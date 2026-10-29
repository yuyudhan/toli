import { MateError, run } from "./util.ts";

export type MergeMethod = "merge" | "squash" | "rebase";
export const MERGE_METHODS: readonly MergeMethod[] = ["merge", "squash", "rebase"];

export type PrCreate = { title: string; body: string; head: string; base?: string; draft: boolean };

/** A pull request by number/id, or the open one whose source is `branch`. */
export type PrRef = { id: string; branch?: undefined } | { id?: undefined; branch: string };

export type PrSummary = {
    id: string;
    title: string;
    /** open, merged, closed or declined. */
    state: string;
    draft: boolean;
    source: string;
    target: string;
    url: string;
};

export type CheckState = "success" | "failure" | "pending";

export type PrStatus = PrSummary & {
    /** null when the forge has not computed (or does not report) mergeability. */
    mergeable: boolean | null;
    mergeDetail: string;
    ci: CheckState | "none";
    checks: { name: string; state: CheckState }[];
};

export type ForgeClient = {
    create(req: PrCreate): Promise<string>;
    status(ref: PrRef): Promise<PrStatus>;
    list(): Promise<PrSummary[]>;
    merge(id: string, method: MergeMethod | undefined): Promise<string>;
};

/** Any failure wins, then anything still running; no checks at all is "none". */
export function ciSummary(states: CheckState[]): PrStatus["ci"] {
    if (states.length === 0) return "none";
    if (states.includes("failure")) return "failure";
    if (states.includes("pending")) return "pending";
    return "success";
}

function normalizeState(state: unknown): string {
    const value = String(state ?? "").toLowerCase();
    return value === "opened" ? "open" : value;
}

type Json = Record<string, unknown>;

/** Run a forge CLI; a non-zero exit becomes a MateError carrying the CLI's own message. */
function runCli(cmd: string[], cwd: string, env: Record<string, string> = {}): string {
    const result = run(cmd, { cwd, env, timeoutMs: 120_000 });
    if (result.code === 127) throw new MateError(`${cmd[0]} not found on PATH`);
    if (result.code !== 0) {
        const detail = (result.stderr || result.stdout).trim();
        throw new MateError(`${cmd.slice(0, 3).join(" ")} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`);
    }
    return result.stdout;
}

function parseJson<T>(text: string, what: string): T {
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new MateError(`unparseable JSON from ${what}: ${text.trim().slice(0, 200)}`);
    }
}

const GH_OUTCOMES: Record<string, CheckState> = {
    SUCCESS: "success",
    NEUTRAL: "success",
    SKIPPED: "success",
    FAILURE: "failure",
    ERROR: "failure",
    CANCELLED: "failure",
    TIMED_OUT: "failure",
    ACTION_REQUIRED: "failure",
    STARTUP_FAILURE: "failure",
};
const GH_FIELDS = "number,title,state,isDraft,headRefName,baseRefName,url";

/** A CheckRun still running, or any state outside GH_OUTCOMES (PENDING, EXPECTED, ...), is pending. */
function ghCheckState(check: Json): CheckState {
    if (check.__typename === "CheckRun" && check.status !== "COMPLETED") return "pending";
    return GH_OUTCOMES[String(check.conclusion || check.state || "")] ?? "pending";
}

/** GitHub through `gh`, addressed as `[HOST/]OWNER/REPO`. */
export class GhClient implements ForgeClient {
    constructor(
        private readonly repo: string,
        private readonly cwd: string,
    ) {}

    private gh(args: string[]): string {
        return runCli(["gh", ...args, "-R", this.repo], this.cwd);
    }

    private summary(pr: Json): PrSummary {
        return {
            id: String(pr.number),
            title: String(pr.title ?? ""),
            state: normalizeState(pr.state),
            draft: pr.isDraft === true,
            source: String(pr.headRefName ?? ""),
            target: String(pr.baseRefName ?? ""),
            url: String(pr.url ?? ""),
        };
    }

    async create(req: PrCreate): Promise<string> {
        const output = this.gh([
            "pr",
            "create",
            "--head",
            req.head,
            "--title",
            req.title,
            "--body",
            req.body,
            ...(req.base === undefined ? [] : ["--base", req.base]),
            ...(req.draft ? ["--draft"] : []),
        ]);
        return lastUrl(output);
    }

