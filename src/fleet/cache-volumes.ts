// The disk keeper's step 1 Docker volumes (src/fleet/disk.ts, T2232): unused build caches go before any checkout's
// build folder. A volume counts only by an exact name rule (cacheVolumes), never by a word anywhere in its name, so a
// compose data volume of a project named after a cache word stays. Docker calls go through DockerApi
// (docker-volumes.ts), whose removal loop step 5 shares.
import { addInboxItem, listInbox } from "../records/inbox.ts";
import {
    ANONYMOUS,
    type BuildVolume,
    type BuildVolumeContext,
    DATA,
    type DockerApi,
    type DockerContainer,
    freeVolumes,
    hostDocker,
} from "./docker-volumes.ts";

/**
 * Default cache names (capacity.diskCacheVolumes): a volume whose name is one, or ends in `_<name>` (a compose
 * `<project>_` prefix and any segments before it), holds a build cache.
 */
export const DEFAULT_CACHE_VOLUME_WORDS: readonly string[] = [
    "target",
    "node_modules",
    "cargo_target",
    "cargo_registry",
    "cargo_git",
];
/** A cache name: name segments joined by `_`, none empty (`target`, `cargo_registry`). */
const CACHE_NAME = /^[a-z0-9][a-z0-9.-]*(?:_[a-z0-9][a-z0-9.-]*)*$/i;

/** capacity.diskCacheVolumes from config/machine.json (`raw`) as cache names, or why it is malformed. */
export function cacheVolumeNames(raw: unknown): readonly string[] | string {
    if (raw === undefined) return DEFAULT_CACHE_VOLUME_WORDS;
    if (Array.isArray(raw) && raw.length > 0 && raw.every((word): word is string => typeof word === "string"))
        if (raw.every((word) => CACHE_NAME.test(word))) return raw;
    return 'config/machine.json capacity.diskCacheVolumes must be a non-empty list of cache names (name segments joined by "_", such as "cargo_target")';
}

/**
 * The unused build caches among `names` (fail closed: anything else stays). A volume counts only when its name is one
 * of the cache names `words`, or ends in `_<word>`: its last `_` segment(s) are exactly that name, so a compose data
 * volume of a project named after one (`cargo-api_grafana`, `cargo_wal`) never does. It must also not look like data
 * (DATA), and no container may mount it, running or stopped (nothing to remove first).
 */
export function cacheVolumes(names: string[], containers: DockerContainer[], words: readonly string[]): BuildVolume[] {
    const lowered = words.map((word) => word.toLowerCase());
    const mounted = new Set(
        containers.flatMap((container) =>
            container.mounts.flatMap((mount) => (mount.type === "volume" ? [mount.volume] : [])),
        ),
    );
    const isCache = (name: string): boolean =>
        lowered.some((word) => name.toLowerCase() === word || name.toLowerCase().endsWith(`_${word}`));
    return names
        .filter((name) => !ANONYMOUS.test(name) && !mounted.has(name) && !DATA.test(name) && isCache(name))
        .map((name) => ({ name, sizeGB: null, stopped: [] }));
}

/**
 * The keeper's step 1, before any checkout's build folder: remove unused build-cache volumes (cacheVolumes, named by
 * `cache.names`), largest first, until free disk is back at the floor; how many went. Malformed names (why, a string)
 * skip the step, saying so and alerting `cache.machine`'s inbox once while that item is there.
 */
export function freeCacheVolumes(
    context: BuildVolumeContext,
    say: (line: string) => void,
    cache: { names: readonly string[] | string; machine: string },
    docker: DockerApi = hostDocker,
): number {
    const { names: words, machine } = cache;
    if (typeof words === "string") {
        say(`docker cache volumes: skipped (${words})`);
        const title = `disk keeper: capacity.diskCacheVolumes on ${machine} is malformed`;
        if (!context.dryRun && !listInbox().some((item) => item.title === title))
            addInboxItem(
                machine,
                title,
                `${words}. The disk keeper skips unused Docker build-cache volumes until it is fixed (docs/disk.md).`,
            );
        return 0;
    }
    const step = {
        what: "docker cache volumes",
        label: "step 1: unused build-cache volume",
        pick: (names: string[], containers: DockerContainer[]) => ({
            volumes: cacheVolumes(names, containers, words),
            kept: [],
        }),
        confirm: (volume: BuildVolume) => cacheContents(docker.volumeHas(volume.name, LOOK_FOR)),
    };
    return freeVolumes(step, context, say, docker);
}

/**
 * What a build cache's root holds (T2232 round 3: `<x>_target` also names a sync or export destination): a cargo
 * target's `CACHEDIR.TAG`, `.rustc_info.json` or a profile's `.fingerprint`; node_modules' `.package-lock.json` (npm),
 * `.modules.yaml` (pnpm) or `.yarn-state.yml` (yarn). Any one of these is enough.
 */
const MARKERS: readonly string[] = [
    "CACHEDIR.TAG",
    ".rustc_info.json",
    "debug/.fingerprint",
    "release/.fingerprint",
    ".package-lock.json",
    ".modules.yaml",
    ".yarn-state.yml",
];
/** Markers that make a volume a cache only together: a cargo registry's layout, cargo's git checkouts'. */
const PAIRS: readonly (readonly [string, string])[] = [
    ["index", "cache"],
    ["db", "checkouts"],
];
/** Every path a look inside a volume asks about. */
const LOOK_FOR: readonly string[] = [...MARKERS, ...PAIRS.flat()];

/** Why a volume whose look inside found `found` (or why the look failed) is no cache after all; null when it is. */
function cacheContents(found: string[] | string): string | null {
    if (typeof found === "string") return `cannot look inside it (${found})`;
    const has = new Set(found);
    const cache = MARKERS.some((marker) => has.has(marker)) || PAIRS.some(([a, b]) => has.has(a) && has.has(b));
    return cache ? null : "no build-cache marker inside it";
}
