// `bin/toli share`: one lead shares a learning or best practice with other machines' leads (docs/sardars.md). Unlike
// a delegation it carries no work: each receiving lead adopts it (written, dated and with its source, into its own
// data/learnings.md, data/preferences.md when it is the user's own word, or a project's notes), adapts it, or declines
// it with a reason, and the answer goes back to the sender as a wake. Records live in data/shares/<id>.json on both.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Args } from "../core/args.ts";
import { fleetMachine, loadFleet, loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import {
    now,
    out,
    printJson,
    readJson,
    readStdin,
    requireName,
    stamp,
    ToliError,
    warn,
    withLock,
    writeJsonAtomic,
} from "../core/util.ts";
import { sendNow } from "../jobs/outbox.ts";
import { addInboxItem } from "../records/inbox.ts";

export const DECISIONS = ["adopt", "adapt", "decline"] as const;
export type Decision = (typeof DECISIONS)[number];
/** Where an adopted learning is written: data/learnings.md, data/preferences.md, or the project's notes. */
export const TARGETS = ["learnings", "preferences", "notes"] as const;
export type Target = (typeof TARGETS)[number];

export type ShareAnswer = { decision: Decision; note?: string; into?: Target; text?: string; at: string };

export type Share = {
    /** `<sender>-<timestamp>`, the same on the sender and every receiver. */
    id: string;
    from: string;
    at: string;
    text: string;
    project?: string;
    /** The user's words or the evidence the learning comes from. */
    source?: string;
    /** The learning is the user's own word: receiving leads treat it as his rule. */
    fromUser: boolean;
    direction: "sent" | "received";
    /** The machines it was sent to (sender's record). */
    to: string[];
    /** Each receiving lead's answer by machine (sender's record), or this lead's own (receiver's record). */
    answers: Record<string, ShareAnswer>;
};

type Message =
    | { type: "learning"; share: Share }
    | { type: "answer"; id: string; machine: string; answer: ShareAnswer };

function sharePath(id: string): string {
    return join(paths.sharesDir(), `${requireName("share", id)}.json`);
}

function loadShare(id: string): Share | null {
    const path = sharePath(id);
    return existsSync(path) ? readJson<Share | null>(path, null) : null;
}

function saveShare(share: Share): void {
    writeJsonAtomic(sharePath(share.id), share);
}

export function listShares(): Share[] {
    const dir = paths.sharesDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((file) => file.endsWith(".json"))
        .sort()
        .flatMap((file) => {
            const share = readJson<Share | null>(join(dir, file), null);
            return share === null ? [] : [share];
        });
}

function preview(text: string): string {
    const line = text.trim().split("\n", 1)[0] ?? "";
    return line.length <= 80 ? line : `${line.slice(0, 77)}...`;
}

/** The dated memory line an adopted learning becomes. */
export function learningLine(share: Share, text: string, day: string): string {
    const origin = [
        `shared by ${share.from}'s lead`,
        ...(share.fromUser ? ["the user's own word"] : []),
        ...(share.source === undefined ? [] : [`source: ${share.source}`]),
    ].join("; ");
    return `- ${day}: ${text.trim().replace(/\s*\n\s*/g, " ")} (${origin})`;
}

function targetFile(share: Share, into: Target): string {
    if (into === "learnings") return paths.learnings();
    if (into === "preferences") {
        if (!share.fromUser)
            throw new ToliError("preferences hold only the user's own words: this learning is not one (use learnings)");
        return paths.preferences();
    }
    if (share.project === undefined) throw new ToliError("--into notes needs a learning shared with --project");
    return paths.projectNotes(share.project);
}

function appendLine(file: string, line: string): void {
    withLock(paths.lock("memory-write"), () => {
        mkdirSync(dirname(file), { recursive: true });
        const text = existsSync(file) ? readFileSync(file, "utf8") : "";
        appendFileSync(file, `${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`);
    });
}

function receiveLearning(share: Share): void {
    if (loadShare(share.id) !== null) return;
    const received: Share = { ...share, direction: "received", to: [], answers: {} };
    saveShare(received);
    const rule = share.fromUser
        ? "This is the user's own word: treat it as his rule. Adopt it into data/preferences.md unless it conflicts with something he said here; then ask him (a hold) before declining."
        : "Decide whether it fits how this machine works.";
    addInboxItem(
        share.from,
        `learning from ${share.from}: ${preview(share.text)}`,
        [
            `${share.from}'s lead shares a learning (${share.id}):`,
            "",
            share.text.trim(),
            "",
            ...(share.project === undefined ? [] : [`- project: ${share.project}`]),
            ...(share.source === undefined ? [] : [`- source: ${share.source}`]),
            `- from the user's own words: ${share.fromUser ? "yes" : "no"}`,
            "",
            rule,
            `Answer with \`bin/toli share answer ${share.id} adopt [--into learnings|preferences|notes]\`,`,
            `\`... adapt --text "<your version>"\` or \`... decline --note "<why>"\`; the answer goes back to ${share.from}.`,
        ].join("\n"),
    );
}

function receiveAnswer(id: string, machine: string, answer: ShareAnswer): void {
    const share = withLock(paths.lock(`share-${id}`), () => {
        const current = loadShare(id);
        if (current === null || current.direction !== "sent") return null;
        current.answers[machine] = answer;
        saveShare(current);
        return current;
    });
    if (share === null) throw new ToliError(`no learning ${id} was shared from this machine`);
    const detail =
        answer.decision === "decline"
            ? `declined: ${answer.note ?? ""}`
            : `${answer.decision}ed into ${answer.into ?? "learnings"}${answer.text === undefined ? "" : `: ${answer.text}`}${answer.note === undefined ? "" : ` (${answer.note})`}`;
    addInboxItem(
        machine,
        `learning ${id}: ${machine} ${answer.decision === "decline" ? "declined" : `${answer.decision}ed`}`,
        [`Your learning: ${preview(share.text)}`, "", `${machine}'s lead ${detail}`].join("\n"),
    );
}

function parseMessage(text: string): Message {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new ToliError("share receive needs its JSON on stdin");
    }
    if (typeof value !== "object" || value === null) throw new ToliError("share receive: not a JSON object");
    const type: unknown = Reflect.get(value, "type");
    if (type === "learning") {
        const share: unknown = Reflect.get(value, "share");
        if (typeof share !== "object" || share === null) throw new ToliError("share receive: missing share");
        const id: unknown = Reflect.get(share, "id");
        const from: unknown = Reflect.get(share, "from");
        const body: unknown = Reflect.get(share, "text");
        if (typeof id !== "string" || typeof from !== "string" || typeof body !== "string" || body.trim() === "")
            throw new ToliError("share receive: a learning needs id, from and text");
        requireName("share", id);
        requireName("machine", from);
        return { type, share: share as Share };
    }
    if (type === "answer") {
        const id: unknown = Reflect.get(value, "id");
        const machine: unknown = Reflect.get(value, "machine");
        const answer: unknown = Reflect.get(value, "answer");
        if (typeof id !== "string" || typeof machine !== "string" || typeof answer !== "object" || answer === null)
            throw new ToliError("share receive: an answer needs id, machine and answer");
        const decision: unknown = Reflect.get(answer, "decision");
        if (!DECISIONS.some((entry) => entry === decision)) throw new ToliError("share receive: bad decision");
        requireName("machine", machine);
        return { type, id, machine, answer: answer as ShareAnswer };
    }
    throw new ToliError("share receive: type must be learning or answer");
}

