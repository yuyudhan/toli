// The user's tool folders on every toli process's PATH (docs/harnesses.md "Service environment"). A launchd agent,
// systemd user service or crontab line starts toli with the PATH it was installed with, and the login profile's PATH
// never replaces it (src/core/login-env.ts), so a toolchain installed under the home folder (rustup's ~/.cargo/bin,
// Bun's ~/.bun/bin, ~/.local/bin) after that install, or never on that PATH, was missing from every run the lead
// service or the tick started: a catch-up jawan's `bin/toli commit` found no cargo to check a Cargo.lock (T2266).
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/** `off` leaves PATH as it is (tests, so the host's own tools never reach a sandboxed toli). */
export const TOOL_DIRS_FLAG = "TOLI_TOOL_DIRS";

/**
 * The folders a login shell usually puts the user's toolchains on PATH from, in this order: cargo's (`$CARGO_HOME/bin`,
 * default `~/.cargo/bin`), Bun's (`$BUN_INSTALL/bin`, default `~/.bun/bin`), `~/.local/bin`, `~/bin`, Homebrew's
 * `/opt/homebrew/bin` and `/usr/local/bin`.
 */
export function userToolDirs(env: Record<string, string | undefined>): string[] {
    const home = env.HOME || homedir();
    return [
        join(env.CARGO_HOME || join(home, ".cargo"), "bin"),
        join(env.BUN_INSTALL || join(home, ".bun"), "bin"),
        join(home, ".local", "bin"),
        join(home, "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ];
}

/** What `withUserToolDirs` reads of a folder: `statSync`'s answer, or undefined when it does not exist. */
export type DirStat = (dir: string) => { isDirectory(): boolean; uid: number; gid: number; mode: number } | undefined;

/** A PATH entry as compared for duplicates: without trailing slashes (`/opt/homebrew/bin/` is `/opt/homebrew/bin`). */
const bare = (dir: string): string => dir.replace(/\/+$/, "") || "/";

/**
 * Whether `dir` and each folder above it, up to `home` when under it or else `/` (both checked), is a directory that
 * only this user or root can change, as ssh's StrictModes asks: owned by `uid` or root, not world-writable, and
 * group-writable only for one of `groups` (this user's groups). Otherwise someone else could plant a `cargo` there,
 * or swap the folder for one holding it.
 */
function trustedChain(dir: string, home: string, stat: DirStat, uid: number, groups: number[]): boolean {
    const top = dir === home || dir.startsWith(`${home}/`) ? home : "/";
    for (let at = dir; ; at = dirname(at)) {
        const found = stat(at);
        if (found?.isDirectory() !== true || (found.uid !== uid && found.uid !== 0)) return false;
        if ((found.mode & 0o002) !== 0 || ((found.mode & 0o020) !== 0 && !groups.includes(found.gid))) return false;
        if (at === top || at === "/") return true;
    }
}

/**
 * `env`'s PATH with each `userToolDirs` folder it lacks appended: what PATH already holds keeps its place and
 * precedence, so a jawan's cargo shim, put first later (src/jawans/env.ts), stays first. A folder is added only when
 * it and the folders above it pass `trustedChain`, so no other user can plant a `cargo` every toli run would find.
 * Unchanged when `TOLI_TOOL_DIRS=off`.
 */
export function withUserToolDirs(
    env: Record<string, string | undefined>,
    stat: DirStat = (dir) => statSync(dir, { throwIfNoEntry: false }),
    uid: number = process.getuid?.() ?? 0,
    groups: number[] = process.getgroups?.() ?? [],
): string | undefined {
    if (env[TOOL_DIRS_FLAG] === "off") return env.PATH;
    const path = env.PATH ? env.PATH.split(delimiter) : [];
    const held = new Set(path.map(bare));
    const home = bare(env.HOME || homedir());
    const added = userToolDirs(env).filter(
        (dir) => !held.has(bare(dir)) && trustedChain(bare(dir), home, stat, uid, groups),
    );
    return added.length === 0 ? env.PATH : [...path, ...added].join(delimiter);
}

/**
 * Give this process (and so everything it starts: a jawan, a job's harness, a gate, a push, a commit's lock-file check)
 * the user's tool folders on PATH. Called once as each toli command starts (src/main.ts).
 */
export function adoptUserToolDirs(env: Record<string, string | undefined> = process.env): void {
    const path = withUserToolDirs(env);
    if (path !== undefined) env.PATH = path;
}
