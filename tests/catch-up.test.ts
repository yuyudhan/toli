// T2142: after a project's release (a new vX.Y.Z tag on origin's main), each machine with the clone starts one
// catch-up jawan that merges the new main into its long-lived branches (docs/projects.md "Release catch-up").
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    asCatchUp,
    commitFile,
    type Machine,
    machine,
    release,
    runRecord,
    runs,
    type TaskRecord,
} from "./catch-up-fixture.ts";

describe("catch-up scan", () => {
    test("a new tag queues one catch-up run per project, never a second while it is live", () => {
        const { box, origin } = machine();
        expect(box.ok(["catch-up", "scan"])).toContain("alpha: no vX.Y.Z tag on origin/main");
        expect(runs(box)).toEqual([]);

        const sha = release(box, origin, "v1.0.0");
        const first = box.ok(["catch-up", "scan"]);
        expect(first).toContain(`alpha: v1.0.0 (${sha.slice(0, 12)}): catch-up run`);
        expect(first).toContain("for nightly");
        const queued = runs(box);
        expect(queued).toHaveLength(1);
        expect(queued[0]).toMatchObject({
            project: "alpha",
            status: "queued",
            cwd: join(box.root, "projects", "alpha"),
        });
        const brief = readFileSync(join(box.root, "data", "projects", "alpha", "briefs", "catch-up-v1.0.0.md"), "utf8");
        expect(brief.startsWith("TOLI_BRIEF v1\n")).toBe(true);
        expect(brief).toContain("## Goal");
        expect(brief).toContain("bin/toli catch-up merge alpha --tag v1.0.0");
        expect(brief).toContain("- nightly");

        expect(box.ok(["catch-up", "scan"])).toContain(`catch-up run ${queued[0]?.id} is still queued`);
        release(box, origin, "v1.1.0");
        expect(box.ok(["catch-up", "scan"])).toContain(`catch-up run ${queued[0]?.id} is still queued`);
        expect(runs(box)).toHaveLength(1);
    });

    test("a held checkout is skipped and tried again on a later scan", () => {
        const { box, clone, origin } = machine();
        runRecord(box, "j-20261120-080100-bbbb", { cwd: clone, project: "alpha" });
        release(box, origin, "v1.0.0");
        expect(box.ok(["catch-up", "scan"])).toContain(
            "nightly: held (jawan run j-20261120-080100-bbbb works in it), tried again next scan",
        );
        expect(runs(box).filter((run) => run.briefPath.includes("catch-up"))).toEqual([]);

        runRecord(box, "j-20261120-080100-bbbb", { cwd: clone, project: "alpha", status: "done" });
        expect(box.ok(["catch-up", "scan"])).toContain("for nightly");
        expect(runs(box).filter((run) => run.status === "queued")).toHaveLength(1);
    });

    test("opt-out is honoured, and a clone with no branch past main needs nothing", () => {
        const { box, origin } = machine();
        expect(box.ok(["project", "set", "alpha", "--catch-up", "no"])).toContain("catch-up=no");
        release(box, origin, "v1.0.0");
        expect(box.ok(["catch-up", "scan"])).toContain("alpha: catch-up is off");
        expect(runs(box)).toEqual([]);
        const listed = JSON.parse(box.ok(["project", "list", "--json"])) as { catchUp: boolean | null }[];
        expect(listed[0]?.catchUp).toBe(false);

        box.ok(["project", "set", "alpha", "--catch-up", "default", "--branch", "none"]);
        box.git(join(box.root, "projects", "alpha"), ["switch", "--quiet", "main"]);
        expect(box.ok(["catch-up", "scan"])).toContain("alpha: v1.0.0");
        expect(box.ok(["catch-up", "scan"])).toContain("every long-lived branch has it");
        expect(runs(box)).toEqual([]);
    });
});

