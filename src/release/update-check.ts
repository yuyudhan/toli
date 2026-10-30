// toli checks for its own updates every 3 days (`bin/toli update check|status|snooze|off|on`). The minute tick
// (src/jobs/tick.ts) starts `bin/toli update check --due` as a detached process when a check is due, so neither the
// tick nor the digest ever waits on the network. The check runs `git ls-remote --tags` against the clone's origin
// (or TOLI_REPO_URL) with a short timeout, and for a newer stable vX.Y.Z fetches that one tag to read its
// CHANGELOG.md; the result goes to state/update-check.json. A network failure records only the attempt time, so
// the next tick an hour later tries again. The digest reads the state file and tells the user about a newer
// version once (never the same version twice). config/updates.json holds the user's settings: `check: false` stops
// every network call, `snoozed` lists versions never to mention. Nothing upgrades on its own: on the user's word
// the lead dispatches a jawan to run `bin/toli upgrade`.
import { spawn as spawnChild } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { Args } from "../core/args.ts";
import { git, isGitRepo } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import {
    isJsonObject,
    now,
    out,
    printJson,
    type RunResult,
    readJson,
    run,
    ToliError,
    withLock,
    writeJsonAtomic,
} from "../core/util.ts";
import { changelogBetween, compareVersions, latestTag, parseVersion, tagsFromLsRemote } from "./release.ts";
import { installedVersion, releaseRemote } from "./upgrade.ts";

const DAY_MS = 86_400_000;
/** A successful check is repeated after this many days. */
export const CHECK_INTERVAL_DAYS = 3;
/** After a failed attempt (offline), the tick waits this long before trying again. */
const RETRY_MS = 60 * 60 * 1000;
/** Each network git call (ls-remote, the tag fetch) is killed after this long. */
const NETWORK_TIMEOUT_MS = 20_000;

/** This checkout's CLI (not paths.toliBin(): TOLI_ROOT may point the data elsewhere, as in tests). */
const TOLI_SCRIPT = resolve(import.meta.dir, "..", "..", "bin", "toli");

/** state/update-check.json. */
export type UpdateState = {
    /** Last successful check (ISO time). */
    lastChecked?: string;
    /** Last attempt, successful or not; spaces out retries while offline. */
    lastAttempt?: string;
    /** The highest stable release tag at the last successful check, or null when the remote has none. */
    latest?: string | null;
    /** CHANGELOG.md sections after the installed version up to `latest`, read from the tag; only for a newer one. */
    changelog?: string;
    /** Versions the user has been told about. */
    notified?: string[];
};

/** config/updates.json. */
export type UpdateSettings = { check: boolean; snoozed: string[] };

const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

export function readUpdateState(): UpdateState {
    const raw: unknown = readJson<unknown>(paths.updateCheck(), {});
    if (!isJsonObject(raw)) return {};
    const state: UpdateState = { notified: strings(raw.notified) };
    if (typeof raw.lastChecked === "string") state.lastChecked = raw.lastChecked;
    if (typeof raw.lastAttempt === "string") state.lastAttempt = raw.lastAttempt;
    if (typeof raw.latest === "string" || raw.latest === null) state.latest = raw.latest;
    if (typeof raw.changelog === "string") state.changelog = raw.changelog;
    return state;
}

/** Read-modify-write state/update-check.json under a lock: the background check and the digest both write it. */
function updateState(change: (state: UpdateState) => UpdateState): void {
    withLock(paths.lock("update-check"), () => writeJsonAtomic(paths.updateCheck(), change(readUpdateState())));
}

export function readUpdateSettings(): UpdateSettings {
    const raw: unknown = readJson<unknown>(paths.updatesConfig(), {});
    if (!isJsonObject(raw)) return { check: true, snoozed: [] };
    return { check: raw.check !== false, snoozed: strings(raw.snoozed) };
}

function writeUpdateSettings(settings: UpdateSettings): void {
    writeJsonAtomic(paths.updatesConfig(), settings);
}

function timeOf(iso: string | undefined): number | null {
    if (iso === undefined) return null;
    const time = Date.parse(iso);
    return Number.isNaN(time) ? null : time;
}

/** When the next check is due: 3 days after the last success, and never within an hour of the last attempt. */
export function nextDue(state: UpdateState): number {
    const checked = timeOf(state.lastChecked);
    const attempt = timeOf(state.lastAttempt);
    return Math.max(
        checked === null ? 0 : checked + CHECK_INTERVAL_DAYS * DAY_MS,
        attempt === null ? 0 : attempt + RETRY_MS,
    );
}

export function checkDue(state: UpdateState, at: Date): boolean {
    return at.getTime() >= nextDue(state);
}

/** Whether release tag `latest` is newer than the installed package.json version (unparsable: never). */
export function isNewer(latest: string, installed: string): boolean {
    const to = parseVersion(latest);
    const from = parseVersion(installed);
    return to !== null && from !== null && compareVersions(to, from) > 0;
}

const NETWORK_ENV = { GIT_TERMINAL_PROMPT: "0" };

