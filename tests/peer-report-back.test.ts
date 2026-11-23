// T813: a task delegated by a paired peer that is not in config/fleet.json reports back to it as a fleet machine's
// does: its done report goes through the outbox to the peer over HTTPS (src/records/delegation-report.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type PeerBox, peerBox, pin } from "./peer-fixture.ts";
import { type Listening, serve } from "./peer-serve-fixture.ts";

const running: Listening[] = [];
afterEach(async () => {
    for (const listening of running.splice(0)) await listening.stop();
});

async function start(box: PeerBox, env: Record<string, string> = {}): Promise<Listening> {
    const listening = await serve(box, env);
    running.push(listening);
    return listening;
}

/** A port nothing listens on right now. */
function freePort(): number {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = server.port;
    server.stop(true);
    return port;
}

type Row = { to: string; kind: string; state: string };

function queued(box: PeerBox): Row[] {
    return JSON.parse(box.box.ok(["outbox", "list", "--json"])) as Row[];
}

describe("a task delegated by a paired peer (T813)", () => {
    test("done reports back to a peer-only delegator through the outbox and the peer link", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        const alphaPort = freePort();
        const listening = await start(beta);
        pin(alpha.box, [{ name: beta.name, identity: beta, cert: beta.cert, addrs: [`127.0.0.1:${listening.port}`] }]);
        pin(beta.box, [{ name: alpha.name, identity: alpha, cert: alpha.cert, addrs: [`127.0.0.1:${alphaPort}`] }]);
        const brief = join(alpha.box.root, "brief.md");
        writeFileSync(brief, "TOLI_BRIEF v1\n# no-op\nReply done.\n");
        alpha.box.ok(["delegate", "beta", "the work", "--brief", brief]);

        const done = beta.box.toli(["task", "done", "T1", "--note", "no-op done"]);
        expect(done.code).toBe(0);
        expect(done.stderr).not.toContain("is not in config/fleet.json");
        expect(queued(beta).map((item) => [item.to, item.kind, item.state])).toEqual([["alpha", "update", "queued"]]);

        // Alpha's listener announces itself on start and beta sends what waits for it at once (docs/peers.md); that
        // flush runs in beta's listener process, so it is polled for, as tests/peer-queue.test.ts `until` does.
        await start(alpha, { TOLI_PEER_PORT: String(alphaPort) });
        const deadline = Date.now() + 20_000;
        while (queued(beta).length > 0 && Date.now() < deadline) await Bun.sleep(100);
        expect(queued(beta)).toEqual([]);
        expect(JSON.parse(beta.box.ok(["outbox", "list", "--cancelled", "--json"]))).toEqual([]);
        const inbox = JSON.parse(alpha.box.ok(["inbox", "list", "--json"])) as Array<{ from: string; title: string }>;
        expect(inbox.map((item) => [item.from, item.title])).toEqual([["beta", "beta/T1 done: the work"]]);
    });
});
