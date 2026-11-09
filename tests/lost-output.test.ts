import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox, withProject } from "./helpers.ts";

// On a loaded machine a git child that exits 0 has been seen to hand back no stdout. These tests put a git on PATH
// that drops the stdout of chosen calls, and check that toli never takes the missing output for an answer.
setDefaultTimeout(60_000);

const REAL_GIT = Bun.which("git") ?? "git";

/**
 * A `git` stub that runs the real git but drops the stdout of calls whose arguments end with one of `endings`, for the
 * first `times` such calls (every one when null), counting them in `<root>/lost`.
 */
function lossyGit(box: Sandbox, endings: string[], times: number | null): void {
    const count = join(box.root, "lost");
    const patterns = endings.map((ending) => `*" ${ending}"`).join(" | ");
    const limit = times === null ? "" : `[ "$n" -lt ${times} ] && `;
    box.stub(
        "git",
        `case "$*" in
${patterns})
    n=$(cat "${count}" 2>/dev/null || echo 0)
    if ${limit}true; then
        echo $((n + 1)) > "${count}"
        "${REAL_GIT}" "$@" > /dev/null
        exit $?
    fi
    ;;
esac
exec "${REAL_GIT}" "$@"`,
    );
}

function lost(box: Sandbox): number {
    const file = join(box.root, "lost");
    return existsSync(file) ? Number(readFileSync(file, "utf8").trim()) : 0;
}

function setup(): { box: Sandbox; dir: string } {
    const box = sandbox();
    box.ok(["init", "--name", "mini", "--role", "coordinator"]);
    return { box, dir: withProject(box, "app") };
}

/** A recipe script outside the clone, so the worktree stays clean. */
function recipe(box: Sandbox, body: string): string {
    const file = join(box.root, "verify.sh");
    writeFileSync(file, `${body}\n`);
    return `sh ${file}`;
}

function records(box: Sandbox): { sha: string; status: string; reason?: string }[] {
    const dir = join(box.root, "state", "gates", "app");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
}

const HEAD_READS = ["rev-parse HEAD", "rev-parse --verify --quiet HEAD^{commit}"];

describe("git output lost on a loaded machine", () => {
    test("a HEAD read whose output is lost once is read again, so the gate records the real commit", () => {
        const { box, dir } = setup();
        const sha = box.git(dir, ["rev-parse", "HEAD"]);
        lossyGit(box, HEAD_READS, 1);
        const verify = recipe(box, "echo ok");
        expect(box.ok(["gate", "run", "app", "--recipe", verify])).toContain("passed");
        expect(lost(box)).toBe(1);
        expect(records(box)).toEqual([expect.objectContaining({ sha, status: "passed" })]);
    });

    test("a HEAD read that keeps coming back empty is refused, never used as a sha", () => {
        const { box } = setup();
        lossyGit(box, HEAD_READS, null);
        const refused = box.toli(["gate", "run", "app", "--recipe", recipe(box, "echo ok")]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("succeeded twice but printed nothing instead of a commit sha");
        expect(records(box)).toEqual([]);
    });

    test("a dirty checkout whose git status output is lost is still refused by the gate", () => {
        const { box, dir } = setup();
        writeFileSync(join(dir, "README"), "changed\n");
        lossyGit(box, ["status --porcelain", "--exclude-standard -z"], null);
        const refused = box.toli(["gate", "run", "app", "--recipe", recipe(box, "echo ok")]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("differs from its HEAD commit (changes git status did not list)");
        expect(records(box)).toEqual([]);
    });

    test("a merge over local changes whose git status output is lost is still refused by commit", () => {
        const { box, dir } = setup();
        writeFileSync(join(dir, "g.txt"), "main\n");
        box.ok(["commit", "app", "-m", "add g", "--", "g.txt"]);
        box.git(dir, ["switch", "--quiet", "-c", "feature"]);
        writeFileSync(join(dir, "g.txt"), "feature\n");
        box.ok(["commit", "app", "-m", "change g", "--", "g.txt"]);
        box.git(dir, ["switch", "--quiet", "main"]);
        const before = box.git(dir, ["rev-parse", "HEAD"]);
        writeFileSync(join(dir, "g.txt"), "local, uncommitted\n");
        lossyGit(box, ["--ignored=matching -- g.txt", "-z -- g.txt"], null);
        const refused = box.toli(["commit", "app", "--merge", "feature", "-m", "Merge feature"]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("local changes to files the merge changes: g.txt");
        expect(box.git(dir, ["rev-parse", "HEAD"])).toBe(before);
        expect(readFileSync(join(dir, "g.txt"), "utf8")).toBe("local, uncommitted\n");
    });
});
