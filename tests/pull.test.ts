import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sshArgs } from "../src/core/config.ts";
import { BACKOFF_FIRST_MS, BACKOFF_MAX_MS, backoffMs } from "../src/jobs/reach.ts";
import { inProcess, type Sandbox, SSH_STUB_ARGS, sandbox, TOLI_BIN } from "./helpers.ts";

type Fleet = { machines: { name: string; ssh: string; root: string; inbound?: boolean }[] };
type Inbox = { title: string; from: string; path: string }[];
type PullReport = { pulled: number; applied: number; acked: number; held: string[]; errors: string[] };

/**
 * m1, the coordinator, takes no inbound ssh; m2 and m3 are its workers. Every machine's `ssh` stub appends
 * `<host> <command>` to its own `.ssh.log` and runs the remote `bin/toli ...` against the named machine's sandbox.
 * A `.<machine>-down` file in m1's root makes that machine unreachable at once, `.<machine>-timeout` only after the
 * call's ConnectTimeout (as a machine that is off is), and `.ack-down` makes `outbox ack` fail.
 */
type Fixture = { m1: Sandbox; m2: Sandbox; m3: Sandbox; flag: (name: string) => string };

function fixture(options: { flagOnWorkers?: boolean } = {}): Fixture {
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

function pull(box: Sandbox): PullReport {
    return JSON.parse(box.ok(["outbox", "pull", "--json"])) as PullReport;
}

function inbox(box: Sandbox): Inbox {
    return JSON.parse(box.ok(["inbox", "list", "--json"])) as Inbox;
}

function bodies(box: Sandbox): string[] {
    return inbox(box).map((item) => readFileSync(item.path, "utf8"));
}

function outbox(box: Sandbox): string[] {
    const dir = join(box.root, "state", "outbox");
    return existsSync(dir)
        ? readdirSync(dir)
              .filter((file) => file.endsWith(".json"))
              .sort()
        : [];
}

/** Why each item `box` gave up on was cancelled (state/outbox/cancelled/). */
function cancelledReasons(box: Sandbox): string[] {
    const rows = JSON.parse(box.ok(["outbox", "list", "--cancelled", "--json"])) as Array<{ reason: string }>;
    return rows.map((row) => row.reason);
}

/** Hosts this machine's ssh stub was called for (connection checks with `-G` / `-O` are not calls into a host). */
function sshHosts(box: Sandbox): string[] {
    const log = join(box.root, ".ssh.log");
    if (!existsSync(log)) return [];
    return readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "" && !line.startsWith("-"))
        .map((line) => line.split(" ")[0] ?? "");
}

/** Queue an outbox item on `box` by hand, as an older toli (or another sender) would leave it. */
function queue(box: Sandbox, file: string, item: Record<string, unknown>): void {
    mkdirSync(join(box.root, "state", "outbox"), { recursive: true });
    writeFileSync(join(box.root, "state", "outbox", file), JSON.stringify(item));
}

/** The calls `box` made to `host` that deliver an item or pull (the tick's fleet check makes its own ssh calls). */
function messageCalls(box: Sandbox, host: string): string[] {
    const log = join(box.root, ".ssh.log");
    if (!existsSync(log)) return [];
    return readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.startsWith(`${host} `) && /bin\/toli (inbox add|outbox pending)/.test(line));
}

