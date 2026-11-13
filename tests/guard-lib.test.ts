// The repo guards' scope and line helpers (scripts/guard-lib.ts), read from this checkout's own history and tree.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { collectScope, eachLine, isCode, lineCount, ROOT } from "../scripts/guard-lib.ts";

/** A published commit (on main since v0.5.10) and its parent: a fixed range whose files never change. */
const PARENT = "bc848ac48245c6e70f8e68b4228af9777910c712";
const COMMIT = "220b3a79db7bc690a116dd540dab2dbdaf78a1c5";

function show(rev: string, path: string): string {
    const proc = Bun.spawnSync(["git", "-C", ROOT, "show", `${rev}:${path}`], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`git show ${rev}:${path}: ${proc.stderr.toString()}`);
    return proc.stdout.toString();
}

describe("the guards' scope", () => {
    test("range mode reads each file the range added or modified at its tip", () => {
        const scope = collectScope({ TOLI_GUARD_RANGE: `${PARENT}..${COMMIT}` });
        expect(scope.description).toBe(`range mode: 4 file(s) changed in ${PARENT}..${COMMIT}, read at the range tip`);
        expect(scope.allowEmpty).toBe(true);
        expect(scope.notes).toEqual([]);
        expect(scope.files.map((file) => file.path)).toEqual([
            "CHANGELOG.md",
            "docs/sardars.md",
            "src/fleet/delegate.ts",
            "tests/delegate.test.ts",
        ]);
        for (const file of scope.files) expect(file.text).toBe(show(COMMIT, file.path));
    });

    test("a range that is not <rev>..<rev> is refused, and an empty one is allowed", () => {
        expect(() => collectScope({ TOLI_GUARD_RANGE: COMMIT })).toThrow(
            "TOLI_GUARD_RANGE must look like <rev>..<rev>",
        );
        expect(() => collectScope({ TOLI_GUARD_RANGE: `${PARENT}...${COMMIT}` })).toThrow(
            "TOLI_GUARD_RANGE must look like <rev>..<rev>",
        );
        const empty = collectScope({ TOLI_GUARD_RANGE: `${COMMIT}..${COMMIT}` });
        expect(empty).toEqual({
            description: `range mode: 0 file(s) changed in ${COMMIT}..${COMMIT}, read at the range tip`,
            files: [],
            notes: [],
            allowEmpty: true,
        });
    });

    test("the full tree reads every tracked file from the working tree and is never empty", () => {
        const scope = collectScope({});
        expect(scope.description).toMatch(/^full tree: \d+ file\(s\) from git ls-files$/);
        expect(scope.allowEmpty).toBe(false);
        const self = scope.files.find((file) => file.path === "scripts/guard-lib.ts");
        expect(self?.text).toBe(readFileSync(`${ROOT}scripts/guard-lib.ts`, "utf8"));
    });
});

describe("the guards' line helpers", () => {
    test("lineCount does not count the empty string after a final newline", () => {
        expect(lineCount("")).toBe(0);
        expect(lineCount("one")).toBe(1);
        expect(lineCount("one\n")).toBe(1);
        expect(lineCount("one\ntwo\n\n")).toBe(3);
    });

    test("eachLine visits every line with its 1-based number; isCode is TypeScript and bin/toli", () => {
        const seen: [number, string][] = [];
        eachLine("a\nb\n", (line, number) => seen.push([number, line]));
        expect(seen).toEqual([
            [1, "a"],
            [2, "b"],
            [3, ""],
        ]);
        expect(["src/a.ts", "bin/toli", "docs/a.md", "bin/other"].filter(isCode)).toEqual(["src/a.ts", "bin/toli"]);
    });
});
