// A jawan's cargo holds a heavy-build slot even when something puts another cargo ahead of toli's cargo shim on PATH
// (T1223: on a Linux worker a shell profile and git's exec path put `~/.cargo/bin` first, and a pre-push hook's clippy and
// a `just verify push` ran the real cargo outside any slot at once). toli's rustc wrapper, cargo's `RUSTC_WRAPPER` in
// a jawan's environment (src/jawans/env.ts), catches such a cargo on its first rustc call. That call must come first
// and the test harnesses must be capped too (T1322: on a Linux worker a plain `git push`'s pre-push hook ran `cargo test`
// with nothing left to compile: cargo's cached rustc probe meant no rustc call ever reached the wrapper, so it ran
// outside any slot, and rustdoc compiled its doctests one rustc per core, 12 against a share of 6).
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "../src/core/paths.ts";
import { jawanEnv } from "../src/jawans/env.ts";
import { CARGO_SHIM, type Run, runs, slotBox, start, until } from "./build-slot-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";

/** An executable `/bin/sh` script at `file`. */
function script(file: string, body: string): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
}

/**
 * A real-looking cargo installation (`<root>/.cargo/bin`, as rustup makes it): a cargo that probes rustc through
 * `RUSTC_WRAPPER` first, as cargo does, then logs its run like the fixture's stub cargo and stays busy for up to
 * STUB_SLEEP fifths of a second (until `<log>.done-<label>`); with NESTED set it first runs a nested `cargo check`,
 * as cargo-clippy does. Like cargo, it caches the probe in `target/.rustc_info.json` and skips it while that file
 * is there, unless `CARGO_CACHE_RUSTC_INFO=0` (cargo 1.9x on a fresh `cargo test` calls its `RUSTC_WRAPPER` zero
 * times; with `CARGO_CACHE_RUSTC_INFO=0` its first call is `rustc -vV`). It logs `<label> held=<yes|no>
 * threads=<RUST_TEST_THREADS>/<NEXTEST_TEST_THREADS>` to `<log>.share`: whether a slot holder held a slot for it
 * once it was past its probe, and the test-thread caps it got. Returns its bin folder.
 */
function realCargo(box: Sandbox, log: string): string {
    const bin = join(box.root, ".cargo", "bin");
    script(join(bin, "rustc"), 'echo "rustc 1.90.0 (fake)"');
    script(
        join(bin, "cargo"),
        [
            "ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
            'here=$(dirname "$0")',
            'cache="$PWD/target/.rustc_info.json"',
            'if [ "${CARGO_CACHE_RUSTC_INFO:-1}" = 0 ] || [ ! -e "$cache" ]; then',
            '    if [ -n "${RUSTC_WRAPPER:-}" ]; then "$RUSTC_WRAPPER" "$here/rustc" -vV >/dev/null || exit 1;',
            '    else "$here/rustc" -vV >/dev/null || exit 1; fi',
            '    if [ "${CARGO_CACHE_RUSTC_INFO:-1}" != 0 ]; then mkdir -p "$PWD/target" && : >"$cache"; fi',
            "fi",
            'held=no; [ -e "$TOLI_ROOT/state/build-slots/cargo-$$.held" ] && held=yes',
            `echo "\${STUB_LABEL:-x} held=$held threads=\${RUST_TEST_THREADS:-none}/\${NEXTEST_TEST_THREADS:-none}" >> ${log}.share`,
            `echo "start \${STUB_LABEL:-x} $(ms) \${TOLI_BUILD_SLOT:-none} \${CARGO_BUILD_JOBS:-none} $*" >> ${log}`,
            'if [ -n "${NESTED:-}" ]; then NESTED="" STUB_LABEL="${STUB_LABEL:-x}-inner" STUB_SLEEP=0 "$0" check || exit 1; fi',
            `n="\${STUB_SLEEP:-0}"; while [ "$n" -gt 0 ] && [ ! -e "${log}.done-\${STUB_LABEL:-x}" ] &&`,
            '    kill -0 "$PPID" 2>/dev/null; do sleep 0.2; n=$((n - 1)); done',
            `echo "end \${STUB_LABEL:-x} $(ms)" >> ${log}`,
        ].join("\n"),
    );
    return bin;
}

/** The `realCargo` share lines of the runs labelled `label`. */
const shareLines = (log: string, label: string): string[] =>
    existsSync(`${log}.share`)
        ? readFileSync(`${log}.share`, "utf8")
              .trim()
              .split("\n")
              .filter((line) => line.startsWith(`${label} `))
        : [];

