// The envelope's refusals (docs/peers.md "The envelope"): every check `applyBatch` makes, through `bin/toli peer
// apply` (the ssh transport), plus the sender checks the plain ssh commands make themselves.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Envelope } from "../src/peer/envelope.ts";
import type { Identity } from "../src/peer/identity.ts";
import { introId, pinExpiry, signIntroduction } from "../src/peer/introduce.ts";
import { GRANTS, type Grant, INTRODUCED_GRANTS, PERMISSIONS } from "../src/peer/store.ts";
import { applyIn, envelope, peerBox, pin, resign, sender } from "./peer-fixture.ts";

function inboxFiles(root: string): string[] {
    try {
        return readdirSync(join(root, "data", "inbox"));
    } catch {
        return [];
    }
}

describe("applyEnvelope refusals", () => {
    test("a bad signature is refused and nothing is applied", () => {
        const recv = peerBox("recv");
        const alice = sender();
        pin(recv.box, [{ name: "alice", identity: alice }]);
        const signed = envelope(alice, "alice", recv.fingerprint);
        const [receipt] = applyIn(recv.box, [{ ...signed, body: "tampered" }]);
        expect(receipt?.status).toBe("refused");
        expect(receipt?.reason).toBe("bad signature");
        expect(inboxFiles(recv.box.root)).toHaveLength(0);
    });

    test("an unknown key and a revoked key are refused", () => {
        const recv = peerBox("recv");
        const alice = sender();
        const stranger = sender();
        pin(recv.box, [{ name: "alice", identity: alice, status: "revoked" }]);
        const [unknown] = applyIn(recv.box, [envelope(stranger, "stranger", recv.fingerprint)]);
        expect(unknown?.reason).toBe("unknown peer key");
        const [revoked] = applyIn(recv.box, [envelope(alice, "alice", recv.fingerprint)]);
        expect(revoked?.status).toBe("refused");
        expect(revoked?.reason).toContain("revoked");
        expect(inboxFiles(recv.box.root)).toHaveLength(0);
    });

    test("an envelope addressed to another machine is refused", () => {
        const recv = peerBox("recv");
        const alice = sender();
        pin(recv.box, [{ name: "alice", identity: alice }]);
        const [receipt] = applyIn(recv.box, [envelope(alice, "alice", "0".repeat(64))]);
        expect(receipt?.reason).toBe("not addressed to this machine");
    });

    test("a replayed nonce of an applied message is a duplicate: it lands once and is never refused", () => {
        const recv = peerBox("recv");
        const alice = sender();
        pin(recv.box, [{ name: "alice", identity: alice }]);
        const signed = envelope(alice, "alice", recv.fingerprint);
        const [first] = applyIn(recv.box, [signed]);
        expect(first?.status).toBe("applied");
        // The same signed request again (a sender trying its next address after the first stopped answering).
        const [replayed] = applyIn(recv.box, [signed]);
        expect(replayed?.status).toBe("duplicate");
        expect(replayed?.stdout).toBe(first?.stdout ?? "");
        expect(inboxFiles(recv.box.root)).toHaveLength(1);
    });

    test("a replayed nonce of a message not applied here stays queued with its sender, never refused", () => {
        const recv = peerBox("recv");
        const alice = sender();
        pin(recv.box, [{ name: "alice", identity: alice }]);
        // Checked here (its nonce recorded), then refused on its claim: nothing was applied.
        const signed = envelope(alice, "alice", recv.fingerprint, {
            kind: "answer",
            body: JSON.stringify({ id: "T999", answer: "yes" }),
        });
        expect(applyIn(recv.box, [signed])[0]?.status).toBe("refused");
        const [replayed] = applyIn(recv.box, [signed]);
        expect(replayed?.status).toBe("failed");
        expect(replayed?.reason).toContain("replayed nonce");
        expect(inboxFiles(recv.box.root)).toHaveLength(0);
    });

    test("an old sentAt (a captured request replayed later) is refused", () => {
        const recv = peerBox("recv");
        const alice = sender();
        pin(recv.box, [{ name: "alice", identity: alice }]);
        const old = resign(alice, envelope(alice, "alice", recv.fingerprint), { sentAt: Date.now() - 6 * 60_000 });
        const [receipt] = applyIn(recv.box, [old]);
        expect(receipt?.status).toBe("refused");
        expect(receipt?.reason).toContain("5-minute window");
    });

    test("a from that is not the key's peer is refused", () => {
        const recv = peerBox("recv");
        const alice = sender();
        pin(recv.box, [{ name: "alice", identity: alice }]);
        const [receipt] = applyIn(recv.box, [envelope(alice, "bob", recv.fingerprint)]);
        expect(receipt?.reason).toBe('from "bob" is not the key\'s peer (alice)');
    });

    test("a talk-only peer cannot delegate", () => {
        const recv = peerBox("recv");
        const alice = sender();
        pin(recv.box, [{ name: "alice", identity: alice, allow: ["talk"] }]);
        const body = JSON.stringify({ id: "alice-1", from: "alice", title: "work", brief: "b" });
        const [receipt] = applyIn(recv.box, [envelope(alice, "alice", recv.fingerprint, { kind: "delegation", body })]);
        expect(receipt?.status).toBe("refused");
        expect(receipt?.reason).toBe("alice lacks the delegate permission here");
        expect(recv.box.ok(["task", "list"])).not.toContain("work");
    });

    test("an answer for a task the peer did not delegate is refused and the task stays held", () => {
        const recv = peerBox("recv");
        const alice = sender();
        const mallory = sender();
        pin(recv.box, [
            { name: "alice", identity: alice },
            { name: "mallory", identity: mallory },
        ]);
        const delegation = { id: "alice-1", from: "alice", title: "held work", brief: "b" };
        recv.box.ok(["delegation", "receive", "--from", "alice"], { stdin: JSON.stringify(delegation) });
        recv.box.ok(["task", "hold", "T1", "--question", "which way?", "--option", "a => x", "--option", "b => y"]);
        const body = JSON.stringify({ id: "T1", answer: "the forged way" });
        const [receipt] = applyIn(recv.box, [envelope(mallory, "mallory", recv.fingerprint, { kind: "answer", body })]);
        expect(receipt?.status).toBe("refused");
        expect(receipt?.reason).toBe("T1 was not delegated here by mallory");
        expect(recv.box.ok(["task", "list"])).toContain("held");
        const [owner] = applyIn(recv.box, [envelope(alice, "alice", recv.fingerprint, { kind: "answer", body })]);
        expect(owner?.status).toBe("applied");
    });

    test("an update for another owner's task is refused", () => {
        const recv = peerBox("recv");
        const mallory = sender();
        pin(recv.box, [{ name: "mallory", identity: mallory }]);
        const update = {
            owner: "alice",
            id: "T1",
            task: { status: "done", updatedAt: new Date().toISOString(), notes: [] },
            message: { title: "done", body: "forged" },
            report: null,
        };
        const [receipt] = applyIn(recv.box, [
            envelope(mallory, "mallory", recv.fingerprint, { kind: "update", body: JSON.stringify(update) }),
        ]);
        expect(receipt?.status).toBe("refused");
        expect(receipt?.reason).toBe("update for alice's task sent by mallory");
    });

    test("an update whose title is over 200 characters is applied, and any other kind is refused (T2119)", () => {
        const recv = peerBox("recv");
        const alice = sender();
        pin(recv.box, [{ name: "alice", identity: alice }]);
        const title = `alice/T1 done: ${"a very long delegated task title ".repeat(8)}`;
        const update = {
            owner: "alice",
            id: "T1",
            task: { status: "active", updatedAt: new Date().toISOString(), notes: [] },
            message: { title, body: "working" },
            report: null,
        };
        const receipts = applyIn(recv.box, [
            envelope(alice, "alice", recv.fingerprint, { kind: "update", title, body: JSON.stringify(update) }),
            envelope(alice, "alice", recv.fingerprint, { title }),
        ]);
        expect(title.length).toBeGreaterThan(200);
        expect(receipts.map((receipt) => receipt.status)).toEqual(["applied", "refused"]);
        expect(receipts[1]?.reason).toBe("title over 200 characters");
    });

    test("a message the receiving command refuses gets a refused receipt with its reason, and the batch goes on", () => {
        const recv = peerBox("recv");
        const alice = sender();
        pin(recv.box, [{ name: "alice", identity: alice }]);
        const link = JSON.stringify({ from: "alice", task: "T9", id: "T42" });
        const receipts = applyIn(recv.box, [
            envelope(alice, "alice", recv.fingerprint, { kind: "link", body: link }),
            envelope(alice, "alice", recv.fingerprint),
        ]);
        expect(receipts.map((receipt) => receipt.status)).toEqual(["refused", "applied"]);
        expect(receipts[0]?.reason).toBe('unknown task "T42"');
        expect(inboxFiles(recv.box.root)).toHaveLength(1);
    });

    test("a duplicate id returns the stored receipt and is applied once", () => {
        const recv = peerBox("recv");
        const alice = sender();
        pin(recv.box, [{ name: "alice", identity: alice }]);
        const first = envelope(alice, "alice", recv.fingerprint);
        const [applied] = applyIn(recv.box, [first]);
        // The sender lost the receipt and re-signs the same item: fresh nonce and sentAt, same id.
        const again = envelope(alice, "alice", recv.fingerprint, {
            id: first.id,
            title: first.title,
            body: first.body,
        });
        const [duplicate] = applyIn(recv.box, [again]);
        expect(applied?.status).toBe("applied");
        expect(duplicate?.status).toBe("duplicate");
        expect(duplicate?.stdout).toBe(applied?.stdout ?? "missing");
        expect(inboxFiles(recv.box.root)).toHaveLength(1);
    });

    test("an applied message is marked as a peer's words in the inbox", () => {
        const recv = peerBox("recv");
        const alice = sender();
        pin(recv.box, [{ name: "alice", identity: alice }]);
        const [receipt] = applyIn(recv.box, [envelope(alice, "alice", recv.fingerprint)]);
        const text = Bun.file(String(receipt?.stdout.trim())).text();
        return text.then((body) =>
            expect(body).toContain(`- via: peer alice (fingerprint ${alice.fingerprint.slice(0, 16)})`),
        );
    });
});

