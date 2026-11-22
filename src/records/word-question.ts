// The question another machine's message asks for the user's word (src/records/word-holds.ts), parsed from its words:
// its `## Question` section or the words themselves, with the options, recommendation and what it blocks when the
// message names them. A template placeholder (`<choice> => <what happens then>`) is never an option.
import { HOLD_OPTIONS_MAX, HOLD_OPTIONS_MIN, type HoldOption, isPlaceholder } from "./hold-options.ts";

/** A question for the user's word, as parsed from a message. */
export type WordQuestion = { question: string; options: HoldOption[]; recommend?: string; blocks?: string };

/** A held question longer than this is cut, with the whole message in the task's notes. */
const QUESTION_MAX = 600;

export const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** 2 to 4 options, or none. */
function clampOptions(options: HoldOption[]): HoldOption[] {
    return options.length < HOLD_OPTIONS_MIN ? [] : options.slice(0, HOLD_OPTIONS_MAX);
}

/** An option written as free text: its choice is the text up to the first comma, colon or bracket. */
function freeOption(text: string): HoldOption | null {
    const outcome = collapse(text).replace(/[;.,]+$/, "");
    const choice = outcome.split(/[,:(]/, 1)[0]?.trim().slice(0, 80) ?? "";
    return choice === "" ? null : { choice, outcome };
}

/** `--option "a => b"` flags, and `N. a => b` (or `- a => b`) lines: the options a message writes as pairs. */
const FLAGGED = /--option\s+["']([^"'\n]+?)\s*=>\s*([^"'\n]+)["']/g;
const LISTED = /^\s*(?:\d+[.)]|-)\s*(.+?)\s*=>\s*(.+)$/gm;

/** The `choice => outcome` pairs `pattern` finds in `text`, placeholders included. */
function writtenPairs(text: string, pattern: RegExp): HoldOption[] {
    return [...text.matchAll(pattern)].flatMap((match) => {
        const choice = collapse(match[1] ?? "");
        const outcome = collapse(match[2] ?? "");
        return choice === "" || outcome === "" ? [] : [{ choice, outcome }];
    });
}

const placeholderOption = (option: HoldOption): boolean =>
    isPlaceholder(option.choice) || isPlaceholder(option.outcome);

/** A message's `## Question` section, when it has one. */
const questionSection = (words: string): string | undefined =>
    /^##\s*Question\s*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(words)?.[1];

/** The first paragraph of a `## Question` section: the question it asks. */
const sectionQuestion = (section: string): string => section.split(/\n\s*\n/).find((part) => part.trim() !== "") ?? "";

/**
 * Whether `text` only quotes the hold template (`task hold <T-id> --question "<plain words>" --option "<choice> =>
 * <what happens then>"`, instructions quoted from a brief): it offers no real option of any kind, and every question
 * it writes in toli's hold format (`## Question`, `--question "..."`) is itself a placeholder. Anything else asks.
 */
export function quotesTemplateOnly(text: string): boolean {
    const section = questionSection(text);
    const questions = [
        ...(section === undefined ? [] : [collapse(sectionQuestion(section))]),
        ...[...text.matchAll(/--question\s+["']([^"'\n]*)["']/g)].map((match) => collapse(match[1] ?? "")),
    ];
    return questions.length > 0 && questions.every(isPlaceholder) && parseOptions(text).length === 0;
}

/**
 * The options a message offers: `--option "a => b"`, `N. a => b` lines, `(1) ... (2) ...`, `Reply X to Y`, yes/no.
 * A template placeholder (`<choice> => <what happens then>`) is no option, and listed options are read with the
 * `--option` flags taken out, so a wrapped `--option` line is never read as a `- a => b` item.
 */
function parseOptions(text: string): HoldOption[] {
    const pairs = (pattern: RegExp, from = text): HoldOption[] =>
        writtenPairs(from, pattern).filter((option) => !placeholderOption(option));
    const flagged = pairs(FLAGGED);
    if (flagged.length > 0) return clampOptions(flagged);
    const listed = pairs(LISTED, text.replace(FLAGGED, ""));
    if (listed.length > 0) return clampOptions(listed);
    const numbered = [...text.matchAll(/\((\d)\)\s*([\s\S]+?)(?=\s*\(\d\)|\n\n|$)/g)].flatMap((match) => {
        const option = freeOption(match[2] ?? "");
        return option === null ? [] : [option];
    });
    if (numbered.length > 0) return clampOptions(numbered);
    const replies = pairs(/Reply\s+[`"']?([^`"'\n]+?)[`"']?\s+(?:to|=>|for)\s+([^;.\n]+)/g);
    if (replies.length > 0) return clampOptions(replies);
    if (/\byes\s*\/\s*no\b/i.test(text))
        return [
            { choice: "yes", outcome: "go ahead as asked" },
            { choice: "no", outcome: "leave it as it is" },
        ];
    return [];
}

/** The option the sender recommends: `Recommended: x`, or the one it marks as its pick. */
function parseRecommend(text: string, options: HoldOption[]): string | undefined {
    const line = /^\s*Recommended:\s*(.+)$/m.exec(text)?.[1]?.trim();
    if (line !== undefined && line !== "") return line;
    return options.find((option) => /\b(?:my pick|recommend(?:ed)?)\b/i.test(option.outcome))?.choice;
}

/** What waits on the answer: `Blocks: x`, `(blocks x)` or `blocking x`. */
function parseBlocks(text: string): string | undefined {
    const found =
        /^\s*Blocks:\s*(.+)$/m.exec(text)?.[1] ??
        /\(blocks\s+([^)]+)\)/i.exec(text)?.[1] ??
        /\bblocking\s+([^.;()]+)/i.exec(text)?.[1];
    return found === undefined ? undefined : collapse(found);
}

/**
 * The question in a message's words: its `## Question` section when it has one, else the words themselves (cut at
 * QUESTION_MAX), with the options, recommendation and what it blocks when the message names them.
 */
export function parseWordQuestion(words: string): WordQuestion {
    const section = questionSection(words);
    const text = section ?? words;
    // A quoted template (`task hold <T-id> ...` and its wrapped `--option` lines) is no part of the question.
    const prose = (section === undefined ? words : sectionQuestion(section)).replace(
        /(?:bin\/toli\s+)?task\s+hold\s+<[^<>\n]+>[^\n]*(?:\n\s*--[^\n]*)*/g,
        "",
    );
    const full = collapse(prose.replace(/^\s*(?:\d+[.)]\s*.+=>.+|Recommended:.+|Blocks:.+)$/gm, ""));
    const question = full.length > QUESTION_MAX ? `${full.slice(0, QUESTION_MAX - 1)}…` : full;
    const options = parseOptions(text);
    const recommend = parseRecommend(text, options);
    const blocks = parseBlocks(text);
    return {
        question,
        options,
        ...(recommend === undefined ? {} : { recommend }),
        ...(blocks === undefined ? {} : { blocks }),
    };
}
