// Sardar's live-session hooks for omp.
//
// omp auto-discovers this file from <repo>/.omp/extensions when Malik starts
// `omp` inside toli. Only the main interactive session acts:
//   - session_start registers the live session (bin/toli session start), so the
//     OS ticker (bin/toli job tick) leaves due jobs to this session;
//   - every 60 s it asks bin/toli which jobs are due for this machine and, if
//     any are, starts `bin/toli job run-due` as a detached background process:
//     each job runs in its own headless omp, never inside Sardar's chat;
//   - on the same tick it takes new results (`bin/toli wake --json`: inbox
//     items such as worker job results and the weekly prune listing, and
//     local job results), each
//     exactly once, and pushes them into the chat: a new turn when Sardar is
//     idle, a follow-up when busy;
//   - session_shutdown unregisters the session so the OS ticker takes over.
// Headless runs (omp -p, used by the ticker and by toli remote) and subagent
// sessions load this file too; they must not claim jobs, take results, or the
// session lock, so everything is gated on an interactive TUI main session.
import { execFile, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// omp ships no installable type package; declare the surface this file uses.
type Timer = unknown;
type Context = {
    hasUI: boolean;
    isIdle(): boolean;
    setInterval(fn: () => unknown, ms: number): Timer;
    ui: { notify(message: string, level: "info" | "warning" | "error"): void };
};
type ExtensionAPI = {
    on(event: string, handler: (event: unknown, ctx: Context) => unknown): void;
    setLabel(label: string): void;
    sendUserMessage(content: string, options?: { deliverAs?: "followUp"; attribution?: "agent" | "user" }): unknown;
};

type DueJob = { name: string };
type Wake = { message: string };

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOLI_BIN = resolve(REPO_ROOT, "bin", "toli");
const TICK_MS = 60_000;
const CLI_TIMEOUT_MS = 20_000;

function runToli(args: string[]): Promise<string> {
    const { promise, resolve: resolvePromise, reject: rejectPromise } = Promise.withResolvers<string>();
    execFile(TOLI_BIN, args, { cwd: REPO_ROOT, timeout: CLI_TIMEOUT_MS }, (error, stdout, stderr) => {
        if (error) {
            const detail = stderr.trim() || error.message;
            rejectPromise(new Error(`bin/toli ${args.join(" ")}: ${detail}`));
            return;
        }
        resolvePromise(stdout);
    });
    return promise;
}

/** Start `bin/toli job run-due` detached: it outlives this session and logs to logs/tick.log. */
function startDueJobs(ctx: Context, names: string[]): void {
    const child = spawn(TOLI_BIN, ["job", "run-due"], { cwd: REPO_ROOT, detached: true, stdio: "ignore" });
    child.on("error", (error) => ctx.ui.notify(`Sardar could not start scheduled jobs: ${error.message}`, "warning"));
    child.unref();
    ctx.ui.notify(
        `Scheduled job${names.length === 1 ? "" : "s"} started in the background: ${names.join(", ")}`,
        "info",
    );
}

function isMainInteractiveSession(ctx: Context): boolean {
    // Observed on omp 18.13.2: ctx.mode and ctx.sessionModes are not yet set at
    // session_start, so they cannot be used. The TUI main session has hasUI
    // true on a TTY; its subagents and print runs (omp -p) have hasUI false.
    // ACP sessions (no-mistakes gate agents run `omp acp`) have hasUI true but
    // talk over pipes, and gate agents also carry NO_MISTAKES_GATE.
    return ctx.hasUI && process.stdout.isTTY === true && process.env.NO_MISTAKES_GATE === undefined;
}

export default function toliExtension(pi: ExtensionAPI): void {
    pi.setLabel("Toli scheduler");
    let registered = false;
    let ticking = false;

    async function tick(ctx: Context): Promise<void> {
        if (ticking) return;
        ticking = true;
        try {
            const due = JSON.parse(await runToli(["job", "due", "--json"])) as DueJob[];
            if (due.length > 0)
                startDueJobs(
                    ctx,
                    due.map((job) => job.name),
                );
            const wake = JSON.parse(await runToli(["wake", "--json"])) as Wake;
            if (wake.message !== "") {
                if (ctx.isIdle()) pi.sendUserMessage(wake.message, { attribution: "agent" });
                else pi.sendUserMessage(wake.message, { deliverAs: "followUp", attribution: "agent" });
            }
        } catch (error) {
            ctx.ui.notify(
                `Sardar background check failed: ${error instanceof Error ? error.message : String(error)}`,
                "warning",
            );
        } finally {
            ticking = false;
        }
    }

    pi.on("session_start", async (_event, ctx) => {
        if (!isMainInteractiveSession(ctx)) return;
        registered = true;
        await runToli(["session", "start", "--pid", String(process.pid)]);
        ctx.setInterval(() => tick(ctx), TICK_MS);
    });

    pi.on("session_shutdown", async () => {
        if (!registered) return;
        registered = false;
        await runToli(["session", "end", "--pid", String(process.pid)]);
    });
}
