// A build woken in its slot waits for the builds lent beside that slot (T2050), and never forever (T2668: on a Linux
// worker a nested cargo sat at 0% CPU in its slot while every other build queued behind it). A lent mark recorded only
// the slot's number, so a build lent beside the slot's previous holder held up the next holder of that number, which
// had itself been lent beside that build: each waited for the other, each marked its slot woken, and a woken slot never
// counts as idle, so neither wait ever ended. A lent mark now names the holder it was lent beside.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { idleSlots, markWoken } from "../src/fleet/idle-slots.ts";
import { processTable } from "../src/fleet/outside-builds.ts";
import type { Resources } from "../src/fleet/resources.ts";
import { holdSlot, runs, type Started, slotBox, spinUntil, start, toliArgs, until } from "./build-slot-fixture.ts";
import { tempDir } from "./helpers.ts";

/** toli's rustc wrapper, cargo's RUSTC_WRAPPER for a cargo that bypasses the shim. */
const RUSTC_WRAPPER = resolve(import.meta.dir, "..", "bin", "shims", "toli-rustc-wrapper");

const saved: Record<string, string | undefined> = {};
function setEnv(values: Record<string, string>): void {
    for (const [key, value] of Object.entries(values)) {
        if (!(key in saved)) saved[key] = process.env[key];
        process.env[key] = value;
    }
}
afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
        delete saved[key];
    }
});

/** How long the test waits for any one of its events before it calls it missed. */
const EVENT_MS = 60_000;

/** A `sh -c` step that runs nothing until `wake` exists (or this test is gone), then the stub cargo. */
const sleepThenBuild = (wake: string): string =>
    `until [ -e "${wake}" ]; do kill -0 ${process.pid} 2>/dev/null || exit 1; sleep 0.3; done; cargo build`;

describe("a build woken in its slot never waits forever for a build lent beside it (T2668)", () => {
    test(
        "a build lent beside the slot's previous holder does not hold up the slot's next holder",
        async () => {
            const { box, log } = slotBox(1, 3);
            const slots = join(box.root, "state", "build-slots");
            const stopFirst = join(box.root, ".stop-first");
            const wakeLent = join(box.root, ".wake-lent");
            const wakeNext = join(box.root, ".wake-next");
            // The real process table over a one-second idle window, for lenders and woken builds alike.
            const real = { TOLI_PROCESS_TABLE: "", TOLI_SLOT_IDLE_MS: "1000" };
            const started: Started[] = [];
            try {
                // H0: holds slot 1 and runs nothing until told to stop.
                const first = start(box, toliArgs("build-slot", "--", "sh", "-c", sleepThenBuild(stopFirst)), {
                    ...real,
                    STUB_LABEL: "h0",
                });
                started.push(first);
                await until(
                    "H0 in slot 1",
                    () =>
                        existsSync(join(slots, "1.lock")) &&
                        readFileSync(join(slots, "1.lock"), "utf8").includes(`"pid":${first.proc.pid},`),
                    EVENT_MS,
                );
                // L: lent a slot beside H0's idle slot 1; it then runs nothing until woken.
                const lent = start(box, toliArgs("build-slot", "--", "sh", "-c", sleepThenBuild(wakeLent)), {
                    ...real,
                    STUB_LABEL: "l",
                });
                started.push(lent);
                await until("L beside slot 1", () => lent.stderr.join("").includes("building beside it"), EVENT_MS);
                // H0 ends; H takes slot 1 again beside L, idle by now.
                mkdirSync(stopFirst);
                expect((await first.done).code).toBe(0);
                const next = start(box, toliArgs("build-slot", "--", "sh", "-c", sleepThenBuild(wakeNext)), {
                    ...real,
                    STUB_LABEL: "h",
                });
                started.push(next);
                await until("H beside L", () => next.stderr.join("").includes("building beside it"), EVENT_MS);
                // Both wake at once. L was lent beside H0, never H: H builds at once, and L, lent the slot H took
                // beside it, waits for H's build to end.
                mkdirSync(wakeNext);
                mkdirSync(wakeLent);
                await until(
                    "both nested builds",
                    () => runs(log).filter((run) => run.label !== "h0").length === 2,
                    EVENT_MS,
                );
                const [h, l] = await Promise.all([next.done, lent.done]);
                expect([h.code, l.code]).toEqual([0, 0]);
                const [built, waited] = runs(log).filter((run) => run.label !== "h0");
                expect(built).toMatchObject({ label: "h", slot: "1" });
                expect(waited).toMatchObject({ label: "l" });
                expect(waited?.start).toBeGreaterThanOrEqual(built?.end ?? Number.POSITIVE_INFINITY);
                expect(h.stderr).not.toContain("lent to a build beside it");
            } finally {
                for (const proc of started) proc.proc.kill("SIGKILL");
            }
        },
        4 * EVENT_MS,
    );
});

