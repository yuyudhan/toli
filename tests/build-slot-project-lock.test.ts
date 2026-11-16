// A command a project wraps in its own lock never deadlocks with a heavy-build slot (T1660: on a Linux worker one
// `bin/toli build-slot -- just test` took the machine's one slot up front and then waited for the project's dev-DB test
// lock, while a plain `just test` held that lock and its cargo, through toli's cargo shim, waited for the slot; both
// hung). Whatever holds the slot around the lock (`build-slot` of anything, a gate's recipe, a push's pre-push hook),
// its command then runs nothing, so the waiting cargo builds beside it once the idle window passes, and the wrapped
// command's own cargo runs in its slot once it has the lock. tests/build-slot-external-lock.test.ts covers the window.
import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runs, type Started, slotBox, start, toliArgs, until } from "./build-slot-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";

/** How long a deadlocked pair is given to move before the test calls it stuck, well past a loaded machine's start-up. */
const STUCK_MS = 60_000;
/**
 * The lock holder's environment: the real process table (no TOLI_PROCESS_TABLE), so its cargo's wait for a slot sees
 * the slot's command sleeping on the lock, and a short idle window.
 */
const LOCK_HOLDER = { TOLI_PROCESS_TABLE: "", TOLI_SLOT_IDLE_MS: "2000" };

/**
 * The project's own lock, a directory made atomically (as `flock(1)` would hold a file, without needing it): a shell
 * function `take` that waits for it (giving up only long after the test has called a wait stuck) and `give` that frees it.
 */
function projectLock(box: Sandbox): { lock: string; functions: string } {
    const lock = join(box.root, ".project-lock");
    const functions = [
        `take() { n=0; until mkdir "${lock}" 2>/dev/null; do n=$((n + 1)); [ "$n" -lt 1500 ] || exit 9; sleep 0.1; done; }`,
        `give() { rmdir "${lock}"; }`,
    ].join("\n");
    return { lock, functions };
}

/**
 * The two commands of the inversion, as `/bin/sh` scripts. `holder` stands for a plain `just test`: it takes the project
 * lock, says so, waits for `go` and then runs `cargo test` (through the shim on PATH). `waiter` stands for the same
 * recipe run under a slot: it says it wants the lock, takes it, then runs `cargo build`.
 */
function scripts(box: Sandbox): { holder: string; waiter: string; holds: string; wants: string; go: string } {
    const { functions } = projectLock(box);
    const holds = join(box.root, ".holder-holds");
    const wants = join(box.root, ".waiter-wants");
    const go = join(box.root, ".go");
    const holder = join(box.root, ".holder.sh");
    const waiter = join(box.root, ".waiter.sh");
    writeFileSync(
        holder,
        [
            functions,
            "take",
            `: > "${holds}"`,
            `while [ ! -e "${go}" ]; do sleep 0.1; done`,
            "STUB_LABEL=b cargo test || exit $?",
            "give",
        ].join("\n"),
    );
    writeFileSync(
        waiter,
        [functions, `: > "${wants}"`, "take", "STUB_LABEL=a cargo build || exit $?", "give"].join("\n"),
    );
    return { holder, waiter, holds, wants, go };
}

/**
 * Both cargos ran, the lock holder's first, beside the slot the lock waiter's command held (number 2, past the one
 * slot) and that command's own then in its slot.
 */
function expectBothBuiltInTurn(log: string, holder: Started): void {
    const byLabel = new Map(runs(log).map((run) => [run.label, run]));
    expect(byLabel.get("b")).toMatchObject({ slot: "2", jobs: "3", args: "test" });
    expect(byLabel.get("a")).toMatchObject({ slot: "1", jobs: "3", args: "build" });
    expect((byLabel.get("b")?.end ?? Number.NaN) <= (byLabel.get("a")?.start ?? Number.NaN)).toBe(true);
    expect(holder.stderr.join("")).toMatch(/heavy-build slot 1 \(pid \d+ in .+\) has run nothing for 2s/);
}