function networkGit(root: string, args: string[]): RunResult {
    return run(["git", "-C", root, ...args], { timeoutMs: NETWORK_TIMEOUT_MS, env: NETWORK_ENV });
}

function failure(result: RunResult): string {
    const detail = (result.stderr || result.stdout).trim().split("\n")[0] ?? "";
    return detail === "" ? `git exited ${result.code}` : detail;
}

/** The CHANGELOG.md sections between `installed` and `tag`, fetching that one tag; null when the fetch failed. */
function tagChangelog(root: string, remote: string, tag: string, installed: string): string | null {
    const shallow = git(root, ["rev-parse", "--is-shallow-repository"]).stdout.trim() === "true";
    const fetched = networkGit(root, [
        "fetch",
        "--quiet",
        "--no-tags",
        ...(shallow ? ["--depth", "1"] : []),
        remote,
        `+refs/tags/${tag}:refs/tags/${tag}`,
    ]);
    if (fetched.code !== 0) return null;
    const shown = git(root, ["show", `${tag}:CHANGELOG.md`]);
    return shown.code === 0 ? changelogBetween(shown.stdout, `v${installed}`, tag) : "";
}

export type CheckOutcome =
    | { ok: true; installed: string; latest: string | null; newer: boolean; notified: boolean }
    | { ok: false; remote: string; error: string; retryAt: string };

/**
 * One check against the release remote. Records the attempt first (so overlapping ticks never start a second
 * one); a network failure records nothing else and never throws.
 */
export function runUpdateCheck(at: Date = now()): CheckOutcome {
    const root = paths.root();
    const attempt = at.toISOString();
    updateState((state) => ({ ...state, lastAttempt: attempt }));
    const remote = releaseRemote(root);
    const offline = (error: string): CheckOutcome => ({
        ok: false,
        remote,
        error,
        retryAt: new Date(at.getTime() + RETRY_MS).toISOString(),
    });
    const listed = networkGit(root, ["ls-remote", "--tags", "--refs", remote]);
    if (listed.code !== 0) return offline(failure(listed));
    const latest = latestTag(tagsFromLsRemote(listed.stdout));
    const installed = installedVersion(root).version;
    const newer = latest !== null && isNewer(latest, installed);
    const previous = readUpdateState();
    let changelog: string | undefined;
    if (latest !== null && newer) {
        const known = previous.latest === latest ? previous.changelog : undefined;
        const fetched = known ?? tagChangelog(root, remote, latest, installed);
        if (fetched === null) return offline(`could not fetch ${latest}`);
        changelog = fetched;
    }
    updateState((state) => {
        const next: UpdateState = { ...state, lastChecked: attempt, latest };
        if (changelog === undefined) delete next.changelog;
        else next.changelog = changelog;
        return next;
    });
    return { ok: true, installed, latest, newer, notified: (previous.notified ?? []).includes(latest ?? "") };
}

/** The told-once lines for a newer release: what it is, what changed, and how to update this checkout. */
export function updateNoticeText(latest: string, installed: string, branch: string | null, changelog: string): string {
    const how =
        branch === null
            ? "Tell the user once; if they confirm, send a jawan to run `bin/toli upgrade` (it also runs migrate and harness sync) and report the result."
            : `Tell the user once; this checkout is a development clone on branch ${branch}, so if they confirm, a jawan updates it with git (merge or check out the ${latest} tag), not bin/toli upgrade.`;
    const lines = [
        `Update: toli ${latest} is out (installed ${installed}). ${how} Snooze this version: \`bin/toli update snooze ${latest}\`; stop checking: \`bin/toli update off\`.`,
    ];
    if (changelog.trim() !== "")
        lines.push("What changed:", ...changelog.split("\n").map((line) => (line === "" ? "" : `  ${line}`)));
    return lines.join("\n");
}

/**
 * The digest's told-once update notice: the newer release from the last check, unless the check is off, the
 * version is snoozed, or the user was already told. Marks the version told. Never touches the network.
 */
export function takeUpdateNotice(): string | null {
    const root = paths.root();
    const settings = readUpdateSettings();
    if (!isGitRepo(root) || !settings.check) return null;
    const state = readUpdateState();
    const latest = state.latest;
    if (typeof latest !== "string") return null;
    if ((state.notified ?? []).includes(latest) || settings.snoozed.includes(latest)) return null;
    const installed = installedVersion(root);
    if (!isNewer(latest, installed.version)) return null;
    updateState((current) => ({ ...current, notified: [...(current.notified ?? []), latest] }));
    return updateNoticeText(latest, installed.version, installed.branch, state.changelog ?? "");
}

/**
 * Called by the tick: start a due check as a detached `bin/toli update check --due` (output in
 * logs/update-check.log) and return at once. Null when no check is due, the check is off, or the root is not a
 * git checkout.
 */
