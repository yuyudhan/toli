// A lead found by its process, however it was started (docs/fleet.md "Oversight"): the records (the session
// extension's state/session.json, a `lead attach` marker, a headless turn) name only a lead toli started or that
// registered itself, and a lead started by hand in tmux after a reboot may be in none of them. A lead is a harness
// CLI (src/harness/harness.ts SPECS) whose working directory is the toli root, the way `fleet work` finds a lead pane
// (src/fleet/machine-script.ts LEAD_PANES_SH): the process is the CLI itself, or a runtime (`bun`, `node`) running its
// script. A harness process in the root that is no lead does not count (notALead). Read only; toli never signals it.
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { paths } from "../core/paths.ts";
import { platform, run } from "../core/util.ts";
import { SPECS } from "../harness/harness.ts";
import { procLink } from "./disk-proc.ts";

const RUNTIMES: readonly string[] = ["bun", "node"];
const PROBE_TIMEOUT_MS = 10_000;

function realOrSelf(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/**
 * The arguments after the harness CLI in a command line's `words`: the CLI is its program, or the script a runtime
 * runs (an argument naming the CLI's binary); null when the command line runs no harness CLI.
 */
function harnessArgs(words: readonly string[], binaries: readonly string[]): readonly string[] | null {
    const [program = "", ...rest] = words;
    const name = basename(program);
    if (binaries.includes(name)) return rest;
    if (!RUNTIMES.includes(name)) return null;
    const script = rest.findIndex((word) => binaries.includes(basename(word)));
    return script === -1 ? null : rest.slice(script + 1);
}

/**
 * Whether a harness's arguments mark a process no lead is, though it may run in the toli root: a headless run in
 * print mode (`-p`/`--print`, codex `exec`: a jawan, `bin/toli exec`, a scheduled job, the lead service's own turn,
 * src/harness/harness.ts headlessCommand), or an internal helper the CLI starts for itself (`omp __omp_worker_daemon`,
 * `omp __omp_worker_shell_process`), which keeps the working directory it started in and can outlive the lead (T2547).
 */
function notALead(args: readonly string[]): boolean {
    return args[0] === "exec" || args.some((arg) => arg === "-p" || arg === "--print" || arg.startsWith("__"));
}

/** The working directory of each of `pids` (Linux /proc, else lsof); a process that cannot be read is left out. */
function cwdsOf(pids: readonly string[]): Map<string, string> {
    const cwds = new Map<string, string>();
    if (platform() === "linux") {
        for (const pid of pids) {
            const cwd = procLink(pid, "cwd");
            if (cwd !== null) cwds.set(pid, cwd);
        }
        return cwds;
    }
    const listed = run(["lsof", "-a", "-d", "cwd", "-w", "-Fpn", "-p", pids.join(",")], { timeoutMs: 60_000 });
    let pid = "";
    for (const line of listed.stdout.split("\n")) {
        if (line.startsWith("p")) pid = line.slice(1);
        else if (line.startsWith("n")) cwds.set(pid, line.slice(1));
    }
    return cwds;
}

/** The pid of a lead harness process running in the toli root other than this one, or null when none runs. */
export function rootHarnessPid(): number | null {
    const listed = run(["ps", "-A", "-ww", "-o", "pid=,args="], { timeoutMs: PROBE_TIMEOUT_MS });
    if (listed.code !== 0) return null;
    const binaries = Object.values(SPECS).map((spec) => spec.binary);
    const me = String(process.pid);
    const candidates: string[] = [];
    for (const line of listed.stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (match === null) continue;
        const [, pid = "", command = ""] = match;
        if (pid === me) continue;
        const args = harnessArgs(command.trim().split(/\s+/), binaries);
        if (args !== null && !notALead(args)) candidates.push(pid);
    }
    if (candidates.length === 0) return null;
    const root = realOrSelf(paths.root());
    for (const [pid, cwd] of cwdsOf(candidates)) if (realOrSelf(cwd) === root) return Number(pid);
    return null;
}
