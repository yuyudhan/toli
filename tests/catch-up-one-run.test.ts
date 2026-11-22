import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRun, updateRun } from "../src/jawans/runs.ts";
import { spawnJawan } from "../src/jawans/spawn.ts";
import * as tagOwner from "../src/jawans/tag-owner.ts";
import { machine, release, runRecord, runs } from "./catch-up-fixture.ts";
import { inProcess, type Sandbox } from "./helpers.ts";

/** Task `id` as data/backlog.json holds it. */
function task(box: Sandbox, id: string): { agent?: string; workspace?: unknown } {
    const backlog = JSON.parse(readFileSync(join(box.root, "data", "backlog.json"), "utf8")) as {
        tasks: { id: string; agent?: string; workspace?: unknown }[];
    };
    const found = backlog.tasks.find((entry) => entry.id === id);
    if (found === undefined) throw new Error(`no task ${id}`);
    return found;
}

// T2298: at most one merge run per release tag and project clone, whichever source starts it. The release catch-up
// stands down for a queued or live run whose brief names the tag (a scheduled job's merge run has no task), and
// `bin/toli spawn` refuses a run naming a tag a catch-up run owns; both check under the jawan-slots lock, so two
// starts in the same second leave one run.

/** A queued run record (no supervisor yet) whose base brief is `brief`. */
function queuedRun(box: Sandbox, id: string, fields: Record<string, unknown>, brief: string): void {
    runRecord(box, id, { status: "queued", supervisorPid: null, pid: null, ...fields });
    writeFileSync(join(box.root, "state", "jawans", id, "brief.base.md"), brief);
}

/** A brief whose body (after the TOLI_BRIEF line) is `text`; returns its path. */
function textBrief(box: Sandbox, name: string, text: string): string {
    const file = join(box.root, `${name}.md`);
    writeFileSync(file, `TOLI_BRIEF v1\n\n${text}`);
    return file;
}

/** A merge brief, as a scheduled job writes one, naming release `tag` in its title. */
function mergeBrief(box: Sandbox, tag: string): string {
    return textBrief(box, `merge-${tag}`, `# Nightly: merge ${tag} into nightly\n`);
}

const HOTFIX = "TOLI_BRIEF v1\n\n# Hotfix: regression since v1.0.0\n";

/** Machine m1 with release v1.0.0 cut, task T1 started and one queued run of a non-merge brief for it. */
function taskWithQueuedRun(): { box: Sandbox; oldId: string } {
    const { box, origin } = machine();
    box.ok(["task", "add", "alpha", "Parser fix"]);
    box.ok(["task", "start", "T1"]);
    const old = box.ok(["spawn", "--brief", textBrief(box, "fix", "# Parser fix\n"), "--task", "T1"]);
    release(box, origin, "v1.0.0");
    return { box, oldId: /^queued (j-\S+):/.exec(old)?.[1] ?? "" };
}

/** `spawn --brief <brief> --task T1 --replace` in this process, the sandbox's stub harness on PATH. */
function spawnIn(box: Sandbox, brief: string): void {
    inProcess(box.root, () => spawnJawan({ briefPath: brief, task: "T1", replace: true }), {
        PATH: `${box.stubs}:${process.env.PATH ?? ""}`,
        TOLI_JAWAN_SCOPE: "off",
        TOLI_TASK: "",
        TOLI_RUN_ID: "",
    });
}

