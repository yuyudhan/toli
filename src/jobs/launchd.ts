// launchd on macOS, behind the tick (schedule.ts), the helpers (src/helpers/) and the lead (src/fleet/lead-service.ts):
// a user agent in gui/<uid> by default, or a LaunchDaemon in the system domain that is already installed.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run, ToliError, writeTextAtomic } from "../core/util.ts";
import { mustRun } from "./os-scheduler.ts";

/** Where launchd user agents live; `TOLI_LAUNCH_AGENTS_DIR` overrides for tests. */
export function launchAgentsDir(): string {
    return process.env.TOLI_LAUNCH_AGENTS_DIR ?? join(homedir(), "Library", "LaunchAgents");
}

/** Where launchd system daemons live; `TOLI_LAUNCH_DAEMONS_DIR` overrides for tests. */
export function launchDaemonsDir(): string {
    return process.env.TOLI_LAUNCH_DAEMONS_DIR ?? "/Library/LaunchDaemons";
}

function guiDomain(): string {
    return `gui/${process.getuid?.() ?? 0}`;
}

/**
 * The launchd domain a toli job lives in: `system` when launchDaemonsDir() holds its plist (a LaunchDaemon, put there
 * by root on a machine whose jobs must keep running with no one logged in), else `user`, a user agent in gui/<uid>,
 * the default. toli never creates a LaunchDaemon; it keeps one it finds, and never adds a user agent beside it.
 */
export type LaunchdDomain = "system" | "user";

function daemonPath(label: string): string {
    return join(launchDaemonsDir(), `${label}.plist`);
}

function agentPath(label: string): string {
    return join(launchAgentsDir(), `${label}.plist`);
}

export function launchdDomain(label: string): LaunchdDomain {
    return existsSync(daemonPath(label)) ? "system" : "user";
}

/** The plist of `label` in its domain: the LaunchDaemon's when there is one, else the user agent's. */
export function launchdPlistPath(label: string): string {
    return launchdDomain(label) === "system" ? daemonPath(label) : agentPath(label);
}

/** The launchctl service target of `label`: `system/<label>` or `gui/<uid>/<label>`. */
export function launchdService(label: string): string {
    return launchdDomain(label) === "system" ? `system/${label}` : `${guiDomain()}/${label}`;
}

/**
 * What status commands show for `label`: its plist, and for a LaunchDaemon the domain, plus a user agent still on
 * disk beside it (left by an install before toli saw LaunchDaemons; the next install retires it). A user agent
 * shows as its bare plist path.
 */
export function launchdDetail(label: string): string {
    if (launchdDomain(label) === "user") return agentPath(label);
    const leftover = existsSync(agentPath(label))
        ? `; a LaunchAgent ${agentPath(label)} is still installed beside it (the next install retires it)`
        : "";
    return `${daemonPath(label)}, a LaunchDaemon in the system domain${leftover}`;
}

/** Whether `label` is loaded in its domain (`launchctl print` of a system service needs no root). */
export function launchctlLoaded(label: string): boolean {
    return run(["launchctl", "print", launchdService(label)]).code === 0;
}

function failure(result: { stderr: string; stdout: string }): string {
    return (result.stderr || result.stdout).trim();
}

/**
 * Why launchd would refuse `launchctl bootstrap gui/<uid>` from this session, or null when it accepts it. A session
 * outside the user's login (a launchd background job, a daemon, no one logged in) can still `bootout` an agent but
 * cannot load one into the gui domain (error 125: "Domain does not support specified action"), and `launchctl print`
 * of the domain fails the same way.
 */
export function launchdSessionProblem(): string | null {
    const probe = run(["launchctl", "print", guiDomain()]);
    if (probe.code === 0) return null;
    const session = run(["launchctl", "managername"]).stdout.trim() || "unknown";
    return `launchctl print ${guiDomain()} exited ${probe.code} (${failure(probe) || "no output"}); launchctl session: ${session}`;
}

