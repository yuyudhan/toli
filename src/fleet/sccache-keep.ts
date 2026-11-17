// sccache at its cap, checked by the minute tick (src/jobs/tick.ts) whatever the free disk. A server whose local cache
// sits at its cap evicts an entry for every one it stores, and such a long-lived server can wedge: its clients sleep on
// its socket, it starts no compiler, yet it still answers `--show-stats` (mozilla/sccache#629, "terrible performance
// when the (disk) cache gets full"; seen with 20 of 20 GiB, builds frozen for an hour, `sccache --stop-server` freeing
// them at once: the next compile starts a fresh server and the cargo already running goes on with it).
//
// So when this user's server reports its local cache at 95% of its cap or more, the oldest entries go until the cache
// is at 80% of it (a missing entry is only a cache miss), and once the server runs no compiler it is stopped with
// `sccache --stop-server`: a fresh server sizes its cache from the folder and starts with that headroom. A server that
// runs a compiler is never stopped (it is asked again next tick). Nothing here sends a signal, and no server is asked
// anything unless one of this user's is already running, so the check never starts one.
import { basename } from "node:path";
import { run } from "../core/util.ts";
import { parseSccacheStats, trimOldest } from "./disk-caches.ts";

/** A local cache this full of its cap counts as at its cap. */
const FULL = 0.95;
/** What a cache at its cap is trimmed to: the headroom a fresh server starts with. */
const TRIM_TO = 0.8;

type Proc = { pid: number; ppid: number; uid: number; stat: string; argv: string[] };

function processes(): Proc[] {
    const result = run(["ps", "-A", "-ww", "-o", "pid=,ppid=,uid=,stat=,args="], { timeoutMs: 10_000 });
    if (result.code !== 0) return [];
    return result.stdout.split("\n").flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (match === null) return [];
        return [
            {
                pid: Number(match[1]),
                ppid: Number(match[2]),
                uid: Number(match[3]),
                stat: match[4] as string,
                argv: (match[5] as string).trim().split(/\s+/),
            },
        ];
    });
}

/**
 * An sccache server: the program alone (as a client starts it, SCCACHE_START_SERVER=1) or with `--start-server` (a
 * service manager's foreground server); a client names the compiler it runs.
 */
function isServer(proc: Proc): boolean {
    const [program, ...rest] = proc.argv;
    return program !== undefined && basename(program) === "sccache" && rest.every((arg) => arg === "--start-server");
}

const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/**
 * Trim this user's sccache local cache at its cap and restart its server once it compiles nothing (see above). A line
 * for the tick's log when it trimmed or stopped something (`would ...` in a dry run), else null. Never throws.
 */
export function keepSccache(dryRun: boolean): string | null {
    const uid = process.getuid?.();
    const table = processes();
    const server = table.find((proc) => proc.uid === uid && isServer(proc));
    if (server === undefined) return null;
    const result = run(["sccache", "--show-stats"], { timeoutMs: 20_000 });
    if (result.code !== 0) return null;
    const stats = parseSccacheStats(result.stdout);
    if (stats === null || stats.bytes < stats.maxBytes * FULL) return null;
    const { removed, total } = trimOldest(stats.dir, stats.maxBytes * TRIM_TO, dryRun);
    const at = `sccache: ${gib(stats.bytes)} at its ${gib(stats.maxBytes)} cap`;
    const trimmed = `${dryRun ? "would trim" : "trimmed"} ${removed} oldest entries of ${stats.dir} to ${gib(total)}`;
    const compiling = table.find((proc) => proc.ppid === server.pid && !proc.stat.startsWith("Z"));
    if (compiling !== undefined) {
        // Asked again every tick until the compile ends: worth a line only when this tick trimmed something.
        if (removed === 0) return null;
        return `${at}: ${trimmed}; server restart waits for the compile in flight (pid ${compiling.pid})`;
    }
    if (dryRun) return `${at}: ${trimmed}; would stop the sccache server (pid ${server.pid})`;
    const stop = run(["sccache", "--stop-server"], { timeoutMs: 60_000 });
    if (stop.code !== 0) {
        const why = (stop.stderr.trim() || stop.stdout.trim()).split("\n")[0] ?? "";
        return `${at}: ${trimmed}; sccache --stop-server failed (exit ${stop.code}${why === "" ? "" : `: ${why}`})`;
    }
    return `${at}: ${trimmed}; stopped the sccache server (pid ${server.pid}), the next compile starts a fresh one`;
}
