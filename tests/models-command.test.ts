import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDefinition, agentItems } from "../src/harness/agents.ts";
import { catalogSelectors } from "../src/harness/model-catalog.ts";
import { type Sandbox, SSH_STUB_ARGS, sandbox } from "./helpers.ts";

/** An omp stub whose `models --json` lists `selectors`, as omp prints its catalog. */
function stubOmpModels(box: Sandbox, selectors: string[]): void {
    const models = selectors.map((selector) => ({ provider: selector.split("/")[0], selector }));
    box.stub("omp", `if [ "$1" = models ]; then echo '${JSON.stringify({ models })}'; exit 0; fi\necho "omp $*"`);
}

function machine(): Sandbox {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    return box;
}

function harnessOf(box: Sandbox): unknown {
    return JSON.parse(readFileSync(join(box.root, "config", "machine.json"), "utf8")).harness;
}

const agentFile = (box: Sandbox, kind: string): string =>
    readFileSync(join(box.root, ".omp", "agents", `toli-${kind}.md`), "utf8");

describe("omp subagents per kind of work", () => {
    test("each kind gets an agent naming its model list in order; an empty list leaves omp's default", () => {
        const qa = agentDefinition("qa", ["google/gemini-3-flash", "anthropic/claude-sonnet-4-6"]);
        expect(qa).toStartWith("---\n");
        expect(qa).toContain("name: toli-qa\n");
        expect(qa).toContain('model:\n    - "google/gemini-3-flash"\n    - "anthropic/claude-sonnet-4-6"\n---');
        expect(qa).toContain('spawns: "*"');
        expect(qa).toContain("You are a toli jawan doing qa work: testing");
        expect(agentDefinition("ship", [])).not.toContain("model:");
        const paths = agentItems({}).map((item) => item.path);
        expect(paths).toContain(".omp/agents/toli-qa.md");
        expect(paths).toContain(".omp/agents/toli-mechanical.md");
        expect(agentItems({}).find((item) => item.path.endsWith("toli-qa.md"))).toMatchObject({
            content: expect.stringContaining('    - "anthropic/claude-sonnet-5-5"\n    - "anthropic/claude-sonnet-5"'),
        });
    });

    test("harness sync writes them; --check reports a stale one", () => {
        const box = machine();
        box.ok(["harness", "sync"]);
        expect(agentFile(box, "mechanical")).toContain('    - "anthropic/claude-haiku-5-5"');
        writeFileSync(join(box.root, ".omp", "agents", "toli-qa.md"), "edited\n");
        const check = box.toli(["harness", "sync", "--check"]);
        expect(check.code).toBe(1);
        expect(check.stdout).toContain("differs .omp/agents/toli-qa.md");
    });
});

