// T2232: the disk keeper wiped a release lane's 120 GB `target/` twice in 6.6 h while an unused 112 GB cargo-target
// Docker volume sat beside it. Unused build-cache volumes now go before any checkout's build folder (step 1), and a
// target in a clone a live jawan or a held heavy-build slot holds stays until free disk is under the emergency level.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    cacheVolumeNames,
    cacheVolumes,
    DEFAULT_CACHE_VOLUME_WORDS,
    freeCacheVolumes,
} from "../src/fleet/cache-volumes.ts";
import type { KeepReport } from "../src/fleet/disk.ts";
import { type Holders, softHold } from "../src/fleet/disk-scan.ts";
import type { DockerApi, DockerContainer } from "../src/fleet/docker-volumes.ts";
import { buildOutput, keeperBox, keeperTest, setCapacity } from "./disk-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";

const mounting = (name: string, status: string, volume: string): DockerContainer => ({
    id: name,
    name,
    status,
    image: "rust:1.82",
    mounts: [{ type: "volume", volume, source: "", destination: "/app/target" }],
});

/**
 * A fake Docker: `volumes` with their sizes (GB), `containers`, what a look inside each volume finds (`contents`: the
 * paths there, or why the look failed; a cargo target's `CACHEDIR.TAG` when not given), and every removal asked for.
 */
function fakeDocker(
    volumes: Record<string, number>,
    containers: DockerContainer[] = [],
    unavailable: string | null = null,
    contents: Record<string, string[] | string> = {},
): DockerApi & { removed: string[] } {
    const removed: string[] = [];
    return {
        removed,
        unavailable: () => unavailable,
        volumes: () => Object.keys(volumes),
        containers: () => containers,
        volumeSizes: () => new Map(Object.entries(volumes)),
        volumeHas: (name, paths) => {
            const found = contents[name] ?? ["CACHEDIR.TAG"];
            return typeof found === "string" ? found : paths.filter((path) => found.includes(path));
        },
        removeContainer: (id) => {
            removed.push(`container ${id}`);
            return null;
        },
        removeVolume: (name) => {
            removed.push(name);
            return null;
        },
    };
}

