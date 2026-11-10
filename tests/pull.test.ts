import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sshArgs } from "../src/core/config.ts";
import { inProcess, type Sandbox, SSH_STUB_ARGS, sandbox, TOLI_BIN } from "./helpers.ts";

type Fleet = { machines: { name: string; ssh: string; root: string; inbound?: boolean }[] };
type Inbox = { title: string; from: string; path: string }[];
type PullReport = { pulled: number; applied: number; acked: number; errors: string[] };

/**
 * m1, the coordinator, takes no inbound ssh; m2 and m3 are its workers. Every machine's `ssh` stub appends
 * `<host> <command>` to its own `.ssh.log` and runs the remote `bin/toli ...` against the named machine's sandbox.
 * A `.<machine>-down` file in m1's root makes that machine unreachable; `.ack-down` makes `outbox ack` fail.
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
    return existsSync(dir) ? readdirSync(dir).sort() : [];
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
        expect(report).toEqual({ pulled: 5, applied: 5, acked: 5, errors: [] });
        const texts = bodies(m1).join("\n---\n");
        const order = ["queued first", "first", "second", "the result"].map((text) => texts.indexOf(text));
        expect(order.every((index) => index >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        const tasks = JSON.parse(m1.ok(["task", "list", "--json"])) as { id: string; title: string }[];
        expect(tasks.map((task) => task.title)).toEqual(["do a thing"]);
        expect(outbox(m2)).toEqual([]);
        expect(inbox(m2).map((item) => item.title)).toContain("delegated m1/T1: do a thing");
        const before = inbox(m1).length;
        expect(pull(m1)).toEqual({ pulled: 0, applied: 0, acked: 0, errors: [] });
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
        expect(pull(m1)).toEqual({ pulled: 1, applied: 0, acked: 1, errors: [] });
        expect(bodies(m1).filter((body) => body.includes("only once"))).toHaveLength(1);
        expect(outbox(m2)).toEqual([]);
        expect(existsSync(join(m1.root, "state", "pulled", "m2.json"))).toBe(false);
    });

    test("an item that fails to apply holds the sender's later items until it applies", () => {
        const { m1, m2 } = fixture();
        queue(m2, "1-broken.json", {
            from: "m2",
            title: "broken",
            body: "",
            to: { name: "m1", ssh: "host1", root: m1.root },
            queuedAt: 1,
        });
        queue(m2, "2-after.json", { from: "m2", title: "after", body: "comes second\n", queuedAt: 2 });
        const failed = pull(m1);
        expect(failed).toMatchObject({ pulled: 2, applied: 0, acked: 0 });
        expect(failed.errors.join("\n")).toContain("m2 1-broken.json: bin/toli inbox add exited");
        expect(inbox(m1)).toEqual([]);
        expect(outbox(m2)).toEqual(["1-broken.json", "2-after.json"]);
        queue(m2, "1-broken.json", {
            from: "m2",
            title: "broken",
            body: "fixed\n",
            to: { name: "m1", ssh: "host1", root: m1.root },
            queuedAt: 1,
        });
        expect(pull(m1)).toEqual({ pulled: 2, applied: 2, acked: 2, errors: [] });
        expect(inbox(m1).map((item) => item.title)).toEqual(["broken", "after"]);
    });

    test("an item claiming another sender is dropped, never applied", () => {
        const { m1, m2 } = fixture();
        queue(m2, "spoof.json", { from: "m3", title: "message from m3", body: "not really\n", queuedAt: 1 });
        const report = pull(m1);
        expect(report).toMatchObject({ pulled: 1, applied: 0, acked: 1 });
        expect(report.errors.join("\n")).toContain("m2 spoof.json: refused and dropped: it claims to be from m3");
        expect(inbox(m1)).toEqual([]);
        expect(outbox(m2)).toEqual([]);
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
        expect(pull(m1)).toEqual({ pulled: 1, applied: 1, acked: 1, errors: [] });
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
