import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The directory holding this code's bin/toli and src/: the working tree, or an installed runtime snapshot. */
const CODE_ROOT = resolve(import.meta.dir, "..", "..");

/** Written into each installed runtime snapshot (src/release/runtime.ts): `{checkout, commit, syncedAt}`. */
export const RUNTIME_MARKER = ".toli-runtime.json";

let servedCheckout: string | null | undefined;

/** The checkout an installed runtime serves (from its marker), or null when this code runs from a checkout. */
function runtimeCheckout(): string | null {
    if (servedCheckout !== undefined) return servedCheckout;
    servedCheckout = null;
    const marker = join(CODE_ROOT, RUNTIME_MARKER);
    if (existsSync(marker)) {
        const parsed: unknown = JSON.parse(readFileSync(marker, "utf8"));
        const checkout = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "checkout") : undefined;
        if (typeof checkout === "string") servedCheckout = checkout;
    }
    return servedCheckout;
}

/** Where this process's code runs from (see CODE_ROOT); never the data root. */
export function codeRoot(): string {
    return CODE_ROOT;
}

/**
 * The repo root: the checkout holding bin/toli, config/, data/ and state/ (resolved from this file, never cwd). Code
 * running from an installed runtime serves the checkout its marker names; `TOLI_ROOT` overrides both for tests.
 */
export function repoRoot(): string {
    const override = process.env.TOLI_ROOT;
    return override ? resolve(override) : (runtimeCheckout() ?? CODE_ROOT);
}

export const paths = {
    root: () => repoRoot(),
    toliBin: () => join(repoRoot(), "bin", "toli"),
    /** The active installed runtime snapshot of a checkout (one line, read by bin/toli; src/release/runtime.ts). */
    runtimePointer: (checkout: string = repoRoot()) => join(checkout, "state", "runtime"),
    machine: () => join(repoRoot(), "config", "machine.json"),
    fleet: () => join(repoRoot(), "config", "fleet.json"),
    jobsConfig: () => join(repoRoot(), "config", "jobs.json"),
    /** Optional persona names (user title, lead, worker); see src/core/persona.ts. */
    persona: () => join(repoRoot(), "config", "persona.json"),
    /** The update check's settings (`bin/toli update off|on|snooze`); see src/release/update-check.ts. */
    updatesConfig: () => join(repoRoot(), "config", "updates.json"),
    projects: () => join(repoRoot(), "data", "projects.json"),
    backlog: () => join(repoRoot(), "data", "backlog.json"),
    projectDir: (name: string) => join(repoRoot(), "projects", name),
    /** Per-task git worktrees of worktree-per-task projects: projects/.worktrees/<project>/<T-id>. */
    worktreesDir: (project: string) => join(repoRoot(), "projects", ".worktrees", project),
    taskWorktree: (project: string, taskId: string) => join(repoRoot(), "projects", ".worktrees", project, taskId),
    /** The user's standing preferences and decisions (pinned memory). */
    preferences: () => join(repoRoot(), "data", "preferences.md"),
    learnings: () => join(repoRoot(), "data", "learnings.md"),
    /** data/projects/: one directory per project (notes, briefs, reports, runs, decisions). */
    projectsDataDir: () => join(repoRoot(), "data", "projects"),
    projectDataDir: (project: string) => join(repoRoot(), "data", "projects", project),
    /** Per-project facts (stack, commands, URLs, proof, gotchas); fed into every brief for the project. */
    projectNotes: (project: string) => join(repoRoot(), "data", "projects", project, "notes.md"),
    /** Each dispatched brief for the project, one file per brief. */
    projectBriefsDir: (project: string) => join(repoRoot(), "data", "projects", project, "briefs"),
    /** Scout and task reports for the project, e.g. `T<n>.md`. */
    projectReportsDir: (project: string) => join(repoRoot(), "data", "projects", project, "reports"),
    projectReport: (project: string, taskId: string) =>
        join(repoRoot(), "data", "projects", project, "reports", `${taskId}.md`),
    /** Jawan and remote run outputs for the project. */
    projectRunsDir: (project: string) => join(repoRoot(), "data", "projects", project, "runs"),
    /** Held questions and the user's answers for the project. */
    projectDecisions: (project: string) => join(repoRoot(), "data", "projects", project, "decisions.md"),
    /** Cold storage for archived memory entries and old tasks; never loaded into a session. */
    archive: (file: string) => join(repoRoot(), "data", "archive", file),
    /** Toli-wide reports (not about one project); per-project reports live in projectReportsDir. */
    reportsDir: () => join(repoRoot(), "data", "reports"),
    jobResultsDir: (name?: string) =>
        name === undefined ? join(repoRoot(), "data", "jobs") : join(repoRoot(), "data", "jobs", name),
    inboxDir: () => join(repoRoot(), "data", "inbox"),
    /** Remote run outputs with no project; project runs go to projectRunsDir. */
    remoteDir: () => join(repoRoot(), "data", "remote"),
    session: () => join(repoRoot(), "state", "session.json"),
    jobsState: () => join(repoRoot(), "state", "jobs.json"),
    acks: () => join(repoRoot(), "state", "acks.json"),
    pruneState: () => join(repoRoot(), "state", "prune.json"),
    /** The setup steps the user was last told about (or snoozed), so session start says it once. */
    setupShown: () => join(repoRoot(), "state", "setup-shown.json"),
    /** The update check's last result and the versions the user was told about (src/release/update-check.ts). */
    updateCheck: () => join(repoRoot(), "state", "update-check.json"),
    updateCheckLog: () => join(repoRoot(), "logs", "update-check.log"),
    outboxDir: () => join(repoRoot(), "state", "outbox"),
    runsDir: () => join(repoRoot(), "state", "runs"),
    runRecord: (runId: string) => join(repoRoot(), "state", "runs", `${runId}.json`),
    /** Index of spawned jawan runs (status/pid); project-less runs also keep their logs in state/jawans/<runId>/. */
    jawansDir: () => join(repoRoot(), "state", "jawans"),
    jawanRecord: (runId: string) => join(repoRoot(), "state", "jawans", `${runId}.json`),
    lock: (name: string) => join(repoRoot(), "state", `${name}.lock`),
    logsDir: () => join(repoRoot(), "logs"),
    tickLog: () => join(repoRoot(), "logs", "tick.log"),
    /** Private per-installation helpers, never committed: local/{scripts,hooks,helpers.json,README.md}. */
    localDir: () => join(repoRoot(), "local"),
    localScriptsDir: () => join(repoRoot(), "local", "scripts"),
    localHooksDir: () => join(repoRoot(), "local", "hooks"),
    helpersConfig: () => join(repoRoot(), "local", "helpers.json"),
    helperLog: (name: string) => join(repoRoot(), "logs", "helpers", `${name}.log`),
};
