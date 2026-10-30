import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/paths.ts";
import { type Sandbox, sandbox, withProject } from "./helpers.ts";

type Check = { key: string; status: string; detail: string; fill?: string };
type Report = { project: string; ready: boolean; checks: Check[] };

const FULL_NOTES = [
    "# app",
    "",
    "## Commands",
    "",
    "- Test: `bun test`",
    "- Smoke: `bun run smoke`",
    "",
    "## Local stack",
    "",
    "- None",
    "",
    "## URLs",
    "",
    "- None",
    "",
    "## Proof",
    "",
    "- Screenshots at 390 and 1440 widths",
    "",
].join("\n");

function notes(box: Sandbox, project: string, text: string): string {
    const file = join(box.root, "data", "projects", project, "notes.md");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
    return file;
}

function setup(box: Sandbox, project: string): Report {
    return JSON.parse(box.ok(["project", "setup", project, "--json"])) as Report;
}

const status = (report: Report): Record<string, string> =>
    Object.fromEntries(report.checks.map((check) => [check.key, check.status]));

function registered(): Sandbox {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    withProject(box, "app");
    return box;
}

describe("per-project data paths", () => {
    test("every per-project file lives under data/projects/<name>/", () => {
        const previous = process.env.TOLI_ROOT;
        process.env.TOLI_ROOT = "/tmp/toli-root";
        try {
            expect(paths.projectsDataDir()).toBe("/tmp/toli-root/data/projects");
            expect(paths.projectDataDir("app")).toBe("/tmp/toli-root/data/projects/app");
            expect(paths.projectNotes("app")).toBe("/tmp/toli-root/data/projects/app/notes.md");
            expect(paths.projectBriefsDir("app")).toBe("/tmp/toli-root/data/projects/app/briefs");
            expect(paths.projectReportsDir("app")).toBe("/tmp/toli-root/data/projects/app/reports");
            expect(paths.projectReport("app", "T7")).toBe("/tmp/toli-root/data/projects/app/reports/T7.md");
            expect(paths.projectRunsDir("app")).toBe("/tmp/toli-root/data/projects/app/runs");
            expect(paths.projectDecisions("app")).toBe("/tmp/toli-root/data/projects/app/decisions.md");
            expect(paths.reportsDir()).toBe("/tmp/toli-root/data/reports");
        } finally {
            if (previous === undefined) delete process.env.TOLI_ROOT;
            else process.env.TOLI_ROOT = previous;
        }
    });
});

describe("project set", () => {
    test("records the delivery choice and validates every value", () => {
        const box = registered();
        const list = (): Record<string, unknown>[] => JSON.parse(box.ok(["project", "list", "--json"]));
        expect(list()[0]?.deliverySetAt).toBeUndefined();
        box.ok(["project", "set", "app", "--forge", "github"]);
        expect(list()[0]?.deliverySetAt).toBeUndefined();
        expect(box.ok(["project", "set", "app", "--mode", "pr", "--branch", "none"])).toBe("app: mode=pr forge=github");
        expect(list()[0]?.deliverySetAt).toEqual(expect.any(String));

        const refusals: [string[], string][] = [
            [["--mode", "merge"], "--mode must be one of commit, pr, no-mistakes"],
            [["--branch", "bad..name"], "is not a valid branch name"],
            [["--forge", "gitea"], "--forge must be one of github, gitlab, bitbucket, or none"],
            [["--forge-host", "https://gitlab.example.com"], "--forge-host must be a host name"],
            [[], "nothing to set"],
        ];
        for (const [args, message] of refusals) {
            const result = box.toli(["project", "set", "app", ...args]);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain(message);
        }
        expect(box.toli(["project", "set", "ghost", "--mode", "pr"]).stderr).toContain('unknown project "ghost"');
    });
});

