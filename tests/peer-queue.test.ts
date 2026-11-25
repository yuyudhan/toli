// Delivery to paired peers over HTTPS and the one outbox (docs/peers.md "Delivery"): two real installations, the
// receiver's listener on 127.0.0.1, the sender's `talk` and outbox. An offline peer keeps its items in order and gets
// each exactly once (a lost receipt included); a refused item moves to cancelled/ with a note; an announce delivers
// at once, as one wake; a peer without a listener pulls; status is asked over HTTPS; waiting alerts fire once. A peer
// that accepts the connection and never answers costs a sender a few seconds, not minutes; a claim left by a dead
// process goes back to the queue at once, and `outbox list` shows a claim still held.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pidAlive } from "../src/core/util.ts";
import { postWaitingAlerts } from "../src/jobs/outbox-admin.ts";
import type { Permission } from "../src/peer/store.ts";
import { inProcess } from "./helpers.ts";
import { type PeerBox, peerBox, pin } from "./peer-fixture.ts";
import { type Listening, serve } from "./peer-serve-fixture.ts";

const running: Listening[] = [];
const stalls: Array<{ stop(closeActive?: boolean): void }> = [];
afterEach(async () => {
    for (const listening of running.splice(0)) await listening.stop();
    for (const stall of stalls.splice(0)) stall.stop(true);
});

/** A port that accepts connections and never answers on them, as a peer behind a flapping VPN did (T2126). */
function stallingPort(): number {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    stalls.push(server);
    return server.port;
}

/** The pid of a process that has already exited. */
function deadPid(): number {
    const pid = Bun.spawnSync(["true"]).pid;
    if (pidAlive(pid)) throw new Error(`pid ${pid} is still alive`);
    return pid;
}

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

/** Pin `a` and `b` to each other: `a` reaches `b` at `bAddr`, `b` reaches `a` at `aAddr` (if any). */
function link(a: PeerBox, b: PeerBox, options: { bAddr?: string; aAddr?: string; bAllows?: Permission[] } = {}): void {
    pin(a.box, [
        { name: b.name, identity: b, cert: b.cert, addrs: options.bAddr === undefined ? [] : [options.bAddr] },
    ]);
    pin(b.box, [
        {
            name: a.name,
            identity: a,
            cert: a.cert,
            addrs: options.aAddr === undefined ? [] : [options.aAddr],
            ...(options.bAllows === undefined ? {} : { allow: options.bAllows }),
        },
    ]);
}

type Item = { title: string; body: string; path: string };

