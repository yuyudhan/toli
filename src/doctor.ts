import { Args } from "./args.ts";
import { hasMachine, loadMachine } from "./config.ts";
import { isGitRepo } from "./git.ts";
import { paths } from "./paths.ts";
import { fleetStatus } from "./pick.ts";
import { loadProjects } from "./projects.ts";
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

export async function runChecks(): Promise<Check[]> {
    const checks: Check[] = [
        { level: "ok", name: "bun", detail: `${Bun.version} (${process.execPath})` },
        toolCheck("omp", ["omp", "--version"], "fail"),
        toolCheck("git", ["git", "--version"], "fail"),
    ];
    const gh = run(["gh", "auth", "status"], { timeoutMs: 20_000 });
    checks.push(
        gh.code === 127
            ? { level: "warn", name: "gh-auth", detail: "gh not found (needed only for PRs)" }
            : gh.code === 0
              ? { level: "ok", name: "gh-auth", detail: "authenticated" }
              : { level: "warn", name: "gh-auth", detail: `not authenticated: ${firstLine(gh.stderr || gh.stdout)}` },
    );
    const noMistakes = Bun.which("no-mistakes", { PATH: process.env.PATH ?? "" });
    checks.push(
        noMistakes
            ? { level: "ok", name: "no-mistakes", detail: noMistakes }
            : { level: "warn", name: "no-mistakes", detail: "not found (needed only for branch/PR gating)" },
    );

    if (!hasMachine()) {
        checks.push({ level: "fail", name: "machine", detail: "config/machine.json missing: run bin/mate init" });
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
                  detail: `${schedule.scheduler} ${schedule.installed ? "installed" : "not installed"}, ${schedule.loaded ? "loaded" : "not loaded"} (bin/mate schedule install)`,
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