describe("unused build-cache volumes", () => {
    test("a cache-named volume no container mounts, running or stopped, is a candidate; a data name never is", () => {
        const names = [
            "app_backend_cargo_target",
            "app_e2e_s3_data",
            "web_node_modules",
            "live_target",
            "app_pgdata",
            "a".repeat(64),
            "ci_build-cache",
        ];
        const containers = [
            mounting("web-1", "exited", "web_node_modules"),
            mounting("api-1", "running", "live_target"),
        ];
        expect(cacheVolumes(names, containers, DEFAULT_CACHE_VOLUME_WORDS).map((volume) => volume.name)).toEqual([
            "app_backend_cargo_target",
        ]);
        // capacity.diskCacheVolumes names other caches.
        expect(cacheVolumes(names, containers, ["build-cache"]).map((volume) => volume.name)).toEqual([
            "ci_build-cache",
        ]);
    });

    // T2232 round 2: a cache word anywhere in the name took compose data volumes of a project named after one.
    test("only a last name segment that is exactly a cache name counts; everything else is kept", () => {
        const kept = [
            "cargo-api_grafana",
            "cargo-api_keycloak",
            "cargo_wal",
            "cargo_gitea",
            "target-app_grafana",
            "retarget_home",
            "cargo_home_ssh_keys",
            "myproj_targets_config",
            "app_cache",
            "hf_cache",
            "x_cargo",
            "x_mytarget",
        ];
        const caches = [
            "acme_backend_cargo_target",
            "x_target",
            "x_node_modules",
            "x_cargo_registry",
            "x_cargo_target",
            "target",
        ];
        const picked = cacheVolumes([...kept, ...caches], [], DEFAULT_CACHE_VOLUME_WORDS).map((volume) => volume.name);
        expect(picked).toEqual(caches);
        // A custom name opts its own caches in, still only as the whole last segment(s).
        expect(
            cacheVolumes(["app_cache", "hf_cache", "cache_db_x", "x_cachex"], [], ["cache"]).map((v) => v.name),
        ).toEqual(["app_cache", "hf_cache"]);
    });

    const defaults = { names: DEFAULT_CACHE_VOLUME_WORDS, machine: "m1" };

    test("a malformed capacity.diskCacheVolumes is reported, never read as the defaults", () => {
        expect(cacheVolumeNames(undefined)).toEqual(DEFAULT_CACHE_VOLUME_WORDS);
        expect(cacheVolumeNames(["cargo_target"])).toEqual(["cargo_target"]);
        for (const bad of ["target", [], [""], ["has space"], ["_target"], [3]])
            expect(cacheVolumeNames(bad)).toContain("capacity.diskCacheVolumes must be");
    });

    test("largest first until free disk is back at the floor, through the Docker interface", () => {
        const docker = fakeDocker({ small_target: 2, big_cargo_target: 112.2, mid_node_modules: 30 });
        let free = 40;
        const sizes: Record<string, number> = { small_target: 2, big_cargo_target: 112.2, mid_node_modules: 30 };
        const real = docker.removeVolume;
        docker.removeVolume = (name) => {
            free += sizes[name] ?? 0;
            return real(name);
        };
        const lines: string[] = [];
        const context = { dryRun: false, free: () => free, stop: () => free >= 60, simulate: () => undefined };
        expect(freeCacheVolumes(context, (line) => lines.push(line), defaults, docker)).toBe(1);
        expect(docker.removed).toEqual(["big_cargo_target"]);
        expect(lines).toContain(
            "removed docker volume big_cargo_target (112.2 GB), freed 112.2 GB (step 1: unused build-cache volume)",
        );
    });

    test("a dry run removes nothing; without Docker the step says why and calls nothing else", () => {
        const docker = fakeDocker({ big_cargo_target: 112.2 });
        const lines: string[] = [];
        let simulated = 0;
        const context = {
            dryRun: true,
            free: () => 40 + simulated,
            stop: () => 40 + simulated >= 60,
            simulate: (size: number) => {
                simulated += size;
            },
        };
        expect(freeCacheVolumes(context, (line) => lines.push(line), defaults, docker)).toBe(1);
        expect(docker.removed).toEqual([]);
        expect(lines).toContain(
            "would remove docker volume big_cargo_target (112.2 GB, step 1: unused build-cache volume)",
        );

        const absent = fakeDocker({ big_cargo_target: 112.2 }, [], "not installed");
        const said: string[] = [];
        expect(freeCacheVolumes(context, (line) => said.push(line), defaults, absent)).toBe(0);
        expect(said).toEqual(["docker cache volumes: skipped (not installed)"]);
        expect(absent.removed).toEqual([]);
    });

    // T2232 round 3: `<x>_target` also names a destination (a sync, replica or export target), not only cargo's.
    test("a cache-named volume goes only when a look inside finds a cache's markers; else it stays and says why", () => {
        const destinations = "sync replica snapshot export migration s3 es mlflow".split(" ").map((w) => `${w}_target`);
        const sizes = Object.fromEntries([
            ...destinations.map((name) => [name, 50] as const),
            ["app_cargo_target", 40],
            ["web_node_modules", 30],
            ["app_cargo_registry", 20],
            ["app_cargo_git", 10],
            ["pnpm_node_modules", 5],
            ["broken_target", 4],
            ["fake_cargo_registry", 3],
        ]);
        const contents: Record<string, string[] | string> = {
            ...Object.fromEntries(destinations.map((name) => [name, ["data.parquet", "index"]])),
            app_cargo_target: ["debug/.fingerprint", "debug"],
            web_node_modules: [".package-lock.json"],
            app_cargo_registry: ["index", "cache", "src"],
            app_cargo_git: ["db", "checkouts"],
            pnpm_node_modules: [".modules.yaml"],
            broken_target: "docker run failed: no such image",
            fake_cargo_registry: ["index"],
        };
        const docker = fakeDocker(sizes, [], null, contents);
        const lines: string[] = [];
        const context = { dryRun: false, free: () => 0, stop: () => false, simulate: () => undefined };
        expect(freeCacheVolumes(context, (line) => lines.push(line), defaults, docker)).toBe(5);
        expect(docker.removed.sort()).toEqual(
            ["app_cargo_git", "app_cargo_registry", "app_cargo_target", "pnpm_node_modules", "web_node_modules"].sort(),
        );
        for (const name of destinations)
            expect(lines).toContain(`kept docker volume ${name}: no build-cache marker inside it`);
        expect(lines).toContain(
            "kept docker volume broken_target: cannot look inside it (docker run failed: no such image)",
        );
        expect(lines).toContain("kept docker volume fake_cargo_registry: no build-cache marker inside it");
    });
});

