import { paths } from "./paths.ts";
import { isJsonObject, readJson, ToliError, writeJsonAtomic } from "./util.ts";

/**
 * The names toli uses in prompts and messages: what the lead calls the user, the lead agent itself, and the
 * worker agents it dispatches. Read from the optional config/persona.json; any field left out keeps its default.
 */
export type Persona = {
    /** How the lead addresses the user: a title (the default is below), after their first name when one is set. */
    user: string;
    /**
     * The user's first name ("" for none, a machine nobody sits at): the lead addresses them as "<first name> <user>",
     * the name counts as one of theirs for `[needs you]`, and paired peers learn it (src/peer/store.ts `person`).
     */
    userFirstName: string;
    /**
     * Other names the user goes by (a real name, a nickname): messages addressed to any of them are for the user,
     * so the wake marks them `[needs you]` (src/records/wake-compact.ts). None by default.
     */
    userAliases: string[];
    /** The lead agent (the one session the user talks to). */
    lead: string;
    leadPlural: string;
    /** A worker agent the lead dispatches. */
    worker: string;
    workerPlural: string;
};

export const DEFAULT_PERSONA: Persona = {
    user: "Malik",
    userFirstName: "",
    userAliases: [],
    lead: "Sardar",
    leadPlural: "Saradars",
    worker: "jawan",
    workerPlural: "jawans",
};

type NameField = Exclude<keyof Persona, "userAliases" | "userFirstName">;

const FIELDS = Object.keys(DEFAULT_PERSONA) as (keyof Persona)[];

/** The longest first name kept, ours or a peer's. */
const MAX_PERSON_NAME = 40;

/** A letter, then letters (with their combining marks), single spaces, hyphens and apostrophes. */
const PERSON_NAME = /^\p{L}[\p{L}\p{M} '’-]*$/u;

const FIRST_NAME_RULE = `"userFirstName" must be a first name: letters, spaces, hyphens and apostrophes, at most ${MAX_PERSON_NAME} characters ("" for none)`;

/**
 * `raw` as a person's name, runs of spaces folded, or undefined when it is anything else (another line, markup,
 * digits, too long). Names from peers pass through here: they are shown and matched, never followed.
 */
export function personName(raw: unknown): string | undefined {
    if (typeof raw !== "string") return undefined;
    const name = raw.trim().replace(/ +/g, " ");
    return name.length <= MAX_PERSON_NAME && PERSON_NAME.test(name) ? name : undefined;
}

/** The configured persona; config/persona.json is optional and every field defaults. */
export function persona(): Persona {
    const raw = readJson<unknown>(paths.persona(), {});
    if (!isJsonObject(raw)) throw new ToliError(`${paths.persona()} must be a JSON object`);
    const result: Persona = { ...DEFAULT_PERSONA };
    for (const [key, value] of Object.entries(raw)) {
        if (!FIELDS.includes(key as keyof Persona))
            throw new ToliError(`${paths.persona()}: unknown key "${key}" (allowed: ${FIELDS.join(", ")})`);
        if (key === "userAliases") {
            if (!Array.isArray(value) || value.some((alias) => typeof alias !== "string" || alias.trim() === ""))
                throw new ToliError(`${paths.persona()}: "userAliases" must be a list of non-empty strings`);
            result.userAliases = value.map((alias: string) => alias.trim());
            continue;
        }
        if (key === "userFirstName") {
            const name = typeof value === "string" && value.trim() === "" ? "" : personName(value);
            if (name === undefined) throw new ToliError(`${paths.persona()}: ${FIRST_NAME_RULE}`);
            result.userFirstName = name;
            continue;
        }
        if (typeof value !== "string" || value.trim() === "")
            throw new ToliError(`${paths.persona()}: "${key}" must be a non-empty string`);
        result[key as NameField] = value.trim();
    }
    return result;
}

/** What the lead calls the user: "<first name> <user>" ("Robin Boss"), or the plain title without a first name. */
export function addressName(names: Persona = persona()): string {
    return names.userFirstName === "" ? names.user : `${names.userFirstName} ${names.user}`;
}

/** Every name the user goes by, the full address first: an ask for any of them needs the user. */
export function userNames(names: Persona = persona()): string[] {
    return [...new Set([addressName(names), names.user, names.userFirstName, ...names.userAliases])].filter(
        (name) => name !== "",
    );
}

/**
 * Record the user's first name (`bin/toli setup first-name`), or "" for none, keeping every other key in
 * config/persona.json. A name that is not one is refused before anything is written.
 */
export function setFirstName(name: string): Persona {
    const clean = name === "" ? "" : personName(name);
    if (clean === undefined) throw new ToliError(FIRST_NAME_RULE);
    persona(); // an invalid file is refused as it is, not rewritten
    const raw = readJson<Record<string, unknown>>(paths.persona(), {});
    writeJsonAtomic(paths.persona(), { ...raw, userFirstName: clean });
    return persona();
}

/** One line telling an agent which names this installation uses (for the digest header and session reminders). */
export function personaLine(names: Persona = persona()): string {
    const user =
        names.userFirstName === ""
            ? `"${names.user}"`
            : `"${addressName(names)}" (first name ${names.userFirstName}, title ${names.user})`;
    return `Names: the user is ${user}, the lead is ${names.lead} (plural ${names.leadPlural}), workers are ${names.workerPlural} (one ${names.worker}).`;
}
