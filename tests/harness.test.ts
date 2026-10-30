import { describe, expect, test } from "bun:test";
import {
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GENERIC_NAMES, guidanceRules, leadGuidance } from "../src/harness/guidance.ts";
import { HARNESSES, headlessCommand } from "../src/harness/harness.ts";
import { claudeAction, guardDecision, ompAction } from "../src/harness/lead-guard.ts";
import { shimItems, syncShims } from "../src/harness/sync.ts";
import { sandbox } from "./helpers.ts";

const INPUT = { brief: "TOLI_BRIEF v1\ndo it", cwd: "/w/projects/alpha", root: "/w", maxMinutes: 30 };

describe("headless commands", () => {
    test("each harness gets its documented non-interactive flags; the brief goes on stdin or as the prompt", () => {
        expect(headlessCommand("omp", INPUT)).toEqual({
            argv: [
                "omp",
                "-p",
                "--cwd",
                "/w/projects/alpha",
                "--no-title",
                "--approval-mode",
                "yolo",
                "--max-time",
                "30m",
                INPUT.brief,
            ],
            stdin: null,
        });
        expect(headlessCommand("claude", { ...INPUT, model: "sonnet" })).toEqual({
            argv: [
                "claude",
                "-p",
                "--output-format",
                "text",
                "--permission-mode",
                "acceptEdits",
                "--allowedTools",
                "Bash,Read,Edit,Write,MultiEdit,NotebookEdit,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite",
                "--add-dir",
                "/w",
                "--model",
                "sonnet",
            ],
            stdin: INPUT.brief,
        });
        expect(headlessCommand("codex", INPUT)).toEqual({
            argv: [
                "codex",
                "exec",
                "--sandbox",
                "workspace-write",
                "-c",
                "sandbox_workspace_write.network_access=true",
                "--add-dir",
                "/w",
                "--skip-git-repo-check",
                "-C",
                "/w/projects/alpha",
                "-",
            ],
            stdin: INPUT.brief,
        });
        expect(headlessCommand("cursor", { ...INPUT, model: "m" })).toEqual({
            argv: ["cursor-agent", "-p", "--force", "--output-format", "text", "--model", "m", INPUT.brief],
            stdin: null,
        });
        expect(headlessCommand("grok", INPUT)).toEqual({
            argv: [
                "grok",
                "--cwd",
                "/w/projects/alpha",
                "--always-approve",
                "--no-auto-update",
                "--output-format",
                "plain",
                "-p",
                INPUT.brief,
            ],
            stdin: null,
        });
        expect(headlessCommand("pi", { ...INPUT, model: "anthropic/x" })).toEqual({
            argv: ["pi", "-p", "--model", "anthropic/x", INPUT.brief],
            stdin: null,
        });
        expect(HARNESSES.map((harness) => headlessCommand(harness, INPUT).argv[0])).toEqual([
            "omp",
            "claude",
            "codex",
            "cursor-agent",
            "grok",
            "pi",
        ]);
    });
});

