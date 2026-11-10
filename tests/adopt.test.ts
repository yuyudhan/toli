import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ENV, fleet, remoteSnapshot } from "./fleet-fixture.ts";

type Run = { id: string; status: string; inbox: string | null };
type Item = { title: string; path: string };

describe("adopted runs report to this machine's lead", () => {
    test("a run that ended without an outcome is posted once by the tick; older history is left alone", () => {
        const box = fleet(remoteSnapshot("m2"));
        box.stub("omp", 'echo "old work"');
        box.ok(["exec"], { env: ENV, stdin: "before the cutover\n" });
        // The first tick marks the cutover: the run that ended before it is history.
        box.ok(["job", "tick"], { env: ENV });
        box.stub("omp", 'echo "adopted work done"');
        box.ok(["exec"], { env: ENV, stdin: "after the cutover\n" });
        const later = new Date(Date.now() + 5 * 60_000).toISOString();
        box.ok(["job", "tick"], { env: ENV, now: later });
        box.ok(["job", "tick"], { env: ENV, now: later });

        const runs = JSON.parse(box.ok(["runs", "--json"])) as Run[];
        const posted = runs.filter((run) => run.inbox !== null);
        expect(posted).toHaveLength(1);
        const items = JSON.parse(box.ok(["inbox", "list", "--json"])) as Item[];
        const outcomes = items.filter((item) => item.title.includes(posted[0]?.id ?? "-"));
        expect(outcomes).toHaveLength(1);
        expect(readFileSync(outcomes[0]?.path ?? "", "utf8")).toContain("adopted work done");
    });
});
