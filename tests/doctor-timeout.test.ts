// doctor never hangs (T1339): each section runs under a time limit and one that never finishes is reported as timed
// out while the rest still run; and the peer client never leaves its connection probe half-open, which kept every
// command that reached a peer behind a resetting firewall alive for good.
import { describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { postPeer, Unreachable } from "../src/peer/client.ts";
import type { Peer } from "../src/peer/store.ts";
import { sandbox, withSystemd } from "./helpers.ts";

describe("doctor time limits", () => {
    test("a check that never returns is marked timed out and doctor still finishes", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const systemd = withSystemd(box);
        // `systemctl --user is-active toli-lead.service` never answers in time; every other call works as usual.
        box.stub(
            "systemctl",
            `if [ "$2" = is-active ] && [ "$3" = toli-lead.service ]; then exec sleep 30; fi
case "$2" in is-active) echo inactive; exit 3 ;; esac`,
        );
        const started = Date.now();
        const result = box.toli(["doctor"], { env: { ...systemd.env, TOLI_DOCTOR_CHECK_MS: "3000" } });
        expect(Date.now() - started).toBeLessThan(25_000);
        const lines = result.stdout.trimEnd().split("\n");
        expect(lines).toContain("warn lead timed out after 3 s: the check never finished and was stopped");
        expect(lines.some((line) => line.startsWith("warn scheduler "))).toBe(true);
    });
});

describe("peer client connection probe", () => {
    test("closes its probe connection fully, even when the peer never closes its side", async () => {
        const { promise: probeClosed, resolve: closed } = Promise.withResolvers<boolean>();
        let connections = 0;
        // The first connection is the probe: kept open from this side after the client's FIN, as a peer behind a
        // firewall that drops the reset does. Writing to it once the client is gone draws a reset that closes it; a
        // client that only half-closed takes the bytes and the connection stays up. Later connections (the HTTPS
        // request) are reset at once.
        const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
            connections += 1;
            if (connections > 1) {
                socket.resetAndDestroy();
                return;
            }
            socket.on("error", () => undefined);
            socket.once("close", () => closed(true));
            socket.once("end", () => {
                const poke = setInterval(() => socket.write("x"), 50);
                socket.once("close", () => clearInterval(poke));
            });
        });
        const { promise: listening, resolve: listened } = Promise.withResolvers<void>();
        server.once("listening", listened);
        server.listen(0, "127.0.0.1");
        await listening;
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("no server port");
        const peer: Peer = {
            name: "stuck",
            key: "",
            fingerprint: "",
            cert: "",
            certSig: "",
            addrs: [`127.0.0.1:${address.port}`],
            allow: [],
            pairedAt: "",
            pairedBy: "owner",
            status: "active",
        };
        try {
            const failure = await postPeer(peer, "/v1/status", {}).then(
                () => null,
                (error: unknown) => error,
            );
            expect(failure).toBeInstanceOf(Unreachable);
            // Real sockets, real time: how long a half-open probe lingers is the behaviour under test, so the bound
            // is a wall-clock one (a closed probe is reset within milliseconds).
            const timer = setTimeout(() => closed(false), 3_000);
            expect(await probeClosed).toBe(true);
            clearTimeout(timer);
        } finally {
            server.close();
        }
    });
});
