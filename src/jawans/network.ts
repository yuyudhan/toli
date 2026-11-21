// Network faults of jawan runs. A run whose harness gave up on the model API with a network-class error (EAI_AGAIN,
// ENOTFOUND, ECONNRESET: omp's `Retry budget exhausted after N retries: getaddrinfo EAI_AGAIN ...`) is requeued
// through the resume chain (src/jawans/continue.ts): the same omp session continues once the network is back, and a
// chain is requeued for a network fault at most once every NETWORK_REQUEUE_MINUTES. A name-resolution failure also
// records the model API host it hit (state/network-fault.json); while that host does not resolve, toli starts no jawan
// (src/jawans/launch.ts) and says so once in logs/network.log. The first start after it resolves again clears the record.
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { paths } from "../core/paths.ts";
import { now, readJson, withLock, writeJsonAtomic } from "../core/util.ts";
import type { Harness } from "../harness/harness.ts";
import { answerLines } from "./limits.ts";
import type { JawanRun } from "./runs.ts";

/** The resume reason of a run requeued after a network fault. */
export const NETWORK_REASON = "network fault";

/** A chain is requeued for a network fault at most once in this many minutes. */
export const NETWORK_REQUEUE_MINUTES = 10;

/** Only the last few lines of a failed attempt count: a fault the jawan met in its own work earlier never does. */
const FAULT_TAIL_LINES = 3;

/** Longest wait for one name lookup. */
const RESOLVE_TIMEOUT_MS = 5000;

/** Longest error line kept in a run's error and its continuation's prompt. */
const FAULT_LINE_CHARS = 240;

/** Network-class error codes; Bun's DNS errors prefix theirs with `DNS_`. */
const FAULT_CODE = /(?:\b|DNS_)(EAI_AGAIN|ENOTFOUND|ECONNRESET)\b/;

/** Codes that mean a name did not resolve, as opposed to a connection that broke. */
const RESOLUTION_CODES: readonly string[] = ["EAI_AGAIN", "ENOTFOUND"];

