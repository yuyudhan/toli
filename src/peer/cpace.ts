// CPace (draft-irtf-cfrg-cpace, the CFRG balanced PAKE) with ristretto255 and SHA-512, for pairing peers with a
// 4-digit code (docs/peers.md "Pairing"). The group arithmetic is the audited @noble/curves (src/peer/deps.ts); this
// file only composes the draft's byte strings (prepend_len, lv_cat, generator_string, transcript_ir) and its steps,
// checked against the draft's test vectors (tests/peer-pair.test.ts). Each run gives an attacker one online guess of
// the code; a passive observer learns nothing.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { loadNoble, type Noble } from "./deps.ts";

export const DSI = Buffer.from("CPaceRistretto255");
const DSI_ISK = Buffer.from("CPaceRistretto255_ISK");
/** SHA-512's input block size: the generator string pads DSI and PRS to fill the first block. */
const S_IN_BYTES = 128;

/** LEB128 length, then the bytes. */
export function prependLen(data: Uint8Array): Buffer {
    const length: number[] = [];
    let rest = data.length;
    for (;;) {
        if (rest < 128) {
            length.push(rest);
            break;
        }
        length.push((rest & 0x7f) | 0x80);
        rest >>= 7;
    }
    return Buffer.concat([Buffer.from(length), data]);
}

export function lvCat(...parts: Uint8Array[]): Buffer {
    return Buffer.concat(parts.map(prependLen));
}

export function generatorString(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Buffer {
    const zpad = Math.max(0, S_IN_BYTES - 1 - prependLen(prs).length - prependLen(DSI).length);
    return lvCat(DSI, prs, Buffer.alloc(zpad), ci, sid);
}

function sha512(data: Uint8Array): Buffer {
    return createHash("sha512").update(data).digest();
}

type Point = InstanceType<Noble["ristretto255"]["Point"]>;

/** g = element_derivation(SHA-512(generator_string)). */
export function calculateGenerator(noble: Noble, prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Point {
    const derive = noble.ristretto255_hasher.deriveToCurve;
    if (derive === undefined) throw new Error("@noble/curves lacks ristretto255 element derivation");
    return derive(sha512(generatorString(prs, ci, sid)));
}

/** A little-endian 32-byte scalar as a bigint. */
export function scalarFromLe(bytes: Uint8Array): bigint {
    return BigInt(`0x${Buffer.from(bytes).reverse().toString("hex") || "0"}`);
}

/** sample_scalar: 32 random bytes with the bits above 252 cleared, never zero. */
export function sampleScalar(): bigint {
    for (;;) {
        const bytes = randomBytes(32);
        bytes[31] = (bytes[31] ?? 0) & 0x0f;
        const scalar = scalarFromLe(bytes);
        if (scalar !== 0n) return scalar;
    }
}

export function scalarMult(scalar: bigint, point: Point): Buffer {
    return Buffer.from(point.multiply(scalar).toBytes());
}

/** scalar_mult_vfy: K encoded, or null when `encoded` is not a valid element or K is the identity (abort). */
export function scalarMultVfy(noble: Noble, scalar: bigint, encoded: Uint8Array): Buffer | null {
    try {
        const point = noble.ristretto255.Point.fromBytes(encoded);
        const product = point.multiply(scalar);
        return product.is0() ? null : Buffer.from(product.toBytes());
    } catch {
        return null;
    }
}

export function transcriptIr(ya: Uint8Array, ada: Uint8Array, yb: Uint8Array, adb: Uint8Array): Buffer {
    return Buffer.concat([lvCat(ya, ada), lvCat(yb, adb)]);
}

/** ISK = SHA-512(lv_cat(DSI_ISK, sid, K) || transcript). */
export function isk(sid: Uint8Array, k: Uint8Array, transcript: Uint8Array): Buffer {
    return sha512(Buffer.concat([lvCat(DSI_ISK, sid, k), transcript]));
}

/** Key confirmation: each side proves it holds ISK, bound to its role and the whole transcript. */
export function confirmTag(key: Uint8Array, role: "A" | "B", transcript: Uint8Array): Buffer {
    return createHmac("sha256", key)
        .update(Buffer.from(`toli-pair-${role}`))
        .update(transcript)
        .digest();
}

export function tagsEqual(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
}

/** One side's pairing inputs: everything both sides must agree on besides the code. */
export type PairInputs = {
    reqId: string;
    nameA: string;
    nameB: string;
    keyA: string;
    keyB: string;
    certFpA: string;
    certFpB: string;
};

/** sid: SHA-256 over both identity keys and both certificate fingerprints, so a relay's own keys change it. */
export function pairSid(inputs: PairInputs): Buffer {
    return createHash("sha256")
        .update(
            lvCat(
                Buffer.from("toli-pair-v1"),
                Buffer.from(inputs.reqId),
                Buffer.from(inputs.keyA, "base64"),
                Buffer.from(inputs.keyB, "base64"),
                Buffer.from(inputs.certFpA, "hex"),
                Buffer.from(inputs.certFpB, "hex"),
            ),
        )
        .digest();
}

export function pairCi(inputs: PairInputs): Buffer {
    return lvCat(Buffer.from(inputs.nameA), Buffer.from(inputs.nameB));
}

/** One party's first move: its secret scalar and the share to send. */
export async function cpaceShare(code: string, inputs: PairInputs): Promise<{ scalar: bigint; share: Buffer }> {
    const noble = await loadNoble();
    const g = calculateGenerator(noble, Buffer.from(code), pairCi(inputs), pairSid(inputs));
    const scalar = sampleScalar();
    return { scalar, share: scalarMult(scalar, g) };
}

/** Both shares known: the session key and the transcript, or null when the other share is invalid (abort). */
export async function cpaceFinish(
    scalar: bigint,
    inputs: PairInputs,
    shareA: Uint8Array,
    shareB: Uint8Array,
    mine: "A" | "B",
): Promise<{ key: Buffer; transcript: Buffer } | null> {
    const noble = await loadNoble();
    const k = scalarMultVfy(noble, scalar, mine === "A" ? shareB : shareA);
    if (k === null) return null;
    const transcript = transcriptIr(
        shareA,
        Buffer.from(inputs.certFpA, "hex"),
        shareB,
        Buffer.from(inputs.certFpB, "hex"),
    );
    return { key: isk(pairSid(inputs), k, transcript), transcript };
}
