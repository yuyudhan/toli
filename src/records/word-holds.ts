// Questions only the user can answer, asked by another machine (docs/sardars.md "Questions for the user"): a peer
// message (`talk`, any `inbox add` from another machine) or a delegated task's held update that asks for the user's
// word ("<name>'s word", "question for <name>", "needs his word", "Reply <option>", or toli's own hold format: a
// `## Question` section, `task hold --question`) goes into this machine's Needs-you queue on arrival, not only the
// inbox. A delegated question holds the `--for` task (src/records/delegation-sync.ts); anything else becomes a new
// held task in the sender's project, with the question, and the options, recommendation and what it blocks when the
// message names them. Each sender's question is held once (state/word-holds.json): a reminder repeating it, or one
// already answered (`task answer`), never holds again. The tick's look over the inbox holds only unacknowledged
// messages that arrived since it first looked, never older ones, and skips a message this machine already answered
// with a `talk` reply quoting it (state/talk-sent.jsonl). A Sardar citing the user's word as authority ("on Asha's
// word", "Asha's word (date): '...'", "questions for Asha go to hub") asks nothing of him, and neither does a jawan
// brief sent as a message (`TOLI_BRIEF` first) or a hold quoted as a template (`--option "<choice> => ..."`).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadMachine } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { userNames } from "../core/persona.ts";
import { now, readJson, withLock, writeJsonAtomic } from "../core/util.ts";
import { loadProjects } from "../projects/projects.ts";
import { loadBacklog, type Task, updateBacklog } from "./backlog.ts";
import { listInbox } from "./inbox.ts";
import { collapse, parseWordQuestion, quotesTemplateOnly, type WordQuestion } from "./word-question.ts";

/** One held question: the task holding it and where it came from. */
type HeldWord = { task: string; at: string; source: string };

/**
 * state/word-holds.json: when the tick first looked at the inbox (it never holds what arrived before), held questions
 * by sender and question, and inbox items the tick already read, by file.
 */
type Registry = { since?: string; holds: Record<string, HeldWord>; read: Record<string, string> };

/** A held question is remembered this long, so a reminder weeks later still does not hold it twice. */
const HELD_KEEP_MS = 60 * 86_400_000;
/** The tick looks this far back in the inbox. */
const SCAN_MS = 86_400_000;
/** At most this many sent `talk` lines are kept. */
const TALK_KEEP = 500;
/** A reply quotes a message when it holds this much of its question (or all of a shorter one). */
const QUOTE_CHARS = 60;
/** A project name shorter than this is never matched in a message's words. */
const NAMED_MIN = 4;

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A mention of the user's word, and when it cites his word as authority instead of asking for it. */
type WordPhrase = { pattern: RegExp; cites?: (before: string, after: string) => boolean };

/**
 * "Asha's word" cited, not asked for: "on/per/by Asha's word", "act on Asha's word when ...", or introducing a quote of
 * what he said ("Asha's word (2026-11-18): '...'").
 */
