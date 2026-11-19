import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { briefStallMinutes } from "../src/jawans/progress.ts";
import { brief, coordinator, type Run, waitFor } from "./jawan-fixture.ts";

/** One run minute lasts a second, so the machine's 1-minute stall time is one second. */
const FAST = { TOLI_RUN_MINUTE_MS: "1000" };

type StallRun = Run & { stallMinutes?: number; resumedBy?: string };

describe("a brief's Stall: line", () => {
    test("is read from the brief header; a misspelt one is an error", () => {
        expect(briefStallMinutes("TOLI_BRIEF v1\n# Task\nStall: 90\n## Goal\n")).toBe(90);
        expect(briefStallMinutes("TOLI_BRIEF v1\nstall:  45 \n")).toBe(45);
        expect(briefStallMinutes("TOLI_BRIEF v1\n## Goal\nStall: 90\n")).toBeNull();
        expect(briefStallMinutes("TOLI_BRIEF v1\nTier: deep\n")).toBeNull();
        for (const bad of ["0", "-5", "1.5", "ninety", "90m"])
            expect(() => briefStallMinutes(`TOLI_BRIEF v1\nStall: ${bad}\n`)).toThrow(
                "the brief's Stall: line must be a positive whole number of minutes",
            );
    });

    test("lets a run that waits silently outlive the machine's stall time", async () => {
        // A release run watching a CI pipeline sits silent (no output, CPU or file change) longer than
        // capacity.stallMinutes; its brief's `Stall: 5` gives it 5 run minutes instead of the machine's 1.
        const box = coordinator();
        const machinePath = join(box.root, "config", "machine.json");
        const machine = JSON.parse(readFileSync(machinePath, "utf8"));
        writeFileSync(machinePath, JSON.stringify({ ...machine, capacity: { ...machine.capacity, stallMinutes: 1 } }));
        box.stub("omp", 'sleep 3; echo "Jane, the pipeline is green and the release is tagged."');
        const started = JSON.parse(
            box.ok(
                [
                    "spawn",
                    "--harness",
                    "omp",
                    "--brief",
                    brief(box, "Stall: 5\nwatch the pipeline"),
                    "--cwd",
                    box.root,
                    "--json",
                ],
                { env: FAST },
            ),
        ) as StallRun;
        expect(started.stallMinutes).toBe(5);
        const done = (await waitFor(box, started.id, (run) => run.inbox !== null)) as StallRun;
        expect(done.status).toBe("done");
        expect(done.resumedBy).toBeUndefined();
        // A malformed line is refused before anything is recorded.
        const refused = box.toli(["spawn", "--harness", "omp", "--brief", brief(box, "Stall: soon\nx"), "--json"]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain(
            "the brief's Stall: line must be a positive whole number of minutes, not soon",
        );
    }, 30_000);
});
