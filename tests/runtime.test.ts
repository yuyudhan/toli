import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runtimeCommand } from "../src/release/runtime.ts";
import { commandIn, GIT_ENV } from "./helpers.ts";

const REPO = resolve(import.meta.dir, "..");
const temps: string[] = [];

afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

type Checkout = {
    dir: string;
    runtimeHome: string;
    toli(args: string[], env?: Record<string, string>): { code: number; stdout: string; stderr: string };
    git(args: string[]): void;
};

/** A git checkout holding this working tree's bin/ and src/, as a live toli checkout would, with its own runtime home. */
function checkout(): Checkout {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "toli-runtime-")));
    temps.push(base);
    const dir = join(base, "toli");
    for (const part of ["bin", "src", "package.json"]) cpSync(join(REPO, part), join(dir, part), { recursive: true });
    const runtimeHome = join(base, "runtime-home");
    const env: Record<string, string | undefined> = {
        ...process.env,
        ...GIT_ENV,
        TOLI_RUNTIME_HOME: runtimeHome,
        TOLI_DRY_RUN: "1",
        TOLI_ROOT: undefined,
        TOLI_DEV: undefined,
    };
    const git = (args: string[]) => {
        const proc = Bun.spawnSync(["git", "-C", dir, ...args], { env, stdout: "pipe", stderr: "pipe" });
        if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
    };
    git(["init", "--quiet", "-b", "develop"]);
    git(["add", "--all"]);
    git(["commit", "--quiet", "-m", "seed"]);
    const toli: Checkout["toli"] = (args, extra = {}) => {
        const proc = Bun.spawnSync([process.execPath, join(dir, "bin", "toli"), ...args], {
            cwd: dir,
            env: { ...env, ...extra },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        });
        return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    };
    const made = { dir, runtimeHome, toli, git };
    const init = toli(["init", "--name", "testbox", "--role", "coordinator"]);
    if (init.code !== 0) throw new Error(`init: ${init.stderr}`);
    return made;
}

describe("installed runtime", () => {
    test("a broken working tree does not break the tick once a runtime is installed", () => {
        const live = checkout();
        const synced = live.toli(["self", "sync", "--json"]);
        expect(synced.stderr).toBe("");
        expect(synced.code).toBe(0);
        const runtime = String(JSON.parse(synced.stdout).runtime);
        expect(runtime.startsWith(live.runtimeHome)).toBe(true);
        expect(readFileSync(join(live.dir, "state", "runtime"), "utf8").trim()).toBe(runtime);

        appendFileSync(join(live.dir, "src", "core", "util.ts"), "\nexport const broken = ;\n");
        const due = live.toli(["job", "due", "--json"]);
        expect(due.stderr).toBe("");
        expect(due.code).toBe(0);
        expect(JSON.parse(due.stdout)).toEqual([]);

        const status = JSON.parse(live.toli(["self", "status", "--json"]).stdout);
        expect(status).toMatchObject({ root: live.dir, code: runtime, runtime, state: "current" });

        // The working tree itself is broken: TOLI_DEV=1 runs it.
        expect(live.toli(["job", "due", "--json"], { TOLI_DEV: "1" }).code).not.toBe(0);
    });

    test("sync refuses a commit that does not load and keeps the previous runtime", () => {
        const live = checkout();
        expect(live.toli(["self", "sync"]).code).toBe(0);
        const before = readFileSync(join(live.dir, "state", "runtime"), "utf8");

        appendFileSync(join(live.dir, "src", "core", "util.ts"), "\nexport const broken = ;\n");
        live.git(["commit", "--quiet", "-am", "break util"]);
        const refused = live.toli(["self", "sync"]);
        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain("does not run");
        expect(refused.stderr).toContain("the live session keeps its current runtime");
        expect(readFileSync(join(live.dir, "state", "runtime"), "utf8")).toBe(before);

        expect(live.toli(["job", "due", "--json"]).code).toBe(0);
        expect(JSON.parse(live.toli(["self", "status", "--json"]).stdout).state).toBe("stale");
    });

    test("a pointer to a deleted snapshot falls back to the working tree", () => {
        const live = checkout();
        const runtime = String(JSON.parse(live.toli(["self", "sync", "--json"]).stdout).runtime);
        rmSync(runtime, { recursive: true, force: true });
        const status = live.toli(["self", "status", "--json"]);
        expect(status.code).toBe(0);
        expect(JSON.parse(status.stdout)).toMatchObject({ code: live.dir, state: "missing" });
    });

    test("status without a runtime names the working tree (in-process)", () => {
        const live = checkout();
        const status = commandIn(live.dir, runtimeCommand)(["status"]);
        expect(status).toContain("no installed runtime");
        expect(existsSync(join(live.dir, "state", "runtime"))).toBe(false);
    });
});
