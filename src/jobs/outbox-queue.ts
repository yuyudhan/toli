// Reading the outbox (state/outbox/, src/jobs/outbox.ts): the items queued (`<id>.json`) and the ones a process is
// sending right now (claimed by renaming to `<id>.json.sending-<pid>`). A claim whose process is gone goes back to the
// queue on every read, so a send killed mid-way (as `timeout` did to a hung `delegate`, T2126) holds nothing.
import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../core/paths.ts";
import { pidAlive, readJson } from "../core/util.ts";
import type { OutboxItem } from "./outbox.ts";

/** One queued file and its item. */
export type Queued = { file: string; item: OutboxItem };

/** An item a live process is sending right now (`<file>.sending-<pid>`), as `outbox list` shows it. */
export type Sending = Queued & { pid: number };

/** A claim this old goes back to the queue even when its pid is alive: another process may have taken that pid. */
const SENDING_STALE_MS = 10 * 60 * 1000;
const CLAIM = /^(.+\.json)\.sending-(\d+)$/;

/** `entries` oldest first: by `queuedAt`, then the file's mtime, then name; a file gone meanwhile is left out. */
function oldestFirst<T extends { item: OutboxItem; path: string; file: string }>(entries: T[]): T[] {
    const dated: Array<{ entry: T; at: number }> = [];
    for (const entry of entries) {
        let at = entry.item.queuedAt;
        if (at === undefined) {
            try {
                at = statSync(entry.path).mtimeMs;
            } catch {
                continue;
            }
        }
        dated.push({ entry, at });
    }
    dated.sort((a, b) => a.at - b.at || a.entry.file.localeCompare(b.entry.file));
    return dated.map(({ entry }) => entry);
}

/**
 * The items being sent right now, oldest first. A claim whose process is gone goes back to the queue first, so the
 * next send takes it at once; so does one claimed (renamed, which sets its ctime) over SENDING_STALE_MS ago.
 */
export function sendingItems(): Sending[] {
    const dir = paths.outboxDir();
    if (!existsSync(dir)) return [];
    const held: Array<Sending & { path: string }> = [];
    for (const name of readdirSync(dir)) {
        const claim = CLAIM.exec(name);
        if (claim === null) continue;
        const [, file = "", pidText = ""] = claim;
        const path = join(dir, name);
        const pid = Number(pidText);
        let stale: boolean;
        try {
            stale = !pidAlive(pid) || Date.now() - statSync(path).ctimeMs > SENDING_STALE_MS;
        } catch {
            continue;
        }
        if (stale) {
            try {
                renameSync(path, join(dir, file));
            } catch {
                // Another process put it back, or its sender finished with it, in the meantime.
            }
            continue;
        }
        const item = readJson<OutboxItem | null>(path, null);
        if (item !== null) held.push({ file, item, pid, path });
    }
    return oldestFirst(held).map(({ file, item, pid }) => ({ file, item, pid }));
}

/** Queued items (`<id>.json`, never one claimed for sending), oldest first; dead claims are put back first. */
export function queuedItems(): Queued[] {
    const dir = paths.outboxDir();
    if (!existsSync(dir)) return [];
    sendingItems();
    const entries: Array<Queued & { path: string }> = [];
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
        const path = join(dir, file);
        const item = readJson<OutboxItem | null>(path, null);
        if (item !== null) entries.push({ file, item, path });
    }
    return oldestFirst(entries).map(({ file, item }) => ({ file, item }));
}
