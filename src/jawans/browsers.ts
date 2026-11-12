// Automation browsers a jawan run leaves open. A jawan that drives a browser (Playwright, Puppeteer, a DevTools MCP
// server, a screenshot script) often starts one that outlives its harness: launched detached into its own process
// group, it is reparented once its launcher exits, so it no longer descends from the harness. While a run's harness
// lives, the supervisor samples the run's process tree (src/jawans/stop.ts stopTargets) and remembers every
// automation browser in it by pid and start time; when the harness exits, it stops those still alive, each with its
// own tree. Where /proc exists (Linux), a process that inherited the run's `TOLI_RUN_ID` belongs to the run too, so a
// browser started and orphaned between two samples is still found.
//
// Only the run's own processes are ever signalled, and among them only automation browsers: a browser binary
// (Chrome, Chromium, its headless shell, Edge, Brave, Firefox) started with an automation flag (remote debugging,
// headless, --enable-automation, marionette) or a throwaway profile (`--user-data-dir` under a temp dir). A browser
// on the user's default profile is never touched, even one a jawan opened, and nothing outside the run's tree is.
import { readdirSync, readFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename } from "node:path";
import { run, warn } from "../core/util.ts";
import { procFile } from "../fleet/resources.ts";
import { type Identities, parseRows, SAME_START_MS, type StopRoot, stopTargets, stopTree } from "./stop.ts";

/** How often a run's process tree is sampled for automation browsers, per real minute of run time (60 000 ms). */
const BROWSER_SAMPLE_MS = 10_000;

/** After SIGTERM, how long a leftover browser gets before SIGKILL. */
const BROWSER_STOP_GRACE_MS = 5_000;
const PS_TIMEOUT_MS = 20_000;
const PS_ARGV = ["ps", "-A", "-o", "pid=,ppid=,pgid=,stat=,etime=,args="];

const BROWSER_BINARY = /chrom(?:e|ium)|headless[_ -]shell|msedge|microsoft edge|brave|firefox/i;
const AUTOMATION_FLAG =
    /(?:^|\s)(?:--?remote-debugging-(?:port|pipe)|--?headless|--enable-automation|--?marionette)(?:[=\s]|$)/;
const PROFILE_FLAG = /(?:^|\s)--user-data-dir=(\S+)/;
const HELPER_FLAG = /(?:^|\s)--type=/;
const TEMP_DIRS = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];

/** A profile dir under the OS temp dir: one an automation tool made for this launch, never the user's own. */
function throwawayProfile(dir: string): boolean {
    const temp = tmpdir();
    return [temp.endsWith("/") ? temp : `${temp}/`, ...TEMP_DIRS].some((prefix) => dir.startsWith(prefix));
}

/**
 * Whether the `ps` command line `args` is an automation browser: a browser binary (the executable before the first
 * flag) started with an automation flag or a throwaway profile. Chrome's helper processes (`--type=...`) are not
 * browsers of their own: they go with their browser's tree.
 */
export function automationBrowser(args: string): boolean {
    const binary = basename(args.split(/\s-/, 1)[0] ?? "");
    if (!BROWSER_BINARY.test(binary) || HELPER_FLAG.test(args)) return false;
    if (AUTOMATION_FLAG.test(args)) return true;
    const profile = PROFILE_FLAG.exec(args)?.[1];
    return profile !== undefined && throwawayProfile(profile);
}

/** Linux: the pids whose environment carries `TOLI_RUN_ID=<runId>`, i.e. the run started them; empty without /proc. */
export function markedPids(runId: string): number[] {
    let entries: string[];
    try {
        entries = readdirSync(procFile(""));
    } catch {
        return [];
    }
    const variable = Buffer.from(`TOLI_RUN_ID=${runId}\0`);
    const separated = Buffer.from(`\0TOLI_RUN_ID=${runId}\0`);
    const marked: number[] = [];
    for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        let environ: Buffer;
        try {
            environ = readFileSync(procFile(`${entry}/environ`));
        } catch {
            continue; // Gone, or not ours to read.
        }
        if (environ.subarray(0, variable.length).equals(variable) || environ.includes(separated))
            marked.push(Number(entry));
    }
    return marked;
}

