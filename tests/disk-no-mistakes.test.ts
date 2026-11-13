// The disk keeper and the low-disk alert on build output no-mistakes runs leave in their worktrees (T1294): a finished
// run's target goes, a running run's stays, data beside it stays, and root-owned files go through a throwaway
// container, never sudo.
import { Database } from "bun:sqlite";
import { describe, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeepReport } from "../src/fleet/disk.ts";
import { dfLine, keeperBox, keeperTest, setCapacity } from "./disk-fixture.ts";
import type { Sandbox } from "./helpers.ts";

type Run = { id: string; status: string };

/**
 * A gate worktree at `tree`: a git checkout with a tracked source, an ignored `docker-data/` holding a compose stack's
 * cargo target (`backend/target`, marked by cargo's CACHEDIR.TAG), a database's files and an unmarked
 * `uploads/target`. Returns its resolved path.
 */
function gateTree(box: Sandbox, tree: string): string {
    mkdirSync(join(tree, "src"), { recursive: true });
    box.git(tree, ["init", "-q"]);
    writeFileSync(join(tree, ".gitignore"), "docker-data/\n");
    writeFileSync(join(tree, "src", "main.rs"), "fn main() {}\n");
    box.git(tree, ["add", ".gitignore", "src/main.rs"]);
    box.git(tree, ["commit", "-q", "-m", "gate"]);
    const target = join(tree, "docker-data", "backend", "target");
    mkdirSync(join(target, "debug", "deps"), { recursive: true });
    writeFileSync(join(target, "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
    writeFileSync(join(target, "debug", ".cargo-lock"), "");
    writeFileSync(join(target, "debug", "deps", "libx.rlib"), "x".repeat(4096));
    mkdirSync(join(tree, "docker-data", "postgres"), { recursive: true });
    writeFileSync(join(tree, "docker-data", "postgres", "PG_VERSION"), "16\n");
    mkdirSync(join(tree, "docker-data", "uploads", "target"), { recursive: true });
    writeFileSync(join(tree, "docker-data", "uploads", "target", "report.pdf"), "user data\n");
    return realpathSync(tree);
}

/**
 * A no-mistakes home in the sandbox (NM_HOME, set by the sandbox) with one gate worktree per run and the state
 * database naming each run's status. `orphans` are worktrees no run record names. Returns each worktree's resolved
 * path by run id.
 */
function noMistakes(box: Sandbox, runs: Run[], orphans: string[] = []): Map<string, string> {
    const home = join(box.root, ".no-mistakes");
    const trees = new Map<string, string>();
    for (const id of [...runs.map((entry) => entry.id), ...orphans])
        trees.set(id, gateTree(box, join(home, "worktrees", "repo1", id)));
    const db = new Database(join(home, "state.sqlite"), { create: true });
    db.run("CREATE TABLE runs (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, worktree_dir TEXT, status TEXT NOT NULL)");
    for (const entry of runs) db.run("INSERT INTO runs VALUES (?, 'repo1', NULL, ?)", [entry.id, entry.status]);
    db.close();
    return trees;
}

const backendTarget = (tree: string): string => join(tree, "docker-data", "backend", "target");

/** A sandbox at 1 GB free of 200 GB (floor 50, under the emergency level), so the keeper visits every folder. */
function fullDisk(): Sandbox {
    const box = keeperBox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    box.stub("docker", "exit 1");
    box.stub("sccache", "exit 2");
    box.stub("df", `kb=1048576\n${dfLine(200)}`);
    return box;
}

function keep(box: Sandbox, args: string[]): KeepReport {
    const options = { env: { TOLI_DRY_RUN: "0" } };
    return JSON.parse(box.ok(["disk", "keep", "--floor", "50", ...args, "--json"], options)) as KeepReport;
}

describe("the disk keeper in no-mistakes run worktrees", () => {
    keeperTest("frees a finished run's target, keeps a running or unrecorded run's and every non-target folder", () => {
        const box = fullDisk();
        const trees = noMistakes(
            box,
            [
                { id: "a-running", status: "running" },
                { id: "b-done", status: "completed" },
            ],
            ["c-orphan"],
        );
        const running = trees.get("a-running") ?? "";
        const done = trees.get("b-done") ?? "";
        const orphan = trees.get("c-orphan") ?? "";

        const plan = keep(box, ["--dry-run"]).lines.join("\n");
        expect(plan).toContain(`would delete ${backendTarget(done)} (`);
        expect(plan).toContain("step 1: finished no-mistakes run's target)");
        expect(plan).toContain(`skipped ${backendTarget(running)}: no-mistakes run a-running is running`);
        expect(existsSync(backendTarget(done))).toBe(true);

        const lines = keep(box, []).lines.join("\n");
        expect(lines).toContain(`deleted ${backendTarget(done)}, freed `);
        expect(lines).toContain(`skipped ${backendTarget(running)}: no-mistakes run a-running is running`);
        expect(lines).toContain(`skipped ${backendTarget(orphan)}: no no-mistakes run record names it`);
        expect(existsSync(backendTarget(done))).toBe(false);
        for (const tree of [running, orphan])
            expect(existsSync(join(backendTarget(tree), "debug", "deps", "libx.rlib"))).toBe(true);
        for (const tree of [running, done, orphan]) {
            expect(existsSync(join(tree, "docker-data", "postgres", "PG_VERSION"))).toBe(true);
            expect(existsSync(join(tree, "docker-data", "uploads", "target", "report.pdf"))).toBe(true);
            expect(existsSync(join(tree, "src", "main.rs"))).toBe(true);
        }
    });

    keeperTest("never frees a finished run's worktree outside $NM_HOME/worktrees", () => {
        const box = fullDisk();
        const done = noMistakes(box, [{ id: "b-done", status: "completed" }]).get("b-done") ?? "";
        const outside = gateTree(box, join(box.root, "elsewhere", "e-done"));
        const db = new Database(join(box.root, ".no-mistakes", "state.sqlite"));
        db.run("INSERT INTO runs VALUES ('e-done', 'repo1', ?, 'completed')", [outside]);
        db.close();

        const lines = keep(box, []).lines.join("\n");
        expect(lines).toContain(`deleted ${backendTarget(done)}, freed `);
        expect(lines).not.toContain(outside);
        expect(existsSync(join(backendTarget(outside), "debug", "deps", "libx.rlib"))).toBe(true);
    });

    keeperTest("keeps every run's output when no-mistakes' state cannot be read", () => {
        const box = fullDisk();
        const done = noMistakes(box, [{ id: "b-done", status: "completed" }]).get("b-done") ?? "";
        writeFileSync(join(box.root, ".no-mistakes", "state.sqlite"), "not a database\n".repeat(64));

        const lines = keep(box, []).lines.join("\n");
        expect(lines).toContain(`skipped ${backendTarget(done)}: no-mistakes state unreadable (`);
        expect(existsSync(join(backendTarget(done), "debug", "deps", "libx.rlib"))).toBe(true);
    });

    keeperTest("removes a finished run's root-owned target from a throwaway container, never with sudo", () => {
        const box = fullDisk();
        const done = noMistakes(box, [{ id: "b-done", status: "failed" }]).get("b-done") ?? "";
        const target = backendTarget(done);
        const calls = join(box.root, "docker.calls");
        // Docker answers and runs no container; `docker run` removes what it is asked to, as root would.
        box.stub(
            "docker",
            `printf '%s\\n' "$*" >> "${calls}"
case "$1" in
info) echo 29 ;;
ps | volume | system) exit 0 ;;
run)
    src=""; last=""
    for arg in "$@"; do
        case "$arg" in type=bind,source=*) src="\${arg#type=bind,source=}"; src="\${src%%,target=*}" ;; esac
        last="$arg"
    done
    chmod -R u+w "$src/\${last#/toli-parent/}" && rm -rf "$src/\${last#/toli-parent/}" ;;
*) echo "Total reclaimed space: 0B" ;;
esac`,
        );
        const sudo = join(box.root, "sudo.calls");
        box.stub("sudo", `printf '%s\\n' "$*" >> "${sudo}"; exit 1`);
        // Files this account cannot delete, as a container running as root leaves them.
        const deps = join(target, "debug", "deps");
        chmodSync(deps, 0o555);
        try {
            const lines = keep(box, []).lines.join("\n");
            expect(lines).toContain(`deleted ${target}, freed `);
            expect(existsSync(target)).toBe(false);
            const run = readFileSync(calls, "utf8")
                .split("\n")
                .find((call) => call.startsWith("run "));
            expect(run).toBe(
                `run --rm --network none --user 0:0 --mount type=bind,source=${join(done, "docker-data", "backend")},target=/toli-parent --entrypoint rm busybox:latest -rf /toli-parent/target`,
            );
            expect(existsSync(sudo)).toBe(false);
            expect(existsSync(join(done, "docker-data", "postgres", "PG_VERSION"))).toBe(true);
        } finally {
            if (existsSync(deps)) chmodSync(deps, 0o755);
        }
    });

    keeperTest("keeps a root-owned target when docker cannot remove it, and says why", () => {
        const box = fullDisk();
        const done = noMistakes(box, [{ id: "b-done", status: "completed" }]).get("b-done") ?? "";
        const target = backendTarget(done);
        const deps = join(target, "debug", "deps");
        chmodSync(deps, 0o555);
        try {
            const lines = keep(box, []).lines.join("\n");
            expect(lines).toContain(
                `kept ${target}: it holds root-owned files, and docker is not reachable to remove them (never sudo)`,
            );
            expect(existsSync(deps)).toBe(true);
        } finally {
            chmodSync(deps, 0o755);
        }
    });

    keeperTest("the low-disk alert names a run worktree's build output with its run and status", () => {
        const box = fullDisk();
        const done = noMistakes(box, [{ id: "b-done", status: "completed" }]).get("b-done") ?? "";
        setCapacity(box, { diskKeepGB: 20, diskKeep: false });
        box.ok(["disk", "alert"], { env: { TOLI_DRY_RUN: "0" } });
        const item = box
            .ok(["inbox", "list"])
            .split("\n")
            .find((line) => line.includes("disk low on m1"));
        const body = readFileSync(item?.split("\t").at(-1) ?? "", "utf8");
        expect(body).toContain(`${backendTarget(done)} (no-mistakes run b-done, completed)`);
        expect(existsSync(backendTarget(done))).toBe(true);
    });
});
