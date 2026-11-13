// doctor's checks of this machine's own setup (src/setup/doctor.ts): the runtime snapshot, config/machine.json and
// what it implies (outbox, pulls, cargo jobs), project clones, the fleet, the scheduler and the lead.
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { inboundOff, loadFleet, loadMachine, type Machine } from "../core/config.ts";
import { isGitRepo } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { idleSessionText, sessionPresence } from "../fleet/idle-session.ts";
import { leadServiceStatus } from "../fleet/lead-service.ts";
import { interactiveLeadPid } from "../fleet/lead-state.ts";
import { availabilityLine, fleetStatus } from "../fleet/pick.ts";
import { capacityFor } from "../fleet/resources.ts";
import { cargoConfigPath } from "../jawans/env.ts";
import { CRON_LEFTOVER_WARNING, missingBunWarning, scheduleStatus } from "../jobs/schedule.ts";
import { loadProjects } from "../projects/projects.ts";
import { describeRuntime, runtimeStatus } from "../release/runtime.ts";
import type { Check } from "./doctor.ts";
import { outboxCheck, pullCheck } from "./outbox-check.ts";

/**
 * Whether cargo's user config caps build jobs at the machine's `capacity.cargoJobs`, one heavy-build slot's share of
 * the cores. `bin/toli spawn`, `bin/toli build-slot` and a lead session (`bin/toli hook lead-build-env`, inherited by
 * its native subagents) set `CARGO_BUILD_JOBS` themselves; this mirror covers every other cargo run on the machine.
 */
export function cargoJobsCheck(configText: string | null, cargoJobs: number): Check {
    const want = `set \`[build] jobs = ${cargoJobs}\` in ${cargoConfigPath()} (capacity.cargoJobs in config/machine.json)`;
    if (configText === null) return { level: "warn", name: "cargo-jobs", detail: `no cargo config: ${want}` };
    let jobs: unknown;
    try {
        const parsed: unknown = Bun.TOML.parse(configText);
        const build = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "build") : undefined;
        jobs = typeof build === "object" && build !== null ? Reflect.get(build, "jobs") : undefined;
    } catch (error) {
        return { level: "warn", name: "cargo-jobs", detail: `cargo config unreadable (${String(error)}): ${want}` };
    }
    if (jobs === cargoJobs) return { level: "ok", name: "cargo-jobs", detail: `[build] jobs = ${cargoJobs}` };
    const found = jobs === undefined ? "no [build] jobs" : `[build] jobs = ${String(jobs)}`;
    return { level: "warn", name: "cargo-jobs", detail: `${found}: ${want}` };
}

export function runtimeChecks(): Check[] {
    if (!isGitRepo(paths.root())) return [];
    const runtime = runtimeStatus();
    return [
        {
            level: runtime.state === "stale" || runtime.state === "missing" ? "warn" : "ok",
            name: "runtime",
            detail: describeRuntime(runtime),
        },
    ];
}

export function machineChecks(): Check[] {
    let machine: Machine;
    try {
        machine = loadMachine();
    } catch (error) {
        return [{ level: "fail", name: "machine", detail: error instanceof Error ? error.message : String(error) }];
    }
    if (machine.role === "worker" && !machine.coordinator)
        return [
            { level: "fail", name: "machine", detail: `${machine.name} is a worker without a coordinator {ssh, root}` },
        ];
    const coordinator = machine.coordinator
        ? ` -> coordinator ${machine.coordinator.ssh}:${machine.coordinator.root}`
        : "";
    const checks: Check[] = [
        { level: "ok", name: "machine", detail: `${machine.name} (${machine.role})${coordinator}` },
        outboxCheck(machine.role === "worker" ? machine.coordinator?.ssh : undefined),
    ];
    const pulling = pullCheck();
    if (pulling !== null) checks.push(pulling);
    if (Bun.which("cargo", { PATH: process.env.PATH ?? "" })) {
        const config = cargoConfigPath();
        const cargoJobs = capacityFor(machine, availableParallelism()).cargoJobs;
        checks.push(cargoJobsCheck(existsSync(config) ? readFileSync(config, "utf8") : null, cargoJobs));
    }
    return checks;
}

export function projectChecks(): Check[] {
    const registered = loadProjects();
    const missing = registered
        .filter((project) => !isGitRepo(paths.projectDir(project.name)))
        .map((project) => project.name);
    return [
        missing.length === 0
            ? {
                  level: "ok",
                  name: "projects",
                  detail: `${registered.length} clone${registered.length === 1 ? "" : "s"} present`,
              }
            : { level: "warn", name: "projects", detail: `registered but not cloned: ${missing.join(", ")}` },
    ];
}

/** Every other fleet machine's availability; nothing when this machine's own config does not load. */
export async function fleetChecks(): Promise<Check[]> {
    try {
        loadMachine();
    } catch {
        return [];
    }
    const fleet = (await fleetStatus()).filter((entry) => !entry.local);
    const pulling = new Set(
        loadFleet()
            .machines.filter(inboundOff)
            .map((machine) => machine.name),
    );
    if (fleet.length === 0) return [{ level: "ok", name: "fleet", detail: "no other machines in config/fleet.json" }];
    return fleet.map((entry) => ({
        level: entry.reachable || pulling.has(entry.machine) ? "ok" : "warn",
        name: "fleet",
        detail: availabilityLine(entry),
    }));
}

export function schedulerChecks(): Check[] {
    const schedule = scheduleStatus();
    const checks: Check[] = [];
    if (schedule.otherBin !== null)
        checks.push({
            level: "warn",
            name: "scheduler",
            detail: `${schedule.scheduler} tick runs ${schedule.otherBin}, not this checkout (bin/toli schedule install moves it here)`,
        });
    else
        checks.push(
            schedule.installed && schedule.loaded
                ? { level: "ok", name: "scheduler", detail: `${schedule.scheduler} installed and loaded` }
                : {
                      level: "warn",
                      name: "scheduler",
                      detail: `${schedule.scheduler} ${schedule.installed ? "installed" : "not installed"}, ${schedule.loaded ? "loaded" : "not loaded"} (bin/toli schedule install)`,
                  },
        );
    if (schedule.missingBun !== null)
        checks.push({ level: "warn", name: "scheduler", detail: missingBunWarning(schedule.missingBun) });
    if (schedule.cronLeftover) checks.push({ level: "warn", name: "scheduler", detail: CRON_LEFTOVER_WARNING });
    return checks;
}

/** The lead is served when its service is installed in the scheduler in use, or an interactive lead is open. */
export function leadCheck(): Check {
    const service = leadServiceStatus();
    if (service.installed)
        return {
            level: "ok",
            name: "lead",
            detail: `${service.scheduler} lead service installed${service.running ? " and running" : ", not running"}`,
        };
    const interactive = interactiveLeadPid();
    if (interactive !== null)
        return { level: "ok", name: "lead", detail: `interactive lead session open (pid ${interactive})` };
    return {
        level: "warn",
        name: "lead",
        detail: `${service.scheduler} lead service not installed: run bin/toli lead install`,
    };
}

/** A warning when the live interactive session has left its wakes unread past `lead.idleSessionMinutes`, else null. */
export function idleSessionCheck(): Check | null {
    const idle = sessionPresence()?.idle ?? null;
    if (idle === null) return null;
    return {
        level: "warn",
        name: "lead-session",
        detail: `interactive session ${idleSessionText(idle)}: the headless lead takes the turns meanwhile; attend or close that session (toli never stops it)`,
    };
}
