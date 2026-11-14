// The cargos in one heavy-build slot together compile at most one slot's share of crates (T1500: on a Linux worker a
// jawan's `cargo nextest run` held one slot, and its project's test kit started a cargo build through `$CARGO`, cargo's
// own absolute path, from each test binary; every one of them went straight past toli's rustc wrapper as a build
// inside the slot, each at the slot's full CARGO_BUILD_JOBS, so 16 compilers ran at once against a share of 8). Every
// crate compilation in a slot takes one job of the slot's job pool in toli's rustc wrapper, whichever cargo started it
// and however that cargo was reached; one started from inside a compilation that holds a job uses that job.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "../src/core/paths.ts";
import { jawanEnv } from "../src/jawans/env.ts";
import { slotBox, start, toliArgs } from "./build-slot-fixture.ts";
import type { Sandbox } from "./helpers.ts";

/** An executable `/bin/sh` script at `file`. */
function script(file: string, body: string): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
}

/**
 * A cargo installation (`<root>/.cargo/bin`). Its rustc answers `-vV`, and for a crate compilation logs `peak <crate>
 * <n>` to `<log>.compiles`, where n is how many compilations run at that moment (each one is an entry in
 * `<log>.running` while it runs), stays busy for a second and logs `done <crate>`; the compilation of the crate named
 * in PROC_MACRO_CARGO first runs `$CARGO build`, as a proc macro that runs cargo does. Its cargo, like a real one,
 * exports its own path as CARGO, probes rustc through `RUSTC_WRAPPER` and compiles CRATES crates (default 2) at once
 * through it; with TESTS set it then runs that many test binaries at once, each starting `$CARGO build` (a test kit's
 * helper build), each detached from the cargo's process tree with DETACH set (a daemonized builder). Returns its bin
 * folder.
 */
function toolchain(box: Sandbox, log: string): string {
    const bin = join(box.root, ".cargo", "bin");
    script(
        join(bin, "rustc"),
        [
            'if [ "$#" -eq 1 ] && [ "$1" = "-vV" ]; then echo "rustc 1.90.0 (fake)"; exit 0; fi',
            'crate=""; prev=""; for arg in "$@"; do [ "$prev" = --crate-name ] && crate=$arg; prev=$arg; done',
            `running="${log}.running"`,
            'mkdir -p "$running" && mkdir "$running/$crate.$$" || exit 1',
            `echo "peak $crate $(ls "$running" | wc -l | tr -d ' ')" >> "${log}.compiles"`,
            'if [ -n "${PROC_MACRO_CARGO:-}" ] && [ "$crate" = "$PROC_MACRO_CARGO" ]; then',
            '    PROC_MACRO_CARGO="" STUB_LABEL="${crate}_m" CRATES=1 TESTS="" "$CARGO" build || exit 1',
            "fi",
            "sleep 1",
            'rmdir "$running/$crate.$$"',
            `echo "done $crate" >> "${log}.compiles"`,
        ].join("\n"),
    );
    script(
        join(bin, "cargo"),
        [
            'here=$(CDPATH=\'\' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1',
            'CARGO="$here/cargo"; export CARGO',
            "label=${STUB_LABEL:-x}",
            '"$RUSTC_WRAPPER" "$here/rustc" -vV >/dev/null || exit 1',
            'pids=""; i=1',
            'while [ "$i" -le "${CRATES:-2}" ]; do',
            '    "$RUSTC_WRAPPER" "$here/rustc" --crate-name "${label}_$i" --edition 2021 src/lib.rs &',
            '    pids="$pids $!"; i=$((i + 1))',
            "done",
            'for pid in $pids; do wait "$pid" || exit 1; done',
            'pids=""; j=1',
            'while [ "$j" -le "${TESTS:-0}" ]; do',
            '    nested="${label}_t$j"',
            '    if [ -n "${DETACH:-}" ]; then',
            `        ( (STUB_LABEL="$nested" TESTS="" DETACH="" "$CARGO" build; echo "$?" > "${log}.exit-$nested") & )`,
            '    else STUB_LABEL="$nested" TESTS="" "$CARGO" build & pids="$pids $!"; fi',
            "    j=$((j + 1))",
            "done",
            'for pid in $pids; do wait "$pid" || exit 1; done',
            'j=1; while [ -n "${DETACH:-}" ] && [ "$j" -le "${TESTS:-0}" ]; do',
            `    f="${log}.exit-\${label}_t$j"`,
            '    n=600; while [ ! -e "$f" ] && [ "$n" -gt 0 ]; do sleep 0.2; n=$((n - 1)); done',
            '    [ "$(cat "$f" 2>/dev/null)" = 0 ] || exit 1',
            "    j=$((j + 1))",
            "done",
        ].join("\n"),
    );
    return bin;
}

