// The disk keeper's Docker volume step (src/fleet/disk.ts, step 5): under the emergency level only, after every idle
// build folder and Docker's build cache (step 3) and before any build folder in use, it removes Docker volumes of
// rebuildable build output that no running container uses: a compose stack's cargo `target/` or `node_modules`
// cache, rebuilt by its next build. A volume counts as build output only when its name says so (ends in `target`,
// or holds `cargo` or `node_modules`) or a container mounts it at such a place (`.../target`, `.../node_modules`, a
// `cargo` folder), and never when its name or any mount point looks like data (a database, uploads, backups: DATA
// below), whatever else matches. Largest first, re-checking free disk after each volume and stopping once it is over
// the emergency level. Stopped containers that still mount the volume are removed first (`docker rm`, never `-v`:
// their other volumes stay), since Docker refuses to remove a volume a container references, but only a container
// that holds nothing but build output: every mount a named build-output volume (no bind mount, no anonymous or
// data-looking volume) and an image that is no database or data store (DATA_IMAGE). Any other stopped user keeps the
// volume, which is then skipped. A running, paused or just-created container keeps its volumes. Like the prune, it never runs while a pull, build or compose up runs.
import { run } from "../core/util.ts";
import { parseSize } from "./disk-caches.ts";
import { GIB, gb } from "./disk-state.ts";
import { dockerBusy } from "./docker-prune.ts";

const DOCKER_LIST_TIMEOUT_MS = 120_000;
/** `docker system df -v` sizes every volume, which takes a while on a big one. */
const DOCKER_DF_TIMEOUT_MS = 600_000;
const DOCKER_REMOVE_TIMEOUT_MS = 600_000;

/** A volume name that says build output: `*_target` / `*-target` / `target`, `*cargo*`, `*node_modules*`. */
const BUILD_NAME = /(?:^|[_.-])target$|cargo|node[_-]?modules/i;
/** A mount point that says build output: a `target` or `node_modules` folder, or a cargo home or registry. */
const BUILD_MOUNT = /\/(?:target|node_modules)\/?$|cargo/i;
/** A name or mount point that may hold data: such a volume is never removed, even when it also looks like a build's. */
const DATA =
    /pg|postgres|sql|maria|mongo|redis|valkey|data|db|upload|media|minio|elastic|opensearch|clickhouse|kafka|rabbit|backup|storage|vault|secret/i;
/** An image that keeps data in its container (a database, queue or object store): such a container is never removed. */
const DATA_IMAGE =
    /postgres|postgis|timescale|mysql|maria|percona|mongo|clickhouse|redis|valkey|keydb|memcache|elastic|opensearch|minio|rabbitmq|kafka|zookeeper|cassandra|scylla|couch|neo4j|influx|etcd|consul|vault|nats|pulsar|cockroach|surreal|questdb|meilisearch|typesense|qdrant|weaviate|milvus|registry|gitea|gitlab|nextcloud|wordpress|ghost/i;
/** An anonymous volume's name: 64 hex digits Docker chose. */
const ANONYMOUS = /^[0-9a-f]{64}$/;
/** Docker's volume names: anything else in `docker volume ls` output is not a volume. */
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** Container states that start nothing on their own: their volumes may go once they are removed. */
const STOPPED: Record<string, true> = { exited: true, dead: true };

/** One mount of a container: `volume` is the volume's name for a volume mount, else its source (a bind's host path). */
export type DockerMount = { type: string; volume: string; destination: string };
export type DockerContainer = { id: string; name: string; status: string; image: string; mounts: DockerMount[] };

/** A named volume mount whose name or mount point says build output and neither may hold data. */
function buildMount(mount: DockerMount): boolean {
    if (mount.type !== "volume" || mount.volume === "" || ANONYMOUS.test(mount.volume)) return false;
    if (!BUILD_NAME.test(mount.volume) && !BUILD_MOUNT.test(mount.destination)) return false;
    return !DATA.test(mount.volume) && !DATA.test(mount.destination);
}

/** Why a stopped container may not be removed (it holds more than build output), or null when it may. */
function holdsMore(container: DockerContainer): string | null {
    if (DATA_IMAGE.test(container.image)) return `its image ${container.image} keeps data`;
    const other = container.mounts.find((mount) => !buildMount(mount));
    if (other === undefined) return null;
    if (other.type === "volume")
        return `it also mounts ${ANONYMOUS.test(other.volume) ? "an anonymous volume" : `volume ${other.volume}`} at ${other.destination}`;
    return `it also has a ${other.type} mount ${other.volume} at ${other.destination}`;
}
/** A build-output volume to remove, and the stopped containers that must go first. */
export type BuildVolume = { name: string; sizeGB: number | null; stopped: DockerContainer[] };

