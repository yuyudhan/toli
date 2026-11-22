// The user's tool folders on every toli process's PATH (docs/harnesses.md "Service environment"). A launchd agent,
// systemd user service or crontab line starts toli with the PATH it was installed with, and the login profile's PATH
// never replaces it (src/core/login-env.ts), so a toolchain installed under the home folder (rustup's ~/.cargo/bin,
// Bun's ~/.bun/bin, ~/.local/bin) after that install, or never on that PATH, was missing from every run the lead
// service or the tick started: a catch-up jawan's `bin/toli commit` found no cargo to check a Cargo.lock (T2266).
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

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

/**
 * `env`'s PATH with each existing `userToolDirs` folder it lacks appended: what PATH already holds keeps its place and
 * precedence, so a jawan's cargo shim, put first later (src/jawans/env.ts), stays first. Unchanged when
 * `TOLI_TOOL_DIRS=off`.
 */
export function withUserToolDirs(env: Record<string, string | undefined>): string | undefined {
    if (env[TOOL_DIRS_FLAG] === "off") return env.PATH;
    const path = env.PATH ? env.PATH.split(delimiter) : [];
    const added = userToolDirs(env).filter(
        (dir) => !path.includes(dir) && statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true,
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
