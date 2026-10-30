import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PERSONA, persona, personaLine } from "../src/persona.ts";

const saved = process.env.TOLI_ROOT;

function rootWith(config: unknown): void {
    const root = mkdtempSync(join(tmpdir(), "toli-persona-"));
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

    test("unknown keys and empty values are errors", () => {
        rootWith({ title: "Boss" });
        expect(() => persona()).toThrow('unknown key "title"');
        rootWith({ user: " " });
        expect(() => persona()).toThrow('"user" must be a non-empty string');
        rootWith(["Boss"]);
        expect(() => persona()).toThrow("must be a JSON object");
    });
});
