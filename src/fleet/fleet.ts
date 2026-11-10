// `bin/toli init` (this machine's config/machine.json) and `bin/toli sync` (bring this checkout, or every fleet
// machine's, up to date). `remote` and `exec` live in src/fleet/remote.ts.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Args } from "../core/args.ts";
import {
    inboundOff,
    inboundOffText,
    loadMachine,
    type Machine,
    machineSettings,
    otherFleetMachines,
    remoteToliCommand,
    sshArgs,
} from "../core/config.ts";
import { currentBranch, git } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { out, requireName, run, ToliError, warn, writeJsonAtomic } from "../core/util.ts";
import { runHook, seedLocal } from "../helpers/local.ts";
import { activeRuntime, syncRuntime } from "../release/runtime.ts";
import { upgradeCommand } from "../release/upgrade.ts";

export function initCommand(argv: string[]): void {
    const args = new Args(argv, { values: ["name", "role", "coordinator-ssh", "coordinator-root"] });
    args.maxPositional(0);
    const name = requireName("machine", args.str("name"));
    const role = args.str("role");
    if (role !== "coordinator" && role !== "worker") throw new ToliError("--role must be coordinator or worker");
    const coordinatorSsh = args.str("coordinator-ssh");
    const coordinatorRoot = args.str("coordinator-root");
    // Re-running init (e.g. setup resuming half-done) keeps every other setting: capacity, harness, retention.
    const machine: Machine = { ...machineSettings(), name, role };
    delete machine.coordinator;
    if (role === "worker") {
        if (!coordinatorSsh || !coordinatorRoot)
            throw new ToliError("a worker needs --coordinator-ssh <host> --coordinator-root <path>");
        machine.coordinator = { ssh: coordinatorSsh, root: coordinatorRoot };
    } else if (coordinatorSsh || coordinatorRoot) {
        throw new ToliError("--coordinator-ssh/--coordinator-root apply to workers only");
    }
    for (const dir of ["config", "data", "state", "logs", "projects"])
        mkdirSync(join(paths.root(), dir), { recursive: true });
    writeJsonAtomic(paths.machine(), machine);
    if (!existsSync(paths.fleet())) writeJsonAtomic(paths.fleet(), { machines: [] });
    seedLocal();
    out(
        `initialized ${name} as ${role}${machine.coordinator ? ` (coordinator ${machine.coordinator.ssh}:${machine.coordinator.root})` : ""}`,
    );
    runHook("post-init");
}

/**
 * Bring this checkout up to date. A development clone (on a branch) pulls fast-forward; a release install (detached
 * HEAD, at a vX.Y.Z tag) follows release tags, so it upgrades to the latest one instead (`bin/toli upgrade`).
 */
async function syncLocal(): Promise<number> {
    const root = paths.root();
    const name = loadMachine().name;
    if (currentBranch(root) === null) {
        out(`${name}: release install (detached HEAD): bin/toli upgrade`);
        return await upgradeCommand([]);
    }
    const dirty = git(root, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty.code !== 0) throw new ToliError(`git status failed in ${root}: ${dirty.stderr.trim()}`);
    if (dirty.stdout.trim() !== "")
        throw new ToliError(`refusing to sync: ${root} has uncommitted changes:\n${dirty.stdout.trimEnd()}`);
    const pull = git(root, ["pull", "--ff-only"]);
    if (pull.code !== 0)
        throw new ToliError(`git pull --ff-only failed (not a fast-forward?): ${(pull.stderr || pull.stdout).trim()}`);
    out(`${name}: ${pull.stdout.trim() || "up to date"}`);
    // The live session runs the installed runtime (src/release/runtime.ts): move it to the pulled code.
    if (activeRuntime(root) !== null) {
        try {
            out(`${name}: runtime ${syncRuntime(root).commit.slice(0, 12)}`);
        } catch (error) {
            warn(
                `toli: pulled, but the runtime stays on the previous commit: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    return 0;
}

export async function syncCommand(argv: string[]): Promise<number> {
    const args = new Args(argv, { booleans: ["all"] });
    args.maxPositional(0);
    const local = await syncLocal();
    if (local !== 0 || !args.bool("all")) return local;
    let failures = 0;
    for (const machine of otherFleetMachines()) {
        if (inboundOff(machine)) {
            out(`${machine.name}: skipped: ${inboundOffText(machine)}; run bin/toli sync there`);
            continue;
        }
        // A release install's sync is an upgrade (fetch, migrate, harness sync, runtime snapshot): allow it time.
        const result = run([...sshArgs(machine.ssh, 15), remoteToliCommand(machine.root, "sync")], {
            timeoutMs: 300_000,
        });
        if (result.code === 0) {
            out(result.stdout.trimEnd() || `${machine.name}: synced`);
        } else {
            failures += 1;
            warn(`${machine.name}: sync failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`);
        }
    }
    return failures === 0 ? 0 : 1;
}