describe("a held clone's target", () => {
    test("a live native jawan in a main clone or a held build slot in a checkout holds its targets", () => {
        const holders: Holders = {
            runs: [],
            tasks: [{ path: "/p/alpha", why: "T1's jawan AlphaTrain works in it" }],
            gates: [],
            cwds: new Map(),
            slots: [{ cwd: "/p/beta/apps/web", why: "heavy-build slot 1 (pid 7) is held for a build in it" }],
        };
        expect(softHold({ project: "alpha", path: "/p/alpha", main: true }, holders)).toBe(
            "T1's jawan AlphaTrain works in it",
        );
        expect(softHold({ project: "beta", path: "/p/beta", main: true }, holders)).toBe(
            "heavy-build slot 1 (pid 7) is held for a build in it",
        );
        expect(softHold({ project: "gamma", path: "/p/gamma", main: true }, holders)).toBeNull();
    });
});

/**
 * Machine m1 with project alpha (a cargo target, node_modules, dist), on a 200 GB disk (emergency level 6 GB, floor
 * 50): `whileThere` GB free while `holder(clone)` exists (freeWhileThere).
 */
function laneTree(box: Sandbox, whileThere: number, holder: (clone: string) => string): string {
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    const clone = realpathSync(withProject(box, "alpha"));
    buildOutput(box, clone);
    box.stub("sccache", "exit 2");
    freeWhileThere(box, holder(clone), whileThere);
    return clone;
}

/** `whileThere` GB free while `path` exists, 100 GB once it is gone. */
function freeWhileThere(box: Sandbox, path: string, whileThere: number): void {
    box.stub(
        "df",
        `if [ -e "${path}" ]; then kb=${whileThere * 1048576}; else kb=${100 * 1048576}; fi
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/x 209715200 1 %s 50%% /\\n' "$kb"`,
    );
}

/**
 * A docker stub listing `app_backend_cargo_target` (no container, there while `marker` exists), `app_e2e_s3_data` (no
 * container, a data name), `web_node_modules` (a stopped container's) and `live_target` (a running container's);
 * it logs every call and removes only the unused cache volume. Without `localImage` no image is present locally.
 */
function laneDocker(box: Sandbox, marker: string, localImage = true): () => string[] {
    writeFileSync(marker, "");
    const inspect = join(box.root, "inspect.json");
    writeFileSync(
        inspect,
        JSON.stringify([
            {
                Id: "c1",
                Name: "/web-1",
                State: { Status: "exited" },
                Mounts: [{ Type: "volume", Name: "web_node_modules", Destination: "/app/node_modules" }],
            },
            {
                Id: "c2",
                Name: "/api-1",
                State: { Status: "running" },
                Mounts: [{ Type: "volume", Name: "live_target", Destination: "/app/target" }],
            },
        ]),
    );
    const log = join(box.root, "docker.calls");
    box.stub(
        "docker",
        `printf '%s\\n' "$*" >> "${log}"
case "$*" in
info*) echo 29 ;;
"image inspect"*) ${localImage ? "echo sha256:busybox" : `echo "Error: No such image: busybox:latest" >&2; exit 1`} ;;
pull*) echo "Error: the test refuses $*" >&2; exit 1 ;;
"volume ls -q") [ -e "${marker}" ] && echo app_backend_cargo_target; printf 'app_e2e_s3_data\\nweb_node_modules\\nlive_target\\n' ;;
"ps -aq --no-trunc") printf 'c1\\nc2\\n' ;;
"container inspect c1 c2") cat "${inspect}" ;;
"system df -v") printf 'Local Volumes space usage:\\n\\nVOLUME NAME LINKS SIZE\\napp_backend_cargo_target 0 112.2GB\\napp_e2e_s3_data 0 16GB\\n\\n' ;;
"run "*source=app_backend_cargo_target,*) echo CACHEDIR.TAG; echo debug/.fingerprint ;;
"volume rm app_backend_cargo_target") rm -f "${marker}"; echo app_backend_cargo_target ;;
"rm "*|"volume rm"*) echo "Error: the test refuses $*" >&2; exit 1 ;;
*) echo "Total reclaimed space: 0B" ;;
esac`,
    );
    return () => (existsSync(log) ? readFileSync(log, "utf8").split("\n") : []);
}

const keep = (box: Sandbox): KeepReport =>
    JSON.parse(box.ok(["disk", "keep", "--floor", "50", "--json"], { env: { TOLI_DRY_RUN: "0" } })) as KeepReport;

