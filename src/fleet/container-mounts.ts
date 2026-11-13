// Which host folders a live Docker container mounts, so the disk keeper (src/fleet/disk.ts) never deletes one at any
// step, the last resort included (T1256). A container uses a host path when it is a bind mount's folder, a volume's
// mountpoint, or the place one of its mounts sits on inside one of its own bind mounts: a compose stack that binds
// `./apps/backend` at /app and mounts the volume `backend_target` at /app/target hangs that volume on the host's
// `apps/backend/target`. Deleting that folder unhooks the volume inside the running container, whose /app/target then
// falls through to whatever the bind shows (T101 on itlinux3: the live backend lost its 53 GB build cache and broke).
// A folder only above a mount (the bound checkout itself) is not held by it: the keeper never deletes a checkout, and
// its build folders are judged on their own.
import { posix } from "node:path";
import { run } from "../core/util.ts";
import { real, within } from "./disk-scan.ts";
import { type DockerContainer, type DockerMount, listContainers, liveContainer } from "./docker-volumes.ts";

/** One host path a live container mounts, and how, for the keeper's log. */
export type HostMount = { path: string; why: string };

/** Container path `path` is `dir` or lies below it. */
function inside(path: string, dir: string): boolean {
    return path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

function describeMount(mount: DockerMount): string {
    if (mount.type === "volume") return `volume ${mount.volume}`;
    if (mount.type === "bind") return `bind mount ${mount.source}`;
    return `${mount.type} mount`;
}

/** Every host path the live (running, paused, restarting or created) containers mount; see the top. */
export function hostMounts(containers: DockerContainer[]): HostMount[] {
    const held: HostMount[] = [];
    for (const container of containers.filter(liveContainer)) {
        const binds = container.mounts.filter((mount) => mount.type === "bind" && mount.source !== "");
        for (const mount of container.mounts) {
            const why = `container ${container.name} (${container.status}) mounts ${describeMount(mount)} at ${mount.destination}`;
            if ((mount.type === "bind" || mount.type === "volume") && mount.source !== "")
                held.push({ path: real(mount.source), why });
            // The innermost other bind mount holding this mount point: the host folder the mount hangs on.
            const outer = binds
                .filter((bind) => bind !== mount && inside(mount.destination, bind.destination))
                .sort((a, b) => b.destination.length - a.destination.length)[0];
            if (outer === undefined) continue;
            const below = posix.relative(outer.destination, mount.destination);
            const path = below === "" ? real(outer.source) : `${real(outer.source)}/${below}`;
            held.push({ path, why: `${why}, over ${path}` });
        }
    }
    return held;
}

/** Why a live container uses `dir` (a mount at it or below it), or null when none does. */
export function mountUse(dir: string, mounts: HostMount[]): string | null {
    const resolved = real(dir);
    return mounts.find((mount) => within(mount.path, resolved))?.why ?? null;
}

/**
 * The host paths live containers mount, read from Docker; a string says why they cannot be known. No docker, or a
 * daemon this user cannot reach, runs no container that could use a folder of ours: none (as step 5 and the prune
 * judge it). A daemon that answers but whose containers cannot be listed leaves every folder in doubt.
 */
export function liveHostMounts(): HostMount[] | string {
    const info = run(["docker", "info", "--format", "{{.ServerVersion}}"], { timeoutMs: 20_000 });
    if (info.code !== 0) return [];
    const containers = listContainers();
    return typeof containers === "string" ? `cannot read docker's containers: ${containers}` : hostMounts(containers);
}

/** Why a live container uses a folder (see mountUse), asking Docker once, at the first folder asked about. */
export function containerUseOnce(read: () => HostMount[] | string = liveHostMounts): (dir: string) => string | null {
    let mounts: HostMount[] | string | undefined;
    return (dir) => {
        mounts ??= read();
        return typeof mounts === "string" ? mounts : mountUse(dir, mounts);
    };
}
