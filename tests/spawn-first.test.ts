// `bin/toli spawn --first`: a run queued ahead of the runs queued without it, first-in first-out among such runs. It
// only reorders the queue: a running run is never stopped, and a `--first` run still waits for the network hold and its
// earliest start (`notBefore`).
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox } from "./helpers.ts";

type Run = {
    id: string;
    status: string;
    signal: string | null;
    error: string | null;
    inbox: string | null;
    startedAt: string;
    endedAt: string | null;
    first?: boolean;
    resumeOf?: string;
    notBefore?: string;
};

function coordinator(maxRuns: number): Sandbox {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    const file = join(box.root, "config", "machine.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), capacity: { maxRuns } }));
    return box;
}

function brief(box: Sandbox, body: string): string {
    const path = join(box.root, `brief-${body}.md`);
    writeFileSync(path, `TOLI_BRIEF v1\n${body}\n`);
    return path;
}

function spawnJson(box: Sandbox, body: string, extra: string[] = []): Run {
    return JSON.parse(
        box.ok(["spawn", "--harness", "omp", "--cwd", box.root, "--brief", brief(box, body), ...extra, "--json"]),
    ) as Run;
}

function runs(box: Sandbox): Run[] {
    return JSON.parse(box.ok(["runs", "--json"])) as Run[];
}

/** Poll until `done` holds; supervisors and harnesses are detached processes, so real time is unavoidable. */
async function waitForRuns(box: Sandbox, done: (all: Run[]) => boolean): Promise<Run[]> {
    for (let attempt = 0; attempt < 300; attempt++) {
        const all = runs(box);
        if (done(all)) return all;
        await Bun.sleep(100);
    }
    throw new Error(`runs never reached the expected state: ${box.ok(["runs"])}`);
}

/** The `bin/toli runs` line of `id`, split into its tab-separated columns. */
function columns(box: Sandbox, id: string): string[] {
    return (
        box
            .ok(["runs"])
            .split("\n")
            .find((line) => line.startsWith(`${id}\t`))
            ?.split("\t") ?? []
    );
}

describe("spawn --first", () => {
    test("a --first run starts before older queued runs, two keep their order, and the running run is untouched", async () => {
        const box = coordinator(1);
        const release = join(box.root, "release");
        // Holds its slot until `release` exists, however slowly the next spawns run under load.
        box.stub("omp", `until [ -f "${release}" ]; do sleep 0.1; done; echo finished`);
        const running = spawnJson(box, "running");
        expect(["starting", "running"]).toContain(running.status);
        const older = spawnJson(box, "older");
        const old = spawnJson(box, "old");
        const text = box.ok([
            "spawn",
            "--harness",
            "omp",
            "--cwd",
            box.root,
            "--brief",
            brief(box, "urgent"),
            "--first",
        ]);
        expect(text).toStartWith("queued ");
        expect(text).toContain("--first: it starts ahead of the runs queued without it");
        const urgent = runs(box).find((run) => run.status === "queued" && run.first === true)?.id ?? "";
        const later = spawnJson(box, "later", ["--first"]);
        expect(later.status).toBe("queued");
        expect(later.first).toBe(true);
        expect(older.first).toBeUndefined();

        // `bin/toli runs` shows the order the queue starts in.
        expect(columns(box, urgent).slice(1, 2)).toEqual(["queued"]);
        expect(columns(box, urgent).at(-1)).toBe("queue 1 (--first)");
        expect(columns(box, later.id).at(-1)).toBe("queue 2 (--first)");
        expect(columns(box, older.id).at(-1)).toBe("queue 3");
        expect(columns(box, old.id).at(-1)).toBe("queue 4");
        expect(columns(box, running.id)).toHaveLength(6);

        // Nothing stopped the running run.
        const still = runs(box).find((run) => run.id === running.id);
        expect(["starting", "running"]).toContain(still?.status ?? "");
        expect(still?.signal).toBeNull();
        writeFileSync(release, "");

        const all = await waitForRuns(box, (list) => list.length === 5 && list.every((run) => run.inbox !== null));
        expect(all.every((run) => run.status === "done")).toBe(true);
        const started = [...all].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map((run) => run.id);
        expect(started).toEqual([running.id, urgent, later.id, older.id, old.id]);
        // One slot: each starts only after the one before it ended.
        const byId = new Map(all.map((run) => [run.id, run]));
        for (let index = 1; index < started.length; index++)
            expect(Date.parse(byId.get(started[index] ?? "")?.startedAt ?? "")).toBeGreaterThanOrEqual(
                Date.parse(byId.get(started[index - 1] ?? "")?.endedAt ?? ""),
            );
    }, 60_000);

    test("a --first run still waits for the network hold", async () => {
        const box = coordinator(2);
        box.stub("omp", "echo finished");
        const faultPath = join(box.root, "state", "network-fault.json");
        writeFileSync(
            faultPath,
            JSON.stringify({ host: "api.example.invalid", code: "EAI_AGAIN", since: "2026-11-21T00:00:00.000Z" }),
        );
        const text = box.ok([
            "spawn",
            "--harness",
            "omp",
            "--cwd",
            box.root,
            "--brief",
            brief(box, "urgent"),
            "--first",
        ]);
        expect(text).toContain("the model API host api.example.invalid does not resolve; it starts once it does");
        box.ok(["job", "tick"]);
        const [held] = runs(box);
        expect(held?.status).toBe("queued");
        expect(held?.first).toBe(true);

        // The network is back: the recorded host resolves now.
        writeFileSync(faultPath, JSON.stringify({ ...JSON.parse(readFileSync(faultPath, "utf8")), host: "localhost" }));
        box.ok(["job", "tick"]);
        const [done] = await waitForRuns(box, (list) => list.every((run) => run.inbox !== null));
        expect(done?.status).toBe("done");
    }, 60_000);

    test("a --first run's network-fault requeue stays first and still waits for its notBefore", async () => {
        const box = coordinator(4);
        const resumes = join(box.root, ".omp-resumes");
        // Every fresh run and the first resume die as omp does when the model API name does not resolve.
        box.stub(
            "omp",
            [
                'dir=""; resume=""; prev=""',
                'for arg in "$@"; do',
                '    case "$prev" in --session-dir) dir="$arg" ;; --resume) resume="$arg" ;; esac',
                '    prev="$arg"',
                "done",
                "cat >/dev/null",
                'if [ -n "$resume" ]; then',
                `    count=$(cat "${resumes}" 2>/dev/null || echo 0); echo $((count + 1)) > "${resumes}"`,
                '    if [ "$count" -ge 1 ]; then echo "Jane, the work is done and committed as abc123."; exit 0; fi',
                "else",
                '    echo "{}" > "$dir/s1.jsonl"',
                "fi",
                'echo "Retry budget exhausted after 3 retries: getaddrinfo EAI_AGAIN localhost" >&2',
                "exit 1",
            ].join("\n"),
        );
        const first = spawnJson(box, "urgent", ["--first"]);
        // The first requeue starts at once and fails the same way; the next waits 10 minutes from its start.
        const [third, second] = await waitForRuns(
            box,
            (all) => all.length === 3 && all.filter((run) => run.inbox !== null).length === 2,
        );
        expect(second?.resumeOf).toBe(first.id);
        expect(second?.first).toBe(true);
        expect(third?.resumeOf).toBe(second?.id);
        expect(third?.first).toBe(true);
        expect(third?.status).toBe("queued");
        expect(third?.notBefore).toBe(new Date(Date.parse(second?.startedAt ?? "") + 10 * 60_000).toISOString());
        box.ok(["job", "tick"]);
        expect(runs(box).find((run) => run.id === third?.id)?.status).toBe("queued");

        box.ok(["job", "tick"], { now: new Date(Date.parse(third?.notBefore ?? "") + 60_000).toISOString() });
        const all = await waitForRuns(box, (list) => list.every((run) => run.inbox !== null));
        expect(all.find((run) => run.id === third?.id)?.status).toBe("done");
    }, 60_000);
});