function inboxOf(box: PeerBox): Item[] {
    const dir = join(box.box.root, "data", "inbox");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .sort()
        .map((file) => {
            const text = readFileSync(join(dir, file), "utf8");
            return { title: text.split("\n")[0]?.replace(/^# /, "") ?? "", body: text, path: join(dir, file) };
        });
}

function talks(box: PeerBox, from: string): string[] {
    return inboxOf(box)
        .filter((item) => item.title === `message from ${from}`)
        .map((item) => /\n\n([^\n]+)\n/.exec(item.body.split("- received:")[1] ?? "")?.[1] ?? item.body);
}

type Row = { id: string; to: string; kind: string; title: string; state: string; pid?: number };

function queued(box: PeerBox): Row[] {
    return JSON.parse(box.box.ok(["outbox", "list", "--json"])) as Row[];
}

async function until(check: () => boolean, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("timed out waiting");
        await Bun.sleep(100);
    }
}

describe("delivery to a paired peer over HTTPS", () => {
    test("talk reaches a paired peer over HTTPS, recorded with its transport and time", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        const listening = await start(beta);
        link(alpha, beta, { bAddr: `127.0.0.1:${listening.port}` });
        expect(alpha.box.ok(["talk", "beta", "ping over https"])).toBe(
            "sent to beta's lead; its reply arrives here as a wake",
        );
        const arrived = inboxOf(beta).filter((item) => item.title === "message from alpha");
        expect(arrived).toHaveLength(1);
        expect(arrived[0]?.body).toContain("ping over https");
        expect(arrived[0]?.body).toContain("- via: peer alpha (fingerprint");
        const stats = JSON.parse(alpha.box.ok(["peer", "stats", "--json"])) as Array<{
            transport: string;
            count: number;
        }>;
        expect(stats.map((row) => [row.transport, row.count])).toEqual([["https", 1]]);
        expect(queued(alpha)).toEqual([]);
    });

    test("an offline peer keeps its items in order and gets each exactly once, a lost receipt included", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        const port = freePort();
        link(alpha, beta, { bAddr: `127.0.0.1:${port}` });
        for (const words of ["one", "two", "three"]) {
            const sent = alpha.box.toli(["talk", "beta", words]);
            expect(sent.code).toBe(0);
            expect(sent.stdout).toContain("queued for beta");
        }
        expect(queued(alpha).map((item) => item.to)).toEqual(["beta", "beta", "beta"]);
        const first = queued(alpha)[0]?.id ?? "";
        const outbox = join(alpha.box.root, "state", "outbox");
        const kept = readFileSync(join(outbox, `${first}.json`), "utf8");
        await start(beta, { TOLI_PEER_PORT: String(port) });
        expect(alpha.box.ok(["peer", "flush", "beta"])).toBe("beta: sent 3");
        // The receipt for the first was lost: it is sent again, and the receiver only answers with its old receipt.
        writeFileSync(join(outbox, `${first}.json`), kept);
        const again = JSON.parse(alpha.box.ok(["peer", "flush", "beta", "--json"])) as Array<{
            receipts: Array<{ id: string; status: string }>;
        }>;
        expect(again[0]?.receipts).toEqual([expect.objectContaining({ id: first, status: "duplicate" })]);
        expect(talks(beta, "alpha")).toEqual(["one", "two", "three"]);
        expect(queued(alpha)).toEqual([]);
    });

    test("a refused message moves to cancelled/ with the reason, and the sender is told", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        const listening = await start(beta);
        link(alpha, beta, { bAddr: `127.0.0.1:${listening.port}`, bAllows: ["share"] });
        const sent = alpha.box.toli(["talk", "beta", "may I?"]);
        expect(sent.code).toBe(0);
        expect(sent.stdout).toContain("not sent: beta refused it");
        expect(sent.stderr).toContain("lacks the talk permission");
        expect(queued(alpha)).toEqual([]);
        const cancelled = JSON.parse(alpha.box.ok(["outbox", "list", "--cancelled", "--json"])) as Array<{
            reason: string;
        }>;
        expect(cancelled).toHaveLength(1);
        expect(cancelled[0]?.reason).toContain("lacks the talk permission");
        expect(inboxOf(alpha).some((item) => item.title.startsWith("1 outbox item not sent: beta refused"))).toBe(true);
        expect(inboxOf(beta).filter((item) => item.title === "message from alpha")).toEqual([]);
    });

    test("a peer that comes back announces itself and gets what waited, in order, as one wake", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        const betaPort = freePort();
        const alphaListening = await start(alpha);
        link(alpha, beta, { bAddr: `127.0.0.1:${betaPort}`, aAddr: `127.0.0.1:${alphaListening.port}` });
        for (const words of ["first", "second", "third"]) alpha.box.ok(["talk", "beta", words]);
        expect(queued(alpha)).toHaveLength(3);
        // No tick and no flush: beta's listener starts, announces, and alpha's listener sends the queue.
        await start(beta, { TOLI_PEER_PORT: String(betaPort) });
        await until(() => talks(beta, "alpha").length === 3);
        expect(talks(beta, "alpha")).toEqual(["first", "second", "third"]);
        await until(() => queued(alpha).length === 0);
        await Bun.sleep(5_200);
        const wake = JSON.parse(beta.box.ok(["wake", "--json"])) as { items: unknown[]; message: string };
        expect(wake.items).toHaveLength(3);
        expect(JSON.parse(beta.box.ok(["wake", "--json"])).items).toEqual([]);
    });

    test("a peer without a listener pulls what waits for it, and the sender drops each item once acknowledged", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        const alphaListening = await start(alpha);
        link(alpha, beta, { aAddr: `127.0.0.1:${alphaListening.port}` });
        for (const words of ["a", "b"]) {
            const sent = alpha.box.ok(["talk", "beta", words]);
            expect(sent).toContain("queued for beta, which pulls its messages");
        }
        expect(beta.box.ok(["peer", "pull"])).toBe("alpha: 2 applied");
        expect(talks(beta, "alpha")).toEqual(["a", "b"]);
        expect(queued(alpha)).toEqual([]);
        expect(beta.box.ok(["peer", "pull"])).toBe("alpha: 0 applied");
    });

    test("status is asked over HTTPS, and refused without the status permission", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        const listening = await start(beta);
        link(alpha, beta, { bAddr: `127.0.0.1:${listening.port}` });
        const status = JSON.parse(alpha.box.ok(["peer", "ask", "beta", "status", "--json"])) as Record<string, unknown>;
        expect(status.machine).toBe("beta");
        expect(typeof status.available).toBe("boolean");
        beta.box.ok(["peer", "deny", "alpha", "status"]);
        const refused = alpha.box.toli(["peer", "ask", "beta", "status"]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("403");
    });

    test("waiting alerts fire once per threshold: 1 hour, 1 day", () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        link(alpha, beta, { bAddr: `127.0.0.1:${freePort()}` });
        alpha.box.ok(["talk", "beta", "are you there?"]);
        const at = (hours: number) => new Date(Date.now() + hours * 60 * 60_000).toISOString();
        const alerts = (hours: number) => {
            let posted: string[] = [];
            inProcess(
                alpha.box.root,
                () => {
                    posted = postWaitingAlerts();
                },
                { TOLI_NOW: at(hours) },
            );
            return posted;
        };
        expect(alerts(0.5)).toEqual([]);
        expect(alerts(1.5)).toEqual(["1 message to beta waiting 2 h"]);
        expect(alerts(2)).toEqual([]);
        expect(alerts(25)).toEqual(["1 message to beta waiting 25 h"]);
        expect(alerts(30)).toEqual([]);
        expect(inboxOf(alpha).filter((item) => item.title.includes("waiting"))).toHaveLength(2);
    });

    test("removing a peer cancels what waits for it, with a note", () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        link(alpha, beta, { bAddr: `127.0.0.1:${freePort()}` });
        alpha.box.ok(["talk", "beta", "hello?"]);
        expect(alpha.box.ok(["peer", "remove", "beta", "--why", "test"])).toContain("1 queued item(s) for it moved");
        expect(queued(alpha)).toEqual([]);
        const outbox = join(alpha.box.root, "state", "outbox", "cancelled");
        expect(readdirSync(outbox).filter((file) => file.endsWith(".json"))).toHaveLength(1);
        renameSync(outbox, `${outbox}-seen`);
    });
});

