// The introducer's side (docs/peers.md "Introducing a machine"): one approval queues an `introduction` for every box
// (the subject pinned there) and one back to the subject for each box (its roster), signed by this machine's key and
// carried by the outbox like any message. state/peer/introduced.json records what went to whom, so `--status` can
// say where each one is, `--sync` can reach boxes that joined since and renew pins before they expire, and
// `peer remove --fleet` can revoke the subject everywhere it was introduced.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fleetMachine, loadFleet, loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { now, readJson, ToliError, waited, withLock, writeJsonAtomic } from "../core/util.ts";
import type { OutboxItem } from "../jobs/outbox.ts";
import type { Cancelled } from "../jobs/outbox-admin.ts";
import { sendingItems } from "../jobs/outbox-queue.ts";
import { compareVersions, parseVersion } from "../release/release.ts";
import { loadIdentity } from "./identity.ts";
import { type Introduction, type IntroOp, introId, pinExpiry, signIntroduction, subjectOf } from "./introduce.ts";
import {
    type Actor,
    activePeer,
    expired,
    INTRODUCED_GRANTS,
    isPermission,
    loadPeers,
    PERMISSIONS,
    type Peer,
    type Permission,
} from "./store.ts";

/** The first toli release that reads an `introduction`; a box on an older one is not sent one. */
export const INTRODUCTION_SINCE = "0.7.4";
/** `--sync` renews a pin whose `notAfter` is this close. */
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60_000;

/** `--grants talk,share`: only the five permissions, never `introduce`; by default all but `delegate`. */
export function grantList(value: string | undefined): Permission[] {
    if (value === undefined) return [...INTRODUCED_GRANTS];
    const grants = value.split(",").map((entry) => entry.trim());
    if (!grants.every(isPermission)) throw new ToliError(`--grants takes ${PERMISSIONS.join(", ")}`);
    return PERMISSIONS.filter((permission) => grants.includes(permission));
}

/** One box an introduction went to: the certificate for it, and the roster entry for it sent to the subject. */
type Sent = { id: string; rosterId: string; at: number } | { skipped: string; at: number };

type Introduced = {
    fingerprint: string;
    grants: Permission[];
    approval: Introduction["approval"];
    notAfter: string;
    boxes: Record<string, Sent>;
};

type Ledger = Record<string, Introduced>;

function loadLedger(): Ledger {
    return readJson<Ledger>(paths.peerIntroduced(), {});
}

function updateLedger<T>(change: (ledger: Ledger) => T): T {
    return withLock(paths.lock("peer-introduced"), () => {
        const ledger = loadLedger();
        const result = change(ledger);
        writeJsonAtomic(paths.peerIntroduced(), ledger);
        return result;
    });
}

/** The fleet's machines other than this one, as config/fleet.json lists them. */
export function fleetBoxes(): string[] {
    const self = loadMachine().name;
    return loadFleet()
        .machines.map((machine) => machine.name)
        .filter((name) => name !== self);
}

/** Why `box` gets no introduction now (not paired here, or a toli that cannot read one), or null. */
function skipReason(box: Peer | undefined): string | null {
    if (box === undefined) return "not paired here";
    if (expired(box)) return "its pin here expired (its introducer renews it)";
    const version = box.version === undefined ? null : parseVersion(box.version);
    const since = parseVersion(INTRODUCTION_SINCE);
    if (version !== null && since !== null && compareVersions(version, since) < 0)
        return `needs upgrade (toli ${box.version}; bin/toli peer introduce --emit-trust-script is the fallback)`;
    return null;
}

/** Queue `cert` for `to` as an outbox item of kind `introduction`, under the certificate's own id. */
function queue(to: string, cert: Introduction): void {
    writeJsonAtomic(join(paths.outboxDir(), `${cert.id}.json`), {
        from: loadMachine().name,
        title: `${cert.op} ${cert.subject.name}`,
        body: JSON.stringify(cert),
        to: fleetMachine(to),
        kind: "introduction",
        queuedAt: now().getTime(),
    } satisfies OutboxItem);
}

