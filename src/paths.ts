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
    projects: () => join(repoRoot(), "data", "projects.json"),
    backlog: () => join(repoRoot(), "data", "backlog.json"),
    projectDir: (name: string) => join(repoRoot(), "projects", name),
    notes: (project: string) => join(repoRoot(), "data", "notes", `${project}.md`),
    reportsDir: () => join(repoRoot(), "data", "reports"),
    jobResultsDir: (name?: string) =>
        name === undefined ? join(repoRoot(), "data", "jobs") : join(repoRoot(), "data", "jobs", name),
    inboxDir: () => join(repoRoot(), "data", "inbox"),
    remoteDir: () => join(repoRoot(), "data", "remote"),
    session: () => join(repoRoot(), "state", "session.json"),
    jobsState: () => join(repoRoot(), "state", "jobs.json"),
    acks: () => join(repoRoot(), "state", "acks.json"),
    outboxDir: () => join(repoRoot(), "state", "outbox"),
    runsDir: () => join(repoRoot(), "state", "runs"),
    runRecord: (runId: string) => join(repoRoot(), "state", "runs", `${runId}.json`),
    lock: (name: string) => join(repoRoot(), "state", `${name}.lock`),
    logsDir: () => join(repoRoot(), "logs"),
    tickLog: () => join(repoRoot(), "logs", "tick.log"),
};