export type LoadOptions = {
    /** A loaded job whose plist on disk already is this one is kicked (`kickstart -k`), never booted out. */
    restartUnchanged?: boolean;
};

/** The `TOLI_DRY_RUN` lines for loadLaunchdJob(label). */
export function launchdLoadPlan(label: string, options: LoadOptions = {}): string[] {
    const target = launchdPlistPath(label);
    const service = launchdService(label);
    if (launchdDomain(label) === "user")
        return [
            ...(options.restartUnchanged === true
                ? [`# would run: launchctl kickstart -k ${service} (loaded, and ${target} already is this plist)`]
                : []),
            `# would run: launchctl bootout ${service} (if loaded), then launchctl bootstrap ${guiDomain()} ${target}`,
            "# from a session launchd cannot bootstrap into (no login session), nothing is touched; a failed bootstrap puts the old plist back",
        ];
    return [
        `# ${target} is a LaunchDaemon in the system domain: toli keeps it there and adds no LaunchAgent`,
        ...(options.restartUnchanged === true
            ? [`# would run: sudo -n launchctl kickstart -k ${service} (loaded, and ${target} already is this plist)`]
            : []),
        `# would run: sudo -n tee ${target}, then sudo -n launchctl bootout ${service} (if loaded) and sudo -n launchctl bootstrap system ${target}`,
        `# would retire a LaunchAgent ${agentPath(label)} of the same label (launchctl bootout ${guiDomain()}/${label}, then remove it), so the job never runs twice`,
        "# needs root through sudo -n: without cached sudo credentials nothing is touched (run sudo -v first); a failed bootstrap puts the old plist back",
    ];
}

/** The `TOLI_DRY_RUN` line for unloadLaunchdJob(label). */
export function launchdRemovalPlan(label: string): string {
    const service = launchdService(label);
    if (launchdDomain(label) === "user")
        return `# dry run: would run launchctl bootout ${service} (if loaded) and remove ${agentPath(label)}`;
    return `# dry run: would run sudo -n launchctl bootout ${service} (if loaded), sudo -n rm -f ${daemonPath(label)}, and retire a LaunchAgent ${agentPath(label)} (if there)`;
}

/**
 * Write `label`'s plist and (re)load it in its launchd domain; returns what was done. A LaunchDaemon already in
 * launchDaemonsDir() is rewritten and reloaded there as root through `sudo -n` (loadLaunchDaemon); otherwise a user
 * agent (loadLaunchAgent).
 */
export function loadLaunchdJob(label: string, plist: string, options: LoadOptions = {}): "loaded" | "restarted" {
    return launchdDomain(label) === "system"
        ? loadLaunchDaemon(label, plist, options)
        : loadLaunchAgent(label, agentPath(label), plist, options);
}

/** Boot out `label` (when loaded) and remove its plist, in its domain; returns whether anything was there. */
export function unloadLaunchdJob(label: string): boolean {
    return launchdDomain(label) === "system" ? unloadLaunchDaemon(label) : unloadLaunchAgent(label, agentPath(label));
}

/**
 * Write a launchd agent and (re)load it; returns what was done. launchd cannot swap a loaded agent in place, so a
 * changed plist is booted out and bootstrapped again: the session is probed first (nothing is touched when launchd
 * would refuse the bootstrap), and when the bootstrap still fails the previous plist is put back and loaded again,
 * so a failed install does not leave a working agent unloaded.
 */