describe("a lent build that itself waits is set aside once it has run nothing for five windows (T2668)", () => {
    test("a woken slot is never idle to a waiter in line, and idle to a woken build only after five windows", () => {
        const dir = tempDir("woken-stale");
        writeFileSync(join(dir, "table"), `900000 1 S bun bin/toli build-slot -- sh\n900001 900000 S sleep 60\n`);
        setEnv({ TOLI_PROCESS_TABLE: join(dir, "table"), TOLI_PROC_DIR: join(dir, "proc"), TOLI_ROOT: dir });
        const slot = { slot: 1, pid: 900_000, cwd: dir, targetDir: null, beside: [] };
        const release = markWoken(1);
        expect(release).not.toBeNull();
        try {
            const watched = (key: string, agoMs: number) => ({
                windowMs: 1000,
                seen: new Map([[key, { since: Date.now() - agoMs, samples: [] }]]),
            });
            expect(idleSlots(watched("1:900000", 60_000), [slot], processTable())).toEqual([]);
            expect(idleSlots(watched("woken 1:900000", 4000), [slot], processTable(), true)).toEqual([]);
            expect(idleSlots(watched("woken 1:900000", 6000), [slot], processTable(), true)).toEqual([slot]);
        } finally {
            release?.();
        }
    });
});

describe("a tree waits in line for one slot only (T2668)", () => {
    test("a cargo below a process whose holder waits in line rides that holder instead of queueing again", async () => {
        const { box, log } = slotBox(1, 3);
        const slots = join(box.root, "state", "build-slots");
        const bin = join(box.root, ".cargo", "bin");
        mkdirSync(bin, { recursive: true });
        const rustc = join(bin, "rustc");
        writeFileSync(rustc, '#!/bin/sh\necho "rustc 1.90.0 (fake)"\n');
        const built = join(box.root, ".built");
        const cargo = join(bin, "cargo");
        writeFileSync(cargo, `#!/bin/sh\n"$RUSTC_WRAPPER" ${rustc} -vV >/dev/null || exit 1\necho "$$" > ${built}\n`);
        chmodSync(rustc, 0o755);
        chmodSync(cargo, 0o755);
        const go = join(box.root, ".go");
        const env = { RUSTC_WRAPPER, TOLI_RUSTC_WRAPPER_NEXT: "" };
        const started: Started[] = [];
        try {
            started.push(await holdSlot(box, log));
            // X: a process whose holder waits in line for the busy slot, then starts a cargo (cargo-sqlx's `cargo check`).
            const outer = start(
                box,
                [
                    "sh",
                    "-c",
                    `until [ -e "${go}" ]; do kill -0 ${process.pid} 2>/dev/null || exit 1; sleep 0.2; done; ${cargo} check`,
                ],
                env,
            );
            started.push(outer);
            const outerPid = outer.proc.pid;
            const holder = start(box, toliArgs("build-slot", "--hold", String(outerPid), "--cwd", box.root), env);
            started.push(holder);
            const claims = (): string[] => readdirSync(slots).filter((name) => /^cargo-\d+\.claim$/.test(name));
            await until("X's holder waiting in line", () => claims().includes(`cargo-${outerPid}.claim`));
            mkdirSync(go);
            // Real processes: only wall time shows the cargo's probe staying in X's one place in line.
            const seen = new Set<string>();
            const deadline = Date.now() + 3000;
            while (Date.now() < deadline) {
                for (const name of claims()) seen.add(name);
                await Bun.sleep(100);
            }
            expect(existsSync(built)).toBe(false);
            writeFileSync(`${log}.done-a`, "");
            await until("the cargo built in X's slot", () => existsSync(built));
            for (const name of claims()) seen.add(name);
            expect([...seen]).toEqual([`cargo-${outerPid}.claim`]);
            expect((await outer.done).code).toBe(0);
        } finally {
            for (const proc of started) proc.proc.kill("SIGKILL");
        }
    }, 60_000);
});

describe("a test runner's slot is freed once the runner runs nothing (T2668)", () => {
    test("an idle runner gives its slot back while it lives on; a working one keeps it", async () => {
        const { box } = slotBox(1, 3);
        const real = { TOLI_PROCESS_TABLE: "", TOLI_SLOT_IDLE_MS: "1000" };
        const busy = (): number | undefined =>
            (JSON.parse(box.ok(["resources", "--json"])) as Resources).buildSlotsBusy;
        const stop = join(box.root, ".stop");
        const started: Started[] = [];
        try {
            const working = start(box, ["sh", "-c", spinUntil(stop)]);
            started.push(working);
            expect(
                (await start(box, toliArgs("build-slot", "--runner", String(working.proc.pid)), real).done).code,
            ).toBe(0);
            expect(busy()).toBe(1);
            // Real processes: only wall time shows a working runner keeping its slot past several idle windows.
            await Bun.sleep(3500);
            expect(busy()).toBe(1);
            mkdirSync(stop);
            expect((await working.done).code).toBe(0);
            await until("the working runner's slot freed", () => busy() === 0);

            const idle = start(box, [
                "sh",
                "-c",
                `until [ -e "${stop}.idle" ]; do kill -0 ${process.pid} 2>/dev/null || exit 1; sleep 0.3; done`,
            ]);
            started.push(idle);
            expect((await start(box, toliArgs("build-slot", "--runner", String(idle.proc.pid)), real).done).code).toBe(
                0,
            );
            await until("the idle runner's slot freed", () => busy() === 0);
            expect(idle.proc.exitCode).toBeNull();
            mkdirSync(`${stop}.idle`);
            expect((await idle.done).code).toBe(0);
        } finally {
            for (const proc of started) proc.proc.kill("SIGKILL");
        }
    }, 60_000);
});
