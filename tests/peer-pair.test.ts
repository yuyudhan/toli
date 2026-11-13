// Pairing with a 4-digit code (docs/peers.md "Pairing"): CPace against the draft's ristretto255/SHA-512 test vectors
// (draft-irtf-cfrg-cpace-14, B.3.9 and B.3.11), then two real installations pairing over HTTPS, and every refusal: a
// wrong code (3 tries, then the request is gone and a 4th try finds nothing), an expired code, a forged request.
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    calculateGenerator,
    confirmTag,
    cpaceFinish,
    cpaceShare,
    generatorString,
    isk,
    type PairInputs,
    scalarFromLe,
    scalarMult,
    scalarMultVfy,
    tagsEqual,
    transcriptIr,
} from "../src/peer/cpace.ts";
import { loadNoble } from "../src/peer/deps.ts";
import { type PeerBox, peerBox, sender } from "./peer-fixture.ts";
import { type Listening, serve } from "./peer-serve-fixture.ts";

const hex = (value: string) => Buffer.from(value, "hex");

// draft-irtf-cfrg-cpace-14 B.3.9, decoded.
const V = {
    PRS: "50617373776F7264",
    CI: "6F630B425F726573706F6E6465720B415F696E69746961746F72",
    sid: "7E4B4791D6A8EF019B936C79FB7F2C57",
    g: "A6FC82C3B8968FBB2E06FEE81CA858586DEA50D248F0C7CA6A18B0902A30B36B",
    ya: "DA3D23700A9E5699258AEF94DC060DFDA5EBB61F02A5EA77FAD53F4FF0976D08",
    ADa: "414461",
    Ya: "D40FB265A7ABEAEE7939D91A585FE59F7053F982C296EC413C624C669308F87A",
    yb: "D2316B454718C35362D83D69DF6320F38578ED5984651435E2949762D900B80D",
    ADb: "414462",
    Yb: "08BCF6E9777A9C313A3DB6DAA510F2D398403319C2341BD506A92E672EB7E307",
    K: "E22B1EF7788F661478F3CDDD4C600774FC0F41E6B711569190FF88FA0E607E09",
    ISK_IR: "4C5469A16B2364C4B944EBC1A79E51D1674AD47DB26E8718154F59FAEBFAA52D8346F30AA58377117EB20D527F2CBC5C76381F7FD372E89DF8239F87F2E02ED1",
};
// B.3.10 and B.3.11.
const VALID = {
    s: "7CD0E075FA7955BA52C02759A6C90DBBFC10E6D40AEA8D283E407D88CF538A05",
    X: "2C3C6B8C4F3800E7AEF6864025B4ED79BD599117E427C41BD47D93D654B4A51C",
    product: "7C13645FE790A468F62C39BEB7388E541D8405D1ADE69D1778C5FE3E7F6B600E",
};
const INVALID = [
    "2B3C6B8C4F3800E7AEF6864025B4ED79BD599117E427C41BD47D93D654B4A51C",
    "0000000000000000000000000000000000000000000000000000000000000000",
];

describe("CPace (draft-irtf-cfrg-cpace-14, ristretto255 and SHA-512)", () => {
    test("matches the draft's test vectors: generator, shares, K and ISK", async () => {
        const noble = await loadNoble();
        expect(generatorString(hex(V.PRS), hex(V.CI), hex(V.sid)).length).toBe(172);
        const g = calculateGenerator(noble, hex(V.PRS), hex(V.CI), hex(V.sid));
        expect(Buffer.from(g.toBytes()).toString("hex")).toBe(V.g.toLowerCase());
        const ya = scalarFromLe(hex(V.ya));
        const yb = scalarFromLe(hex(V.yb));
        expect(scalarMult(ya, g).toString("hex")).toBe(V.Ya.toLowerCase());
        expect(scalarMult(yb, g).toString("hex")).toBe(V.Yb.toLowerCase());
        const ka = scalarMultVfy(noble, ya, hex(V.Yb));
        const kb = scalarMultVfy(noble, yb, hex(V.Ya));
        expect(ka?.toString("hex")).toBe(V.K.toLowerCase());
        expect(kb?.toString("hex")).toBe(V.K.toLowerCase());
        const transcript = transcriptIr(hex(V.Ya), hex(V.ADa), hex(V.Yb), hex(V.ADb));
        expect(isk(hex(V.sid), hex(V.K), transcript).toString("hex")).toBe(V.ISK_IR.toLowerCase());
    });

    test("scalar_mult_vfy: valid input multiplies, invalid encodings and the identity abort", async () => {
        const noble = await loadNoble();
        expect(scalarMultVfy(noble, scalarFromLe(hex(VALID.s)), hex(VALID.X))?.toString("hex")).toBe(
            VALID.product.toLowerCase(),
        );
        for (const invalid of INVALID)
            expect(scalarMultVfy(noble, scalarFromLe(hex(VALID.s)), hex(invalid))).toBeNull();
    });

    test("a relay with its own keys gets a different session key on each side: no tag verifies", async () => {
        const fp = (char: string) => char.repeat(64);
        const key = (byte: number) => Buffer.alloc(32, byte).toString("base64");
        const real: PairInputs = {
            reqId: "r1",
            nameA: "alpha",
            nameB: "beta",
            keyA: key(1),
            keyB: key(2),
            certFpA: fp("a"),
            certFpB: fp("b"),
        };
        // A talks to the relay as if it were B (the relay's key and certificate); B sees the relay as A.
        const aView: PairInputs = { ...real, keyB: key(9), certFpB: fp("9") };
        const bView: PairInputs = { ...real, keyA: key(9), certFpA: fp("9") };
        const a = await cpaceShare("1234", aView);
        const b = await cpaceShare("1234", bView);
        const aDone = await cpaceFinish(a.scalar, aView, a.share, b.share, "A");
        const bDone = await cpaceFinish(b.scalar, bView, a.share, b.share, "B");
        if (aDone === null || bDone === null) throw new Error("valid shares aborted");
        expect(
            tagsEqual(confirmTag(aDone.key, "A", aDone.transcript), confirmTag(bDone.key, "A", bDone.transcript)),
        ).toBe(false);
        // The same inputs on both sides do agree.
        const a2 = await cpaceShare("1234", real);
        const b2 = await cpaceShare("1234", real);
        const aKey = await cpaceFinish(a2.scalar, real, a2.share, b2.share, "A");
        const bKey = await cpaceFinish(b2.scalar, real, a2.share, b2.share, "B");
        expect(aKey?.key.equals(bKey?.key ?? Buffer.alloc(0))).toBe(true);
    });
});

