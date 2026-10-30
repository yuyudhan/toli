import { describe, expect, test } from "bun:test";
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
        box.ok(["inbox", "ack"]);
        expect(wake(box).items).toEqual([]);
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