/**
 * The automation browsers among the run's processes in `psOutput` (`ps -A -o pid=,ppid=,pgid=,stat=,etime=,args=`
 * taken at `nowMs`), as roots: browsers whose parent is not one too. The run's processes are `root`'s tree as
 * stopTargets finds it with the identities in `tree` (each found one is added to `tree`, so a process orphaned since
 * stays known), plus the `marked` pids.
 */
export function runBrowsers(
    psOutput: string,
    nowMs: number,
    root: StopRoot,
    tree: Identities,
    marked: number[],
): Identities {
    const rows = parseRows(psOutput, nowMs);
    const mine = stopTargets(psOutput, nowMs, root, tree);
    for (const pid of marked) {
        const row = rows.get(pid);
        if (row !== undefined && !row.zombie) mine.set(pid, row.startMs);
    }
    for (const [pid, startMs] of mine) tree.set(pid, startMs);
    const browsers = new Set([...mine.keys()].filter((pid) => automationBrowser(rows.get(pid)?.args ?? "")));
    const roots: Identities = new Map();
    for (const pid of browsers) {
        const parent = rows.get(pid)?.ppid ?? 0;
        const startMs = mine.get(pid);
        if (!browsers.has(parent) && startMs !== undefined) roots.set(pid, startMs);
    }
    return roots;
}

export type BrowserWatch = {
    /**
     * Stop sampling, then stop the run's automation browsers still alive, noting them in the run's log (`logFd`).
     * Call once the harness has exited. A failure is only warned about: it never changes the run's outcome.
     */
    finish: (logFd: number) => Promise<void>;
};

/**
 * Watch the run (`runId`) whose harness is `root` for automation browsers, sampling every 10 run-seconds (a run
 * minute lasts `minuteMs`, shortened in tests). Its `finish` closes them when the harness is done.
 */
export function watchBrowsers(root: StopRoot, runId: string, minuteMs: number): BrowserWatch {
    const tree: Identities = new Map();
    const browsers: Identities = new Map();
    const sample = (marked: number[]): Identities | null => {
        const ps = run(PS_ARGV, { timeoutMs: PS_TIMEOUT_MS });
        if (ps.code !== 0) return null;
        const nowMs = Date.now();
        for (const [pid, startMs] of runBrowsers(ps.stdout, nowMs, root, tree, marked)) browsers.set(pid, startMs);
        return new Map([...parseRows(ps.stdout, nowMs)].map(([pid, row]) => [pid, row.startMs]));
    };
    const timer = setInterval(() => sample([]), Math.max(50, Math.round((BROWSER_SAMPLE_MS * minuteMs) / 60_000)));
    timer.unref();
    const close = async (): Promise<{ closed: number[]; survivors: number[] }> => {
        clearInterval(timer);
        const live = sample(markedPids(runId));
        if (live === null) return { closed: [], survivors: [] };
        const open = [...browsers].filter(([pid, startMs]) => {
            const liveStart = live.get(pid);
            return liveStart !== undefined && Math.abs(liveStart - startMs) < SAME_START_MS;
        });
        const survivors = await Promise.all(
            open.map(([pid, startMs]) =>
                stopTree({ pid, spawnedAtMs: startMs }, BROWSER_STOP_GRACE_MS, { unreaped: false }),
            ),
        );
        return { closed: open.map(([pid]) => pid), survivors: survivors.flat() };
    };
    return {
        finish: async (logFd) => {
            try {
                const { closed, survivors } = await close();
                if (closed.length > 0)
                    writeSync(
                        logFd,
                        `\n[toli] closed the automation browser(s) the run left open: pid ${closed.join(", ")}\n`,
                    );
                if (survivors.length > 0)
                    writeSync(logFd, `\n[toli] browser pid ${survivors.join(", ")} outlived SIGKILL\n`);
            } catch (error) {
                warn(
                    `closing the browsers of ${runId} failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        },
    };
}
