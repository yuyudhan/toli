// This installation's peer identity (docs/peers.md "Identity"): an Ed25519 key that signs every message and vouches
// for a self-signed TLS certificate the listener serves. Both live in config/peer/ (private to the machine, secrets at
// mode 0600). The fingerprint people compare is SHA-256 of the raw 32-byte public key. A certificate is bound to the
// key by `certSig`, the key's signature over the certificate's SHA-256, so a renewed certificate needs no re-pairing.
//
// Everything here is node:crypto (Ed25519, SHA-256) plus `openssl` for the X.509 certificate, which node:crypto cannot
// make. No cryptography is written here; the pairing's PAKE is the audited @noble/curves (src/peer/cpace.ts).
import {
    createHash,
    createPrivateKey,
    createPublicKey,
    generateKeyPairSync,
    type KeyObject,
    sign,
    verify,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../core/paths.ts";
import { run, ToliError } from "../core/util.ts";

/** The TLS name every listener's certificate carries; clients ask for it with the peer's certificate pinned. */
export const TLS_NAME = "toli-peer";
const CERT_DAYS = 3650;
const CERT_SIG_CONTEXT = "toli-cert-v1:";

export type Identity = {
    /** The raw 32-byte Ed25519 public key, base64. */
    key: string;
    fingerprint: string;
    privateKey: KeyObject;
    certPem: string;
    certFingerprint: string;
    /** The identity key's signature over `toli-cert-v1:<certFingerprint>`, base64. */
    certSig: string;
    tlsKeyPem: string;
};

function files(): { key: string; pub: string; tlsKey: string; tlsCert: string; certSig: string } {
    const dir = paths.peerConfigDir();
    return {
        key: join(dir, "identity.key"),
        pub: join(dir, "identity.pub"),
        tlsKey: join(dir, "tls.key"),
        tlsCert: join(dir, "tls.crt"),
        certSig: join(dir, "cert.sig"),
    };
}

export function sha256Hex(data: Buffer | string): string {
    return createHash("sha256").update(data).digest("hex");
}

/** The raw public key of an Ed25519 key object. */
function rawPublicKey(key: KeyObject): Buffer {
    const jwk = key.export({ format: "jwk" });
    if (typeof jwk.x !== "string") throw new ToliError("not an Ed25519 key");
    return Buffer.from(jwk.x, "base64url");
}

/** An Ed25519 public key object from its raw base64 form; throws on anything that is not 32 bytes. */
export function publicKeyFromRaw(key: string): KeyObject {
    const raw = Buffer.from(key, "base64");
    if (raw.length !== 32) throw new ToliError("an Ed25519 public key is 32 bytes");
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
}

/** SHA-256 of the raw public key, as 64 hex characters. */
export function fingerprintOf(key: string): string {
    return sha256Hex(Buffer.from(key, "base64"));
}

/**
 * A fingerprint for reading aloud, in colon-joined groups of eight: `3f2a9c01:...`. Never groups of four, so no
 * piece of it looks like a 4-digit pairing code.
 */
export function spokenFingerprint(fingerprint: string): string {
    return (fingerprint.match(/.{1,8}/g) ?? []).join(":");
}

/** The DER bytes of the first certificate in a PEM text. */
export function certDer(pem: string): Buffer {
    const body = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(pem)?.[1];
    if (body === undefined) throw new ToliError("no certificate in the PEM text");
    return Buffer.from(body.replace(/\s+/g, ""), "base64");
}

/** A DER certificate as PEM. */
export function certPem(der: Buffer): string {
    const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
    return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

export function certFingerprintOf(pem: string): string {
    return sha256Hex(certDer(pem));
}

/** JSON with every object's keys sorted and no whitespace: the bytes a signature covers. */
export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (typeof value === "object" && value !== null) {
        const entries = Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

export function signWith(privateKey: KeyObject, data: string | Buffer): string {
    return sign(null, Buffer.from(data), privateKey).toString("base64");
}

/** Whether `signature` (base64) is the raw Ed25519 `key`'s signature over `data`; false for any malformed input. */
export function verifySignature(key: string, data: string | Buffer, signature: string): boolean {
    try {
        return verify(null, Buffer.from(data), publicKeyFromRaw(key), Buffer.from(signature, "base64"));
    } catch {
        return false;
    }
}

/** Whether `certSig` is `key`'s signature over the certificate in `pem`. */
export function certSigValid(key: string, pem: string, certSig: string): boolean {
    try {
        return verifySignature(key, `${CERT_SIG_CONTEXT}${certFingerprintOf(pem)}`, certSig);
    } catch {
        return false;
    }
}

export function hasIdentity(): boolean {
    const file = files();
    return [file.key, file.tlsKey, file.tlsCert, file.certSig].every((path) => existsSync(path));
}

function writeSecret(path: string, text: string): void {
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, text, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
}

/**
 * A fresh self-signed P-256 certificate for TLS_NAME at `certPath`, with its key at `keyPath`. node:crypto makes the
 * key (PKCS#8, which every TLS stack reads; LibreSSL's own EC key output is not) and openssl signs the certificate.
 */
function makeCertificate(keyPath: string, certPath: string): void {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    writeSecret(`${keyPath}.new`, privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    const made = run(
        [
            "openssl",
            "req",
            "-x509",
            "-new",
            "-key",
            `${keyPath}.new`,
            "-out",
            `${certPath}.new`,
            "-days",
            String(CERT_DAYS),
            "-subj",
            `/CN=${TLS_NAME}`,
            "-addext",
            `subjectAltName=DNS:${TLS_NAME}`,
        ],
        { timeoutMs: 30_000 },
    );
    if (made.code !== 0) {
        rmSync(`${keyPath}.new`, { force: true });
        rmSync(`${certPath}.new`, { force: true });
        throw new ToliError(
            made.code === 127
                ? "openssl is required for the peer certificate: install it (macOS ships it; Debian/Ubuntu: sudo apt install openssl)"
                : `openssl req failed (exit ${made.code}): ${(made.stderr || made.stdout).trim()}`,
        );
    }
    renameSync(`${keyPath}.new`, keyPath);
    renameSync(`${certPath}.new`, certPath);
}

/**
 * Create this installation's identity where any part is missing: the Ed25519 key (kept when present), a certificate
 * (kept when present) and its `certSig`. Returns whether anything was made. `rotate` replaces key and certificate.
 */
export function initIdentity(options: { rotate?: boolean } = {}): boolean {
    const file = files();
    mkdirSync(paths.peerConfigDir(), { recursive: true, mode: 0o700 });
    chmodSync(paths.peerConfigDir(), 0o700);
    let made = false;
    if (options.rotate === true || !existsSync(file.key)) {
        const { privateKey, publicKey } = generateKeyPairSync("ed25519");
        writeSecret(file.key, privateKey.export({ format: "pem", type: "pkcs8" }).toString());
        writeFileSync(file.pub, `${rawPublicKey(publicKey).toString("base64")}\n`);
        rmSync(file.certSig, { force: true });
        made = true;
    }
    if (options.rotate === true || !existsSync(file.tlsKey) || !existsSync(file.tlsCert)) {
        makeCertificate(file.tlsKey, file.tlsCert);
        rmSync(file.certSig, { force: true });
        made = true;
    }
    if (!existsSync(file.certSig)) {
        const privateKey = createPrivateKey(readFileSync(file.key, "utf8"));
        const fingerprint = certFingerprintOf(readFileSync(file.tlsCert, "utf8"));
        writeFileSync(file.certSig, `${signWith(privateKey, `${CERT_SIG_CONTEXT}${fingerprint}`)}\n`);
        made = true;
    }
    return made;
}

/** This installation's identity; refuses when `peer init` has not run. */
export function loadIdentity(): Identity {
    if (!hasIdentity()) throw new ToliError("no peer identity here: run `bin/toli peer init`");
    const file = files();
    const privateKey = createPrivateKey(readFileSync(file.key, "utf8"));
    const key = rawPublicKey(createPublicKey(privateKey)).toString("base64");
    const pem = readFileSync(file.tlsCert, "utf8");
    return {
        key,
        fingerprint: fingerprintOf(key),
        privateKey,
        certPem: pem,
        certFingerprint: certFingerprintOf(pem),
        certSig: readFileSync(file.certSig, "utf8").trim(),
        tlsKeyPem: readFileSync(file.tlsKey, "utf8"),
    };
}

/** The identity's secret files whose mode lets anyone but the owner read them (doctor). */
export function looseSecrets(): string[] {
    const file = files();
    return [file.key, file.tlsKey].filter((path) => existsSync(path) && (statSync(path).mode & 0o077) !== 0);
}
