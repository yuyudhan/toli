import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { sshArgs } from "../src/core/config.ts";
import { run } from "../src/core/util.ts";

// A control socket path must stay under ~100 bytes, which the OS temp dir on macOS leaves no room for; /tmp does.
const root = mkdtempSync("/tmp/toli-ssh-");
const dir = join(root, "state", "ssh");
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Run `fn` with this file's short TOLI_ROOT, restoring the previous one after. */
async function inRoot<T>(fn: () => T | Promise<T>): Promise<T> {
    const saved = process.env.TOLI_ROOT;
    process.env.TOLI_ROOT = root;
    try {
        return await fn();
    } finally {
        if (saved === undefined) delete process.env.TOLI_ROOT;
        else process.env.TOLI_ROOT = saved;
    }
}

/** The options ssh itself resolves for a toli ssh argv prefix, read with `ssh -G` (no connection is made). */
function resolved(args: string[]): Map<string, string> {
    const host = args.at(-1) ?? "";
    const result = run([...args.slice(0, -1), "-G", host], { timeoutMs: 10_000 });
    expect(result.code).toBe(0);
    return new Map(
        result.stdout
            .split("\n")
            .filter((line) => line.includes(" "))
            .map((line) => [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)] as const),
    );
}

describe("ssh connection reuse", () => {
    test("consecutive calls to one host share one connection through the same control socket", async () => {
        const [first, second] = await inRoot(() => [sshArgs("fleet-a.invalid", 5), sshArgs("fleet-a.invalid", 5)]);
        const config = join(dir, "config");
        expect(first).toEqual(second);
        expect(first?.slice(0, 3)).toEqual(["ssh", "-F", config]);
        const text = readFileSync(config, "utf8");
        expect(text).toContain("ControlMaster auto");
        expect(text).toContain("ControlPersist 10m");
        expect(text).toContain(`ControlPath "${dir}/%C"`);
        expect(statSync(dir).mode & 0o777).toBe(0o700);
        const [a, b] = [resolved(first ?? []), resolved(second ?? [])];
        expect(a.get("controlmaster")).toBe("auto");
        expect(a.get("controlpersist")).toBe("600");
        expect(a.get("controlpath")?.startsWith(`${dir}/`)).toBe(true);
        expect(b.get("controlpath")).toBe(a.get("controlpath") ?? "");
        expect(resolved(await inRoot(() => sshArgs("fleet-b.invalid", 5))).get("controlpath")).not.toBe(
            a.get("controlpath") ?? "",
        );
    });

    test("a wedged control socket is dropped and the call connects on its own within its timeout", async () => {
        // Nothing listens on port 1, so once past the control socket the call fails fast with ssh's own exit 255.
        const host = "ssh://127.0.0.1:1";
        const socket = resolved(await inRoot(() => sshArgs(host, 2))).get("controlpath") ?? "";
        expect(socket.startsWith(`${dir}/`)).toBe(true);
        // A master that accepts and never replies: without the check, ssh waits on it forever.
        const wedged = createServer(() => undefined);
        const listening = Promise.withResolvers<void>();
        wedged.listen(socket, () => listening.resolve());
        await listening.promise;
        try {
            const result = await inRoot(() => run([...sshArgs(host, 2), "true"], { timeoutMs: 20_000 }));
            expect(result.code).toBe(255);
            expect(existsSync(socket)).toBe(false);
        } finally {
            wedged.close();
        }
    });
});
