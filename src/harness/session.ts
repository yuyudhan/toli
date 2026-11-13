import { existsSync, rmSync } from "node:fs";
import { Args } from "../core/args.ts";
import { paths } from "../core/paths.ts";
import { now, out, pidAlive, readJson, ToliError, withLock, writeJsonAtomic } from "../core/util.ts";

export type SessionFile = { pid: number; startedAt: string };

/** The session's pid when it is a well-formed pid of a running process, else null. */
function livePid(session: SessionFile | null): number | null {
    if (session === null || !Number.isInteger(session.pid) || session.pid <= 0) return null;
    return pidAlive(session.pid) ? session.pid : null;
}

/** The live interactive session, or null. A recorded pid that is no longer running is stale and removed. */
export function liveSession(): SessionFile | null {
    const path = paths.session();
    if (!existsSync(path)) return null;
    const session = readJson<SessionFile | null>(path, null);
    if (session !== null && livePid(session) !== null) return session;
    withLock(paths.lock("session"), () => {
        const current = readJson<SessionFile | null>(path, null);
        if (current?.pid === session?.pid) rmSync(path, { force: true });
    });
    return null;
}

function parsePid(args: Args): number {
    const pid = Number(args.str("pid"));
    if (!Number.isInteger(pid) || pid <= 0) throw new ToliError("session needs --pid <n>");
    return pid;
}

export function sessionCommand(argv: string[]): void {
    const [sub, ...rest] = argv;
    const args = new Args(rest, { values: ["pid"] });
    args.maxPositional(0);
    switch (sub) {
        case "start": {
            // The first live session keeps the record: a second interactive omp started in toli's root (a jawan
            // driving omp in tmux, another terminal) must not take it, or its `session end` on exit would leave the
            // still-running lead unregistered and the lead service would run headless turns beside it. The extension
            // repeats `start` every tick, so a record lost any other way comes back within a minute.
            const pid = parsePid(args);
            const holder = withLock(paths.lock("session"), () => {
                const current = readJson<SessionFile | null>(paths.session(), null);
                const live = livePid(current);
                if (live !== null && live !== pid) return live;
                if (current?.pid !== pid)
                    writeJsonAtomic(paths.session(), {
                        pid,
                        startedAt: now().toISOString(),
                    } satisfies SessionFile);
                return pid;
            });
            out(
                holder === pid
                    ? `session ${pid} registered`
                    : `session ${pid} not registered: session ${holder} is open`,
            );
            break;
        }
        case "end": {
            const pid = parsePid(args);
            const removed = withLock(paths.lock("session"), () => {
                const current = readJson<SessionFile | null>(paths.session(), null);
                if (current?.pid !== pid) return false;
                rmSync(paths.session(), { force: true });
                return true;
            });
            out(removed ? `session ${pid} ended` : `session ${pid} was not registered`);
            break;
        }
        default:
            throw new ToliError("usage: toli session start|end --pid <n>");
    }
}
