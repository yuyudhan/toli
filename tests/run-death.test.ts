import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseJournalKill } from "../src/jawans/death.ts";
import type { Sandbox } from "./helpers.ts";
import { brief, coordinator, type Run, waitFor } from "./jawan-fixture.ts";

setDefaultTimeout(30_000);

type Outcome = Run & { error: string | null; signal: string | null };

/** systemd-oomd's and the user manager's journal lines for a scope it killed, as itlinux2 logged them (T97). */
function oomdLines(unit: string): string {
    return [
        `Killed /user.slice/user-1001.slice/user@1001.service/app.slice/${unit} due to memory pressure for /user.slice being 80.10% > 80.00% for > 1min with reclaim activity`,
        `${unit}: systemd-oomd killed 86 process(es) in this unit.`,
    ].join("\n");
}

function spawn(box: Sandbox, env: Record<string, string> = {}): Run {
    return JSON.parse(
        box.ok(["spawn", "--harness", "omp", "--brief", brief(box), "--cwd", box.root, "--json"], { env }),
    ) as Run;
}

function status(box: Sandbox, id: string, env: Record<string, string> = {}): Outcome {
    return JSON.parse(box.ok(["run", "status", id, "--json"], { env })) as Outcome;
}

/** Linux with a user manager, a systemd-run that logs and execs, and a journalctl that prints `journal` if written. */
function linuxBox(): { box: Sandbox; env: Record<string, string>; scopes: string; journal: string } {
    const box = coordinator();
    const runtime = join(box.root, ".run-user");
    mkdirSync(join(runtime, "systemd"), { recursive: true });
    writeFileSync(join(runtime, "systemd", "private"), "");
    const scopes = join(box.root, ".systemd-run.log");
    const journal = join(box.root, ".journal");
    box.stub(
        "systemd-run",
        [
            `printf '%s\\n' "$*" >> "${scopes}"`,
            'while [ "$#" -gt 0 ]; do case "$1" in --*) shift ;; *) break ;; esac; done',
            'exec "$@"',
        ].join("\n"),
    );
    box.stub("journalctl", `cat "${journal}" 2>/dev/null; exit 0`);
    const env = { TOLI_PLATFORM: "linux", TOLI_JAWAN_SCOPE: "", TOLI_JOURNAL: "", XDG_RUNTIME_DIR: runtime };
    return { box, env, scopes, journal };
}

describe("a jawan killed by a signal still records an outcome naming it", () => {
    test("SIGKILL to the jawan's process group: failed, killed by SIGKILL, posted with the log tail", async () => {
        const box = coordinator();
        box.stub("omp", 'echo "working on it"; sleep 30');
        const started = spawn(box);
        const running = await waitFor(
            box,
            started.id,
            (run) => run.status === "running" && run.pid !== null && readFileSync(run.logPath, "utf8") !== "",
        );
        process.kill(-(running.pid ?? 0), "SIGKILL");
        await waitFor(box, started.id, (run) => run.inbox !== null);
        const ended = status(box, started.id);
        expect(ended.status).toBe("failed");
        expect(ended.signal).toBe("SIGKILL");
        expect(ended.error).toBe("killed by SIGKILL");
        const posted = readFileSync(ended.inbox ?? "", "utf8");
        expect(posted).toContain("- status: failed (signal SIGKILL): killed by SIGKILL");
        expect(posted).toContain("working on it");
    });

    test("on Linux the harness has its own scope apart from the supervisor's, and oomd's kill is named", async () => {
        const { box, env, scopes, journal } = linuxBox();
        box.stub("omp", 'echo "building"; sleep 30');
        const started = spawn(box, env);
        // Killed only once it runs: a group killed before the stubs ran would never have logged its scope.
        const running = await waitFor(
            box,
            started.id,
            (run) => run.status === "running" && run.pid !== null && readFileSync(run.logPath, "utf8") !== "",
        );
        writeFileSync(journal, oomdLines(`toli-jawan-${started.id}.scope`));
        process.kill(-(running.pid ?? 0), "SIGKILL");
        await waitFor(box, started.id, (run) => run.inbox !== null);
        const ended = status(box, started.id, env);
        expect(ended.status).toBe("failed");
        expect(ended.error).toBe(
            "killed by systemd-oomd (SIGKILL, 86 processes): memory pressure for /user.slice being 80.10% > 80.00% for > 1min with reclaim activity",
        );
        const [supervisor, harness] = readFileSync(scopes, "utf8").trim().split("\n");
        expect(supervisor).toContain(`--unit=toli-supervisor-${started.id}.scope`);
        expect(supervisor).toEndWith(`run supervise ${started.id}`);
        expect(harness).toContain(`--unit=toli-jawan-${started.id}.scope`);
        expect(harness).toContain("scope-1.started omp -p ");
    });
});

