import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PERSONA, persona, personaLine } from "../src/core/persona.ts";
import { tempDir } from "./helpers.ts";

const saved = process.env.TOLI_ROOT;

function rootWith(config: unknown): void {
    const root = tempDir("persona");
    process.env.TOLI_ROOT = root;
    if (config === undefined) return;
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config", "persona.json"), JSON.stringify(config));
}

afterEach(() => {
    if (saved === undefined) delete process.env.TOLI_ROOT;
    else process.env.TOLI_ROOT = saved;
});

describe("persona", () => {
    test("defaults without config/persona.json", () => {
        rootWith(undefined);
        expect(persona()).toEqual({
            user: "Malik",
            userAliases: [],
            lead: "Sardar",
            leadPlural: "Saradars",
            worker: "jawan",
            workerPlural: "jawans",
        });
        expect(personaLine()).toBe(
            'Names: the user is "Malik", the lead is Sardar (plural Saradars), workers are jawans (one jawan).',
        );
    });

    test("configured fields override, the rest keep their defaults", () => {
        rootWith({ user: "Boss", worker: "crew member", workerPlural: "crew" });
        expect(persona()).toEqual({ ...DEFAULT_PERSONA, user: "Boss", worker: "crew member", workerPlural: "crew" });
        expect(personaLine()).toContain('the user is "Boss"');
    });

    test("userAliases lists the user's other names", () => {
        rootWith({ userAliases: [" Sam Lee ", "Sam"] });
        expect(persona().userAliases).toEqual(["Sam Lee", "Sam"]);
        rootWith({ userAliases: "Sam" });
        expect(() => persona()).toThrow('"userAliases" must be a list of non-empty strings');
        rootWith({ userAliases: [""] });
        expect(() => persona()).toThrow('"userAliases" must be a list of non-empty strings');
    });

    test("unknown keys and empty values are errors", () => {
        rootWith({ title: "Boss" });
        expect(() => persona()).toThrow('unknown key "title"');
        rootWith({ user: " " });
        expect(() => persona()).toThrow('"user" must be a non-empty string');
        rootWith(["Boss"]);
        expect(() => persona()).toThrow("must be a JSON object");
    });
});
