// Cargo-like build output for the disk keeper's tests (tests/disk.test.ts, tests/disk-sweep.test.ts).
import { dlopen, FFIType } from "bun:ffi";
import { expect } from "bun:test";
import { closeSync, mkdirSync, openSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Sandbox } from "./helpers.ts";

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