/** Where a network error names its host: right after the code, as a URL, or as a `hostname` field. */
const HOST_PATTERNS: readonly RegExp[] = [
    /\b(?:EAI_AGAIN|ENOTFOUND)\s+([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i,
    /\bhttps?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i,
    /\bhostname["']?\s*[:=]\s*["']?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i,
];

/** Model API hosts by provider, as a `provider/model` name or a model's own prefix names it. */
const PROVIDER_HOSTS: Record<string, string> = {
    anthropic: "api.anthropic.com",
    openai: "api.openai.com",
    google: "generativelanguage.googleapis.com",
    xai: "api.x.ai",
    openrouter: "openrouter.ai",
};

const MODEL_PROVIDERS: readonly [RegExp, string][] = [
    [/^claude/i, "anthropic"],
    [/^(?:gpt|o\d|codex)/i, "openai"],
    [/^gemini/i, "google"],
    [/^grok/i, "xai"],
];

/** The provider a harness talks to when its model does not say. */
const HARNESS_PROVIDERS: Partial<Record<Harness, string>> = { claude: "anthropic", codex: "openai", grok: "xai" };

export type NetworkFault = {
    code: string;
    /** The host the error names, or null. */
    host: string | null;
    /** The error line, shortened. */
    line: string;
};

/** The network fault a failed attempt ended on (a non-zero exit whose last lines name one), or null. */
export function networkFault(output: string, exitCode: number | null): NetworkFault | null {
    if (exitCode === 0) return null;
    for (const line of answerLines(output).slice(-FAULT_TAIL_LINES).reverse()) {
        const code = FAULT_CODE.exec(line)?.[1];
        if (code === undefined) continue;
        const host = HOST_PATTERNS.map((pattern) => pattern.exec(line)?.[1]).find((match) => match !== undefined);
        return {
            code,
            host: host?.toLowerCase() ?? null,
            line: line.length > FAULT_LINE_CHARS ? `${line.slice(0, FAULT_LINE_CHARS - 3)}...` : line,
        };
    }
    return null;
}

/** The model API host a run talks to, from its model (`provider/model` or a known prefix) or its harness; else null. */
export function modelApiHost(harness: Harness, model: string | null): string | null {
    const name = model ?? "";
    const slash = name.indexOf("/");
    const provider =
        (slash > 0 ? name.slice(0, slash).toLowerCase() : undefined) ??
        MODEL_PROVIDERS.find(([pattern]) => pattern.test(name))?.[1] ??
        HARNESS_PROVIDERS[harness];
    return provider === undefined ? null : (PROVIDER_HOSTS[provider] ?? null);
}

/** The error a run that ended on a network fault records. */
export function networkFaultError(fault: NetworkFault): string {
    return `network fault: ${fault.line}`;
}

/**
 * When the continuation of a run that ended on a network fault may start: a run that was itself requeued for one less
 * than NETWORK_REQUEUE_MINUTES ago waits out the rest; otherwise undefined (as soon as the network allows).
 */
export function networkRequeueAt(run: JawanRun, at: Date): string | undefined {
    if (run.resumeReason !== NETWORK_REASON) return undefined;
    const next = Date.parse(run.startedAt) + NETWORK_REQUEUE_MINUTES * 60_000;
    return next > at.getTime() ? new Date(next).toISOString() : undefined;
}

/** Whether a queued run may start now as far as its earliest start goes. */
export function startDue(run: { notBefore?: string | undefined }, at: Date): boolean {
    return run.notBefore === undefined || Date.parse(run.notBefore) <= at.getTime();
}

type FaultRecord = {
    host: string;
    code: string;
    since: string;
    /** When starts were first held for it: the one line was logged then. */
    held?: string;
};

const FAULT_LOCK = "network-fault";

function logLine(line: string, at: Date): void {
    mkdirSync(paths.logsDir(), { recursive: true });
    appendFileSync(paths.networkLog(), `${at.toISOString()} ${line}\n`);
}

/**
 * Record that a run failed to resolve the model API `host`, when the fault is a name-resolution one; a fault already
 * recorded for the same host keeps its start. Returns whether anything is recorded.
 */
export function recordNetworkFault(fault: NetworkFault, host: string | null, at: Date = now()): boolean {
    if (host === null || !RESOLUTION_CODES.includes(fault.code)) return false;
    withLock(paths.lock(FAULT_LOCK), () => {
        const known = readJson<FaultRecord | null>(paths.networkFault(), null);
        if (known?.host === host) return;
        writeJsonAtomic(paths.networkFault(), { host, code: fault.code, since: at.toISOString() });
    });
    return true;
}

/** Whether `host` resolves on this machine now, looked up in a child process so the caller stays synchronous. */
export function hostResolves(host: string): boolean {
    const lookup = Bun.spawnSync([process.execPath, "-e", "await Bun.dns.lookup(process.env.TOLI_RESOLVE_HOST)"], {
        env: { ...process.env, TOLI_RESOLVE_HOST: host },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        timeout: RESOLVE_TIMEOUT_MS,
    });
    return lookup.exitCode === 0;
}

/** Starts held for a model API host that does not resolve; `line` is set only for the one call that logged the hold. */
export type NetworkHold = { host: string; line: string | null };

/**
 * Whether jawan starts are held: a model API host a run failed to resolve still does not. The first hold logs one line
 * (returned for the caller to show too); once the host resolves the record is cleared and starts go ahead.
 */
export function networkHold(at: Date = now()): NetworkHold | null {
    const fault = readJson<FaultRecord | null>(paths.networkFault(), null);
    if (fault === null) return null;
    const resolves = hostResolves(fault.host);
    return withLock(paths.lock(FAULT_LOCK), (): NetworkHold | null => {
        const current = readJson<FaultRecord | null>(paths.networkFault(), null);
        if (current === null) return null;
        // Recorded for another host meanwhile: judge that one on the next start.
        if (current.host !== fault.host) return { host: current.host, line: null };
        if (resolves) {
            rmSync(paths.networkFault(), { force: true });
            if (current.held !== undefined)
                logLine(`${current.host} resolves again: jawan starts held since ${current.held} go ahead`, at);
            return null;
        }
        if (current.held !== undefined) return { host: current.host, line: null };
        const line = `jawan starts held: the model API host ${current.host} does not resolve (${current.code} since ${current.since}); queued runs start once it does, \`bin/toli spawn --now\` starts one anyway`;
        writeJsonAtomic(paths.networkFault(), { ...current, held: at.toISOString() });
        logLine(line, at);
        return { host: current.host, line };
    });
}

/** The model API host jawan starts are held for, as last judged by networkHold (no lookup), or null. */
export function heldHost(): string | null {
    const fault = readJson<FaultRecord | null>(paths.networkFault(), null);
    return fault?.held === undefined ? null : fault.host;
}
