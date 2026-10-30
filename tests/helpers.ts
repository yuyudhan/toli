import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const TOLI_BIN = resolve(import.meta.dir, "..", "bin", "toli");

/** Git identity and an empty global config, so user hooks (e.g. secret scanners) never run in tests. */
export const GIT_ENV: Record<string, string> = {
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
};

export type ToliRun = { code: number; stdout: string; stderr: string };

export type Sandbox = {
    root: string;
    stubs: string;
    toli(args: string[], options?: { stdin?: string; now?: string; env?: Record<string, string> }): ToliRun;
    /** `toli` that must succeed; returns trimmed stdout. */
    ok(args: string[], options?: { stdin?: string; now?: string; env?: Record<string, string> }): string;
    stub(name: string, script: string): void;
    git(dir: string, args: string[]): string;
};

/**
 * A temp TOLI_ROOT with its own stub-binaries dir first on PATH. The host's schedulers are never read or written:
 * `systemctl` starts stubbed as "no user session" (Linux-mode runs pick crontab on any host) and `crontab` as an
 * empty crontab that refuses writes; a test that wants either stubs its own.
 */
export function sandbox(): Sandbox {
    const root = mkdtempSync(join(tmpdir(), "toli-test-"));
    const stubs = join(root, ".stubs");
    mkdirSync(stubs);
    const stub: Sandbox["stub"] = (name, script) => {
        const file = join(stubs, name);
        writeFileSync(file, `#!/bin/sh\n${script}\n`);
        chmodSync(file, 0o755);
    };
    stub("systemctl", 'echo "Failed to connect to bus: No medium found" >&2; exit 1');
    stub(
        "crontab",
        'if [ "$1" = "-l" ]; then echo "no crontab for test" >&2; else echo "crontab stub: writes refused" >&2; fi; exit 1',
    );
    const path = [stubs, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
    const toli: Sandbox["toli"] = (args, options = {}) => {
        const proc = Bun.spawnSync([process.execPath, TOLI_BIN, ...args], {
            cwd: root,
            env: {
                ...process.env,
                ...GIT_ENV,
                PATH: path,
                TOLI_ROOT: root,
                TOLI_DRY_RUN: "1",
                ...(options.now === undefined ? {} : { TOLI_NOW: options.now }),
                ...options.env,
            },
            stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
            stdout: "pipe",
            stderr: "pipe",
        });
        return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    };
    return {
        root,
        stubs,
        toli,
        ok(args, options) {
            const result = toli(args, options);
            if (result.code !== 0)
                throw new Error(`toli ${args.join(" ")} exited ${result.code}: ${result.stderr}${result.stdout}`);
            return result.stdout.trim();
        },
        stub,
        git(dir, args) {
            const proc = Bun.spawnSync(["git", "-C", dir, ...args], {
                env: { ...process.env, ...GIT_ENV },
                stdout: "pipe",
                stderr: "pipe",
            });
            if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
            return proc.stdout.toString().trim();
        },
    };
}

/** A file-backed `crontab` stub: `-l` prints the file (exit 1 when absent), `-` replaces it from stdin. */
export function withCrontab(box: Sandbox, initial: string | null): string {
    const file = join(box.root, ".crontab");
    if (initial !== null) writeFileSync(file, initial);
    box.stub(
        "crontab",
        `case "$1" in
    -l) [ -f "${file}" ] || { echo "no crontab for test" >&2; exit 1; }; cat "${file}" ;;
    -) cat > "${file}" ;;
    *) exit 2 ;;
esac`,
    );
    return file;
}

/**
 * A working `systemctl --user` stub: every call is appended to `.systemctl`; `enable` / `disable` flip whether
 * `is-active` answers "active". Units go to `units/` via TOLI_SYSTEMD_USER_DIR; `env` selects Linux, not dry run.
 */
export function withSystemd(box: Sandbox): { env: Record<string, string>; units: string; calls: () => string[] } {
    const log = join(box.root, ".systemctl");
    const active = join(box.root, ".active");
    box.stub(
        "systemctl",
        `printf '%s\\n' "$*" >> "${log}"
case "$2" in
    is-active) if [ -f "${active}" ]; then echo active; else echo inactive; exit 3; fi ;;
    enable) touch "${active}" ;;
    disable) rm -f "${active}" ;;
esac`,
    );
    const units = join(box.root, "units");
    return {
        env: { TOLI_PLATFORM: "linux", TOLI_DRY_RUN: "0", TOLI_SYSTEMD_USER_DIR: units },
        units,
        calls: () => (existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : []),
    };
}

/** A bare "origin" repo with one commit on main, plus `projects/<name>` registered via `toli project add`. */
export function withProject(box: Sandbox, name: string): string {
    const origin = join(box.root, ".origin", `${name}.git`);
    const seed = join(box.root, ".seed", name);
    mkdirSync(origin, { recursive: true });
    mkdirSync(seed, { recursive: true });
    box.git(origin, ["init", "--bare", "--initial-branch=main"]);
    box.git(seed, ["init", "--initial-branch=main"]);
    writeFileSync(join(seed, "README"), "seed\n");
    box.git(seed, ["add", "README"]);
    box.git(seed, ["commit", "-m", "seed"]);
    box.git(seed, ["push", origin, "main"]);
    box.ok(["project", "add", name, origin]);
    return join(box.root, "projects", name);
}
