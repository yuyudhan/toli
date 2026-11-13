import { describe, expect, test } from "bun:test";
import { sandbox } from "./helpers.ts";

describe("--help and -h", () => {
    const box = sandbox();

    /** Help must succeed, print usage on stdout and say nothing on stderr. */
    const help = (args: string[]): string => {
        const result = box.toli(args);
        expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
        return result.stdout;
    };

    test("upgrade --help prints upgrade's usage instead of running it", () => {
        const output = help(["upgrade", "--help"]);
        expect(output).toContain("upgrade [vX.Y.Z|--latest] [--check]");
        expect(output).not.toContain("task add");
    });

    test("task add --help and -h print only task add's usage; nothing is added", () => {
        for (const flag of ["--help", "-h"]) {
            const output = help(["task", "add", flag]);
            expect(output).toContain('task add <project> "<title>"');
            expect(output).not.toContain("task list");
        }
        expect(help(["task", "add", "p", "title", "--note", "--help"])).toContain("task add");
        expect(help(["task", "list", "--json"])).toBe("[]\n");
    });

    test("a subcommand listed after a | finds its line; an unknown subcommand shows the whole command", () => {
        expect(help(["task", "done", "--help"])).toContain("done <id> [--report <path>]");
        const task = help(["task", "nope", "--help"]);
        expect(task).toContain("task add");
        expect(task).toContain("task list");
    });

    test("top-level commands: doctor, project, run; one USAGE does not list gets all of it", () => {
        expect(help(["doctor", "--help"]).trim()).toBe("usage: bin/toli doctor [--json]");
        const project = help(["project", "-h"]);
        expect(project).toContain("project add <name>");
        expect(project).toContain("[--live-stack yes|no]");
        expect(project).not.toContain("task add");
        expect(help(["run", "--help"])).toContain("run status <id>");
        expect(help(["remote", "--help"])).toContain("usage: bin/toli <command> [args]");
        expect(help(["--help"])).toContain("usage: bin/toli <command> [args]");
        expect(help(["help"])).toContain("upgrade [vX.Y.Z|--latest] [--check]");
    });

    test("--help after a bare -- is an argument, and an unknown command stays unknown", () => {
        const refused = box.toli(["remote", "--", "--help"]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("toli: remote:");
        const unknown = box.toli(["bogus", "--help"]);
        expect(unknown.code).toBe(2);
        expect(unknown.stderr).toContain('toli: unknown command "bogus"');
    });
});
