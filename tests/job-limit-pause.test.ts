import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox } from "./helpers.ts";

describe("job limit pause", () => {
    // The line a scheduled run captured when its provider's limit named a reset about 41 hours away.
    const LIMIT = "429 rate_limit_error ... retry-after-ms=147223000";

    function limitedBox(line = LIMIT): Sandbox {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        box.ok(["job", "add", "train", "--cron", "*/30 * * * *", "--prompt", "train", "--shape", "ship"], {
            now: "2026-11-15T10:50:00Z",
        });
        box.stub(
            "omp",
            [
                `echo call >> "${join(box.root, "omp-calls")}"`,
                `if [ -e "${join(box.root, "omp-ok")}" ]; then echo "trained"; exit 0; fi`,
                `echo 'Error: ${line}'`,
                "exit 1",
            ].join("\n"),
        );
        return box;
    }

    const calls = (box: Sandbox): number => {
        const file = join(box.root, "omp-calls");
        return existsSync(file) ? readFileSync(file, "utf8").trimEnd().split("\n").length : 0;
    };
    const notices = (box: Sandbox): string[] =>
        (JSON.parse(box.ok(["inbox", "list", "--json"])) as { title: string }[])
            .map((item) => item.title)
            .filter((title) => title.includes("paused"));
    const statuses = (box: Sandbox): string[] =>
        (JSON.parse(box.ok(["job", "results", "--json"])) as { status: string }[]).map((result) => result.status);

    test("a named reset skips the next due ticks with one notice, and the job runs again after the reset", () => {
        const box = limitedBox();
        box.ok(["job", "run-due"], { now: "2026-11-15T11:00:10Z" });
        expect(calls(box)).toBe(1);
        // The failure itself still posts as a result.
        expect(statuses(box)).toEqual(["failed"]);
        const reset = new Date(new Date("2026-11-15T11:00:10Z").getTime() + 147_223_000);

        box.ok(["job", "run-due"], { now: "2026-11-15T11:30:10Z" });
        expect(calls(box)).toBe(1);
        const posted = notices(box);
        expect(posted.length).toBe(1);
        expect(posted[0]).toStartWith("job train paused until ");
        expect(posted[0]).toContain(reset.toISOString());

        box.ok(["job", "run-due"], { now: "2026-11-15T12:00:10Z" });
        box.ok(["job", "run-due"], { now: "2026-11-16T12:00:10Z" });
        box.ok(["job", "run-due"], { now: new Date(reset.getTime() - 60_000).toISOString() });
        expect(calls(box)).toBe(1);
        expect(notices(box).length).toBe(1);
        expect(statuses(box)).toEqual(["failed"]);

        writeFileSync(join(box.root, "omp-ok"), "");
        box.ok(["job", "run-due"], { now: new Date(reset.getTime() + 60_000).toISOString() });
        expect(calls(box)).toBe(2);
        expect(statuses(box)).toEqual(["failed", "ok"]);
        expect(notices(box).length).toBe(1);
    });

    test("a manual run still runs while paused, and a run that gets through lifts the pause", () => {
        const box = limitedBox();
        box.ok(["job", "run-due"], { now: "2026-11-15T11:00:10Z" });
        box.ok(["job", "run", "train"], { now: "2026-11-15T11:10:00Z" });
        expect(calls(box)).toBe(2);
        writeFileSync(join(box.root, "omp-ok"), "");
        box.ok(["job", "run", "train"], { now: "2026-11-15T11:20:00Z" });
        expect(calls(box)).toBe(3);
        box.ok(["job", "run-due"], { now: "2026-11-15T11:30:10Z" });
        expect(calls(box)).toBe(4);
        expect(notices(box)).toEqual([]);
    });

    test("a limit that names no reset keeps failing each due tick, with no pause", () => {
        const box = limitedBox("429 rate_limit_error");
        box.ok(["job", "run-due"], { now: "2026-11-15T11:00:10Z" });
        box.ok(["job", "run-due"], { now: "2026-11-15T11:30:10Z" });
        expect(calls(box)).toBe(2);
        expect(statuses(box)).toEqual(["failed", "failed"]);
        expect(notices(box)).toEqual([]);
    });
});
