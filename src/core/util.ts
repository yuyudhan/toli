import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** A user-facing failure: printed as `toli: <message>` and exits non-zero. */
export class ToliError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ToliError";
    }
}

/** Set once the reader of stdout is gone (`toli digest | head -3`): later output is dropped, the command still finishes. */
let stdoutClosed = false;
let stdoutWatched = false;

/** A failed stdout write: a broken pipe closes stdout for the rest of the run; anything else is a real error. */
function stdoutFailed(error: unknown): void {
    if ((error as NodeJS.ErrnoException | null)?.code !== "EPIPE") throw error;
    stdoutClosed = true;
}

/** CLI output: one line (or block) to stdout. A closed pipe is not an error: the reader has all it wanted. */
export function out(text: string): void {
    if (stdoutClosed) return;
    if (!stdoutWatched) {
        stdoutWatched = true;
        // Asynchronous write failures arrive as an 'error' event; without a listener they crash the process.
        process.stdout.on("error", stdoutFailed);
    }
    try {
        process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    } catch (error) {
        stdoutFailed(error);
    }
}

/** Diagnostics: one line to stderr. */
export function warn(text: string): void {
    process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
}

export function printJson(value: unknown): void {
    out(JSON.stringify(value, null, 4));
}

/** Current time; `TOLI_NOW` (any Date-parsable string) pins it for tests. */
export function now(): Date {
    const pinned = process.env.TOLI_NOW;
    if (pinned) {
        const date = new Date(pinned);
        if (Number.isNaN(date.getTime())) throw new ToliError(`TOLI_NOW is not a date: ${pinned}`);
        return date;
    }
    return new Date();
}

/** Sortable, filename-safe UTC timestamp with millisecond precision: 2026-10-29T13-27-00-189Z. */
export function stamp(date: Date = now()): string {
    return date.toISOString().replace(/[:.]/g, "-");
}

