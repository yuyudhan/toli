// The envelope's refusals (docs/peers.md "The envelope"): every check `applyBatch` makes, through `bin/toli peer
// apply` (the ssh transport), plus the sender checks the plain ssh commands make themselves.
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
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

    test("a replayed nonce is refused and the message lands once", () => {
        const recv = peerBox("recv");
        const alice = sender();
        pin(recv.box, [{ name: "alice", identity: alice }]);
        const signed = envelope(alice, "alice", recv.fingerprint);
        expect(applyIn(recv.box, [signed])[0]?.status).toBe("applied");
        const [replayed] = applyIn(recv.box, [signed]);
        expect(replayed?.status).toBe("refused");
        expect(replayed?.reason).toBe("replayed nonce");
        expect(inboxFiles(recv.box.root)).toHaveLength(1);
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
        recv.box.ok(["task", "hold", "T1", "--question", "which way?"]);
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

describe("the ssh commands hold the sender to its task", () => {
    test("task answer --from a machine that did not delegate the task is refused", () => {
        const recv = peerBox("recv");
        recv.box.ok(["delegation", "receive"], {
            stdin: JSON.stringify({ id: "alice-1", from: "alice", title: "held work", brief: "b" }),
        });
        recv.box.ok(["task", "hold", "T1", "--question", "which way?"]);
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
