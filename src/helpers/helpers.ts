import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Args } from "../core/args.ts";
import { paths } from "../core/paths.ts";
import { out, platform, printJson, run, runInherit, ToliError, writeTextAtomic } from "../core/util.ts";
import {
    dryRun,
    guiDomain,
    launchAgentsDir,
    loadLaunchAgent,
    mustRun,
    osScheduler,
    readCrontab,
    type Scheduler,
    systemctl,
    systemdUserDir,
    unloadLaunchAgent,
    writeCrontab,
} from "../jobs/os-scheduler.ts";
import { type Helper, loadHelpers, scheduleText } from "./registry.ts";
import {
    HELPER_CRON_PREFIX,
    HELPER_LABEL_PREFIX,
    HELPER_UNIT_PREFIX,
    helperCronTag,
    helperLabel,
    helperUnit,
    renderHelperCronLine,
    renderHelperPlist,
    renderHelperSystemd,
} from "./units.ts";

const USAGE =
    "usage: toli helper list [--json] | install <name>|--all | uninstall <name>|--all | run <name> | status [<name>] [--json]";

function helperPlistPath(name: string): string {
    return join(launchAgentsDir(), `${helperLabel(name)}.plist`);
}

function systemdFiles(name: string): { service: string; timer: string } {
    const base = join(systemdUserDir(), helperUnit(name));
    return { service: `${base}.service`, timer: `${base}.timer` };
}

function platformOk(helper: Helper): boolean {
    return helper.platforms === undefined || helper.platforms.includes(platform());
}

function installHelper(helper: Helper, scheduler: Scheduler): void {
    if (!existsSync(helper.exec)) throw new ToliError(`helper "${helper.name}": ${helper.exec} does not exist`);
    if (scheduler === "launchd") {
        const plist = renderHelperPlist(helper);
        const target = helperPlistPath(helper.name);
        if (dryRun()) {
            out(`# dry run: would write ${target}`);
            out(plist);
            out(`# would run: launchctl bootstrap ${guiDomain()} ${target} (after bootout if loaded)`);
            return;
        }
        mkdirSync(dirname(paths.helperLog(helper.name)), { recursive: true });
        loadLaunchAgent(helperLabel(helper.name), target, plist);
        out(`installed ${helper.name}: launchd ${helperLabel(helper.name)} (${scheduleText(helper.schedule)})`);
        return;
    }
    if (scheduler === "systemd") {
        const units = renderHelperSystemd(helper);
        const files = systemdFiles(helper.name);
        const unit = `${helperUnit(helper.name)}.${units.timer === null ? "service" : "timer"}`;
        if (dryRun()) {
            out(`# dry run: would write ${files.service}`);
            out(units.service);
            if (units.timer !== null) {
                out(`# dry run: would write ${files.timer}`);
                out(units.timer);
            }
            out(
                `# would run: systemctl --user daemon-reload && systemctl --user enable ${unit} && systemctl --user restart ${unit}`,
            );
            return;
        }
        mkdirSync(dirname(paths.helperLog(helper.name)), { recursive: true });
        writeTextAtomic(files.service, units.service);
        if (units.timer === null) rmSync(files.timer, { force: true });
        else writeTextAtomic(files.timer, units.timer);
        mustRun(systemctl("daemon-reload"));
        mustRun(systemctl("enable", unit));
        mustRun(systemctl("restart", unit));
        out(`installed ${helper.name}: systemd ${unit} (${scheduleText(helper.schedule)})`);
        return;
    }
    const line = renderHelperCronLine(helper);
    const tag = helperCronTag(helper.name);
    const lines = [...readCrontab().filter((entry) => !entry.endsWith(tag)), line];
    if (dryRun()) {
        out("# dry run: would install crontab:");
        out(lines.join("\n"));
        return;
    }
    mkdirSync(dirname(paths.helperLog(helper.name)), { recursive: true });
    writeCrontab(lines);
    out(`installed ${helper.name}: crontab line (${scheduleText(helper.schedule)})`);
}

/** Remove a helper's schedule whether or not it is still registered; returns whether anything was installed. */
function uninstallHelper(name: string, scheduler: Scheduler): boolean {
    if (scheduler === "launchd") {
        if (dryRun()) {
            out(`# dry run: would boot out ${guiDomain()}/${helperLabel(name)} and remove ${helperPlistPath(name)}`);
            return false;
        }
        return unloadLaunchAgent(helperLabel(name), helperPlistPath(name));
    }
    if (scheduler === "systemd") {
        const files = systemdFiles(name);
        const present = [files.timer, files.service].filter((file) => existsSync(file));
        if (dryRun()) {
            out(`# dry run: would disable --now and remove ${present.join(", ") || "(nothing installed)"}`);
            return false;
        }
        if (present.length === 0) return false;
        // Stop the timer before its service; a unit systemd no longer knows is not an error here.
        for (const file of present) run(systemctl("disable", "--now", file.slice(file.lastIndexOf("/") + 1)));
        for (const file of present) rmSync(file, { force: true });
        mustRun(systemctl("daemon-reload"));
        return true;
    }
    const tag = helperCronTag(name);
    const lines = readCrontab();
    const kept = lines.filter((entry) => !entry.endsWith(tag));
    if (dryRun()) {
        out("# dry run: would install crontab:");
        out(kept.join("\n"));
        return false;
    }
    if (kept.length === lines.length) return false;
    writeCrontab(kept);
    return true;
}

