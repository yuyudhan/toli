import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox } from "./helpers.ts";

type Option = { choice: string; outcome: string };
type HeldJson = {
    id: string;
    status: string;
    question?: string;
    options?: Option[];
    recommend?: string;
    blocks?: string;
    heldAt?: string;
    notes: string[];
};
type NeedItem = {
    id: string;
    project: string;
    question: string | null;
    options: Option[];
    recommend: string | null;
    blocks: string | null;
    ageDays: number;
    stale: boolean;
    reply: string;
};
type Needs = { total: number; staleDays: number; groups: { project: string; items: NeedItem[] }[] };

const NOW = "2026-03-20T10:00:00Z";

/** Two registered projects. Tasks only need the registration, so no clones are made (keeps these tests fast). */
function twoProjects(): Sandbox {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    const project = (name: string) => ({
        name,
        url: `https://example.invalid/${name}.git`,
        mode: "commit",
        addedAt: "2026-01-01T00:00:00Z",
        workspace: "same-branch",
    });
    mkdirSync(join(box.root, "data"), { recursive: true });
    writeFileSync(
        join(box.root, "data", "projects.json"),
        JSON.stringify({ projects: [project("alpha"), project("beta")] }),
    );
    return box;
}

function task(box: Sandbox, id: string): HeldJson {
    const found = (JSON.parse(box.ok(["task", "list", "--json"])) as HeldJson[]).find((entry) => entry.id === id);
    if (!found) throw new Error(`task ${id} not listed`);
    return found;
}

function needs(box: Sandbox): Needs {
    return JSON.parse(box.ok(["needs", "--json"], { now: NOW })) as Needs;
}

/** Lines of the digest's Needs-you section (up to the first blank line). */
function needsSection(text: string): string[] {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.startsWith("Needs you ("));
    if (start < 0) throw new Error(`no Needs you section in:\n${text}`);
    const end = lines.indexOf("", start);
    return lines.slice(start, end < 0 ? undefined : end);
}

const DB_OPTIONS = [
    "--option",
    "postgres => migrate the schema today",
    "--option",
    "sqlite => ship as is, revisit later",
];

describe("task hold with options", () => {
    test("question, options, recommendation and blocks round-trip through the backlog", () => {
        const box = twoProjects();
        box.ok(["task", "add", "alpha", "pick db"]);
        box.ok(
            [
                "task",
                "hold",
                "T1",
                "--question",
                "which db?",
                ...DB_OPTIONS,
                "--recommend",
                "2",
                "--blocks",
                "T4 rollout",
            ],
            { now: "2026-03-18T09:00:00Z" },
        );
        expect(task(box, "T1")).toMatchObject({
            status: "held",
            question: "which db?",
            options: [
                { choice: "postgres", outcome: "migrate the schema today" },
                { choice: "sqlite", outcome: "ship as is, revisit later" },
            ],
            recommend: "sqlite",
            blocks: "T4 rollout",
            heldAt: "2026-03-18T09:00:00.000Z",
        });
        // Re-holding with only a question replaces every hold field (backwards compatible form).
        box.ok(["task", "hold", "T1", "--question", "still sure?"]);
        const plain = task(box, "T1");
        expect(plain.question).toBe("still sure?");
        expect(plain.options).toBeUndefined();
        expect(plain.recommend).toBeUndefined();
        expect(plain.blocks).toBeUndefined();
    });

    test("a recommendation may name the choice text; bad option counts, shapes and recommendations are refused", () => {
        const box = twoProjects();
        box.ok(["task", "add", "alpha", "pick db"]);
        box.ok(["task", "hold", "T1", "--question", "which db?", ...DB_OPTIONS, "--recommend", "Postgres"]);
        expect(task(box, "T1").recommend).toBe("postgres");
        const hold = (extra: string[]) => box.toli(["task", "hold", "T1", "--question", "q", ...extra]);
        expect(hold(["--option", "a => x"]).stderr).toContain("give 2-4 --option values, or none");
        expect(
            hold([
                "--option",
                "a => 1",
                "--option",
                "b => 2",
                "--option",
                "c => 3",
                "--option",
                "d => 4",
                "--option",
                "e => 5",
            ]).stderr,
        ).toContain("give 2-4 --option values");
        expect(hold(["--option", "a", "--option", "b => y"]).stderr).toContain('--option must be "<choice> => <what');
        expect(hold([...DB_OPTIONS, "--recommend", "3"]).stderr).toContain("--recommend must be an option's number");
        expect(hold(["--recommend", "whatever works"]).code).toBe(0);
        expect(task(box, "T1").recommend).toBe("whatever works");
    });
});