export function readJson<T>(path: string, fallback: T): T {
    if (!existsSync(path)) return fallback;
    const text = readFileSync(path, "utf8");
    try {
        return JSON.parse(text) as T;
    } catch (error) {
        throw new ToliError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** The one shared guard for hand-validated JSON config: a plain object (not null, not an array). */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Write via temp file + rename so readers never observe a half-written file. */
export function writeJsonAtomic(path: string, value: unknown): void {
    writeTextAtomic(path, `${JSON.stringify(value, null, 4)}\n`);
}

export function writeTextAtomic(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(temp, text);
    renameSync(temp, path);
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

/** Serialize read-modify-write cycles across concurrent toli processes (e.g. overlapping cron ticks). */
export function withLock<T>(lockPath: string, fn: () => T): T {
    mkdirSync(dirname(lockPath), { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        try {
            closeSync(openSync(lockPath, "wx"));
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            try {
                if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) rmSync(lockPath, { force: true });
            } catch {
                // The holder released the lock between our open and stat; retry.
            }
            if (Date.now() > deadline) throw new ToliError(`timed out waiting for lock ${lockPath}`);
            Bun.sleepSync(25);
        }
    }
    try {
        return fn();
    } finally {
        rmSync(lockPath, { force: true });
    }
}

/** Quote one word for a POSIX shell. */
export function shellQuote(word: string): string {
    if (/^[A-Za-z0-9_./:=@%+-]+$/.test(word)) return word;
    return `'${word.replace(/'/g, `'\\''`)}'`;
}

export type RunResult = { code: number; stdout: string; stderr: string };

export type RunOptions = { cwd?: string; stdin?: string; timeoutMs?: number; env?: Record<string, string | undefined> };

/** Run a program synchronously; a missing binary is reported as exit 127, never thrown. */
export function run(cmd: string[], options: RunOptions = {}): RunResult {
    const program = cmd[0];
    if (program === undefined) throw new Error("run: empty command");
    const resolved = program.includes("/") ? program : Bun.which(program, { PATH: process.env.PATH ?? "" });
    if (!resolved) return { code: 127, stdout: "", stderr: `${program}: command not found` };
    const proc = Bun.spawnSync([resolved, ...cmd.slice(1)], {
        cwd: options.cwd ?? process.cwd(),
        env: { ...process.env, ...options.env },
        stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
        stdout: "pipe",
        stderr: "pipe",
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    });
    return {
        code: proc.exitCode ?? 1,
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
    };
}

/** Run a program asynchronously with stdout and stderr captured into one interleaved stream. */
export async function runCombined(cmd: string[], options: RunOptions = {}): Promise<{ code: number; output: string }> {
    const program = cmd[0];
    if (program === undefined) throw new Error("runCombined: empty command");
    const resolved = program.includes("/") ? program : Bun.which(program, { PATH: process.env.PATH ?? "" });
    if (!resolved) return { code: 127, output: `${program}: command not found\n` };
    const chunks: string[] = [];
    const proc = Bun.spawn([resolved, ...cmd.slice(1)], {
        cwd: options.cwd ?? process.cwd(),
        env: { ...process.env, ...options.env },
        stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
        stdout: "pipe",
        stderr: "pipe",
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    });
    const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) chunks.push(decoder.decode(chunk, { stream: true }));
        chunks.push(decoder.decode());
    };
    await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
    const code = await proc.exited;
    return { code, output: chunks.join("") };
}

export type AsyncRunResult = RunResult & { timedOut: boolean };

/** Run a program asynchronously, capturing stdout and stderr separately; on timeout the process is killed. */
export async function runAsync(cmd: string[], options: RunOptions = {}): Promise<AsyncRunResult> {
    const program = cmd[0];
    if (program === undefined) throw new Error("runAsync: empty command");
    const resolved = program.includes("/") ? program : Bun.which(program, { PATH: process.env.PATH ?? "" });
    if (!resolved) return { code: 127, stdout: "", stderr: `${program}: command not found`, timedOut: false };
    const proc = Bun.spawn([resolved, ...cmd.slice(1)], {
        cwd: options.cwd ?? process.cwd(),
        env: { ...process.env, ...options.env },
        stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
        stdout: "pipe",
        stderr: "pipe",
    });
    let timedOut = false;
    const timer =
        options.timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                  timedOut = true;
                  proc.kill("SIGKILL");
              }, options.timeoutMs);
    try {
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        return { code, stdout, stderr, timedOut };
    } finally {
        clearTimeout(timer);
    }
}

/** Run a program with this process's stdout/stderr, so its output streams live; resolves to its exit code. */
export async function runInherit(cmd: string[], options: RunOptions = {}): Promise<number> {
    const program = cmd[0];
    if (program === undefined) throw new Error("runInherit: empty command");
    const resolved = program.includes("/") ? program : Bun.which(program, { PATH: process.env.PATH ?? "" });
    if (!resolved) {
        warn(`${program}: command not found`);
        return 127;
    }
    const proc = Bun.spawn([resolved, ...cmd.slice(1)], {
        cwd: options.cwd ?? process.cwd(),
        env: { ...process.env, ...options.env },
        stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
        stdout: "inherit",
        stderr: "inherit",
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    });
    return await proc.exited;
}

/** Whether a process with this pid exists (EPERM: it exists but belongs to someone else). */
export function pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** `TOLI_PLATFORM` lets tests exercise either platform's behaviour on any host. */
export function platform(): string {
    return process.env.TOLI_PLATFORM ?? process.platform;
}

/** Body text piped on stdin; an interactive terminal yields "" instead of blocking. */
export function readStdin(): string {
    if (process.stdin.isTTY) return "";
    try {
        return readFileSync(0, "utf8");
    } catch {
        return "";
    }
}

export function isValidName(name: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

export function requireName(kind: string, name: string | undefined): string {
    if (name === undefined || name === "") throw new ToliError(`missing ${kind} name`);
    if (!isValidName(name)) throw new ToliError(`invalid ${kind} name "${name}" (letters, digits, . _ - only)`);
    return name;
}
