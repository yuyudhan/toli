// T2534: `just check` on a commit and then a push of that same commit ran the full suite twice: the pre-push hook only
// reuses a pass `bin/toli gate check` can prove, and `just check` recorded none. A clone carrying toli's real justfile
// and pre-push hook, whose `bin/toli` is the real CLI on a data root of its own and whose `bun run check` counts its
// runs: a passed `just check` on the pushed commit is reused by the hook, while a commit nobody checked is still checked.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GIT_ENV, TOLI_BIN, tempDir } from "./helpers.ts";

const REPO = resolve(import.meta.dir, "..");

// Each test runs real gates and real pushes through the hook; on a loaded machine that passes 5 s.
setDefaultTimeout(120_000);

type Run = { code: number; output: string };

function clone(): { dir: string; runs: () => number; run: (cmd: string[]) => Run; commit: (name: string) => void } {
    const root = tempDir("checkgate");
    const stubs = join(root, "stubs");
    const origin = join(root, "origin.git");
    const dir = join(root, "clone");
    const count = join(root, "count");
    for (const path of [stubs, origin, join(dir, ".githooks"), join(dir, "bin")]) mkdirSync(path, { recursive: true });
    writeFileSync(join(stubs, "gitleaks"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(stubs, "gitleaks"), 0o755);
    copyFileSync(join(REPO, "Justfile"), join(dir, "Justfile"));
    copyFileSync(join(REPO, ".githooks", "pre-push"), join(dir, ".githooks", "pre-push"));
    chmodSync(join(dir, ".githooks", "pre-push"), 0o755);
    writeFileSync(join(dir, "bin", "toli"), `#!/bin/sh\nexec "${process.execPath}" "${TOLI_BIN}" "$@"\n`);
    chmodSync(join(dir, "bin", "toli"), 0o755);
    writeFileSync(
        join(dir, "package.json"),
        `${JSON.stringify({ name: "clone", private: true, scripts: { check: `echo run >> "${count}"` } })}\n`,
    );
    // What the CLI writes under its data root (the clone) stays out of the checkout's status.
    writeFileSync(join(dir, ".gitignore"), "config/\ndata/\nlogs/\nstate/\n");
    const just = Bun.which("just");
    if (just === null) throw new Error("just is not on PATH");
    // The hook decides TOLI_DEV itself, so a caller's (toli's own gate runs this suite with TOLI_DEV=1) is dropped.
    const { TOLI_DEV: _callerDev, ...callerEnv } = process.env;
    const env = {
        ...callerEnv,
        ...GIT_ENV,
        TOLI_ROOT: dir,
        PATH: [stubs, dirname(process.execPath), dirname(just), "/usr/bin", "/bin"].join(":"),
        // As in sandbox(): the gate's heavy-build slot reads builds from this table, never the host's processes, it
        // starts no systemd scope, and it is never joined to the host jawan's task or run.
        TOLI_PROCESS_TABLE: join(root, ".process-table"),
        TOLI_BUILD_SCOPE: "off",
        TOLI_JAWAN_SCOPE: "off",
        TOLI_JOURNAL: "off",
        TOLI_TASK: "",
        TOLI_RUN_ID: "",
    };
    const run = (cmd: string[]): Run => {
        // A hung gate fails the test instead of the whole run.
        const proc = Bun.spawnSync(cmd, { cwd: dir, env, stdout: "pipe", stderr: "pipe", timeout: 90_000 });
        return { code: proc.exitCode ?? 1, output: proc.stdout.toString() + proc.stderr.toString() };
    };
    const git = (cwd: string, args: string[]): void => {
        const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { env, stdout: "pipe", stderr: "pipe" });
        if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
    };
    git(origin, ["init", "--bare", "--initial-branch=main"]);
    git(dir, ["init", "--initial-branch=main"]);
    git(dir, ["config", "core.hooksPath", ".githooks"]);
    git(dir, ["remote", "add", "origin", origin]);
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "seed"]);
    const commit = (name: string): void => {
        writeFileSync(join(dir, name), `${name}\n`);
        git(dir, ["add", name]);
        git(dir, ["commit", "-m", `add ${name}`]);
    };
    const runs = (): number => (existsSync(count) ? readFileSync(count, "utf8").trim().split("\n").length : 0);
    return { dir, runs, run, commit };
}

describe("a passed `just check` and the pre-push hook (T2534)", () => {
    test("a push of the commit `just check` passed on reuses its pass; a commit nobody checked is checked", () => {
        const { runs, run, commit } = clone();
        const checked = run(["just", "check"]);
        expect(checked.code).toBe(0);
        expect(runs()).toBe(1);

        const pushed = run(["git", "push", "origin", "main"]);
        expect(pushed.code).toBe(0);
        expect(pushed.output).toContain("bun run check already passed on");
        expect(runs()).toBe(1);

        commit("b.txt");
        const unchecked = run(["git", "push", "origin", "main"]);
        expect(unchecked.code).toBe(0);
        expect(unchecked.output).toContain("pre-push: bun run check on");
        expect(runs()).toBe(2);
    });

    test("`just check` on a checkout with uncommitted changes runs on the working tree and records nothing", () => {
        const { dir, runs, run } = clone();
        writeFileSync(join(dir, "wip.txt"), "half done\n");
        expect(run(["just", "check"]).code).toBe(0);
        expect(runs()).toBe(1);
        expect(run(["bin/toli", "gate", "check", "toli", "--sha", "HEAD", "--recipe", "bun run check"]).code).toBe(1);
    });
});
