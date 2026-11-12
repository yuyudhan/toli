// A jawan's cargo holds a heavy-build slot even when something puts another cargo ahead of toli's cargo shim on PATH
// (T1223: on itlinux8 a shell profile and git's exec path put `~/.cargo/bin` first, and a pre-push hook's clippy and
// a `just verify push` ran the real cargo outside any slot at once). toli's rustc wrapper, cargo's `RUSTC_WRAPPER` in
// a jawan's environment (src/jawans/env.ts), catches such a cargo on its first rustc call.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
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
 * as cargo-clippy does. Returns its bin folder.
 */
function realCargo(box: Sandbox, log: string): string {
    const bin = join(box.root, ".cargo", "bin");
    script(join(bin, "rustc"), 'echo "rustc 1.90.0 (fake)"');
    script(
        join(bin, "cargo"),
        [
            "ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
            'here=$(dirname "$0")',
            'if [ -n "${RUSTC_WRAPPER:-}" ]; then "$RUSTC_WRAPPER" "$here/rustc" -vV >/dev/null || exit 1;',
            'else "$here/rustc" -vV >/dev/null || exit 1; fi',
            `echo "start \${STUB_LABEL:-x} $(ms) \${TOLI_BUILD_SLOT:-none} \${CARGO_BUILD_JOBS:-none} $*" >> ${log}`,
            'if [ -n "${NESTED:-}" ]; then NESTED="" STUB_LABEL="${STUB_LABEL:-x}-inner" STUB_SLEEP=0 "$0" check || exit 1; fi',
            `n="\${STUB_SLEEP:-0}"; while [ "$n" -gt 0 ] && [ ! -e "${log}.done-\${STUB_LABEL:-x}" ]; do`,
            "    sleep 0.2; n=$((n - 1)); done",
            `echo "end \${STUB_LABEL:-x} $(ms)" >> ${log}`,
        ].join("\n"),
    );
    return bin;
}

/** A jawan's environment over the fixture's PATH, as `bin/toli spawn` builds it, without the host's cargo config. */
function jawan(box: Sandbox): Record<string, string> {
    const path = [paths.buildShimsDir(), box.stubs, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin"];
    const env = jawanEnv({ PATH: path.join(":"), CARGO_HOME: join(box.root, ".cargo") }, "r1", 3);
    return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** The holder files the rustc wrapper's slot holders leave in state/build-slots. */
const holderFiles = (box: Sandbox): string[] =>
    readdirSync(join(box.root, "state", "build-slots")).filter((name) => name.startsWith("cargo-"));

describe("a cargo ahead of the shim on PATH still holds a heavy-build slot", () => {
    test("a pre-push hook's script that puts ~/.cargo/bin first: its clippy holds the slot, the next build waits", async () => {
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
        const env = { ...jawan(box), STUB_LABEL: "a", STUB_SLEEP: "150" };
        const push = start(box, ["git", "push", "-q", "origin", "HEAD:refs/heads/main"], env, dir);
        await until("the hook's clippy", () => runs(log).some((run) => run.label === "a"));
        expect(runs(log).find((run) => run.label === "a")).toMatchObject({
            jobs: "3",
            args: "clippy --workspace --all-targets",
        });
        const second = start(box, [CARGO_SHIM, "build"], { STUB_LABEL: "b" });
        await until("the second build waiting", () =>
            second.stderr.join("").includes("waiting for a heavy-build slot (1 busy)"),
        );
        expect(runs(log).some((run) => run.label === "b")).toBe(false);
        writeFileSync(`${log}.done-a`, "");
        const [pushed, built] = await Promise.all([push.done, second.done]);
        expect([pushed.code, built.code]).toEqual([0, 0]);
        const a = runs(log).find((run) => run.label === "a") as Run;
        const b = runs(log).find((run) => run.label === "b") as Run;
        expect(b.start).toBeGreaterThanOrEqual(a.end);
        await until("the holder's files gone", () => holderFiles(box).length === 0);
    }, 60_000);

    test("a nested cargo under a cargo that holds its slot through the wrapper reuses it, never deadlocks", async () => {
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
    }, 30_000);

    test("a cargo killed with SIGKILL frees the slot its holder took", async () => {
        const { box, log } = slotBox(1, 3);
        const real = realCargo(box, log);
        const env = { ...jawan(box), STUB_LABEL: "k", STUB_SLEEP: "150" };
        const killed = start(box, [join(real, "cargo"), "build"], env);
        await until("the killed build", () => runs(log).some((run) => run.label === "k"));
        expect(holderFiles(box).some((name) => name.endsWith(".held"))).toBe(true);
        const next = start(box, [CARGO_SHIM, "test"], { STUB_LABEL: "n" });
        await until("the next build waiting", () => next.stderr.join("").includes("waiting for a heavy-build slot"));
        killed.proc.kill("SIGKILL");
        const result = await next.done;
        expect(result.code).toBe(0);
        expect(runs(log).find((run) => run.label === "n")).toMatchObject({ slot: "1", args: "test" });
        await until("the holder's files gone", () => holderFiles(box).length === 0);
        expect(existsSync(join(box.root, "state", "build-slots", "1.lock"))).toBe(true);
    }, 30_000);

    test("light cargo commands run past the wrapper at once while every slot is busy", async () => {
        const { box, log } = slotBox(1, 3);
        const real = realCargo(box, log);
        const holder = start(box, [CARGO_SHIM, "build"], { STUB_LABEL: "h", STUB_SLEEP: "150" });
        await until("the holding build", () => runs(log).some((run) => run.label === "h"));
        const metadata = await start(box, [join(real, "cargo"), "metadata"], { ...jawan(box), STUB_LABEL: "m" }).done;
        holder.proc.kill("SIGKILL");
        expect(metadata.code).toBe(0);
        expect(metadata.stderr).not.toContain("waiting");
        expect(runs(log).find((run) => run.label === "m")).toMatchObject({ args: "metadata" });
    }, 30_000);
});
