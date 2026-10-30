import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type Sandbox, sandbox } from "./helpers.ts";

type Move = { kind: string; from: string; to: string; duplicate: boolean };
type Plan = {
    applied: boolean;
    moves: Move[];
    conflicts: Move[];
    kept: { path: string; reason: string }[];
    references: { file: string; references: number }[];
};

function put(box: Sandbox, file: string, text: string): void {
    const path = join(box.root, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
}

function task(id: string, project: string): Record<string, unknown> {
    const at = "2026-10-01T00:00:00.000Z";
    return { id, project, title: id, shape: "scout", status: "done", notes: [], createdAt: at, updatedAt: at };
}

/** Every file under data/ and config/ with its content. */
function snapshot(box: Sandbox): Record<string, string> {
    const files: Record<string, string> = {};
    const walk = (dir: string): void => {
        if (!existsSync(dir)) return;
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) walk(path);
            else files[relative(box.root, path)] = readFileSync(path, "utf8");
        }
    };
    walk(join(box.root, "data"));
    walk(join(box.root, "config"));
    return files;
}

/** The old flat layout: notes, task reports (live and archived tasks), remote runs, briefs, toli-wide reports. */
function oldLayout(): Sandbox {
    const box = sandbox();
    put(box, "data/notes/app.md", "# app\n\nSee data/reports/T1.md and data/reports/T12.md.\n");
    put(box, "data/notes/web.md", "# web\n");
    put(
        box,
        "data/backlog.json",
        JSON.stringify({ nextId: 13, tasks: [task("T1", "app"), task("T12", "web"), task("T4", "app-x")] }, null, 4),
    );
    put(box, "data/archive/tasks.json", JSON.stringify({ tasks: [task("T3", "web")] }));
    put(box, "data/reports/T1.md", "report one");
    put(box, "data/reports/T12.md", "report twelve");
    put(box, "data/reports/T3.md", "archived task report");
    put(box, "data/reports/T99.md", "orphan report");
    put(box, "data/reports/toli-study.md", "toli-wide");
    put(box, "data/remote/2026-10-01T00-00-00-000Z-m2.md", "# remote m2\n\n- from: m1\n- project: app\n");
    put(box, "data/remote/2026-10-02T00-00-00-000Z-m2.md", "# remote m2\n\n- from: m1\n");
    put(box, "data/briefs/app-release.md", "release brief; see data/notes/app.md");
    put(box, "data/briefs/web.md", "web brief");
    put(box, "data/briefs/keybindings.md", "global brief");
    // Both "app" and "app-x" prefix these names: ambiguous unless a scheduled job of one project uses the brief.
    put(box, "data/briefs/app-x-old.md", "ambiguous brief");
    put(box, "data/briefs/app-x-plan.md", "job brief");
    put(
        box,
        "config/jobs.json",
        JSON.stringify({
            jobs: [
                { name: "j", prompt: "Follow data/briefs/app-release.md and data/notes/app.md" },
                { name: "k", project: "app-x", prompt: "Follow data/briefs/app-x-plan.md" },
            ],
        }),
    );
    put(box, "data/learnings.md", "- 2026-10-01: data/notes/web.md has the web stack\n");
    return box;
}

const plan = (box: Sandbox, args: string[]): Plan => JSON.parse(box.ok(["migrate", "--json", ...args])) as Plan;