function loadLaunchAgent(label: string, target: string, plist: string, options: LoadOptions): "loaded" | "restarted" {
    const problem = launchdSessionProblem();
    if (problem !== null)
        throw new ToliError(
            `cannot load ${label} from this session, and nothing was changed: ${problem}. launchd only loads user agents ` +
                `into ${guiDomain()} from the user's login session, so booting out a running ${label} here would leave it ` +
                "unloaded. Run this command from a Terminal in the login session.",
        );
    const service = `${guiDomain()}/${label}`;
    const bootstrap = ["launchctl", "bootstrap", guiDomain(), target];
    const loaded = launchctlLoaded(label);
    const previous = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (loaded && options.restartUnchanged === true && previous === plist) {
        mustRun(["launchctl", "kickstart", "-k", service]);
        return "restarted";
    }
    writeTextAtomic(target, plist);
    if (loaded) mustRun(["launchctl", "bootout", service]);
    const booted = run(bootstrap);
    if (booted.code === 0) return "loaded";
    const message = `${bootstrap.join(" ")} failed: ${failure(booted)}`;
    if (!loaded) throw new ToliError(message);
    if (previous === null)
        throw new ToliError(
            `${message}; ${label} was loaded without a plist at ${target}, so the previous agent cannot be restored and ${label} is now unloaded`,
        );
    writeTextAtomic(target, previous);
    const restored = run(bootstrap);
    if (restored.code === 0)
        throw new ToliError(`${message}; the previous ${target} is back and ${label} is loaded again, unchanged`);
    throw new ToliError(
        `${message}; restoring the previous agent failed too (${bootstrap.join(" ")}: ${failure(restored)}), so ${label} is now unloaded; the previous plist is back at ${target}`,
    );
}

/** Boot out a launchd agent (when loaded) and remove its plist; returns whether anything was there. */
function unloadLaunchAgent(label: string, target: string): boolean {
    const loaded = launchctlLoaded(label);
    if (loaded) mustRun(["launchctl", "bootout", `${guiDomain()}/${label}`]);
    const present = existsSync(target);
    rmSync(target, { force: true });
    return loaded || present;
}

/** A root-only command, run through `sudo -n`: toli never prompts for a password and never stores one. */
function sudo(cmd: string[]): string[] {
    return ["sudo", "-n", ...cmd];
}

/** Throw before anything changes when `sudo -n` cannot get root here, saying how to fix that. */
function requireSudo(what: string, label: string): void {
    const probe = run(sudo(["true"]));
    if (probe.code === 0) return;
    throw new ToliError(
        `${what} needs root: ${label} is a LaunchDaemon in ${launchDaemonsDir()}, loaded into launchd's system domain, ` +
            `and sudo -n cannot run here (${failure(probe) || `sudo -n true exited ${probe.code}`}). Nothing was changed. ` +
            "Run `sudo -v` in this terminal (sudo asks for your password once), then run this command again from the " +
            "same terminal; toli calls sudo -n itself, so do not run toli under sudo.",
    );
}

/**
 * Write a LaunchDaemon plist as root (mode 644, as launchd requires), replacing `target` in one rename. When a step
 * fails the staged copy is removed, so nothing but `target` (unchanged) is left in the daemons dir.
 */
function writeDaemonPlist(target: string, text: string): void {
    const staged = `${target}.toli-new`;
    const steps: [string[], string | undefined][] = [
        [sudo(["tee", staged]), text],
        [sudo(["chmod", "644", staged]), undefined],
        [sudo(["mv", "-f", staged, target]), undefined],
    ];
    for (const [cmd, stdin] of steps) {
        const result = run(cmd, stdin === undefined ? {} : { stdin });
        if (result.code === 0) continue;
        run(sudo(["rm", "-f", staged]));
        throw new ToliError(`${cmd.join(" ")} failed: ${failure(result)}; ${target} is unchanged`);
    }
}

/** A retired user agent: its plist text (null when there was none) and whether it was loaded. */
type RetiredAgent = { plist: string | null; loaded: boolean };

/**
 * Boot out the user agent of `label` beside its LaunchDaemon and remove its plist, so the job never runs twice.
 * bootout works from any session of the user (unlike bootstrap) and fails when nothing is loaded.
 */
