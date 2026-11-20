// `delegate` against a target that stops answering (T2126): it returns within seconds with the item queued, a run
// killed mid-send leaves nothing locked, and running it again sends the copy already queued instead of another.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { brief, pair, tasks } from "./delegate-fixture.ts";

describe("delegate to a target that stops answering", () => {
    test("delegating again after a run that died while sending reuses its copy, sends it, and leaves no second", () => {
        const { m1, m2, down, up } = pair();
        down();
        m1.ok(["delegate", "m2", "later", "--brief", brief(m1)]);
        const outbox = join(m1.root, "state", "outbox");
        const [first = ""] = readdirSync(outbox);
        const dead = Bun.spawnSync(["true"]).pid;
        renameSync(join(outbox, first), join(outbox, `${first}.sending-${dead}`));
        up();
        expect(m1.ok(["delegate", "m2", "later", "--brief", brief(m1)])).toBe(
            "delegated to m2/T1: m2's lead dispatches it",
        );
        expect(readdirSync(outbox)).toEqual([]);
        expect(tasks(m2).map((task) => task.id)).toEqual(["T1"]);
        expect(tasks(m2)[0]?.delegatedBy?.id).toBe(first.replace(/^delegation-|\.json$/g, ""));
    });

    test("delegating again while a live run sends the first copy sends nothing more", () => {
        const { m1, m2, down, up } = pair();
        down();
        m1.ok(["delegate", "m2", "later", "--brief", brief(m1)]);
        const outbox = join(m1.root, "state", "outbox");
        const [first = ""] = readdirSync(outbox);
        renameSync(join(outbox, first), join(outbox, `${first}.sending-${process.pid}`));
        up();
        expect(m1.ok(["delegate", "m2", "later", "--brief", brief(m1)])).toContain("already queued for m2");
        expect(readdirSync(outbox)).toEqual([`${first}.sending-${process.pid}`]);
        expect(existsSync(join(m2.root, "data", "backlog.json"))).toBe(false);
    });

    test("a target whose ssh connects and never answers gets the delegation queued within seconds", () => {
        const { m1, m2 } = pair();
        m1.stub("ssh", "exec sleep 300");
        const started = Date.now();
        const run = m1.toli(["delegate", "m2", "later", "--brief", brief(m1)]);
        expect(Date.now() - started).toBeLessThan(25_000);
        expect(run.code).toBe(0);
        expect(run.stdout).toContain("queued: m2 is unreachable");
        expect(run.stderr).toContain("ssh host2: no answer within 10 s");
        expect(readdirSync(join(m1.root, "state", "outbox")).filter((file) => file.endsWith(".json"))).toHaveLength(1);
        expect(existsSync(join(m2.root, "data", "backlog.json"))).toBe(false);
    });
});