describe("migrate", () => {
    test("dry run prints the plan and changes nothing", () => {
        const box = oldLayout();
        const before = snapshot(box);
        const result = plan(box, ["--dry-run"]);
        expect(result.applied).toBe(false);
        expect(result.moves.map((move) => [move.kind, move.from, move.to])).toEqual([
            ["notes", "data/notes/app.md", "data/projects/app/notes.md"],
            ["notes", "data/notes/web.md", "data/projects/web/notes.md"],
            ["report", "data/reports/T1.md", "data/projects/app/reports/T1.md"],
            ["report", "data/reports/T12.md", "data/projects/web/reports/T12.md"],
            ["report", "data/reports/T3.md", "data/projects/web/reports/T3.md"],
            [
                "run",
                "data/remote/2026-10-01T00-00-00-000Z-m2.md",
                "data/projects/app/runs/2026-10-01T00-00-00-000Z-m2.md",
            ],
            ["brief", "data/briefs/app-release.md", "data/projects/app/briefs/app-release.md"],
            ["brief", "data/briefs/app-x-plan.md", "data/projects/app-x/briefs/app-x-plan.md"],
            ["brief", "data/briefs/web.md", "data/projects/web/briefs/web.md"],
        ]);
        expect(result.kept.map((entry) => entry.path)).toEqual([
            "data/reports/T99.md",
            "data/reports/toli-study.md",
            "data/remote/2026-10-02T00-00-00-000Z-m2.md",
            "data/briefs/app-x-old.md",
            "data/briefs/keybindings.md",
        ]);
        expect(result.conflicts).toEqual([]);
        expect(result.references).toEqual(
            expect.arrayContaining([
                { file: "config/jobs.json", references: 3 },
                { file: "data/learnings.md", references: 1 },
                { file: "data/briefs/app-release.md", references: 1 },
                { file: "data/notes/app.md", references: 2 },
            ]),
        );
        const text = box.ok(["migrate", "--dry-run"]);
        expect(text).toContain("migrate (dry run): 9 files to move, 0 conflicts");
        expect(text).toContain("data/briefs/app-x-old.md (brief name fits several projects (app, app-x))");
        expect(text).toContain("move   data/notes/app.md -> data/projects/app/notes.md");
        expect(text).toContain("data/reports/toli-study.md (toli-wide report)");
        expect(text).toContain("nothing changed");
        expect(snapshot(box)).toEqual(before);
    });

    test("moves every file without loss, rewrites references, and is idempotent", () => {
        const box = oldLayout();
        const before = snapshot(box);
        expect(plan(box, []).applied).toBe(true);
        const after = snapshot(box);
        expect(after["data/projects/app/notes.md"]).toBe(
            "# app\n\nSee data/projects/app/reports/T1.md and data/projects/web/reports/T12.md.\n",
        );
        expect(after["data/projects/web/reports/T12.md"]).toBe("report twelve");
        expect(after["data/projects/web/reports/T3.md"]).toBe("archived task report");
        expect(after["data/projects/app/runs/2026-10-01T00-00-00-000Z-m2.md"]).toContain("- project: app");
        expect(after["data/projects/app/briefs/app-release.md"]).toBe("release brief; see data/projects/app/notes.md");
        expect(after["data/reports/T99.md"]).toBe("orphan report");
        expect(after["data/reports/toli-study.md"]).toBe("toli-wide");
        expect(after["data/briefs/keybindings.md"]).toBe("global brief");
        expect(after["config/jobs.json"]).toContain(
            "Follow data/projects/app/briefs/app-release.md and data/projects/app/notes.md",
        );
        expect(after["data/learnings.md"]).toContain("data/projects/web/notes.md");
        expect(existsSync(join(box.root, "data/notes"))).toBe(false);
        // No loss: same number of files, and every original body is still somewhere.
        expect(Object.keys(after)).toHaveLength(Object.keys(before).length);
        for (const [file, body] of Object.entries(before))
            if (
                !file.endsWith(".json") &&
                !file.includes("notes/") &&
                file !== "data/learnings.md" &&
                !file.endsWith("app-release.md")
            )
                expect(Object.values(after)).toContain(body);

        const again = plan(box, []);
        expect(again.moves).toEqual([]);
        expect(again.references).toEqual([]);
        expect(snapshot(box)).toEqual(after);
        expect(box.ok(["migrate"])).toContain("nothing to move; the layout is current");
    });

    test("refuses to overwrite a different destination and changes nothing; identical copies are deduplicated", () => {
        const box = oldLayout();
        put(box, "data/projects/app/notes.md", "# app (newer, different)\n");
        put(box, "data/projects/web/reports/T12.md", "report twelve");
        const before = snapshot(box);
        const dry = plan(box, ["--dry-run"]);
        expect(dry.conflicts.map((move) => move.from)).toEqual(["data/notes/app.md"]);
        expect(dry.moves.find((move) => move.from === "data/reports/T12.md")?.duplicate).toBe(true);
        expect(box.ok(["migrate", "--dry-run"])).toContain(
            "CONFLICT data/notes/app.md -> data/projects/app/notes.md (destination differs)",
        );
        const refused = box.toli(["migrate"]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("refusing to migrate: 1 destination already exists with different content");
        expect(snapshot(box)).toEqual(before);

        writeFileSync(join(box.root, "data/notes/app.md"), "# app (newer, different)\n");
        plan(box, []);
        expect(existsSync(join(box.root, "data/reports/T12.md"))).toBe(false);
        expect(readFileSync(join(box.root, "data/projects/web/reports/T12.md"), "utf8")).toBe("report twelve");
        expect(readFileSync(join(box.root, "data/projects/app/notes.md"), "utf8")).toBe("# app (newer, different)\n");
    });

    test("a brief named by a task id moves to that task's project, as its report does", () => {
        const box = sandbox();
        put(box, "data/backlog.json", JSON.stringify({ nextId: 11, tasks: [task("T10", "app")] }));
        put(box, "data/archive/tasks.json", JSON.stringify({ tasks: [task("T3", "web")] }));
        put(box, "data/briefs/T10.md", "brief ten");
        put(box, "data/briefs/T3.md", "archived task brief");
        put(box, "data/briefs/T77.md", "orphan brief");
        const dry = plan(box, ["--dry-run"]);
        expect(dry.moves.map((move) => [move.kind, move.from, move.to])).toEqual([
            ["brief", "data/briefs/T10.md", "data/projects/app/briefs/T10.md"],
            ["brief", "data/briefs/T3.md", "data/projects/web/briefs/T3.md"],
        ]);
        expect(dry.kept).toEqual([
            { path: "data/briefs/T77.md", reason: "task T77 not found in the backlog or task archive" },
        ]);
    });

    test("moves the persona-named preferences file and its archive, rewriting mentions; refuses to overwrite", () => {
        const box = sandbox();
        put(box, "data/malik.md", "# Preferences\n\n- 2026-10-01: short replies\n");
        put(box, "data/archive/malik.md", "## 2026-10-02\n\n- 2026-09-01: old preference\n");
        put(box, "data/learnings.md", "- 2026-10-01: standing answers live in data/malik.md\n");
        const before = snapshot(box);
        const dry = plan(box, ["--dry-run"]);
        expect(dry.moves.map((move) => [move.kind, move.from, move.to])).toEqual([
            ["preferences", "data/malik.md", "data/preferences.md"],
            ["preferences", "data/archive/malik.md", "data/archive/preferences.md"],
        ]);
        expect(dry.references).toEqual([{ file: "data/learnings.md", references: 1 }]);
        expect(snapshot(box)).toEqual(before);

        put(box, "data/preferences.md", "# Preferences (already moved, different)\n");
        const refused = box.toli(["migrate"]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("data/malik.md -> data/preferences.md");
        expect(existsSync(join(box.root, "data/malik.md"))).toBe(true);
        expect(existsSync(join(box.root, "data/archive/preferences.md"))).toBe(false);

        writeFileSync(join(box.root, "data/preferences.md"), before["data/malik.md"] ?? "");
        const applied = plan(box, []);
        expect(applied.moves.find((move) => move.from === "data/malik.md")?.duplicate).toBe(true);
        const after = snapshot(box);
        expect(after["data/preferences.md"]).toBe(before["data/malik.md"]);
        expect(after["data/archive/preferences.md"]).toBe(before["data/archive/malik.md"]);
        expect(after["data/learnings.md"]).toBe("- 2026-10-01: standing answers live in data/preferences.md\n");
        expect(existsSync(join(box.root, "data/malik.md"))).toBe(false);
        expect(existsSync(join(box.root, "data/archive/malik.md"))).toBe(false);
        expect(plan(box, []).moves).toEqual([]);
    });

    test("an empty data directory has nothing to migrate", () => {
        expect(sandbox().ok(["migrate", "--dry-run"])).toBe("migrate: nothing to move; the layout is current");
    });
});
