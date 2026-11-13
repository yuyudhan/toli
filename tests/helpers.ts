import { spyOn } from "bun:test";
import {
    chmodSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
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

/**
 * Shell line for an `ssh` stub: sets `$host` and `$cmd` to its last two arguments, whatever options toli's ssh
 * calls put before them (sshArgs in src/core/config.ts).
 */
export const SSH_STUB_ARGS = 'for arg in "$@"; do host="$cmd"; cmd="$arg"; done';

const temps: string[] = [];

/** A fresh `toli-<prefix>-*` dir under the OS temp dir, removed after the whole run (tests/setup.ts). */
export function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `toli-${prefix}-`));
    temps.push(dir);
    return dir;
}

/** Removes every dir made by `tempDir`. */
export function removeTempDirs(): void {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export type ToliRun = { code: number; stdout: string; stderr: string };

export type Sandbox = {
    root: string;
    stubs: string;
    toli(args: string[], options?: { stdin?: string; now?: string; env?: Record<string, string> }): ToliRun;
    /** `toli` without blocking, so several can run at once (overlapping ticks). */
    toliAsync(args: string[], options?: { now?: string; env?: Record<string, string> }): Promise<ToliRun>;
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
    const root = tempDir("test");
    const stubs = join(root, ".stubs");
    mkdirSync(stubs);
    const stub: Sandbox["stub"] = (name, script) => {
        const file = join(stubs, name);
        writeFileSync(file, `#!/bin/sh\n${script}\n`);
        chmodSync(file, 0o755);
    };
    stub("systemctl", 'echo "Failed to connect to bus: No medium found" >&2; exit 1');
    // Never the host's sudo (cached credentials would run a test's root steps for real); a test that wants it uses withSudo.
    stub("sudo", 'echo "sudo: a password is required" >&2; exit 1');
    stub(
        "crontab",
        'if [ "$1" = "-l" ]; then echo "no crontab for test" >&2; else echo "crontab stub: writes refused" >&2; fi; exit 1',
    );
    // gitleaks stays reachable (bin/toli commit scans every staged set with it; CI installs it before the tests), but
    // only it: the rest of its directory (gh, glab, no-mistakes, ...) stays off PATH.
    const gitleaks = Bun.which("gitleaks");
    if (gitleaks) symlinkSync(gitleaks, join(stubs, "gitleaks"));
    const path = [stubs, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
    const toliEnv = (options: { now?: string; env?: Record<string, string> }) => ({
        ...process.env,
        ...GIT_ENV,
        PATH: path,
        TOLI_ROOT: root,
        TOLI_DRY_RUN: "1",
        // Jawans and heavy builds start without a systemd scope, so tests on a Linux host never create real units.
        TOLI_JAWAN_SCOPE: "off",
        // No LaunchDaemons unless a test writes one here: never the host's /Library/LaunchDaemons.
        TOLI_LAUNCH_DAEMONS_DIR: join(root, "daemons"),
        TOLI_BUILD_SCOPE: "off",
        // A run's cause of death is never read from the host's journal; a test with a stub journalctl turns it on.
        TOLI_JOURNAL: "off",
        // Harnesses start without the host user's login shell (src/core/login-env.ts); a test turns it on.
        TOLI_LOGIN_ENV: "off",
        // The disk keeper's last resort deletes Playwright's browsers: never the host's.
        PLAYWRIGHT_BROWSERS_PATH: join(root, ".playwright"),
        // The disk keeper frees build output no-mistakes runs left in their worktrees: never the host's runs.
        NM_HOME: join(root, ".no-mistakes"),
        // The Claude SessionStart hook appends the lead's build variables here: never to the host session's file.
        CLAUDE_ENV_FILE: "",
        ...(options.now === undefined ? {} : { TOLI_NOW: options.now }),
        ...options.env,
    });
    const toli: Sandbox["toli"] = (args, options = {}) => {
        const proc = Bun.spawnSync([process.execPath, TOLI_BIN, ...args], {
            cwd: root,
            env: toliEnv(options),
            stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
            stdout: "pipe",
            stderr: "pipe",
        });
        return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    };
    const toliAsync: Sandbox["toliAsync"] = async (args, options = {}) => {
        const proc = Bun.spawn([process.execPath, TOLI_BIN, ...args], {
            cwd: root,
            env: toliEnv(options),
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        return { code, stdout, stderr };
    };
    return {
        root,
        stubs,
        toli,
        toliAsync,
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

/** A `sudo` stub with cached credentials: `sudo -n <cmd>` runs `<cmd>` (as the test user); calls go to `.sudo`. */
export function withSudo(box: Sandbox): { calls: () => string[] } {
    const log = join(box.root, ".sudo");
    box.stub("sudo", `[ "$1" = "-n" ] && shift; printf '%s\\n' "$*" >> "${log}"; exec "$@"`);
    return { calls: () => (existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : []) };
}

export type LaunchctlOptions = {
    /** false: a session launchd cannot load agents into (`managername` Background): domain `print` and `bootstrap` exit 125. */
    gui?: boolean;
    /** `bootstrap` refuses (exit 5) any plist file containing this text, as launchd refuses a plist it cannot load. */
    rejects?: string;
};

/** A launchd domain in the stub: the user's gui domain or the system domain. */
export type LaunchctlDomain = "gui" | "system";

export type Launchctl = {
    /** Mark `label` loaded in `domain` (default gui), as if bootstrapped earlier. */
    load(label: string, domain?: LaunchctlDomain): void;
    loaded(label: string, domain?: LaunchctlDomain): boolean;
    /** Every call so far, one line each (`bootout gui/501/com.toli.lead`). */
    calls(): string[];
};

/**
 * A stateful `launchctl` stub: bootstrap marks a label loaded in its domain (failing when it already is, like the
 * real one), bootout unloads it, kickstart needs it loaded, service `print` succeeds only while loaded, and gui
 * domain `print` and `bootstrap` follow `options.gui` (the system domain works from any session). Every call is
 * appended to `.launchctl/log`.
 */
export function withLaunchctl(box: Sandbox, options: LaunchctlOptions = {}): Launchctl {
    const state = join(box.root, ".launchctl");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, ".rejects"), options.rejects ?? "");
    if (options.gui === false) writeFileSync(join(state, ".background"), "");
    const refuseDomain = `[ -f "$state/.background" ] && { echo "Domain does not support specified action" >&2; exit 125; }`;
    box.stub(
        "launchctl",
        `state="${state}"; echo "$*" >> "$state/log"
key() { case "$1" in system/*) echo "system.\${1##*/}" ;; *) echo "\${1##*/}" ;; esac; }
case "$1" in
    managername) if [ -f "$state/.background" ]; then echo Background; else echo Aqua; fi ;;
    print)
        case "$2" in
            gui/*/*|system/*) [ -f "$state/$(key "$2")" ] || exit 113; printf 'state = running\\npid = 4242\\nlast exit code = 0\\n' ;;
            system) echo "domain = system" ;;
            *) ${refuseDomain}; echo "domain = $2" ;;
        esac ;;
    bootstrap)
        label="$(basename "$3" .plist)"
        if [ "$2" = system ]; then key="system.$label"; else ${refuseDomain}; key="$label"; fi
        [ -f "$state/$key" ] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }
        [ -s "$state/.rejects" ] && grep -qF -f "$state/.rejects" "$3" && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }
        touch "$state/$key" ;;
    bootout) key="$(key "$2")"; [ -f "$state/$key" ] || exit 3; rm -f "$state/$key" ;;
    kickstart) key="$(key "$3")"; [ -f "$state/$key" ] || exit 113 ;;
    *) exit 2 ;;
esac`,
    );
    const file = (label: string, domain: LaunchctlDomain): string =>
        join(state, domain === "system" ? `system.${label}` : label);
    return {
        load: (label, domain = "gui") => writeFileSync(file(label, domain), ""),
        loaded: (label, domain = "gui") => existsSync(file(label, domain)),
        calls: () =>
            existsSync(join(state, "log")) ? readFileSync(join(state, "log"), "utf8").trimEnd().split("\n") : [],
    };
}

/** The bare seed origin withProject copies, built once per run. */
let seedOrigin: string | null = null;

/**
 * A bare "origin" repo with one commit on main, plus `projects/<name>` registered via `toli project add`. The origin
 * is a copy of one seed repo built on the first call: building it costs five git processes, which add up to seconds
 * per test on a loaded machine, and a copy spawns nothing. Each copy is its own repo, so pushes stay per test.
 */
export function withProject(box: Sandbox, name: string): string {
    if (seedOrigin === null) {
        const dir = tempDir("seed-origin");
        const bare = join(dir, "origin.git");
        const seed = join(dir, "seed");
        mkdirSync(bare);
        mkdirSync(seed);
        box.git(bare, ["init", "--bare", "--initial-branch=main"]);
        box.git(seed, ["init", "--initial-branch=main"]);
        writeFileSync(join(seed, "README"), "seed\n");
        box.git(seed, ["add", "README"]);
        box.git(seed, ["commit", "-m", "seed"]);
        box.git(seed, ["push", bare, "main"]);
        seedOrigin = bare;
    }
    const origin = join(box.root, ".origin", `${name}.git`);
    cpSync(seedOrigin, origin, { recursive: true });
    box.ok(["project", "add", name, origin]);
    return join(box.root, "projects", name);
}

/**
 * Run `fn` in this test process with `root` as TOLI_ROOT, the GIT_ENV identity and `extra` (e.g. TOLI_NOW) set;
 * returns what it wrote to stdout. Coverage sees only in-process code, never bin/toli subprocesses, so command
 * functions called this way count. The environment and stdout are restored even when `fn` throws.
 */
export function inProcess(root: string, fn: () => void, extra: Record<string, string> = {}): string {
    const env: Record<string, string> = { ...GIT_ENV, TOLI_ROOT: root, ...extra };
    const saved = Object.keys(env).map((key) => [key, process.env[key]] as const);
    Object.assign(process.env, env);
    const chunks: string[] = [];
    const write = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
    });
    try {
        fn();
    } finally {
        write.mockRestore();
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
    return chunks.join("");
}

/** A runner for one `bin/toli` command function under inProcess: each call returns that command's trimmed stdout. */
export function commandIn(
    root: string,
    command: (argv: string[]) => void,
    extra: Record<string, string> = {},
): (argv: string[]) => string {
    return (argv) => inProcess(root, () => command(argv), extra).trim();
}
