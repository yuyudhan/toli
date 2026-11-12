import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeepReport } from "../src/fleet/disk.ts";
import {
    buildVolumes,
    type DockerContainer,
    type DockerMount,
    parseContainers,
    parseVolumeSizes,
} from "../src/fleet/docker-volumes.ts";
import { buildOutput, holdLock, keeperBox, keeperTest } from "./disk-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";

const container = (name: string, status: string, ...mounts: [string, string][]): DockerContainer => ({
    id: name,
    name,
    status,
    image: "",
    mounts: mounts.map(([volume, destination]) => ({ type: "volume", volume, destination })),
});

describe("which docker volumes hold idle build output", () => {
    test("a build-output name or mount point makes a candidate; a data-looking one never is", () => {
        const containers = [
            container("web", "exited", ["3f2a9c", "/app/node_modules"]),
            container("db", "exited", ["x_pgdata", "/var/lib/postgresql/data"], ["cache_target", "/srv/data"]),
        ];
        const names = ["x_target", "app-cargo-registry", "3f2a9c", "x_pgdata", "cargo_pgdata", "cache_target", "logs"];
        const { volumes, kept } = buildVolumes(names, containers);
        expect(volumes.map((volume) => volume.name)).toEqual(["x_target", "app-cargo-registry", "3f2a9c"]);
        expect(volumes.find((volume) => volume.name === "3f2a9c")?.stopped.map((c) => c.name)).toEqual(["web"]);
        expect(kept).toEqual([
            "kept docker volume cargo_pgdata: its name may hold data",
            "kept docker volume cache_target: mount /srv/data may hold data",
        ]);
    });

    test("a volume a running, paused or just-created container uses stays; a stopped one's may go", () => {
        const names = ["a_target", "b_target", "c_target", "d_target"];
        const { volumes, kept } = buildVolumes(names, [
            container("run", "running", ["a_target", "/app/target"]),
            container("pause", "paused", ["b_target", "/app/target"]),
            container("new", "created", ["c_target", "/app/target"]),
            container("old", "exited", ["d_target", "/app/target"]),
        ]);
        expect(volumes.map((volume) => volume.name)).toEqual(["d_target"]);
        expect(kept).toEqual([
            "kept docker volume a_target: container run uses it (running)",
            "kept docker volume b_target: container pause uses it (paused)",
            "kept docker volume c_target: container new uses it (created)",
        ]);
    });

    test("a stopped container holding more than build output keeps the volume: a database beside a bind mount", () => {
        const postgres: DockerContainer = {
            ...container("stack-postgres-1", "exited", ["x_target", "/app/target"], ["x_pgdata", "/var/lib/data"]),
            image: "postgres:16",
        };
        postgres.mounts.push({ type: "bind", volume: "/home/me/seed", destination: "/seed" });
        const { volumes, kept } = buildVolumes(["x_target"], [postgres]);
        expect(volumes).toEqual([]);
        expect(kept).toEqual([
            "kept docker volume x_target: stopped container stack-postgres-1 mounts it and its image postgres:16 keeps data",
        ]);
        const plain = { ...postgres, image: "rust:1.82" };
        expect(buildVolumes(["x_target"], [plain]).kept[0]).toEndWith(
            "it also mounts volume x_pgdata at /var/lib/data",
        );
        plain.mounts = [postgres.mounts[0] as DockerMount, postgres.mounts[2] as DockerMount];
        expect(buildVolumes(["x_target"], [plain]).kept[0]).toEndWith(
            "it also has a bind mount /home/me/seed at /seed",
        );
        const anonymous = container(
            "web",
            "exited",
            ["x_target", "/app/target"],
            ["a".repeat(64), "/app/node_modules"],
        );
        expect(buildVolumes(["x_target"], [anonymous]).kept[0]).toContain("an anonymous volume at /app/node_modules");
    });

    test("a stopped container with only build volumes is still removed with its volume", () => {
        const backend = { ...container("stack-backend-1", "exited", ["x_target", "/app/target"]), image: "rust:1.82" };
        backend.mounts.push({ type: "volume", volume: "x_cargo", destination: "/usr/local/cargo/registry" });
        const { volumes, kept } = buildVolumes(["x_target", "x_cargo"], [backend]);
        expect(kept).toEqual([]);
        expect(volumes.map((volume) => [volume.name, volume.stopped.map((c) => c.name)])).toEqual([
            ["x_target", ["stack-backend-1"]],
            ["x_cargo", ["stack-backend-1"]],
        ]);
    });

    test("reads volume sizes from docker system df -v and containers from docker container inspect", () => {
        const df = [
            "Images space usage:",
            "",
            "REPOSITORY   TAG   IMAGE ID   CREATED   SIZE   SHARED SIZE   UNIQUE SIZE   CONTAINERS",
            "kalki        dev   0123abcd   2 days    1.2GB  0B            1.2GB         1",
            "",
            "Local Volumes space usage:",
            "",
            "VOLUME NAME            LINKS     SIZE",
            "kalki_backend_target   0         23.1GB",
            "x_pgdata               1         512MB",
            "",
            "Build cache usage: 0B",
        ].join("\n");
        const sizes = parseVolumeSizes(df);
        expect([...sizes.keys()]).toEqual(["kalki_backend_target", "x_pgdata"]);
        expect(sizes.get("kalki_backend_target")).toBeCloseTo(23.1e9 / 1024 ** 3, 6);
        expect(parseVolumeSizes("Total reclaimed space: 0B").size).toBe(0);
        const inspected = JSON.stringify([
            {
                Id: "c1",
                Name: "/stack-backend-1",
                State: { Status: "exited" },
                Config: { Image: "kalki-backend:dev" },
                Mounts: [
                    { Type: "volume", Name: "kalki_backend_target", Destination: "/app/target" },
                    { Type: "bind", Source: "/home/me/app", Destination: "/app" },
                ],
            },
        ]);
        const backend = container("stack-backend-1", "exited", ["kalki_backend_target", "/app/target"]);
        backend.mounts.push({ type: "bind", volume: "/home/me/app", destination: "/app" });
        expect(parseContainers(inspected)).toEqual([{ ...backend, id: "c1", image: "kalki-backend:dev" }]);
        expect(parseContainers("Total reclaimed space: 0B")).toBeNull();
        expect(parseContainers('[{"Name":"/no-id"}]')).toBeNull();
    });
});

