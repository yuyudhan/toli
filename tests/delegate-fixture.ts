// Two real machines for delegation tests (tests/delegate.test.ts, tests/delegation-sync.test.ts).
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, SSH_STUB_ARGS, sandbox, TOLI_BIN } from "./helpers.ts";

export type Task = {
    id: string;
    status: string;
    project: string;
    agent?: string;
    notes: string[];
    delegatedBy?: { machine: string; task?: string; id: string; upstream?: { machine: string; task: string }[] };
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

/** A Pair whose m3 is a real machine too. */
export type Trio = Pair & { m3: Sandbox };

function machines(count: 2 | 3): Pair & { m3?: Sandbox } {
    const boxes = Array.from({ length: count }, () => sandbox());
    const [m1, m2, m3] = boxes as [Sandbox, Sandbox, Sandbox | undefined];
    const roots: Record<string, string> = Object.fromEntries(boxes.map((box, index) => [`host${index + 1}`, box.root]));
    const flag = (machine: string) => join(m1.root, `.${machine}-down`);
    const fleet = JSON.stringify({
        machines: [
            { name: "m1", ssh: "host1", root: m1.root },
            { name: "m2", ssh: "host2", root: m2.root },
            { name: "m3", ssh: "host3", root: m3?.root ?? "/srv/toli" },
        ],
    });
    for (const [index, box] of boxes.entries()) {
        box.ok(["init", "--name", `m${index + 1}`, "--role", "coordinator"]);
        writeFileSync(join(box.root, "config", "fleet.json"), fleet);
        box.stub(
            "ssh",
            [
                SSH_STUB_ARGS,
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
        ...(m3 === undefined ? {} : { m3 }),
        down: (machine = "m2") => writeFileSync(flag(machine), "1"),
        up: (machine = "m2") => rmSync(flag(machine), { force: true }),
    };
}

export function pair(): Pair {
    return machines(2);
}

/** Three real machines, m1, m2 and m3, for work forwarded from one to the next. */
export function trio(): Trio {
    const { m3, ...rest } = machines(3);
    if (m3 === undefined) throw new Error("trio() needs a third machine");
    return { ...rest, m3 };
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