describe("lead guard", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "toli-guard-")));
    const lead = { root, cwd: root, jawan: false };

    test("the lead may write toli's records but not project or toli source files", () => {
        expect(guardDecision(lead, { kind: "write", paths: ["data/projects/a/briefs/T1.md"] }).allow).toBe(true);
        expect(guardDecision(lead, { kind: "write", paths: [join(root, "state", "x.json")] }).allow).toBe(true);
        expect(guardDecision(lead, { kind: "write", paths: ["config/machine.json"] }).allow).toBe(true);
        expect(guardDecision(lead, { kind: "write", paths: ["agent://Peer"] }).allow).toBe(true);
        const project = guardDecision(lead, { kind: "write", paths: ["projects/alpha/src/main.ts"] });
        expect(project).toEqual({ allow: false, reason: expect.stringContaining("jawan work") });
        expect(guardDecision(lead, { kind: "write", paths: ["src/records/digest.ts"] }).allow).toBe(false);
        expect(guardDecision(lead, { kind: "write", paths: ["data/x.md", "/opt/elsewhere/y.ts"] }).allow).toBe(false);
    });

    test("the lead may not read project code but may read toli's own files", () => {
        expect(guardDecision(lead, { kind: "read", paths: ["projects/alpha/README.md"] }).allow).toBe(false);
        expect(guardDecision(lead, { kind: "read", paths: [join(root, "projects")] }).allow).toBe(false);
        expect(guardDecision(lead, { kind: "read", paths: ["data/projects/alpha/notes.md"] }).allow).toBe(true);
        expect(guardDecision(lead, { kind: "read", paths: ["AGENTS.md"] }).allow).toBe(true);
        expect(guardDecision(lead, { kind: "other" }).allow).toBe(true);
    });

    test("jawans are never blocked: by marker, or by running anywhere but toli's root", () => {
        const write = { kind: "write" as const, paths: ["projects/alpha/src/main.ts"] };
        expect(guardDecision({ ...lead, jawan: true }, write).allow).toBe(true);
        expect(
            guardDecision({ ...lead, cwd: join(root, "projects", "alpha") }, { kind: "write", paths: ["x.ts"] }).allow,
        ).toBe(true);
    });

    test("harness tool calls map to paths: Claude fields, omp hashline headers and ;-lists", () => {
        expect(claudeAction("Edit", { file_path: "/a/b.ts" })).toEqual({ kind: "write", paths: ["/a/b.ts"] });
        expect(claudeAction("Glob", { pattern: "projects/**" })).toEqual({ kind: "read", paths: ["projects/**"] });
        expect(claudeAction("Bash", { command: "bin/toli digest" })).toEqual({ kind: "other" });
        expect(
            ompAction("edit", { input: "[projects/a/x.ts#1A2B]\nPUT 1.=1:\n+x\n[data/n.md#FFFF]\nMV data/m.md" }),
        ).toEqual({ kind: "write", paths: ["projects/a/x.ts", "data/n.md", "data/m.md"] });
        expect(ompAction("grep", { path: "src;projects/a" })).toEqual({ kind: "read", paths: ["src", "projects/a"] });
        expect(ompAction("bash", { command: "cat projects/a/x" })).toEqual({ kind: "other" });
    });

    // A toli reached through a symlink (macOS /tmp -> /private/tmp) with a project linked to a checkout in temp.
    function linkedBox() {
        const base = realpathSync(mkdtempSync(join(tmpdir(), "toli-guard-link-")));
        const real = join(base, "real-root");
        const alias = join(base, "alias-root");
        const checkout = join(base, "checkout");
        mkdirSync(join(real, "projects"), { recursive: true });
        mkdirSync(join(real, "data"));
        mkdirSync(checkout);
        writeFileSync(join(checkout, "README.md"), "hello\n");
        symlinkSync(real, alias, "dir");
        symlinkSync(checkout, join(real, "projects", "dummy"), "dir");
        return { base, real, alias, checkout };
    }

    test("D1: a symlinked root and a linked project in temp never open project writes", () => {
        const { base, real, alias, checkout } = linkedBox();
        for (const context of [
            { root: alias, cwd: alias, jawan: false },
            { root: real, cwd: alias, jawan: false },
            { root: alias, cwd: real, jawan: false },
        ]) {
            for (const path of [
                "projects/dummy/README.md",
                join(alias, "projects", "dummy", "README.md"),
                join(real, "projects", "dummy", "NEW.txt"),
                join(checkout, "README.md"),
                join(checkout, "NEW.txt"),
            ])
                expect([path, guardDecision(context, { kind: "write", paths: [path] }).allow]).toEqual([path, false]);
            for (const path of ["projects/dummy/README.md", join(real, "projects", "dummy", "README.md")])
                expect([path, guardDecision(context, { kind: "read", paths: [path] }).allow]).toEqual([path, false]);
            for (const path of ["data/x.md", join(alias, "data", "x.md"), join(real, "data", "x.md"), join(base, "s")])
                expect([path, guardDecision(context, { kind: "write", paths: [path] }).allow]).toEqual([path, true]);
        }
    });

    test("D2: the lead may not read a linked project through its real checkout path", () => {
        const { alias, checkout } = linkedBox();
        const lead = { root: alias, cwd: alias, jawan: false };
        for (const path of [checkout, join(checkout, "README.md"), join(checkout, "src", "**")])
            expect([path, guardDecision(lead, { kind: "read", paths: [path] }).allow]).toEqual([path, false]);
        expect(guardDecision(lead, { kind: "read", paths: ["AGENTS.md"] }).allow).toBe(true);
    });
});

