import { describe, expect, test } from "bun:test";
import guard from "../scripts/guard/internal-names.ts";
import { internalNameHits, internalNamesIn, nameHash } from "../scripts/internal-names.ts";
import { DEFAULT_PERSONA } from "../src/core/persona.ts";

// The real denylist is hashed so tests never spell it out; these use their own list, plus the one name that is
// public anyway: the default persona user name.
const LIST = new Set(["acme", "corp.int", "box-a", "10.20"]);
const listed = (candidate: string) => LIST.has(candidate);

describe("internal names", () => {
    test("finds words, words with a number, hyphenated, dotted and address-prefix pairs, in any case", () => {
        expect(internalNamesIn("Built on ACME's server", listed)).toEqual(["acme"]);
        expect(internalNamesIn("the acme3 box and ACME-12", listed)).toEqual(["acme3", "acme"]);
        expect(internalNamesIn("peer box-a-7 at git@gitlab.corp.int:team/app", listed)).toEqual(["box-a", "corp.int"]);
        expect(internalNamesIn("addrs 10.20.1.7:47123 and 10.200.1.1", listed)).toEqual(["10.20"]);
        expect(internalNamesIn("acmes, box_b, corp-int, 110.20.0.1", listed)).toEqual([]);
    });

    test("the real list holds the default persona name and reports each line", () => {
        const name = DEFAULT_PERSONA.user;
        expect(internalNameHits(`fine\nask ${name} first\n`)).toEqual([{ line: 2, names: [name.toLowerCase()] }]);
        expect(internalNameHits("toli, Sardar and jawans are the brand\n")).toEqual([]);
        expect(nameHash(name)).toBe(nameHash(name.toUpperCase()));
    });

    test("the guard flags tracked text, honours the allowlist, and flags a stale allowlist entry", () => {
        const name = DEFAULT_PERSONA.user;
        const flagged = guard.run([{ path: "docs/x.md", text: `Reply to ${name}.\n` }]);
        expect(flagged).toEqual([{ path: "docs/x.md", line: 1, message: `internal name: ${name.toLowerCase()}` }]);
        const allowed = guard.run([{ path: "src/core/persona.ts", text: `    user: "${name}",\n` }]);
        expect(allowed).toEqual([]);
        const mixed = guard.run([{ path: "src/core/persona.ts", text: `    user: "${name}", // ${name}\n` }]);
        expect(mixed.map((violation) => violation.line)).toEqual([1]);
        const stale = guard.run([{ path: "src/core/persona.ts", text: "export {};\n" }]);
        expect(stale).toEqual([
            {
                path: "scripts/internal-names-allow.txt",
                message: `"user: "${name}"" no longer appears in src/core/persona.ts; delete it`,
            },
        ]);
    });
});