/**
 * Which of `names` hold rebuildable build output and may go now (sizes unknown yet), and one line for each
 * build-looking volume kept: one that may hold data, or one a running container uses.
 */
export function buildVolumes(
    names: string[],
    containers: DockerContainer[],
): { volumes: BuildVolume[]; kept: string[] } {
    const volumes: BuildVolume[] = [];
    const kept: string[] = [];
    for (const name of names) {
        const mine = (mount: DockerMount): boolean => mount.type === "volume" && mount.volume === name;
        const users = containers.filter((container) => container.mounts.some(mine));
        const at = users.flatMap((container) => container.mounts.filter(mine).map((mount) => mount.destination));
        if (!BUILD_NAME.test(name) && !at.some((destination) => BUILD_MOUNT.test(destination))) continue;
        const data = [name, ...at].find((text) => DATA.test(text));
        if (data !== undefined) {
            kept.push(`kept docker volume ${name}: ${data === name ? "its name" : `mount ${data}`} may hold data`);
            continue;
        }
        const live = users.find((container) => !Object.hasOwn(STOPPED, container.status));
        if (live !== undefined) {
            kept.push(`kept docker volume ${name}: container ${live.name} uses it (${live.status})`);
            continue;
        }
        const holder = users.map((container) => ({ container, why: holdsMore(container) })).find((u) => u.why !== null);
        if (holder !== undefined) {
            kept.push(
                `kept docker volume ${name}: stopped container ${holder.container.name} mounts it and ${holder.why}`,
            );
            continue;
        }
        volumes.push({ name, sizeGB: null, stopped: users });
    }
    return { volumes, kept };
}

/** Volume sizes (GB) from `docker system df -v` text: its "Local Volumes space usage" table. */
export function parseVolumeSizes(text: string): Map<string, number> {
    const sizes = new Map<string, number>();
    const lines = text.split("\n");
    const start = lines.findIndex((line) => /^Local Volumes space usage/i.test(line.trim()));
    if (start < 0) return sizes;
    let rows = false;
    for (const line of lines.slice(start + 1)) {
        const trimmed = line.trim();
        if (trimmed === "") {
            if (rows) break;
            continue;
        }
        if (/^VOLUME NAME\b/i.test(trimmed)) {
            rows = true;
            continue;
        }
        if (trimmed.endsWith(":")) break;
        const words = trimmed.split(/\s+/);
        const bytes = parseSize(words.at(-1));
        const name = words[0];
        if (name !== undefined && bytes !== null && words.length >= 2) sizes.set(name, bytes / GIB);
    }
    return sizes;
}

type Inspected = {
    Id?: unknown;
    Name?: unknown;
    State?: { Status?: unknown };
    Config?: { Image?: unknown };
    Mounts?: { Type?: unknown; Name?: unknown; Source?: unknown; Destination?: unknown }[];
};

/** Containers from `docker container inspect` JSON; null when it does not parse. */
export function parseContainers(json: string): DockerContainer[] | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed)) return null;
    const containers: DockerContainer[] = [];
    for (const item of parsed as Inspected[]) {
        if (typeof item.Id !== "string") return null;
        // Every mount, binds and tmpfs included: an unknown type counts as more than build output.
        const mounts = (Array.isArray(item.Mounts) ? item.Mounts : []).map((mount) => {
            const type = typeof mount.Type === "string" ? mount.Type : "unknown";
            const source = type === "volume" ? mount.Name : mount.Source;
            return {
                type,
                volume: typeof source === "string" ? source : "",
                destination: typeof mount.Destination === "string" ? mount.Destination : "",
            };
        });
        const name = typeof item.Name === "string" ? item.Name.replace(/^\//, "") : item.Id.slice(0, 12);
        const status = typeof item.State?.Status === "string" ? item.State.Status : "unknown";
        const image = typeof item.Config?.Image === "string" ? item.Config.Image : "";
        containers.push({ id: item.Id, name, status, image, mounts });
    }
    return containers;
}

