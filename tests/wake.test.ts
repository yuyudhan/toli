import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox } from "./helpers.ts";

type Wake = { items: { kind: string; title: string; body: string }[]; message: string };

const wake = (box: Sandbox): Wake => JSON.parse(box.ok(["wake", "--json"])) as Wake;

function coordinator(): Sandbox {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    return box;
}

function deliver(box: Sandbox, title: string, now: string, body = "details"): void {
    box.ok(["inbox", "add", "--from", "m2", "--title", title], { stdin: body, now });
}

function finishJob(box: Sandbox, now: string, body: string): void {
    box.ok(["job", "add", "nightly", "--cron", "0 3 * * *", "--prompt", "x"], { now });
    runJob(box, now, body);
}

/** One more run of the already added `nightly` job, finished with `body`. */
function runJob(box: Sandbox, now: string, body: string): void {
    const begun = JSON.parse(box.ok(["job", "begin", "nightly", "--via", "headless", "--json"], { now })) as {
        runId: string;
    };
    box.ok(["job", "finish", "nightly", begun.runId], { stdin: body, now });
}

describe("wake", () => {
    test("delivers inbox items and job results oldest first, each exactly once", () => {
        const box = coordinator();
        deliver(box, "remote run done", "2026-03-04T10:00:00Z", "remote body");
        finishJob(box, "2026-03-04T10:01:00Z", "job body");
        const first = wake(box);
        expect(first.items.map((item) => [item.kind, item.title])).toEqual([
            ["inbox", "m2: remote run done"],
            ["job", "job nightly (ok)"],
        ]);
        expect(first.message).toContain("remote body");
        expect(first.message).toContain("job body");
        expect(wake(box)).toEqual({ items: [], message: "" });
        expect(box.ok(["wake"])).toBe("nothing new");

        deliver(box, "later", "2026-03-04T10:02:00Z");
        expect(wake(box).items.map((item) => item.title)).toEqual(["m2: later"]);
    });

    test("delivery does not acknowledge: the digest still lists items until ack", () => {
        const box = coordinator();
        deliver(box, "one", "2026-03-04T10:00:00Z");
        wake(box);
        expect((JSON.parse(box.ok(["inbox", "list", "--unseen", "--json"])) as unknown[]).length).toBe(1);
    });

    test("items already acknowledged never wake", () => {
        const box = coordinator();
        deliver(box, "old", "2026-03-04T10:00:00Z");
        box.ok(["inbox", "list"]);
        box.ok(["inbox", "ack"]);
        expect(wake(box).items).toEqual([]);
    });

    test("inbox ack covers only what the wake showed: a message arriving after it stays unread and wakes next", () => {
        const box = coordinator();
        deliver(box, "A", "2026-03-04T10:00:00Z");
        const shown = wake(box);
        expect(shown.items.map((item) => item.title)).toEqual(["m2: A"]);
        deliver(box, "B", "2026-03-04T10:01:00Z");
        expect(box.ok(["inbox", "ack"])).toBe(
            "acknowledged 1 inbox item; 1 newer inbox item not shown yet, still unread",
        );
        const unseen = JSON.parse(box.ok(["inbox", "list", "--unseen", "--json"])) as { title: string }[];
        expect(unseen.map((item) => item.title)).toEqual(["B"]);
        expect(wake(box).items.map((item) => item.title)).toEqual(["m2: B"]);
    });

    test("job ack covers only what the wake showed: a result finishing after it stays unread and wakes next", () => {
        const box = coordinator();
        finishJob(box, "2026-03-04T10:00:00Z", "first run");
        expect(wake(box).items.map((item) => item.title)).toEqual(["job nightly (ok)"]);
        runJob(box, "2026-03-04T11:00:00Z", "second run");
        expect(box.ok(["job", "ack"])).toBe(
            "acknowledged 1 job result; 1 newer job result not shown yet, still unread",
        );
        expect((JSON.parse(box.ok(["job", "results", "--unseen", "--json"])) as unknown[]).length).toBe(1);
        const next = wake(box);
        expect(next.items).toHaveLength(1);
        expect(next.items[0]?.body).toContain("second run");
    });

    test("items unread at upgrade wake the lead once and ack normally", () => {
        const box = coordinator();
        deliver(box, "before upgrade", "2026-03-04T10:00:00Z");
        finishJob(box, "2026-03-04T10:01:00Z", "old job");
        const inboxStamp = (JSON.parse(box.ok(["inbox", "list", "--json"])) as { stamp: string }[])[0]?.stamp ?? "";
        const jobStamp = (JSON.parse(box.ok(["job", "results", "--json"])) as { stamp: string }[])[0]?.stamp ?? "";
        // A toli without shown marks had delivered both and recorded only that.
        writeFileSync(
            join(box.root, "state", "acks.json"),
            JSON.stringify({ inboxDelivered: inboxStamp, jobsDelivered: jobStamp }),
        );
        expect(wake(box).items.map((item) => item.title)).toEqual(["m2: before upgrade", "job nightly (ok)"]);
        expect(wake(box).items).toEqual([]);
        expect(box.ok(["inbox", "ack"])).toBe("acknowledged 1 inbox item");
        expect(box.ok(["job", "ack"])).toBe("acknowledged 1 job result");
        expect(wake(box).items).toEqual([]);
    });

    test("the wake ends with ack commands through the newest item of each stream it shows", () => {
        const box = coordinator();
        deliver(box, "A", "2026-03-04T10:00:00Z");
        finishJob(box, "2026-03-04T10:01:00Z", "job body");
        const { message } = wake(box);
        const inboxStamp = (JSON.parse(box.ok(["inbox", "list", "--json"])) as { stamp: string }[])[0]?.stamp;
        const jobStamp = (JSON.parse(box.ok(["job", "results", "--json"])) as { stamp: string }[])[0]?.stamp;
        expect(message.split("\n").slice(-2)).toEqual([
            `    bin/toli inbox ack --through ${inboxStamp}`,
            `    bin/toli job ack --through ${jobStamp}`,
        ]);
    });

    test("a large backlog shows ten bodies and lists the rest by path", () => {
        const box = coordinator();
        for (let index = 0; index < 12; index++)
            deliver(box, `item ${index}`, `2026-03-04T10:${String(index).padStart(2, "0")}:00Z`, `body ${index}`);
        const { items, message } = wake(box);
        expect(items).toHaveLength(12);
        expect(message).toContain("body 9");
        expect(message).not.toContain("body 10");
        expect(message).toContain("- m2: item 11 - data/inbox/");
    });
});