/**
 * alpha idle, beta's target held by a cargo lock, on a 200 GB disk (emergency level 6 GB): 1 GB free while alpha's
 * target or the idle `x_target` volume exists, `afterGB` once both are gone. Docker lists `x_target` (23.1 GB, its
 * stopped container `stack-backend-1`), `y_target` (a running container's), `x_pgdata` (a stopped database's) and
 * `x_db_target` (no container; its name may hold data); it removes only what the keeper should remove.
 */
function volumeTree(box: Sandbox, afterGB: number, ps = "exit 0", backend: Record<string, unknown> = {}) {
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    const idle = realpathSync(withProject(box, "alpha"));
    const busy = realpathSync(withProject(box, "beta"));
    buildOutput(box, idle);
    buildOutput(box, busy);
    const volume = join(box.root, "x_target.volume");
    writeFileSync(volume, "");
    const inspect = join(box.root, "inspect.json");
    writeFileSync(
        inspect,
        JSON.stringify([
            {
                Id: "c1",
                Name: "/stack-cache-1",
                State: { Status: "running" },
                Mounts: [{ Type: "volume", Name: "y_target", Destination: "/app/target" }],
            },
            {
                Id: "c2",
                Name: "/stack-backend-1",
                State: { Status: "exited" },
                Config: { Image: "rust:1.82" },
                Mounts: [{ Type: "volume", Name: "x_target", Destination: "/app/target" }],
                ...backend,
            },
            {
                Id: "c3",
                Name: "/stack-postgres-1",
                State: { Status: "exited" },
                Mounts: [{ Type: "volume", Name: "x_pgdata", Destination: "/var/lib/postgresql/data" }],
            },
        ]),
    );
    const log = join(box.root, "docker.calls");
    box.stub(
        "docker",
        `printf '%s\\n' "$*" >> "${log}"
case "$*" in
info*) echo 29 ;;
"volume ls -q") [ -e "${volume}" ] && echo x_target; printf 'y_target\\nx_pgdata\\nx_db_target\\n' ;;
"ps -aq --no-trunc") printf 'c1\\nc2\\nc3\\n' ;;
"container inspect c1 c2 c3") cat "${inspect}" ;;
"system df -v") printf 'Local Volumes space usage:\\n\\nVOLUME NAME LINKS SIZE\\nx_target 1 23.1GB\\ny_target 1 5GB\\nx_pgdata 1 2GB\\n\\nBuild cache usage: 0B\\n' ;;
"rm c2") echo c2 ;;
"volume rm x_target") rm -f "${volume}"; echo x_target ;;
"rm "*|"volume rm"*) echo "Error: the test refuses $*" >&2; exit 1 ;;
*) echo "Total reclaimed space: 0B" ;;
esac`,
    );
    box.stub("sccache", "exit 2");
    box.stub("ps", ps);
    box.stub(
        "df",
        `if [ -e "${join(idle, "target")}" ] || [ -e "${volume}" ]; then kb=1048576; else kb=${afterGB * 1048576}; fi
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/x 209715200 1 %s 50%% /\\n' "$kb"`,
    );
    return {
        idle,
        busy,
        calls: (): string[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n") : []),
        keep: (): KeepReport =>
            JSON.parse(
                box.ok(["disk", "keep", "--floor", "50", "--json"], { env: { TOLI_DRY_RUN: "0" } }),
            ) as KeepReport,
        release: holdLock(join(busy, "target", "debug", ".cargo-lock")),
    };
}

/** Docker never removed a volume that may hold data or one a running container uses, nor such a container. */
function sparedTheRest(calls: string[]): void {
    for (const call of ["volume rm y_target", "volume rm x_pgdata", "volume rm x_db_target", "rm c1", "rm c3"])
        expect(calls).not.toContain(call);
}

describe("docker build volumes in the keeper", () => {
    keeperTest(
        "under the emergency level an idle build volume goes before a target in use, which stays when that is enough",
        () => {
            const box = keeperBox();
            const { idle, busy, calls, keep, release } = volumeTree(box, 10);
            try {
                const report = keep();
                const lines = report.lines.join("\n");
                expect(report.lastResort).toBe(false);
                expect(lines).toContain(`deleted ${join(idle, "target")}, freed `);
                expect(lines).toContain("removed stopped container stack-backend-1 (it mounts docker volume x_target)");
                expect(lines).toContain(
                    "removed docker volume x_target (21.5 GB), freed 9.0 GB (step 5: idle build volume)",
                );
                expect(lines).toContain(
                    `kept ${join(busy, "target")} in use: free 10.0 GB is over the emergency level`,
                );
                expect(lines).toContain("kept docker volume y_target: container stack-cache-1 uses it (running)");
                expect(lines).toContain("kept docker volume x_db_target: its name may hold data");
                expect(lines).not.toContain("deleting it anyway");
                expect(existsSync(join(busy, "target", "debug", "deps", "libx.rlib"))).toBe(true);
                expect(calls().indexOf("rm c2")).toBeLessThan(calls().indexOf("volume rm x_target"));
                sparedTheRest(calls());
            } finally {
                release();
            }
        },
    );

    keeperTest("even at the last resort a running container's volume and a database's volume stay", () => {
        const box = keeperBox();
        const { busy, calls, keep, release } = volumeTree(box, 1);
        try {
            const report = keep();
            const lines = report.lines.join("\n");
            expect(report.lastResort).toBe(true);
            const volumeAt = lines.indexOf("removed docker volume x_target");
            expect(volumeAt).toBeGreaterThan(-1);
            expect(volumeAt).toBeLessThan(lines.indexOf(`deleted ${join(busy, "target")}, freed `));
            expect(lines).toContain(`deleted ${join(busy, "target")}, freed 0.0 GB (step 7: last resort)`);
            sparedTheRest(calls());
        } finally {
            release();
        }
    });

    keeperTest("a stopped postgres container with a build volume, its data and a bind mount keeps all of them", () => {
        const box = keeperBox();
        const postgres = {
            Name: "/stack-postgres-2",
            Config: { Image: "postgres:16" },
            Mounts: [
                { Type: "volume", Name: "x_target", Destination: "/app/target" },
                { Type: "volume", Name: "x_pgdata", Destination: "/var/lib/postgresql/data" },
                { Type: "bind", Source: "/home/me/seed", Destination: "/seed" },
            ],
        };
        const { calls, keep, release } = volumeTree(box, 10, "exit 0", postgres);
        try {
            const lines = keep().lines.join("\n");
            expect(lines).toContain(
                "kept docker volume x_target: stopped container stack-postgres-2 mounts it and its image postgres:16 keeps data",
            );
            expect(lines).not.toContain("removed docker volume x_target");
            expect(calls()).not.toContain("rm c2");
            expect(calls()).not.toContain("volume rm x_target");
            sparedTheRest(calls());
        } finally {
            release();
        }
    });

    keeperTest("while a docker pull runs no volume goes", () => {
        const box = keeperBox();
        const { calls, keep, release } = volumeTree(box, 10, "printf '  4242 docker pull hello-world\\n'");
        try {
            const lines = keep().lines.join("\n");
            expect(lines).toContain("docker volumes: skipped (pid 4242 `docker pull hello-world` is running)");
            expect(calls().filter((call) => call.startsWith("volume rm") || call.startsWith("rm "))).toEqual([]);
        } finally {
            release();
        }
    });
});
