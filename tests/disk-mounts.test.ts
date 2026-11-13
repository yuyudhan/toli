import { describe, expect, test } from "bun:test";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostMounts, mountUse } from "../src/fleet/container-mounts.ts";
import type { KeepReport } from "../src/fleet/disk.ts";
import type { DockerContainer, DockerMount } from "../src/fleet/docker-volumes.ts";
import { buildOutput, dfLine, holdLock, keeperBox, keeperTest } from "./disk-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";

const bind = (source: string, destination: string): DockerMount => ({
    type: "bind",
    volume: source,
    source,
    destination,
});
const volume = (name: string, destination: string): DockerMount => ({
    type: "volume",
    volume: name,
    source: `/var/lib/docker/volumes/${name}/_data`,
    destination,
});
const container = (name: string, status: string, ...mounts: DockerMount[]): DockerContainer => ({
    id: name,
    name,
    status,
    image: "",
    mounts,
});

describe("which host folders a live container mounts", () => {
    test("a volume hung on a build folder inside a bind mount holds that folder; the bound tree above does not", () => {
        // itlinux3's velocityfss stack (T101): ./apps/backend at /app, the volume backend_target at /app/target.
        const backend = "/srv/velocityfss/apps/backend";
        const stack = container(
            "velocityfss-backend",
            "running",
            bind(backend, "/app"),
            volume("velocityfss_backend_target", "/app/target"),
        );
        const mounts = hostMounts([stack]);
        expect(mountUse(`${backend}/target`, mounts)).toBe(
            `container velocityfss-backend (running) mounts volume velocityfss_backend_target at /app/target, over ${backend}/target`,
        );
        expect(mountUse(`${backend}/web/node_modules`, mounts)).toBeNull();
        expect(mountUse("/srv/velocityfss/target", mounts)).toBeNull();
    });

    test("a bind of the folder or below it, or a volume's mountpoint below it, holds it; a stopped container nothing", () => {
        const direct = container("web", "paused", bind("/srv/a/target", "/app/target"));
        const inner = container("cache", "created", bind("/srv/b/node_modules/.cache", "/cache"));
        const local = { ...container("v", "restarting"), mounts: [{ ...volume("v", "/v"), source: "/srv/c/dist/v" }] };
        const stopped = container("old", "exited", bind("/srv/d/target", "/app/target"));
        const mounts = hostMounts([direct, inner, local, stopped]);
        expect(mountUse("/srv/a/target", mounts)).toBe(
            "container web (paused) mounts bind mount /srv/a/target at /app/target",
        );
        expect(mountUse("/srv/b/node_modules", mounts)).toContain("container cache (created)");
        expect(mountUse("/srv/c/dist", mounts)).toBe("container v (restarting) mounts volume v at /v");
        expect(mountUse("/srv/d/target", mounts)).toBeNull();
    });
});

/**
 * itlinux3 on 2026-11-12 (T101): 1 GB free of 200 GB and nothing to gain, so the keeper reaches its last resort.
 * beta's target is held by a cargo lock (host cargo) and is the mountpoint a running stack hangs its target volume on,
 * through a bind of the whole checkout; alpha is idle, its target bind-mounted straight into a running container; a
 * stopped container binds beta's web/dist.
 */
function mountedTree(box: Sandbox, ps: string) {
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    const idle = realpathSync(withProject(box, "alpha"));
    const busy = realpathSync(withProject(box, "beta"));
    buildOutput(box, idle);
    buildOutput(box, busy);
    const inspect = join(box.root, "inspect.json");
    writeFileSync(
        inspect,
        JSON.stringify([
            {
                Id: "c1",
                Name: "/velocityfss-backend",
                State: { Status: "running" },
                Mounts: [
                    { Type: "bind", Source: busy, Destination: "/app" },
                    {
                        Type: "volume",
                        Name: "velocityfss_backend_target",
                        Source: "/var/lib/docker/volumes/velocityfss_backend_target/_data",
                        Destination: "/app/target",
                    },
                ],
            },
            {
                Id: "c2",
                Name: "/alpha-web-1",
                State: { Status: "running" },
                Mounts: [{ Type: "bind", Source: join(idle, "target"), Destination: "/app/target" }],
            },
            {
                Id: "c3",
                Name: "/beta-site-1",
                State: { Status: "exited" },
                Mounts: [{ Type: "bind", Source: join(busy, "web", "dist"), Destination: "/site" }],
            },
        ]),
    );
    box.stub(
        "docker",
        `case "$*" in
info*) echo 29 ;;
"ps -aq --no-trunc") ${ps} ;;
"container inspect c1 c2 c3") cat "${inspect}" ;;
"volume ls -q") ;;
*) echo "Total reclaimed space: 0B" ;;
esac`,
    );
    box.stub("sccache", "exit 2");
    box.stub("df", `kb=1048576\n${dfLine(200)}`);
    return {
        idle,
        busy,
        keep: (): KeepReport =>
            JSON.parse(
                box.ok(["disk", "keep", "--floor", "50", "--json"], { env: { TOLI_DRY_RUN: "0" } }),
            ) as KeepReport,
        release: holdLock(join(busy, "target", "debug", ".cargo-lock")),
    };
}

const NEVER = "a folder a live container mounts is never deleted";

describe("build folders a running container mounts in the keeper", () => {
    keeperTest("even at the last resort a target a running container mounts stays (itlinux3's T101)", () => {
        const box = keeperBox();
        const { idle, busy, keep, release } = mountedTree(box, "printf 'c1\\nc2\\nc3\\n'");
        try {
            const report = keep();
            const lines = report.lines.join("\n");
            expect(report.lastResort).toBe(true);
            expect(lines).toContain(
                `kept ${join(busy, "target")}: container velocityfss-backend (running) mounts volume velocityfss_backend_target at /app/target, over ${join(busy, "target")}; ${NEVER}`,
            );
            expect(lines).toContain(
                `kept ${join(idle, "target")}: container alpha-web-1 (running) mounts bind mount ${join(idle, "target")} at /app/target; ${NEVER}`,
            );
            expect(lines).not.toContain(`deleted ${join(busy, "target")}`);
            expect(lines).not.toContain(`deleted ${join(idle, "target")}`);
            expect(lines).not.toContain("deleting it anyway");
            expect(existsSync(join(busy, "target", "debug", "deps", "libx.rlib"))).toBe(true);
            expect(existsSync(join(idle, "target", "debug", "deps", "libx.rlib"))).toBe(true);
            // A stopped container holds nothing: the rest of the build output still goes.
            expect(lines).toContain(`deleted ${join(busy, "web", "dist")}, freed `);
            expect(existsSync(join(idle, "web", "dist"))).toBe(false);
        } finally {
            release();
        }
    });

    keeperTest("when docker answers but its containers cannot be read, no build folder goes", () => {
        const box = keeperBox();
        const { idle, busy, keep, release } = mountedTree(box, "echo 'Error: permission denied' >&2; exit 1");
        try {
            const lines = keep().lines.join("\n");
            expect(lines).toContain(
                `kept ${join(idle, "target")}: cannot read docker's containers: docker ps failed (exit 1); ${NEVER}`,
            );
            for (const clone of [idle, busy]) expect(lines).not.toContain(`deleted ${clone}`);
            expect(existsSync(join(idle, "target", "debug", "deps", "libx.rlib"))).toBe(true);
        } finally {
            release();
        }
    });
});
