import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeepReport } from "../src/fleet/disk.ts";
import {
    DOCKER_PRUNE_IDLE_RETRY_MS,
    DOCKER_PRUNE_MIN_INTERVAL_MS,
    type DockerPruneState,
    dockerBusyFrom,
    dockerPruneSkip,
} from "../src/fleet/docker-prune.ts";
import { dfLine, keeperBox, keeperTest } from "./disk-fixture.ts";

describe("docker prune decision", () => {
    const NOW = 1_000_000_000_000;
    const ago = (ms: number, state: Omit<DockerPruneState, "atMs">): DockerPruneState => ({ atMs: NOW - ms, ...state });
    const input = (last: DockerPruneState | null, freeGB = 16, busy: string | null = null) => ({
        busy,
        last,
        nowMs: NOW,
        freeGB,
    });

    test("waits while a pull or build runs, whatever the last prune was", () => {
        const reason = dockerPruneSkip(input(null, 16, "pid 7 `docker pull hello-world`"));
        expect(reason).toContain("pid 7 `docker pull hello-world` is running");
        expect(
            dockerPruneSkip(input(ago(10 * DOCKER_PRUNE_IDLE_RETRY_MS, { freeGB: 50, reclaimedBytes: 5 }), 16, "x")),
        ).toContain("is running");
    });

    test("prunes when nothing ran before, or the last prune is old enough and reclaimed something", () => {
        expect(dockerPruneSkip(input(null))).toBeNull();
        const reclaimed = ago(DOCKER_PRUNE_MIN_INTERVAL_MS + 1, { freeGB: 16, reclaimedBytes: 3e9 });
        expect(dockerPruneSkip(input(reclaimed))).toBeNull();
    });

    test("at most one prune per interval, even when the last one reclaimed something", () => {
        const last = ago(5 * 60_000, { freeGB: 16, reclaimedBytes: 3e9 });
        expect(dockerPruneSkip(input(last, 10))).toBe("pruned 5 min ago, at most once per 30 min");
    });

    test("after a 0 B prune it waits until free space drops 1 GB or 6 h pass", () => {
        const zero = (ms: number): DockerPruneState => ago(ms, { freeGB: 16, reclaimedBytes: 0 });
        const due = DOCKER_PRUNE_MIN_INTERVAL_MS + 60_000;
        expect(dockerPruneSkip(input(zero(due), 16))).toContain("reclaimed 0 B; waiting for free space under 15.0 GB");
        expect(dockerPruneSkip(input(zero(due), 15.5))).not.toBeNull();
        expect(dockerPruneSkip(input(zero(due), 14.9))).toBeNull();
        expect(dockerPruneSkip(input(zero(DOCKER_PRUNE_IDLE_RETRY_MS + 1), 16))).toBeNull();
    });

    test("an unknown result (a failed step) is retried after the interval, like a non-empty one", () => {
        const unknown = ago(DOCKER_PRUNE_MIN_INTERVAL_MS + 1, { freeGB: 16, reclaimedBytes: null });
        expect(dockerPruneSkip(input(unknown, 16))).toBeNull();
    });

    test("a state dated in the future (clock moved back) never blocks a prune", () => {
        expect(dockerPruneSkip(input({ atMs: NOW + 60_000, freeGB: 16, reclaimedBytes: 0 }))).toBeNull();
    });

    test("finds a running pull, build or compose up; ignores other docker commands and this process", () => {
        const ps = (...lines: string[]): string => lines.join("\n");
        expect(dockerBusyFrom(ps("  100 docker ps -a", " 101 /usr/bin/docker pull hello-world"), 1)).toBe(
            "pid 101 `/usr/bin/docker pull hello-world`",
        );
        expect(dockerBusyFrom(ps(" 102 /usr/libexec/docker/cli-plugins/docker-compose compose up -d"), 1)).toContain(
            "pid 102",
        );
        expect(dockerBusyFrom(ps(" 103 docker buildx build -t x ."), 1)).toContain("pid 103");
        expect(
            dockerBusyFrom(ps(" 104 docker image prune -f", " 105 grep docker pull", " 106 vim up.md"), 1),
        ).toBeNull();
        expect(dockerBusyFrom(ps(" 107 docker pull x"), 107)).toBeNull();
    });
});

describe("docker prune in the keeper", () => {
    /** `freeGB` free of 200 (floor 150: nothing else to free); `docker` logs its calls, every prune reclaims 0 B. */
    function dockerKeeper(freeGB: number, ps = "exit 0") {
        const box = keeperBox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const log = join(box.root, "docker.calls");
        box.stub(
            "docker",
            `printf '%s\\n' "$*" >> "${log}"\n[ "$1" = info ] && echo 29 || echo "Total reclaimed space: 0B"`,
        );
        box.stub("sccache", "exit 2");
        box.stub("ps", ps);
        box.stub("df", `kb=${freeGB * 1048576}\n${dfLine(200)}`);
        return {
            box,
            prunes: (): string[] =>
                existsSync(log)
                    ? readFileSync(log, "utf8")
                          .split("\n")
                          .filter((call) => call.includes("prune"))
                    : [],
            keep: (): string =>
                (
                    JSON.parse(
                        box.ok(["disk", "keep", "--floor", "150", "--json"], { env: { TOLI_DRY_RUN: "0" } }),
                    ) as KeepReport
                ).lines.join("\n"),
        };
    }

    keeperTest("a second keeper run right after a 0 B prune skips Docker and says why", () => {
        const { prunes, keep } = dockerKeeper(100);
        expect(keep()).toContain("ran docker builder prune -af: reclaimed 0B");
        expect(prunes()).toEqual(["builder prune -af", "image prune -f"]);
        expect(keep()).toContain("docker: skipped (pruned 0 min ago, at most once per 30 min)");
        expect(prunes()).toHaveLength(2);
    });

    keeperTest("while a docker pull runs it never prunes", () => {
        const { prunes, keep } = dockerKeeper(100, "printf '  4242 docker pull hello-world\\n'");
        expect(keep()).toContain("docker: skipped (pid 4242 `docker pull hello-world` is running");
        expect(prunes()).toEqual([]);
    });

    keeperTest("once the interval has passed and free space dropped, it prunes again", () => {
        const { box, prunes, keep } = dockerKeeper(100);
        keep();
        // The 0 B prune ran an hour ago at 102 GB free: 100 GB is over a GB lower, so Docker is tried again.
        const state = join(box.root, "state", "disk-docker-prune.json");
        writeFileSync(state, JSON.stringify({ atMs: Date.now() - 3_600_000, freeGB: 102, reclaimedBytes: 0 }));
        expect(keep()).toContain("ran docker builder prune -af");
        expect(prunes()).toHaveLength(4);
    });

    keeperTest("under the emergency level it prunes every unused image, not only dangling ones", () => {
        const { prunes, keep } = dockerKeeper(1);
        keep();
        expect(prunes()).toEqual(["builder prune -af", "image prune -af"]);
    });
});
