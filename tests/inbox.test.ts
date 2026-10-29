import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type Sandbox, sandbox } from "./helpers.ts";

type Item = { from: string; title: string; unseen: boolean; path: string; stamp: string };

const items = (box: Sandbox, ...flags: string[]): Item[] =>
    JSON.parse(box.ok(["inbox", "list", "--json", ...flags])) as Item[];

function deliver(box: Sandbox, from: string, title: string, now: string, body = "details"): string {
    return box.ok(["inbox", "add", "--from", from, "--title", title], { stdin: body, now });
}

describe("inbox", () => {
    test("items list oldest first with title and sender, all unseen", () => {
        const box = sandbox();
        deliver(box, "m2", "second", "2026-03-04T10:00:02Z");
        deliver(box, "m3", "first", "2026-03-04T10:00:01Z");
        expect(items(box).map((item) => [item.from, item.title, item.unseen])).toEqual([
            ["m3", "first", true],
            ["m2", "second", true],
        ]);
    });

    test("ack marks everything seen; later deliveries are unseen again", () => {
        const box = sandbox();
        deliver(box, "m2", "one", "2026-03-04T10:00:00Z");
        deliver(box, "m2", "two", "2026-03-04T10:01:00Z");
        expect(box.ok(["inbox", "ack"])).toBe("acknowledged 2 inbox items");
        expect(items(box, "--unseen")).toEqual([]);
        expect(items(box)).toHaveLength(2);
        expect(box.ok(["inbox", "list", "--unseen"])).toBe("inbox: nothing unseen");

        deliver(box, "m3", "three", "2026-03-04T10:02:00Z");
        expect(items(box, "--unseen").map((item) => item.title)).toEqual(["three"]);
        expect(box.ok(["inbox", "ack"])).toBe("acknowledged 1 inbox item");
        expect(box.ok(["inbox", "ack"])).toBe("acknowledged 0 inbox items");
    });

    test("two deliveries in the same millisecond from one sender both survive", () => {
        const box = sandbox();
        const first = deliver(box, "m2", "a", "2026-03-04T10:00:00.000Z", "body a");
        const second = deliver(box, "m2", "b", "2026-03-04T10:00:00.000Z", "body b");
        expect(first).not.toBe(second);
        expect(items(box).map((item) => item.title)).toEqual(["a", "b"]);
        expect(readFileSync(first, "utf8")).toContain("body a");
    });

    test("add rejects a missing title, an empty body, and an unsafe sender name", () => {
        const box = sandbox();
        expect(box.mate(["inbox", "add", "--from", "m2"], { stdin: "x" }).stderr).toContain("--title");
        expect(box.mate(["inbox", "add", "--from", "m2", "--title", "t"], { stdin: "  \n" }).stderr).toContain(
            "body on stdin",
        );
        expect(box.mate(["inbox", "add", "--from", "../etc", "--title", "t"], { stdin: "x" }).code).toBe(1);
        expect(box.ok(["inbox", "list"])).toBe("inbox: empty");
    });
});