type Approval = { grants: Permission[]; approval: Introduction["approval"]; notAfter: string };

/** Sign one certificate about `subject` for `audience`. */
function certify(op: IntroOp, audience: Peer, subject: Peer, terms: Approval, replaces: string | null = null) {
    return signIntroduction(loadIdentity(), {
        id: introId(),
        op,
        audience: audience.fingerprint,
        subject: subjectOf(subject),
        grants: terms.grants,
        notAfter: terms.notAfter,
        replaces,
        approval: terms.approval,
    });
}

/**
 * Introduce `subject` to each of `boxes` and each box to `subject`, as `op`. A box not paired here, or on a toli that
 * cannot read an introduction, is recorded as skipped. Returns one `<box>: <what happened>` line each, and the
 * certificates queued for the subject (its roster entries).
 */
function sendTo(
    subject: Peer,
    boxes: string[],
    terms: Approval,
    op: IntroOp,
    replaces: string | null,
): { lines: string[]; rosters: Introduction[] } {
    const lines: string[] = [];
    const rosters: Introduction[] = [];
    const sent: Record<string, Sent> = {};
    for (const name of boxes) {
        if (name === subject.name) continue;
        const box = activePeer(name);
        const skipped = skipReason(box);
        if (box === undefined || skipped !== null) {
            sent[name] = { skipped: skipped ?? "not paired here", at: now().getTime() };
            lines.push(`${name}: ${skipped}`);
            continue;
        }
        const cert = certify(op, box, subject, terms, replaces);
        const roster = certify(op, subject, box, terms);
        queue(box.name, cert);
        queue(subject.name, roster);
        rosters.push(roster);
        sent[name] = { id: cert.id, rosterId: roster.id, at: now().getTime() };
        lines.push(`${name}: queued`);
    }
    updateLedger((ledger) => {
        const entry = ledger[subject.name];
        ledger[subject.name] = {
            fingerprint: subject.fingerprint,
            grants: terms.grants,
            approval: terms.approval,
            notAfter: terms.notAfter,
            boxes: { ...(entry?.fingerprint === subject.fingerprint ? entry.boxes : {}), ...sent },
        };
    });
    return { lines, rosters };
}

/** `peer introduce <subject> --fleet|--to ...`: the one approval, fanned out. */
export function introduce(subjectName: string, boxes: string[], grants: Permission[], actor: Actor): string[] {
    const subject = activePeer(subjectName);
    if (subject === undefined) throw new ToliError(`no paired peer "${subjectName}"`);
    const approval = { by: actor.by, why: actor.why, at: now().toISOString() };
    return sendTo(subject, boxes, { grants, approval, notAfter: pinExpiry() }, "introduce", null).lines;
}

/**
 * `POST /v1/roster` from `subject` (its `peer add <this> --fleet`): introduce it to every fleet box with all five
 * permissions, as `peer introduce --fleet` would (so it is on the books: `--status`, renewed by `--sync`), and return
 * the certificates for the subject at once. They stay queued too; delivered again later, they are duplicates.
 */
export function rosterFor(subject: Peer): Introduction[] {
    const approval = { by: loadMachine().name, why: `fleet roster for ${subject.name}`, at: now().toISOString() };
    const terms = { grants: [...PERMISSIONS], approval, notAfter: pinExpiry() };
    return sendTo(subject, fleetBoxes(), terms, "introduce", null).rosters;
}

/** Where one introduction is: delivered and applied, waiting, refused (with the reason), or never sent. */
function stateOf(sent: Sent): string {
    if ("skipped" in sent) return sent.skipped;
    const file = `${sent.id}.json`;
    const queued = existsSync(join(paths.outboxDir(), file)) || sendingItems().some((entry) => entry.file === file);
    if (queued) return `queued ${waited(now().getTime() - sent.at)}`;
    const cancelled = readJson<Cancelled | null>(join(paths.outboxCancelledDir(), file), null);
    return cancelled === null ? "pinned" : `refused: ${cancelled.reason}`;
}