describe("the batch header (T2049)", () => {
    /** An update for a task `alice` owns whose status wakes nobody: applied here, writes no inbox item. */
    function quietUpdate(alice: Identity, to: string, n: number): Envelope {
        const update = {
            owner: "alice",
            id: `T${n}`,
            task: { status: "active", updatedAt: new Date().toISOString(), notes: [] },
            message: { title: `T${n} active`, body: "working" },
            report: null,
        };
        return envelope(alice, "alice", to, { kind: "update", body: JSON.stringify(update) });
    }

    test("a batch of applied messages that write no inbox item posts no header", () => {
        const recv = peerBox("recv");
        const alice = sender();
        pin(recv.box, [{ name: "alice", identity: alice }]);
        const batch = [1, 2, 3, 4, 5, 6, 7].map((n) => quietUpdate(alice, recv.fingerprint, n));
        const receipts = applyIn(recv.box, batch);
        expect(receipts.map((receipt) => receipt.status)).toEqual(Array(7).fill("applied"));
        expect(inboxFiles(recv.box.root)).toEqual([]);
    });

    test("the header counts only the inbox items the batch wrote", () => {
        const recv = peerBox("recv");
        const alice = sender();
        pin(recv.box, [{ name: "alice", identity: alice }]);
        const talk = [1, 2, 3, 4, 5, 6].map(() => envelope(alice, "alice", recv.fingerprint));
        const quiet = [1, 2, 3, 4, 5, 6].map((n) => quietUpdate(alice, recv.fingerprint, n));
        applyIn(recv.box, [...talk, ...quiet]);
        const files = inboxFiles(recv.box.root).sort();
        expect(files).toHaveLength(7);
        const header = Bun.file(join(recv.box.root, "data", "inbox", String(files.at(-1)))).text();
        return header.then((text) => expect(text).toStartWith("# 6 queued messages from alice arrived\n"));
    });
});