/** The compilations logged: the most that ran at once, and the crates that finished. */
function compiles(log: string): { peak: number; done: string[] } {
    const file = `${log}.compiles`;
    const lines = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
    let peak = 0;
    const done: string[] = [];
    for (const line of lines) {
        const [kind, crate = "", count = "0"] = line.split(" ");
        if (kind === "peak") peak = Math.max(peak, Number(count));
        else if (kind === "done") done.push(crate);
    }
    return { peak, done: done.sort() };
}

/**
 * A jawan's environment over the fixture's PATH, as `bin/toli spawn` builds it (CARGO_BUILD_JOBS 2, a slot's share),
 * without the host's cargo config, outside any compile job.
 */
function jawan(box: Sandbox): Record<string, string> {
    const path = [paths.buildShimsDir(), box.stubs, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin"];
    const env = jawanEnv({ PATH: path.join(":"), CARGO_HOME: join(box.root, ".cargo") }, "r1", 2);
    const set = Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined);
    return { ...Object.fromEntries(set), TOLI_BUILD_JOB: "" };
}

/** The crates `labels`' cargos compile, CRATES (2) each. */
const crates = (...labels: string[]): string[] => labels.flatMap((label) => [`${label}_1`, `${label}_2`]).sort();

/** How long a build of these tests may take on a machine under load (a full `just check` beside it). */
const LOADED_MS = 120_000;

describe("the cargos in one heavy-build slot compile at most the slot's share of crates (T1500)", () => {
    test(
        "a test kit's builds through $CARGO under a cargo in a slot share the slot's jobs",
        async () => {
            const { box, log } = slotBox(1, 2);
            const cargo = join(toolchain(box, log), "cargo");
            const build = start(box, toliArgs("build-slot", "--", cargo, "test"), {
                ...jawan(box),
                STUB_LABEL: "o",
                TESTS: "3",
            });
            const result = await build.done;
            expect(result.code).toBe(0);
            const { peak, done } = compiles(log);
            expect(done).toEqual(crates("o", "o_t1", "o_t2", "o_t3"));
            expect(peak).toBeLessThanOrEqual(2);
        },
        LOADED_MS,
    );

    test(
        "a cargo started by its absolute path, outside the shim, and its test kit's builds share the slot's jobs",
        async () => {
            const { box, log } = slotBox(1, 2);
            const real = toolchain(box, log);
            const env = { ...jawan(box), PATH: `${real}:${jawan(box).PATH}`, STUB_LABEL: "p", TESTS: "3" };
            const build = start(box, [join(real, "cargo"), "test"], env);
            const result = await build.done;
            expect(result.code).toBe(0);
            const { peak, done } = compiles(log);
            expect(done).toEqual(crates("p", "p_t1", "p_t2", "p_t3"));
            expect(peak).toBeLessThanOrEqual(2);
        },
        LOADED_MS,
    );

    test(
        "builds a test kit detaches from the slot's process tree through $CARGO still share the slot's jobs",
        async () => {
            const { box, log } = slotBox(1, 2);
            const cargo = join(toolchain(box, log), "cargo");
            const build = start(box, toliArgs("build-slot", "--", cargo, "test"), {
                ...jawan(box),
                STUB_LABEL: "d",
                TESTS: "3",
                DETACH: "1",
            });
            const result = await build.done;
            expect(result.code).toBe(0);
            const { peak, done } = compiles(log);
            expect(done).toEqual(crates("d", "d_t1", "d_t2", "d_t3"));
            expect(peak).toBeLessThanOrEqual(2);
        },
        LOADED_MS,
    );

    test(
        "never deadlock: a cargo run from inside a compilation that holds the slot's one job uses that job",
        async () => {
            const { box, log } = slotBox(1, 1);
            const cargo = join(toolchain(box, log), "cargo");
            const build = start(box, toliArgs("build-slot", "--", cargo, "build"), {
                ...jawan(box),
                STUB_LABEL: "m",
                CRATES: "1",
                PROC_MACRO_CARGO: "m_1",
            });
            const result = await build.done;
            expect(result.code).toBe(0);
            expect(result.stderr).not.toContain("waiting");
            expect(compiles(log).done).toEqual(["m_1", "m_1_m_1"]);
        },
        LOADED_MS,
    );
});
