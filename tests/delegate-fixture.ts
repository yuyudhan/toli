// Two real machines for delegation tests (tests/delegate.test.ts, tests/delegation-sync.test.ts).
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox, TOLI_BIN } from "./helpers.ts";

export type Task = {
    id: string;
    status: string;
    project: string;
    agent?: string;
    notes: string[];
    delegatedBy?: { machine: string; task?: string; id: string };
    delegatedTo?: string[];
    delegates?: Record<string, { status: string; question?: string; options?: { choice: string }[]; commit?: string }>;
    heldFrom?: string;
    question?: string;
    options?: { choice: string; outcome: string }[];
    commit?: string;
    report?: string;
};
export type FleetList = {
    machine: string;
    local: boolean;
    fetchedAt: string | null;
    error?: string;
    tasks: { fleetId: string }[];
}[];
export type InboxItem = { title: string; path: string };

/**
 * Two real machines, m1 and m2, each a sandbox of its own, and m3 that never answers. Their `ssh` stub runs the
 * remote `bin/toli ...` command against the named machine's sandbox, so a delegation really crosses machines.
 * `down(machine)` makes that machine unreachable (m2 by default) until `up(machine)`.
 */
export type Pair = {
    m1: Sandbox;
    m2: Sandbox;
    down: (machine?: string) => void;
    up: (machine?: string) => void;
};

export function pair(): Pair {
    const m1 = sandbox();
    const m2 = sandbox();
    const roots: Record<string, string> = { host1: m1.root, host2: m2.root };
    const flag = (machine: string) => join(m1.root, `.${machine}-down`);
    const fleet = JSON.stringify({
        machines: [
            { name: "m1", ssh: "host1", root: m1.root },
            { name: "m2", ssh: "host2", root: m2.root },
            { name: "m3", ssh: "host3", root: "/srv/toli" },
        ],
    });
    for (const [name, box] of [
        ["m1", m1],
        ["m2", m2],
    ] as const) {
        box.ok(["init", "--name", name, "--role", "coordinator"]);
        writeFileSync(join(box.root, "config", "fleet.json"), fleet);
        box.stub(
            "ssh",
            [
                'host="$5"; cmd="$6"',
                `if [ -e "${m1.root}/.m$(printf '%s' "$host" | sed 's/^host//')-down" ]; then echo "ssh: connect to host $host: Connection refused" >&2; exit 255; fi`,
                'case "$host" in',
                ...Object.entries(roots).map(([host, root]) => `  ${host}) root="${root}" ;;`),
                '  *) echo "ssh: connect to host $host port 22: Connection refused" >&2; exit 255 ;;',
                "esac",
                `cmd=$(printf '%s' "$cmd" | sed "s#bin/toli #'${process.execPath}' '${TOLI_BIN}' #")`,
                'TOLI_ROOT="$root" exec sh -c "$cmd"',
            ].join("\n"),
        );
    }
    return {
        m1,
        m2,
        down: (machine = "m2") => writeFileSync(flag(machine), "1"),
        up: (machine = "m2") => rmSync(flag(machine), { force: true }),
    };
}

export function tasks(box: Sandbox): Task[] {
    return JSON.parse(box.ok(["task", "list", "--json"])) as Task[];
}

export function inbox(box: Sandbox): InboxItem[] {
    return JSON.parse(box.ok(["inbox", "list", "--json"])) as InboxItem[];
}

export function brief(box: Sandbox, text = "TOLI_BRIEF v1\n# no-op\nReply done.\n"): string {
    const file = join(box.root, "brief.md");
    writeFileSync(file, text);
    return file;
}