describe("the keeper beside a release lane", () => {
    keeperTest(
        "an unused build-cache volume goes before any checkout's target, which stays once that is enough",
        () => {
            const box = keeperBox();
            const marker = join(box.root, "cargo-target.volume");
            const clone = laneTree(box, 30, () => marker);
            const calls = laneDocker(box, marker);
            const lines = keep(box).lines.join("\n");
            expect(lines).toContain(
                "removed docker volume app_backend_cargo_target (104.5 GB), freed 70.0 GB (step 1: unused build-cache volume)",
            );
            const look = calls().find((call) => call.startsWith("run ") && call.includes("app_backend_cargo_target"));
            expect(look).toContain("--pull never");
            expect(look).toContain("source=app_backend_cargo_target,target=/v,readonly");
            expect(lines).not.toContain(`deleted ${join(clone, "target")}`);
            expect(existsSync(join(clone, "target", "debug", "deps", "libx.rlib"))).toBe(true);
            for (const call of [
                "volume rm app_e2e_s3_data",
                "volume rm web_node_modules",
                "volume rm live_target",
                "rm c1",
            ])
                expect(calls()).not.toContain(call);
        },
    );

    keeperTest("a malformed capacity.diskCacheVolumes skips step 1 with an alert and removes no volume", () => {
        const box = keeperBox();
        const marker = join(box.root, "cargo-target.volume");
        laneTree(box, 30, () => marker);
        const calls = laneDocker(box, marker);
        const config = join(box.root, "config", "machine.json");
        const machine = JSON.parse(readFileSync(config, "utf8")) as Record<string, unknown>;
        writeFileSync(config, JSON.stringify({ ...machine, capacity: { diskCacheVolumes: "cargo" } }));
        const lines = keep(box).lines.join("\n");
        expect(lines).toContain("docker cache volumes: skipped (config/machine.json capacity.diskCacheVolumes must be");
        expect(calls().filter((call) => call.startsWith("volume rm"))).toEqual([]);
        expect(existsSync(marker)).toBe(true);
        const inbox = box.ok(["inbox", "list"]);
        expect(inbox).toContain("disk keeper: capacity.diskCacheVolumes on m1 is malformed");
    });

    // T2232 round 3: with no image to look inside it with, the volume stays (fail closed) and nothing is pulled.
    keeperTest("with no local image to look inside it, the cache volume stays and nothing is pulled", () => {
        const box = keeperBox();
        const marker = join(box.root, "cargo-target.volume");
        laneTree(box, 30, () => marker);
        const calls = laneDocker(box, marker, false);
        const lines = keep(box).lines.join("\n");
        expect(lines).toContain(
            "kept docker volume app_backend_cargo_target: cannot look inside it (no local busybox:latest image to look with (never pulled))",
        );
        expect(calls().filter((call) => /^(pull|run|volume rm|image pull)\b/.test(call))).toEqual([]);
        expect(existsSync(marker)).toBe(true);
    });

    keeperTest("with capacity.diskKeep false a jawan start removes no volume: low disk only alerts", () => {
        const box = keeperBox();
        const marker = join(box.root, "cargo-target.volume");
        const clone = laneTree(box, 30, () => marker);
        const calls = laneDocker(box, marker);
        setCapacity(box, { diskKeepGB: 50, diskKeep: false });
        box.stub("omp", "true");
        const brief = join(box.root, "brief.md");
        writeFileSync(brief, "TOLI_BRIEF v1\nsay hi\n");
        box.ok(["spawn", "--brief", brief, "--cwd", box.root, "--json"], { env: { TOLI_DRY_RUN: "0" } });
        expect(calls().filter((call) => call.startsWith("volume rm") || call.startsWith("rm "))).toEqual([]);
        expect(existsSync(marker)).toBe(true);
        expect(existsSync(join(clone, "target", "debug", "deps", "libx.rlib"))).toBe(true);
    });

    keeperTest("a live native jawan's clone keeps its target over the emergency level, not under it", () => {
        const box = keeperBox();
        const clone = laneTree(box, 30, (dir) => join(dir, "target"));
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
        const target = join(clone, "target");

        const over = keep(box);
        expect(over.lines).toContain(
            `skipped ${target}: T1's jawan AlphaTrain works in it; kept until free disk is under the emergency level`,
        );
        expect(existsSync(join(target, "debug", "deps", "libx.rlib"))).toBe(true);
        expect(over.inUseLeft.map((left) => left.path)).toContain(target);

        // 1 GB free: under the emergency level (6 GB), a full disk deletes it.
        freeWhileThere(box, target, 1);
        const under = keep(box).lines.join("\n");
        expect(under).toContain(`deleted ${target}, freed `);
        expect(under).toContain("(step 1: idle target, under the emergency level)");
        expect(existsSync(target)).toBe(false);
    });
});
