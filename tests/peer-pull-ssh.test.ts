// A paired peer gets nothing over ssh once `peer.sshFallback` is off (docs/peers.md "The listener"), pulls
// included: the minute tick's ssh `outbox pull` leaves a paired peer's items for the HTTPS pull.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, SSH_STUB_ARGS, sandbox, TOLI_BIN } from "./helpers.ts";
import { pin, sender } from "./peer-fixture.ts";

/** m1 takes no inbound ssh, so it pulls from m2 over ssh; m2's `ssh` stub runs m1's commands and logs each host. */
function pair(): { m1: Sandbox; m2: Sandbox; sshLog: () => string } {
    const m1 = sandbox();
    const m2 = sandbox();
    m1.ok(["init", "--name", "m1", "--role", "coordinator"]);
    m2.ok(["init", "--name", "m2", "--role", "worker", "--coordinator-ssh", "host1", "--coordinator-root", m1.root]);
    const fleet = JSON.stringify({
        machines: [
            { name: "m1", ssh: "host1", root: m1.root, inbound: false },
            { name: "m2", ssh: "host2", root: m2.root },
        ],
    });
    for (const box of [m1, m2]) writeFileSync(join(box.root, "config", "fleet.json"), fleet);
    const log = join(m1.root, ".ssh.log");
    m1.stub(
        "ssh",
        [
            SSH_STUB_ARGS,
            `printf '%s %s\\n' "$host" "$cmd" >> "${log}"`,
            `case "$host" in host2) root="${m2.root}" ;; *) echo "ssh: connect to host $host port 22: Connection refused" >&2; exit 255 ;; esac`,
            `cmd=$(printf '%s' "$cmd" | sed "s#bin/toli #'${process.execPath}' '${TOLI_BIN}' #")`,
            'TOLI_ROOT="$root" exec sh -c "$cmd"',
        ].join("\n"),
    );
    return { m1, m2, sshLog: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
}

const queued = (box: Sandbox): string[] => {
    const dir = join(box.root, "state", "outbox");
    return existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".json")) : [];
};

describe("the ssh pull and a paired peer", () => {
    test("with ssh fallback off, a paired peer's items are left for the HTTPS pull", () => {
        const { m1, m2, sshLog } = pair();
        m2.ok(["talk", "m1", "over https only"]);
        expect(queued(m2)).toHaveLength(1);
        pin(m1, [{ name: "m2", identity: sender() }]);
        m1.ok(["peer", "set", "--ssh-fallback", "off"]);
        const report = JSON.parse(m1.ok(["outbox", "pull", "--json"])) as { pulled: number; held: string[] };
        expect(report.pulled).toBe(0);
        expect(sshLog()).not.toContain("host2");
        expect(queued(m2)).toHaveLength(1);

        m1.ok(["peer", "set", "--ssh-fallback", "on"]);
        expect(JSON.parse(m1.ok(["outbox", "pull", "--json"]))).toMatchObject({ pulled: 1, applied: 1 });
        expect(queued(m2)).toEqual([]);
    });
});