describe("toli needs", () => {
    test("groups by project; blocking holds first, then oldest; json carries ages and reply hints", () => {
        const box = twoProjects();
        for (const title of ["a1", "a2", "b1", "b2", "a3"])
            box.ok(["task", "add", title.startsWith("a") ? "alpha" : "beta", title]);
        box.ok(["task", "hold", "T1", "--question", "a1?"], { now: "2026-03-10T10:00:00Z" });
        box.ok(["task", "hold", "T2", "--question", "a2?", "--blocks", "release"], { now: "2026-03-19T10:00:00Z" });
        box.ok(["task", "hold", "T3", "--question", "b1?"], { now: "2026-03-05T10:00:00Z" });
        box.ok(["task", "hold", "T4", "--question", "b2?", ...DB_OPTIONS, "--recommend", "2"], {
            now: "2026-03-15T10:00:00Z",
        });
        // T5 stays queued: not part of the queue.

        const queue = needs(box);
        expect(queue.total).toBe(4);
        expect(queue.staleDays).toBe(7);
        expect(queue.groups.map((group) => [group.project, group.items.map((item) => item.id)])).toEqual([
            ["alpha", ["T2", "T1"]],
            ["beta", ["T3", "T4"]],
        ]);
        const [t2, t1] = queue.groups[0]?.items ?? [];
        expect(t2).toMatchObject({ blocks: "release", ageDays: 1, stale: false, reply: '"T2: <answer>"' });
        expect(t1).toMatchObject({ ageDays: 10, stale: true });
        expect(queue.groups[1]?.items[1]).toMatchObject({
            recommend: "sqlite",
            reply: '"T4: 2" (any option number, or own words)',
        });

        const text = box.ok(["needs"], { now: NOW }).split("\n");
        expect(text).toEqual([
            "Needs you (4):",
            "  alpha:",
            "    T2 a2: a2? (held 1d; blocks: release)",
            '      reply "T2: <answer>"',
            "    T1 a1: a1? (held 10d)",
            "      STALE: unanswered 10d; ask once more, or drop it: bin/toli task drop T1",
            '      reply "T1: <answer>"',
            "  beta:",
            "    T3 b1: b1? (held 15d)",
            "      STALE: unanswered 15d; ask once more, or drop it: bin/toli task drop T3",
            '      reply "T3: <answer>"',
            "    T4 b2: b2? (held 5d)",
            "      1. postgres => migrate the schema today",
            "      2. sqlite => ship as is, revisit later (recommended)",
            '      reply "T4: 2" (any option number, or own words)',
            '  record each reply verbatim: bin/toli task answer T<n> "<the user\'s words>", then dispatch it',
        ]);
    });

    test("an empty queue says so; staleDays comes from config/machine.json", () => {
        const box = twoProjects();
        expect(box.ok(["needs"])).toBe("Needs you (0):\n  nothing is waiting on the user");
        const machinePath = join(box.root, "config", "machine.json");
        const machine = JSON.parse(readFileSync(machinePath, "utf8"));
        writeFileSync(machinePath, JSON.stringify({ ...machine, needs: { staleDays: 2 } }));
        box.ok(["task", "add", "alpha", "x"]);
        box.ok(["task", "hold", "T1", "--question", "x?"], { now: "2026-03-17T10:00:00Z" });
        expect(needs(box)).toMatchObject({ staleDays: 2, groups: [{ items: [{ ageDays: 3, stale: true }] }] });
    });
});

