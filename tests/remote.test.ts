import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENV, fleet, remoteSnapshot, sshLog } from "./fleet-fixture.ts";

describe("remote and exec model tiers", () => {
    test("remote sends the tier and work type to exec as variables, and only when given", () => {
        const box = fleet(remoteSnapshot("m2"));
        box.ok(["remote", "m2", "check it", "--work", "verify", "--tier", "light"], { env: ENV });
        box.ok(["remote", "m2", "plain"], { env: ENV });
        const execs = sshLog(box)
            .split("\n")
            .filter((line) => line.includes("bin/toli exec"));
        expect(execs[0]).toContain("TOLI_EXEC_TIER=light TOLI_EXEC_WORK=verify bin/toli exec --from m1");
        expect(execs[1]).not.toContain("TOLI_EXEC_TIER");
        expect(execs[1]).not.toContain("TOLI_EXEC_WORK");
        expect(box.toli(["remote", "m2", "x", "--tier", "huge"], { env: ENV }).stderr).toContain(
            "--tier must be one of light, standard, deep",
        );
    });

    test("exec picks the model with this machine's own tier table and records it on the run", () => {
        const box = fleet(remoteSnapshot("m2"));
        const machinePath = join(box.root, "config", "machine.json");
        const machine = JSON.parse(readFileSync(machinePath, "utf8"));
        writeFileSync(machinePath, JSON.stringify({ ...machine, harness: { tiers: { omp: { deep: "m2-opus" } } } }));
        box.stub("omp", 'echo "$*"');
        const output = box.ok(["exec", "--from", "m1"], {
            env: { ...ENV, TOLI_EXEC_WORK: "verify" },
            stdin: "check\n",
        });
        expect(output).toContain("--max-time 180m --model m2-opus check");
        // The prompt's Tier: line beats the work type.
        expect(box.ok(["exec", "--from", "m1"], { env: ENV, stdin: "Tier: light\ncheck\n" })).toContain(
            "--model claude-haiku-5-5",
        );
        const runs = JSON.parse(box.ok(["runs", "--json"])) as { model: string; tier: string; work: string | null }[];
        expect(runs.map((run) => [run.model, run.tier, run.work]).sort()).toEqual([
            ["claude-haiku-5-5", "light", null],
            ["m2-opus", "deep", "verify"],
        ]);
    });

    test("exec stopped by a rate limit retries once on the next allowed tier and records the fallback", () => {
        const box = fleet(remoteSnapshot("m2"));
        const count = join(box.root, ".calls");
        box.stub(
            "omp",
            `n=$(cat "${count}" 2>/dev/null || echo 0); echo $((n + 1)) > "${count}"
if [ "$n" = 0 ]; then echo 'Error: 429 {"type":"rate_limit_error","message":"slow down"}'; exit 1; fi
echo "$*"`,
        );
        const result = box.toli(["exec", "--from", "m1"], { env: { ...ENV, TOLI_EXEC_WORK: "verify" }, stdin: "v\n" });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("--model claude-sonnet-5-5 v");
        expect(result.stderr).toContain("claude-opus-5-5 hit a rate/usage limit; retrying once on claude-sonnet-5-5");
        const [run] = JSON.parse(box.ok(["runs", "--json"])) as {
            status: string;
            model: string;
            tier: string;
            fallback: { from: string; to: string };
        }[];
        expect(run?.status).toBe("done");
        expect([run?.model, run?.tier]).toEqual(["claude-sonnet-5-5", "standard"]);
        expect(run?.fallback).toMatchObject({ from: "claude-opus-5-5", to: "claude-sonnet-5-5" });
    });
});
