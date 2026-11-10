// A coordinator sandbox with a stubbed fleet (ssh, vm_stat), shared by the fleet and remote tests.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, SSH_STUB_ARGS, sandbox } from "./helpers.ts";

/** Thresholds loose enough that this test host is always available, whatever its real load and memory. */
export const ROOMY = { maxRuns: 50, maxLoadPerCpu: 1000, minMemAvailableMB: 0 };

/** 1 GiB "available" memory from a stubbed vm_stat, so memory never depends on the test host. */
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                               262144.
Pages active:                                  1.
Pages inactive:                                0.
Pages speculative:                             0.
Pages throttled:                               0.
Pages wired down:                              1.
Pages purgeable:                               0.`;

export const ENV = { TOLI_PLATFORM: "darwin" };

export function remoteSnapshot(machine: string, overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        machine,
        platform: "linux",
        cpus: 8,
        load1: 1,
        load5: 1,
        memTotalMB: 16000,
        memAvailableMB: 8000,
        diskFreeGB: 100,
        activeRuns: 0,
        maxRuns: 2,
        maxLoadPerCpu: 0.8,
        projects: [],
        available: true,
        reasons: [],
        at: "2026-10-29T00:00:00.000Z",
        queue: { queued: 0, active: 0, held: 0, jawansRunning: 0, jawansQueued: 0, depth: 0 },
        ...overrides,
    });
}

/**
 * Coordinator m1 with fleet machines m2 (answers `resources --json` with `m2Snapshot`) and m3 (ssh fails).
 * Every ssh invocation is appended to `.ssh.log`.
 */
export function fleet(m2Snapshot: string, capacity: Record<string, number> = ROOMY): Sandbox {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    const machinePath = join(box.root, "config", "machine.json");
    writeFileSync(machinePath, JSON.stringify({ ...JSON.parse(readFileSync(machinePath, "utf8")), capacity }));
    writeFileSync(
        join(box.root, "config", "fleet.json"),
        JSON.stringify({
            machines: [
                { name: "m1", ssh: "host1", root: "/srv/toli" },
                { name: "m2", ssh: "host2", root: "/srv/toli" },
                { name: "m3", ssh: "host3", root: "/srv/toli" },
            ],
        }),
    );
    writeFileSync(join(box.root, ".m2.json"), m2Snapshot);
    box.stub("vm_stat", `cat <<'EOF'\n${VM_STAT}\nEOF`);
    box.stub(
        "ssh",
        [
            `printf '%s\\n' "$*" >> "${join(box.root, ".ssh.log")}"`,
            SSH_STUB_ARGS,
            'case "$host" in',
            `  host2) case "$cmd" in *"resources --json"*) cat "${join(box.root, ".m2.json")}" ;; *) cat >/dev/null; echo "ran on m2" ;; esac ;;`,
            "  *) echo 'ssh: connect to host host3 port 22: Connection refused' >&2; exit 255 ;;",
            "esac",
        ].join("\n"),
    );
    return box;
}

export function sshLog(box: Sandbox): string {
    const path = join(box.root, ".ssh.log");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
}
