// The user's login environment for the harnesses toli starts (docs/harnesses.md "Service environment"). A launchd
// agent, systemd user service or crontab line starts toli with little more than PATH, so a provider key exported in
// the shell profile (e.g. ANTHROPIC_API_KEY) is missing there. Before a harness starts, toli runs the user's login
// shell once (`<shell> -i -l -c`, the same files an ssh login reads), reads its environment over a pipe and adds the
// variables this process lacks. Values stay in memory: nothing is written to a service file, log or disk.
import { randomBytes } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { platform, run, shellQuote, warn } from "./util.ts";

/**
 * `1` once a process holds the login environment (its children inherit it and skip the capture); `off` turns the
 * capture off (tests).
 */
export const LOGIN_ENV_FLAG = "TOLI_LOGIN_ENV";
const MARK_ENV = "TOLI_LOGIN_ENV_MARK";
const CAPTURE_TIMEOUT_MS = 15_000;
/** The shell's own bookkeeping, never adopted. */
const SHELL_ONLY = new Set(["PWD", "OLDPWD", "SHLVL", "_", MARK_ENV, LOGIN_ENV_FLAG]);

/** The shell the user database names for this user (cron sets SHELL=/bin/sh whatever it is); null when unknown. */
function passwdShell(): string | null {
    const user = userInfo().username;
    if (platform() === "darwin") {
        const result = run(["dscl", ".", "-read", `/Users/${user}`, "UserShell"], { timeoutMs: 5_000 });
        const match = /^UserShell:\s*(\S+)/m.exec(result.stdout);
        return result.code === 0 && match?.[1] ? match[1] : null;
    }
    const result = run(["getent", "passwd", user], { timeoutMs: 5_000 });
    const shell = result.stdout.trim().split(":")[6];
    return result.code === 0 && shell ? shell : null;
}

/** The user's login shell: `$SHELL`, unless it is cron's /bin/sh, then the user database, then /bin/sh. */
export function loginShell(env: Record<string, string | undefined> = process.env): string {
    const shell = env.SHELL;
    if (shell && shell !== "/bin/sh") return shell;
    return passwdShell() ?? shell ?? "/bin/sh";
}

export type LoginCapture = { shell: string; env: Record<string, string> } | { shell: string; error: string };

/**
 * The environment the user's login shell builds when started from `base`. Profile output is ignored: the env comes
 * between two random markers. Errors never quote the shell's output, which may hold secrets.
 */
export function captureLoginEnv(base: Record<string, string | undefined>): LoginCapture {
    const shell = loginShell(base);
    const mark = `toli-login-env-${randomBytes(12).toString("hex")}`;
    const script = `const m=process.env.${MARK_ENV};process.stdout.write(m+JSON.stringify(process.env)+m)`;
    const proc = Bun.spawnSync([shell, "-i", "-l", "-c", `${shellQuote(process.execPath)} -e ${shellQuote(script)}`], {
        cwd: base.HOME || homedir(),
        env: { ...base, [MARK_ENV]: mark },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeout: CAPTURE_TIMEOUT_MS,
    });
    if (proc.signalCode)
        return { shell, error: `stopped by ${proc.signalCode} (timeout ${CAPTURE_TIMEOUT_MS / 1000}s)` };
    const output = proc.stdout.toString();
    const start = output.indexOf(mark);
    const end = output.lastIndexOf(mark);
    if (start === -1 || end <= start)
        return { shell, error: `exited ${proc.exitCode} without printing its environment` };
    try {
        const parsed = JSON.parse(output.slice(start + mark.length, end)) as Record<string, unknown>;
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed))
            if (typeof value === "string" && !SHELL_ONLY.has(key)) env[key] = value;
        return { shell, env };
    } catch {
        return { shell, error: "printed an environment that is not JSON" };
    }
}

/**
 * Add each login variable `base` lacks (unset or empty) to `base`; returns the names added. What `base` already holds
 * wins, PATH included: a service keeps the PATH toli installed it with.
 */
export function mergeLoginEnv(base: Record<string, string | undefined>, login: Record<string, string>): string[] {
    const added: string[] = [];
    for (const [key, value] of Object.entries(login)) {
        if (SHELL_ONLY.has(key) || (base[key] ?? "") !== "") continue;
        base[key] = value;
        added.push(key);
    }
    return added;
}

/**
 * Before this process starts a harness: give it the login environment, once per process tree. A failed capture is
 * warned about (stderr, so the service's log) and the harness starts with the environment it has.
 */
export function adoptLoginEnv(): void {
    const flag = process.env[LOGIN_ENV_FLAG];
    if (flag === "1" || flag === "off") return;
    const capture = captureLoginEnv(process.env);
    process.env[LOGIN_ENV_FLAG] = "1";
    if ("error" in capture) warn(`login environment not loaded: ${capture.shell} -i -l ${capture.error}`);
    else mergeLoginEnv(process.env, capture.env);
}

/** Variable names that carry a harness's provider credential (values are never read here). */
export function credentialNames(env: Record<string, string | undefined>): string[] {
    return Object.keys(env)
        .filter((key) => /(_API_KEY|_AUTH_TOKEN|_OAUTH_TOKEN)$/.test(key) && (env[key] ?? "") !== "")
        .sort();
}