describe("project setup", () => {
    test("a fresh registration lists the delivery question and the missing notes", () => {
        const box = registered();
        const report = setup(box, "app");
        expect(report.ready).toBe(false);
        expect(status(report)).toMatchObject({ clone: "ok", delivery: "missing", branch: "ok", notes: "missing" });
        expect(report.checks.find((check) => check.key === "delivery")).toMatchObject({
            fill: "ask",
            detail: "never chosen; defaulted to commit on the checked-out branch",
        });
        const text = box.ok(["project", "setup", "app"]);
        expect(text).toContain("app: needs setup");
        expect(text).toContain("[ ] delivery");
        expect(text).toContain("(ask the user)");
    });

    test("notes sections, commands and freshness are checked; a complete project is set up", () => {
        const box = registered();
        box.ok(["project", "set", "app", "--mode", "commit", "--branch", "main"]);
        const file = notes(box, "app", "# app\n\n## Commands\n\n- `bun install`\n");
        expect(status(setup(box, "app"))).toMatchObject({
            delivery: "ok",
            branch: "ok",
            notes: "ok",
            test: "missing",
            smoke: "missing",
            "local-stack": "missing",
            urls: "missing",
            proof: "missing",
            freshness: "ok",
        });
        writeFileSync(file, FULL_NOTES);
        const ready = setup(box, "app");
        expect(ready.checks.filter((check) => check.status !== "ok" && check.status !== "optional")).toEqual([]);
        expect(ready.ready).toBe(true);
        const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
        utimesSync(file, old, old);
        expect(status(setup(box, "app")).freshness).toBe("stale");
    });

    test("a fixed branch missing from the clone and a pr project without a forge are gaps", () => {
        const box = registered();
        box.ok(["project", "set", "app", "--branch", "release"]);
        expect(setup(box, "app").checks.find((check) => check.key === "branch")).toMatchObject({
            status: "missing",
            detail: "fixed branch release exists neither locally nor on origin",
        });
        box.ok(["project", "set", "app", "--mode", "pr", "--branch", "none"]);
        expect(status(setup(box, "app")).forge).toBe("missing");
    });

    test("--all lists only projects with gaps", () => {
        const box = registered();
        withProject(box, "done");
        box.ok(["project", "set", "done", "--mode", "commit"]);
        notes(box, "done", FULL_NOTES);
        const needing = JSON.parse(box.ok(["project", "setup", "--all", "--json"])) as {
            name: string;
            missing: string[];
        }[];
        expect(needing).toEqual([{ name: "app", missing: ["delivery", "notes"] }]);
        expect(box.ok(["project", "setup", "--all"])).toContain("1 of 2 projects need setup");
        expect(box.toli(["project", "setup", "app", "--all"]).code).toBe(1);
    });

    test("drop keeps the project's data directory unless --delete-data", () => {
        const box = registered();
        notes(box, "app", FULL_NOTES);
        expect(box.ok(["project", "drop", "app"])).toBe(
            "dropped app (clone kept at projects/app; data kept at data/projects/app)",
        );
        withProject(box, "app2");
        notes(box, "app2", FULL_NOTES);
        expect(box.ok(["project", "drop", "app2", "--delete-data"])).toBe(
            "dropped app2 and deleted data/projects/app2 (clone kept at projects/app2)",
        );
    });
});

describe("project decisions", () => {
    test("answering a held task appends the question and answer to data/projects/<p>/decisions.md", () => {
        const box = registered();
        box.ok(["task", "add", "app", "Pick a cache"]);
        box.ok(["task", "hold", "T1", "--question", "Redis or in-memory?"]);
        box.ok(["task", "answer", "T1", "in-memory"], { now: "2026-10-30T12:00:00Z" });
        expect(readFileSync(join(box.root, "data/projects/app/decisions.md"), "utf8")).toBe(
            "# app decisions\n\n## 2026-10-30 T1: Pick a cache\n\n- Q: Redis or in-memory?\n- A: in-memory\n",
        );
    });
});
