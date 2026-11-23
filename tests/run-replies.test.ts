// A reply to a spawned jawan's own `talk` reaches that run while it is alive (T815, docs/sardars.md "Replies to a
// jawan's talk"): the jawan's talk names its run, the other machine replies with `talk <machine> --run <id>`, and the
// receiving machine files the reply with the run (`bin/toli run replies`), or, once the run and its continuations have
// ended, in its lead's inbox.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inbox, pair } from "./delegate-fixture.ts";
import type { Sandbox } from "./helpers.ts";

const RUN = "j-20261123-100000-aaaa";
const NEXT = "j-20261123-110000-bbbb";

/** A jawan run record on `box`; `running` under this test process stays live. */
function runRecord(box: Sandbox, id: string, fields: Record<string, unknown> = {}): void {
    const dir = join(box.root, "state", "jawans");
    const runDir = join(dir, id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "brief.md"), "TOLI_BRIEF v1\n");
    writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({
            id,
            harness: "omp",
            task: "T1",
            project: null,
            work: null,
            model: null,
            cwd: box.root,
            runDir,
            briefPath: join(runDir, "brief.md"),
            logPath: join(runDir, "output.log"),
            command: "omp",
            maxMinutes: null,
            status: "running",
            supervisorPid: process.pid,
            pid: process.pid,
            exitCode: null,
            signal: null,
            startedAt: "2026-11-23T10:00:00.000Z",
            endedAt: null,
            inbox: null,
            error: null,
            ...fields,
        }),
    );
}

/** The run's jawan environment, as its supervisor sets it. */
const asRun = (id: string) => ({ env: { TOLI_ROLE: "jawan", TOLI_RUN_ID: id, TOLI_TASK: "T1" } });

function lastInboxBody(box: Sandbox): string {
    const item = inbox(box).at(-1);
    return item === undefined ? "" : readFileSync(item.path, "utf8");
}

describe("a reply to a jawan's talk", () => {
    test("reaches the live run that sent it, not its lead's inbox", () => {
        const { m1, m2 } = pair();
        runRecord(m1, RUN);
        const sent = m1.ok(["talk", "m2", "What is the login code for the staging account?"], asRun(RUN));
        expect(sent).toContain(`bin/toli run replies --wait`);

        // The message names the run and how to reply to it.
        const asked = lastInboxBody(m2);
        expect(asked).toContain(`- run: ${RUN} (task T1)`);
        expect(asked).toContain(`bin/toli talk m1 --run ${RUN} "<reply>"`);

        const before = inbox(m1).length;
        expect(m2.ok(["talk", "m1", "--run", RUN, "482913"])).toContain("sent to m1");
        expect(inbox(m1)).toHaveLength(before);

        const replies = m1.ok(["run", "replies"], asRun(RUN));
        expect(replies).toContain("482913");
        expect(replies).toContain("from m2");
        // Read once: the next look has nothing new; --all shows it again.
        expect(m1.ok(["run", "replies"], asRun(RUN))).toBe(`no new replies for ${RUN}`);
        expect(m1.ok(["run", "replies", RUN, "--all"])).toContain("482913");
    });

    test("follows the run's continuation, and goes to the lead's inbox once every run of it has ended", () => {
        const { m1, m2 } = pair();
        runRecord(m1, RUN, { status: "stalled", endedAt: "2026-11-23T10:30:00.000Z", resumedBy: NEXT });
        runRecord(m1, NEXT, { resumeOf: RUN });
        m2.ok(["talk", "m1", "--run", RUN, "code 1111"]);
        expect(m1.ok(["run", "replies"], asRun(NEXT))).toContain("code 1111");

        runRecord(m1, NEXT, { resumeOf: RUN, status: "done", endedAt: "2026-11-23T11:30:00.000Z" });
        m2.ok(["talk", "m1", "--run", RUN, "code 2222"]);
        const body = lastInboxBody(m1);
        expect(body).toContain("code 2222");
        expect(body).toContain(`for run ${RUN}, which has ended`);
    });

    test("--wait returns as soon as a reply arrives", async () => {
        const { m1, m2 } = pair();
        runRecord(m1, RUN);
        // Started first, it is waiting (or, if slower to start than the reply, finds it waiting) when the reply arrives.
        const waiting = m1.toliAsync(["run", "replies", "--wait", "1"], asRun(RUN));
        m2.ok(["talk", "m1", "--run", RUN, "333444"]);
        const done = await waiting;
        expect(done.code).toBe(0);
        expect(done.stdout).toContain("333444");
    });
});
