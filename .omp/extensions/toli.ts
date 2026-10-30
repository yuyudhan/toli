// The lead's live-session hooks for omp.
//
// omp auto-discovers this file from <repo>/.omp/extensions when the user starts
// `omp` inside toli. Only the main interactive session (the lead) acts:
//   - session_start registers the live session (bin/toli session start), so the
//     OS ticker (bin/toli job tick) leaves due jobs to this session, and takes
//     the told-once setup notice (`bin/toli setup notice --json`): shown to
//     the user as a notification and handed to the lead on the first turn only;
//   - every turn (before_agent_start) it appends the lead guidance
//     (`bin/toli guidance`: delegate everything, reply short, never wait, use
//     bin/toli and the skills) to the system prompt for that turn only;
//   - every tool call goes through the lead guard (src/harness/lead-guard.ts): the lead
//     may write only toli's records (data/, state/, config/) and may not read
//     projects/; bash (bin/toli bookkeeping) is never blocked;
//   - every 60 s it asks bin/toli which jobs are due for this machine and, if
//     any are, starts `bin/toli job run-due` as a detached background process:
//     each job runs in its own headless omp, never inside the lead's chat;
//   - on the same tick it takes new results (`bin/toli wake --json`: inbox
//     items such as finished `bin/toli spawn` jawans, worker job results and the
//     weekly prune listing, and local job results), each exactly once, and
//     pushes them into the chat: a new turn when idle, a follow-up when busy;
//   - a failing bin/toli (e.g. a broken checkout) is reported once per distinct
//     error with a pointer to `bin/toli doctor` (src/harness/cli-health.ts); the tick
//     keeps retrying quietly, re-registers the session if that failed, and
//     recovers silently once the CLI works again;
//   - session_shutdown unregisters the session so the OS ticker takes over.
// Headless runs (omp -p: the ticker, toli remote, spawned jawans) and subagent
// sessions load this file too; they must not claim jobs, take results, get the
// lead guidance or the guard, so everything is gated on the main TUI session.
import { execFile, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliHealth } from "../../src/harness/cli-health.ts";
import { guardDecision, isBrief, jawanEnv, ompAction } from "../../src/harness/lead-guard.ts";

// omp ships no installable type package; declare the surface this file uses.
type Timer = unknown;
type Context = {
    hasUI: boolean;
    cwd: string;
    /** The agent this session runs; subagents (task, advisor) report kind "sub". */
    agent?: { kind: string };
    isIdle(): boolean;
    setInterval(fn: () => unknown, ms: number): Timer;
    ui: { notify(message: string, level: "info" | "warning" | "error"): void };
};
type BeforeAgentStartEvent = { prompt: string; systemPrompt: string[] };
type ToolCallEvent = { toolName: string; input: Record<string, unknown> };
type ExtensionAPI = {
    on(
        event: "before_agent_start",
        handler: (event: BeforeAgentStartEvent, ctx: Context) => { systemPrompt: string[] } | undefined,
    ): void;
    on(
        event: "tool_call",
        handler: (event: ToolCallEvent, ctx: Context) => { block: true; reason: string } | undefined,
    ): void;
    on(event: string, handler: (event: unknown, ctx: Context) => unknown): void;
    setLabel(label: string): void;
    sendUserMessage(content: string, options?: { deliverAs?: "followUp"; attribution?: "agent" | "user" }): unknown;
};

type DueJob = { name: string };
type Wake = { message: string };
type SetupNotice = { notice: string; context: string };

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
    child.on("error", (error) => ctx.ui.notify(`toli could not start scheduled jobs: ${error.message}`, "warning"));
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
    // talk over pipes, and gate agents also carry NO_MISTAKES_GATE. Spawned
    // jawans carry TOLI_ROLE=jawan. Per-call contexts also name their agent.
    return (
        ctx.hasUI &&
        process.stdout.isTTY === true &&
        !jawanEnv(process.env) &&
        (ctx.agent === undefined || ctx.agent.kind === "main")
    );
}

export default function toliExtension(pi: ExtensionAPI): void {
    pi.setLabel("toli lead");
    // Set once `bin/toli session start` succeeded (retried by the tick until it does).
    let registered = false;
    let ticking = false;
    let guidance = "";
    // A brief pasted as the first prompt makes this interactive session a jawan: no guidance, no guard.
    let briefed = false;
    let prompted = false;
    // The told-once setup notice for the lead's first turn; "" when nothing is due.
    let setupContext = "";

    const health = new CliHealth();

    /** Run CLI work; a failure is shown once per distinct error, a success clears it silently. */
    async function guarded(ctx: Context, work: () => Promise<void>): Promise<void> {
        try {
            await work();
            health.succeeded();
        } catch (error) {
            const notice = health.failed(error);
            if (notice !== null) ctx.ui.notify(notice, "warning");
        }
    }

    async function register(): Promise<void> {
        await runToli(["session", "start", "--pid", String(process.pid)]);
        registered = true;
    }

    async function tick(ctx: Context): Promise<void> {
        if (ticking) return;
        ticking = true;
        try {
            await guarded(ctx, async () => {
                if (!registered) await register();
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
                guidance = (await runToli(["guidance"])).trim();
            });
        } finally {
            ticking = false;
        }
    }

    pi.on("session_start", async (_event, ctx) => {
        if (!isMainInteractiveSession(ctx)) return;
        await guarded(ctx, async () => {
            await register();
            guidance = (await runToli(["guidance"])).trim();
            const setup = JSON.parse(await runToli(["setup", "notice", "--json"])) as SetupNotice;
            if (setup.notice !== "") {
                ctx.ui.notify(setup.notice, "info");
                setupContext = setup.context;
            }
        });
        ctx.setInterval(() => tick(ctx), TICK_MS);
    });

    pi.on("before_agent_start", (event, ctx) => {
        if (!prompted) {
            prompted = true;
            briefed = isBrief(event.prompt);
        }
        if (briefed || guidance === "" || !isMainInteractiveSession(ctx)) return undefined;
        const extra = setupContext === "" ? [guidance] : [guidance, setupContext];
        setupContext = "";
        return { systemPrompt: [...event.systemPrompt, ...extra] };
    });

    pi.on("tool_call", (event, ctx) => {
        if (!isMainInteractiveSession(ctx)) return undefined;
        const decision = guardDecision(
            { root: REPO_ROOT, cwd: ctx.cwd, jawan: briefed },
            ompAction(event.toolName, event.input),
        );
        return decision.allow ? undefined : { block: true, reason: decision.reason };
    });

    pi.on("session_shutdown", async () => {
        if (!registered) return;
        registered = false;
        await runToli(["session", "end", "--pid", String(process.pid)]);
    });
}
