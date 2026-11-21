// An interactive Sardar that takes no wake (docs/sardars.md "A Sardar that stops taking its wakes"): once the oldest
// item still waiting for it is `lead.silentSessionMinutes` (default 20) old, the minute tick on a worker alerts the
// coordinator once per episode, and `lead status` says why. The session taking a wake ends the episode.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inbox, pair } from "./delegate-fixture.ts";
import type { Sandbox } from "./helpers.ts";

const T0 = "2026-11-11T08:32:00.000Z";
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const crontab = { TOLI_SCHEDULER: "crontab" };

function attach(box: Sandbox): void {
    writeFileSync(join(box.root, "state", "session.json"), JSON.stringify({ pid: process.pid, startedAt: T0 }));
}

function alerts(box: Sandbox): string[] {
    return inbox(box)
        .map((item) => item.title)
        .filter((title) => title.startsWith("Sardar on "));
}

type Status = { silent: Record<string, unknown> | null };

function status(box: Sandbox, now: string): Status {
    return JSON.parse(box.ok(["lead", "status", "--json"], { now, env: crontab })) as Status;
}

describe("an attached Sardar that takes no wake", () => {
    test("on a worker, alerts the coordinator once per episode, and lead status says why", () => {
        const { m1, m2 } = pair();
        m2.ok([
            "init",
            "--name",
            "m2",
            "--role",
            "worker",
            "--coordinator-ssh",
            "host1",
            "--coordinator-root",
            m1.root,
        ]);
        attach(m2);
        m2.ok(["inbox", "add", "--from", "m1", "--title", "chase"], { stdin: "where is T172?", now: at(1) });

        m2.ok(["job", "tick"], { now: at(15) });
        expect(alerts(m1)).toEqual([]);
        expect(status(m2, at(15)).silent).toBeNull();

        m2.ok(["job", "tick"], { now: at(22) });
        expect(alerts(m1)).toEqual(["Sardar on m2 silent 21 min, 1 wake pending"]);
        const [item] = inbox(m1).filter((entry) => entry.title.startsWith("Sardar on "));
        const body = readFileSync(item?.path ?? "", "utf8");
        expect(body).toContain(`its interactive session (pid ${process.pid})`);
        expect(body).toContain("bin/toli lead status");

        // The same episode never alerts twice.
        m2.ok(["inbox", "add", "--from", "m1", "--title", "chase again"], { stdin: "T172?", now: at(30) });
        m2.ok(["job", "tick"], { now: at(40) });
        expect(alerts(m1)).toHaveLength(1);
        expect(status(m2, at(40)).silent).toMatchObject({
            pid: process.pid,
            waiting: 2,
            waitingSince: "2026-11-11T08-33-00-000Z",
            minutes: 39,
            alertedTo: "m1",
            alertedAt: at(22),
        });
        expect(m2.ok(["lead", "status"], { now: at(40), env: crontab })).toContain(
            `silent: interactive session pid ${process.pid} has taken no wake for 39 min (2 waiting since 2026-11-11T08-33-00-000Z); m1 alerted at ${at(22)}`,
        );

        // The session takes its wakes: the episode ends; a later silence alerts again.
        const taken = JSON.parse(m2.ok(["wake", "--json", "--pid", String(process.pid)], { now: at(41) }));
        expect(taken.items).toHaveLength(2);
        m2.ok(["inbox", "ack", "--through", "2026-11-11T09-02-00-000Z"]);
        m2.ok(["job", "tick"], { now: at(42) });
        expect(status(m2, at(42)).silent).toBeNull();
        m2.ok(["inbox", "add", "--from", "m1", "--title", "later"], { stdin: "later", now: at(50) });
        m2.ok(["job", "tick"], { now: at(75) });
        expect(alerts(m1)).toEqual([
            "Sardar on m2 silent 21 min, 1 wake pending",
            "Sardar on m2 silent 25 min, 1 wake pending",
        ]);
    });

    test("on the coordinator, after lead.silentSessionMinutes, the tick logs it and status shows it; nothing is sent", () => {
        const { m1 } = pair();
        const file = join(m1.root, "config", "machine.json");
        writeFileSync(
            file,
            JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), lead: { silentSessionMinutes: 5 } }),
        );
        attach(m1);
        m1.ok(["inbox", "add", "--from", "m2", "--title", "result"], { stdin: "done", now: at(1) });
        m1.ok(["job", "tick"], { now: at(5) });
        expect(status(m1, at(5)).silent).toBeNull();
        m1.ok(["job", "tick"], { now: at(7) });
        expect(status(m1, at(7)).silent).toMatchObject({ waiting: 1, minutes: 6, alertedTo: null, alertedAt: at(7) });
        const log = readFileSync(join(m1.root, "logs", "tick.log"), "utf8");
        expect(log).toContain(
            `interactive session pid ${process.pid} has taken no wake for 6 min (1 waiting since 2026-11-11T08-33-00-000Z): this is the coordinator, nobody to alert`,
        );
        expect(alerts(m1)).toEqual([]);
    });
});
