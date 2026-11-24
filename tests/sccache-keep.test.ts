import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keepSccache } from "../src/fleet/sccache-keep.ts";
import { age, artifact } from "./disk-fixture.ts";
import { tempDir } from "./helpers.ts";

const KIB = 1024;
const uid = process.getuid?.() ?? 0;
const savedPath = process.env.PATH;
const savedProcDir = process.env.TOLI_PROC_DIR;

afterEach(() => {
    process.env.PATH = savedPath;
    if (savedProcDir === undefined) delete process.env.TOLI_PROC_DIR;
    else process.env.TOLI_PROC_DIR = savedProcDir;
});

type Fixture = { cache: string; entries: string[]; calls: () => string[] };

/**
 * `ps` and `sccache` stubs first on PATH: `ps` lists `rows` (pid ppid uid stat args); `sccache --show-stats` reports a
 * local cache in a temp folder of ten 1 KiB entries, the first the oldest, with `cachedKiB` of `capKiB` used.
 */
function fixture(rows: string[], cachedKiB: number, capKiB: number): Fixture {
    const root = tempDir("sccache-keep");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const cache = join(root, "cache");
    const entries = Array.from({ length: 10 }, (_, i) => {
        const entry = artifact(join(cache, String(i % 3), `entry-${i}`), KIB);
        age(entry, 100 - i);
        return entry;
    });
    const log = join(root, "sccache.log");
    const stub = (name: string, body: string): void => {
        writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
        chmodSync(join(bin, name), 0o755);
    };
    stub("ps", `cat <<'EOF'\n${rows.join("\n")}\nEOF`);
    const stats = [
        `Cache location                  Local disk: "${cache}"`,
        `Cache size                           ${cachedKiB} KiB`,
        `Max cache size                       ${capKiB} KiB`,
    ].join("\n");
    stub(
        "sccache",
        [
            `printf '%s\\n' "$*" >> '${log}'`,
            'case "$1" in',
            `--show-stats) cat <<'EOF'\n${stats}\nEOF\n;;`,
            "--stop-server) echo 'Stopping sccache server...' ;;",
            "esac",
        ].join("\n"),
    );
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    return {
        cache,
        entries,
        calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
    };
}

const server = (pid: number, owner = uid): string => `${pid} 1 ${owner} Ss /usr/local/bin/sccache`;
const rustc = (pid: number, ppid: number): string =>
    `${pid} ${ppid} ${uid} R /home/u/.rustup/toolchains/stable/bin/rustc --crate-name serde --edition 2021`;
const client = (pid: number): string => `${pid} 900 ${uid} S /usr/local/bin/sccache rustc --crate-name tokio`;

describe("sccache at its cap", () => {
    test("a server at its cap compiling nothing: oldest entries trimmed to 80% of the cap, then --stop-server", () => {
        // A wedged server: a client waits on it, and it runs no compiler.
        const f = fixture([server(500), client(501)], 10, 10);
        const line = keepSccache(false);
        expect(f.entries.slice(0, 2).some(existsSync)).toBe(false);
        expect(f.entries.slice(2).every(existsSync)).toBe(true);
        expect(f.calls()).toEqual(["--show-stats", "--stop-server"]);
        expect(line).toContain("stopped the sccache server (pid 500)");
        expect(line).toContain("2 oldest entries");
    });

    test("a compiler running under the server: trimmed, never stopped", () => {
        const f = fixture([server(500), rustc(510, 500), client(501)], 10, 10);
        const line = keepSccache(false);
        expect(f.entries.slice(0, 2).some(existsSync)).toBe(false);
        expect(f.calls()).toEqual(["--show-stats"]);
        expect(line).toContain("compile in flight (pid 510)");
    });

    test("under 95% of the cap: nothing trimmed, nothing stopped", () => {
        const f = fixture([server(500)], 9, 10);
        expect(keepSccache(false)).toBeNull();
        expect(f.entries.every(existsSync)).toBe(true);
        expect(f.calls()).toEqual(["--show-stats"]);
    });

    test("no server of this user's: sccache is not asked anything, so none starts", () => {
        const f = fixture([`500 1 ${uid + 1} Ss /usr/local/bin/sccache`, rustc(510, 1)], 10, 10);
        expect(keepSccache(false)).toBeNull();
        expect(f.calls()).toEqual([]);
    });

    test("a dry run deletes and stops nothing", () => {
        const f = fixture([server(500)], 10, 10);
        const line = keepSccache(true);
        expect(f.entries.every(existsSync)).toBe(true);
        expect(f.calls()).toEqual(["--show-stats"]);
        expect(line).toContain("would trim");
        expect(line).toContain("would stop the sccache server (pid 500)");
    });

    test("a build's own server in its scope is never asked; the shared one still is (T24)", () => {
        const proc = tempDir("sccache-keep-proc");
        mkdirSync(join(proc, "500"));
        const socket = "/run/user/1000/toli-sccache-1-4242.sock";
        writeFileSync(join(proc, "500", "environ"), `PATH=/usr/bin\0SCCACHE_SERVER_UDS=${socket}\0`);
        process.env.TOLI_PROC_DIR = proc;
        const alone = fixture([server(500), rustc(510, 500)], 10, 10);
        expect(keepSccache(false)).toBeNull();
        expect(alone.calls()).toEqual([]);

        const beside = fixture([server(500), server(600)], 10, 10);
        expect(keepSccache(false)).toContain("stopped the sccache server (pid 600)");
        expect(beside.calls()).toEqual(["--show-stats", "--stop-server"]);
    });
});
