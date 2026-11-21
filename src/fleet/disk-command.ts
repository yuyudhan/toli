// `bin/toli disk`: the disk keeper by hand (src/fleet/disk.ts) and the low-disk alert (src/fleet/disk-alert.ts).
import { Args } from "../core/args.ts";
import { out, printJson, ToliError } from "../core/util.ts";
import { dryRun as envDryRun } from "../jobs/os-scheduler.ts";
import { outsideBuildLine, outsideBuilds, partialScanLines } from "./build-place.ts";
import { floorText, type KeepReport, keepDisk } from "./disk.ts";
import { diskAlertCommand } from "./disk-alert.ts";
import { describe, gb } from "./disk-state.ts";
import { watchKeeper } from "./disk-watchdog.ts";
import { fallbackSweep } from "./stale-sweep.ts";

/** `toli disk keep [--dry-run] [--floor <GB>] [--json] [--background]`, `toli disk alert`. */
export function diskCommand(argv: string[]): void {
    const [sub, ...rest] = argv;
    if (sub === "alert") {
        new Args(rest).maxPositional(0);
        diskAlertCommand();
        return;
    }
    if (sub !== "keep") {
        throw new ToliError(
            "usage: toli disk keep [--dry-run] [--floor <GB>] [--json] [--background] | toli disk alert",
        );
    }
    const args = new Args(rest, { booleans: ["dry-run", "json", "background"], values: ["floor"] });
    args.maxPositional(0);
    const number = (name: string): number | undefined => {
        const raw = args.str(name);
        if (raw === undefined) return undefined;
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) throw new ToliError(`--${name} must be a non-negative number`);
        return value;
    };
    const floorGB = number("floor");
    const json = args.bool("json");
    const dryRun = args.bool("dry-run");
    // The tick's detached keeper (disk-state.ts keepDiskDetached): nobody reads its lines, so it skips the stray scan.
    const background = args.bool("background");
    // Past its time limit a keeper stuck in a call that never returns is logged and stopped, never left hanging.
    const stopWatch = watchKeeper();
    try {
        keepAndReport(floorGB, json, dryRun, background);
    } finally {
        stopWatch();
    }
}

/**
 * `disk keep`'s run (by hand or the background keeper), its report and, unless `background`, the build folders outside
 * the clones. The background keeper never scans: its stdout goes nowhere, and on macOS reading the home folder can
 * block it for good (T2170).
 */
function keepAndReport(floorGB: number | undefined, json: boolean, dryRun: boolean, background: boolean): void {
    let report: KeepReport;
    try {
        report = keepDisk({
            dryRun,
            ...(floorGB === undefined ? {} : { floorGB }),
            echo: !json,
        });
    } catch (error) {
        const lines = fallbackSweep(error, !json, dryRun || envDryRun());
        if (json) printJson({ error: describe(error), fallback: lines });
        throw new ToliError(`disk keeper failed: ${describe(error)}; swept stale artifacts instead`);
    }
    const outside = background ? null : outsideBuilds();
    if (json) {
        printJson(
            outside === null
                ? report
                : {
                      ...report,
                      outsideBuilds: outside.found,
                      outsideScanComplete: outside.complete,
                      outsideScanUnanswered: outside.unanswered,
                  },
        );
    } else if (report.lines.length === 0) out(`free ${gb(report.freeBeforeGB)}, ${floorText(report)}: nothing to do`);
    if (!json && outside !== null) {
        for (const build of outside.found) out(`flagged, not deleted: ${outsideBuildLine(build)}`);
        for (const line of partialScanLines(outside)) out(`flagged, not deleted: ${line}`);
    }
    if (!json && !report.automatic) {
        out(
            "automatic deletion: off (capacity.diskKeep false); toli deletes only when `bin/toli disk keep` is run by hand",
        );
    }
}
