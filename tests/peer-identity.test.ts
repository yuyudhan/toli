// `bin/toli peer init|status|list` (docs/peers.md "Identity"): the key and certificate are made once, kept private,
// and the certificate is vouched for by the key.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { certSigValid, fingerprintOf } from "../src/peer/identity.ts";
import { sandbox } from "./helpers.ts";

describe("peer identity", () => {
    test("init makes a private key and a certificate its key vouches for", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        expect(box.ok(["peer", "init"])).toContain("peer identity made");
        const dir = join(box.root, "config", "peer");
        for (const secret of ["identity.key", "tls.key"]) expect(statSync(join(dir, secret)).mode & 0o777).toBe(0o600);
        expect(statSync(dir).mode & 0o777).toBe(0o700);
        const status = JSON.parse(box.ok(["peer", "status", "--json"])) as {
            key: string;
            fingerprint: string;
            cert: string;
            certSig: string;
        };
        expect(status.fingerprint).toBe(fingerprintOf(status.key));
        expect(status.cert).toBe(readFileSync(join(dir, "tls.crt"), "utf8"));
        expect(certSigValid(status.key, status.cert, status.certSig)).toBe(true);
        expect(certSigValid(status.key, status.cert, Buffer.alloc(64).toString("base64"))).toBe(false);
        expect(JSON.stringify(status)).not.toContain("PRIVATE KEY");
    });

    test("init is idempotent: a second run keeps the same key and certificate", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        box.ok(["peer", "init"]);
        const before = box.ok(["peer", "status", "--json"]);
        expect(box.ok(["peer", "init"])).toContain("already");
        expect(box.ok(["peer", "status", "--json"])).toBe(before);
    });

    test("status reads aloud in groups and list starts empty", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        box.ok(["peer", "init"]);
        expect(box.ok(["peer", "status"])).toMatch(/fingerprint: ([0-9a-f]{4} ){15}[0-9a-f]{4}/);
        expect(box.ok(["peer", "list"])).toBe("no peers paired yet: bin/toli peer add <host>");
    });

    test("status before init says how to make the identity", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        expect(box.ok(["peer", "status"])).toContain("no peer identity here: run `bin/toli peer init`");
    });

    test("migrate makes the identity, since an upgrade from an older toli runs only its own steps", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        expect(box.ok(["migrate", "--dry-run"])).not.toContain("peer identity");
        expect(box.ok(["peer", "status"])).toContain("no peer identity here");
        expect(box.ok(["migrate"])).toContain("peer identity made");
        expect(box.ok(["peer", "status"])).toMatch(/fingerprint: /);
        expect(box.ok(["migrate"])).not.toContain("peer identity");
    });

    test("migrate on a checkout that never ran init makes no identity", () => {
        const box = sandbox();
        box.ok(["migrate"]);
        expect(existsSync(join(box.root, "config", "peer"))).toBe(false);
    });
});
