import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type Sandbox, sandbox } from "./helpers.ts";

const NOW = "2026-10-30T12:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;

type Item = { kind: string; target: string; action: string };
type Task = { id: string; status: string };

const daysAgo = (days: number): Date => new Date(Date.parse(NOW) - days * DAY_MS);
const fileStamp = (date: Date): string => date.toISOString().replace(/[:.]/g, "-");

function put(box: Sandbox, file: string, text: string, mtime?: Date): void {
    const path = join(box.root, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    if (mtime) utimesSync(path, mtime, mtime);
}

function task(id: string, status: string, at: Date): Record<string, unknown> {
    const iso = at.toISOString();
    return {
        id,
        project: "p",
        title: `task ${id}`,
        shape: "ship",
        status,
        notes: [],
        createdAt: iso,
        updatedAt: iso,
        ...(status === "done" ? { doneAt: iso } : {}),
    };
}

/** Every file under data/ and logs/ with its content, to prove a dry run changes nothing. */
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
    walk(join(box.root, "logs"));
    return files;
}

function prunable(): Sandbox {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    // daily: 7 results 60+ days old plus 1 fresh; the newest 5 stay, so the 3 oldest go.
    for (let index = 0; index < 7; index++) put(box, `data/jobs/daily/${fileStamp(daysAgo(60 + index))}.md`, "old");
    put(box, `data/jobs/daily/${fileStamp(daysAgo(1))}.md`, "fresh");
    // weekly: only 2 results, both old; kept because the newest 5 always stay.
    put(box, `data/jobs/weekly/${fileStamp(daysAgo(100))}.md`, "old");
    put(box, `data/jobs/weekly/${fileStamp(daysAgo(200))}.md`, "old");
    put(
        box,
        "data/backlog.json",
        JSON.stringify({
            nextId: 5,
            tasks: [
                task("T1", "done", daysAgo(200)),
                task("T2", "dropped", daysAgo(100)),
                task("T3", "done", daysAgo(10)),
                task("T4", "queued", daysAgo(300)),
            ],
        }),
    );
    put(box, "data/reports/T1.md", "investigation", daysAgo(400));
    put(box, "logs/old.log", "old", daysAgo(30));
    put(box, "logs/tick.log", "fresh", daysAgo(1));
    const seen = fileStamp(daysAgo(40));
    put(box, `data/inbox/${seen}-m2.md`, "# seen\n");
    put(box, `data/inbox/${fileStamp(daysAgo(30))}-m2.md`, "# unseen\n");
    put(box, "state/acks.json", JSON.stringify({ inbox: seen }));
    return box;
}

const plan = (box: Sandbox, args: string[] = []): { applied: boolean; items: Item[] } =>
    JSON.parse(box.ok(["prune", "--json", ...args], { now: NOW })) as { applied: boolean; items: Item[] };

describe("prune", () => {
    test("dry run lists what would go and changes nothing", () => {
        const box = prunable();
        const before = snapshot(box);
        const result = plan(box);
        expect(result.applied).toBe(false);
        expect(result.items.map((item) => [item.kind, item.action])).toEqual([
            ["job-result", "delete"],
            ["job-result", "delete"],
            ["job-result", "delete"],
            ["task", "archive"],
            ["task", "archive"],
            ["log", "delete"],
            ["inbox", "delete"],
        ]);
        expect(result.items.some((item) => item.target.includes("reports"))).toBe(false);
        expect(box.ok(["prune"], { now: NOW })).toContain("prune (dry run): 7 items would go; nothing changed");
        expect(snapshot(box)).toEqual(before);
    });

    test("--apply keeps the newest 5 results, archives old finished tasks, never touches reports", () => {
        const box = prunable();
        plan(box, ["--apply"]);
        expect(readdirSync(join(box.root, "data/jobs/daily"))).toHaveLength(5);
        expect(readdirSync(join(box.root, "data/jobs/weekly"))).toHaveLength(2);
        const backlog = JSON.parse(readFileSync(join(box.root, "data/backlog.json"), "utf8")) as {
            nextId: number;
            tasks: Task[];
        };
        expect(backlog.nextId).toBe(5);
        expect(backlog.tasks.map((entry) => entry.id)).toEqual(["T3", "T4"]);
        const archive = JSON.parse(readFileSync(join(box.root, "data/archive/tasks.json"), "utf8")) as {
            tasks: (Task & { archivedAt: string })[];
        };
        expect(archive.tasks.map((entry) => [entry.id, entry.status, entry.archivedAt])).toEqual([
            ["T1", "done", NOW],
            ["T2", "dropped", NOW],
        ]);
        expect(readFileSync(join(box.root, "data/reports/T1.md"), "utf8")).toBe("investigation");
        expect(readdirSync(join(box.root, "logs"))).toEqual(["tick.log"]);
        expect(readdirSync(join(box.root, "data/inbox")).map((name) => name.endsWith("-m2.md"))).toEqual([true]);
        expect(plan(box).items).toEqual([]);
    });

    test("retention is overridable in config/machine.json", () => {
        const box = prunable();
        put(
            box,
            "config/machine.json",
            JSON.stringify({ name: "m1", role: "coordinator", retention: { jobResultsKeep: 7, tasksDays: 365 } }),
        );
        const kinds = plan(box).items.map((item) => item.kind);
        expect(kinds.filter((kind) => kind === "job-result")).toHaveLength(1);
        expect(kinds).not.toContain("task");
    });

    test("the tick posts the dry run to the inbox once a week and deletes nothing", () => {
        const box = prunable();
        const before = snapshot(box);
        box.ok(["job", "tick"], { now: NOW });
        const titles = (): string[] =>
            (JSON.parse(box.ok(["inbox", "list", "--json"], { now: NOW })) as { title: string }[])
                .map((item) => item.title)
                .filter((title) => title.startsWith("prune dry run"));
        expect(titles()).toEqual(["prune dry run on m1: 7 items would go"]);
        const after = snapshot(box);
        for (const [file, text] of Object.entries(before)) if (file !== "logs/tick.log") expect(after[file]).toBe(text);
        box.ok(["job", "tick"], { now: new Date(Date.parse(NOW) + 3 * DAY_MS).toISOString() });
        expect(titles()).toHaveLength(1);
        box.ok(["job", "tick"], { now: new Date(Date.parse(NOW) + 8 * DAY_MS).toISOString() });
        expect(titles()).toHaveLength(2);
    });
});
