// Two builds on one checkout never wait on each other (T1426: on a Linux worker one `bin/toli build-slot -- cargo test`
// held the machine's one heavy-build slot and waited for cargo's build-folder lock, while another cargo held that lock
// and its rustc call for a registry crate waited in toli's rustc wrapper for the slot the first one held; neither
// moved). Cargo takes its build-folder lock after its `rustc -vV` probe, so the wrapper may wait for a slot only on
// that probe: any later rustc call already runs under the lock.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "../src/core/paths.ts";
import { jawanEnv } from "../src/jawans/env.ts";
import { holdSlot, runs, slotBox, start, toliArgs, until } from "./build-slot-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";

/** An executable `/bin/sh` script at `file`. */
function script(file: string, body: string): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
}

/**
 * A cargo installation (`<root>/.cargo/bin`) whose cargo does what a real one does around its build-folder lock:
 * it probes rustc through `RUSTC_WRAPPER` (`rustc -vV`), logs its start like the fixture's stub cargo, takes the lock
 * (a directory, `lock`, made atomically), and with AFTER set waits until the build labelled AFTER started. With CRATE
 * set it then compiles a registry crate (CRATE_NAME, default chrono_tz) through the wrapper from that crate's folder
 * (cargo runs rustc in a non-local package's own root), under a child shell standing for a build script's process
 * when BUILD_SCRIPT is set, frees the lock and logs its end. Returns its bin folder.
 */
function lockingCargo(box: Sandbox, log: string, lock: string): string {
    const bin = join(box.root, ".cargo", "bin");
    script(join(bin, "rustc"), 'echo "rustc 1.90.0 (fake)"');
    script(
        join(bin, "cargo"),
        [
            "ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
            'here=$(dirname "$0")',
            '"$RUSTC_WRAPPER" "$here/rustc" -vV >/dev/null || exit 1',
            `echo "start \${STUB_LABEL:-x} $(ms) \${TOLI_BUILD_SLOT:-none} \${CARGO_BUILD_JOBS:-none} $*" >> ${log}`,
            `until mkdir "${lock}" 2>/dev/null; do sleep 0.1; done`,
            `if [ -n "\${AFTER:-}" ]; then until grep -q "^start $AFTER " "${log}"; do sleep 0.1; done; fi`,
            'if [ -n "${CRATE:-}" ]; then',
            '    set -- "$here/rustc" --crate-name "${CRATE_NAME:-chrono_tz}" src/lib.rs',
            '    if [ -n "${BUILD_SCRIPT:-}" ]; then (cd "$CRATE" && sh -c \'"$RUSTC_WRAPPER" "$@"\' build "$@") >/dev/null || exit 1',
            '    else (cd "$CRATE" && "$RUSTC_WRAPPER" "$@") >/dev/null || exit 1; fi',
            "fi",
            `rmdir "${lock}"`,
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

/** How long a wait on a real process event may take on a machine under load (a full `just check` beside it). */
const LOADED_MS = 120_000;

describe("a build in a slot and a cargo holding the build-folder lock (T1426)", () => {
    test(
        "never deadlock: the lock holder's later rustc calls never wait for the slot",
        async () => {
            const { box, log } = slotBox(1, 3);
            const lock = join(box.root, "target-lock");
            const cargo = join(lockingCargo(box, log, lock), "cargo");
            const dir = withProject(box, "app");
            box.ok(["project", "set", "app", "--live-stack", "yes"]);
            const crate = join(box.root, "registry", "chrono-tz-0.10.0");
            mkdirSync(crate, { recursive: true });
            // B: a build in the live-stack checkout (no slot) takes the lock first and holds it until A is in its slot.
            const b = start(
                box,
                toliArgs("build-slot", "--", cargo, "test"),
                { ...jawan(box), STUB_LABEL: "b", AFTER: "a", CRATE: crate },
                dir,
            );
            const builds = [b];
            try {
                await until("b holds the build-folder lock", () => existsSync(lock), LOADED_MS);
                // A: a build in a slot, which then waits for the lock B holds.
                const a = start(box, toliArgs("build-slot", "--", cargo, "test"), { ...jawan(box), STUB_LABEL: "a" });
                builds.push(a);
                await until(
                    "both builds finished",
                    () => runs(log).filter((run) => !Number.isNaN(run.end)).length === 2,
                    LOADED_MS,
                );
                const [resultA, resultB] = await Promise.all([a.done, b.done]);
                expect([resultA.code, resultB.code]).toEqual([0, 0]);
                const byLabel = new Map(runs(log).map((run) => [run.label, run]));
                expect(byLabel.get("a")).toMatchObject({ slot: "1", args: "test" });
                expect(byLabel.get("b")).toMatchObject({ slot: "none", args: "test" });
                expect((byLabel.get("b")?.end ?? Number.NaN) <= (byLabel.get("a")?.end ?? Number.NaN)).toBe(true);
            } finally {
                for (const build of builds) build.proc.kill();
            }
        },
        3 * LOADED_MS,
    );

    test(
        "a cargo's own later rustc call, under a build script's process, never waits for the slot another build holds",
        async () => {
            const { box, log } = slotBox(1, 3);
            const cargo = join(lockingCargo(box, log, join(box.root, "target-lock")), "cargo");
            const dir = withProject(box, "app");
            box.ok(["project", "set", "app", "--live-stack", "yes"]);
            const crate = join(box.root, "registry", "tikv-jemalloc-sys-0.6.0");
            mkdirSync(crate, { recursive: true });
            const holder = await holdSlot(box, log);
            const env = { ...jawan(box), STUB_LABEL: "j", CRATE: crate, CRATE_NAME: "tikv_jemalloc_sys" };
            const build = start(box, toliArgs("build-slot", "--", cargo, "test"), { ...env, BUILD_SCRIPT: "1" }, dir);
            try {
                const result = await build.done;
                expect(result.code).toBe(0);
                expect(result.stderr).not.toContain("waiting");
                const byLabel = new Map(runs(log).map((run) => [run.label, run]));
                expect(byLabel.get("j")).toMatchObject({ slot: "none", args: "test" });
                expect(Number.isNaN(byLabel.get("j")?.end ?? Number.NaN)).toBe(false);
                expect(Number.isNaN(byLabel.get("a")?.end ?? 0)).toBe(true);
            } finally {
                writeFileSync(`${log}.done-a`, "");
                build.proc.kill();
                await holder.done;
            }
        },
        2 * LOADED_MS,
    );
});
