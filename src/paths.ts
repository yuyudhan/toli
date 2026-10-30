import { join, resolve } from "node:path";

/** The repo root: the directory holding bin/toli (resolved from this file, never cwd); `TOLI_ROOT` overrides for tests. */
export function repoRoot(): string {
    const override = process.env.TOLI_ROOT;
    return override ? resolve(override) : resolve(import.meta.dir, "..");
}

export const paths = {
    root: () => repoRoot(),
    toliBin: () => join(repoRoot(), "bin", "toli"),
    machine: () => join(repoRoot(), "config", "machine.json"),
    fleet: () => join(repoRoot(), "config", "fleet.json"),
    jobsConfig: () => join(repoRoot(), "config", "jobs.json"),
    /** Optional persona names (user title, lead, worker); see src/persona.ts. */
    persona: () => join(repoRoot(), "config", "persona.json"),
    projects: () => join(repoRoot(), "data", "projects.json"),
    backlog: () => join(repoRoot(), "data", "backlog.json"),
    projectDir: (name: string) => join(repoRoot(), "projects", name),
    malik: () => join(repoRoot(), "data", "malik.md"),
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
