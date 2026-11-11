// What `bin/toli upgrade` does for the OS services (docs/install.md "Upgrading"): once the checkout has moved, each
// service this machine already has installed, the lead service and the tick, is installed again by the new code, so
// its unit is current and it is enabled and running. Only what was installed is touched, and nothing is stopped for
// good. The lead unit stops only its own process (`KillMode=process`, src/fleet/lead-service.ts), so that restart
// leaves every running supervisor and jawan alone.
import { existsSync } from "node:fs";
import { leadServiceStatus, leadUnitPath } from "../fleet/lead-service.ts";
import { osScheduler } from "../jobs/os-scheduler.ts";
import { scheduleStatus, tickUnitFiles } from "../jobs/schedule.ts";

/** The `bin/toli` calls that refresh the installed services, and what was left alone and why. */
export type ServiceRefresh = { steps: string[][]; notes: string[] };

/**
 * The refresh for this machine, judged by the scheduler `bin/toli` reaches from this shell. Over ssh without a
 * reachable `systemctl --user` it resolves to crontab, where systemd units on disk are invisible: installing from
 * there would add a crontab line beside units that still exist, so those units are named and left as they are.
 */
export function serviceRefresh(): ServiceRefresh {
    const steps: string[][] = [];
    if (leadServiceStatus().installed) steps.push(["lead", "install"]);
    if (scheduleStatus().installed) steps.push(["schedule", "install"]);
    const notes: string[] = [];
    if (osScheduler() === "crontab") {
        const units = [leadUnitPath(), tickUnitFiles().timer].filter((file) => existsSync(file));
        if (units.length > 0)
            notes.push(
                `systemd units exist (${units.join(", ")}) but \`systemctl --user\` is not reachable from this shell, ` +
                    "so the services were left as they are; run bin/toli lead install and bin/toli schedule install from a login shell",
            );
    }
    return { steps, notes };
}
