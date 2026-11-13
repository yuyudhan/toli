// AGENTS.md rule 5 in code (src/fleet/build-place.ts): `bin/toli build-slot` and the cargo shim refuse a build whose
// working tree is not a registered clone, a task worktree toli made or toli's own checkout, unless an override with a
// reason is set (and logged); `disk keep` and `doctor` flag, never delete, build folders and worktrees outside them.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CARGO_SHIM, runs, slotBox, start, toliArgs } from "./build-slot-fixture.ts";
import { type Sandbox, tempDir, withProject } from "./helpers.ts";

/** A sandbox with project `app` cloned, plus a git repo outside every allowed place (a stray clone or export). */
function placeBox(): { box: Sandbox; log: string; clone: string; outside: string } {
    const { box, log } = slotBox(1, 2);
    const clone = withProject(box, "app");
    const outside = tempDir("outside");
    box.git(outside, ["init", "--initial-branch=main"]);
    return { box, log, clone, outside };
}

/** A detached git worktree of `clone` at `path`. */
function worktree(box: Sandbox, clone: string, path: string): string {
    box.git(clone, ["worktree", "add", "--detach", path]);
    return realpathSync(path);
}

describe("build place guard", () => {
    test("build-slot and the cargo shim refuse builds outside the clones", async () => {
        const { box, log, clone, outside } = placeBox();
        const exported = tempDir("export");
        writeFileSync(join(exported, "Cargo.toml"), "[package]\n");
        const stray = worktree(box, clone, join(box.root, ".worktrees", "mine"));
        const refused = [
            await start(box, toliArgs("build-slot", "--", "cargo", "build"), { STUB_LABEL: "a" }, outside).done,
            await start(box, [CARGO_SHIM, "build"], { STUB_LABEL: "b" }, exported).done,
            await start(box, [CARGO_SHIM, "test"], { STUB_LABEL: "c", TOLI_BUILD_SLOT: "1" }, outside).done,
            await start(box, [CARGO_SHIM, "check"], { STUB_LABEL: "d" }, stray).done,
        ];
        for (const result of refused) {
            expect(result.code).not.toBe(0);
            expect(result.stderr).toContain("refusing to build in");
            expect(result.stderr).toContain("TOLI_BUILD_PLACE_OVERRIDE");
        }
        expect(refused[0]?.stderr).toContain(realpathSync(outside));
        expect(refused[1]?.stderr).toContain(realpathSync(exported));
        expect(refused[3]?.stderr).toContain(stray);
        // A light cargo command builds nothing, so it runs anywhere.
        const light = await start(box, [CARGO_SHIM, "metadata"], { STUB_LABEL: "e" }, outside).done;
        expect(light.code).toBe(0);
        expect(runs(log).map((run) => run.label)).toEqual(["e"]);
    }, 60_000);

    test("the clone, toli's checkout, toli's task worktrees and no-mistakes run worktrees build", async () => {
        const { box, log, clone } = placeBox();
        const nmHome = join(box.root, ".no-mistakes");
        const task = worktree(box, clone, join(box.root, "projects", ".worktrees", "app", "T1"));
        const gateRun = worktree(box, clone, join(nmHome, "worktrees", "app-1", "run-1"));
        mkdirSync(join(clone, "crates", "core"), { recursive: true });
        const env = { NM_HOME: nmHome };
        const built = [
            await start(box, [CARGO_SHIM, "build"], { ...env, STUB_LABEL: "clone" }, clone).done,
            await start(box, [CARGO_SHIM, "build"], { ...env, STUB_LABEL: "sub" }, join(clone, "crates", "core")).done,
            await start(box, toliArgs("build-slot", "--", "cargo", "test"), { ...env, STUB_LABEL: "toli" }).done,
            await start(box, [CARGO_SHIM, "build"], { ...env, STUB_LABEL: "task" }, task).done,
            await start(box, [CARGO_SHIM, "build"], { ...env, STUB_LABEL: "gate" }, gateRun).done,
        ];
        expect(built.map((result) => result.code)).toEqual([0, 0, 0, 0, 0]);
        expect(runs(log).map((run) => run.label)).toEqual(["clone", "sub", "toli", "task", "gate"]);
    }, 60_000);

    test("--manifest-path decides the working tree, not the cwd", async () => {
        const { box, log, clone, outside } = placeBox();
        const away = join(outside, "Cargo.toml");
        const refused = [
            await start(box, [CARGO_SHIM, "build", "--manifest-path", away], { STUB_LABEL: "a" }, clone).done,
            await start(box, [CARGO_SHIM, "build", `--manifest-path=${away}`], { STUB_LABEL: "b" }, clone).done,
        ];
        expect(refused.map((result) => result.code)).toEqual([1, 1]);
        const home = join(clone, "Cargo.toml");
        const allowed = await start(box, [CARGO_SHIM, "build", "--manifest-path", home], { STUB_LABEL: "c" }, outside)
            .done;
        expect(allowed.code).toBe(0);
        // After `--` the words are the program's, not cargo's.
        const passed = await start(box, [CARGO_SHIM, "run", "--", "--manifest-path", away], { STUB_LABEL: "d" }, clone)
            .done;
        expect(passed.code).toBe(0);
        expect(runs(log).map((run) => run.label)).toEqual(["c", "d"]);
    }, 60_000);

    test("TOLI_BUILD_PLACE_OVERRIDE with a reason builds anyway and is logged", async () => {
        const { box, log, outside } = placeBox();
        const blank = await start(box, [CARGO_SHIM, "build"], { TOLI_BUILD_PLACE_OVERRIDE: "  " }, outside).done;
        expect(blank.code).toBe(1);
        const reason = "bisecting v0.1 in a scratch clone, Malik's word";
        const result = await start(box, [CARGO_SHIM, "build"], { TOLI_BUILD_PLACE_OVERRIDE: reason }, outside).done;
        expect(result.code).toBe(0);
        expect(result.stderr).toContain("building outside the clones");
        expect(runs(log)).toHaveLength(1);
        const logged = readFileSync(join(box.root, "logs", "build-place.log"), "utf8")
            .trim()
            .split("\n");
        expect(logged).toHaveLength(1);
        const entry = JSON.parse(logged[0] ?? "{}") as Record<string, unknown>;
        expect(entry.tree).toBe(realpathSync(outside));
        expect(entry.reason).toBe(reason);
        expect(String(entry.command)).toContain("build");
    }, 60_000);

    test("disk keep and doctor flag build folders and worktrees outside the clones, deleting nothing", () => {
        const { box, clone } = placeBox();
        const scan = tempDir("scan");
        mkdirSync(join(scan, "export", "target", "debug"), { recursive: true });
        mkdirSync(join(scan, "a", "b", "web", "node_modules", "left-pad"), { recursive: true });
        mkdirSync(join(scan, "clean", "src"), { recursive: true });
        const stray = worktree(box, clone, join(scan, "wt"));
        worktree(box, clone, join(box.root, "projects", ".worktrees", "app", "T1"));
        mkdirSync(join(box.root, "projects", ".worktrees", "app", "T1", "target"));
        mkdirSync(join(clone, "target"));
        const env = { TOLI_BUILD_SCAN_ROOTS: `${scan}:${box.root}` };
        const real = realpathSync(scan);
        const flagged = [join(real, "export"), join(real, "a", "b", "web"), stray];

        const keep = box.toli(["disk", "keep", "--dry-run"], { env });
        expect(keep.code).toBe(0);
        for (const path of flagged) expect(keep.stdout).toContain(path);
        expect(keep.stdout).not.toContain(join(real, "clean"));
        expect(keep.stdout).not.toContain("T1");
        const json = JSON.parse(box.toli(["disk", "keep", "--dry-run", "--json"], { env }).stdout) as {
            outsideBuilds: { path: string; why: string }[];
        };
        expect(json.outsideBuilds.map((entry) => entry.path).sort()).toEqual([...flagged].sort());

        const doctor = JSON.parse(box.toli(["doctor", "--json"], { env }).stdout) as {
            level: string;
            name: string;
            detail: string;
        }[];
        const lines = doctor.filter((check) => check.name === "build-place");
        expect(lines.map((check) => check.level)).toEqual(["warn", "warn", "warn"]);
        for (const path of flagged) expect(lines.some((check) => check.detail.includes(path))).toBe(true);
        expect(existsSync(join(scan, "export", "target", "debug"))).toBe(true);
        expect(existsSync(join(scan, "a", "b", "web", "node_modules", "left-pad"))).toBe(true);
        expect(existsSync(stray)).toBe(true);
    }, 60_000);

    test("doctor says ok when every build is in its place", () => {
        const { box } = placeBox();
        const scan = tempDir("scan");
        mkdirSync(join(scan, "clean", "src"), { recursive: true });
        const doctor = JSON.parse(box.toli(["doctor", "--json"], { env: { TOLI_BUILD_SCAN_ROOTS: scan } }).stdout) as {
            level: string;
            name: string;
        }[];
        expect(doctor.filter((check) => check.name === "build-place").map((check) => check.level)).toEqual(["ok"]);
    }, 60_000);
});