/**
 * A jawan's environment over the fixture's PATH, as `bin/toli spawn` builds it (a live-stack project's with
 * `liveStack`), without the host's cargo config.
 */
function jawan(box: Sandbox, liveStack = false): Record<string, string> {
    const path = [paths.buildShimsDir(), box.stubs, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin"];
    const env = jawanEnv({ PATH: path.join(":"), CARGO_HOME: join(box.root, ".cargo") }, "r1", 3, liveStack);
    return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/**
 * Project "app" whose pre-push hook runs its verify script, which (like a login profile, or git's exec path) puts
 * the real cargo `real` first and runs `cargo test`, as a client project's `just verify push` does; its last build left
 * cargo's rustc probe cache behind, so that `cargo test` has nothing left to compile. Returns the checkout.
 */
function pushTestProject(box: Sandbox, real: string): string {
    const dir = withProject(box, "app");
    script(join(dir, ".githooks", "pre-push"), "bash scripts/verify.sh");
    script(join(dir, "scripts", "verify.sh"), `PATH="${real}:$PATH"; export PATH\ncargo test --workspace`);
    box.git(dir, ["config", "core.hooksPath", ".githooks"]);
    box.git(dir, ["add", "-A"]);
    box.git(dir, ["commit", "-q", "-m", "hook"]);
    mkdirSync(join(dir, "target"));
    writeFileSync(join(dir, "target", ".rustc_info.json"), "{}");
    return dir;
}

/** The holder files the rustc wrapper's slot holders leave in state/build-slots. */
const holderFiles = (box: Sandbox): string[] =>
    readdirSync(join(box.root, "state", "build-slots")).filter((name) => name.startsWith("cargo-"));

/** How long a wait on a real process event may take on a machine under load (a full `just check` beside it). */
const LOADED_MS = 120_000;

/** The host's own build variables, cleared so only the jawan's environment decides what the hook's cargo gets. */
const HOST_CLEARED = { RUST_TEST_THREADS: "", NEXTEST_TEST_THREADS: "", CARGO_CACHE_RUSTC_INFO: "" };

/** `git push` of the checkout's HEAD to its origin's main. */
const PUSH = ["git", "push", "-q", "origin", "HEAD:refs/heads/main"];

describe("a cargo a jawan's plain `git push` starts in its pre-push hook (T1322)", () => {
    test(
        "with nothing left to compile, it still takes a slot before it runs, at one slot's share of jobs and test threads",
        async () => {
            const { box, log } = slotBox(1, 3);
            const dir = pushTestProject(box, realCargo(box, log));
            const push = start(box, PUSH, { ...HOST_CLEARED, ...jawan(box), STUB_LABEL: "t" }, dir);
            const result = await push.done;
            expect(result.code).toBe(0);
            expect(shareLines(log, "t")).toEqual(["t held=yes threads=3/3"]);
            expect(runs(log).find((run) => run.label === "t")).toMatchObject({ jobs: "3", args: "test --workspace" });
            await until("the holder's files gone", () => holderFiles(box).length === 0, LOADED_MS);
        },
        2 * LOADED_MS,
    );

    test(
        "in a live-stack project it skips the slot, still at one slot's share of jobs and test threads",
        async () => {
            const { box, log } = slotBox(1, 3);
            const dir = pushTestProject(box, realCargo(box, log));
            box.ok(["project", "set", "app", "--live-stack", "yes"]);
            const push = start(box, PUSH, { ...HOST_CLEARED, ...jawan(box, true), STUB_LABEL: "l" }, dir);
            const result = await push.done;
            expect(result.code).toBe(0);
            expect(shareLines(log, "l")).toEqual(["l held=no threads=3/3"]);
            expect(runs(log).find((run) => run.label === "l")).toMatchObject({ jobs: "3", args: "test --workspace" });
        },
        2 * LOADED_MS,
    );
});

describe("a cargo ahead of the shim on PATH still holds a heavy-build slot", () => {
    test(
        "a pre-push hook's script that puts ~/.cargo/bin first: its clippy holds the slot, the next build waits",
        async () => {
            const { box, log } = slotBox(1, 3);
            const real = realCargo(box, log);
            const dir = withProject(box, "app");
            // The project's hook runs its verify script, which (like a login profile) puts the real cargo first.
            script(join(dir, ".githooks", "pre-push"), "bash scripts/verify.sh");
            script(
                join(dir, "scripts", "verify.sh"),
                `PATH="${real}:$PATH"; export PATH\ncargo clippy --workspace --all-targets`,
            );
            box.git(dir, ["config", "core.hooksPath", ".githooks"]);
            box.git(dir, ["add", "-A"]);
            box.git(dir, ["commit", "-q", "-m", "hook"]);
            // The stub stays busy until the test writes `<log>.done-a`; its start line is logged only once its first rustc
            // call returned, so that line is the event "the hook's clippy holds the slot". Under a loaded machine a git
            // push plus a few bun cold starts can take well over 15 s, so the waits get a generous deadline instead.
            const env = { ...jawan(box), STUB_LABEL: "a", STUB_SLEEP: "1500" };
            const push = start(box, ["git", "push", "-q", "origin", "HEAD:refs/heads/main"], env, dir);
            await until("the hook's clippy", () => runs(log).some((run) => run.label === "a"), LOADED_MS);
            expect(runs(log).find((run) => run.label === "a")).toMatchObject({
                jobs: "3",
                args: "clippy --workspace --all-targets",
            });
            const second = start(box, [CARGO_SHIM, "build"], { STUB_LABEL: "b" });
            await until(
                "the second build waiting",
                () => second.stderr.join("").includes("waiting for a heavy-build slot (1 busy)"),
                LOADED_MS,
            );
            expect(runs(log).some((run) => run.label === "b")).toBe(false);
            writeFileSync(`${log}.done-a`, "");
            const [pushed, built] = await Promise.all([push.done, second.done]);
            expect([pushed.code, built.code]).toEqual([0, 0]);
            const a = runs(log).find((run) => run.label === "a") as Run;
            const b = runs(log).find((run) => run.label === "b") as Run;
            expect(b.start).toBeGreaterThanOrEqual(a.end);
            await until("the holder's files gone", () => holderFiles(box).length === 0, LOADED_MS);
        },
        4 * LOADED_MS,
    );

    test(
        "a nested cargo under a cargo that holds its slot through the wrapper reuses it, never deadlocks",
        async () => {
            const { box, log } = slotBox(1, 3);
            const real = realCargo(box, log);
            const env = { ...jawan(box), PATH: `${real}:${jawan(box).PATH}`, STUB_LABEL: "o", NESTED: "1" };
            const outer = start(box, [join(real, "cargo"), "clippy"], env);
            const result = await outer.done;
            expect(result.code).toBe(0);
            expect(result.stderr).not.toContain("waiting");
            expect(runs(log).map((run) => [run.label, run.args])).toEqual([
                ["o", "clippy"],
                ["o-inner", "check"],
            ]);
        },
        LOADED_MS,
    );

    test(
        "a cargo killed with SIGKILL frees the slot its holder took",
        async () => {
            const { box, log } = slotBox(1, 3);
            const real = realCargo(box, log);
            const env = { ...jawan(box), STUB_LABEL: "k", STUB_SLEEP: "1500" };
            const killed = start(box, [join(real, "cargo"), "build"], env);
            await until("the killed build", () => runs(log).some((run) => run.label === "k"), LOADED_MS);
            expect(holderFiles(box).some((name) => name.endsWith(".held"))).toBe(true);
            const next = start(box, [CARGO_SHIM, "test"], { STUB_LABEL: "n" });
            await until(
                "the next build waiting",
                () => next.stderr.join("").includes("waiting for a heavy-build slot"),
                LOADED_MS,
            );
            killed.proc.kill("SIGKILL");
            const result = await next.done;
            expect(result.code).toBe(0);
            expect(runs(log).find((run) => run.label === "n")).toMatchObject({ slot: "1", args: "test" });
            await until("the holder's files gone", () => holderFiles(box).length === 0, LOADED_MS);
            expect(existsSync(join(box.root, "state", "build-slots", "1.lock"))).toBe(true);
        },
        4 * LOADED_MS,
    );

    test(
        "light cargo commands run past the wrapper at once while every slot is busy",
        async () => {
            const { box, log } = slotBox(1, 3);
            const real = realCargo(box, log);
            const holder = start(box, [CARGO_SHIM, "build"], { STUB_LABEL: "h", STUB_SLEEP: "1500" });
            await until("the holding build", () => runs(log).some((run) => run.label === "h"), LOADED_MS);
            const metadata = await start(box, [join(real, "cargo"), "metadata"], { ...jawan(box), STUB_LABEL: "m" })
                .done;
            holder.proc.kill("SIGKILL");
            expect(metadata.code).toBe(0);
            expect(metadata.stderr).not.toContain("waiting");
            expect(runs(log).find((run) => run.label === "m")).toMatchObject({ args: "metadata" });
        },
        4 * LOADED_MS,
    );
});