describe("the ssh commands hold the sender to its task", () => {
    test("task answer --from a machine that did not delegate the task is refused", () => {
        const recv = peerBox("recv");
        recv.box.ok(["delegation", "receive"], {
            stdin: JSON.stringify({ id: "alice-1", from: "alice", title: "held work", brief: "b" }),
        });
        recv.box.ok(["task", "hold", "T1", "--question", "which way?", "--option", "a => x", "--option", "b => y"]);
        const forged = recv.box.toli(["task", "answer", "T1", "forged", "--from", "mallory"]);
        expect(forged.code).toBe(1);
        expect(forged.stderr).toContain("T1 was delegated by alice, not mallory");
        expect(recv.box.ok(["task", "list"])).toContain("held");
        expect(recv.box.toli(["task", "answer", "T1", "real", "--from", "alice"]).code).toBe(0);
    });

    test("delegation update --from a machine that is not the owner is refused", () => {
        const recv = peerBox("recv");
        const update = {
            owner: "alice",
            id: "T1",
            task: { status: "done", updatedAt: new Date().toISOString(), notes: [] },
            message: { title: "done", body: "forged" },
            report: null,
        };
        const forged = recv.box.toli(["delegation", "update", "--from", "mallory"], { stdin: JSON.stringify(update) });
        expect(forged.code).toBe(1);
        expect(forged.stderr).toContain("an update for alice's task cannot come from mallory");
        expect(inboxFiles(recv.box.root)).toHaveLength(0);
    });
});

