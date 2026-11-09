import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLock } from "../src/core/util.ts";

function lockPath(): string {
    return join(mkdtempSync(join(tmpdir(), "toli-lock-")), "x.lock");
}

/** The pid of a process that has already exited. */
async function deadPid(): Promise<number> {
    const proc = Bun.spawn(["true"]);
    await proc.exited;
    return proc.pid;
}

describe("withLock", () => {
    test("the lock file names its holder while it runs, and is gone after", () => {
        const path = lockPath();
        const seen = withLock(path, () => readFileSync(path, "utf8"));
        expect(seen).toBe(String(process.pid));
        expect(existsSync(path)).toBe(false);
    });

    test("a lock left by a holder that died inside it is taken over at once", async () => {
        const path = lockPath();
        writeFileSync(path, String(await deadPid()));
        const started = Date.now();
        expect(withLock(path, () => "ran")).toBe("ran");
        expect(Date.now() - started).toBeLessThan(5_000);
    });

    test("a lock whose holder is alive is waited for, then refused", () => {
        const path = lockPath();
        const holder = Bun.spawn(["sleep", "30"]);
        try {
            writeFileSync(path, String(holder.pid));
            expect(() => withLock(path, () => "ran")).toThrow("timed out waiting for lock");
            expect(existsSync(path)).toBe(true);
        } finally {
            holder.kill();
        }
    }, 30_000);
});
