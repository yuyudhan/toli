// The install-level setup checklist behind `bin/toli setup status`: one item per step, with a stable id, its state,
// who closes it, and the exact fix. Probes that touch the machine outside TOLI_ROOT are injectable for tests.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hasMachine, loadFleet, loadMachine, type Machine } from "../core/config.ts";
import { git } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { DEFAULT_PERSONA, persona } from "../core/persona.ts";
import { platform, shellQuote } from "../core/util.ts";
import {
    configuredHarnesses,
    defaultHarness,
    HARNESSES,
    type Harness,
    harnessLogin,
    harnessPath,
    SPECS,
} from "../harness/harness.ts";
import { syncShims } from "../harness/sync.ts";
import { CRON_TAG, plistPath, readCrontab, scheduleStatus } from "../jobs/schedule.ts";
import { loadProjects } from "../projects/projects.ts";

export const SETUP_ITEM_IDS = [
    "tools",
    "machine",
    "persona",
    "harness-sync",
    "harness-cli",
    "scheduler",
    "local",
    "git-hooks",
    "fleet",
    "project",
] as const;
export type SetupItemId = (typeof SETUP_ITEM_IDS)[number];

/** done: nothing to do. missing: counts as a remaining step. optional: offered once, never counted. */
export type SetupState = "done" | "missing" | "optional";

/**
 * Who closes the item. user: needs the user's answer or action (a login). lead-command: one `bin/toli` bookkeeping
 * command that writes only toli's own records. jawan: changes outside toli's records (installs, launchd/crontab,
 * git config, tracked files), so a jawan does it.
 */
export type SetupWho = "user" | "jawan" | "lead-command";

export type SetupItem = {
    id: SetupItemId;
    title: string;
    status: SetupState;
    who: SetupWho;
    detail: string;
    /** The exact command, or the question to ask the user followed by the command that records the answer. */
    fix: string;
};

export type HarnessReadiness = {
    /** The first harness found installed with a usable (or uncheckable) login. */
    ready: Harness | null;
    detail: string;
    /** Installed harnesses whose CLI reports no login. */
    loggedOut: Harness[];
};

/** Probes that touch the machine outside TOLI_ROOT; tests replace them. */
export type SetupProbe = {
    which(tool: string): string | null;
    harness(): HarnessReadiness;
    scheduler(): SchedulerFacts;
    hooksPath(): string | null;
};

/** Harnesses to try, the jawan default first, stopping at the first ready one so session start stays fast. */
function harnessOrder(): Harness[] {
    let preferred: Harness[] = [];
    try {
        preferred = [defaultHarness(), ...configuredHarnesses()];
    } catch {
        // An invalid harness block in config/machine.json is reported by `bin/toli doctor`; try every harness here.
    }
    return [...new Set([...preferred, ...HARNESSES])];
}

function liveHarnessReadiness(): HarnessReadiness {
    const loggedOut: Harness[] = [];
    for (const harness of harnessOrder()) {
        if (harnessPath(harness) === null) continue;
        const login = harnessLogin(harness);
        if (login.loggedIn === false) {
            loggedOut.push(harness);
            continue;
        }
        const state = login.loggedIn === null ? "login not checkable" : "logged in";
        return { ready: harness, detail: `${SPECS[harness].label} installed, ${state}: ${login.detail}`, loggedOut };
    }
    return {
        ready: null,
        detail:
            loggedOut.length > 0
                ? `installed but not logged in: ${loggedOut.map((harness) => SPECS[harness].label).join(", ")}`
                : `none of ${HARNESSES.join(", ")} is on PATH`,
        loggedOut,
    };
}

export type SchedulerFacts = {
    scheduler: string;
    installed: boolean;
    loaded: boolean;
    /** The `bin/toli` an installed tick runs when that is another toli checkout; null when it runs this one. */
    otherBin: string | null;
};

