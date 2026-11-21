import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { calls, deliver, lead, once } from "./lead-stub.ts";

/** When the interactive session in the idle-session test registered (on a Linux worker, 2026-11-11). */
const T0 = "2026-11-11T08:32:00.000Z";

describe("lead run --once", () => {
    test("one headless turn per batch of wake items, resuming the conversation it left", () => {
        const setup = lead();
        const { box, sessions } = setup;
        deliver(box, "delegated T1 from m2: first", "first body");
        once(box);
        const [first] = calls(setup);
        expect(first).toStartWith("-p\n--wait-async\n");
        expect(first).toContain(`--session-dir\n${sessions}\n`);
        expect(first).not.toContain("--resume");
        expect(first).toContain("[toli lead m1] headless turn");
        expect(first).toContain("first body");
        expect(first).toContain("bin/toli spawn --task T<n> --brief <file>");

        once(box);
        expect(calls(setup)).toHaveLength(1);

        deliver(box, "message from m2", "second body");
        once(box);
        const second = calls(setup)[1] ?? "";
        expect(second).toContain(`--resume\n${join(sessions, "conversation.jsonl")}\n`);
        expect(second).toContain("second body");
        expect(second).not.toContain("first body");

        const state: unknown = JSON.parse(readFileSync(join(box.root, "state", "lead", "state.json"), "utf8"));
        expect(state).toMatchObject({ turns: 2, lastExit: 0, pid: null, ompPid: null });
        expect(existsSync(join(box.root, "state", "lead", "pending.md"))).toBe(false);
        const log = readFileSync(join(box.root, "logs", "lead.log"), "utf8");
        expect(log).toContain("lead turn 1 done");
        expect(log).toContain("lead turn 2 done");
    });

    test("a failed turn keeps its wake in pending.md and the next pass sends it again", () => {
        const setup = lead();
        const { box } = setup;
        const pending = join(box.root, "state", "lead", "pending.md");
        writeFileSync(join(box.root, ".fail"), "");
        deliver(box, "delegated T1 from m2: build", "build body");
        once(box);
        expect(readFileSync(pending, "utf8")).toContain("build body");
        expect(readFileSync(join(box.root, "logs", "lead.log"), "utf8")).toContain("lead turn 1 exited 1");

        rmSync(join(box.root, ".fail"));
        once(box);
        const [, retry] = calls(setup);
        expect(retry).toContain("build body");
        expect(existsSync(pending)).toBe(false);
    });

    test("the turn runs marked headless, and on a full machine its prompt says to delegate instead of spawning", () => {
        const setup = lead();
        const { box } = setup;
        deliver(box, "message from m2", "first body");
        once(box);
        box.ok(["lead", "full", "--reason", "coordination only"]);
        deliver(box, "message from m2", "second body");
        once(box);
        const [first, second] = calls(setup);
        expect(first).not.toContain("start no jawan here");
        expect(second).toContain(
            "This machine is full: coordination only (until lead full --clear): start no jawan here",
        );
        expect(readFileSync(join(box.root, ".turn-env"), "utf8")).toBe("headless\nheadless\n");
    });

    test("a live interactive session makes the pass skip and take nothing", () => {
        const setup = lead();
        const { box } = setup;
        writeFileSync(
            join(box.root, "state", "session.json"),
            JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        );
        deliver(box, "message from m2", "hello");
        once(box);
        expect(calls(setup)).toHaveLength(0);
        const wake = JSON.parse(box.ok(["wake", "--json"])) as { items: unknown[] };
        expect(wake.items).toHaveLength(1);
    });

    test("an interactive session stuck at a prompt still holds the inbox: no headless turn, however long its wakes stay unread", () => {
        const setup = lead();
        const { box } = setup;
        const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
        const session = join(box.root, "state", "session.json");
        writeFileSync(session, JSON.stringify({ pid: process.pid, startedAt: T0 }));
        box.ok(["inbox", "add", "--from", "m2", "--title", "message from m2"], { stdin: "stuck body", now: at(1) });
        // The session's extension took the item and pushed it into its chat, but the session sits at a prompt.
        expect((JSON.parse(box.ok(["wake", "--json"], { now: at(2) })) as { items: unknown[] }).items).toHaveLength(1);
        const file = join(box.root, "config", "machine.json");
        writeFileSync(
            file,
            JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), lead: { idleSessionMinutes: 90 } }),
        );
        for (const minutes of [30, 92, 600]) box.ok(["lead", "run", "--once"], { now: at(minutes) });
        expect(calls(setup)).toHaveLength(0);
        expect(existsSync(join(box.root, "state", "lead", "pending.md"))).toBe(false);
        // The session is flagged for the user, never stopped and never stood in for: its record stays.
        expect(existsSync(session)).toBe(true);
        const digest = JSON.parse(box.ok(["digest", "--json"], { now: at(92) })) as { idleSession?: unknown };
        expect(digest.idleSession).toEqual({
            pid: process.pid,
            startedAt: T0,
            unreadSince: "2026-11-11T08-33-00-000Z",
            minutes: 90,
        });
        expect(box.ok(["digest"], { now: at(92) })).toContain(
            `idle session: pid ${process.pid} has left wakes unread since 2026-11-11T08-33-00-000Z (over 90 min); its wakes wait for it (attend or close that session)`,
        );

        // Once the session closes, the next new item wakes a headless turn.
        rmSync(session);
        box.ok(["inbox", "add", "--from", "m2", "--title", "later"], { stdin: "later body", now: at(601) });
        box.ok(["lead", "run", "--once"], { now: at(602) });
        expect(calls(setup)[0]).toContain("later body");
    });

    test("only the session holding the record takes wakes: a second interactive omp takes none", () => {
        const setup = lead();
        const { box } = setup;
        writeFileSync(
            join(box.root, "state", "session.json"),
            JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        );
        deliver(box, "message from m2", "hello");
        const take = (pid: number): unknown[] =>
            (JSON.parse(box.ok(["wake", "--json", "--pid", String(pid)])) as { items: unknown[] }).items;
        expect(take(process.ppid)).toHaveLength(0);
        expect(take(process.pid)).toHaveLength(1);
    });

    test("a conversation pinned to a removed model is retired and a fresh one takes the pending wake", () => {
        const setup = lead();
        const { box, sessions } = setup;
        deliver(box, "message from m2", "first body");
        once(box);
        const file = join(box.root, "config", "machine.json");
        writeFileSync(
            file,
            JSON.stringify({
                ...JSON.parse(readFileSync(file, "utf8")),
                harness: { models: { omp: "anthropic/claude-opus-5" } },
            }),
        );
        writeFileSync(join(box.root, ".pinned"), "");
        deliver(box, "message from m2", "second body");
        once(box);
        const [, failed, fresh] = calls(setup);
        expect(failed).toContain(`--resume\n${join(sessions, "conversation.jsonl")}\n`);
        expect(fresh).not.toContain("--resume");
        expect(fresh).toContain("--model\nanthropic/claude-opus-5\n");
        expect(fresh).toContain("second body");
        expect(existsSync(join(sessions, "retired", "conversation.jsonl"))).toBe(true);
        const state: unknown = JSON.parse(readFileSync(join(box.root, "state", "lead", "state.json"), "utf8"));
        expect(state).toMatchObject({ turns: 2, lastExit: 0 });
        expect(existsSync(join(box.root, "state", "lead", "pending.md"))).toBe(false);
        const log = readFileSync(join(box.root, "logs", "lead.log"), "utf8");
        expect(log).toContain(
            `lead turn 2: ${join(sessions, "conversation.jsonl")} is pinned to anthropic/claude-sonnet-5, which omp cannot restore; retired to ${join(sessions, "retired")}, starting a fresh lead conversation on anthropic/claude-opus-5 with the pending wake`,
        );
        expect(log).toContain("lead turn 2 done");
    });

    test("a turn already running elsewhere holds the inbox: the pass skips and the session's wake waits for it", () => {
        const setup = lead();
        const { box } = setup;
        mkdirSync(join(box.root, "state", "lead"), { recursive: true });
        const state = join(box.root, "state", "lead", "state.json");
        writeFileSync(state, JSON.stringify({ turns: 3, pid: process.pid, ompPid: null }));
        // An interactive session opened while the headless turn runs.
        writeFileSync(
            join(box.root, "state", "session.json"),
            JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        );
        deliver(box, "message from m2", "hello");
        once(box);
        expect(calls(setup)).toHaveLength(0);
        const take = (): unknown[] =>
            (JSON.parse(box.ok(["wake", "--json", "--pid", String(process.pid)])) as { items: unknown[] }).items;
        expect(take()).toHaveLength(0);
        writeFileSync(state, JSON.stringify({ turns: 4, pid: null, ompPid: null }));
        expect(take()).toHaveLength(1);
    });

    test("a turn record whose processes are gone, or whose pid now names a later process, is cleared and holds nothing", () => {
        const setup = lead();
        const { box } = setup;
        mkdirSync(join(box.root, "state", "lead"), { recursive: true });
        const state = join(box.root, "state", "lead", "state.json");
        const gone = Bun.spawnSync(["true"]).pid;
        // A record a reboot left behind: its pid now belongs to a process started after the record was written.
        const reused = Bun.spawn(["sleep", "60"]);
        try {
            writeFileSync(state, JSON.stringify({ turns: 450, lastExit: 1, pid: reused.pid, ompPid: gone }));
            const hourAgo = new Date(Date.now() - 3_600_000);
            utimesSync(state, hourAgo, hourAgo);
            const session = join(box.root, "state", "session.json");
            writeFileSync(session, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
            deliver(box, "message from m2", "hello");
            // The interactive session takes its wake: the dead record holds nothing.
            const wake = JSON.parse(box.ok(["wake", "--json", "--pid", String(process.pid)])) as { items: unknown[] };
            expect(wake.items).toHaveLength(1);
            const status = JSON.parse(box.ok(["lead", "status", "--json"], { env: { TOLI_SCHEDULER: "crontab" } }));
            expect(status).toMatchObject({ turnPid: null, interactivePid: process.pid });

            // The next pass clears the record and says so; with the session closed, a headless turn runs.
            rmSync(session);
            deliver(box, "later from m2", "later body");
            once(box);
            const log = readFileSync(join(box.root, "logs", "lead.log"), "utf8");
            expect(log).toContain(
                `lead turn record named pid ${reused.pid} (omp pid ${gone}), which no longer runs: cleared`,
            );
            expect(calls(setup)[0]).toContain("later body");
            expect(JSON.parse(readFileSync(state, "utf8"))).toMatchObject({ turns: 451, pid: null, ompPid: null });
        } finally {
            reused.kill();
        }
    });

    test('under lead.dispatch "subagents" the turn starts no jawan, and what it leaves unacked wakes the interactive session', () => {
        const setup = lead();
        const { box } = setup;
        const file = join(box.root, "config", "machine.json");
        writeFileSync(
            file,
            JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), lead: { dispatch: "subagents" } }),
        );
        deliver(box, "delegated T1 from m2: build", "build body");
        once(box);
        const [first] = calls(setup);
        expect(first).toContain("Start no jawan in this turn");
        expect(first).toContain('`lead.dispatch: "subagents"`');
        expect(first).toContain("Acknowledge only what you settled");
        expect(first).not.toContain("bin/toli spawn --task T<n> --brief <file>");
        expect(first).toContain("build body");

        // The turn acked nothing (the stub runs no command): the next pass takes nothing new...
        once(box);
        expect(calls(setup)).toHaveLength(1);
        // ...and the interactive session is still woken by the item, once.
        const wake = JSON.parse(box.ok(["wake", "--json"])) as { items: { body: string }[] };
        expect(wake.items).toHaveLength(1);
        expect(wake.items[0]?.body).toContain("build body");
        expect((JSON.parse(box.ok(["wake", "--json"])) as { items: unknown[] }).items).toHaveLength(0);

        // An item the turn acknowledges never reaches the interactive session.
        deliver(box, "message from m2", "settled body");
        once(box);
        expect(calls(setup)[1]).toContain("settled body");
        const shown = JSON.parse(box.ok(["inbox", "list", "--json"])) as { stamp: string }[];
        box.ok(["inbox", "ack", "--through", shown.at(-1)?.stamp ?? ""]);
        expect((JSON.parse(box.ok(["wake", "--json"])) as { items: unknown[] }).items).toHaveLength(0);
    });
});
