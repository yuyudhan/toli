import { paths } from "./paths.ts";
import { isJsonObject, readJson, ToliError } from "./util.ts";

/**
 * The names toli uses in prompts and messages: what the lead calls the user, the lead agent itself, and the
 * worker agents it dispatches. Read from the optional config/persona.json; any field left out keeps its default.
 */
export type Persona = {
    /** How the lead addresses the user, e.g. "Malik". */
    user: string;
    /** The lead agent (the one session the user talks to). */
    lead: string;
    leadPlural: string;
    /** A worker agent the lead dispatches. */
    worker: string;
    workerPlural: string;
};

export const DEFAULT_PERSONA: Persona = {
    user: "Malik",
    lead: "Sardar",
    leadPlural: "Saradars",
    worker: "jawan",
    workerPlural: "jawans",
};

const FIELDS = Object.keys(DEFAULT_PERSONA) as (keyof Persona)[];

/** The configured persona; config/persona.json is optional and every field defaults. */
export function persona(): Persona {
    const raw = readJson<unknown>(paths.persona(), {});
    if (!isJsonObject(raw)) throw new ToliError(`${paths.persona()} must be a JSON object`);
    const result: Persona = { ...DEFAULT_PERSONA };
    for (const [key, value] of Object.entries(raw)) {
        if (!FIELDS.includes(key as keyof Persona))
            throw new ToliError(`${paths.persona()}: unknown key "${key}" (allowed: ${FIELDS.join(", ")})`);
        if (typeof value !== "string" || value.trim() === "")
            throw new ToliError(`${paths.persona()}: "${key}" must be a non-empty string`);
        result[key as keyof Persona] = value.trim();
    }
    return result;
}

/** One line telling an agent which names this installation uses (for the digest header and session reminders). */
export function personaLine(names: Persona = persona()): string {
    return `Names: the user is "${names.user}", the lead is ${names.lead} (plural ${names.leadPlural}), workers are ${names.workerPlural} (one ${names.worker}).`;
}
