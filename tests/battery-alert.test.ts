// T497: the low-battery alert (docs/fleet.md "Low battery"). A machine others depend on (the coordinator, or one whose
// `battery.serves` names what goes through it) that runs on battery under `battery.alertPercent` (default 30) posts one
// inbox item and repeats it at most every 15 minutes while it stays so; never on AC power, never without a battery.
// The hourly fleet check shows the line too.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePmset, readPowerSupply } from "../src/fleet/battery.ts";
import { inbox, pair } from "./delegate-fixture.ts";
import { type Sandbox, sandbox, tempDir } from "./helpers.ts";

const T0 = "2026-11-23T19:00:00.000Z";
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const LINUX = { TOLI_PLATFORM: "linux" };
const COORDINATOR_TEXT =
    "m1 on battery at 25%, discharging: plug it in; it is the coordinator, every machine's inbox, holds and fleet checks go through it";

type Supply = { battery?: { capacity: number; status: string; scope?: string }; mains?: boolean };

/** Write a /sys/class/power_supply tree into `dir` (TOLI_POWER_SUPPLY_DIR), replacing what was there. */
function writeSupply(dir: string, supply: Supply): void {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    if (supply.battery !== undefined) {
        const bat = join(dir, "BAT0");
        mkdirSync(bat);
        writeFileSync(join(bat, "type"), "Battery\n");
        writeFileSync(join(bat, "capacity"), `${supply.battery.capacity}\n`);
        writeFileSync(join(bat, "status"), `${supply.battery.status}\n`);
        if (supply.battery.scope !== undefined) writeFileSync(join(bat, "scope"), `${supply.battery.scope}\n`);
    }
    if (supply.mains !== undefined) {
        const ac = join(dir, "AC");
        mkdirSync(ac);
        writeFileSync(join(ac, "type"), "Mains\n");
        writeFileSync(join(ac, "online"), supply.mains ? "1\n" : "0\n");
    }
}

/** This sandbox's power supply tree, which the sandbox points TOLI_POWER_SUPPLY_DIR at. */
const supply = (box: Sandbox, value: Supply): void => writeSupply(join(box.root, ".power_supply"), value);

function alerts(box: Sandbox): string[] {
    return inbox(box)
        .map((item) => item.title)
        .filter((title) => title.includes(" on battery at "));
}

function coordinator(): Sandbox {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    return box;
}

function setBattery(box: Sandbox, battery: Record<string, unknown>): void {
    const file = join(box.root, "config", "machine.json");
    const machine = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...machine, battery }));
}

const tick = (box: Sandbox, minutes: number, env: Record<string, string> = LINUX): void => {
    box.ok(["job", "tick"], { now: at(minutes), env });
};

describe("reading the battery", () => {
    test("pmset: the internal battery's charge and whether it discharges; none on a Mac without one", () => {
        const discharging = [
            "Now drawing from 'Battery Power'",
            " -InternalBattery-0 (id=4653155)\t27%; discharging; 2:10 remaining present: true",
        ].join("\n");
        expect(parsePmset(discharging)).toEqual({ percent: 27, discharging: true });
        const attached = [
            "Now drawing from 'AC Power'",
            " -InternalBattery-0 (id=4653155)\t27%; AC attached; not charging present: true",
        ].join("\n");
        expect(parsePmset(attached)).toEqual({ percent: 27, discharging: false });
        const charging = " -InternalBattery-0 (id=1)\t12%; charging; 1:02 remaining present: true";
        expect(parsePmset(charging)).toEqual({ percent: 12, discharging: false });
        expect(parsePmset("Now drawing from 'AC Power'\n")).toBeNull();
    });

    test("sysfs: system batteries only; a peripheral's battery or a machine with none reads as no battery", () => {
        const dir = tempDir("power");
        writeSupply(dir, { battery: { capacity: 18, status: "Discharging" }, mains: false });
        expect(readPowerSupply(dir)).toEqual({ percent: 18, discharging: true });
        writeSupply(dir, { battery: { capacity: 18, status: "Not charging" }, mains: true });
        expect(readPowerSupply(dir)).toEqual({ percent: 18, discharging: false });
        writeSupply(dir, { battery: { capacity: 5, status: "Discharging", scope: "Device" }, mains: true });
        expect(readPowerSupply(dir)).toBeNull();
        writeSupply(dir, { mains: true });
        expect(readPowerSupply(dir)).toBeNull();
        expect(readPowerSupply(join(dir, "absent"))).toBeNull();
    });
});

