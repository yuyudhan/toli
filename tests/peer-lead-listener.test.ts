// Who starts a listener and when it stops (docs/peers.md "The listener"): the lead service starts one only on an
// installation that made its peer identity (`peer init`, which `upgrade` runs), so a checkout that never opted in,
// a test sandbox included, never binds the machine's private addresses; it starts a listener that died again within
// seconds, between and during its passes; a listener whose checkout is gone stops; and doctor and the fleet check
// flag a configured listener that is down.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TOLI_BIN } from "./helpers.ts";
import { peerBox } from "./peer-fixture.ts";
import { livePid, peerEnv, serve, until } from "./peer-serve-fixture.ts";

/** Run the lead service (`lead run`, dry run) in `root` for a few passes; returns logs/lead.log ("" when none). */
async function leadPasses(env: Record<string, string | undefined>, root: string): Promise<string> {
    const log = join(root, "logs", "lead.log");
    const proc = Bun.spawn([process.execPath, TOLI_BIN, "lead", "run"], {
        cwd: root,
        env: { ...env, TOLI_LEAD_POLL_MS: "50" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
    });
    try {
        // Past its imports once it says where it runs from; then a few passes.
        const reader = proc.stdout.getReader();
        let started = "";
        while (!started.includes("lead service started")) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error(`lead run exited before starting: ${started}`);
            started += new TextDecoder().decode(chunk.value);
        }
        reader.releaseLock();
        await Bun.sleep(500);
        return existsSync(log) ? readFileSync(log, "utf8") : "";
    } finally {
        proc.kill();
        await proc.exited;
    }
}

describe("the lead service and the listener", () => {
    test("starts a listener only once this installation has a peer identity", async () => {
        const recv = peerBox("alpha");
        rmSync(join(recv.box.root, "config", "peer"), { recursive: true, force: true });
        const without = await leadPasses(peerEnv(recv), recv.box.root);
        expect(without).not.toContain("peer listener");

        recv.box.ok(["peer", "init"]);
        rmSync(join(recv.box.root, "logs", "lead.log"), { force: true });
        expect(await leadPasses(peerEnv(recv), recv.box.root)).toContain("would start the peer listener");
    }, 60_000);

    test("a listener that dies is started again within seconds, though the next pass is minutes away", async () => {
        const recv = peerBox("alpha");
        const root = recv.box.root;
        const lead = Bun.spawn([process.execPath, TOLI_BIN, "lead", "run"], {
            cwd: root,
            // A pass every 10 minutes stands for one busy with a long headless turn: only the listener timer runs.
            env: {
                ...peerEnv(recv),
                TOLI_DRY_RUN: undefined,
                TOLI_LEAD_POLL_MS: "600000",
                TOLI_LEAD_LISTENER_MS: "100",
            },
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
        });
        let second: number | null = null;
        try {
            const first = await until("the first listener", 20_000, () => livePid(root));
            process.kill(first, "SIGKILL");
            second = await until("a new listener", 20_000, () => {
                const pid = livePid(root);
                return pid !== null && pid !== first ? pid : null;
            });
            expect(
                readFileSync(join(root, "logs", "lead.log"), "utf8").match(/started the peer listener/g),
            ).toHaveLength(2);
        } finally {
            lead.kill();
            await lead.exited;
            const left = second ?? livePid(root);
            if (left !== null) process.kill(left, "SIGTERM");
        }
    }, 60_000);

    test("doctor and the fleet check flag a configured listener that is down", () => {
        const recv = peerBox("alpha");
        const down = "peer.listen is on but no peer listener runs";
        expect(recv.box.toli(["doctor"]).stdout).toContain(`warn peer-listener ${down}`);
        expect(JSON.parse(recv.box.ok(["fleet", "check", "--local", "--json"])).listener).toStartWith(down);
        const check = recv.box.ok(["fleet", "check"]);
        expect(check.split("\n")[0]).toEndWith("with waiting work, 1 peer listener down");
        expect(check).toContain(`- alpha: ${down}`);

        recv.box.ok(["peer", "listen", "off"]);
        expect(recv.box.toli(["doctor"]).stdout).toContain("ok peer-listener off (this machine pulls from its peers)");
        expect(JSON.parse(recv.box.ok(["fleet", "check", "--local", "--json"])).listener).toBeNull();
    }, 60_000);

    test("a listener stops once its checkout is gone", async () => {
        const recv = peerBox("alpha");
        const listening = await serve(recv, { TOLI_PEER_RESCAN_MS: "100" });
        try {
            rmSync(join(recv.box.root, "config", "machine.json"));
            expect(await listening.exited).toBe(0);
            expect(readFileSync(join(recv.box.root, "logs", "peer.log"), "utf8")).toContain(
                "listener: config/machine.json is gone; stopping",
            );
        } finally {
            await listening.stop();
        }
    }, 60_000);
});