/** `share "<learning>" [--to <machine>]... [--all] [--project p] [--source "..."] [--from-user]`. */
function send(args: Args): void {
    args.maxPositional(1);
    const text = args.pos(0, "learning").trim();
    if (text === "") throw new ToliError("share needs the learning's text");
    const self = loadMachine().name;
    const named = args.all("to");
    if (named.length > 0 && args.bool("all")) throw new ToliError("give --to or --all, not both");
    const others = loadFleet().machines.filter((entry) => entry.name !== self);
    const targets = named.length > 0 ? named.map((name) => fleetMachine(requireName("machine", name))) : others;
    if (targets.length === 0) throw new ToliError("no other machine in config/fleet.json to share with");
    if (targets.some((target) => target.name === self)) throw new ToliError("--to names this machine");
    const project = args.str("project");
    if (project !== undefined) requireName("project", project);
    const source = args.str("source");
    const share: Share = {
        id: `${self}-${stamp()}`,
        from: self,
        at: now().toISOString(),
        text,
        ...(project === undefined ? {} : { project }),
        ...(source === undefined ? {} : { source }),
        fromUser: args.bool("from-user"),
        direction: "sent",
        to: targets.map((target) => target.name),
        answers: {},
    };
    saveShare(share);
    const message = JSON.stringify({ type: "learning", share } satisfies Message);
    for (const target of targets) {
        const sent = sendNow(
            self,
            target,
            "share",
            `learning ${share.id}`,
            message,
            `share-${share.id}-${target.name}`,
        );
        if (sent.delivered) out(`shared ${share.id} with ${target.name}`);
        else {
            warn(sent.error);
            out(`queued ${share.id} for ${target.name} (unreachable); the minute tick retries`);
        }
    }
}