describe("bin/toli models", () => {
    test("set takes any provider's ids as an ordered list, rewrites the agent, and unset goes back", () => {
        const box = machine();
        stubOmpModels(box, ["openai/gpt-5-mini"]);
        const set = box.ok(["models", "set", "qa", "google/gemini-3-flash,openai/gpt-5-mini"]);
        expect(set).toContain(
            "qa         google/gemini-3-flash, openai/gpt-5-mini -> runs openai/gpt-5-mini (machine)",
        );
        expect(set).toContain("subagent toli-qa");
        expect(harnessOf(box)).toEqual({ workModels: { omp: { qa: ["google/gemini-3-flash", "openai/gpt-5-mini"] } } });
        expect(agentFile(box, "qa")).toContain('    - "google/gemini-3-flash"\n    - "openai/gpt-5-mini"');
        // The catalog lacks google: spawn takes the next model of the list.
        expect(box.ok(["spawn", "--dry-run", "--work", "qa", "--cwd", box.root])).toContain(
            "omp openai/gpt-5-mini (standard, work), work qa (omp subagent: toli-qa)",
        );
        box.ok(["models", "set", "light", "local/small"]);
        box.ok(["models", "set", "ship", "none"]);
        expect(harnessOf(box)).toEqual({
            workModels: { omp: { qa: ["google/gemini-3-flash", "openai/gpt-5-mini"], ship: [] } },
            tiers: { omp: { light: ["local/small"] } },
        });
        expect(agentFile(box, "ship")).not.toContain("model:");
        box.ok(["models", "unset", "qa"]);
        box.ok(["models", "unset", "ship"]);
        box.ok(["models", "unset", "light"]);
        expect(harnessOf(box)).toEqual({});
        expect(agentFile(box, "qa")).toContain('    - "anthropic/claude-sonnet-5-5"');
        expect(box.toli(["models", "set", "testing", "a/b"]).stderr).toContain("must be one of");
        expect(box.toli(["models", "set", "qa", "a/b,,c/d"]).stderr).toContain("must be a model id or a list");
    });

    test("check records what omp can run, says which model each list runs, and fails when a list has none", () => {
        const box = machine();
        stubOmpModels(box, ["anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5", "anthropic/claude-opus-5"]);
        const check = box.toli(["models", "check"]);
        expect(check.code).toBe(0);
        expect(check.stdout).toContain("omp: runs 3 models here");
        expect(check.stdout).toContain("-> runs anthropic/claude-sonnet-4-6 (standard tier)");
        expect(check.stdout).toContain("-> runs anthropic/claude-haiku-4-5 (light tier)");
        // A brief's Work: line picks the kind; the catalog picks the list entry.
        const brief = join(box.root, "brief.md");
        writeFileSync(brief, "TOLI_BRIEF v1\n# QA S1\nWork: qa\n## Goal\n");
        expect(box.ok(["spawn", "--dry-run", "--brief", brief, "--cwd", box.root])).toContain(
            "omp anthropic/claude-sonnet-4-6 (standard, work), work qa",
        );
        box.ok(["models", "set", "qa", "google/gemini-3-flash"]);
        const missing = box.toli(["models", "check"]);
        expect(missing.code).toBe(1);
        expect(missing.stdout).toContain("no model available here for: omp qa");
        const shown = JSON.parse(box.ok(["models", "show", "--json"])) as {
            rows: { key: string; available: boolean | null; source: string }[];
        };
        expect(shown.rows.find((row) => row.key === "qa")).toMatchObject({ available: false, source: "machine" });
    });

    test("--fleet makes the same change on every other machine over ssh", () => {
        const box = machine();
        stubOmpModels(box, []);
        writeFileSync(
            join(box.root, "config", "fleet.json"),
            JSON.stringify({
                machines: [
                    { name: "m1", ssh: "m1", root: "/r1" },
                    { name: "m2", ssh: "m2", root: "/r2" },
                    { name: "m3", ssh: "m3", root: "/r3", inbound: false },
                ],
            }),
        );
        const calls = join(box.root, ".ssh-calls");
        box.stub("ssh", `${SSH_STUB_ARGS}\necho "$host $cmd" >> "${calls}"\necho "m2 set"`);
        const result = box.toli(["models", "set", "qa", "google/gemini-3-flash,openai/gpt-5-mini", "--fleet"]);
        // m3 takes no inbound ssh: skipped with the talk to send instead, so the change is not fleet-wide yet.
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("m3: skipped");
        expect(result.stderr).toContain('bin/toli talk m3 "run bin/toli models set qa');
        expect(result.stdout).toContain("== m2 ==\nm2 set");
        const sent = readFileSync(calls, "utf8");
        expect(sent).toStartWith("m2 ");
        expect(sent).toContain(
            "cd /r2 && bin/toli models set qa 'google/gemini-3-flash,openai/gpt-5-mini' --harness omp",
        );
    });

    test("the catalog reader takes omp's selectors, or provider/id, and refuses other output", () => {
        expect(
            catalogSelectors(
                JSON.stringify({ models: [{ selector: "a/b" }, { provider: "c", id: "d" }, { id: "x" }] }),
            ),
        ).toEqual(["a/b", "c/d"]);
        expect(catalogSelectors("not json")).toBeNull();
        expect(catalogSelectors("{}")).toBeNull();
    });
});
