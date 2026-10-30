import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { machineSettings } from "./config.ts";
import { run, ToliError } from "./util.ts";

/** Agent harnesses toli can start a lead in and run jawans on. */
export const HARNESSES = ["omp", "claude", "codex", "cursor", "grok", "pi"] as const;
export type Harness = (typeof HARNESSES)[number];

/** Kinds of jawan work that may route to a different harness (`harness.byWork` in config/machine.json). */
export const WORK_TYPES = ["scout", "ship", "verify"] as const;
export type WorkType = (typeof WORK_TYPES)[number];

export type HarnessSpec = {
    name: Harness;
    label: string;
    binary: string;
    install: string;
    login: string;
    /** Whether the harness's own subagents run in the background so the lead stays free (otherwise use spawn). */
    asyncSubagents: boolean;
};

export const SPECS: Record<Harness, HarnessSpec> = {
    omp: {
        name: "omp",
        label: "omp",
        binary: "omp",
        install: "bun install -g @oh-my-pi/pi-coding-agent",
        login: "omp login",
        asyncSubagents: true,
    },
    claude: {
        name: "claude",
        label: "Claude Code",
        binary: "claude",
        install: "curl -fsSL https://claude.ai/install.sh | bash",
        login: "claude auth login (or ANTHROPIC_API_KEY)",
        asyncSubagents: true,
    },
    codex: {
        name: "codex",
        label: "Codex CLI",
        binary: "codex",
        install: "npm install -g @openai/codex",
        login: "codex login (or CODEX_API_KEY)",
        asyncSubagents: false,
    },
    cursor: {
        name: "cursor",
        label: "Cursor CLI",
        binary: "cursor-agent",
        install: "curl https://cursor.com/install -fsS | bash",
        login: "cursor-agent login (or CURSOR_API_KEY)",
        asyncSubagents: false,
    },
    grok: {
        name: "grok",
        label: "Grok CLI",
        binary: "grok",
        install: "curl -fsSL https://x.ai/cli/install.sh | bash",
        login: "grok login (or XAI_API_KEY)",
        asyncSubagents: true,
    },
    pi: {
        name: "pi",
        label: "pi",
        binary: "pi",
        install: "npm install -g @earendil-works/pi-coding-agent",
        login: "provider API keys (e.g. ANTHROPIC_API_KEY) or /login inside pi",
        asyncSubagents: false,
    },
};

export function isHarness(value: string): value is Harness {
    return (HARNESSES as readonly string[]).includes(value);
}

export function parseHarness(value: string, label = "--harness"): Harness {
    if (!isHarness(value)) throw new ToliError(`${label} must be one of ${HARNESSES.join(", ")} (got "${value}")`);
    return value;
}

/** Where the harness binary resolves on PATH, or null when it is not installed. */
export function harnessPath(harness: Harness): string | null {
    return Bun.which(SPECS[harness].binary, { PATH: process.env.PATH ?? "" });
}

export function notInstalledMessage(harness: Harness): string {
    const spec = SPECS[harness];
    return `${spec.label} is not installed on this machine (\`${spec.binary}\` is not on PATH). Install: ${spec.install}; then log in: ${spec.login}. See docs/harnesses.md.`;
}

/** The binary's absolute path; throws the install hint when the harness is missing. */
export function requireInstalled(harness: Harness): string {
    const found = harnessPath(harness);
    if (!found) throw new ToliError(notInstalledMessage(harness));
    return found;
}

export type HeadlessInput = {
    /** Full brief text; its first line is `TOLI_BRIEF v1`. */
    brief: string;
    /** Working directory of the jawan (the project clone). */
    cwd: string;
    /** toli's root, granted as an extra writable directory so the jawan can write its report there. */
    root: string;
    model?: string | undefined;
    maxMinutes: number;
};

export type HeadlessCommand = { argv: string[]; stdin: string | null };

// Claude Code tools a headless jawan may use without a prompt; acceptEdits covers edits in cwd and --add-dir.
const CLAUDE_JAWAN_TOOLS = "Bash,Read,Edit,Write,MultiEdit,NotebookEdit,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite";

/**
 * The non-interactive command for one jawan run on `harness`. Flags per harness are documented with sources in
 * docs/harnesses.md. The brief goes on stdin where the CLI reads it there, otherwise as the prompt argument.
 */
export function headlessCommand(harness: Harness, input: HeadlessInput): HeadlessCommand {
    const model = input.model;
    switch (harness) {
        case "omp":
            return {
                argv: [
                    "omp",
                    "-p",
                    "--cwd",
                    input.cwd,
                    "--no-title",
                    "--approval-mode",
                    "yolo",
                    "--max-time",
                    `${input.maxMinutes}m`,
                    ...(model ? ["--model", model] : []),
                    input.brief,
                ],
                stdin: null,
            };
        case "claude":
            return {
                argv: [
                    "claude",
                    "-p",
                    "--output-format",
                    "text",
                    "--permission-mode",
                    "acceptEdits",
                    "--allowedTools",
                    CLAUDE_JAWAN_TOOLS,
                    "--add-dir",
                    input.root,
                    ...(model ? ["--model", model] : []),
                ],
                stdin: input.brief,
            };
        case "codex":
            return {
                argv: [
                    "codex",
                    "exec",
                    "--sandbox",
                    "workspace-write",
                    "-c",
                    "sandbox_workspace_write.network_access=true",
                    "--add-dir",
                    input.root,
                    "--skip-git-repo-check",
                    "-C",
                    input.cwd,
                    ...(model ? ["-m", model] : []),
                    "-",
                ],
                stdin: input.brief,
            };
        case "cursor":
            return {
                argv: [
                    "cursor-agent",
                    "-p",
                    "--force",
                    "--output-format",
                    "text",
                    ...(model ? ["--model", model] : []),
                    input.brief,
                ],
                stdin: null,
            };
        case "grok":
            return {
                argv: [
                    "grok",
                    "--cwd",
                    input.cwd,
                    "--always-approve",
                    "--no-auto-update",
                    "--output-format",
                    "plain",
                    ...(model ? ["-m", model] : []),
                    "-p",
                    input.brief,
                ],
                stdin: null,
            };
        case "pi":
            return { argv: ["pi", "-p", ...(model ? ["--model", model] : []), input.brief], stdin: null };
    }
}