/** Wait until both stub cargos ran to their end; a stuck pair fails with what the lock holder's command printed. */
async function untilBothBuilt(log: string, holder: Started): Promise<void> {
    try {
        await until(
            "both cargos finished",
            () => runs(log).filter((run) => !Number.isNaN(run.end)).length === 2,
            STUCK_MS,
        );
    } catch (error) {
        const stuck = error instanceof Error ? error.message : String(error);
        throw new Error(
            `${stuck}; holder stderr: ${holder.stderr.join("").trim()}; runs: ${JSON.stringify(runs(log))}`,
        );
    }
}

describe("a project's own lock and the heavy-build slots (T1660)", () => {
    test(
        "`build-slot` around a command waiting on the lock lends its slot to the lock holder's cargo",
        async () => {
            const { box, log } = slotBox(1, 3);
            const { holder, waiter, holds, wants, go } = scripts(box);
            const b = start(box, ["/bin/sh", holder], LOCK_HOLDER);
            const started = [b];
            try {
                await until("the plain command holding the project lock", () => existsSync(holds), STUCK_MS);
                const a = start(box, toliArgs("build-slot", "--", "/bin/sh", waiter));
                started.push(a);
                await until("the build-slot command asking for the project lock", () => existsSync(wants), STUCK_MS);
                writeFileSync(go, "");
                await untilBothBuilt(log, b);
                const [resultA, resultB] = await Promise.all([a.done, b.done]);
                expect([resultA.code, resultB.code]).toEqual([0, 0]);
                expectBothBuiltInTurn(log, b);
            } finally {
                for (const command of started) command.proc.kill();
            }
        },
        3 * STUCK_MS,
    );

    test(
        "a gate whose recipe waits on the lock lends its slot to the lock holder's cargo",
        async () => {
            const { box, log } = slotBox(1, 3);
            withProject(box, "app");
            const { holder, waiter, holds, wants, go } = scripts(box);
            const b = start(box, ["/bin/sh", holder], LOCK_HOLDER);
            try {
                await until("the plain command holding the project lock", () => existsSync(holds), STUCK_MS);
                const gate = box.toliAsync(["gate", "run", "app", "--recipe", `/bin/sh '${waiter}'`], {
                    env: { TOLI_BUILD_SLOT: "", TOLI_BUILD_SCOPE: "off" },
                });
                await until("the gate's recipe asking for the project lock", () => existsSync(wants), STUCK_MS);
                writeFileSync(go, "");
                await untilBothBuilt(log, b);
                const [gateRun, resultB] = await Promise.all([gate, b.done]);
                expect([gateRun.code, resultB.code]).toEqual([0, 0]);
                expectBothBuiltInTurn(log, b);
            } finally {
                b.proc.kill();
            }
        },
        3 * STUCK_MS,
    );

    test(
        "a push whose pre-push hook waits on the lock lends its slot to the lock holder's cargo",
        async () => {
            const { box, log } = slotBox(1, 3);
            const dir = withProject(box, "app");
            box.ok(["project", "set", "app", "--standing-push", "yes"]);
            const { holder, waiter, holds, wants, go } = scripts(box);
            writeFileSync(join(dir, ".git", "hooks", "pre-push"), `#!/bin/sh\nexec /bin/sh '${waiter}'\n`, {
                mode: 0o755,
            });
            const b = start(box, ["/bin/sh", holder], LOCK_HOLDER);
            try {
                await until("the plain command holding the project lock", () => existsSync(holds), STUCK_MS);
                const push = box.toliAsync(["push", "app"], { env: { TOLI_BUILD_SLOT: "", TOLI_BUILD_SCOPE: "off" } });
                await until("the pre-push hook asking for the project lock", () => existsSync(wants), STUCK_MS);
                writeFileSync(go, "");
                await untilBothBuilt(log, b);
                const [pushRun, resultB] = await Promise.all([push, b.done]);
                expect([pushRun.code, resultB.code]).toEqual([0, 0]);
                expectBothBuiltInTurn(log, b);
            } finally {
                b.proc.kill();
            }
        },
        3 * STUCK_MS,
    );
});