describe("catch-up merge", () => {
    test("merges into an unpushed branch and keeps it local", () => {
        const { box, clone, origin } = machine();
        box.ok(["project", "set", "alpha", "--standing-push", "yes"]);
        const sha = release(box, origin, "v1.0.0");
        box.ok(["catch-up", "scan"]);
        const self = { env: { TOLI_RUN_ID: runs(box)[0]?.id ?? "" } };
        const text = box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0"], self);
        expect(text).toMatch(/^nightly \(.*projects\/alpha\): merged v1\.0\.0 as [0-9a-f]{12}$/m);
        expect(text).toContain("keep local: nightly is not on origin");
        expect(text).not.toContain("push:");
        expect(box.git(clone, ["merge-base", "--is-ancestor", sha, "nightly"])).toBe("");
        expect(box.git(clone, ["log", "-1", "--format=%P", "nightly"]).split(" ")).toContain(sha);
        expect(box.git(origin, ["branch", "--list", "nightly"])).toBe("");
        expect(box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0"], self)).toContain("nightly: up to date");
    });

    test("a pushed branch gets a push line only with the standing grant; the command itself never pushes", () => {
        const { box, clone, origin } = machine();
        box.git(clone, ["push", "--quiet", "origin", "nightly"]);
        const before = box.git(origin, ["rev-parse", "nightly"]);
        release(box, origin, "v1.0.0");
        box.ok(["catch-up", "scan"]);
        const self = { env: { TOLI_RUN_ID: runs(box)[0]?.id ?? "" } };
        expect(box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0"], self)).toContain(
            "keep local: no standing push grant for alpha",
        );
        box.ok(["project", "set", "alpha", "--standing-push", "yes", "--catch-up-checks", "just lint"]);
        release(box, origin, "v1.1.0");
        box.ok(["catch-up", "scan"]);
        const text = box.ok(["catch-up", "merge", "alpha", "--tag", "v1.1.0"], self);
        expect(text).toContain("checks: just lint");
        expect(text).toContain("push (after the checks pass): bin/toli push alpha --branch nightly");
        expect(box.git(origin, ["rev-parse", "nightly"])).toBe(before);

        // A box that cannot run the project's push gate keeps every catch-up merge local.
        expect(box.ok(["project", "set", "alpha", "--catch-up-push", "no"])).toContain("catch-up-push=no");
        release(box, origin, "v1.2.0");
        box.ok(["catch-up", "scan"]);
        // The v1.2.0 scan queued a catch-up run of its own (the v1.1.0 merge replaced the v1.0.0 record): it owns
        // v1.2.0, so the merge runs as that jawan.
        const local = box.ok(["catch-up", "merge", "alpha", "--tag", "v1.2.0"], asCatchUp(box, "v1.2.0"));
        expect(local).toContain("keep local: catch-up pushes are off for alpha on this machine");
        expect(local).not.toContain("push (after");
    });

    test("a conflict is reported, the tree left clean, and the task owner told", () => {
        const { box, clone, origin } = machine();
        box.ok(["project", "set", "alpha", "--branch", "none", "--workspace", "worktree-per-task"]);
        box.git(clone, ["switch", "--quiet", "main"]);
        box.ok(["task", "add", "alpha", "Build API"]);
        box.ok(["task", "start", "T1"]);
        box.ok(["workspace", "prepare", "T1"]);
        const worktree = join(box.root, "projects", ".worktrees", "alpha", "T1");
        const head = commitFile(box, worktree, "CHANGES", "mine\n");
        release(box, origin, "v1.0.0", "CHANGES", "theirs\n");
        expect(box.ok(["catch-up", "scan"])).toContain("for toli/m1/T1-build-api");

        const self = { env: { TOLI_RUN_ID: runs(box)[0]?.id ?? "" } };
        const text = box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0"], self);
        expect(text).toContain("toli/m1/T1-build-api (T1");
        expect(text).toContain("conflict in CHANGES: nothing merged, the work left as it was");
        expect(box.git(worktree, ["rev-parse", "HEAD"])).toBe(head);
        expect(box.git(worktree, ["status", "--porcelain"])).toBe("");
        expect(existsSync(join(clone, ".git", "worktrees", "T1", "MERGE_HEAD"))).toBe(false);
        const tasks = JSON.parse(box.ok(["task", "list", "--json"])) as TaskRecord[];
        expect(tasks.find((task) => task.id === "T1")?.notes.join("\n")).toContain(
            "catch-up v1.0.0: merging it into toli/m1/T1-build-api conflicts in CHANGES",
        );
    });

    test("a checkout another live jawan holds is skipped and handed back to the next scan", () => {
        const { box, clone, origin } = machine();
        release(box, origin, "v1.0.0");
        box.ok(["catch-up", "scan"]);
        const catchUp = runs(box)[0]?.id ?? "";
        runRecord(box, "j-20261120-080100-bbbb", { cwd: clone, project: "alpha" });
        const head = box.git(clone, ["rev-parse", "HEAD"]);
        const text = box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0"], { env: { TOLI_RUN_ID: catchUp } });
        expect(text).toContain("nightly: held (jawan run j-20261120-080100-bbbb works in it)");
        const state = JSON.parse(readFileSync(join(box.root, "state", "catch-up.json"), "utf8")) as {
            projects: Record<string, { attempted: string[] }>;
        };
        expect(state.projects.alpha?.attempted).toEqual([]);
        expect(box.git(clone, ["rev-parse", "HEAD"])).toBe(head);
    });
});

// T2207: a project's commit-msg hook may demand a trailer on a merge that touches its protected paths; the catch-up
// merge carries the project's `--catch-up-trailer` line and the hook still judges it.
describe("catch-up trailer", () => {
    /** machine() with a commit-msg hook in the clone requiring `Quality-change:` when quality.toml changes. */
    function guarded(): Machine {
        const setup = machine();
        const hook = setup.box.git(setup.clone, [
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "hooks/commit-msg",
        ]);
        writeFileSync(
            hook,
            [
                "#!/bin/sh",
                "if git diff --cached --name-only HEAD | grep -qx quality.toml && ! grep -q '^Quality-change: .' \"$1\"; then",
                '    echo "quality.toml changed: add a Quality-change: <reason> line" >&2',
                "    exit 1",
                "fi",
                "",
            ].join("\n"),
        );
        chmodSync(hook, 0o755);
        return setup;
    }

    test("without the setting, a merge touching a protected path is still refused", () => {
        const { box, clone, origin } = guarded();
        const head = box.git(clone, ["rev-parse", "HEAD"]);
        release(box, origin, "v1.0.0", "quality.toml", "strict = true\n");
        box.ok(["catch-up", "scan"]);
        const self = { env: { TOLI_RUN_ID: runs(box)[0]?.id ?? "" } };
        const text = box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0"], self);
        expect(text).toContain("rejected the message");
        expect(text).toContain("quality.toml changed: add a Quality-change: <reason> line");
        expect(text).toContain("bin/toli project set alpha --catch-up-trailer '<Key>: <text>'");
        expect(box.git(clone, ["rev-parse", "HEAD"])).toBe(head);
        expect(box.git(clone, ["status", "--porcelain"])).toBe("");

        // A trailer of another key does not satisfy the hook either: it still judges the message.
        box.ok(["project", "set", "alpha", "--catch-up-trailer", "Reviewed-by: catch-up of {tag}"]);
        const other = box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0"], self);
        expect(other).toContain("rejected the message");
        expect(other).not.toContain("--catch-up-trailer '<Key>");
        expect(box.git(clone, ["rev-parse", "HEAD"])).toBe(head);
    });

    test("with --catch-up-trailer the merge carries the line and the hook accepts it", () => {
        const { box, clone, origin } = guarded();
        const sha = release(box, origin, "v1.0.0", "quality.toml", "strict = true\n");
        box.ok(["catch-up", "scan"]);
        const self = { env: { TOLI_RUN_ID: runs(box)[0]?.id ?? "" } };

        expect(box.toli(["project", "set", "alpha", "--catch-up-trailer", "no colon here"]).code).not.toBe(0);
        expect(
            box.toli(["project", "set", "alpha", "--catch-up-trailer", "Quality-change: {version}"]).stderr,
        ).toContain("knows {tag}, {base}, {branch}, not {version}");
        expect(
            box.ok([
                "project",
                "set",
                "alpha",
                "--catch-up-trailer",
                "Quality-change: release {tag} merged from {base}",
            ]),
        ).toContain('catch-up-trailer="Quality-change: release {tag} merged from {base}"');
        const listed = JSON.parse(box.ok(["project", "list", "--json"])) as { catchUpTrailer: string | null }[];
        expect(listed[0]?.catchUpTrailer).toBe("Quality-change: release {tag} merged from {base}");

        const text = box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0"], self);
        expect(text).toMatch(/^nightly \(.*projects\/alpha\): merged v1\.0\.0 as [0-9a-f]{12}$/m);
        expect(box.git(clone, ["log", "-1", "--format=%P", "nightly"]).split(" ")).toContain(sha);
        expect(box.git(clone, ["log", "-1", "--format=%B", "nightly"])).toBe(
            "Merge v1.0.0 into nightly\n\nQuality-change: release v1.0.0 merged from main",
        );
        expect(readFileSync(join(clone, "quality.toml"), "utf8")).toBe("strict = true\n");

        box.ok(["project", "set", "alpha", "--catch-up-trailer", "none"]);
        const cleared = JSON.parse(box.ok(["project", "list", "--json"])) as { catchUpTrailer: string | null }[];
        expect(cleared[0]?.catchUpTrailer).toBeNull();
    });
});

// T2203: a catch-up never merges, checks or pushes in a checkout on another branch or one a live run holds.
describe("catch-up guards", () => {
    test("a branch not checked out here starts no jawan and plans no checks or push", () => {
        const { box, clone, origin } = machine();
        box.ok(["project", "set", "alpha", "--standing-push", "yes"]);
        box.git(clone, ["push", "--quiet", "origin", "nightly"]);
        box.git(clone, ["switch", "--quiet", "-c", "release/v0.9.0", "main"]);
        const head = box.git(clone, ["rev-parse", "HEAD"]);
        release(box, origin, "v1.0.0");
        expect(box.ok(["catch-up", "scan"])).toContain(
            "nightly: skipped: not checked out here (projects/alpha is on release/v0.9.0), tried again next scan",
        );
        expect(runs(box)).toEqual([]);

        const text = box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0"]);
        expect(text).toContain("nightly: not checked out on this machine; nothing merged");
        expect(text).not.toContain("checks:");
        expect(text).not.toContain("push");
        expect(box.git(clone, ["rev-parse", "HEAD"])).toBe(head);

        // The next scan after the branch is back in the clone hands it out.
        box.git(clone, ["switch", "--quiet", "nightly"]);
        expect(box.ok(["catch-up", "scan"])).toContain("for nightly");
    });

    test("push --branch refuses when the checkout is on another branch", () => {
        const { box, clone, origin } = machine();
        box.ok(["project", "set", "alpha", "--standing-push", "yes"]);
        box.git(clone, ["push", "--quiet", "origin", "nightly"]);
        const pushed = box.git(origin, ["rev-parse", "nightly"]);
        commitFile(box, clone, "more.txt", "more\n");
        box.git(clone, ["switch", "--quiet", "-c", "release/v0.9.0"]);
        const refused = box.toli(["push", "alpha", "--branch", "nightly"]);
        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain("refusing: projects/alpha is on release/v0.9.0, not nightly");
        expect(box.git(origin, ["branch", "--list", "release/v0.9.0"])).toBe("");
        expect(box.git(origin, ["rev-parse", "nightly"])).toBe(pushed);
    });

    test("a live run in the project clone holds a worktree branch's catch-up too", () => {
        const { box, clone, origin } = machine();
        box.ok(["project", "set", "alpha", "--branch", "none", "--workspace", "worktree-per-task"]);
        box.git(clone, ["switch", "--quiet", "main"]);
        box.ok(["task", "add", "alpha", "Build API"]);
        box.ok(["task", "start", "T1"]);
        box.ok(["workspace", "prepare", "T1"]);
        const worktree = join(box.root, "projects", ".worktrees", "alpha", "T1");
        const head = commitFile(box, worktree, "api.txt", "api\n");
        runRecord(box, "j-20261120-080100-bbbb", { cwd: clone, project: "alpha" });
        release(box, origin, "v1.0.0");
        expect(box.ok(["catch-up", "scan"])).toContain(
            "toli/m1/T1-build-api: held (projects/alpha: jawan run j-20261120-080100-bbbb works in it), tried again next scan",
        );
        expect(runs(box).filter((run) => run.briefPath.includes("catch-up"))).toEqual([]);

        expect(box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0"])).toContain(
            "toli/m1/T1-build-api: held (projects/alpha: jawan run j-20261120-080100-bbbb works in it)",
        );
        expect(box.git(worktree, ["rev-parse", "HEAD"])).toBe(head);

        runRecord(box, "j-20261120-080100-bbbb", { cwd: clone, project: "alpha", status: "done" });
        expect(box.ok(["catch-up", "scan"])).toContain("for toli/m1/T1-build-api");
    });
});
