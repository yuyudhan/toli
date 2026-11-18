// A target wipe renames the target aside (`<target>.toli-wipe-<ms>`) before deleting it: git never lists that folder,
// root-owned files in it go through a throwaway container, and what still stays is reported, then deleted first by
// the next keeper run.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { renameAside } from "../src/fleet/cargo-lock.ts";
import type { KeepReport } from "../src/fleet/disk.ts";
import { buildOutput, dfLine, keeperBox, keeperTest } from "./disk-fixture.ts";
import { GIT_ENV, type Sandbox, tempDir, withProject } from "./helpers.ts";

/** `docker` that answers and, on `run`, removes what it is asked to as root would (the bound parent + last arg). */
const ROOT_REMOVER = `case "$1" in
info) echo 29 ;;
ps | volume | system) exit 0 ;;
run)
    src=""; last=""
    for arg in "$@"; do
        case "$arg" in type=bind,source=*) src="\${arg#type=bind,source=}"; src="\${src%%,target=*}" ;; esac
        last="$arg"
    done
    chmod -R u+w "$src/\${last#/toli-parent/}" && rm -rf "$src/\${last#/toli-parent/}" ;;
*) echo "Total reclaimed space: 0B" ;;
esac`;

function git(cwd: string, args: string[]): string {
    const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...GIT_ENV } });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString();
}

describe("a target renamed aside for deletion", () => {
    test("is ignored by git, which no longer matches the target's own ignore pattern", () => {
        const repo = realpathSync(tempDir("aside"));
        git(repo, ["init", "-q"]);
        writeFileSync(join(repo, ".gitignore"), "target/\n");
        git(repo, ["add", ".gitignore"]);
        git(repo, ["commit", "-qm", "ignore target"]);
        const target = join(repo, "apps", "backend", "target");
        mkdirSync(join(target, "debug", "deps"), { recursive: true });
        writeFileSync(join(target, "debug", "deps", "libx.rlib"), "x");
        const aside = renameAside(target);
        expect(aside).not.toBeNull();
        expect(basename(aside ?? "")).toMatch(/^target\.toli-wipe-\d+$/);
        expect(existsSync(join(aside ?? "", "debug", "deps", "libx.rlib"))).toBe(true);
        expect(git(repo, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
        // Through the checkout's excludes, written once however many wipes there are.
        mkdirSync(target);
        renameAside(target);
        const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8").split("\n");
        expect(exclude.filter((line) => line === "*.toli-wipe-*")).toHaveLength(1);
    });
});

/** An idle clone `alpha` whose target holds files this account cannot delete, as a container running as root leaves. */
function rootOwnedTarget(box: Sandbox): { clone: string; deps: string } {
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    const clone = realpathSync(withProject(box, "alpha"));
    buildOutput(box, clone);
    const deps = join(clone, "target", "debug", "deps");
    chmodSync(deps, 0o555);
    box.stub("sccache", "exit 2");
    box.stub("df", `kb=${100 * 1048576}\n${dfLine(200)}`);
    return { clone, deps };
}

function keepNow(box: Sandbox): string {
    const keep = ["disk", "keep", "--floor", "1000000000", "--json"];
    return (JSON.parse(box.ok(keep, { env: { TOLI_DRY_RUN: "0" } })) as KeepReport).lines.join("\n");
}

/** Make every leftover writable again so the sandbox can be cleaned up. */
function unlock(clone: string): void {
    for (const name of readdirSync(clone)) {
        const deps = join(clone, name, "debug", "deps");
        if (existsSync(deps)) chmodSync(deps, 0o755);
    }
}

describe("a root-owned target", () => {
    keeperTest("is wiped through a throwaway container, leaving no renamed-aside folder", () => {
        const box = keeperBox();
        const { clone } = rootOwnedTarget(box);
        box.stub("docker", ROOT_REMOVER);
        try {
            expect(keepNow(box)).toContain(`deleted ${join(clone, "target")}, freed `);
            expect(readdirSync(clone).filter((name) => name.includes(".toli-wipe-"))).toEqual([]);
        } finally {
            unlock(clone);
        }
    });

    keeperTest("that docker cannot reach is reported, kept out of git status, and deleted by the next run", () => {
        const box = keeperBox();
        const { clone } = rootOwnedTarget(box);
        box.stub("docker", "exit 1");
        try {
            const lines = keepNow(box);
            const aside = readdirSync(clone).find((name) => name.startsWith("target.toli-wipe-")) ?? "";
            expect(aside).not.toBe("");
            expect(lines).toContain(
                `kept ${join(clone, "target")}: renamed aside to ${join(clone, aside)}, which stays: it holds root-owned files, and docker is not reachable to remove them (never sudo)`,
            );
            expect(box.git(clone, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
            box.stub("docker", ROOT_REMOVER);
            expect(keepNow(box)).toContain(
                `deleted ${join(clone, aside)}, freed 0.0 GB (step 0: leftover of an interrupted target wipe)`,
            );
            expect(existsSync(join(clone, aside))).toBe(false);
        } finally {
            unlock(clone);
        }
    });
});

describe("disk keeper", () => {
    keeperTest("takes a renamed-aside target a killed keeper left first, with or without its .gitignore", () => {
        const box = keeperBox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const clone = realpathSync(withProject(box, "alpha"));
        buildOutput(box, clone);
        mkdirSync(join(clone, "apps", "backend"), { recursive: true });
        writeFileSync(join(clone, "apps", "backend", "Cargo.toml"), "[package]\n");
        box.git(clone, ["add", "apps/backend/Cargo.toml"]);
        box.git(clone, ["commit", "-m", "backend"]);
        const ignored = join(clone, "apps", "backend", "target.toli-wipe-1795003985234");
        mkdirSync(join(ignored, "debug"), { recursive: true });
        writeFileSync(join(ignored, ".gitignore"), "*\n");
        writeFileSync(join(ignored, "debug", "libx.rlib"), "x".repeat(4096));
        // Left by a keeper from before the wipe wrote a .gitignore: merely untracked.
        const untracked = join(clone, "target.toli-wipe-1795003985000");
        mkdirSync(join(untracked, "debug"), { recursive: true });
        writeFileSync(join(untracked, "debug", "libx.rlib"), "x".repeat(4096));
        // An untracked folder of the user's that only looks similar is never touched.
        const own = join(clone, "notes.toli-wipe-draft");
        mkdirSync(own);
        writeFileSync(join(own, "todo.md"), "keep\n");
        box.stub("docker", "exit 1");
        box.stub("sccache", "exit 2");
        box.stub("df", `kb=${100 * 1048576}\n${dfLine(200)}`);
        // The sandbox runs dry (TOLI_DRY_RUN): the plan is the evidence, and nothing is deleted.
        const report = JSON.parse(box.ok(["disk", "keep", "--floor", "1000000000", "--json"])) as KeepReport;
        const lines = report.lines.join("\n");
        const step = "step 0: leftover of an interrupted target wipe)";
        expect(lines).toContain(`would delete ${ignored} (`);
        expect(lines).toContain(`would delete ${untracked} (`);
        expect(lines.split("\n").filter((line) => line.endsWith(step))).toHaveLength(2);
        expect(lines.indexOf(step)).toBeLessThan(lines.indexOf("step 1: idle target)"));
        expect(lines).not.toContain("notes.toli-wipe-draft");
        expect(existsSync(join(own, "todo.md"))).toBe(true);
    });
});
