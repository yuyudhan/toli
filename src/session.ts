import { existsSync, rmSync } from "node:fs";
import { Args } from "./args.ts";
import { paths } from "./paths.ts";
import { now, out, pidAlive, readJson, ToliError, withLock, writeJsonAtomic } from "./util.ts";

export type SessionFile = { pid: number; startedAt: string };

/** The live interactive session, or null. A recorded pid that is no longer running is stale and removed. */
export function liveSession(): SessionFile | null {
    const path = paths.session();
    if (!existsSync(path)) return null;
    const session = readJson<SessionFile | null>(path, null);
    if (session && Number.isInteger(session.pid) && session.pid > 0 && pidAlive(session.pid)) return session;
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
            const pid = parsePid(args);
            withLock(paths.lock("session"), () => {
                writeJsonAtomic(paths.session(), {
                    pid,
                    startedAt: now().toISOString(),
                } satisfies SessionFile);
            });
            out(`session ${pid} registered`);
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
