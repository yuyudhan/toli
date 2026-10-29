import { Args } from "./args.ts";
import { hasMachine, loadMachine } from "./config.ts";
import { forgeReadiness, projectForge } from "./forge.ts";
import { bitbucketCredentials } from "./forge-bitbucket.ts";
import { isGitRepo } from "./git.ts";
import { paths } from "./paths.ts";
import { fleetStatus } from "./pick.ts";
import { type Forge, loadProjects } from "./projects.ts";
import { availabilityLine } from "./resources.ts";
import { scheduleStatus } from "./schedule.ts";
import { out, printJson, run } from "./util.ts";

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

export async function runChecks(): Promise<Check[]> {
    const checks: Check[] = [
        { level: "ok", name: "bun", detail: `${Bun.version} (${process.execPath})` },
        toolCheck("omp", ["omp", "--version"], "fail"),
        toolCheck("git", ["git", "--version"], "fail"),
        ...forgeChecks(),
    ];
    const noMistakes = Bun.which("no-mistakes", { PATH: process.env.PATH ?? "" });
    checks.push(
        noMistakes
            ? { level: "ok", name: "no-mistakes", detail: noMistakes }
            : { level: "warn", name: "no-mistakes", detail: "not found (needed only for branch/PR gating)" },
    );

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
            if (fleet.length === 0)
                checks.push({ level: "ok", name: "fleet", detail: "no other machines in config/fleet.json" });
            for (const entry of fleet)
                checks.push({ level: entry.reachable ? "ok" : "warn", name: "fleet", detail: availabilityLine(entry) });
        } catch (error) {
            checks.push({
                level: "fail",
                name: "fleet",
                detail: error instanceof Error ? error.message : String(error),
            });
        }
    }

    const schedule = scheduleStatus();
    checks.push(
        schedule.installed && schedule.loaded
            ? { level: "ok", name: "scheduler", detail: `${schedule.scheduler} installed and loaded` }
            : {
                  level: "warn",
                  name: "scheduler",
                  detail: `${schedule.scheduler} ${schedule.installed ? "installed" : "not installed"}, ${schedule.loaded ? "loaded" : "not loaded"} (bin/toli schedule install)`,
              },
    );
    return checks;
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