/** Queue an inbox item from `from` on `box` for machine `to` per text, oldest first. */
function queueFor(box: Sandbox, from: string, to: { name: string; ssh: string; root: string }, texts: string[]): void {
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

function tickLog(box: Sandbox): string {
    const log = join(box.root, "logs", "tick.log");
    return existsSync(log) ? readFileSync(log, "utf8") : "";
}

function reachState(box: Sandbox): Record<string, { failures: number; retryAt: number; error: string }> {
    const file = join(box.root, "state", "reach.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

describe("a machine that takes no inbound ssh pulls its messages (T954)", () => {
    test("a worker never ssh-es into it: talk, delegate, answers, results, fleet reads and doctor", () => {
        const { m2 } = fixture();
        expect(m2.ok(["talk", "m1", "hello"])).toContain("queued for m1, which pulls its messages");
        const brief = join(m2.root, "brief.md");
        writeFileSync(brief, "TOLI_BRIEF v1\n# no-op\n");
        expect(m2.ok(["delegate", "m1", "do a thing", "--brief", brief])).toContain("which pulls its messages");
        expect(m2.ok(["task", "answer", "m1/T1", "yes"])).toContain("answer for m1/T1 queued for m1");
        m2.ok(["job", "tick"]);
        m2.toli(["digest", "--fleet"]);
        m2.toli(["task", "list", "--fleet"]);
        m2.toli(["fleet", "status"]);
        expect(m2.ok(["fleet", "sync"])).toContain("m1 takes no inbound ssh");
        const talk = m2.toli(["talk", "m1"]);
        expect(talk.code).not.toBe(0);
        expect(talk.stderr).toContain("m1 takes no inbound ssh");
        const doctor = m2.toli(["doctor"]);
        const lines = doctor.stdout.split("\n").filter((line) => /\boutbox\b|\bm1\b/.test(line));
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) expect(line).not.toMatch(/^\s*(warn|fail)|\bunreachable\b|ssh host1/i);
        expect(outbox(m2)).toHaveLength(3);
        expect(sshHosts(m2)).not.toContain("host1");
        inProcess(m2.root, () => expect(() => sshArgs("host1")).toThrow("m1 takes no inbound ssh"));
    });

    test("each item is applied once, in order, and a delegation's answer comes back with the ack", () => {
        const { m1, m2 } = fixture();
        m2.ok(["talk", "m1", "first"]);
        m2.ok(["talk", "m1", "second"]);
        const brief = join(m2.root, "brief.md");
        writeFileSync(brief, "TOLI_BRIEF v1\n# no-op\n");
        m2.ok(["delegate", "m1", "do a thing", "--brief", brief]);
        // Names that sort against their queue order: the queue order wins.
        queue(m2, "a-job.json", {
            from: "m2",
            title: "job nightly",
            body: "the result\n",
            queuedAt: Date.now() + 1000,
        });
        queue(m2, "z-early.json", { from: "m2", title: "early", body: "queued first\n", queuedAt: 1 });
        const report = pull(m1);
        expect(report).toEqual({ pulled: 5, applied: 5, acked: 5, held: [], errors: [] });
        const texts = bodies(m1).join("\n---\n");
        const order = ["queued first", "first", "second", "the result"].map((text) => texts.indexOf(text));
        expect(order.every((index) => index >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        const tasks = JSON.parse(m1.ok(["task", "list", "--json"])) as { id: string; title: string }[];
        expect(tasks.map((task) => task.title)).toEqual(["do a thing"]);
        expect(outbox(m2)).toEqual([]);
        expect(inbox(m2).map((item) => item.title)).toContain("delegated m1/T1: do a thing");
        const before = inbox(m1).length;
        expect(pull(m1)).toEqual({ pulled: 0, applied: 0, acked: 0, held: [], errors: [] });
        expect(inbox(m1)).toHaveLength(before);
        expect(sshHosts(m2)).not.toContain("host1");
    });

    test("a lost ack is retried without applying the item twice", () => {
        const { m1, m2, flag } = fixture();
        m2.ok(["talk", "m1", "only once"]);
        writeFileSync(flag("ack-down"), "1");
        const failed = pull(m1);
        expect(failed).toMatchObject({ pulled: 1, applied: 1, acked: 0 });
        expect(failed.errors.join("\n")).toContain("m2: ack not sent");
        expect(outbox(m2)).toHaveLength(1);
        expect(readdirSync(join(m1.root, "state", "pulled"))).toEqual(["m2.json"]);
        rmSync(flag("ack-down"));
        expect(pull(m1)).toEqual({ pulled: 1, applied: 0, acked: 1, held: [], errors: [] });
        expect(bodies(m1).filter((body) => body.includes("only once"))).toHaveLength(1);
        expect(outbox(m2)).toEqual([]);
        expect(existsSync(join(m1.root, "state", "pulled", "m2.json"))).toBe(false);
    });

    test("an item the puller refuses is cancelled once with the reason, and the sender's later items still apply", () => {
        const { m1, m2 } = fixture();
        queue(m2, "1-broken.json", {
            from: "m2",
            title: "broken",
            body: "",
            to: { name: "m1", ssh: "host1", root: m1.root },
            queuedAt: 1,
        });
        queue(m2, "2-after.json", { from: "m2", title: "after", body: "comes second\n", queuedAt: 2 });
        const first = pull(m1);
        expect(first).toMatchObject({ pulled: 2, applied: 1, acked: 2 });
        expect(first.errors.join("\n")).toContain(
            "m2 1-broken.json: refused: inbox add needs the message body on stdin",
        );
        expect(inbox(m1).map((item) => item.title)).toEqual(["after"]);
        expect(outbox(m2)).toEqual([]);
        expect(cancelledReasons(m2)).toEqual(["m1 refused it: inbox add needs the message body on stdin"]);
        expect(pull(m1)).toEqual({ pulled: 0, applied: 0, acked: 0, held: [], errors: [] });
    });

    test("an item claiming another sender is refused, never applied, and its sender cancels it", () => {
        const { m1, m2 } = fixture();
        queue(m2, "spoof.json", { from: "m3", title: "message from m3", body: "not really\n", queuedAt: 1 });
        const report = pull(m1);
        expect(report).toMatchObject({ pulled: 1, applied: 0, acked: 1 });
        expect(report.errors.join("\n")).toContain("m2 spoof.json: refused: it claims to be from m3");
        expect(inbox(m1)).toEqual([]);
        expect(outbox(m2)).toEqual([]);
        expect(cancelledReasons(m2)).toEqual(["m1 refused it: it claims to be from m3"]);
    });

    test("an offline worker keeps its items for a later pull; the others still arrive", () => {
        const { m1, m2, m3, flag } = fixture();
        m2.ok(["talk", "m1", "from m2"]);
        m3.ok(["talk", "m1", "from m3"]);
        writeFileSync(flag("m3-down"), "1");
        const report = pull(m1);
        expect(report).toMatchObject({ pulled: 1, applied: 1, acked: 1 });
        expect(report.errors.join("\n")).toContain("m3: ssh host3 exited 255");
        expect(outbox(m3)).toHaveLength(1);
        rmSync(flag("m3-down"));
        expect(pull(m1)).toEqual({ pulled: 1, applied: 1, acked: 1, held: [], errors: [] });
        expect(bodies(m1).join("\n")).toContain("from m3");
        expect(outbox(m3)).toEqual([]);
    });

    test("the pull carries the fleet list, so a worker learns the flag without ssh into the coordinator", () => {
        const { m1, m2 } = fixture({ flagOnWorkers: false });
        pull(m1);
        const fleet = JSON.parse(readFileSync(join(m2.root, "config", "fleet.json"), "utf8")) as Fleet;
        expect(fleet.machines.find((machine) => machine.name === "m1")).toEqual({
            name: "m1",
            ssh: "host1",
            root: m1.root,
            inbound: false,
        });
        rmSync(join(m2.root, ".ssh.log"), { force: true });
        expect(m2.ok(["talk", "m1", "after the flag"])).toContain("which pulls its messages");
        expect(sshHosts(m2)).not.toContain("host1");
    });

    test("the minute tick pulls on the machine that takes no inbound ssh, and m1's own sends still use ssh", () => {
        const { m1, m2 } = fixture();
        m2.ok(["talk", "m1", "via the tick"]);
        m1.ok(["job", "tick"]);
        expect(bodies(m1).join("\n")).toContain("via the tick");
        expect(m1.ok(["talk", "m2", "reply"])).toContain("sent to m2's lead");
        expect(bodies(m2).join("\n")).toContain("reply");
    });
});

describe("the tick's messaging pass with machines that are down (T979)", () => {
    const T0 = Date.parse("2026-11-11T10:00:00Z");
    const at = (ms: number) => new Date(T0 + ms).toISOString();

    test("a host is tried once per pass: after its first failure its other items wait, in order", () => {
        const { m1, m2, m3, flag } = fixture();
        const to3 = { name: "m3", ssh: "host3", root: m3.root };
        writeFileSync(flag("m3-down"), "1");
        // A worker's delivery: three items for m3, one ssh call.
        queueFor(m2, "m2", to3, ["first", "second", "third"]);
        m2.ok(["job", "tick"]);
        expect(messageCalls(m2, "host3")).toHaveLength(1);
        expect(outbox(m2)).toEqual(["m3-0.json", "m3-1.json", "m3-2.json"]);
        expect(tickLog(m2)).toContain("2 items for host3 left queued: failed earlier in this pass");
        // The coordinator: the pull finds m3 down, so its delivery to m3 makes no call at all, and m2's still goes.
        queueFor(m1, "m1", to3, ["a", "b"]);
        queueFor(m1, "m1", { name: "m2", ssh: "host2", root: m2.root }, ["for m2"]);
        m1.ok(["job", "tick"]);
        expect(messageCalls(m1, "host3")).toHaveLength(1);
        expect(messageCalls(m1, "host3")[0]).toContain("outbox pending");
        expect(outbox(m1)).toEqual(["m3-0.json", "m3-1.json"]);
        expect(bodies(m2).join("\n")).toContain("for m2");
    });

    test("a host that is down is backed off across ticks, doubling up to 10 minutes, and comes back", () => {
        expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs)).toEqual([
            30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000,
        ]);
        expect(BACKOFF_FIRST_MS).toBe(30_000);
        expect(BACKOFF_MAX_MS).toBe(600_000);
        const { m2, m3, flag } = fixture();
        writeFileSync(flag("m3-down"), "1");
        queueFor(m2, "m2", { name: "m3", ssh: "host3", root: m3.root }, ["first", "second"]);
        m2.ok(["job", "tick"], { now: at(0) });
        expect(reachState(m2).host3).toMatchObject({ failures: 1, retryAt: T0 + 30_000 });
        m2.ok(["job", "tick"], { now: at(20_000) });
        expect(messageCalls(m2, "host3")).toHaveLength(1);
        expect(tickLog(m2)).toContain("2 items for host3 left queued: unreachable 1 time in a row; next try in 10 s");
        m2.ok(["job", "tick"], { now: at(31_000) });
        expect(messageCalls(m2, "host3")).toHaveLength(2);
        expect(reachState(m2).host3).toMatchObject({ failures: 2, retryAt: T0 + 91_000 });
        m2.ok(["job", "tick"], { now: at(90_000) });
        expect(messageCalls(m2, "host3")).toHaveLength(2);
        rmSync(flag("m3-down"));
        m2.ok(["job", "tick"], { now: at(91_000) });
        expect(messageCalls(m2, "host3")).toHaveLength(4);
        expect(inbox(m3).map((item) => item.title)).toEqual(["first", "second"]);
        expect(reachState(m2)).toEqual({});
    });

    test("a hand-run pull still tries a machine the tick backs off", () => {
        const { m1, m2 } = fixture();
        m2.ok(["talk", "m1", "while backed off"]);
        const reach = { host2: { failures: 3, retryAt: Date.now() + 600_000, error: "ssh: timed out" } };
        writeFileSync(join(m1.root, "state", "reach.json"), JSON.stringify(reach));
        expect(pull(m1)).toEqual({ pulled: 1, applied: 1, acked: 1, held: [], errors: [] });
        expect(reachState(m1)).toEqual({});
    });

    test("a machine that takes its whole ConnectTimeout does not hold up the others' items", () => {
        const { m1, m2, m3, flag } = fixture();
        m2.ok(["talk", "m1", "from m2"]);
        m3.ok(["talk", "m1", "from m3"]);
        writeFileSync(flag("m3-timeout"), "1");
        const start = Date.now();
        const report = pull(m1);
        const end = Date.now();
        expect(report).toMatchObject({ pulled: 1, applied: 1, acked: 1 });
        expect(report.errors.join("\n")).toContain("m3: ssh host3 exited 255");
        // The pull's ConnectTimeout is short (5 s, not 15 s).
        expect(end - start).toBeGreaterThanOrEqual(5000);
        expect(end - start).toBeLessThan(15_000);
        // m2's message was in m1's inbox while m3's connection still waited.
        const item = inbox(m1).find((entry) => entry.from === "m2");
        expect(item).toBeDefined();
        expect(end - statSync(item?.path ?? "").mtimeMs).toBeGreaterThan(2000);
        expect(outbox(m3)).toHaveLength(1);
        // The tick backs m3 off: after one tick that waits on it, the next pulls m2 without waiting on m3 again.
        m1.ok(["job", "tick"]);
        m2.ok(["talk", "m1", "again from m2"]);
        const next = Date.now();
        m1.ok(["job", "tick"]);
        expect(Date.now() - next).toBeLessThan(5000);
        expect(bodies(m1).join("\n")).toContain("again from m2");
        expect(tickLog(m1)).toContain("1 machine(s) held back");
    }, 60_000);

    test("overlapping ticks and pulls still apply and deliver each item exactly once", async () => {
        const { m1, m2 } = fixture();
        const fromM2 = ["T979 pulled 1", "T979 pulled 2", "T979 pulled 3"];
        const fromM1 = ["T979 delivered 1", "T979 delivered 2", "T979 delivered 3"];
        for (const text of fromM2) m2.ok(["talk", "m1", text]);
        queueFor(m1, "m1", { name: "m2", ssh: "host2", root: m2.root }, fromM1);
        const runs = await Promise.all([
            m1.toliAsync(["job", "tick"]),
            m1.toliAsync(["job", "tick"]),
            m1.toliAsync(["outbox", "pull"]),
        ]);
        for (const run of runs) expect(run.code).toBe(0);
        m1.ok(["job", "tick"]);
        const atM1 = bodies(m1);
        for (const text of fromM2) expect(atM1.filter((body) => body.includes(text))).toHaveLength(1);
        const atM2 = bodies(m2);
        for (const text of fromM1) expect(atM2.filter((body) => body.includes(text))).toHaveLength(1);
        expect(outbox(m1)).toEqual([]);
        expect(outbox(m2)).toEqual([]);
        expect(existsSync(join(m1.root, "state", "pulled", "m2.json"))).toBe(false);
    }, 60_000);
});
