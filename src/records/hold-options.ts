// A held question's options (`task hold --option`) and the words that keep a hold from ever being auto-applied.
import { ToliError } from "../core/util.ts";

/** One answer a held task offers the user, and what the lead does if it is chosen. */
export type HoldOption = { choice: string; outcome: string };

/** How many options a held question offers when it offers any. */
export const HOLD_OPTIONS_MIN = 2;
export const HOLD_OPTIONS_MAX = 4;

/** Parse one `--option "<choice> => <what happens then>"`. */
export function parseOption(value: string): HoldOption {
    const at = value.indexOf("=>");
    const choice = at === -1 ? "" : value.slice(0, at).trim();
    const outcome = at === -1 ? "" : value.slice(at + 2).trim();
    if (choice === "" || outcome === "")
        throw new ToliError(`--option must be "<choice> => <what happens then>", got "${value}"`);
    return { choice, outcome };
}

/** The option a reply or recommendation names: its 1-based number or its exact choice text (any case). */
export function matchOption(options: HoldOption[], value: string): HoldOption | undefined {
    const text = value.trim();
    if (/^\d+$/.test(text)) return options[Number(text) - 1];
    return options.find((option) => option.choice.toLowerCase() === text.toLowerCase());
}

/**
 * Words that make a hold never auto-applied, whatever the caller says: push, merge, main, MR/PR, tag, release,
 * destructive or irreversible steps, security, money. Returns the first word found, else undefined.
 */
const IRREVERSIBLE_WORDS =
    /\b(push(?:es|ed|ing)?|merg(?:e|es|ed|ing)|main|master|MRs?|PRs?|merge requests?|pull requests?|tags?|releases?|deploy(?:s|ed|ing|ment)?|delet(?:e|es|ed|ing)|drop(?:s|ped|ping)?|destroy(?:s|ed|ing)?|destructive|irreversible|force|wipe|reset|rm|security|secrets?|credentials?|passwords?|tokens?|permissions?|auth|money|payments?|billing|cost|price|pricing)\b/i;

export function irreversibleTopic(texts: (string | undefined)[]): string | undefined {
    for (const text of texts) {
        const match = text === undefined ? null : IRREVERSIBLE_WORDS.exec(text);
        if (match) return match[0];
    }
    return undefined;
}