const citesWord = (before: string, after: string): boolean =>
    /\b(?:on|upon|per|by|under)\s+$/i.test(before) || /^\s*(?:\([^)\n]*\)\s*)?:\s*['"‘“]/.test(after);

/** "questions for Asha go to hub": where his questions are sent, not one of them. */
const routesQuestions = (_before: string, after: string): boolean =>
    /^\s+(?:go(?:es)?|should go|(?:are|is) (?:sent|routed))\b/i.test(after);

/** Phrases that mention the user's word, the installation's own user name included. */
function wordPhrases(): WordPhrase[] {
    const user = userNames().map(escapeRegex).join("|");
    return [
        { pattern: new RegExp(`\\b(?:${user})'s word\\b`, "gi"), cites: citesWord },
        { pattern: /\b[A-Z][\w-]*'s word\b/g, cites: citesWord },
        { pattern: /\bthe user's word\b/gi, cites: citesWord },
        { pattern: new RegExp(`\\bquestions? for (?:${user}|the user)\\b`, "gi"), cites: routesQuestions },
        { pattern: /\bquestions? for [A-Z][\w-]*\b/g, cites: routesQuestions },
        { pattern: /\bneeds? (?:his|her|their|your) word\b/gi },
        { pattern: /\bword needed\b/gi },
    ];
}

/** `Reply "<option>"`, `Reply 2`, `Reply yes`: asks for a pick in itself. */
const REPLY_OPTION = /(?:^|[.!?:;]\s+)Reply\s+(?:[`"'][^`"'\n]+[`"']|\(?\d\)?(?!\w)|yes\b|no\b)/m;

/** toli's own hold format: a `## Question` section, or a `task hold ... --question` command line. */
const HOLD_FORMAT = [/^##\s*Question\s*$/m, /--question\s+["']/];

/**
 * Whether `text` is a jawan brief (`TOLI_BRIEF v1` first, after an optional part marker such as `1/3` or `(part 2/3)`):
 * work handed over, which goes by `bin/toli delegate <machine> "<title>" --brief <file>`, never a question.
 */
export function isBriefText(text: string): boolean {
    return /^\s*(?:[([]?\s*(?:part\s*)?\d+\s*\/\s*\d+\s*[)\]]?\s*[:.-]?\s*)?TOLI_BRIEF\b/i.test(text);
}

/**
 * Whether `text` asks for the user's word. A `peer` message (not a delegated task's held question, which asks by
 * being held) asks only in a paragraph that is a question (has a `?`), so a Sardar relaying his rules ("merges still
 * need his word") is not a request; toli's hold format and `Reply <option>` ask in themselves, unless every option the
 * hold gives is a template placeholder (a quoted template, quotesTemplateOnly). A jawan brief sent as a peer message
 * asks nothing: it is work to run. A mention that cites his word as authority never asks.
 */
export function asksForWord(text: string, peer: boolean): boolean {
    if (peer && isBriefText(text)) return false;
    if (REPLY_OPTION.test(text)) return true;
    if (peer && !quotesTemplateOnly(text) && HOLD_FORMAT.some((pattern) => pattern.test(text))) return true;
    const phrases = wordPhrases();
    return text
        .split(/\n\s*\n/)
        .some(
            (paragraph) =>
                (!peer || paragraph.includes("?")) &&
                phrases.some(({ pattern, cites }) =>
                    [...paragraph.matchAll(pattern)].some(
                        (match) =>
                            cites === undefined ||
                            !cites(paragraph.slice(0, match.index), paragraph.slice(match.index + match[0].length)),
                    ),
                ),
        );
}

/** A sender's question compared without case, spacing or a trailing reminder. */
export function questionKey(from: string, question: string): string {
    return `${from}\n${collapse(question).toLowerCase().slice(0, 400)}`;
}

/** The words of a stored inbox item or a `talk` body: without the inbox header and talk's own footer lines. */
export function messageWords(body: string): string {
    return body
        .split("\n")
        .filter((line) => !/^#\s|^- (?:from|via|received|reply): /.test(line))
        .join("\n")
        .trim();
}

function loadRegistry(): Registry {
    const raw = readJson<Partial<Registry>>(paths.wordHolds(), {});
    return { ...(raw.since === undefined ? {} : { since: raw.since }), holds: raw.holds ?? {}, read: raw.read ?? {} };
}

/** Drop held questions past HELD_KEEP_MS and read marks past the scan window. */
function prune(registry: Registry): void {
    const at = now().getTime();
    for (const [key, held] of Object.entries(registry.holds))
        if (at - Date.parse(held.at) > HELD_KEEP_MS) delete registry.holds[key];
    for (const [file, read] of Object.entries(registry.read))
        if (at - Date.parse(read) > 2 * SCAN_MS) delete registry.read[file];
}

/**
 * Hold `from`'s question once: `hold` runs (and names the task it held) only when this sender's question was never
 * held here; null when it was (a reminder, or one already answered).
 */
export function holdOnce(from: string, question: string, source: string, hold: () => Task): Task | null {
    return withLock(paths.lock("word-holds"), () => {
        const registry = loadRegistry();
        const key = questionKey(from, question);
        if (registry.holds[key] !== undefined) return null;
        const task = hold();
        prune(registry);
        registry.holds[key] = { task: task.id, at: now().toISOString(), source };
        writeJsonAtomic(paths.wordHolds(), registry);
        return task;
    });
}

/**
 * The project a message from `from` belongs to: the first one it names (a name of at least NAMED_MIN characters, so
 * a short one like `pls` is never read out of plain words), else the newest task here linked to that machine, else
 * the only project here.
 */
export function senderProject(from: string, text: string, tasks: Task[]): string | null {
    const names = loadProjects().map((project) => project.name);
    let named: { name: string; at: number } | null = null;
    for (const name of names) {
        if (name.length < NAMED_MIN) continue;
        const at = text.search(new RegExp(`(?<![\\w-])${escapeRegex(name)}(?![\\w-])`, "i"));
        if (at !== -1 && (named === null || at < named.at)) named = { name, at };
    }
    if (named !== null) return named.name;
    const linked = tasks
        .filter(
            (task) =>
                task.delegatedBy?.machine === from ||
                (task.delegatedTo ?? []).some((fid) => fid.startsWith(`${from}/`)) ||
                (task.slices ?? []).some((fid) => fid.startsWith(`${from}/`)),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const project = linked.find((task) => names.includes(task.project))?.project;
    if (project !== undefined) return project;
    return names.length === 1 ? (names[0] ?? null) : null;
}

/** A new task here, held with `word`, in `project`. `heldFrom` makes its answer go to that delegated task too. */
export function heldTask(project: string, title: string, word: WordQuestion, note: string, heldFrom?: string): Task {
    return updateBacklog((backlog) => {
        const at = now().toISOString();
        const task: Task = {
            id: `T${backlog.nextId}`,
            project,
            title,
            shape: "ship",
            status: "held",
            notes: [note],
            question: word.question,
            ...(word.options.length > 0 ? { options: word.options } : {}),
            ...(word.recommend === undefined ? {} : { recommend: word.recommend }),
            ...(word.blocks === undefined ? {} : { blocks: word.blocks }),
            heldAt: at,
            ...(heldFrom === undefined ? {} : { heldFrom }),
            createdAt: at,
            updatedAt: at,
        };
        backlog.nextId += 1;
        backlog.tasks.push(task);
        return { ...task };
    });
}

/**
 * A peer message from `from` (its words as sent, `source` its inbox file): when it asks for the user's word, hold it
 * as a new task in the sender's project. Returns what happened, or null when it asks nothing of the user.
 */
export function holdPeerMessage(from: string, body: string, source: string): string | null {
    const words = messageWords(body);
    if (words === "" || !asksForWord(words, true)) return null;
    const word = parseWordQuestion(words);
    if (word.question === "") return null;
    const project = senderProject(from, words, loadBacklog().tasks);
    if (project === null)
        return `${from} asks for the user's word, but no project here matches it: answer from the inbox (${source})`;
    const title = `${from} asks for the user's word: ${word.question.slice(0, 80)}`;
    const note = `held from ${from}'s message ${source}; answer it here, then reply: bin/toli talk ${from} "<answer>"`;
    const task = holdOnce(from, word.question, source, () => heldTask(project, title, word, note));
    return task === null
        ? `${from}'s question is already held (a reminder, or answered)`
        : `${task.id} held: ${from} asks for the user's word (bin/toli needs)`;
}

/** Record a `talk` this machine sent, so the tick knows a message it quotes is answered. */
export function noteTalkSent(to: string, words: string): void {
    const file = paths.talkSent();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ to, at: now().toISOString(), words })}\n`);
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length > TALK_KEEP) writeFileSync(file, `${lines.slice(-TALK_KEEP).join("\n")}\n`);
}

type SentTalk = { to: string; at: string; words: string };

function sentTalks(): SentTalk[] {
    if (!existsSync(paths.talkSent())) return [];
    return readFileSync(paths.talkSent(), "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
            try {
                return [JSON.parse(line) as SentTalk];
            } catch {
                return [];
            }
        });
}

/** Whether a `talk` to `from` sent after `receivedAt` quotes `question`. */
export function answeredByTalk(from: string, receivedAt: string, question: string, talks: SentTalk[]): boolean {
    const quote = collapse(question).toLowerCase().slice(0, QUOTE_CHARS);
    return talks.some(
        (talk) => talk.to === from && talk.at > receivedAt && collapse(talk.words).toLowerCase().includes(quote),
    );
}

/**
 * The tick's look over the inbox: every message another machine's lead sent with `talk` (`message from <machine>`)
 * that arrived since this toli first looked (`since`, at most SCAN_MS ago), is not acknowledged yet, was not read
 * before, asks for the user's word and was not answered with a quoting `talk` reply is held (holdPeerMessage). What
 * was in the inbox at the first look (an upgrade) was the lead's to handle already, so it is never backfilled. Other
 * items (a delegated task's report, a delegation's brief) are not messages to read that way: `delegation update`
 * holds a delegated question on arrival. Returns one line per hold.
 */
export function holdInboxWords(): string[] {
    const self = loadMachine().name;
    const started = loadRegistry().since;
    if (started === undefined) {
        withLock(paths.lock("word-holds"), () => {
            const registry = loadRegistry();
            registry.since ??= now().toISOString();
            writeJsonAtomic(paths.wordHolds(), registry);
        });
        return [];
    }
    const since = Math.max(Date.parse(started), now().getTime() - SCAN_MS);
    const fresh = listInbox().filter(
        (item) =>
            item.unseen &&
            item.from !== self &&
            item.title === `message from ${item.from}` &&
            Date.parse(stampTime(item.stamp)) >= since,
    );
    if (fresh.length === 0) return [];
    const read = loadRegistry().read;
    const talks = sentTalks();
    const lines: string[] = [];
    const marked: string[] = [];
    for (const item of fresh) {
        if (read[item.file] !== undefined) continue;
        marked.push(item.file);
        const body = readFileSync(item.path, "utf8");
        const words = messageWords(body);
        const received = /^- received: (\S+)$/m.exec(body)?.[1] ?? stampTime(item.stamp);
        if (!asksForWord(words, true)) continue;
        if (answeredByTalk(item.from, received, parseWordQuestion(words).question, talks)) continue;
        const held = holdPeerMessage(item.from, body, item.path);
        if (held !== null) lines.push(held);
    }
    withLock(paths.lock("word-holds"), () => {
        const registry = loadRegistry();
        for (const file of marked) registry.read[file] = now().toISOString();
        prune(registry);
        writeJsonAtomic(paths.wordHolds(), registry);
    });
    return lines;
}

/** An inbox stamp (`2026-11-18T17-40-28-840Z`) as an ISO time. */
function stampTime(stamp: string): string {
    return stamp.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, "T$1:$2:$3.$4Z");
}
