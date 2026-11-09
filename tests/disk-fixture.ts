// Cargo-like build output and sandboxes for the disk keeper's tests (tests/disk*.test.ts).
import { dlopen, FFIType } from "bun:ffi";
import { expect, test } from "bun:test";
import { closeSync, mkdirSync, openSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Sandbox, sandbox } from "./helpers.ts";

/**
 * A keeper test: each builds origin repos and clones with git and runs bin/toli several times. That real I/O takes
 * 2-8 s on an idle machine but has taken 67 s at load average 30-60, so each allows 120 s.
 */
export function keeperTest(name: string, run: () => void): void {
    test(name, run, 120_000);
}

/**
 * A sandbox whose `ps` and `lsof` report no other processes and no open files, so the keeper sees only what a test
 * sets up (running jawans in state/, cargo's locks) and never the host's own processes.
 */
export function keeperBox(): Sandbox {
    const box = sandbox();
    box.stub("ps", "exit 0");
    box.stub("lsof", "exit 0");
    return box;
}

/** Merge `capacity` into the sandbox's config/machine.json. */
export function setCapacity(box: Sandbox, capacity: Record<string, number>): void {
    const file = join(box.root, "config", "machine.json");
    const machine = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...machine, capacity }));
}

/** A `df -Pk` stub line for a volume of `totalGB` with `$kb` (a shell variable the script sets) available. */
export function dfLine(totalGB: number): string {
    const total = totalGB * 1024 * 1024;
    return `printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/x ${total} 1 %s 50%% /\\n' "$kb"`;
}

/** A clone with a cargo-style target, node_modules and dist, all git-ignored, plus a tracked dist in `docs/`. */
export function buildOutput(box: Sandbox, clone: string): void {
    writeFileSync(join(clone, ".gitignore"), "target/\nnode_modules/\ndist/\n");
    mkdirSync(join(clone, "docs", "dist"), { recursive: true });
    writeFileSync(join(clone, "docs", "dist", "page.html"), "tracked\n");
    box.git(clone, ["add", "-f", ".gitignore", "docs/dist/page.html"]);
    box.git(clone, ["commit", "-m", "tracked dist"]);
    mkdirSync(join(clone, "target", "debug", "deps"), { recursive: true });
    writeFileSync(join(clone, "target", "debug", ".cargo-lock"), "");
    writeFileSync(join(clone, "target", "debug", "deps", "libx.rlib"), "x".repeat(4096));
    mkdirSync(join(clone, "web", "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(clone, "web", "node_modules", "pkg", "index.js"), "1\n");
    mkdirSync(join(clone, "web", "dist"), { recursive: true });
    writeFileSync(join(clone, "web", "dist", "app.js"), "1\n");
}

export const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

/** Hold an exclusive flock on `file` as a compiling cargo would; returns the release. */
export function holdLock(file: string): () => void {
    const fd = openSync(file, "r");
    expect(libc.symbols.flock(fd, 2 | 4)).toBe(0);
    return () => {
        libc.symbols.flock(fd, 8);
        closeSync(fd);
    };
}

/** Set a file's or folder's atime and mtime to `minutes` ago. */
export function age(path: string, minutes: number): void {
    const when = new Date(Date.now() - minutes * 60_000);
    utimesSync(path, when, when);
}

/** Write `path` (and its folders) holding `bytes` bytes. */
export function artifact(path: string, bytes = 4096): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "x".repeat(bytes));
    return path;
}

/**
 * A cargo profile dir `<target>/debug` whose artifacts in deps, build, .fingerprint and incremental were last used
 * `staleMinutes` ago, beside fresh ones just written, its `.cargo-lock` as old as the stale ones.
 */
export function agedTarget(target: string, staleMinutes: number): { lock: string; stale: string[]; fresh: string[] } {
    const debug = join(target, "debug");
    const lock = artifact(join(debug, ".cargo-lock"), 0);
    const staleFiles = [
        artifact(join(debug, "deps", "libold-1a2b.rlib")),
        artifact(join(debug, ".fingerprint", "old-1a2b", "lib-old")),
        artifact(join(debug, "build", "old-3c4d", "out", "generated.rs")),
        artifact(join(debug, "incremental", "old-5e6f", "s-abc-working", "query-cache.bin")),
    ];
    const fresh = [
        artifact(join(debug, "deps", "libnew-7a8b.rlib")),
        artifact(join(debug, ".fingerprint", "new-7a8b", "lib-new")),
    ];
    const stale = [
        join(debug, "deps", "libold-1a2b.rlib"),
        join(debug, ".fingerprint", "old-1a2b"),
        join(debug, "build", "old-3c4d"),
        join(debug, "incremental", "old-5e6f"),
    ];
    // Files first, then their folders deepest first: writing a file moves its folder's mtime.
    for (const file of [...staleFiles, lock]) age(file, staleMinutes);
    const folders = [
        join(debug, "build", "old-3c4d", "out"),
        join(debug, "incremental", "old-5e6f", "s-abc-working"),
        ...stale.slice(1),
        join(debug, ".fingerprint", "new-7a8b"),
    ];
    for (const folder of folders) age(folder, staleMinutes);
    return { lock, stale, fresh };
}
