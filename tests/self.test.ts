import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Sandbox, sandbox } from "./helpers.ts";

const JUST = Bun.which("just");
// Each test runs git, bin/toli and `just check` processes; allow for a machine loaded by parallel jawans.
setDefaultTimeout(60_000);

/** The sandbox root as a toli-like live checkout on main whose `just check` fails while a FAIL file exists. */
function liveRepo(): { box: Sandbox; env: Record<string, string> } {
    const box = sandbox();
    if (JUST === null) throw new Error("these tests need `just` on PATH (the gate runs `just check`)");
    box.git(box.root, ["init", "--initial-branch=main"]);
    writeFileSync(join(box.root, ".gitignore"), "/projects/\n/.stubs/\n/state/\n/data/\n/config/\n/logs/\n");
    writeFileSync(join(box.root, "Justfile"), "check:\n    test ! -e FAIL\n    @echo check passed\n");
    writeFileSync(join(box.root, "README"), "live\n");
    box.git(box.root, ["add", "."]);
    box.git(box.root, ["commit", "-m", "seed"]);
    return { box, env: { PATH: `${dirname(JUST)}:${process.env.PATH ?? ""}` } };
}

function commitIn(box: Sandbox, dir: string, file: string, text: string): void {
    writeFileSync(join(dir, file), text);
    box.git(dir, ["add", file]);
    box.git(dir, ["commit", "-m", `add ${file}`]);
}

describe("self worktrees", () => {
    test("prepare creates projects/.worktrees/toli/<T-id> on toli/<T-id> from the live branch, idempotently", () => {
        const { box, env } = liveRepo();
        const first = JSON.parse(box.ok(["self", "prepare", "t7", "--json"], { env }));
        const path = join(realpathSync(box.root), "projects", ".worktrees", "toli", "T7");
        expect(first).toEqual({ task: "T7", path, branch: "toli/T7", base: "main", dirty: false });
        expect(box.git(path, ["branch", "--show-current"])).toBe("toli/T7");
        expect(readFileSync(join(path, "README"), "utf8")).toBe("live\n");
        expect(JSON.parse(box.ok(["self", "prepare", "T7", "--json"], { env }))).toEqual(first);
        const listed = JSON.parse(box.ok(["self", "list", "--json"], { env }));
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({ task: "T7", branch: "toli/T7", base: "main", dirty: false });
        // Run from inside the worktree (its own bin/toli), toli still finds the live checkout.
        expect(JSON.parse(box.ok(["self", "list", "--json"], { env: { ...env, TOLI_ROOT: path } }))).toEqual(listed);
        expect(box.git(box.root, ["status", "--porcelain"])).toBe("");
    });

    test("prepare rejects ids that are not T<n> and paths that are not its worktree", () => {
        const { box, env } = liveRepo();
        expect(box.toli(["self", "prepare", "../x"], { env }).stderr).toContain('invalid task id "../x"');
        mkdirSync(join(box.root, "projects", ".worktrees", "toli", "T3"), { recursive: true });
        expect(box.toli(["self", "prepare", "T3"], { env }).stderr).toContain("is not a worktree of");
    });

    test("land rebases onto main, passes the check, fast-forwards the live checkout and removes the worktree", () => {
        const { box, env } = liveRepo();
        const path = JSON.parse(box.ok(["self", "prepare", "T1", "--json"], { env })).path as string;
        commitIn(box, path, "feature.txt", "feature\n");
        commitIn(box, box.root, "other.txt", "landed meanwhile\n");
        const landed = JSON.parse(box.ok(["self", "land", "T1", "--json"], { env }));
        expect(landed).toMatchObject({ task: "T1", branch: "toli/T1", base: "main", commits: 1 });
        expect(landed.check).toContain("check passed");
        expect(readFileSync(join(box.root, "feature.txt"), "utf8")).toBe("feature\n");
        expect(box.git(box.root, ["rev-parse", "HEAD"])).toBe(landed.head);
        expect(box.git(box.root, ["log", "--format=%s", "-3"]).split("\n")).toEqual([
            "add feature.txt",
            "add other.txt",
            "seed",
        ]);
        expect(existsSync(path)).toBe(false);
        expect(box.git(box.root, ["branch", "--list", "toli/T1"])).toBe("");
        expect(box.ok(["self", "list"], { env })).toBe("no self worktrees");
    });

    test("a failing check refuses to land and leaves main and the worktree as they were", () => {
        const { box, env } = liveRepo();
        const path = JSON.parse(box.ok(["self", "prepare", "T2", "--json"], { env })).path as string;
        commitIn(box, path, "FAIL", "broken\n");
        const before = box.git(box.root, ["rev-parse", "HEAD"]);
        const result = box.toli(["self", "land", "T2"], { env });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("refusing to land T2: `just check` failed");
        expect(result.stderr).toContain("main is unchanged");
        expect(box.git(box.root, ["rev-parse", "HEAD"])).toBe(before);
        expect(existsSync(join(box.root, "FAIL"))).toBe(false);
        expect(box.git(path, ["branch", "--show-current"])).toBe("toli/T2");
    });

    test("uncommitted changes and conflicting rebases refuse to land", () => {
        const { box, env } = liveRepo();
        const path = JSON.parse(box.ok(["self", "prepare", "T4", "--json"], { env })).path as string;
        writeFileSync(join(path, "README"), "edited\n");
        const dirtyRun = box.toli(["self", "land", "T4"], { env });
        expect(dirtyRun.code).toBe(1);
        expect(dirtyRun.stderr).toContain("has uncommitted changes");
        box.git(path, ["commit", "-am", "worktree edit"]);
        commitIn(box, box.root, "README", "live edit\n");
        const before = box.git(box.root, ["rev-parse", "HEAD"]);
        const conflict = box.toli(["self", "land", "T4"], { env });
        expect(conflict.code).toBe(1);
        expect(conflict.stderr).toContain("does not rebase cleanly onto main (rebase aborted");
        expect(box.git(box.root, ["rev-parse", "HEAD"])).toBe(before);
        expect(box.git(path, ["status", "--porcelain"])).toBe("");
        expect(box.git(path, ["log", "--format=%s", "-1"])).toBe("worktree edit");
    });

    test("land without commits only removes the worktree; unknown tasks are refused", () => {
        const { box, env } = liveRepo();
        box.ok(["self", "prepare", "T5"], { env });
        expect(box.ok(["self", "land", "T5"], { env })).toBe(
            "T5: nothing to land on main; worktree and toli/T5 removed",
        );
        expect(box.toli(["self", "land", "T6"], { env }).stderr).toContain("no self worktree for T6");
    });
});