describe("a peer that does not answer (T2126)", () => {
    test("talk to a peer that accepts and never answers is queued within seconds", () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        link(alpha, beta, { bAddr: `127.0.0.1:${stallingPort()}` });
        const started = Date.now();
        const sent = alpha.box.toli(["talk", "beta", "are you there?"]);
        expect(Date.now() - started).toBeLessThan(15_000);
        expect(sent.code).toBe(0);
        expect(sent.stdout).toContain("queued for beta");
        expect(queued(alpha).map((item) => [item.to, item.state])).toEqual([["beta", "queued"]]);
    });

    test("delegate to a peer that accepts and never answers is queued as fast as talk", () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        link(alpha, beta, { bAddr: `127.0.0.1:${stallingPort()}` });
        const brief = join(alpha.box.root, "brief.md");
        writeFileSync(brief, "TOLI_BRIEF v1\n# no-op\nReply done.\n");
        const started = Date.now();
        const sent = alpha.box.toli(["delegate", "beta", "later", "--brief", brief]);
        // talk's budget over HTTPS (QUICK_MS, 5 s) + 1 s, + ~1 s to start bun: the verify-only check and the send
        // share that budget, so a check that got no answer leaves the item queued without a second wait.
        expect(Date.now() - started).toBeLessThan(7_000);
        expect(sent.code).toBe(0);
        expect(sent.stdout).toContain("queued for beta");
        expect(queued(alpha).map((item) => [item.to, item.kind, item.state])).toEqual([
            ["beta", "delegation", "queued"],
        ]);
    });

    test("a pull goes past peers that accept the connection and never complete the handshake (T2775)", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        const gamma = peerBox("gamma");
        const delta = peerBox("delta");
        const alphaListening = await start(alpha);
        // beta pulls from three peers; gamma and delta (stalled addresses, tried first) hold nothing it can reach.
        pin(beta.box, [
            { name: gamma.name, identity: gamma, cert: gamma.cert, addrs: [`127.0.0.1:${stallingPort()}`] },
            { name: delta.name, identity: delta, cert: delta.cert, addrs: [`127.0.0.1:${stallingPort()}`] },
            { name: alpha.name, identity: alpha, cert: alpha.cert, addrs: [`127.0.0.1:${alphaListening.port}`] },
        ]);
        pin(alpha.box, [{ name: beta.name, identity: beta, cert: beta.cert }]);
        expect(alpha.box.ok(["talk", "beta", "waiting since last night"])).toContain("queued for beta");
        const started = Date.now();
        const pulled = beta.box.toli(["peer", "pull"]);
        // One handshake budget (CONNECT_MS, 5 s), the stalled peers side by side, + bun's start. Before T2775 each
        // stalled peer held the pass for its whole request budget (120 s), one after the other.
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(pulled.stdout).toContain("alpha: 1 applied");
        expect(pulled.stdout).toContain("gamma: 0 applied");
        expect(pulled.stdout).toContain("delta: 0 applied");
        expect(talks(beta, "alpha")).toEqual(["waiting since last night"]);
    }, 300_000);

    test("a peer's dead addresses are probed side by side, so its live one answers within one handshake (T2775)", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        const alphaListening = await start(alpha);
        const dead = [stallingPort(), stallingPort(), stallingPort()].map((port) => `127.0.0.1:${port}`);
        pin(beta.box, [
            {
                name: alpha.name,
                identity: alpha,
                cert: alpha.cert,
                addrs: [...dead, `127.0.0.1:${alphaListening.port}`],
            },
        ]);
        pin(alpha.box, [{ name: beta.name, identity: beta, cert: beta.cert }]);
        expect(alpha.box.ok(["talk", "beta", "old Wi-Fi addresses first"])).toContain("queued for beta");
        const started = Date.now();
        const pulled = beta.box.toli(["peer", "pull"]);
        // One handshake budget (CONNECT_MS, 5 s) + bun's start, not 5 s for each dead address in turn (15 s here).
        expect(Date.now() - started).toBeLessThan(13_000);
        expect(pulled.stdout).toBe("alpha: 1 applied\n");
    }, 120_000);

    test("an address failing for a day while another answers is dropped, and the user is told (T2775)", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        const listening = await start(beta);
        const gone = `127.0.0.1:${freePort()}`;
        const flaky = `127.0.0.1:${freePort()}`;
        const live = `127.0.0.1:${listening.port}`;
        pin(alpha.box, [{ name: beta.name, identity: beta, cert: beta.cert, addrs: [gone, flaky, live] }]);
        pin(beta.box, [{ name: alpha.name, identity: alpha, cert: alpha.cert }]);
        // `gone` has failed every handshake for 25 hours; `flaky` has not failed before.
        const failures = join(alpha.box.root, "state", "peer", "addr-failures.json");
        mkdirSync(dirname(failures), { recursive: true });
        writeFileSync(failures, JSON.stringify({ beta: { [gone]: Date.now() - 25 * 60 * 60 * 1000 } }));
        expect(alpha.box.ok(["talk", "beta", "after the move"])).not.toContain("queued");
        expect(talks(beta, "alpha")).toEqual(["after the move"]);
        const addrs = () =>
            (
                JSON.parse(readFileSync(join(alpha.box.root, "config", "peers.json"), "utf8")) as {
                    peers: Array<{ name: string; addrs: string[] }>;
                }
            ).peers.find((peer) => peer.name === "beta")?.addrs ?? [];
        await until(() => !addrs().includes(gone));
        expect(addrs()).toEqual([live, flaky]);
        expect(readFileSync(join(alpha.box.root, "logs", "peer.log"), "utf8")).toContain(
            `address for beta changed: dropped ${gone}`,
        );
        expect(Object.keys(JSON.parse(readFileSync(failures, "utf8")).beta)).toEqual([flaky]);
        expect(inboxOf(alpha).map((item) => item.title)).toContain("address for beta changed");
    });

    test("an item claimed by a process that died goes back to the queue at once and is delivered", async () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        const port = freePort();
        link(alpha, beta, { bAddr: `127.0.0.1:${port}` });
        expect(alpha.box.ok(["talk", "beta", "left behind"])).toContain("queued for beta");
        const id = queued(alpha)[0]?.id ?? "";
        const outbox = join(alpha.box.root, "state", "outbox");
        renameSync(join(outbox, `${id}.json`), join(outbox, `${id}.json.sending-${deadPid()}`));
        expect(queued(alpha).map((entry) => [entry.id, entry.state])).toEqual([[id, "queued"]]);
        expect(readdirSync(outbox)).toEqual([`${id}.json`]);
        await start(beta, { TOLI_PEER_PORT: String(port) });
        expect(alpha.box.ok(["peer", "flush", "beta"])).toBe("beta: sent 1");
        expect(talks(beta, "alpha")).toEqual(["left behind"]);
    });

    test("outbox list shows an item a live process is sending, with its state", () => {
        const alpha = peerBox("alpha");
        const beta = peerBox("beta");
        link(alpha, beta, { bAddr: `127.0.0.1:${freePort()}` });
        alpha.box.ok(["talk", "beta", "in flight"]);
        const [item] = queued(alpha);
        const outbox = join(alpha.box.root, "state", "outbox");
        renameSync(join(outbox, `${item?.id}.json`), join(outbox, `${item?.id}.json.sending-${process.pid}`));
        expect(queued(alpha)).toEqual([expect.objectContaining({ id: item?.id, state: "sending", pid: process.pid })]);
        expect(alpha.box.ok(["outbox", "list"])).toContain(`sending (pid ${process.pid})`);
        expect(readdirSync(outbox)).toEqual([`${item?.id}.json.sending-${process.pid}`]);
    });
});