export function startDueUpdateCheck(at: Date = now()): string | null {
    const root = paths.root();
    if (!isGitRepo(root) || !readUpdateSettings().check || !checkDue(readUpdateState(), at)) return null;
    mkdirSync(paths.logsDir(), { recursive: true });
    const log = openSync(paths.updateCheckLog(), "a");
    try {
        const child = spawnChild(process.execPath, [TOLI_SCRIPT, "update", "check", "--due"], {
            cwd: root,
            detached: true,
            stdio: ["ignore", log, log],
        });
        child.unref();
        return `update check: started in the background (pid ${child.pid ?? "unknown"}, log ${paths.updateCheckLog()})`;
    } finally {
        closeSync(log);
    }
}

function outcomeLine(outcome: CheckOutcome): string {
    if (!outcome.ok)
        return `update check: could not reach ${outcome.remote} (${outcome.error}); nothing recorded, the next tick after ${outcome.retryAt} tries again`;
    if (!outcome.newer)
        return `update check: toli is up to date (installed ${outcome.installed}, latest ${outcome.latest ?? "none"})`;
    return `update check: ${outcome.latest} is available (installed ${outcome.installed}); ${outcome.notified ? "the user was already told" : "the digest tells the user once"}`;
}

function checkCommand(argv: string[]): void {
    const args = new Args(argv, { booleans: ["due", "json"] });
    args.maxPositional(0);
    const due = args.bool("due");
    const at = now();
    if (!readUpdateSettings().check) {
        if (due) return;
        throw new ToliError("update checks are off (config/updates.json); turn them on with `bin/toli update on`");
    }
    if (!isGitRepo(paths.root())) {
        if (due) return;
        throw new ToliError(`${paths.root()} is not a git checkout; there is nothing to compare`);
    }
    if (due && !checkDue(readUpdateState(), at)) return;
    const outcome = runUpdateCheck(at);
    if (args.bool("json")) printJson(outcome);
    else out(due ? `${at.toISOString()} ${outcomeLine(outcome)}` : outcomeLine(outcome));
}

function statusCommand(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const settings = readUpdateSettings();
    const state = readUpdateState();
    const root = paths.root();
    const installed = isGitRepo(root) ? installedVersion(root) : null;
    const due = nextDue(state);
    const latest = state.latest ?? null;
    const status = {
        check: settings.check,
        installed: installed?.version ?? null,
        branch: installed?.branch ?? null,
        lastChecked: state.lastChecked ?? null,
        lastAttempt: state.lastAttempt ?? null,
        nextDue: settings.check ? new Date(due).toISOString() : null,
        latest,
        newer: latest !== null && installed !== null && isNewer(latest, installed.version),
        notified: state.notified ?? [],
        snoozed: settings.snoozed,
    };
    if (args.bool("json")) {
        printJson(status);
        return;
    }
    const list = (values: string[]): string => (values.length === 0 ? "none" : values.join(", "));
    out(
        [
            `update check: ${settings.check ? `on, every ${CHECK_INTERVAL_DAYS} days` : "off"} (config/updates.json)`,
            `installed: ${status.installed ?? "unknown (not a git checkout)"}${status.branch === null ? "" : ` (development clone on branch ${status.branch})`}`,
            `last checked: ${status.lastChecked ?? "never"}${status.lastAttempt !== status.lastChecked && status.lastAttempt !== null ? ` (last failed attempt ${status.lastAttempt})` : ""}`,
            `next check: ${status.nextDue === null ? "never (off)" : due <= now().getTime() ? "at the next tick" : status.nextDue}`,
            `latest: ${latest ?? "unknown"}${status.newer ? " (newer than installed)" : ""}`,
            `told: ${list(status.notified)}`,
            `snoozed: ${list(status.snoozed)}`,
        ].join("\n"),
    );
}

/** `bin/toli update check [--due] [--json] | status [--json] | snooze <vX.Y.Z> | off | on`. */
export function updateCommand(argv: string[]): void {
    const [sub, ...rest] = argv;
    switch (sub) {
        case "check":
            checkCommand(rest);
            return;
        case "status":
            statusCommand(rest);
            return;
        case "snooze": {
            const args = new Args(rest);
            args.maxPositional(1);
            const version = args.pos(0, "version");
            if (!version.startsWith("v") || parseVersion(version) === null)
                throw new ToliError(`"${version}" is not a release tag vX.Y.Z`);
            const settings = readUpdateSettings();
            if (!settings.snoozed.includes(version)) settings.snoozed.push(version);
            writeUpdateSettings(settings);
            out(`snoozed ${version}: the digest never mentions it; a later release is still shown`);
            return;
        }
        case "off":
        case "on": {
            new Args(rest).maxPositional(0);
            writeUpdateSettings({ ...readUpdateSettings(), check: sub === "on" });
            out(
                sub === "on"
                    ? `update check on: toli looks for a new release every ${CHECK_INTERVAL_DAYS} days`
                    : "update check off: no network checks and no update notices until `bin/toli update on`",
            );
            return;
        }
        default:
            throw new ToliError(
                "usage: toli update check [--due] [--json] | status [--json] | snooze <vX.Y.Z> | off | on",
            );
    }
}