describe("claude hooks", () => {
    function hookBox() {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const root = box.root;
        const pre = (input: object, env: Record<string, string> = {}) =>
            box.ok(["hook", "claude-pre-tool"], { stdin: JSON.stringify(input), env: { TOLI_ROLE: "", ...env } });
        return { box, root, pre };
    }

    test("PreToolUse denies a lead edit in projects/ and allows a jawan's", () => {
        const { root, pre } = hookBox();
        const call = { cwd: root, tool_name: "Edit", tool_input: { file_path: join(root, "projects/alpha/x.ts") } };
        const denied = JSON.parse(pre(call)) as { hookSpecificOutput: Record<string, string> };
        expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
        expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("toli lead guard");
        expect(pre(call, { TOLI_ROLE: "jawan" })).toBe("");
        expect(pre({ ...call, agent_id: "sub-1" })).toBe("");
        expect(pre({ ...call, tool_input: { file_path: join(root, "data/notes.md") } })).toBe("");
        expect(pre({ cwd: root, tool_name: "Bash", tool_input: { command: "bin/toli task list" } })).toBe("");
    });

    test("a session whose first user message is a brief counts as a jawan", () => {
        const { root, pre } = hookBox();
        const transcript = join(root, "t.jsonl");
        writeFileSync(
            transcript,
            `${JSON.stringify({ type: "user", isMeta: true, message: { content: "caveat" } })}\n${JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "TOLI_BRIEF v1\nfix" }] } })}\n`,
        );
        const call = {
            cwd: root,
            transcript_path: transcript,
            tool_name: "Read",
            tool_input: { file_path: "projects/a/x" },
        };
        expect(pre(call)).toBe("");
        expect(
            JSON.parse(pre({ ...call, transcript_path: join(root, "missing.jsonl") })).hookSpecificOutput
                .permissionDecision,
        ).toBe("deny");
    });

    test("UserPromptSubmit gives the lead its guidance plus new results, and jawans nothing", () => {
        const { box, root } = hookBox();
        box.ok(["inbox", "add", "--from", "m2", "--title", "jawan j-1 done: omp"], { stdin: "ok" });
        const run = (prompt: string, env: Record<string, string> = {}) =>
            box.ok(["hook", "claude-prompt"], {
                stdin: JSON.stringify({ cwd: root, prompt }),
                env: { TOLI_ROLE: "", ...env },
            });
        const context = JSON.parse(run("hello")).hookSpecificOutput.additionalContext as string;
        expect(context).toContain("[toli] You are the lead (Sardar)");
        expect(context).toContain("Delegate everything");
        expect(context).toContain("m2: jawan j-1 done: omp");
        expect(JSON.parse(run("again")).hookSpecificOutput.additionalContext).not.toContain("j-1");
        expect(run("TOLI_BRIEF v1\nwork")).toBe("");
        expect(run("hello", { TOLI_ROLE: "jawan" })).toBe("");
    });

    test("a malformed hook input allows the call instead of failing closed", () => {
        const { box } = hookBox();
        const result = box.toli(["hook", "claude-pre-tool"], { stdin: "{not json" });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("(allowing)");
    });
});

describe("lead guidance", () => {
    const REPLY_RULE = /^- Reply to (Malik|the user) in 1-3 short lines unless asked for detail: /;

    test("the reply-length rule comes first, in the live reminder and the generic rule files alike", () => {
        const persona = {
            user: "Malik",
            lead: "Sardar",
            leadPlural: "Saradars",
            worker: "jawan",
            workerPlural: "jawans",
        };
        const lines = leadGuidance(persona).split("\n");
        expect(lines[0]).toStartWith("[toli] You are the lead (Sardar)");
        expect(lines[1]).toMatch(REPLY_RULE);
        expect(guidanceRules(GENERIC_NAMES)[0]).toMatch(REPLY_RULE);
        expect(guidanceRules(GENERIC_NAMES).join("\n")).not.toContain("one or two lines");
    });

    test("AGENTS.md states the same rule early in section 1", () => {
        const agents = readFileSync(join(import.meta.dir, "..", "AGENTS.md"), "utf8");
        const identity = agents.slice(agents.indexOf("## 1. Identity"), agents.indexOf("## 2. "));
        const bullets = identity.split("\n").filter((line) => line.startsWith("- "));
        expect(bullets[1]).toStartWith("- Reply in 1-3 short lines unless Malik asks for detail: ");
        expect(agents).not.toContain("one or two lines");
    });
});

describe("harness sync", () => {
    test("creates every shim once, then reports everything ok; --check never writes", () => {
        const root = mkdtempSync(join(tmpdir(), "toli-sync-"));
        expect(syncShims(root, true).every((result) => result.state === "missing" && result.action === "none")).toBe(
            true,
        );
        expect(() => lstatSync(join(root, "CLAUDE.md"))).toThrow();
        const first = syncShims(root, false);
        expect(first.every((result) => result.action === "created")).toBe(true);
        expect(readlinkSync(join(root, ".claude", "skills"))).toBe("../.omp/skills");
        expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");
        const second = syncShims(root, false);
        expect(second.every((result) => result.state === "ok" && result.action === "none")).toBe(true);
    });

    test("repairs drift but never replaces a real directory", () => {
        const root = mkdtempSync(join(tmpdir(), "toli-sync-"));
        syncShims(root, false);
        writeFileSync(join(root, "CLAUDE.md"), "edited\n");
        mkdirSync(join(root, ".pi", "prompts-real"), { recursive: true });
        const results = syncShims(root, false);
        expect(results.find((result) => result.path === "CLAUDE.md")?.action).toBe("updated");
        const blockedRoot = mkdtempSync(join(tmpdir(), "toli-sync-"));
        mkdirSync(join(blockedRoot, ".agents", "skills"), { recursive: true });
        const blocked = syncShims(blockedRoot, false).find((result) => result.path === ".agents/skills");
        expect(blocked?.state).toBe("blocked");
        expect(lstatSync(join(blockedRoot, ".agents", "skills")).isDirectory()).toBe(true);
    });

    test("the repository's committed shims are in sync with the generator", () => {
        const repo = resolve(import.meta.dir, "..");
        const drift = syncShims(repo, true).filter((result) => result.state !== "ok");
        expect(drift).toEqual([]);
        expect(shimItems().length).toBeGreaterThan(0);
    });
});