    async status(ref: PrRef): Promise<PrStatus> {
        const fields = `${GH_FIELDS},mergeable,mergeStateStatus,statusCheckRollup`;
        const pr = parseJson<Json>(this.gh(["pr", "view", ref.id ?? ref.branch, "--json", fields]), "gh pr view");
        const checks = ((pr.statusCheckRollup as Json[] | null) ?? []).map((check) => ({
            name: String(check.name || check.context || ""),
            state: ghCheckState(check),
        }));
        const mergeable = pr.mergeable === "MERGEABLE" ? true : pr.mergeable === "CONFLICTING" ? false : null;
        return {
            ...this.summary(pr),
            mergeable,
            mergeDetail: String(pr.mergeStateStatus ?? pr.mergeable ?? "").toLowerCase(),
            ci: ciSummary(checks.map((check) => check.state)),
            checks,
        };
    }

    async list(): Promise<PrSummary[]> {
        const prs = parseJson<Json[]>(this.gh(["pr", "list", "--json", GH_FIELDS]), "gh pr list");
        return prs.map((pr) => this.summary(pr));
    }

    async merge(id: string, method: MergeMethod | undefined): Promise<string> {
        return this.gh(["pr", "merge", id, `--${method ?? "merge"}`]).trim() || `merged pull request ${id}`;
    }
}

const GITLAB_PIPELINE: Record<string, CheckState> = {
    success: "success",
    skipped: "success",
    failed: "failure",
    canceled: "failure",
    canceling: "failure",
};
const GITLAB_UNSETTLED: Record<string, true> = {
    checking: true,
    unchecked: true,
    preparing: true,
    approvals_syncing: true,
};

/** GitLab (gitlab.com or self-hosted) through `glab`, with `GITLAB_HOST` selecting the instance. */
export class GlabClient implements ForgeClient {
    constructor(
        private readonly path: string,
        private readonly host: string,
        private readonly cwd: string,
    ) {}

    private glab(args: string[]): string {
        return runCli(["glab", ...args, "-R", this.path], this.cwd, { GITLAB_HOST: this.host });
    }

    private summary(mr: Json): PrSummary {
        return {
            id: String(mr.iid),
            title: String(mr.title ?? ""),
            state: normalizeState(mr.state),
            draft: mr.draft === true,
            source: String(mr.source_branch ?? ""),
            target: String(mr.target_branch ?? ""),
            url: String(mr.web_url ?? ""),
        };
    }

    async create(req: PrCreate): Promise<string> {
        const output = this.glab([
            "mr",
            "create",
            "--source-branch",
            req.head,
            "--title",
            req.title,
            "--description",
            req.body,
            "--yes",
            ...(req.base === undefined ? [] : ["--target-branch", req.base]),
            ...(req.draft ? ["--draft"] : []),
        ]);
        return lastUrl(output);
    }

    async status(ref: PrRef): Promise<PrStatus> {
        const mr = parseJson<Json>(this.glab(["mr", "view", ref.id ?? ref.branch, "-F", "json"]), "glab mr view");
        const pipeline = mr.head_pipeline as Json | null | undefined;
        const checks: PrStatus["checks"] = pipeline
            ? [
                  {
                      name: `pipeline ${String(pipeline.id ?? "")}`.trim(),
                      state: GITLAB_PIPELINE[String(pipeline.status ?? "")] ?? "pending",
                  },
              ]
            : [];
        const detail = String(mr.detailed_merge_status ?? mr.merge_status ?? "");
        return {
            ...this.summary(mr),
            mergeable: detail === "mergeable" ? true : GITLAB_UNSETTLED[detail] || detail === "" ? null : false,
            mergeDetail: detail,
            ci: ciSummary(checks.map((check) => check.state)),
            checks,
        };
    }

    async list(): Promise<PrSummary[]> {
        const mrs = parseJson<Json[]>(this.glab(["mr", "list", "-F", "json"]), "glab mr list");
        return mrs.map((mr) => this.summary(mr));
    }

    async merge(id: string, method: MergeMethod | undefined): Promise<string> {
        const strategy = method === "squash" ? ["--squash"] : method === "rebase" ? ["--rebase"] : [];
        return (
            this.glab(["mr", "merge", id, "--yes", "--auto-merge=false", ...strategy]).trim() ||
            `merged merge request ${id}`
        );
    }
}

/** The last http(s) URL a CLI printed (gh and glab print the new PR/MR URL), else its last line. */
export function lastUrl(output: string): string {
    const urls = output.match(/https?:\/\/[^\s"'<>]+/g);
    if (urls && urls.length > 0) return urls[urls.length - 1] as string;
    const lines = output.trim().split("\n");
    return lines[lines.length - 1] ?? "";
}
