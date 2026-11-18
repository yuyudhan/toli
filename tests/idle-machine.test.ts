// A machine with waiting work and no agent activity for oversight.idleMachineMinutes (30): the tick re-dispatches the
// subagents that stopped reporting and, with no live lead session, alerts the coordinator and the delegating machines
// once per idle spell, never touching a live omp.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editBacklog, fleet, remoteSnapshot, sshLog } from "./fleet-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";

const START = "2026-03-04T08:00:00.000Z";
const BRIEF = "TOLI_BRIEF v1\n\n# T1: build the report page\n";
const ALERT = "m1: no agent activity for";

/**
 * Coordinator m1 (fleet m2, m3) with project alpha: T1 active under subagent T11Sub, whose last report was 08:01 (no
 * omp pid: it reported on its own activity), and T2 queued, delegated by m2.
 */
function stoppedMachine(): Sandbox {
    const box = fleet(remoteSnapshot("m2"));
    withProject(box, "alpha");
    box.stub("omp", "true");
    box.ok(["task", "add", "alpha", "build the report page"]);
    box.ok(["task", "add", "alpha", "draft the export"]);
    const briefs = join(box.root, "data", "projects", "alpha", "briefs");
    mkdirSync(briefs, { recursive: true });
    writeFileSync(join(briefs, "T1.md"), BRIEF);
    box.ok(["task", "start", "T1", "--agent", "T11Sub"], { now: START });
    const agents = join(box.root, "state", "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "T11Sub.json"), JSON.stringify({ at: "2026-03-04T08:01:00.000Z" }));
    editBacklog(box, (tasks) => {
        const t2 = tasks.find((task) => task.id === "T2");
        if (t2 !== undefined) t2.delegatedBy = { machine: "m2", id: "m2-T7", at: START };
    });
    return box;
}

function runIds(box: Sandbox): string[] {
    const dir = join(box.root, "state", "jawans");
    try {
        return readdirSync(dir).filter((file) => file.endsWith(".json"));
    } catch {
        return [];
    }
}

function alerts(box: Sandbox): string[] {
    const dir = join(box.root, "data", "inbox");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .map((file) => readFileSync(join(dir, file), "utf8"))
        .filter((item) => item.startsWith(`# ${ALERT}`));
}

describe("an idle machine with waiting work", () => {
    test("re-dispatches a subagent that stopped reporting and alerts once, to the coordinator and the delegator", () => {
        const box = stoppedMachine();
        // 20 minutes without activity: not idle yet; the silent subagent is only reported to the lead.
        box.ok(["job", "tick"], { now: "2026-03-04T08:21:00.000Z" });
        expect(runIds(box)).toHaveLength(0);
        expect(alerts(box)).toHaveLength(0);

        box.ok(["job", "tick"], { now: "2026-03-04T08:32:00.000Z" });
        expect(runIds(box)).toHaveLength(1);
        const t1 = (
            JSON.parse(box.ok(["task", "list", "--json"])) as { id: string; agent?: string; notes: string[] }[]
        ).find((task) => task.id === "T1");
        expect(t1?.agent).toMatch(/^j-/);
        expect(t1?.notes.at(-1)).toContain(
            "its agent T11Sub stopped reporting, and this machine shows no agent activity",
        );
        const [alert] = alerts(box);
        expect(alert).toContain("# m1: no agent activity for 31 min with 2 tasks waiting, and no live lead session");
        expect(alert).toContain("- T2 (alpha, queued): draft the export");
        expect(alert).toContain("toli never kills or signals a live omp");
        expect(sshLog(box)).toContain("host2");

        // The re-dispatched run is activity: the same spell never alerts twice.
        box.ok(["job", "tick"], { now: "2026-03-04T08:40:00.000Z" });
        expect(alerts(box)).toHaveLength(1);
    });

    test("with a live lead session it re-dispatches the stopped subagent but sends no alert", () => {
        const box = stoppedMachine();
        box.ok(["session", "start", "--pid", String(process.pid)]);
        box.ok(["job", "tick"], { now: "2026-03-04T08:32:00.000Z" });
        expect(runIds(box)).toHaveLength(1);
        expect(alerts(box)).toHaveLength(0);
    });
});
