// A build inside a heavy-build slot runs in that slot (src/fleet/enclosing-slot.ts `enclosingSlot`): a nested
// `bin/toli build-slot` or a cargo through the shim never queues behind the slot its own ancestor holds, while a build
// whose TOLI_BUILD_SLOT names a slot nobody holds takes a slot of its own like any other. Nor does the build take a
// second slot's room through the compilations a compiler daemon (sccache's server) runs for it (T2244).
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CARGO_SHIM, holdSlot, type Run, runs, slotBox, start, toliArgs, until } from "./build-slot-fixture.ts";
import { TOLI_BIN } from "./helpers.ts";

describe("nested heavy builds", () => {
    test("a TOLI_BUILD_SLOT left by a holder that is gone never skips the line", async () => {
        const { box, log } = slotBox(2, 3);
        const holder = await holdSlot(box, log);
        // Slot 2's holder is gone: a build still carrying its marker takes slot 2 for itself, so a third build waits.
        const stale = start(box, [CARGO_SHIM, "build"], { STUB_LABEL: "b", STUB_SLEEP: "150", TOLI_BUILD_SLOT: "2" });
        await until("the stale-marker build", () => runs(log).some((run) => run.label === "b"));
        const third = start(box, toliArgs("build-slot", "--", "cargo", "check"), { STUB_LABEL: "c" });
        await until("the waiting message", () => third.stderr.join("").includes("waiting for a heavy-build slot"));
        expect(runs(log).map((run) => run.label)).toEqual(["a", "b"]);
        writeFileSync(`${log}.done-a`, "");
        writeFileSync(`${log}.done-b`, "");
        const [a, b, c] = await Promise.all([holder.done, stale.done, third.done]);
        expect([a.code, b.code, c.code]).toEqual([0, 0, 0]);
        expect(runs(log).find((run) => run.label === "b")).toMatchObject({ slot: "2", args: "build" });
        expect(runs(log).find((run) => run.label === "c")).toMatchObject({ args: "check" });
    }, 30_000);

    test("a build-slot inside a build-slot runs in the outer one's slot, while an independent build waits for it", async () => {
        const { box, log } = slotBox(1, 3);
        // The shape that hung a worker for 37 minutes: under `nice` and a shell, the outer build-slot's command runs
        // nested build-slots and the shim's cargo, also where a layer in between dropped TOLI_BUILD_SLOT; each runs at
        // once in the slot the outer one holds.
        const inner = [
            `"$0" build-slot -- "$0" build-slot -- true`,
            `env -u TOLI_BUILD_SLOT "$0" build-slot -- true`,
            "env -u TOLI_BUILD_SLOT cargo build",
        ].join(" && ");
        const outer = start(box, toliArgs("build-slot", "--", "nice", "-n", "19", "sh", "-c", inner, TOLI_BIN), {
            STUB_LABEL: "a",
            STUB_SLEEP: "150",
        });
        await until("the nested build", () => runs(log).some((run) => run.label === "a"));
        const independent = start(box, toliArgs("build-slot", "--", "cargo", "check"), { STUB_LABEL: "b" });
        await until("the waiting message", () =>
            independent.stderr.join("").includes("waiting for a heavy-build slot"),
        );
        expect(runs(log).some((run) => run.label === "b")).toBe(false);
        writeFileSync(`${log}.done-a`, "");
        const [first, second] = await Promise.all([outer.done, independent.done]);
        expect([first.code, second.code]).toEqual([0, 0]);
        expect(first.stderr).not.toContain("waiting");
        const [a, b] = runs(log);
        expect(a).toMatchObject({ label: "a", slot: "1", args: "build" });
        expect(b).toMatchObject({ label: "b", slot: "1", args: "check" });
        expect((b as Run).start).toBeGreaterThanOrEqual((a as Run).end);
    }, 30_000);

    test("a build-slot around the cargo shim, compiling through sccache's server, takes one slot in all", async () => {
        const { box, log } = slotBox(2, 3);
        // The shape that filled a two-slot Linux worker: `bin/toli build-slot -- cargo test`, cargo the shim (a nested
        // build-slot), every crate compiled by sccache's server, a daemon outside the build's process tree.
        const outer = start(box, toliArgs("build-slot", "--", "cargo", "test"), { STUB_LABEL: "a", STUB_SLEEP: "150" });
        await until("the nested build", () => runs(log).some((run) => run.label === "a"));
        const record: unknown = JSON.parse(readFileSync(join(box.root, "state", "build-slots", "1.lock"), "utf8"));
        const holder = typeof record === "object" && record !== null && "pid" in record ? Number(record.pid) : 0;
        expect(holder).toBeGreaterThan(0);
        const compile = "--crate-name audit_log --edition=2021 -C metadata=aa1 -C codegen-units=1";
        writeFileSync(
            join(box.root, ".process-table"),
            [
                `${holder} 1 Sl bun bin/toli build-slot -- cargo test`,
                `9001 ${holder} S /bin/sh bin/shims/toli-rustc-wrapper rustc ${compile}`,
                `9002 9001 S sccache rustc ${compile}`,
                "9100 1 Sl /home/u/.cargo/bin/sccache",
                `9101 9100 Rl rustc ${compile}`,
                "",
            ].join("\n"),
        );
        const second = start(box, toliArgs("build-slot", "--", "cargo", "check"), {
            STUB_LABEL: "b",
            STUB_SLEEP: "150",
        });
        await until("the second build", () => runs(log).some((run) => run.label === "b"));
        expect(second.stderr.join("")).not.toContain("waiting");
        const third = start(box, toliArgs("build-slot", "--", "cargo", "build"), { STUB_LABEL: "c" });
        await until("the third build waiting", () => third.stderr.join("").includes("waiting for a heavy-build slot"));
        writeFileSync(`${log}.done-a`, "");
        const first = await outer.done;
        writeFileSync(join(box.root, ".process-table"), ""); // The build's compilations end with it.
        writeFileSync(`${log}.done-b`, "");
        const [two, three] = await Promise.all([second.done, third.done]);
        expect([first.code, two.code, three.code]).toEqual([0, 0, 0]);
        expect(first.stderr).not.toContain("waiting");
        expect(runs(log).map((run) => [run.label, run.slot, run.args])).toEqual([
            ["a", "1", "test"],
            ["b", "2", "check"],
            ["c", expect.stringMatching(/^[12]$/), "build"],
        ]);
    }, 30_000);
});
