import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox } from "./helpers.ts";

const NOW = "2026-10-30T12:00:00Z";

type Report = {
    budget: number;
    total: number;
    over: boolean;
    files: { file: string; tokens: number }[];
    notes: { file: string; tokens: number }[];
};
type Stale = { file: string; line: number; id: string; date: string | null; ageDays: number | null; tier: string };

const LEARNINGS = [
    "# Learnings",
    "",
    "## Builds",
    "",
    "- 2026-10-25: fresh aging fact",
    "- 2026-09-01: old aging fact",
    "  with a continuation line",
    "- 2026-10-20: watch the flaky test (until: PR #12 merges)",
    "- 2026-10-28: recent perishable (until: v2 ships)",
    "- an undated fact",
    "",
].join("\n");

function write(box: Sandbox, file: string, text: string): string {
    const path = join(box.root, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    return path;
}

function memoryBox(): Sandbox {
    const box = sandbox();
    write(box, "data/malik.md", "# Malik\n\n- 2025-01-01: ancient preference, still pinned\n- Prefers short replies\n");
    write(box, "data/learnings.md", LEARNINGS);
    write(
        box,
        "data/notes/kalki.md",
        "# kalki\n\n## Gotchas\n\n- 2026-09-15: old note fact\n- 2026-10-29: new note fact\n",
    );
    return box;
}

const report = (box: Sandbox): Report => JSON.parse(box.ok(["memory", "--json"], { now: NOW })) as Report;
const stale = (box: Sandbox): Stale[] => JSON.parse(box.ok(["memory", "stale", "--json"], { now: NOW })) as Stale[];

describe("memory budget", () => {
    test("tokens are ceil(UTF-8 bytes / 3); notes are reported but not counted", () => {
        const box = sandbox();
        write(box, "data/malik.md", "a".repeat(3000));
        write(box, "data/learnings.md", "ééééé");
        write(box, "data/notes/kalki.md", "n".repeat(30));
        const result = report(box);
        expect(result.files.map((file) => [file.file, file.tokens])).toEqual([
            ["data/malik.md", 1000],
            ["data/learnings.md", 4],
        ]);
        expect(result.total).toBe(1004);
        expect(result.budget).toBe(7500);
        expect(result.over).toBe(false);
        expect(result.notes).toEqual([expect.objectContaining({ file: "data/notes/kalki.md", tokens: 10 })]);
    });

    test("over budget against memoryBudgetTokens from config/machine.json", () => {
        const box = sandbox();
        write(box, "data/malik.md", "a".repeat(3000));
        write(box, "data/learnings.md", "b".repeat(12));
        write(
            box,
            "config/machine.json",
            JSON.stringify({ name: "m1", role: "coordinator", memoryBudgetTokens: 1000 }),
        );
        const result = report(box);
        expect(result).toMatchObject({ budget: 1000, total: 1004, over: true });
        expect(box.ok(["memory"], { now: NOW })).toContain("1004/1000 estimated tokens (over budget by 4)");
    });

    test("a malformed budget is an error, not a silent default", () => {
        const box = sandbox();
        write(
            box,
            "config/machine.json",
            JSON.stringify({ name: "m1", role: "coordinator", memoryBudgetTokens: "lots" }),
        );
        const result = box.toli(["memory"], { now: NOW });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("memoryBudgetTokens must be a positive integer");
    });
});

describe("memory stale", () => {
    test("aging after 30 days, perishable after 7, undated listed, pinned never", () => {
        const found = stale(memoryBox());
        expect(found.map((entry) => [entry.file, entry.date, entry.ageDays, entry.tier])).toEqual([
            ["data/learnings.md", "2026-09-01", 59, "aging"],
            ["data/learnings.md", "2026-10-20", 10, "perishable"],
            ["data/learnings.md", null, null, "aging"],
            ["data/notes/kalki.md", "2026-09-15", 45, "aging"],
        ]);
    });

    test("refreshing the date re-confirms an entry", () => {
        const box = memoryBox();
        write(box, "data/learnings.md", LEARNINGS.replace("2026-09-01", "2026-10-30"));
        expect(stale(box).some((entry) => entry.line === 6)).toBe(false);
    });
});

describe("memory archive", () => {
    test("moves the whole entry to data/archive with provenance and removes it from the source", () => {
        const box = memoryBox();
        const output = box.ok(["memory", "archive", "learnings", "7", "--reason", "unreinforced 59d"], { now: NOW });
        expect(output).toContain("archived data/learnings.md:6");
        const source = readFileSync(join(box.root, "data/learnings.md"), "utf8");
        expect(source).not.toContain("old aging fact");
        expect(source).not.toContain("continuation line");
        expect(source).toContain("- 2026-10-25: fresh aging fact\n- 2026-10-20: watch");
        const archive = readFileSync(join(box.root, "data/archive/learnings.md"), "utf8");
        expect(archive).toBe(
            [
                "## 2026-10-30",
                "",
                "From `data/learnings.md` line 6 (tier aging, dated 2026-09-01). Reason: unreinforced 59d.",
                "",
                "- 2026-09-01: old aging fact",
                "  with a continuation line",
                "",
            ].join("\n"),
        );
    });

    test("archives by id and appends under the same day's heading", () => {
        const box = memoryBox();
        const [first, second] = stale(box);
        box.ok(["memory", "archive", "data/learnings.md", first?.id ?? "", "--reason", "stale"], { now: NOW });
        box.ok(["memory", "archive", "learnings.md", second?.id ?? "", "--reason", "PR #12 merged"], { now: NOW });
        const archive = readFileSync(join(box.root, "data/archive/learnings.md"), "utf8");
        expect(archive.match(/^## 2026-10-30$/gm)).toHaveLength(1);
        expect(archive).toContain("(tier perishable, dated 2026-10-20). Reason: PR #12 merged.");
        expect(stale(box).map((entry) => entry.date)).toEqual([null, "2026-09-15"]);
    });

    test("notes entries archive to data/archive/<project>.md", () => {
        const box = memoryBox();
        box.ok(["memory", "archive", "notes/kalki", "5", "--reason", "stale"], { now: NOW });
        expect(readFileSync(join(box.root, "data/archive/kalki.md"), "utf8")).toContain("- 2026-09-15: old note fact");
        expect(readFileSync(join(box.root, "data/notes/kalki.md"), "utf8")).not.toContain("old note fact");
    });

    test("pinned entries refuse without --force and stay put", () => {
        const box = memoryBox();
        const before = readFileSync(join(box.root, "data/malik.md"), "utf8");
        const refused = box.toli(["memory", "archive", "malik", "3", "--reason", "old"], { now: NOW });
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("pinned");
        expect(readFileSync(join(box.root, "data/malik.md"), "utf8")).toBe(before);
        expect(existsSync(join(box.root, "data/archive/malik.md"))).toBe(false);

        box.ok(["memory", "archive", "malik", "3", "--reason", "Malik retired it", "--force"], { now: NOW });
        expect(readFileSync(join(box.root, "data/malik.md"), "utf8")).not.toContain("ancient preference");
        expect(readFileSync(join(box.root, "data/archive/malik.md"), "utf8")).toContain(
            "(tier pinned, dated 2025-01-01)",
        );
    });

    test("a line outside any entry and a missing reason are refused", () => {
        const box = memoryBox();
        expect(box.toli(["memory", "archive", "learnings", "3", "--reason", "x"], { now: NOW }).stderr).toContain(
            "not inside a memory entry",
        );
        expect(box.toli(["memory", "archive", "learnings", "6"], { now: NOW }).stderr).toContain("--reason");
    });
});