describe("the low-battery alert", () => {
    test("the coordinator discharging under the threshold alerts once, then at most every 15 min while it stays so", () => {
        const box = coordinator();
        supply(box, { battery: { capacity: 25, status: "Discharging" }, mains: false });

        tick(box, 0);
        expect(alerts(box)).toEqual([COORDINATOR_TEXT]);
        tick(box, 5);
        tick(box, 14);
        expect(alerts(box)).toHaveLength(1);
        tick(box, 15);
        expect(alerts(box)).toHaveLength(2);

        // Plugged in, the episode ends; on battery again it alerts at once, not 15 min after the last one.
        supply(box, { battery: { capacity: 25, status: "Charging" }, mains: true });
        tick(box, 20);
        expect(alerts(box)).toHaveLength(2);
        supply(box, { battery: { capacity: 25, status: "Discharging" }, mains: false });
        tick(box, 21);
        expect(alerts(box)).toHaveLength(3);
    });

    test("at or over the threshold, or on AC power, it never alerts; the threshold is configurable", () => {
        const box = coordinator();
        supply(box, { battery: { capacity: 30, status: "Discharging" }, mains: false });
        tick(box, 0);
        supply(box, { battery: { capacity: 10, status: "Charging" }, mains: true });
        tick(box, 1);
        supply(box, { battery: { capacity: 10, status: "Not charging" }, mains: true });
        tick(box, 2);
        supply(box, { battery: { capacity: 10, status: "Full" }, mains: true });
        tick(box, 3);
        expect(alerts(box)).toEqual([]);

        setBattery(box, { alertPercent: 50 });
        supply(box, { battery: { capacity: 40, status: "Discharging" }, mains: false });
        tick(box, 4);
        expect(alerts(box)).toEqual([
            "m1 on battery at 40%, discharging: plug it in; it is the coordinator, every machine's inbox, holds and fleet checks go through it",
        ]);
    });

    test("a machine with no battery never alerts, on Linux or macOS", () => {
        const box = coordinator();
        supply(box, { mains: true });
        tick(box, 0);
        box.stub("pmset", "echo \"Now drawing from 'AC Power'\"");
        tick(box, 1, { TOLI_PLATFORM: "darwin" });
        expect(alerts(box)).toEqual([]);

        box.stub(
            "pmset",
            `printf "Now drawing from 'Battery Power'\\n -InternalBattery-0 (id=1)\\t9%%; discharging; 0:20 remaining present: true\\n"`,
        );
        tick(box, 2, { TOLI_PLATFORM: "darwin" });
        expect(alerts(box)).toEqual([
            "m1 on battery at 9%, discharging: plug it in; it is the coordinator, every machine's inbox, holds and fleet checks go through it",
        ]);
    });

    test("a worker alerts only when others depend on it (battery.serves), and the coordinator hears of it", () => {
        const { m1, m2 } = pair();
        m2.ok([
            "init",
            "--name",
            "m2",
            "--role",
            "worker",
            "--coordinator-ssh",
            "host1",
            "--coordinator-root",
            m1.root,
        ]);
        supply(m2, { battery: { capacity: 12, status: "Discharging" }, mains: false });
        tick(m2, 0);
        expect(alerts(m2)).toEqual([]);

        setBattery(m2, { serves: "every machine's AI goes through it" });
        tick(m2, 1);
        const text = "m2 on battery at 12%, discharging: plug it in; every machine's AI goes through it";
        expect(alerts(m2)).toEqual([text]);
        expect(alerts(m1)).toEqual([text]);
    });

    test("the hourly fleet check shows the line too", () => {
        const box = coordinator();
        supply(box, { battery: { capacity: 25, status: "Discharging" }, mains: false });
        const local = JSON.parse(box.ok(["fleet", "check", "--local", "--json"], { env: LINUX })) as {
            battery: string | null;
        };
        expect(local.battery).toBe(COORDINATOR_TEXT);
        const check = box.ok(["fleet", "check", "--wake"], { env: LINUX, now: at(0) });
        expect(check).toStartWith(`fleet check at ${at(0)}: 1 machine on battery`);
        expect(check).toContain(`On battery, discharging (plug in):\n- ${COORDINATOR_TEXT}`);
        expect(inbox(box).map((item) => item.title)).toContain("fleet check: 1 machine on battery");

        supply(box, { battery: { capacity: 25, status: "Charging" }, mains: true });
        expect(box.ok(["fleet", "check"], { env: LINUX, now: at(1) })).toStartWith(
            `fleet check at ${at(1)}: all clear`,
        );
    });
});