type Pair = { a: PeerBox; b: PeerBox; listening: Listening; target: string };

const running: Listening[] = [];
afterEach(async () => {
    for (const listening of running.splice(0)) await listening.stop();
});

async function pairBoxes(env: Record<string, string> = {}): Promise<Pair> {
    const a = peerBox("alpha");
    const b = peerBox("beta");
    const listening = await serve(b, env);
    running.push(listening);
    return { a, b, listening, target: `127.0.0.1:${listening.port}` };
}

function requestId(pair: Pair): string {
    const out = pair.a.box.ok(["peer", "add", pair.target]);
    expect(out).toContain("asked beta to pair");
    const reqId = /request ([0-9a-f]{16})/.exec(out)?.[1];
    if (reqId === undefined) throw new Error(`no request id in: ${out}`);
    return reqId;
}

function codeFor(pair: Pair, reqId: string): string {
    const out = pair.b.box.ok(["peer", "accept", reqId, "--by", "owner", "--why", "test"]);
    const code = /^Pairing code: (\d{4}) \(tell this to alpha's requester\)$/m.exec(out)?.[1];
    expect(out).toMatch(/^fingerprint: [0-9a-f]{8}(:[0-9a-f]{8}){7}$/m);
    expect(out).not.toMatch(/\b[0-9a-f]{4} [0-9a-f]{4}\b/);
    if (code === undefined) throw new Error(`no code in: ${out}`);
    return code;
}

function peersOf(box: PeerBox): Array<{ name: string; allow: string[]; status: string }> {
    return JSON.parse(box.box.ok(["peer", "list", "--json"])) as Array<{
        name: string;
        allow: string[];
        status: string;
    }>;
}

const wrong = (code: string) => String((Number(code) + 1) % 10_000).padStart(4, "0");

describe("pairing with a 4-digit code", () => {
    test("request, accept, code: both sides pin each other with every permission", async () => {
        const pair = await pairBoxes();
        const reqId = requestId(pair);
        const requests = JSON.parse(pair.b.box.ok(["peer", "requests", "--json"])) as Array<{
            reqId: string;
            name: string;
        }>;
        expect(requests.map((request) => [request.reqId, request.name])).toEqual([[reqId, "alpha"]]);
        const code = codeFor(pair, reqId);
        const done = pair.a.box.ok(["peer", "add", pair.target, "--code", code, "--by", "owner", "--why", "test"]);
        expect(done).toContain("paired with beta");
        for (const [box, other] of [
            [pair.a, "beta"],
            [pair.b, "alpha"],
        ] as const) {
            const peers = peersOf(box);
            expect(peers.map((peer) => [peer.name, peer.status, peer.allow])).toEqual([
                [other, "active", ["talk", "delegate", "share", "answer", "status"]],
            ]);
        }
        expect(JSON.parse(pair.b.box.ok(["peer", "requests", "--json"]))).toEqual([]);
    });

    test("the request's inbox item and the logs never hold the code", async () => {
        const pair = await pairBoxes();
        const reqId = requestId(pair);
        const inbox = join(pair.b.box.root, "data", "inbox");
        const items = readdirSync(inbox).map((file) => readFileSync(join(inbox, file), "utf8"));
        expect(items.some((item) => item.includes(`peer accept ${reqId}`))).toBe(true);
        const code = codeFor(pair, reqId);
        for (const item of readdirSync(inbox).map((file) => readFileSync(join(inbox, file), "utf8")))
            expect(item).not.toContain(code);
        const log = readFileSync(join(pair.b.box.root, "logs", "peer.log"), "utf8");
        expect(log).toContain(`accepted pairing request ${reqId}`);
        expect(log).not.toMatch(new RegExp(`\\b${code}\\b`));
    });

    test("a wrong code is refused with the tries left; the third kills the request and a 4th try finds nothing", async () => {
        const pair = await pairBoxes();
        const reqId = requestId(pair);
        const code = codeFor(pair, reqId);
        const tryCode = (value: string) => pair.a.box.toli(["peer", "add", pair.target, "--code", value]);
        const first = tryCode(wrong(code));
        expect(first.code).toBe(1);
        expect(first.stderr).toContain("wrong code; 2 tries left");
        expect(tryCode(wrong(code)).stderr).toContain("wrong code; 1 try left");
        expect(tryCode(wrong(code)).stderr).toContain("that was the last try");
        const fourth = tryCode(code);
        expect(fourth.code).toBe(1);
        expect(fourth.stderr).toContain("no such pairing request here");
        expect(peersOf(pair.a)).toEqual([]);
        expect(peersOf(pair.b)).toEqual([]);
        const inbox = join(pair.b.box.root, "data", "inbox");
        expect(
            readdirSync(inbox).some((file) => readFileSync(join(inbox, file), "utf8").includes("3 wrong codes")),
        ).toBe(true);
        const again = pair.a.box.toli(["peer", "add", pair.target]);
        expect(again.code).toBe(1);
        expect(again.stderr).toContain("held after 3 wrong codes");
    });

    test("one source may ask 3 times an hour: the 4th request is refused", async () => {
        const pair = await pairBoxes();
        for (let index = 0; index < 3; index += 1) requestId(pair);
        const fourth = pair.a.box.toli(["peer", "add", pair.target]);
        expect(fourth.code).toBe(1);
        expect(fourth.stderr).toContain("at most 3 pairing requests an hour");
    });

    test("an expired code kills its request", async () => {
        const pair = await pairBoxes({ TOLI_PEER_CODE_TTL_MS: "1" });
        const reqId = requestId(pair);
        const code = codeFor(pair, reqId);
        await Bun.sleep(20);
        const late = pair.a.box.toli(["peer", "add", pair.target, "--code", code]);
        expect(late.code).toBe(1);
        expect(late.stderr).toContain("the code expired");
        expect(peersOf(pair.b)).toEqual([]);
    });

    test("no code before the owner accepts, and a code typed with no request is refused", async () => {
        const pair = await pairBoxes();
        const early = pair.a.box.toli(["peer", "add", pair.target, "--code", "1234"]);
        expect(early.code).toBe(1);
        expect(early.stderr).toContain("no pairing request to");
        requestId(pair);
        const unaccepted = pair.a.box.toli(["peer", "add", pair.target, "--code", "1234"]);
        expect(unaccepted.code).toBe(1);
        expect(unaccepted.stderr).toContain("no code yet");
    });

    test("a request signed by another key, or with a certificate its key does not vouch for, is refused", async () => {
        const pair = await pairBoxes();
        const mallory = sender();
        const body = {
            reqId: "0123456789abcdef",
            name: "mallory",
            key: mallory.key,
            cert: pair.a.cert,
            certSig: pair.a.certSig,
            addrs: [],
            version: "0",
            sentAt: Date.now(),
            nonce: "n",
            sig: "AAAA",
        };
        const forged = await pair.listening.post("/v1/pair/request", body);
        expect(forged.status).toBe(401);
        expect(JSON.parse(pair.b.box.ok(["peer", "requests", "--json"]))).toEqual([]);
    });

    test("allow, deny and remove change a peer's permissions, logged with who and why", async () => {
        const pair = await pairBoxes();
        const reqId = requestId(pair);
        pair.a.box.ok(["peer", "add", pair.target, "--code", codeFor(pair, reqId)]);
        expect(pair.b.box.ok(["peer", "deny", "alpha", "delegate", "--why", "test"])).toBe(
            "alpha may now: talk, share, answer, status",
        );
        expect(pair.b.box.ok(["peer", "allow", "alpha", "delegate"])).toBe(
            "alpha may now: talk, delegate, share, answer, status",
        );
        const sardar = pair.b.box.toli(["peer", "deny", "alpha", "talk", "--by", "sardar"]);
        expect(sardar.code).toBe(1);
        expect(sardar.stderr).toContain("the Sardar must say why");
        pair.b.box.ok(["peer", "remove", "alpha", "--by", "sardar", "--why", "machine retired"]);
        expect(peersOf(pair.b).map((peer) => [peer.name, peer.status])).toEqual([["alpha", "revoked"]]);
        const log = readFileSync(join(pair.b.box.root, "logs", "peer.log"), "utf8");
        expect(log).toContain("denied alpha delegate by the owner: test");
        expect(log).toContain("removed alpha by the sardar: machine retired");
    });
});
