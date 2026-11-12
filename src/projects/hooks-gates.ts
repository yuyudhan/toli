import { isGitRepo } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { ToliError, warn } from "../core/util.ts";
import type { Check } from "../setup/doctor.ts";
import { hookCheckLine, hookChecks } from "./hooks.ts";

/**
 * `bin/toli push`: the delivery promise is "push through the project's own hooks", so refuse when the repo declares a
 * pre-push hook git would not run (unless `noHooksOk`), and warn about any other declared hook that is not installed.
 */
export function requirePushHooks(project: string, dir: string, noHooksOk: boolean): void {
    const setup = `bin/toli project setup ${project}`;
    for (const check of hookChecks(dir)) {
        if (check.missing.length === 0) continue;
        const line = hookCheckLine(check, setup);
        if (check.missing.includes("pre-push") && !noHooksOk)
            throw new ToliError(
                `refusing to push ${project}: ${line}; the project's pre-push check would not run. Install it, or pass --no-hooks-ok to push without it`,
            );
        warn(`toli: ${line}`);
    }
}

/**
 * `bin/toli doctor`: one warning per declaration in a registered clone whose hooks git would not run, else one ok line;
 * nothing when no clone declares any.
 */
export function hooksDoctorChecks(projects: string[]): Check[] {
    const warnings: Check[] = [];
    let declaring = 0;
    for (const name of projects) {
        const dir = paths.projectDir(name);
        if (!isGitRepo(dir)) continue;
        const checks = hookChecks(dir);
        if (checks.length > 0) declaring += 1;
        for (const check of checks)
            if (check.missing.length > 0)
                warnings.push({
                    level: "warn",
                    name: "hooks",
                    detail: `${name}: ${hookCheckLine(check, `bin/toli project setup ${name}`)}`,
                });
    }
    if (warnings.length > 0 || declaring === 0) return warnings;
    const detail = `declared git hooks active in ${declaring} clone${declaring === 1 ? "" : "s"}`;
    return [{ level: "ok", name: "hooks", detail }];
}