export type HelperState = {
    name: string;
    registered: boolean;
    enabled: boolean;
    /** Whether the helper's `platforms` include this machine. */
    platformOk: boolean;
    schedule: string;
    scheduler: Scheduler;
    installed: boolean;
    /** Known to the scheduler: a loaded launchd agent, an active systemd unit, or a crontab line. */
    loaded: boolean;
    /** A process is running right now (between runs, an interval helper is loaded but not running). */
    running: boolean;
    pid: number | null;
    lastExit: string | null;
    detail: string;
};

function probe(
    name: string,
    scheduler: Scheduler,
): Omit<HelperState, "name" | "registered" | "enabled" | "platformOk" | "schedule"> {
    if (scheduler === "launchd") {
        const target = helperPlistPath(name);
        const printed = run(["launchctl", "print", `${guiDomain()}/${helperLabel(name)}`]);
        const loaded = printed.code === 0;
        const field = (key: string): string | null =>
            loaded ? (new RegExp(`^\\s*${key} = (.+)$`, "m").exec(printed.stdout)?.[1]?.trim() ?? null) : null;
        const pid = field("pid");
        return {
            scheduler,
            installed: existsSync(target),
            loaded,
            running: field("state") === "running",
            pid: pid === null ? null : Number(pid),
            lastExit: field("last exit code"),
            detail: target,
        };
    }
    if (scheduler === "systemd") {
        const files = systemdFiles(name);
        const hasTimer = existsSync(files.timer);
        const unit = helperUnit(name);
        const active = (suffix: string): boolean =>
            run(systemctl("is-active", `${unit}.${suffix}`)).stdout.trim() === "active";
        const show = run(systemctl("show", `${unit}.service`, "--property=MainPID,ExecMainStatus"));
        const prop = (key: string): string | null => new RegExp(`^${key}=(.*)$`, "m").exec(show.stdout)?.[1] ?? null;
        const pid = Number(prop("MainPID") ?? "0");
        const running = active("service");
        return {
            scheduler,
            installed: existsSync(files.service),
            loaded: hasTimer ? active("timer") : running,
            running,
            pid: pid > 0 ? pid : null,
            lastExit: prop("ExecMainStatus"),
            detail: hasTimer ? files.timer : files.service,
        };
    }
    const line = readCrontab().find((entry) => entry.endsWith(helperCronTag(name)));
    return {
        scheduler,
        installed: line !== undefined,
        loaded: line !== undefined,
        running: false,
        pid: null,
        lastExit: null,
        detail: line ?? "no crontab line",
    };
}

/** Names of toli helpers installed in this machine's scheduler, registered or not. */
function installedNames(scheduler: Scheduler): string[] {
    const list = (dir: string, prefix: string, suffix: string): string[] =>
        existsSync(dir)
            ? readdirSync(dir)
                  .filter((file) => file.startsWith(prefix) && file.endsWith(suffix))
                  .map((file) => file.slice(prefix.length, -suffix.length))
            : [];
    if (scheduler === "launchd") return list(launchAgentsDir(), HELPER_LABEL_PREFIX, ".plist");
    if (scheduler === "systemd") return list(systemdUserDir(), HELPER_UNIT_PREFIX, ".service");
    return readCrontab().flatMap((entry) => {
        const at = entry.lastIndexOf(HELPER_CRON_PREFIX);
        return at === -1 ? [] : [entry.slice(at + HELPER_CRON_PREFIX.length)];
    });
}

export function helperStates(): HelperState[] {
    const scheduler = osScheduler();
    const helpers = loadHelpers();
    const registered = new Set(helpers.map((helper) => helper.name));
    const states: HelperState[] = helpers.map((helper) => ({
        name: helper.name,
        registered: true,
        enabled: helper.enabled,
        platformOk: platformOk(helper),
        schedule: scheduleText(helper.schedule),
        ...probe(helper.name, scheduler),
    }));
    for (const name of installedNames(scheduler)
        .filter((entry) => !registered.has(entry))
        .sort())
        states.push({
            name,
            registered: false,
            enabled: false,
            platformOk: true,
            schedule: "?",
            ...probe(name, scheduler),
        });
    return states;
}

