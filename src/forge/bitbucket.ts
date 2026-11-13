import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../core/paths.ts";
import { run, ToliError } from "../core/util.ts";
import type { ForgeClient, MergeMethod, PrCreate, PrRef, PrStatus, PrSummary } from "./cli.ts";
import { ciSummary } from "./cli.ts";

const DEFAULT_API = "https://api.bitbucket.org/2.0";

/** Where a credential came from; the secret itself is never printed. `email` is the basic-auth user. */
export type BitbucketCredentials = { email: string; token: string; source: string };

/** `KEY=value` pairs from a dotenv file (`export ` prefixes, quotes and `#` comment lines handled). */
export function parseDotenv(text: string): Record<string, string> {
    const values: Record<string, string> = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim().replace(/^export\s+/, "");
        const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!match || line.startsWith("#")) continue;
        let value = (match[2] as string).trim();
        const quoted = /^(["'])(.*)\1$/.exec(value);
        if (quoted) value = quoted[2] as string;
        else value = value.replace(/\s+#.*$/, "");
        values[match[1] as string] = value;
    }
    return values;
}

function fromPair(email: string | undefined, token: string | undefined, source: string) {
    return email && token ? { email, token, source } : null;
}

/** The repo-root `.env` values, or none when the file is absent. */
function dotenvValues(): Record<string, string> {
    const dotenvPath = join(paths.root(), ".env");
    return existsSync(dotenvPath) ? parseDotenv(readFileSync(dotenvPath, "utf8")) : {};
}

/**
 * `git credential fill` for https://bitbucket.org, never prompting. Git logs in with the Bitbucket username, which
 * the REST API rejects for API tokens, so the stored username is used only when it is an email; otherwise `email`.
 */
function fromGitCredential(email: string | undefined): BitbucketCredentials | null {
    const result = run(["git", "credential", "fill"], {
        stdin: "protocol=https\nhost=bitbucket.org\n\n",
        timeoutMs: 15_000,
        env: { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" },
    });
    if (result.code !== 0) return null;
    const fields = Object.fromEntries(
        result.stdout
            .split("\n")
            .map((line) => line.split("="))
            .filter((parts) => parts.length >= 2)
            .map(([key, ...rest]) => [key, rest.join("=")]),
    );
    const stored = fields.username?.includes("@") ? fields.username : undefined;
    return fromPair(email || stored, fields.password, "git credential helper (bitbucket.org)");
}

/**
 * `BITBUCKET_EMAIL` and `BITBUCKET_API_TOKEN`, each from the environment, else the repo-root `.env`; when either is
 * missing, the git credential helper's bitbucket.org login. Bitbucket API tokens authenticate with the Atlassian
 * account email, never the username.
 */
export function bitbucketCredentials(): BitbucketCredentials | null {
    const dotenv = dotenvValues();
    const envEmail = process.env.BITBUCKET_EMAIL;
    const envToken = process.env.BITBUCKET_API_TOKEN;
    const email = envEmail || dotenv.BITBUCKET_EMAIL;
    const token = envToken || dotenv.BITBUCKET_API_TOKEN;
    if (!email || !token) return fromGitCredential(email);
    const fromEnv = [Boolean(envEmail), Boolean(envToken)];
    const source = fromEnv.every(Boolean) ? "environment" : fromEnv.some(Boolean) ? "environment and .env" : ".env";
    return { email, token, source };
}

const BITBUCKET_SETUP =
    "set BITBUCKET_EMAIL (the Atlassian account email) and BITBUCKET_API_TOKEN (an Atlassian API token with " +
    "Bitbucket scopes) in the environment or the toli repo's .env";

/** What to set when no credentials resolve; names a leftover BITBUCKET_USERNAME, which Bitbucket rejects. */
export function bitbucketCredentialsHelp(): string {
    const legacy = Boolean(process.env.BITBUCKET_USERNAME || dotenvValues().BITBUCKET_USERNAME);
    return (
        "Bitbucket credentials missing: " +
        (legacy ? "BITBUCKET_USERNAME is not used, API tokens authenticate with the account email; " : "") +
        `${BITBUCKET_SETUP}, or store the token for bitbucket.org in the git credential helper with BITBUCKET_EMAIL set`
    );
}

type Json = Record<string, unknown>;

function field<T>(value: unknown, ...keys: string[]): T | undefined {
    let current = value;
    for (const key of keys) {
        if (current === null || typeof current !== "object") return undefined;
        current = (current as Json)[key];
    }
    return current as T | undefined;
}

const MERGE_STRATEGIES: Record<MergeMethod, string> = {
    merge: "merge_commit",
    squash: "squash",
    rebase: "fast_forward",
};

const CHECK_STATES: Record<string, "success" | "failure" | "pending"> = {
    SUCCESSFUL: "success",
    FAILED: "failure",
    STOPPED: "failure",
    INPROGRESS: "pending",
};

/** Bitbucket Cloud REST 2.0 for one `workspace/repo`. */
export class BitbucketClient implements ForgeClient {
    private readonly base: string;
    private readonly auth: string;
    private readonly rejectedHint: string;

    constructor(
        private readonly repo: string,
        credentials: BitbucketCredentials | null = bitbucketCredentials(),
    ) {
        if (repo.split("/").length !== 2)
            throw new ToliError(`Bitbucket repo path must be workspace/repo, got "${repo}"`);
        if (!credentials) throw new ToliError(bitbucketCredentialsHelp());
        this.base = (process.env.TOLI_BITBUCKET_API ?? DEFAULT_API).replace(/\/+$/, "");
        this.auth = `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString("base64")}`;
        this.rejectedHint =
            `Bitbucket rejected the credentials from ${credentials.source} (email ${credentials.email}): ` +
            `${BITBUCKET_SETUP}; the email must be the account that owns the token`;
    }

    private async request(method: string, path: string, body?: unknown): Promise<Json> {
        const url = path.startsWith("http") ? path : `${this.base}/repositories/${this.repo}${path}`;
        // Pagination links are absolute; never send the credentials anywhere but the API itself.
        if (!url.startsWith(`${this.base}/`))
            throw new ToliError(`refusing Bitbucket request outside ${this.base}: ${url}`);
        const response = await fetch(url, {
            method,
            headers: {
                Authorization: this.auth,
                Accept: "application/json",
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(60_000),
        });
        const text = await response.text();
        let parsed: Json = {};
        try {
            parsed = text === "" ? {} : (JSON.parse(text) as Json);
        } catch {
            parsed = { raw: text.slice(0, 300) };
        }
        if (!response.ok) {
            const detail = field<string>(parsed, "error", "message") ?? field<string>(parsed, "raw") ?? "";
            const hint = response.status === 401 ? `. ${this.rejectedHint}` : "";
            throw new ToliError(
                `Bitbucket ${method} ${url} failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}${hint}`,
            );
        }
        return parsed;
    }

    private summary(pr: Json): PrSummary {
        return {
            id: String(field<number>(pr, "id")),
            title: field<string>(pr, "title") ?? "",
            state: (field<string>(pr, "state") ?? "").toLowerCase(),
            draft: field<boolean>(pr, "draft") ?? false,
            source: field<string>(pr, "source", "branch", "name") ?? "",
            target: field<string>(pr, "destination", "branch", "name") ?? "",
            url: field<string>(pr, "links", "html", "href") ?? "",
        };
    }

    async create(req: PrCreate): Promise<string> {
        const pr = await this.request("POST", "/pullrequests", {
            title: req.title,
            description: req.body,
            source: { branch: { name: req.head } },
            ...(req.base === undefined ? {} : { destination: { branch: { name: req.base } } }),
            draft: req.draft,
        });
        return this.summary(pr).url;
    }

    private async findByBranch(branch: string): Promise<Json> {
        const query = encodeURIComponent(`source.branch.name="${branch.replace(/"/g, '\\"')}" AND state="OPEN"`);
        const page = await this.request("GET", `/pullrequests?q=${query}`);
        const first = field<Json[]>(page, "values")?.[0];
        if (!first) throw new ToliError(`no open Bitbucket pull request from branch ${branch}`);
        return first;
    }

    async status(ref: PrRef): Promise<PrStatus> {
        const pr =
            ref.id !== undefined
                ? await this.request("GET", `/pullrequests/${encodeURIComponent(ref.id)}`)
                : await this.findByBranch(ref.branch);
        const sha = field<string>(pr, "source", "commit", "hash");
        const checks: PrStatus["checks"] = [];
        let next: string | undefined = sha ? `/commit/${sha}/statuses?pagelen=100` : undefined;
        while (next !== undefined) {
            const page = await this.request("GET", next);
            for (const status of field<Json[]>(page, "values") ?? []) {
                const state = field<string>(status, "state") ?? "";
                checks.push({
                    name: field<string>(status, "name") ?? field<string>(status, "key") ?? "",
                    state: CHECK_STATES[state] ?? "pending",
                });
            }
            next = field<string>(page, "next");
        }
        return {
            ...this.summary(pr),
            mergeable: null,
            mergeDetail: "not reported by Bitbucket",
            ci: ciSummary(checks.map((check) => check.state)),
            checks,
        };
    }

    async list(): Promise<PrSummary[]> {
        const prs: PrSummary[] = [];
        let next: string | undefined = "/pullrequests?state=OPEN&pagelen=50";
        while (next !== undefined) {
            const page = await this.request("GET", next);
            prs.push(...(field<Json[]>(page, "values") ?? []).map((pr) => this.summary(pr)));
            next = field<string>(page, "next");
        }
        return prs;
    }

    async merge(id: string, method: MergeMethod | undefined): Promise<string> {
        const pr = await this.request(
            "POST",
            `/pullrequests/${encodeURIComponent(id)}/merge`,
            method === undefined ? {} : { merge_strategy: MERGE_STRATEGIES[method] },
        );
        const summary = this.summary(pr);
        return `merged ${summary.url || `pull request ${id}`} (state ${summary.state || "unknown"})`;
    }
}
