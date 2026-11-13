// Sealing a signed envelope for one peer, so a relay that carries it can neither read nor change it (docs/peers.md
// "Relay"). The envelope inside is the one HTTPS delivery sends, already signed by its sender's Ed25519 key; sealing
// adds secrecy and binds the routing header the relay sees:
//
//   ephemeral X25519 key  x  the recipient's Ed25519 key in its X25519 form   ->  shared secret
//   HKDF-SHA256(shared, salt = ephemeral public key || recipient X25519 key, info "toli-relay-v1")  ->  AES-256-GCM key
//   AES-256-GCM(key, random 12-byte nonce, additional data = the canonical header)  ->  ct (ciphertext || 16-byte tag)
//
// A fresh ephemeral key per seal means a fresh AES key, so a nonce never repeats under one key. The curve arithmetic is
// the audited @noble/curves (src/peer/deps.ts); AES-GCM and HKDF are node:crypto. No cryptography is written here.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { isJsonObject } from "../core/util.ts";
import { loadNoble } from "./deps.ts";
import { canonicalJson, type Identity } from "./identity.ts";

const INFO = "toli-relay-v1";
const TAG_BYTES = 16;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * What a relay holds: `from`/`fromKey` the sender (its name and key fingerprint), `to` the recipient's fingerprint,
 * `id` the item's id and `seq` its order among the sender's items. The relay routes by them; all are covered by the
 * tag, so changing one makes the recipient refuse the item.
 */
export type Sealed = {
    v: 1;
    from: string;
    fromKey: string;
    to: string;
    id: string;
    seq: number;
    eph: string;
    nonce: string;
    ct: string;
};

export type SealHeader = Pick<Sealed, "from" | "fromKey" | "to" | "id" | "seq">;

function aesKey(shared: Uint8Array, ephPublic: Uint8Array, recipientX: Uint8Array): Buffer {
    return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephPublic, recipientX]), INFO, 32));
}

function additionalData(sealed: Omit<Sealed, "ct">): Buffer {
    return Buffer.from(canonicalJson(sealed));
}

/** Seal `plaintext` (a signed envelope's JSON) for the peer whose raw Ed25519 key is `recipientKey` (base64). */
export async function seal(header: SealHeader, recipientKey: string, plaintext: string): Promise<Sealed> {
    const { ed25519, x25519 } = await loadNoble();
    const recipientX = ed25519.utils.toMontgomery(Buffer.from(recipientKey, "base64"));
    const ephSecret = x25519.utils.randomSecretKey();
    const ephPublic = x25519.getPublicKey(ephSecret);
    const nonce = randomBytes(12);
    const unsealed: Omit<Sealed, "ct"> = {
        v: 1,
        ...header,
        eph: Buffer.from(ephPublic).toString("base64"),
        nonce: nonce.toString("base64"),
    };
    const cipher = createCipheriv(
        "aes-256-gcm",
        aesKey(x25519.getSharedSecret(ephSecret, recipientX), ephPublic, recipientX),
        nonce,
    );
    cipher.setAAD(additionalData(unsealed));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return { ...unsealed, ct: ct.toString("base64") };
}

/** A well-formed sealed item, or null. */
export function sealedShape(value: unknown): Sealed | null {
    if (!isJsonObject(value) || value.v !== 1) return null;
    const strings = ["from", "fromKey", "to", "id", "eph", "nonce", "ct"];
    if (!strings.every((field) => typeof value[field] === "string")) return null;
    if (typeof value.seq !== "number" || !Number.isFinite(value.seq)) return null;
    if (
        !ID.test(String(value.id)) ||
        !/^[0-9a-f]{64}$/.test(String(value.fromKey)) ||
        !/^[0-9a-f]{64}$/.test(String(value.to))
    )
        return null;
    return value as Sealed;
}

/**
 * Open an item sealed for `identity`: the plaintext, or null when it was not sealed for this key or anything in it
 * (header, nonce, ciphertext) was changed.
 */
export async function unseal(identity: Identity, sealed: Sealed): Promise<string | null> {
    const { ed25519, x25519 } = await loadNoble();
    const seed = identity.privateKey.export({ format: "jwk" }).d;
    if (typeof seed !== "string") return null;
    const secretX = ed25519.utils.toMontgomerySecret(Buffer.from(seed, "base64url"));
    const recipientX = x25519.getPublicKey(secretX);
    const ephPublic = Buffer.from(sealed.eph, "base64");
    const nonce = Buffer.from(sealed.nonce, "base64");
    const ct = Buffer.from(sealed.ct, "base64");
    if (ephPublic.length !== 32 || nonce.length !== 12 || ct.length < TAG_BYTES) return null;
    try {
        const shared = x25519.getSharedSecret(secretX, ephPublic);
        const decipher = createDecipheriv("aes-256-gcm", aesKey(shared, ephPublic, recipientX), nonce);
        const { ct: _ct, ...unsealed } = sealed;
        decipher.setAAD(additionalData(unsealed));
        decipher.setAuthTag(ct.subarray(ct.length - TAG_BYTES));
        return Buffer.concat([decipher.update(ct.subarray(0, ct.length - TAG_BYTES)), decipher.final()]).toString(
            "utf8",
        );
    } catch {
        // A low-order ephemeral key (x25519 refuses it) or a failed tag: not sealed for this key, or changed.
        return null;
    }
}