describe("a run whose supervisor is gone is reconciled to a recorded failure with its cause", () => {
    /** A run record left `running` by a supervisor that died, with its log. */
    function orphan(box: Sandbox, id: string, log: string, fields: Record<string, unknown> = {}): void {
        const dead = Bun.spawnSync(["true"]).pid;
        const runDir = join(box.root, "state", "jawans", id);
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, "output.log"), log);
        const record = {
            id,
            harness: "omp",
            task: null,
            project: null,
            work: null,
            model: null,
            cwd: box.root,
            runDir,
            briefPath: join(runDir, "brief.md"),
            logPath: join(runDir, "output.log"),
            command: "omp <brief>",
            maxMinutes: null,
            status: "running",
            supervisorPid: dead,
            pid: dead,
            exitCode: null,
            signal: null,
            startedAt: new Date(Date.now() - 60_000).toISOString(),
            endedAt: null,
            inbox: null,
            error: null,
            ...fields,
        };
        writeFileSync(join(box.root, "state", "jawans", `${id}.json`), JSON.stringify(record));
    }

    test("the digest records the signal the supervisor got and the harness's own last words", () => {
        const box = coordinator();
        const id = "j-20261110-025731-5cf5";
        orphan(box, id, "working\n\n[Stopped by SIGTERM]\n[Recovery]\n", {
            supervisorSignal: { signal: "SIGTERM", at: "2026-11-10T14:05:00.000Z" },
        });
        box.ok(["digest"]);
        const ended = status(box, id);
        expect(ended.status).toBe("failed");
        expect(ended.error).toBe(
            "the supervisor exited without recording an outcome: the supervisor got SIGTERM at 2026-11-10T14:05:00.000Z; " +
                `the harness was stopped by SIGTERM; its harness (pid ${ended.pid}) is gone too`,
        );
    });

    test("on Linux the digest names systemd-oomd's kill of a scope that held the supervisor", () => {
        const { box, env, journal } = linuxBox();
        const id = "j-20261112-192840-c9c3";
        orphan(box, id, "Working...\n");
        writeFileSync(journal, oomdLines(`toli-jawan-${id}.scope`));
        box.ok(["digest"], { env });
        const ended = status(box, id, env);
        expect(ended.status).toBe("failed");
        expect(ended.error).toStartWith(
            "the supervisor exited without recording an outcome: killed by systemd-oomd (86 processes): memory pressure",
        );
    });
});

describe("parseJournalKill", () => {
    test("reads systemd-oomd's and the kernel OOM killer's lines about the run's scopes only", () => {
        const id = "j-1";
        expect(parseJournalKill(oomdLines("toli-jawan-j-1-2.scope").split("\n"), id)).toEqual({
            by: "systemd-oomd",
            processes: 86,
            reason: "memory pressure for /user.slice being 80.10% > 80.00% for > 1min with reclaim activity",
        });
        expect(parseJournalKill(oomdLines("toli-jawan-j-2.scope").split("\n"), id)).toBeNull();
        expect(
            parseJournalKill(["toli-jawan-j-1.scope: A process of this unit has been killed by the OOM killer."], id),
        ).toEqual({ by: "the kernel OOM killer", processes: null, reason: "" });
    });
});
