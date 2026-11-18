// A pid lock or record that outlived a reboot (T1771): the pid in it may now belong to another program, or to a
// process started after it was written; neither holds it.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryPidLock } from "../src/core/pid-lock.ts";
import { liveListener } from "../src/peer/supervise.ts";
import { inProcess, sandbox } from "./helpers.ts";

function lockPath(): string {
    return join(mkdtempSync(join(tmpdir(), "toli-pid-lock-")), "x.lock");
}

/** A live process whose command line names toli (`sh -c ... toli-holder`; the `; :` keeps sh from exec'ing sleep). */
function toliLike(): Bun.Subprocess {
    return Bun.spawn(["sh", "-c", "sleep 30; :", "toli-holder"]);
}

/**
 * Wait until ps shows `proc` with its own command line, not the bun fork that is about to exec it. A short poll: no
 * event says when another process has exec'd.
 */
async function settled(proc: Bun.Subprocess, word: string): Promise<void> {
    for (let tries = 0; tries < 100; tries++) {
        const ps = Bun.spawnSync(["ps", "-o", "args=", "-p", String(proc.pid)]);
        if (ps.stdout.toString().includes(word)) return;
        await Bun.sleep(20);
    }
    throw new Error(`pid ${proc.pid} never showed ${word}`);
}

describe("tryPidLock", () => {
    test("a live toli process that wrote the lock keeps it", async () => {
        const holder = toliLike();
        try {
            await settled(holder, "toli-holder");
            const path = lockPath();
            writeFileSync(path, String(holder.pid));
            expect(tryPidLock(path)).toBe(false);
            expect(readFileSync(path, "utf8")).toBe(String(holder.pid));
        } finally {
            holder.kill();
        }
    }, 30_000);

    test("a pid now held by another program is taken over", async () => {
        const other = Bun.spawn(["sleep", "30"]);
        try {
            await settled(other, "sleep");
            const path = lockPath();
            writeFileSync(path, String(other.pid));
            expect(tryPidLock(path)).toBe(true);
            expect(readFileSync(path, "utf8").trim()).toBe(String(process.pid));
        } finally {
            other.kill();
        }
    }, 30_000);

    test("a toli process started after the lock was written is not its holder", async () => {
        const path = lockPath();
        const later = toliLike();
        try {
            await settled(later, "toli-holder");
            writeFileSync(path, String(later.pid));
            // Dated back an hour, as a lock written before a reboot.
            const past = new Date(Date.now() - 3_600_000);
            utimesSync(path, past, past);
            expect(tryPidLock(path)).toBe(true);
            expect(readFileSync(path, "utf8").trim()).toBe(String(process.pid));
        } finally {
            later.kill();
        }
    }, 30_000);
});

describe("liveListener", () => {
    test("a listener record whose pid a reboot reused names no listener", async () => {
        const box = sandbox();
        const record = join(box.root, "state", "peer", "listener.json");
        mkdirSync(join(box.root, "state", "peer"), { recursive: true });
        const other = Bun.spawn(["sleep", "30"]);
        try {
            await settled(other, "sleep");
            const body = { pid: other.pid, port: 1, addrs: [], startedAt: "", fingerprint: "", version: "0" };
            writeFileSync(record, JSON.stringify(body));
            let seen: unknown = "unset";
            inProcess(box.root, () => {
                seen = liveListener();
            });
            expect(seen).toBeNull();
        } finally {
            other.kill();
        }
    }, 30_000);
});
