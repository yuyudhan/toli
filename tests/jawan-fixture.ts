// Shared by the spawn and run-outcome tests: a coordinator sandbox, a brief, and reading detached runs' records.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox } from "./helpers.ts";

export type Run = {
    id: string;
    harness: string;
    status: string;
    task: string | null;
    project: string | null;
    cwd: string;
    logPath: string;
    pid: number | null;
    supervisorPid: number | null;
    exitCode: number | null;
    inbox: string | null;
    model: string | null;
    tier?: string | null;
    modelSource?: string;
    fallback?: { from: string | null; to: string | null; tier: string | null; waitedMinutes: number; reason: string };
    replaces?: string[];
    replacedBy?: string;
};

export function coordinator(): Sandbox {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    return box;
}

export function brief(box: Sandbox, body = "say hi"): string {
    const path = join(box.root, "brief.md");
    writeFileSync(path, `TOLI_BRIEF v1\n${body}\n`);
    return path;
}

export function runs(box: Sandbox): Run[] {
    return JSON.parse(box.ok(["runs", "--json"])) as Run[];
}

/**
 * Poll the run until `done` holds, failing after ~10 s. Real time is unavoidable here: the supervisor and the
 * harness are separate detached OS processes, so there is no in-process promise or event to await.
 */
export async function waitFor(box: Sandbox, id: string, done: (run: Run) => boolean): Promise<Run> {
    for (let attempt = 0; attempt < 100; attempt++) {
        const run = JSON.parse(box.ok(["run", "status", id, "--json"])) as Run;
        if (done(run)) return run;
        await Bun.sleep(100);
    }
    throw new Error(`run ${id} never reached the expected state: ${box.ok(["run", "status", id])}`);
}

export function spawnJson(box: Sandbox, args: string[]): Run {
    return JSON.parse(box.ok(["spawn", ...args, "--json"])) as Run;
}
