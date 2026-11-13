// A machine marked pull-only on itself (config/machine.json) pulls, and doctor names one whose pulls never started.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Sandbox } from "./helpers.ts";
import { bodies, type Fleet, fixture, outbox, queueFor } from "./pull-fixture.ts";

/** Write config/machine.json on `box` with `inbound: false` added, as setup (`init --inbound off`) leaves it. */
function markPullOnly(box: Sandbox): void {
    const file = join(box.root, "config", "machine.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), inbound: false }));
}

/** Drop every machine's `inbound` flag from `box`'s config/fleet.json, as a list written before the flag was set. */
function unflagFleet(box: Sandbox): void {
    const file = join(box.root, "config", "fleet.json");
    const fleet = JSON.parse(readFileSync(file, "utf8")) as Fleet;
    writeFileSync(file, JSON.stringify({ machines: fleet.machines.map(({ inbound: _, ...entry }) => entry) }));
}

/** Age every queued outbox item on `box` by `minutes`. */
function ageOutbox(box: Sandbox, minutes: number): void {
    const dir = join(box.root, "state", "outbox");
    const then = new Date(Date.now() - minutes * 60_000);
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")))
        utimesSync(join(dir, file), then, then);
}

function doctorLines(box: Sandbox, name: string): string[] {
    return box
        .toli(["doctor"])
        .stdout.split("\n")
        .filter((line) => line.split(" ")[1] === name);
}

describe("a machine marked pull-only in its own config/machine.json pulls (T1331)", () => {
    test("the tick pulls even when its own fleet entry lacks the flag, and the pull carries the flag", () => {
        const { m1, m2, m3 } = fixture();
        m2.ok(["talk", "m1", "while unflagged"]);
        unflagFleet(m1);
        markPullOnly(m1);
        unflagFleet(m3);
        m1.ok(["job", "tick"]);
        expect(bodies(m1).join("\n")).toContain("while unflagged");
        expect(outbox(m2)).toHaveLength(0);
        // m3's list lacked the flag; m1's pull told it, so m3 never ssh-es into m1 again.
        const fleet = JSON.parse(readFileSync(join(m3.root, "config", "fleet.json"), "utf8")) as Fleet;
        expect(fleet.machines.find((machine) => machine.name === "m1")?.inbound).toBe(false);
    });

    test("init --inbound off marks it, a rerun keeps it, --inbound on clears it", () => {
        const { m1 } = fixture();
        const machine = () => JSON.parse(readFileSync(join(m1.root, "config", "machine.json"), "utf8"));
        m1.ok(["init", "--name", "m1", "--role", "coordinator", "--inbound", "off"]);
        expect(machine().inbound).toBe(false);
        m1.ok(["init", "--name", "m1", "--role", "coordinator"]);
        expect(machine().inbound).toBe(false);
        m1.ok(["init", "--name", "m1", "--role", "coordinator", "--inbound", "on"]);
        expect(machine().inbound).toBeUndefined();
        expect(m1.toli(["init", "--name", "m1", "--role", "coordinator", "--inbound", "maybe"]).code).not.toBe(0);
    });

    test("doctor warns on a pull-only machine that has never pulled, until it pulls", () => {
        const { m1 } = fixture();
        unflagFleet(m1);
        expect(doctorLines(m1, "pull")).toEqual([]);
        markPullOnly(m1);
        expect(doctorLines(m1, "pull").join("\n")).toMatch(/^warn pull .*never pulled/);
        m1.ok(["outbox", "pull"]);
        expect(doctorLines(m1, "pull").join("\n")).toMatch(/^ok pull /);
    });

    test("a sender's doctor names a puller that has never pulled from it", () => {
        const { m1, m2 } = fixture();
        m2.ok(["talk", "m1", "never fetched"]);
        ageOutbox(m2, 30);
        expect(doctorLines(m2, "outbox").join("\n")).toMatch(
            /^warn outbox .*m1 has never pulled from here.*--inbound off/,
        );
        m1.ok(["outbox", "pull"]);
        m2.ok(["talk", "m1", "fetched later"]);
        ageOutbox(m2, 30);
        const line = doctorLines(m2, "outbox").join("\n");
        expect(line).toMatch(/^warn outbox /);
        expect(line).not.toContain("never pulled");
    });

    test("a sender's doctor suggests pull-only for an unmarked machine its items pile up for", () => {
        const { m2 } = fixture();
        queueFor(m2, "m2", { name: "m9", ssh: "host9", root: "/nowhere" }, ["stuck"]);
        ageOutbox(m2, 120);
        expect(doctorLines(m2, "outbox").join("\n")).toMatch(
            /^warn outbox .*if m9 takes no inbound ssh.*--inbound off/,
        );
    });
});
