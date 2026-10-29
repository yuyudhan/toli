import { describe, expect, test } from "bun:test";
import { Args, parseArgs } from "../src/args.ts";
import { MateError } from "../src/util.ts";

describe("parseArgs", () => {
    test("value flags take the next word or an inline value; booleans never consume a word", () => {
        const parsed = parseArgs(["a", "--mode", "pr", "--json", "b", "--title=x=y", "-m", "msg"], ["json"]);
        expect(parsed.positional).toEqual(["a", "b"]);
        expect(Object.fromEntries(parsed.flags)).toEqual({ mode: "pr", json: true, title: "x=y", message: "msg" });
    });

    test("everything after a bare -- is rest, even flag-shaped words", () => {
        const parsed = parseArgs(["p", "--", "--not-a-flag", "-m"]);
        expect(parsed.positional).toEqual(["p"]);
        expect(parsed.rest).toEqual(["--not-a-flag", "-m"]);
    });

    test("an empty inline value is kept as an empty string, not treated as missing", () => {
        expect(parseArgs(["--note="]).flags.get("note")).toBe("");
    });

    test("errors: value flag at the end, boolean given a value, unknown short flag", () => {
        expect(() => parseArgs(["--mode"])).toThrow("--mode needs a value");
        expect(() => parseArgs(["--json=yes"], ["json"])).toThrow("--json takes no value");
        expect(() => parseArgs(["-x"])).toThrow("unknown option -x");
    });
});

describe("Args", () => {
    test("unknown long options are rejected", () => {
        expect(() => new Args(["--sahpe", "ship"], { values: ["shape"] })).toThrow(MateError);
        expect(() => new Args(["--sahpe", "ship"], { values: ["shape"] })).toThrow("unknown option --sahpe");
    });

    test("pos treats a missing or empty positional as missing", () => {
        const args = new Args(["", "b"]);
        expect(() => args.pos(0, "project")).toThrow("missing <project>");
        expect(args.pos(1, "title")).toBe("b");
        expect(() => args.pos(2, "extra")).toThrow("missing <extra>");
    });

    test("maxPositional names the first surplus argument", () => {
        expect(() => new Args(["a", "b", "c"]).maxPositional(1)).toThrow('unexpected argument "b"');
        expect(() => new Args(["a"]).maxPositional(1)).not.toThrow();
    });

    test("str ignores booleans and bool ignores values", () => {
        const args = new Args(["--json", "--status", "held"], { booleans: ["json"], values: ["status"] });
        expect(args.str("json")).toBeUndefined();
        expect(args.bool("status")).toBe(false);
        expect(args.has("status")).toBe(true);
        expect(args.str("status")).toBe("held");
    });
});
