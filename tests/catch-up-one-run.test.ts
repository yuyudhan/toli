import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { machine, release, runRecord, runs } from "./catch-up-fixture.ts";
import type { Sandbox } from "./helpers.ts";

// T2298: at most one merge run per release tag and project clone, whichever source starts it. The release catch-up
// stands down for a queued or live run whose brief names the tag (a scheduled job's merge run has no task), and
// `bin/toli spawn` refuses a run naming a tag a catch-up run owns; both check under the jawan-slots lock, so two
// starts in the same second leave one run.

/** A queued run record (no supervisor yet) whose base brief is `brief`. */
function queuedRun(box: Sandbox, id: string, fields: Record<string, unknown>, brief: string): void {
    runRecord(box, id, { status: "queued", supervisorPid: null, pid: null, ...fields });
    writeFileSync(join(box.root, "state", "jawans", id, "brief.base.md"), brief);
}

/** A merge brief, as a scheduled job writes one, naming release `tag` in its title. */
function mergeBrief(box: Sandbox, tag: string): string {
    const file = join(box.root, `merge-${tag}.md`);
    writeFileSync(file, `TOLI_BRIEF v1\n\n# Nightly: merge ${tag} into nightly\n`);
    return file;
}

describe("one merge run per release tag", () => {
    test("a queued run of the clone naming the tag holds the catch-up; one naming another tag does not", () => {
        const { box, clone, origin } = machine();
        const nightly = "j-20261122-093000-cccc";
        queuedRun(box, nightly, { project: null, cwd: clone }, "TOLI_BRIEF v1\n\n# Nightly: merge v1.0.0\n");
        release(box, origin, "v1.0.0");
        expect(box.ok(["catch-up", "scan"])).toContain(
            `nightly: held (run ${nightly} (queued) names v1.0.0 in its brief), tried again next scan`,
        );
        expect(runs(box).map((run) => run.id)).toEqual([nightly]);

        const other = machine();
        queuedRun(
            other.box,
            "j-20261122-093000-dddd",
            { project: "alpha", cwd: other.clone },
            "TOLI_BRIEF v1\n\n# Nightly: merge v1.0.01\n",
        );
        release(other.box, other.origin, "v1.0.0");
        expect(other.box.ok(["catch-up", "scan"])).toMatch(/catch-up run j-\S+ \(queued\) for nightly/);
        expect(runs(other.box)).toHaveLength(2);
    });

    test("spawn refuses a run naming a tag a queued catch-up run owns, by project or cwd; another tag spawns", () => {
        const { box, clone, origin } = machine();
        release(box, origin, "v1.0.0");
        box.ok(["catch-up", "scan"]);
        const [catchUp] = runs(box);
        expect(catchUp).toBeDefined();
        const brief = mergeBrief(box, "v1.0.0");
        for (const where of [
            ["--project", "alpha"],
            ["--cwd", clone],
        ]) {
            const refused = box.toli(["spawn", "--brief", brief, ...where]);
            expect(refused.code).not.toBe(0);
            expect(refused.stderr).toContain(
                `refusing: release catch-up run ${catchUp?.id} (queued) merges v1.0.0 on alpha; one merge run per release tag and clone`,
            );
        }
        expect(runs(box)).toHaveLength(1);
        expect(box.ok(["spawn", "--brief", mergeBrief(box, "v1.0.1"), "--project", "alpha"])).toMatch(/^queued j-/);
        expect(runs(box)).toHaveLength(2);
    });

    test("a catch-up scan and a spawn for the same tag started in the same second leave one run", async () => {
        const { box, origin } = machine();
        release(box, origin, "v1.0.0");
        const brief = mergeBrief(box, "v1.0.0");
        const [scan, spawn] = await Promise.all([
            box.toliAsync(["catch-up", "scan"]),
            box.toliAsync(["spawn", "--brief", brief, "--project", "alpha"]),
        ]);
        expect(scan.code).toBe(0);
        expect(runs(box)).toHaveLength(1);
        const scanHeld = scan.stdout.includes("nightly: held (run ");
        const spawnRefused = spawn.code !== 0 && spawn.stderr.includes("refusing: release catch-up run ");
        expect([scanHeld, spawnRefused].filter(Boolean)).toHaveLength(1);
    });
});