function stateLine(state: HelperState): string {
    const flags = [
        state.registered ? null : "NOT REGISTERED (uninstall it or add it back to local/helpers.json)",
        state.enabled ? null : state.registered ? "disabled" : null,
        state.platformOk ? null : "other platform",
    ].filter((flag) => flag !== null);
    const install = state.installed ? (state.loaded ? "installed, loaded" : "installed, NOT loaded") : "not installed";
    const activity = state.running ? `running pid ${state.pid ?? "?"}` : "idle";
    const exit = state.lastExit === null ? "" : `, last exit ${state.lastExit}`;
    return `${state.name}\t${state.schedule}\t${state.scheduler}: ${install}${state.installed ? `, ${activity}${exit}` : ""}${flags.length > 0 ? `\t[${flags.join("; ")}]` : ""}`;
}

function findHelper(name: string): Helper {
    const helper = loadHelpers().find((entry) => entry.name === name);
    if (!helper) throw new ToliError(`no helper "${name}" in local/helpers.json`);
    return helper;
}

function installCommand(args: Args): void {
    const scheduler = osScheduler();
    if (args.bool("all")) {
        args.maxPositional(0);
        const helpers = loadHelpers();
        if (helpers.length === 0) out("no helpers in local/helpers.json");
        for (const helper of helpers) {
            if (!helper.enabled) out(`skipped ${helper.name}: disabled`);
            else if (!platformOk(helper)) out(`skipped ${helper.name}: platforms ${helper.platforms?.join(",")}`);
            else installHelper(helper, scheduler);
        }
        return;
    }
    args.maxPositional(1);
    const helper = findHelper(args.pos(0, "helper name"));
    if (!helper.enabled) throw new ToliError(`helper "${helper.name}" is disabled in local/helpers.json`);
    if (!platformOk(helper))
        throw new ToliError(`helper "${helper.name}" is for ${helper.platforms?.join(", ")}, not ${platform()}`);
    installHelper(helper, scheduler);
}

function uninstallCommand(args: Args): void {
    const scheduler = osScheduler();
    args.maxPositional(args.bool("all") ? 0 : 1);
    const names = args.bool("all") ? installedNames(scheduler) : [args.pos(0, "helper name")];
    if (names.length === 0) out("no toli helpers installed");
    for (const name of names)
        if (uninstallHelper(name, scheduler)) out(`uninstalled ${name}`);
        else if (!dryRun()) out(`${name}: not installed`);
}

/** `toli helper ...`; resolves to the exit code (`run` passes the helper's own through). */
export async function helperCommand(argv: string[]): Promise<number> {
    const [sub, ...rest] = argv;
    const args = new Args(rest, { booleans: ["json", "all"] });
    switch (sub) {
        case "list": {
            args.maxPositional(0);
            const scheduler = osScheduler();
            const helpers = loadHelpers();
            const rows = helpers.map((helper) => ({
                name: helper.name,
                schedule: scheduleText(helper.schedule),
                enabled: helper.enabled,
                platformOk: platformOk(helper),
                installed: probe(helper.name, scheduler).installed,
                command: [helper.exec, ...helper.args],
                description: helper.description,
            }));
            if (args.bool("json")) printJson(rows);
            else if (rows.length === 0) out("no helpers: add one to local/helpers.json (see docs/helpers.md)");
            else
                for (const row of rows)
                    out(
                        `${row.name}\t${row.schedule}\t${row.enabled ? (row.platformOk ? "enabled" : "other platform") : "disabled"}\t${row.installed ? "installed" : "not installed"}\t${row.description || row.command.join(" ")}`,
                    );
            return 0;
        }
        case "status": {
            args.maxPositional(1);
            const only = args.positional[0];
            const states = helperStates().filter((state) => only === undefined || state.name === only);
            if (only !== undefined && states.length === 0)
                throw new ToliError(`no helper "${only}" registered or installed`);
            if (args.bool("json")) printJson(states);
            else if (states.length === 0) out("no helpers: add one to local/helpers.json (see docs/helpers.md)");
            else for (const state of states) out(stateLine(state));
            return 0;
        }
        case "install":
            installCommand(args);
            return 0;
        case "uninstall":
            uninstallCommand(args);
            return 0;
        case "run": {
            args.maxPositional(1);
            const helper = findHelper(args.pos(0, "helper name"));
            if (!existsSync(helper.exec)) throw new ToliError(`helper "${helper.name}": ${helper.exec} does not exist`);
            return await runInherit([helper.exec, ...helper.args], { cwd: paths.root(), env: helper.env });
        }
        default:
            throw new ToliError(USAGE);
    }
}
