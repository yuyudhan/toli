// Keeping the HTTPS listener (src/peer/server.ts) up, docs/peers.md "The listener": the lead service (src/fleet/lead.ts)
// calls ensureListener every few seconds on a timer of its own, and doctor and `fleet check` report a configured
// listener that is down (listenerProblem).
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../core/paths.ts";
import { pidAlive, readJson } from "../core/util.ts";
import { activeRuntime, runtimeSuperseded } from "../release/runtime.ts";
import { hasIdentity } from "./identity.ts";
import { controlRequest, type ListenerRecord, readListener } from "./server.ts";
import { peerSettings } from "./store.ts";

/** How long the lead waits for a listener on a replaced runtime to exit once asked to stop. */
const HANDOVER_MS = 5_000;

/** The running listener's record, or null when none runs. */
export function liveListener(): ListenerRecord | null {
    const record = readListener();
    return record !== null && pidAlive(record.pid) ? record : null;
}

/**
 * Whether a running listener is behind the checkout's active runtime: `self sync` (`upgrade`) has replaced the
 * snapshot it runs, or, for a record without `code` (written before 0.5.3), the active runtime has another version.
 */
function onReplacedRuntime(record: ListenerRecord): boolean {
    if (record.code !== undefined) return runtimeSuperseded(record.code, paths.root());
    const active = activeRuntime();
    if (active === null || !existsSync(active)) return false;
    const version = readJson<{ version?: string }>(join(active, "package.json"), {}).version;
    return version !== undefined && version !== record.version;
}

/**
 * Why the configured listener does not serve (doctor, `fleet check`), or null when it runs on the active runtime or
 * is not wanted (`peer.listen` off, no identity yet).
 */
export function listenerProblem(): string | null {
    if (!peerSettings().listen || !hasIdentity()) return null;
    const running = liveListener();
    if (running === null)
        return "peer.listen is on but no peer listener runs (the lead service starts it within seconds; if it stays down: bin/toli lead status, then bin/toli lead install, or bin/toli peer serve)";
    if (onReplacedRuntime(running))
        return `the peer listener (pid ${running.pid}) still runs a replaced runtime (the lead service replaces it within seconds; if it stays: bin/toli lead install)`;
    return null;
}

/** The `peer serve` this process last started, until its record names it: one still loading is not started twice. */
let starting: number | null = null;

async function exitedWithin(pid: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (pidAlive(pid)) {
        if (Date.now() >= deadline) return false;
        await Bun.sleep(50);
    }
    return true;
}

/**
 * The lead service's listener supervision: when `peer.listen` is on and this installation has its peer identity
 * (`peer init`, which `upgrade` runs: a checkout that never opted in, a test sandbox included, never binds the
 * machine's addresses), keep one listener running on the checkout's active runtime. A listener that died is started
 * again; one still running a runtime that `self sync` (`upgrade`) replaced is asked to stop over the control socket
 * and replaced at once, instead of serving old code until its next rescan. The new one is started from the active
 * runtime even when this lead still runs an older one (a long turn delays its own restart). Returns the log line when
 * it acted (or, with TOLI_DRY_RUN, would have), else null.
 */
export async function ensureListener(): Promise<string | null> {
    if (!peerSettings().listen || !hasIdentity()) return null;
    const running = liveListener();
    let replaced = "";
    if (running !== null) {
        starting = null;
        if (!onReplacedRuntime(running)) return null;
        if (process.env.TOLI_DRY_RUN === "1")
            return `would replace the peer listener on a replaced runtime (pid ${running.pid}) (TOLI_DRY_RUN)`;
        await controlRequest("/stop", {});
        if (!(await exitedWithin(running.pid, HANDOVER_MS)))
            return `asked the peer listener on a replaced runtime (pid ${running.pid}) to stop; it still runs`;
        replaced = `stopped the peer listener on a replaced runtime (pid ${running.pid}); `;
    } else if (starting !== null && pidAlive(starting)) return null;
    if (process.env.TOLI_DRY_RUN === "1") return "would start the peer listener (TOLI_DRY_RUN)";
    const active = runtimeSuperseded() ? activeRuntime() : null;
    const bin = active === null ? paths.codeBin() : join(active, "bin", "toli");
    mkdirSync(paths.logsDir(), { recursive: true });
    const log = openSync(paths.peerLog(), "a");
    const { TOLI_LEAD_TURN: _turn, ...env } = process.env;
    try {
        const child = spawn(process.execPath, [bin, "peer", "serve"], {
            cwd: paths.root(),
            detached: true,
            stdio: ["ignore", log, log],
            env,
        });
        child.unref();
        starting = child.pid ?? null;
        return `${replaced}started the peer listener (pid ${child.pid ?? "?"})`;
    } finally {
        closeSync(log);
    }
}