function retireLaunchAgent(label: string): RetiredAgent {
    const target = agentPath(label);
    const plist = existsSync(target) ? readFileSync(target, "utf8") : null;
    const loaded = run(["launchctl", "bootout", `${guiDomain()}/${label}`]).code === 0;
    rmSync(target, { force: true });
    return { plist, loaded };
}

/** Put a retired agent back after its LaunchDaemon failed to load; returns a clause for the error saying how it went. */
function restoreLaunchAgent(label: string, agent: RetiredAgent): string {
    if (agent.plist === null)
        return agent.loaded ? `; the LaunchAgent ${label} it replaced had no plist, so it stays unloaded` : "";
    const target = agentPath(label);
    writeTextAtomic(target, agent.plist);
    if (!agent.loaded) return `; the LaunchAgent plist it replaced is back at ${target}`;
    const back = run(["launchctl", "bootstrap", guiDomain(), target]);
    return back.code === 0
        ? `; the LaunchAgent ${label} it replaced is loaded again in ${guiDomain()}`
        : `; the LaunchAgent plist it replaced is back at ${target}, but loading it again failed (${failure(back)}), so that agent is not running`;
}

/**
 * Rewrite the LaunchDaemon `label` as root and (re)load it in the system domain. Root comes from `sudo -n`, probed
 * first: without it nothing is touched. A user agent of the same label is booted out and removed before the daemon
 * loads, so the job never runs twice. launchd cannot swap a loaded job in place, so a changed plist is booted out and
 * bootstrapped again; when that bootstrap fails the previous plist is put back and loaded again (and, when the daemon
 * was not running before, the retired agent too), so a failed install does not leave a working job unloaded.
 */
function loadLaunchDaemon(label: string, plist: string, options: LoadOptions): "loaded" | "restarted" {
    requireSudo(`installing ${label}`, label);
    const target = daemonPath(label);
    const service = `system/${label}`;
    const loaded = launchctlLoaded(label);
    const previous = readFileSync(target, "utf8");
    if (loaded && options.restartUnchanged === true && previous === plist) {
        retireLaunchAgent(label);
        mustRun(sudo(["launchctl", "kickstart", "-k", service]));
        return "restarted";
    }
    writeDaemonPlist(target, plist);
    if (loaded) {
        const bootout = run(sudo(["launchctl", "bootout", service]));
        if (bootout.code !== 0) {
            writeDaemonPlist(target, previous);
            throw new ToliError(
                `sudo -n launchctl bootout ${service} failed: ${failure(bootout)}; the previous ${target} is back and ${label} stays loaded as it was`,
            );
        }
    }
    const agent = retireLaunchAgent(label);
    const bootstrap = sudo(["launchctl", "bootstrap", "system", target]);
    const booted = run(bootstrap);
    if (booted.code === 0) return "loaded";
    const message = `${bootstrap.join(" ")} failed: ${failure(booted)}`;
    writeDaemonPlist(target, previous);
    if (!loaded)
        throw new ToliError(
            `${message}; ${label} was not loaded and the previous ${target} is back${restoreLaunchAgent(label, agent)}`,
        );
    const restored = run(bootstrap);
    if (restored.code === 0)
        throw new ToliError(`${message}; the previous ${target} is back and ${label} is loaded again, unchanged`);
    throw new ToliError(
        `${message}; restoring the previous daemon failed too (${bootstrap.join(" ")}: ${failure(restored)}), so ${label} is now unloaded; the previous plist is back at ${target}${restoreLaunchAgent(label, agent)}`,
    );
}

/**
 * Boot out the LaunchDaemon `label` (when loaded) and remove its plist, as root through `sudo -n`, and retire a user
 * agent of that label beside it; returns true (the daemon's plist was there).
 */
function unloadLaunchDaemon(label: string): boolean {
    requireSudo(`removing ${label}`, label);
    if (launchctlLoaded(label)) mustRun(sudo(["launchctl", "bootout", `system/${label}`]));
    mustRun(sudo(["rm", "-f", daemonPath(label)]));
    retireLaunchAgent(label);
    return true;
}