describe("one merge run per release tag", () => {
    test("a queued run of the clone naming the tag holds the catch-up; one naming another tag does not", () => {
        const { box, clone, origin } = machine();
        const nightly = "j-20261122-093000-cccc";
        queuedRun(box, nightly, { project: null, cwd: clone }, "TOLI_BRIEF v1\n\n# Nightly: merge v1.0.0\n");
        release(box, origin, "v1.0.0");
        expect(box.ok(["catch-up", "scan"])).toContain(
            `nightly: held (run ${nightly} (queued) merges v1.0.0 by its brief), tried again next scan`,
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

    test("a brief that names the owned tag without merging it queues; a merge brief is still refused", () => {
        const { box, origin } = machine();
        release(box, origin, "v1.0.0");
        box.ok(["catch-up", "scan"]);
        const hotfix = textBrief(
            box,
            "hotfix",
            "# Hotfix: regression since v1.0.0\n\nThe parser crashes since v1.0.0.\n",
        );
        expect(box.ok(["spawn", "--brief", hotfix, "--project", "alpha"])).toMatch(/^queued j-/);
        const nightly = textBrief(box, "nightly", "# Nightly: merge v1.0.0\n");
        expect(box.toli(["spawn", "--brief", nightly, "--project", "alpha"]).stderr).toContain(
            "merges v1.0.0 on alpha; one merge run per release tag and clone",
        );
        // An explicit `Merges:` line states the merge whatever the title says.
        const stated = textBrief(box, "stated", "# Nightly upkeep\n\nMerges: v1.0.0\n");
        expect(box.toli(["spawn", "--brief", stated, "--project", "alpha"]).code).not.toBe(0);
        expect(runs(box)).toHaveLength(2);
    });

    test("a queued run that only mentions the tag does not hold the catch-up", () => {
        const { box, clone, origin } = machine();
        queuedRun(box, "j-20261122-093000-eeee", { project: "alpha", cwd: clone }, HOTFIX);
        release(box, origin, "v1.0.0");
        expect(box.ok(["catch-up", "scan"])).toMatch(/catch-up run j-\S+ \(queued\) for nightly/);
    });

    test("a run in a task worktree is never refused: it does not touch the branches the catch-up merges", () => {
        const { box, origin } = machine();
        release(box, origin, "v1.0.0");
        box.ok(["catch-up", "scan"]);
        box.ok(["project", "set", "alpha", "--branch", "none", "--workspace", "worktree-per-task"]);
        box.ok(["task", "add", "alpha", "Merge v1.0.0 into the parser branch"]);
        box.ok(["task", "start", "T1"]);
        const brief = mergeBrief(box, "v1.0.0");
        expect(box.ok(["spawn", "--brief", brief, "--task", "T1"])).toMatch(/^queued j-/);
        const worktree = join(box.root, "projects", ".worktrees", "alpha", "T1");
        expect(box.ok(["spawn", "--brief", brief, "--cwd", worktree])).toMatch(/^queued j-/);
        expect(runs(box)).toHaveLength(3);
    });

    test("a refused task spawn leaves the shared clone on its branch: the tag is checked before the workspace", () => {
        const { box, clone, origin } = machine();
        release(box, origin, "v1.0.0");
        box.ok(["catch-up", "scan"]);
        box.ok(["project", "set", "alpha", "--branch", "none", "--workspace", "branch-per-task"]);
        box.ok(["task", "add", "alpha", "Parser fix"]);
        box.ok(["task", "start", "T1"]);
        const refused = box.toli(["spawn", "--brief", mergeBrief(box, "v1.0.0"), "--task", "T1"]);
        expect(refused.stderr).toContain("merges v1.0.0 on alpha; one merge run per release tag and clone");
        expect(box.git(clone, ["branch", "--show-current"])).toBe("nightly");
        expect(task(box, "T1").workspace).toBeUndefined();
        expect(runs(box)).toHaveLength(1);
    });

    test("spawn --replace refused under the slots lock never stopped the old run: the task keeps its jawan", () => {
        const { box, oldId } = taskWithQueuedRun();
        // The outside check passes; the one under the lock finds an owner, as a catch-up recorded in between would.
        const refuse = spyOn(tagOwner, "refuseOwnedTag")
            .mockImplementationOnce(() => undefined)
            .mockImplementationOnce(() => {
                throw new tagOwner.TagOwnedError({ run: loadRun(oldId), why: "a catch-up recorded meanwhile" });
            });
        try {
            expect(() => spawnIn(box, mergeBrief(box, "v1.0.0"))).toThrow("a catch-up recorded meanwhile");
            expect(refuse).toHaveBeenCalledTimes(2);
        } finally {
            refuse.mockRestore();
        }
        expect(runs(box).find((run) => run.id === oldId)?.status).toBe("queued");
        expect(task(box, "T1").agent).toBe(oldId);
        expect(runs(box)).toHaveLength(1);
    });

    test("spawn --replace of a run that ended before the slots lock records the new run, stopping nothing", () => {
        const { box, oldId } = taskWithQueuedRun();
        // The old run ends between the listing outside the lock and the guard under it.
        const refuse = spyOn(tagOwner, "refuseOwnedTag")
            .mockImplementationOnce(() => undefined)
            .mockImplementationOnce(() => {
                updateRun(oldId, (record) => {
                    record.status = "done";
                });
            });
        try {
            spawnIn(box, textBrief(box, "again", "# Parser fix, again\n"));
        } finally {
            refuse.mockRestore();
        }
        const all = runs(box);
        expect(all.find((run) => run.id === oldId)?.status).toBe("done");
        const next = all.find((run) => run.id !== oldId);
        expect(next?.status).toBe("queued");
        expect(next?.replaces).toBeUndefined();
        expect(task(box, "T1").agent).toBe(next?.id);
    });

    test("a tag matches as a whole release name, its regex characters literal", () => {
        const { namesTag } = tagOwner;
        expect(namesTag("merge v1.2.3.", "v1.2.3")).toBe(true);
        expect(namesTag("merge (v1.2.3)", "v1.2.3")).toBe(true);
        expect(namesTag("merge v1.2.3-rc.1", "v1.2.3")).toBe(false);
        expect(namesTag("merge v1.2.3+build.5", "v1.2.3")).toBe(false);
        expect(namesTag("merge v1.2.30", "v1.2.3")).toBe(false);
        expect(namesTag("merge v1.2.3.4", "v1.2.3")).toBe(false);
        expect(namesTag("merge v1.2.333b", "v1.2.3+b")).toBe(false);
        expect(namesTag("merge v1.2.3+b", "v1.2.3+b")).toBe(true);
    });
});