/** Every container with its mounts, or why they cannot be read. */
function listContainers(): DockerContainer[] | string {
    const ids = run(["docker", "ps", "-aq", "--no-trunc"], { timeoutMs: DOCKER_LIST_TIMEOUT_MS });
    if (ids.code !== 0) return `docker ps failed (exit ${ids.code})`;
    const list = ids.stdout.split("\n").filter((id) => /^[0-9a-f]+$/i.test(id.trim()));
    if (list.length === 0) return [];
    const inspected = run(["docker", "container", "inspect", ...list.map((id) => id.trim())], {
        timeoutMs: DOCKER_LIST_TIMEOUT_MS,
    });
    const containers = inspected.code === 0 ? parseContainers(inspected.stdout) : null;
    return containers ?? `docker container inspect failed (exit ${inspected.code})`;
}

export type BuildVolumeContext = {
    dryRun: boolean;
    /** Free disk now, GB. */
    free: () => number;
    /** True once free disk is over the emergency level: the step stops. */
    over: () => boolean;
    /** Count `sizeGB` as freed (a dry run). */
    simulate: (sizeGB: number) => void;
};

const STEP = "step 5: idle build volume";

/** Remove idle build-output volumes until free disk is over the emergency level (see the top); how many went. */
export function freeBuildVolumes(context: BuildVolumeContext, say: (line: string) => void): number {
    const info = run(["docker", "info", "--format", "{{.ServerVersion}}"], { timeoutMs: 20_000 });
    if (info.code !== 0) {
        say(`docker volumes: skipped (${info.code === 127 ? "not installed" : "daemon not reachable"})`);
        return 0;
    }
    const busy = dockerBusy();
    if (busy !== null) {
        say(`docker volumes: skipped (${busy} is running)`);
        return 0;
    }
    const listed = run(["docker", "volume", "ls", "-q"], { timeoutMs: DOCKER_LIST_TIMEOUT_MS });
    if (listed.code !== 0) {
        say(`docker volumes: skipped (docker volume ls failed, exit ${listed.code})`);
        return 0;
    }
    const names = listed.stdout
        .split("\n")
        .map((name) => name.trim())
        .filter((name) => VOLUME_NAME.test(name));
    const containers = listContainers();
    if (typeof containers === "string") {
        say(`docker volumes: skipped (${containers})`);
        return 0;
    }
    const { volumes, kept } = buildVolumes(names, containers);
    for (const line of kept) say(line);
    if (volumes.length === 0) {
        say("docker volumes: none holds idle build output");
        return 0;
    }
    // Largest first, so the fewest volumes go; a size `docker system df` does not report sorts last.
    const sizes = parseVolumeSizes(run(["docker", "system", "df", "-v"], { timeoutMs: DOCKER_DF_TIMEOUT_MS }).stdout);
    for (const volume of volumes) volume.sizeGB = sizes.get(volume.name) ?? null;
    volumes.sort((a, b) => (b.sizeGB ?? -1) - (a.sizeGB ?? -1));
    let removed = 0;
    for (const volume of volumes) {
        if (context.over()) break;
        const size = volume.sizeGB === null ? "size unknown" : gb(volume.sizeGB);
        if (context.dryRun) {
            for (const container of volume.stopped)
                say(`would remove stopped container ${container.name} (it mounts docker volume ${volume.name})`);
            say(`would remove docker volume ${volume.name} (${size}, ${STEP})`);
            context.simulate(volume.sizeGB ?? 0);
            removed += 1;
            continue;
        }
        const before = context.free();
        const refusal = removeVolume(volume, say);
        if (refusal !== null) {
            say(`kept docker volume ${volume.name}: ${refusal}`);
            continue;
        }
        removed += 1;
        const freed = gb(Math.max(0, context.free() - before));
        say(`removed docker volume ${volume.name} (${size}), freed ${freed} (${STEP})`);
    }
    return removed;
}

/** Remove `volume` and, first, the stopped containers that mount it; why not, when Docker refused. */
function removeVolume(volume: BuildVolume, say: (line: string) => void): string | null {
    for (const container of volume.stopped) {
        const gone = run(["docker", "rm", container.id], { timeoutMs: DOCKER_REMOVE_TIMEOUT_MS });
        if (gone.code !== 0) return `docker rm ${container.name} failed: ${firstLine(gone.stderr || gone.stdout)}`;
        say(`removed stopped container ${container.name} (it mounts docker volume ${volume.name})`);
    }
    const result = run(["docker", "volume", "rm", volume.name], { timeoutMs: DOCKER_REMOVE_TIMEOUT_MS });
    return result.code === 0 ? null : `docker volume rm failed: ${firstLine(result.stderr || result.stdout)}`;
}

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";