describe("an introduction envelope", () => {
    /** A box that pins `coord` with `allow`, and a certificate from coord introducing a new machine to it. */
    function introduced(allow: Grant[]) {
        const recv = peerBox("box");
        const coord = sender();
        pin(recv.box, [{ name: "coord", identity: coord, allow }]);
        const mac = sender();
        const cert = signIntroduction(coord, {
            id: introId(),
            op: "introduce",
            audience: recv.fingerprint,
            subject: { name: "mac", key: mac.key, fingerprint: mac.fingerprint, cert: "", certSig: "", addrs: [] },
            grants: [...INTRODUCED_GRANTS],
            notAfter: pinExpiry(),
            replaces: null,
            approval: { by: "owner", why: "Chirag joins", at: new Date().toISOString() },
        });
        const signed = envelope(coord, "coord", recv.fingerprint, {
            kind: "introduction",
            title: "introducing mac",
            body: JSON.stringify(cert),
        });
        return { recv, coord, signed };
    }

    function pinnedNames(root: string): string[] {
        const file: { peers: Array<{ name: string }> } = JSON.parse(
            readFileSync(join(root, "config", "peers.json"), "utf8"),
        );
        return file.peers.map((peer) => peer.name);
    }

    test("is applied from a peer allowed to introduce: the subject is pinned and the inbox told", () => {
        const { recv, signed } = introduced([...GRANTS]);
        const [receipt] = applyIn(recv.box, [signed]);
        expect(receipt?.status).toBe("applied");
        expect(receipt?.stdout).toContain("pinned mac");
        expect(pinnedNames(recv.box.root)).toContain("mac");
        expect(inboxFiles(recv.box.root)).toHaveLength(1);
    });

    test("is refused from a peer without introduce, and nothing is pinned", () => {
        const { recv, signed } = introduced([...PERMISSIONS]);
        const [receipt] = applyIn(recv.box, [signed]);
        expect(receipt?.status).toBe("refused");
        expect(receipt?.reason).toBe("coord lacks the introduce permission here");
        expect(pinnedNames(recv.box.root)).not.toContain("mac");
    });

    test("a replay of the same envelope is a duplicate", () => {
        const { recv, signed } = introduced([...GRANTS]);
        expect(applyIn(recv.box, [signed])[0]?.status).toBe("applied");
        expect(applyIn(recv.box, [signed])[0]?.status).toBe("duplicate");
        expect(inboxFiles(recv.box.root)).toHaveLength(1);
    });

    test("a refused certificate is refused with its reason and noted in the inbox", () => {
        const { recv, coord } = introduced([...GRANTS]);
        const forged = envelope(coord, "coord", recv.fingerprint, {
            kind: "introduction",
            body: JSON.stringify({ v: 1 }),
        });
        const [receipt] = applyIn(recv.box, [forged]);
        expect(receipt?.status).toBe("refused");
        expect(receipt?.reason).toBe("not an introduction certificate");
        expect(inboxFiles(recv.box.root)).toHaveLength(1);
    });

    test("an introduced pin past its notAfter is refused like a revoked one", () => {
        const recv = peerBox("box");
        const mac = sender();
        pin(recv.box, [{ name: "mac", identity: mac }]);
        const file = join(recv.box.root, "config", "peers.json");
        const peers: { peers: Array<Record<string, unknown>> } = JSON.parse(readFileSync(file, "utf8"));
        for (const peer of peers.peers) peer.notAfter = new Date(Date.now() - 60_000).toISOString();
        writeFileSync(file, JSON.stringify(peers));
        const [receipt] = applyIn(recv.box, [envelope(mac, "mac", recv.fingerprint)]);
        expect(receipt?.status).toBe("refused");
        expect(receipt?.reason).toContain("pin expired");
    });
});