describe("digest Needs you", () => {
    test("stale holds are re-surfaced once; a held task with no question is flagged every time", () => {
        const box = twoProjects();
        box.ok(["task", "add", "alpha", "old one"]);
        box.ok(["task", "add", "beta", "silent"]);
        box.ok(["task", "hold", "T1", "--question", "keep it?", ...DB_OPTIONS], { now: "2026-03-01T10:00:00Z" });
        box.ok(["task", "hold", "T2", "--question", "placeholder"], { now: "2026-03-19T10:00:00Z" });
        // Older data or a hand edit can leave a hold without its question.
        const backlogPath = join(box.root, "data", "backlog.json");
        const backlog = JSON.parse(readFileSync(backlogPath, "utf8")) as { tasks: HeldJson[] };
        for (const entry of backlog.tasks) if (entry.id === "T2") delete entry.question;
        writeFileSync(backlogPath, JSON.stringify(backlog));

        const first = needsSection(box.ok(["digest"], { now: NOW }));
        expect(first).toEqual([
            "Needs you (2):",
            "  alpha:",
            "    T1 old one: keep it? (held 19d)",
            "      1. postgres => migrate the schema today",
            "      2. sqlite => ship as is, revisit later",
            "      STALE: unanswered 19d; ask once more, or drop it: bin/toli task drop T1",
            '      reply "T1: 1" (any option number, or own words)',
            "  beta:",
            "    T2 silent (held 1d)",
            '      BUG: held with no question; ask its jawan or re-hold: bin/toli task hold T2 --question "..." --option "<choice> => <then>"',
            '  record each reply verbatim: bin/toli task answer T<n> "<the user\'s words>", then dispatch it',
        ]);
        const second = needsSection(box.ok(["digest"], { now: NOW }));
        expect(second.some((line) => line.includes("STALE"))).toBe(false);
        expect(second.some((line) => line.includes("BUG: held with no question"))).toBe(true);

        const digest = JSON.parse(box.ok(["digest", "--json"], { now: NOW })) as {
            needs: Needs;
            next: { action: string }[];
        };
        expect(digest.needs.total).toBe(2);
        expect(digest.next.map((action) => action.action)).toContain(
            "T2 (beta) is held with no question, so the user cannot answer it",
        );

        // Re-holding starts a new hold: it can be re-surfaced again once it goes stale.
        box.ok(["task", "hold", "T1", "--question", "keep it now?"], { now: "2026-03-01T10:00:00Z" });
        expect(needsSection(box.ok(["digest"], { now: NOW })).some((line) => line.includes("STALE"))).toBe(true);
    });

    test("two or more questions become one batched Next action", () => {
        const box = twoProjects();
        box.ok(["task", "add", "alpha", "a"]);
        box.ok(["task", "add", "beta", "b"]);
        box.ok(["task", "hold", "T1", "--question", "a?"]);
        box.ok(["task", "hold", "T2", "--question", "b?"]);
        const digest = JSON.parse(box.ok(["digest", "--json"])) as { next: { action: string }[] };
        const asks = digest.next.filter((action) => action.action.startsWith("Ask the user"));
        expect(asks.map((action) => action.action)).toEqual([
            "Ask the user the 2 Needs-you questions together as one numbered list (T1, T2)",
        ]);
    });
});

describe("task answer", () => {
    test("records the verbatim answer with the options to decisions.md and prints the unblocked hint", () => {
        const box = twoProjects();
        box.ok(["task", "add", "alpha", "pick db"]);
        box.ok(["task", "hold", "T1", "--question", "which db?", ...DB_OPTIONS, "--recommend", "1"]);
        const printed = box.ok(["task", "answer", "T1", "2"], { now: NOW }).split("\n");
        expect(printed[0]).toStartWith("T1\tqueued\talpha\tship\tpick db");
        expect(printed[1]).toStartWith("unblocked: dispatch T1 now");
        expect(task(box, "T1").notes).toEqual(["Q: which db?\nA: 2 (= sqlite)"]);
        expect(readFileSync(join(box.root, "data", "projects", "alpha", "decisions.md"), "utf8")).toBe(
            [
                "# alpha decisions",
                "",
                "## 2026-03-20 T1: pick db",
                "",
                "- Q: which db?",
                "- Options: 1. postgres => migrate the schema today; 2. sqlite => ship as is, revisit later",
                "- Recommended: postgres",
                "- A: 2",
                "- Chosen: sqlite => ship as is, revisit later",
                "",
            ].join("\n"),
        );
        expect(needs(box).total).toBe(0);
    });
});
