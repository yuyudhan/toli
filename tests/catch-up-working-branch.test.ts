// T2800: the release catch-up merges a new tag only into the project's configured working branch (`project set
// --branch`), never into another branch checked out on the machine (a per-task fix branch, a PR branch), and a working
// branch that is a per-task project's base (its tasks' pull requests target it) takes only a release already on its
// origin copy (docs/projects.md "Release catch-up"). Observed on a fleet box: v1.0.54 of main was merged into
// fix/T2636-sec-docker-hardening, a branch based on develop whose PR targets develop.
import { describe, expect, test } from "bun:test";
import { commitFile, machine, release, runs } from "./catch-up-fixture.ts";
import { tempDir } from "./helpers.ts";

describe("catch-up merges only into the working branch", () => {
    test("a per-task fix branch is skipped; the develop base takes only a release already on origin/develop", () => {
        const { box, clone, origin } = machine();
        // A develop-based project: tasks branch from develop and their PRs target it; releases are tagged on main.
        box.git(clone, ["switch", "--quiet", "-c", "develop", "main"]);
        commitFile(box, clone, "develop.txt", "integration work\n");
        box.git(clone, ["push", "--quiet", "origin", "develop"]);
        box.ok(["project", "set", "alpha", "--branch", "develop", "--workspace", "branch-per-task"]);
        box.ok(["task", "add", "alpha", "Docker hardening"]);
        box.ok(["task", "start", "T1"]);
        box.ok(["workspace", "prepare", "T1"]);
        const fix = box.git(clone, ["branch", "--show-current"]);
        expect(fix).not.toBe("develop");
        const head = commitFile(box, clone, "Dockerfile", "USER app\n");
        const sha = release(box, origin, "v1.0.0");

        const scan = box.ok(["catch-up", "scan"]);
        expect(scan).toContain(
            `alpha: v1.0.0 (${sha.slice(0, 12)}): ${fix}: skipped: not alpha's working branch (develop)`,
        );
        expect(scan).toContain("develop: skipped: v1.0.0 is not on origin/develop");
        expect(runs(box).filter((run) => run.briefPath.includes("catch-up"))).toEqual([]);

        const merge = box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0"]);
        expect(merge).not.toContain(fix);
        expect(merge).toContain("develop: skipped: v1.0.0 is not on origin/develop");
        expect(box.git(clone, ["rev-parse", "HEAD"])).toBe(head);
        expect(box.git(clone, ["branch", "--list", "--contains", sha, fix])).toBe("");

        // Once the release is back-merged into origin/develop, the develop checkout takes it; the fix branch never.
        const releaser = tempDir("backmerge");
        box.git(releaser, ["clone", "--quiet", origin, "."]);
        box.git(releaser, ["switch", "--quiet", "develop"]);
        box.git(releaser, ["merge", "--quiet", "--no-edit", "v1.0.0"]);
        box.git(releaser, ["push", "--quiet", "origin", "develop"]);
        box.git(clone, ["fetch", "--quiet", "origin", "develop"]);
        box.git(clone, ["switch", "--quiet", "develop"]);
        const next = box.ok(["catch-up", "scan"]);
        expect(next).toMatch(/catch-up run j-\S+ \(queued\) for develop$/m);
        expect(next).not.toMatch(/for .*toli\//);
        const self = { env: { TOLI_RUN_ID: runs(box).find((run) => run.catchUp === "v1.0.0")?.id ?? "" } };
        const merged = box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0"], self);
        expect(merged).toMatch(/^develop \(.*\): merged v1\.0\.0/m);
        expect(box.git(clone, ["branch", "--list", "--contains", sha, fix])).toBe("");
    });

    test("with no working branch set, the branch the clone is on is skipped, never merged", () => {
        const { box, clone, origin } = machine();
        box.ok(["project", "set", "alpha", "--branch", "none"]);
        box.git(clone, ["switch", "--quiet", "-c", "fix/T2636-sec-docker-hardening"]);
        const head = commitFile(box, clone, "Dockerfile", "USER app\n");
        release(box, origin, "v1.0.0");
        expect(box.ok(["catch-up", "scan"])).toContain(
            "fix/T2636-sec-docker-hardening: skipped: not alpha's working branch (none set: bin/toli project set alpha --branch <b>)",
        );
        expect(runs(box)).toEqual([]);
        expect(box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0"])).toBe("no long-lived branch here");
        expect(box.git(clone, ["rev-parse", "HEAD"])).toBe(head);
    });

    test("undo still takes back a recorded merge into a branch that is no longer the working branch", () => {
        const { box, clone, origin } = machine();
        const before = box.git(clone, ["rev-parse", "HEAD"]);
        release(box, origin, "v1.0.0");
        box.ok(["catch-up", "scan"]);
        const self = { env: { TOLI_RUN_ID: runs(box)[0]?.id ?? "" } };
        box.ok(["catch-up", "merge", "alpha", "--tag", "v1.0.0"], self);
        const merged = box.git(clone, ["rev-parse", "HEAD"]);
        expect(merged).not.toBe(before);
        box.ok(["project", "set", "alpha", "--branch", "none"]);
        expect(box.ok(["catch-up", "undo", "alpha", "--branch", "nightly", "--merge", merged], self)).toContain(
            `nightly: undid the catch-up merge ${merged.slice(0, 12)}; back at ${before.slice(0, 12)}`,
        );
        expect(box.git(clone, ["rev-parse", "HEAD"])).toBe(before);
    });
});