/** `peer introduce --status <subject>`: one `<box>\t<state>` line per box it was introduced to. */
export function introductionStatus(subjectName: string): string[] {
    const entry = loadLedger()[subjectName];
    if (entry === undefined) throw new ToliError(`${subjectName} was never introduced from here`);
    return Object.entries(entry.boxes)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([box, sent]) => `${box}\t${stateOf(sent)}`);
}

/**
 * `peer introduce --sync` (the tick runs it): for every subject introduced from here, introduce it to fleet boxes it
 * has not reached (added since, or upgraded since they were skipped), re-sign everything for a subject whose key
 * rotated, and renew pins within 30 days of expiring.
 */
export function syncIntroductions(): string[] {
    const lines: string[] = [];
    const fleet = fleetBoxes();
    for (const [name, entry] of Object.entries(loadLedger())) {
        const subject = activePeer(name);
        if (subject === undefined) continue;
        const reached = Object.entries(entry.boxes)
            .filter(([, sent]) => !("skipped" in sent))
            .map(([box]) => box);
        const terms = { grants: entry.grants, approval: entry.approval, notAfter: entry.notAfter };
        if (subject.fingerprint !== entry.fingerprint) {
            const renewed = { ...terms, notAfter: pinExpiry() };
            const rotated = sendTo(subject, reached, renewed, "refresh", entry.fingerprint).lines;
            lines.push(...rotated.map((line) => `${name}: new key to ${line}`));
            continue;
        }
        if (Date.parse(entry.notAfter) - now().getTime() < RENEW_BEFORE_MS) {
            const renewed = sendTo(subject, reached, { ...terms, notAfter: pinExpiry() }, "refresh", null).lines;
            lines.push(...renewed.map((line) => `${name}: renewed on ${line}`));
        }
        const missing = fleet.filter(
            (box) => box !== name && !reached.includes(box) && skipReason(activePeer(box)) === null,
        );
        for (const line of sendTo(subject, missing, terms, "introduce", null).lines)
            lines.push(`${name}: introduced to ${line.replace(/: queued$/, "")}`);
    }
    return lines;
}

/** `peer remove <subject> --fleet`: queue a revoke for every box the subject was introduced to. */
export function revokeEverywhere(subjectName: string, actor: Actor): string[] {
    const entry = loadLedger()[subjectName];
    const subject = loadPeers().find((peer) => peer.name === subjectName);
    if (entry === undefined || subject === undefined) return [];
    const terms = { grants: [], approval: { by: actor.by, why: actor.why, at: now().toISOString() }, notAfter: null };
    const told: string[] = [];
    for (const [name, sent] of Object.entries(entry.boxes)) {
        const box = activePeer(name);
        if ("skipped" in sent || box === undefined) continue;
        queue(
            name,
            signIntroduction(loadIdentity(), {
                id: introId(),
                op: "revoke",
                audience: box.fingerprint,
                subject: subjectOf(subject),
                replaces: null,
                ...terms,
            }),
        );
        told.push(name);
    }
    updateLedger((ledger) => {
        delete ledger[subjectName];
    });
    return told;
}

/**
 * `peer introduce --emit-trust-script <subject>`: the `peer trust` lines that pin the subject on every fleet box and
 * every box on the subject, through this machine as the relay: the fallback for a box on an old toli.
 */
export function trustScript(subjectName: string): string[] {
    const subject = activePeer(subjectName);
    if (subject === undefined) throw new ToliError(`no paired peer "${subjectName}"`);
    const self = loadMachine().name;
    const boxes = fleetBoxes().flatMap((name) => {
        const box = activePeer(name);
        return box === undefined || name === subjectName ? [] : [box];
    });
    const why = `--why "introduced by ${self}"`;
    return [
        `# On every fleet box (${boxes.map((box) => box.name).join(", ") || "none"}):`,
        `bin/toli peer trust ${subject.name} --key ${subject.key} --via ${self} ${why}`,
        `# On ${subject.name}:`,
        ...boxes.map((box) => `bin/toli peer trust ${box.name} --key ${box.key} --via ${self} ${why}`),
        `# Fingerprint of ${subject.name} to confirm on each box: ${subject.fingerprint}`,
    ];
}