/** `share answer <id> adopt|adapt|decline [--into learnings|preferences|notes] [--text "..."] [--note "..."]`. */
function answer(args: Args): void {
    args.maxPositional(2);
    const id = args.pos(0, "id");
    const decisionText = args.pos(1, "decision");
    const decision = DECISIONS.find((entry) => entry === decisionText);
    if (decision === undefined) throw new ToliError(`decision must be one of ${DECISIONS.join(", ")}`);
    const share = loadShare(id);
    if (share === null || share.direction !== "received")
        throw new ToliError(`no learning ${id} was shared with this machine`);
    const note = args.str("note")?.trim();
    const adapted = args.str("text")?.trim();
    const intoText = args.str("into");
    const into =
        intoText === undefined
            ? share.fromUser
                ? "preferences"
                : "learnings"
            : TARGETS.find((entry) => entry === intoText);
    if (into === undefined) throw new ToliError(`--into must be one of ${TARGETS.join(", ")}`);
    if (decision === "decline" && !note) throw new ToliError('decline needs --note "<why>"');
    if (decision === "adapt" && !adapted) throw new ToliError('adapt needs --text "<your version>"');
    const result: ShareAnswer = {
        decision,
        at: now().toISOString(),
        ...(note ? { note } : {}),
        ...(decision === "decline" ? {} : { into }),
        ...(decision === "adapt" && adapted ? { text: adapted } : {}),
    };
    if (decision !== "decline") {
        const file = targetFile(share, into);
        appendLine(file, learningLine(share, adapted || share.text, result.at.slice(0, 10)));
        out(`${decision}ed into ${file}`);
    }
    share.answers[loadMachine().name] = result;
    saveShare(share);
    const self = loadMachine().name;
    const sender = loadFleet().machines.find((entry) => entry.name === share.from);
    if (sender === undefined) {
        warn(`${share.from} is not in config/fleet.json; the answer stays here`);
        return;
    }
    const message = JSON.stringify({ type: "answer", id, machine: self, answer: result } satisfies Message);
    const sent = sendNow(self, sender, "share", `learning ${id} answer`, message, `share-answer-${id}-${self}`);
    if (sent.delivered) out(`answer sent to ${share.from}`);
    else {
        warn(sent.error);
        out(`answer queued for ${share.from} (unreachable); the minute tick retries`);
    }
}

function list(json: boolean): void {
    const shares = listShares();
    if (json) {
        printJson(shares);
        return;
    }
    if (shares.length === 0) {
        out("nothing shared yet");
        return;
    }
    for (const share of shares) {
        const flags = [share.fromUser ? "user's word" : null, share.project ?? null].filter((flag) => flag !== null);
        const head =
            share.direction === "sent"
                ? `${share.id}\tsent to ${share.to.join(", ")}`
                : `${share.id}\treceived from ${share.from}`;
        out(`${head}\t${preview(share.text)}${flags.length > 0 ? `\t(${flags.join("; ")})` : ""}`);
        const waiting = share.direction === "sent" ? share.to.filter((machine) => !(machine in share.answers)) : [];
        for (const [machine, entry] of Object.entries(share.answers))
            out(
                `  ${machine}: ${entry.decision}${entry.into ? ` into ${entry.into}` : ""}${entry.note ? ` (${entry.note})` : ""}`,
            );
        for (const machine of waiting) out(`  ${machine}: no answer yet`);
        if (share.direction === "received" && Object.keys(share.answers).length === 0) out("  not answered yet");
    }
}

export function shareCommand(argv: string[]): void {
    const [sub, ...rest] = argv;
    if (sub === "receive") {
        new Args(rest).maxPositional(0);
        const message = parseMessage(readStdin());
        if (message.type === "learning") receiveLearning(message.share);
        else receiveAnswer(message.id, message.machine, message.answer);
        out("share-received");
        return;
    }
    if (sub === "answer") {
        answer(new Args(rest, { values: ["note", "text", "into"] }));
        return;
    }
    const args = new Args(argv, {
        values: ["to", "project", "source"],
        booleans: ["all", "from-user", "list", "json"],
    });
    if (args.bool("list")) {
        args.maxPositional(0);
        list(args.bool("json"));
        return;
    }
    send(args);
}
