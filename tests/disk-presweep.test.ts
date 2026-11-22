// The disk keeper sweeps stale artifacts out of an idle cargo target before it deletes any target whole (T2259): a
// target past builds grew (old hashed rlibs in deps) shrinks to what its builds still use, and goes whole only if free
// disk is still under the floor after the sweep. A held clone's target (a release train's clone) is neither swept nor
// deleted over the emergency level.
import { describe, expect } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeepReport } from "../src/fleet/disk.ts";
import { agedTarget, buildOutput, dfLine, keeperBox, keeperTest, setCapacity } from "./disk-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";

/** Machine m1 with project alpha: a clone with build output and a target whose stale artifacts are 240 min old. */
function staleTree(box: Sandbox): { clone: string; target: string; stale: string[]; fresh: string[] } {
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    const clone = realpathSync(withProject(box, "alpha"));
    buildOutput(box, clone);
    const target = join(clone, "target");
    const { stale, fresh } = agedTarget(target, 240);
    setCapacity(box, { diskSweepStaleMinutes: 60 });
    box.stub("docker", "exit 1");
    box.stub("sccache", "exit 2");
    return { clone, target, stale, fresh };
}

/** `whileThere` GB free (of 200) while `path` exists, 100 GB once it is gone. */
function freeWhileThere(box: Sandbox, path: string, whileThere: number): void {
    box.stub(
        "df",
        `if [ -e "${path}" ]; then kb=${whileThere * 1048576}; else kb=${100 * 1048576}; fi\n${dfLine(200)}`,
    );
}

const keep = (box: Sandbox): KeepReport =>
    JSON.parse(box.ok(["disk", "keep", "--floor", "50", "--json"], { env: { TOLI_DRY_RUN: "0" } })) as KeepReport;

/** Record T1, a live native jawan's release train, with `clone` as its workspace. */
function releaseTrain(box: Sandbox, clone: string): void {
    box.ok(["task", "add", "alpha", "Release train"]);
    const backlogFile = join(box.root, "data", "backlog.json");
    const backlog = JSON.parse(readFileSync(backlogFile, "utf8")) as { tasks: Record<string, unknown>[] };
    Object.assign(backlog.tasks[0] ?? {}, {
        status: "active",
        agent: "AlphaTrain",
        agentSession: { agent: "AlphaTrain", pid: process.pid },
        dispatchedAt: new Date().toISOString(),
        workspace: { strategy: "same-branch", path: clone, branch: "main", base: "main" },
    });
    writeFileSync(backlogFile, JSON.stringify(backlog));
}

describe("stale artifacts before a whole target", () => {
    keeperTest("a sweep that brings free disk back to the floor keeps the target and its fresh artifacts", () => {
        const box = keeperBox();
        const { target, stale, fresh } = staleTree(box);
        freeWhileThere(box, stale[0] ?? "", 20);
        const report = keep(box);
        const lines = report.lines.join("\n");
        expect(lines).toContain(`swept 4 stale artifacts from ${target} (unused for 60 min, `);
        expect(lines).toContain("(step 1: stale artifacts of an idle target)");
        expect(lines).not.toContain(`deleted ${target}`);
        expect(report.freeAfterGB).toBe(100);
        for (const path of stale) expect(existsSync(path)).toBe(false);
        for (const path of fresh) expect(existsSync(path)).toBe(true);
    });

    keeperTest("a dry run counts what the sweep would free and keeps everything", () => {
        const box = keeperBox();
        const { target, stale, fresh } = staleTree(box);
        freeWhileThere(box, stale[0] ?? "", 20);
        const report = JSON.parse(
            box.ok(["disk", "keep", "--floor", "50", "--json", "--dry-run"], { env: { TOLI_DRY_RUN: "0" } }),
        ) as KeepReport;
        expect(report.lines.join("\n")).toContain(`would sweep 4 stale artifacts from ${target} (unused for 60 min`);
        for (const path of [...stale, ...fresh]) expect(existsSync(path)).toBe(true);
    });

    keeperTest("a target goes whole only when free disk is still under the floor after the sweep", () => {
        const box = keeperBox();
        const { target } = staleTree(box);
        freeWhileThere(box, target, 20);
        const lines = keep(box).lines.join("\n");
        const swept = lines.indexOf(`swept 4 stale artifacts from ${target}`);
        const deleted = lines.indexOf(`deleted ${target}, freed `);
        expect(swept).toBeGreaterThanOrEqual(0);
        expect(deleted).toBeGreaterThan(swept);
        expect(lines).toContain("(step 1: idle target)");
        expect(existsSync(target)).toBe(false);
    });

    keeperTest("a release train's clone is neither swept nor deleted over the emergency level", () => {
        const box = keeperBox();
        const { clone, target, stale, fresh } = staleTree(box);
        releaseTrain(box, clone);
        freeWhileThere(box, stale[0] ?? "", 20);
        const lines = keep(box).lines.join("\n");
        expect(lines).toContain(
            `skipped ${target}: T1's jawan AlphaTrain works in it; kept until free disk is under the emergency level`,
        );
        expect(lines).not.toContain("stale artifacts");
        for (const path of [...stale, ...fresh]) expect(existsSync(path)).toBe(true);
    });

    keeperTest("under the emergency level a release train's target is swept first and kept when that is enough", () => {
        const box = keeperBox();
        const { clone, target, stale, fresh } = staleTree(box);
        releaseTrain(box, clone);
        // 1 GB free: under the emergency level (6 GB) while the stale rlib is there.
        freeWhileThere(box, stale[0] ?? "", 1);
        const lines = keep(box).lines.join("\n");
        expect(lines).toContain(`swept 4 stale artifacts from ${target} (unused for 60 min, `);
        expect(lines).toContain("(step 1: stale artifacts of a held clone's target, under the emergency level)");
        expect(lines).not.toContain(`deleted ${target}`);
        for (const path of stale) expect(existsSync(path)).toBe(false);
        for (const path of fresh) expect(existsSync(path)).toBe(true);
    });
});
