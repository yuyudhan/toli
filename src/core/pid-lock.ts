import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { pidAlive, writeJsonAtomic } from "./util.ts";

/**
 * Take `lockPath` for this process without waiting, as a run that must never overlap another (the tick's messaging
 * pass, a pull): false when a live process holds it. One whose holder is gone is taken over. The caller removes it.
 */
export function tryPidLock(lockPath: string): boolean {
    mkdirSync(dirname(lockPath), { recursive: true });
    try {
        const fd = openSync(lockPath, "wx");
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let holder = 0;
    try {
        holder = Number(readFileSync(lockPath, "utf8").trim());
    } catch {
        // Released between the open and the read: take it.
    }
    if (pidAlive(holder)) return false;
    writeJsonAtomic(lockPath, process.pid);
    return true;
}