export type HarnessConfig = {
    /** Default harness for jawans spawned with `bin/toli spawn` (default omp). */
    jawan?: Harness;
    /** Per-work-type override of `jawan`. */
    byWork?: Partial<Record<WorkType, Harness>>;
    /** Model passed to a harness when `spawn` gets no --model. */
    models?: Partial<Record<Harness, string>>;
};

/** `harness` from config/machine.json, validated. */
export function harnessConfig(): HarnessConfig {
    const raw = machineSettings().harness;
    if (raw === undefined) return {};
    if (raw.jawan !== undefined) parseHarness(raw.jawan, "config/machine.json harness.jawan");
    for (const [work, value] of Object.entries(raw.byWork ?? {})) {
        if (!(WORK_TYPES as readonly string[]).includes(work))
            throw new ToliError(`config/machine.json harness.byWork: unknown work type "${work}"`);
        parseHarness(String(value), `config/machine.json harness.byWork.${work}`);
    }
    for (const key of Object.keys(raw.models ?? {})) parseHarness(key, "config/machine.json harness.models key");
    return raw;
}

/** The harness a jawan of this work type runs on when spawn gets no --harness. */
export function defaultHarness(work?: WorkType): Harness {
    const config = harnessConfig();
    return (work === undefined ? undefined : config.byWork?.[work]) ?? config.jawan ?? "omp";
}

/** Every harness the configuration routes jawans to. */
export function configuredHarnesses(): Harness[] {
    const config = harnessConfig();
    const named = [config.jawan ?? "omp", ...Object.values(config.byWork ?? {})];
    return HARNESSES.filter((harness) => named.includes(harness));
}

export type HarnessStatus = {
    harness: Harness;
    label: string;
    installed: boolean;
    path: string | null;
    version: string | null;
    /** true/false when the CLI can tell; null when login cannot be checked without starting a session. */
    loggedIn: boolean | null;
    detail: string;
};

function firstLine(text: string): string {
    return (
        text
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line !== "") ?? ""
    );
}

function envKey(names: string[]): string | undefined {
    return names.find((name) => (process.env[name] ?? "") !== "");
}

/** Whether the harness has a usable login, without printing or storing any credential (spawns its status CLI). */
export function harnessLogin(harness: Harness): { loggedIn: boolean | null; detail: string } {
    switch (harness) {
        case "omp":
            return { loggedIn: null, detail: "logins live in omp's profile (`omp login` adds one)" };
        case "claude": {
            const result = run(["claude", "auth", "status", "--json"], { timeoutMs: 20_000 });
            try {
                const status = JSON.parse(result.stdout) as { loggedIn?: boolean; authMethod?: string };
                return status.loggedIn === true
                    ? { loggedIn: true, detail: `logged in (${status.authMethod ?? "unknown method"})` }
                    : { loggedIn: false, detail: "not logged in: claude auth login" };
            } catch {
                return { loggedIn: null, detail: "`claude auth status` unavailable (older Claude Code)" };
            }
        }
        case "codex": {
            const result = run(["codex", "login", "status"], { timeoutMs: 20_000 });
            return result.code === 0
                ? { loggedIn: true, detail: firstLine(result.stdout || result.stderr) || "logged in" }
                : { loggedIn: false, detail: "not logged in: codex login" };
        }
        case "cursor": {
            const result = run(["cursor-agent", "status"], { timeoutMs: 20_000 });
            const text = `${result.stdout}\n${result.stderr}`;
            return result.code === 0 && !/not (logged|authenticated)/i.test(text)
                ? { loggedIn: true, detail: firstLine(result.stdout) || "logged in" }
                : { loggedIn: false, detail: "not logged in: cursor-agent login" };
        }
        case "grok": {
            const key = envKey(["XAI_API_KEY"]);
            return key
                ? { loggedIn: true, detail: `${key} set` }
                : { loggedIn: null, detail: "XAI_API_KEY unset; a `grok login` session is not checked" };
        }
        case "pi": {
            const key = envKey(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY"]);
            if (key) return { loggedIn: true, detail: `${key} set` };
            return existsSync(join(homedir(), ".pi", "agent", "auth.json"))
                ? { loggedIn: true, detail: "~/.pi/agent/auth.json present" }
                : { loggedIn: false, detail: "no provider key or ~/.pi/agent/auth.json: /login inside pi" };
        }
    }
}

/** Installed, version, and login state of one harness CLI. */
export function harnessStatus(harness: Harness): HarnessStatus {
    const spec = SPECS[harness];
    const found = harnessPath(harness);
    if (!found)
        return {
            harness,
            label: spec.label,
            installed: false,
            path: null,
            version: null,
            loggedIn: null,
            detail: `not installed (install: ${spec.install})`,
        };
    const versionRun = run([found, "--version"], { timeoutMs: 20_000 });
    const version = versionRun.code === 0 ? firstLine(versionRun.stdout || versionRun.stderr) || null : null;
    const login = harnessLogin(harness);
    return { harness, label: spec.label, installed: true, path: found, version, ...login };
}
