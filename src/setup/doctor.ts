import { existsSync, readFileSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { join } from "node:path";
import { Args } from "../core/args.ts";
import { hasMachine, inboundOff, loadFleet, loadMachine } from "../core/config.ts";
import { isGitRepo } from "../core/git.ts";
import { captureLoginEnv, credentialNames, LOGIN_ENV_FLAG, loginShell } from "../core/login-env.ts";
import { paths } from "../core/paths.ts";
import { out, printJson, run } from "../core/util.ts";
import { leadServiceStatus } from "../fleet/lead-service.ts";
import { interactiveLeadPid } from "../fleet/lead-state.ts";
import { availabilityLine, fleetStatus } from "../fleet/pick.ts";
import { capacityFor } from "../fleet/resources.ts";
import { bitbucketCredentials } from "../forge/bitbucket.ts";
import { forgeReadiness, projectForge } from "../forge/forge.ts";
import { configuredHarnesses, HARNESSES, type Harness, harnessStatus } from "../harness/harness.ts";
import { syncShims } from "../harness/sync.ts";
import { schedulePath } from "../jobs/os-scheduler.ts";
import { CRON_LEFTOVER_WARNING, missingBunWarning, scheduleStatus } from "../jobs/schedule.ts";
import { type Forge, loadProjects } from "../projects/projects.ts";
import { memoryCheck } from "../records/memory.ts";
import { describeRuntime, runtimeStatus } from "../release/runtime.ts";
import { outboxCheck } from "./outbox-check.ts";

export type CheckLevel = "ok" | "warn" | "fail";
export type Check = { level: CheckLevel; name: string; detail: string };

/** Cargo's user config, where `[build] jobs` caps every cargo run on the machine, not only toli-spawned jawans. */
export function cargoConfigPath(env: Record<string, string | undefined> = process.env): string {
    return join(env.CARGO_HOME || join(homedir(), ".cargo"), "config.toml");
}

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

function firstLine(text: string): string {
    return (
        text
            .split("\n")
            .find((line) => line.trim() !== "")
            ?.trim() ?? "(no output)"
    );
}

function toolCheck(name: string, cmd: string[], missing: CheckLevel): Check {
    const result = run(cmd, { timeoutMs: 20_000 });
    if (result.code === 127) return { level: missing, name, detail: "not found on PATH" };
    if (result.code !== 0)
        return {
            level: missing,
            name,
            detail: `${cmd.join(" ")} exited ${result.code}: ${firstLine(result.stderr || result.stdout)}`,
        };
    return { level: "ok", name, detail: firstLine(result.stdout || result.stderr) };
}

function nameList(names: string[]): string {
    return names.length <= 5 ? names.join(", ") : `${names.slice(0, 5).join(", ")} +${names.length - 5} more`;
}

/**
 * Forge readiness per forge host the registered projects use: `gh auth status` / `glab auth status --hostname`,
 * Bitbucket credentials present. GitHub (github.com) is always checked; unused gitlab/bitbucket only reported.
 */
function forgeChecks(): Check[] {
    const used = new Map<string, { forge: Forge; host: string; projects: string[] }>();
    const undetected: string[] = [];
    for (const project of loadProjects()) {
        try {
            const target = projectForge(project);
            const key = `${target.forge} ${target.host}`;
            const entry = used.get(key) ?? { forge: target.forge, host: target.host, projects: [] };
            entry.projects.push(project.name);
            used.set(key, entry);
        } catch {
            undetected.push(project.name);
        }
    }
    if (!used.has("github github.com"))
        used.set("github github.com", { forge: "github", host: "github.com", projects: [] });
    const checks: Check[] = [...used.values()].map(({ forge, host, projects }) => {
        const readiness = forgeReadiness(forge, host);
        const scope = projects.length === 0 ? "no registered projects" : `projects: ${nameList(projects)}`;
        return {
            level: readiness.ready ? "ok" : "warn",
            name: `forge-${forge}`,
            detail: `${readiness.detail} (${scope})`,
        };
    });
    const forges = new Set([...used.values()].map((entry) => entry.forge));
    if (!forges.has("gitlab")) {
        const glab = Bun.which("glab", { PATH: process.env.PATH ?? "" });
        checks.push({
            level: "ok",
            name: "forge-gitlab",
            detail: `${glab ? `glab at ${glab}` : "glab not found"} (no registered gitlab projects)`,
        });
    }
    if (!forges.has("bitbucket")) {
        const credentials = bitbucketCredentials();
        checks.push({
            level: "ok",
            name: "forge-bitbucket",
            detail: `${credentials ? `credentials from ${credentials.source}` : "no credentials set"} (no registered bitbucket projects)`,
        });
    }
    if (undetected.length > 0)
        checks.push({
            level: "warn",
            name: "forge",
            detail: `forge not detected for ${nameList(undetected)} (bin/toli forge <project>; set --forge)`,
        });
    return checks;
}

/**
 * One check per harness CLI: installed, version, login. omp is required (scheduled jobs run in headless omp);
 * harnesses config/machine.json routes jawans to warn when missing or logged out; the rest are optional.
 * Also checks the per-harness shims are in sync with their single source (.omp, AGENTS.md).
 */
function harnessChecks(): Check[] {
    let configured: Harness[];
    try {
        configured = configuredHarnesses();
    } catch (error) {
        return [{ level: "fail", name: "harness", detail: error instanceof Error ? error.message : String(error) }];
    }
    const checks = HARNESSES.map((harness): Check => {
        const status = harnessStatus(harness);
        const needed = harness === "omp" || configured.includes(harness);
        const role = configured.includes(harness) ? " [jawan harness]" : "";
        if (!status.installed)
            return {
                level: harness === "omp" ? "fail" : needed ? "warn" : "ok",
                name: harness,
                detail: `${status.detail}${needed ? "" : " - optional"}${role}`,
            };
        const login = status.loggedIn === null ? "login not checked" : status.loggedIn ? "logged in" : "NOT logged in";
        return {
            level: status.loggedIn === false && needed ? "warn" : "ok",
            name: harness,
            detail: `${status.version ?? "installed"}, ${login}: ${status.detail}${role}`,
        };
    });
    const drift = syncShims(paths.root(), true).filter((result) => result.state !== "ok");
    checks.push(
        drift.length === 0
            ? { level: "ok", name: "harness-shims", detail: "CLAUDE.md, .claude, .agents, .cursor, .pi in sync" }
            : {
                  level: "warn",
                  name: "harness-shims",
                  detail: `out of date: ${drift.map((result) => result.path).join(", ")} (bin/toli harness sync)`,
              },
    );
    return checks;
}

/**
 * Whether the harness credentials in this shell (`*_API_KEY`, `*_AUTH_TOKEN`, `*_OAUTH_TOKEN` variables) reach what
 * the lead service, the tick and the helpers start: the user's login shell is run from a service's environment
 * (HOME, USER, SHELL, PATH) and each name set here but not there is a warning. Names only, never values.
 */
export function serviceEnvCheck(env: Record<string, string | undefined> = process.env): Check {
    if (env[LOGIN_ENV_FLAG] === "off")
        return { level: "ok", name: "service-env", detail: `not checked (${LOGIN_ENV_FLAG}=off)` };
    const base: Record<string, string | undefined> = {
        HOME: env.HOME,
        USER: env.USER,
        LOGNAME: env.LOGNAME,
        TMPDIR: env.TMPDIR,
        SHELL: loginShell(env),
        PATH: schedulePath(),
    };
    const capture = captureLoginEnv(base);
    if ("error" in capture)
        return {
            level: "warn",
            name: "service-env",
            detail: `${capture.shell} -i -l ${capture.error}: jawans started by services get no profile variables`,
        };
    const here = credentialNames(env);
    const seen = new Set(credentialNames(capture.env));
    const missing = here.filter((name) => !seen.has(name));
    if (missing.length > 0)
        return {
            level: "warn",
            name: "service-env",
            detail: `${nameList(missing)} set in this shell but not by the login profile of ${capture.shell}: jawans the lead service, tick or helpers start will not see ${missing.length === 1 ? "it" : "them"} (export ${missing.length === 1 ? "it" : "them"} in the shell profile)`,
        };
    return {
        level: "ok",
        name: "service-env",
        detail:
            seen.size === 0
                ? `no credential variables set; ${capture.shell} login profile loads for service-started jawans`
                : `services see ${nameList([...seen].sort())} via the ${capture.shell} login profile`,
    };
}

export async function runChecks(): Promise<Check[]> {
    const checks: Check[] = [
        { level: "ok", name: "bun", detail: `${Bun.version} (${process.execPath})` },
        ...harnessChecks(),
        serviceEnvCheck(),
        toolCheck("git", ["git", "--version"], "fail"),
        ...forgeChecks(),
    ];
    const noMistakes = Bun.which("no-mistakes", { PATH: process.env.PATH ?? "" });
    checks.push(
        noMistakes
            ? { level: "ok", name: "no-mistakes", detail: noMistakes }
            : { level: "warn", name: "no-mistakes", detail: "not found (needed only for branch/PR gating)" },
    );
    checks.push({ name: "memory", ...memoryCheck() });
    if (isGitRepo(paths.root())) {
        const runtime = runtimeStatus();
        checks.push({
            level: runtime.state === "stale" || runtime.state === "missing" ? "warn" : "ok",
            name: "runtime",
            detail: describeRuntime(runtime),
        });
    }

    if (!hasMachine()) {
        checks.push({ level: "fail", name: "machine", detail: "config/machine.json missing: run bin/toli init" });
        return checks;
    }
    let machineOk = false;
    try {
        const machine = loadMachine();
        if (machine.role === "worker" && !machine.coordinator) {
            checks.push({
                level: "fail",
                name: "machine",
                detail: `${machine.name} is a worker without a coordinator {ssh, root}`,
            });
        } else {
            const coordinator = machine.coordinator
                ? ` -> coordinator ${machine.coordinator.ssh}:${machine.coordinator.root}`
                : "";
            checks.push({ level: "ok", name: "machine", detail: `${machine.name} (${machine.role})${coordinator}` });
            checks.push(outboxCheck(machine.role === "worker" ? machine.coordinator?.ssh : undefined));
            if (Bun.which("cargo", { PATH: process.env.PATH ?? "" })) {
                const config = cargoConfigPath();
                const cargoJobs = capacityFor(machine, availableParallelism()).cargoJobs;
                checks.push(cargoJobsCheck(existsSync(config) ? readFileSync(config, "utf8") : null, cargoJobs));
            }
        }
        machineOk = true;
    } catch (error) {
        checks.push({ level: "fail", name: "machine", detail: error instanceof Error ? error.message : String(error) });
    }

    const registered = loadProjects();
    const missing = registered
        .filter((project) => !isGitRepo(paths.projectDir(project.name)))
        .map((project) => project.name);
    checks.push(
        missing.length === 0
            ? {
                  level: "ok",
                  name: "projects",
                  detail: `${registered.length} clone${registered.length === 1 ? "" : "s"} present`,
              }
            : { level: "warn", name: "projects", detail: `registered but not cloned: ${missing.join(", ")}` },
    );

    if (machineOk) {
        try {
            const fleet = (await fleetStatus()).filter((entry) => !entry.local);
            const pulling = new Set(
                loadFleet()
                    .machines.filter(inboundOff)
                    .map((machine) => machine.name),
            );
            if (fleet.length === 0)
                checks.push({ level: "ok", name: "fleet", detail: "no other machines in config/fleet.json" });
            for (const entry of fleet)
                checks.push({
                    level: entry.reachable || pulling.has(entry.machine) ? "ok" : "warn",
                    name: "fleet",
                    detail: availabilityLine(entry),
                });
        } catch (error) {
            checks.push({
                level: "fail",
                name: "fleet",
                detail: error instanceof Error ? error.message : String(error),
            });
        }
    }

    const schedule = scheduleStatus();
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
    checks.push(leadCheck());
    return checks;
}

/** The lead is served when its service is installed in the scheduler in use, or an interactive lead is open. */
function leadCheck(): Check {
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

/** Prints `ok|warn|fail <name> <detail>` per check; returns the process exit code (1 only on a fail). */
export async function doctorCommand(argv: string[]): Promise<number> {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const checks = await runChecks();
    if (args.bool("json")) printJson(checks);
    else for (const check of checks) out(`${check.level} ${check.name} ${check.detail}`);
    return checks.some((check) => check.level === "fail") ? 1 : 0;
}
