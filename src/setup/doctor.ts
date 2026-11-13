import { Args } from "../core/args.ts";
import { hasMachine } from "../core/config.ts";
import { captureLoginEnv, credentialNames, LOGIN_ENV_FLAG, loginShell } from "../core/login-env.ts";
import { paths } from "../core/paths.ts";
import { out, printJson, run } from "../core/util.ts";
import { bitbucketCredentials } from "../forge/bitbucket.ts";
import { forgeReadiness, projectForge } from "../forge/forge.ts";
import { configuredHarnesses, HARNESSES, type Harness, harnessStatus } from "../harness/harness.ts";
import { syncShims } from "../harness/sync.ts";
import { schedulePath } from "../jobs/os-scheduler.ts";
import { hooksDoctorChecks } from "../projects/hooks-gates.ts";
import { type Forge, loadProjects } from "../projects/projects.ts";
import { memoryCheck } from "../records/memory.ts";
import {
    fleetChecks,
    idleSessionCheck,
    leadCheck,
    machineChecks,
    projectChecks,
    runtimeChecks,
    schedulerChecks,
} from "./machine-checks.ts";
import { peerChecks } from "./peer-checks.ts";

export type CheckLevel = "ok" | "warn" | "fail";
export type Check = { level: CheckLevel; name: string; detail: string };

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

/** How long one doctor section may take before it is stopped and reported as timed out. */
const SECTION_MS = 60_000;
/**
 * The fleet section probes every other machine at once: over HTTPS (5 s to connect, then up to 120 s for the
 * answer), then ssh (up to 20 s), so it gets longer than the rest.
 */
const FLEET_SECTION_MS = 150_000;

/** One doctor section: a name for its timed-out line, its time limit (default SECTION_MS), and the checks it makes. */
type Section = { name: string; limitMs?: number; run: () => Check[] | Promise<Check[]> };

/** The sections every machine runs, in order. */
const SECTIONS: Section[] = [
    { name: "bun", run: () => [{ level: "ok", name: "bun", detail: `${Bun.version} (${process.execPath})` }] },
    { name: "harness", run: harnessChecks },
    { name: "service-env", run: () => [serviceEnvCheck()] },
    { name: "git", run: () => [toolCheck("git", ["git", "--version"], "fail")] },
    { name: "forge", run: forgeChecks },
    { name: "openssl", run: () => [toolCheck("openssl", ["openssl", "version"], "warn")] },
    { name: "peer", run: peerChecks },
    {
        name: "no-mistakes",
        run: () => {
            const noMistakes = Bun.which("no-mistakes", { PATH: process.env.PATH ?? "" });
            return [
                noMistakes
                    ? { level: "ok", name: "no-mistakes", detail: noMistakes }
                    : { level: "warn", name: "no-mistakes", detail: "not found (needed only for branch/PR gating)" },
            ];
        },
    },
    { name: "memory", run: () => [{ name: "memory", ...memoryCheck() }] },
    { name: "runtime", run: runtimeChecks },
];

/** The sections that need config/machine.json, in order after SECTIONS. */
const MACHINE_SECTIONS: Section[] = [
    { name: "machine", run: machineChecks },
    { name: "projects", run: projectChecks },
    { name: "hooks", run: () => hooksDoctorChecks(loadProjects().map((project) => project.name)) },
    { name: "fleet", limitMs: FLEET_SECTION_MS, run: fleetChecks },
    { name: "scheduler", run: schedulerChecks },
    { name: "lead", run: () => [leadCheck(), idleSessionCheck()].filter((check) => check !== null) },
];

/** Run one section by name (in src/setup/doctor-worker.ts); a section that throws reports a fail line. */
export async function runSection(name: string): Promise<Check[]> {
    const section = [...SECTIONS, ...MACHINE_SECTIONS].find((entry) => entry.name === name);
    if (section === undefined) return [{ level: "fail", name, detail: "no such doctor section" }];
    try {
        return await section.run();
    } catch (error) {
        return [{ level: "fail", name, detail: error instanceof Error ? error.message : String(error) }];
    }
}

/** A section's time limit; `TOLI_DOCTOR_CHECK_MS` replaces every limit (tests). */
function sectionLimitMs(section: Section): number {
    const override = Number(process.env.TOLI_DOCTOR_CHECK_MS);
    if (Number.isInteger(override) && override > 0) return override;
    return section.limitMs ?? SECTION_MS;
}

/**
 * Run one section in its own worker, so neither a call that blocks (a synchronous child process with no timeout) nor
 * a handle it leaves open (a socket never closed) can hold doctor up: past its limit the section is reported as
 * timed out, the worker is terminated, and the next section runs. The worker never keeps the process alive.
 */
async function runBounded(section: Section): Promise<Check[]> {
    const limitMs = sectionLimitMs(section);
    const worker = new Worker(new URL("./doctor-worker.ts", import.meta.url).href);
    worker.unref();
    const { promise, resolve } = Promise.withResolvers<Check[]>();
    worker.onmessage = (event: MessageEvent<Check[]>) => resolve(event.data);
    worker.onerror = (event: ErrorEvent) => {
        event.preventDefault();
        resolve([{ level: "fail", name: section.name, detail: event.message }]);
    };
    const timer = setTimeout(
        () =>
            resolve([
                {
                    level: "warn",
                    name: section.name,
                    detail: `timed out after ${limitMs / 1000} s: the check never finished and was stopped`,
                },
            ]),
        limitMs,
    );
    worker.postMessage(section.name);
    try {
        return await promise;
    } finally {
        clearTimeout(timer);
        worker.terminate();
    }
}

/** Every check, section by section; `report` gets each section's checks as soon as that section finishes. */
export async function runChecks(report: (checks: Check[]) => void = () => undefined): Promise<Check[]> {
    const checks: Check[] = [];
    const add = (found: Check[]): void => {
        checks.push(...found);
        report(found);
    };
    for (const section of SECTIONS) add(await runBounded(section));
    if (!hasMachine()) {
        add([{ level: "fail", name: "machine", detail: "config/machine.json missing: run bin/toli init" }]);
        return checks;
    }
    for (const section of MACHINE_SECTIONS) add(await runBounded(section));
    return checks;
}

/**
 * Prints `ok|warn|fail <name> <detail>` per check, each section's lines as soon as it finishes; returns the process
 * exit code (1 only on a fail).
 */
export async function doctorCommand(argv: string[]): Promise<number> {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const json = args.bool("json");
    const checks = await runChecks((found) => {
        if (!json) for (const check of found) out(`${check.level} ${check.name} ${check.detail}`);
    });
    if (json) printJson(checks);
    return checks.some((check) => check.level === "fail") ? 1 : 0;
}