/** scheduleStatus plus whether the one per-machine tick runs this checkout (a second clone shares the label). */
function liveScheduler(): SchedulerFacts {
    const status = scheduleStatus();
    if (!status.installed) return { ...status, otherBin: null };
    const bin = paths.toliBin();
    const darwin = platform() === "darwin";
    const text = darwin
        ? readFileSync(plistPath(), "utf8")
        : readCrontab()
              .filter((line) => line.includes(CRON_TAG))
              .join("\n");
    if (text.includes(darwin ? `<string>${bin}</string>` : ` ${shellQuote(bin)} `))
        return { ...status, otherBin: null };
    return { ...status, otherBin: /[^\s<>'"]*\/bin\/toli(?=[\s<'"])/.exec(text)?.[0] ?? "another toli checkout" };
}

export function liveProbe(): SetupProbe {
    return {
        which: (tool) => Bun.which(tool, { PATH: process.env.PATH ?? "" }),
        harness: liveHarnessReadiness,
        scheduler: liveScheduler,
        hooksPath: () => {
            const result = git(paths.root(), ["config", "--get", "core.hooksPath"]);
            return result.code === 0 ? result.stdout.trim() : null;
        },
    };
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toolsItem(probe: SetupProbe): SetupItem {
    const gitPath = probe.which("git");
    return gitPath
        ? {
              id: "tools",
              title: "Bun and git",
              status: "done",
              who: "jawan",
              detail: `bun ${Bun.version}, git ${gitPath}`,
              fix: "",
          }
        : {
              id: "tools",
              title: "Bun and git",
              status: "missing",
              who: "jawan",
              detail: `bun ${Bun.version}; git is not on PATH`,
              fix: "install git (macOS: xcode-select --install; Debian/Ubuntu: sudo apt install git)",
          };
}

const MACHINE_FIX =
    "Question: what should this machine be called, and is it the coordinator (the machine you talk to) or a worker? Then: bin/toli init --name <machine> --role coordinator (a worker adds --coordinator-ssh <host> --coordinator-root <path>)";

function machineItem(): SetupItem {
    const base = { id: "machine" as const, title: "Machine config (config/machine.json)", who: "user" as const };
    if (!hasMachine()) return { ...base, status: "missing", detail: "config/machine.json missing", fix: MACHINE_FIX };
    try {
        const machine = loadMachine();
        return { ...base, status: "done", detail: `${machine.name} (${machine.role})`, fix: "" };
    } catch (error) {
        return { ...base, status: "missing", detail: message(error), fix: MACHINE_FIX };
    }
}

function personaItem(): SetupItem {
    const base = { id: "persona" as const, title: "Persona names (config/persona.json)", who: "user" as const };
    const defaults = `the user "${DEFAULT_PERSONA.user}", the lead ${DEFAULT_PERSONA.lead}, workers ${DEFAULT_PERSONA.workerPlural}`;
    const fix = `Question: keep the default names (${defaults}) or pick your own? Custom names go in config/persona.json: {"user": "...", "lead": "...", "leadPlural": "...", "worker": "...", "workerPlural": "..."}`;
    if (!existsSync(paths.persona()))
        return { ...base, status: "optional", detail: `defaults in use (${defaults})`, fix };
    try {
        const names = persona();
        return {
            ...base,
            status: "done",
            detail: `the user "${names.user}", the lead ${names.lead}, workers ${names.workerPlural}`,
            fix: "",
        };
    } catch (error) {
        return { ...base, status: "missing", detail: message(error), fix };
    }
}

function harnessSyncItem(): SetupItem {
    const base = { id: "harness-sync" as const, title: "Harness shims in sync", who: "jawan" as const };
    const drift = syncShims(paths.root(), true).filter((result) => result.state !== "ok");
    return drift.length === 0
        ? { ...base, status: "done", detail: "CLAUDE.md, .claude, .agents, .cursor, .pi in sync", fix: "" }
        : {
              ...base,
              status: "missing",
              detail: `out of date: ${drift.map((result) => `${result.path} (${result.state})`).join(", ")}`,
              fix: "bin/toli harness sync",
          };
}

function harnessCliItem(probe: SetupProbe): SetupItem {
    const base = { id: "harness-cli" as const, title: "A harness CLI installed and logged in" };
    const readiness = probe.harness();
    if (readiness.ready !== null) return { ...base, status: "done", who: "jawan", detail: readiness.detail, fix: "" };
    const first = readiness.loggedOut[0];
    if (first !== undefined)
        return {
            ...base,
            status: "missing",
            who: "user",
            detail: readiness.detail,
            fix: `log in yourself (it may open a browser): ${SPECS[first].login}`,
        };
    return {
        ...base,
        status: "missing",
        who: "jawan",
        detail: readiness.detail,
        fix: `install one (the default jawan harness is omp: ${SPECS.omp.install}), then the user logs in (docs/harnesses.md)`,
    };
}

function schedulerItem(probe: SetupProbe): SetupItem {
    const base = {
        id: "scheduler" as const,
        title: "Scheduler tick (bin/toli job tick every minute)",
        who: "jawan" as const,
    };
    const status = probe.scheduler();
    if (status.otherBin !== null)
        return {
            ...base,
            status: "missing",
            who: "user",
            detail: `${status.scheduler} tick runs ${status.otherBin}, not this checkout`,
            fix: `Question: move this machine's tick from ${status.otherBin} to this checkout? Then: bin/toli schedule install`,
        };
    return status.installed && status.loaded
        ? { ...base, status: "done", detail: `${status.scheduler} installed and loaded`, fix: "" }
        : {
              ...base,
              status: "missing",
              detail: `${status.scheduler} ${status.installed ? "installed" : "not installed"}, ${status.loaded ? "loaded" : "not loaded"}`,
              fix: "bin/toli schedule install",
          };
}

function localItem(): SetupItem {
    const base = { id: "local" as const, title: "Private helpers dir (local/) seeded", who: "lead-command" as const };
    const wanted = [
        paths.localScriptsDir(),
        paths.localHooksDir(),
        paths.helpersConfig(),
        join(paths.localDir(), "README.md"),
    ];
    const absent = wanted.filter((path) => !existsSync(path));
    return absent.length === 0
        ? { ...base, status: "done", detail: "local/scripts, local/hooks, helpers.json, README.md present", fix: "" }
        : {
              ...base,
              status: "missing",
              detail: `absent: ${absent.map((path) => path.slice(paths.root().length + 1)).join(", ")}`,
              fix: "bin/toli setup seed-local",
          };
}

function gitHooksItem(probe: SetupProbe): SetupItem {
    const base = { id: "git-hooks" as const, title: "Git hooks (core.hooksPath)", who: "jawan" as const };
    const hooksDir = join(paths.root(), ".githooks");
    if (!existsSync(hooksDir) || !statSync(hooksDir).isDirectory())
        return { ...base, status: "done", detail: "this checkout has no .githooks; nothing to install", fix: "" };
    const current = probe.hooksPath();
    return current === ".githooks"
        ? { ...base, status: "done", detail: "core.hooksPath = .githooks", fix: "" }
        : {
              ...base,
              status: "missing",
              detail: current === null ? "core.hooksPath unset" : `core.hooksPath = ${current}`,
              fix: "git config core.hooksPath .githooks (from toli's root; same as `bun run hooks`)",
          };
}

function fleetItem(): SetupItem {
    const base = { id: "fleet" as const, title: "Fleet: other machines / coordinator", who: "user" as const };
    const fleetFix =
        "Question: is toli also cloned on other machines? Add each one to config/fleet.json as {name, ssh, root} (skill toli-sync)";
    let machine: Machine;
    try {
        machine = loadMachine();
    } catch {
        return { ...base, status: "optional", detail: "set up the machine first", fix: fleetFix };
    }
    if (machine.role === "worker")
        return machine.coordinator
            ? {
                  ...base,
                  status: "done",
                  detail: `worker of ${machine.coordinator.ssh}:${machine.coordinator.root}`,
                  fix: "",
              }
            : {
                  ...base,
                  status: "missing",
                  detail: "a worker without a coordinator",
                  fix: "Question: which ssh host and toli path is the coordinator? Then: bin/toli init --name <machine> --role worker --coordinator-ssh <host> --coordinator-root <path>",
              };
    const others = loadFleet().machines.filter((entry) => entry.name !== machine.name);
    return others.length > 0
        ? { ...base, status: "done", detail: `fleet: ${others.map((entry) => entry.name).join(", ")}`, fix: "" }
        : { ...base, status: "optional", detail: "single machine (no others in config/fleet.json)", fix: fleetFix };
}

const PROJECT_NAMES_SHOWN = 3;

function projectItem(): SetupItem {
    const base = { id: "project" as const, title: "At least one project registered", who: "user" as const };
    const projects = loadProjects();
    return projects.length > 0
        ? {
              ...base,
              status: "done",
              detail: `${projects.length} registered: ${projects
                  .slice(0, PROJECT_NAMES_SHOWN)
                  .map((project) => project.name)
                  .join(", ")}${projects.length > PROJECT_NAMES_SHOWN ? ", ..." : ""}`,
              fix: "",
          }
        : {
              ...base,
              status: "missing",
              detail: "data/projects.json lists no project",
              fix: "Question: which repository should toli work on first (name and git URL)? Then: /add-project <name> <git-url> (skill toli-projects)",
          };
}

function guarded(id: SetupItemId, title: string, build: () => SetupItem): SetupItem {
    try {
        return build();
    } catch (error) {
        return {
            id,
            title,
            status: "missing",
            who: "jawan",
            detail: `check failed: ${message(error)}`,
            fix: "bin/toli doctor",
        };
    }
}

/** Every install-level setup item, in the order setup should close them. */
export function setupChecklist(probe: SetupProbe = liveProbe()): SetupItem[] {
    return [
        guarded("tools", "Bun and git", () => toolsItem(probe)),
        guarded("machine", "Machine config", machineItem),
        guarded("persona", "Persona names", personaItem),
        guarded("harness-sync", "Harness shims in sync", harnessSyncItem),
        guarded("harness-cli", "A harness CLI installed and logged in", () => harnessCliItem(probe)),
        guarded("scheduler", "Scheduler tick", () => schedulerItem(probe)),
        guarded("local", "Private helpers dir", localItem),
        guarded("git-hooks", "Git hooks", () => gitHooksItem(probe)),
        guarded("fleet", "Fleet", fleetItem),
        guarded("project", "First project", projectItem),
    ];
}

export function pendingIds(items: SetupItem[]): SetupItemId[] {
    return items
        .filter((item) => item.status === "missing")
        .map((item) => item.id)
        .sort();
}
