// The three-machine fleet the pull tests share (tests/pull.test.ts, tests/pull-only.test.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, SSH_STUB_ARGS, sandbox, TOLI_BIN } from "./helpers.ts";

export type Fleet = { machines: { name: string; ssh: string; root: string; inbound?: boolean }[] };
export type Inbox = { title: string; from: string; path: string }[];
export type PullReport = { pulled: number; applied: number; acked: number; held: string[]; errors: string[] };

/**
 * m1, the coordinator, takes no inbound ssh; m2 and m3 are its workers. Every machine's `ssh` stub appends
 * `<host> <command>` to its own `.ssh.log` and runs the remote `bin/toli ...` against the named machine's sandbox.
 * A `.<machine>-down` file in m1's root makes that machine unreachable at once, `.<machine>-timeout` only after the
 * call's ConnectTimeout (as a machine that is off is), and `.ack-down` makes `outbox ack` fail.
 */
export type Fixture = { m1: Sandbox; m2: Sandbox; m3: Sandbox; flag: (name: string) => string };

export function fixture(options: { flagOnWorkers?: boolean } = {}): Fixture {
    const m1 = sandbox();
    const m2 = sandbox();
    const m3 = sandbox();
    const flag = (name: string) => join(m1.root, `.${name}`);
    const roots: Record<string, string> = { host1: m1.root, host2: m2.root, host3: m3.root };
    const fleet = (inbound: boolean): Fleet => ({
        machines: [
            { name: "m1", ssh: "host1", root: m1.root, ...(inbound ? {} : { inbound: false }) },
            { name: "m2", ssh: "host2", root: m2.root },
            { name: "m3", ssh: "host3", root: m3.root },
        ],
    });
    m1.ok(["init", "--name", "m1", "--role", "coordinator"]);
    for (const [name, box] of [
        ["m2", m2],
        ["m3", m3],
    ] as const)
        box.ok([
            "init",
            "--name",
            name,
            "--role",
            "worker",
            "--coordinator-ssh",
            "host1",
            "--coordinator-root",
            m1.root,
        ]);
    writeFileSync(join(m1.root, "config", "fleet.json"), JSON.stringify(fleet(false)));
    for (const box of [m2, m3])
        writeFileSync(join(box.root, "config", "fleet.json"), JSON.stringify(fleet(options.flagOnWorkers === false)));
    for (const box of [m1, m2, m3])
        box.stub(
            "ssh",
            [
                SSH_STUB_ARGS,
                `printf '%s %s\\n' "$host" "$cmd" >> "${join(box.root, ".ssh.log")}"`,
                `name=m$(printf '%s' "$host" | sed 's/^host//')`,
                `if [ -e "${m1.root}/.$name-down" ]; then echo "ssh: connect to host $host: Connection refused" >&2; exit 255; fi`,
                `if [ -e "${m1.root}/.$name-timeout" ]; then delay=15; for arg in "$@"; do case "$arg" in ConnectTimeout=*) delay="\${arg#ConnectTimeout=}" ;; esac; done; sleep "$delay"; echo "ssh: connect to host $host port 22: Operation timed out" >&2; exit 255; fi`,
                `case "$cmd" in *"outbox ack"*) if [ -e "${flag("ack-down")}" ]; then echo "ssh: broken pipe" >&2; exit 255; fi ;; esac`,
                'case "$host" in',
                ...Object.entries(roots).map(([host, root]) => `  ${host}) root="${root}" ;;`),
                '  *) echo "ssh: connect to host $host port 22: Connection refused" >&2; exit 255 ;;',
                "esac",
                `cmd=$(printf '%s' "$cmd" | sed "s#bin/toli #'${process.execPath}' '${TOLI_BIN}' #")`,
                'TOLI_ROOT="$root" exec sh -c "$cmd"',
            ].join("\n"),
        );
    return { m1, m2, m3, flag };
}

export function pull(box: Sandbox): PullReport {
    return JSON.parse(box.ok(["outbox", "pull", "--json"])) as PullReport;
}

export function inbox(box: Sandbox): Inbox {
    return JSON.parse(box.ok(["inbox", "list", "--json"])) as Inbox;
}

export function bodies(box: Sandbox): string[] {
    return inbox(box).map((item) => readFileSync(item.path, "utf8"));
}

export function outbox(box: Sandbox): string[] {
    const dir = join(box.root, "state", "outbox");
    return existsSync(dir)
        ? readdirSync(dir)
              .filter((file) => file.endsWith(".json"))
              .sort()
        : [];
}

/** Why each item `box` gave up on was cancelled (state/outbox/cancelled/). */
export function cancelledReasons(box: Sandbox): string[] {
    const rows = JSON.parse(box.ok(["outbox", "list", "--cancelled", "--json"])) as Array<{ reason: string }>;
    return rows.map((row) => row.reason);
}

/** Hosts this machine's ssh stub was called for (connection checks with `-G` / `-O` are not calls into a host). */
export function sshHosts(box: Sandbox): string[] {
    const log = join(box.root, ".ssh.log");
    if (!existsSync(log)) return [];
    return readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "" && !line.startsWith("-"))
        .map((line) => line.split(" ")[0] ?? "");
}

/** Queue an outbox item on `box` by hand, as an older toli (or another sender) would leave it. */
export function queue(box: Sandbox, file: string, item: Record<string, unknown>): void {
    mkdirSync(join(box.root, "state", "outbox"), { recursive: true });
    writeFileSync(join(box.root, "state", "outbox", file), JSON.stringify(item));
}

/** The calls `box` made to `host` that deliver an item or pull (the tick's fleet check makes its own ssh calls). */
export function messageCalls(box: Sandbox, host: string): string[] {
    const log = join(box.root, ".ssh.log");
    if (!existsSync(log)) return [];
    return readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.startsWith(`${host} `) && /bin\/toli (inbox add|outbox pending)/.test(line));
}

/** Queue an inbox item from `from` on `box` for machine `to` per text, oldest first. */
export function queueFor(
    box: Sandbox,
    from: string,
    to: { name: string; ssh: string; root: string },
    texts: string[],
): void {
    for (const [index, text] of texts.entries())
        queue(box, `${to.name}-${index}.json`, {
            from,
            title: text,
            body: `${text}\n`,
            to,
            kind: "inbox",
            queuedAt: index + 1,
        });
}

export function tickLog(box: Sandbox): string {
    const log = join(box.root, "logs", "tick.log");
    return existsSync(log) ? readFileSync(log, "utf8") : "";
}

export function reachState(box: Sandbox): Record<string, { failures: number; retryAt: number; error: string }> {
    const file = join(box.root, "state", "reach.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}
