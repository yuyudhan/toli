import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pushLine } from "../src/records/push-log.ts";
import { type Sandbox, sandbox, withProject } from "./helpers.ts";

// Each test builds a project with origin plus up to a dozen bin/toli runs; on a loaded machine one test has taken
// close to 30 s, so allow 60 s.
setDefaultTimeout(60_000);

type Push = {
    at: string;
    machine: string;
    project: string;
    branch: string;
    old: string | null;
    new: string;
    by: string;
    task: string | null;
    word: string | null;
};

/**
 * A worker "mini" with project "app" on a new local branch "feature" one commit ahead of origin/main. "app" has a
 * standing push grant on mini, so a push needs no `--word`.
 */
function mini(): { box: Sandbox; dir: string } {
    const box = sandbox();
    box.ok(["init", "--name", "mini", "--role", "worker", "--coordinator-ssh", "mac", "--coordinator-root", "/r"]);
    const dir = withProject(box, "app");
    box.ok(["project", "set", "app", "--standing-push", "yes"]);
    box.git(dir, ["switch", "-c", "feature"]);
    commitFile(box, dir, "a.txt");
    return { box, dir };
}

function commitFile(box: Sandbox, dir: string, name: string): string {
    writeFileSync(join(dir, name), `${name}\n`);
    box.git(dir, ["add", name]);
    box.git(dir, ["commit", "-m", `add ${name}`]);
    return box.git(dir, ["rev-parse", "HEAD"]);
}

function pushes(box: Sandbox): Push[] {
    return JSON.parse(box.ok(["push-log", "list", "--json"]));
}

const AT = "2026-11-02T07:32:53.000Z";

describe("push log", () => {
    test("a push for another machine is logged here with its range, task and quoted word, and the digest shows it", () => {
        const { box, dir } = mini();
        const first = box.git(dir, ["rev-parse", "HEAD"]);
        const word = "yes pls. mini push";
        const pushed = box.ok(["push", "app", "--by", "mac", "--for", "T118", "--word", word], { now: AT });
        expect(pushed).toContain(`push log: ${AT} app feature (new)..${first.slice(0, 9)} for mac T118`);
        const second = commitFile(box, dir, "b.txt");
        box.ok(["push", "app", "--by", "mac", "--for", "T118", "--word", word], { now: AT });
        // Nothing new on origin: a repeated push records nothing.
        expect(box.ok(["push", "app"], { now: AT })).toContain("push log: nothing new on origin/feature");

        expect(pushes(box)).toEqual([
            {
                at: AT,
                machine: "mini",
                project: "app",
                branch: "feature",
                old: null,
                new: first,
                by: "mac",
                task: "T118",
                word,
            },
            {
                at: AT,
                machine: "mini",
                project: "app",
                branch: "feature",
                old: first,
                new: second,
                by: "mac",
                task: "T118",
                word,
            },
        ]);
        const digest = box.ok(["digest"], { now: "2026-11-03T00:00:00.000Z" });
        expect(digest).toContain("recent pushes (2):");
        expect(digest).toContain(
            `  ${AT} app feature ${first.slice(0, 9)}..${second.slice(0, 9)} for mac T118, word: "${word}"`,
        );
        const json = JSON.parse(box.ok(["digest", "--json"], { now: "2026-11-03T00:00:00.000Z" }));
        expect(json.pushes.map((entry: Push) => entry.new)).toEqual([second, first]);
        // A week later the pushes leave the digest but stay in the log.
        expect(box.ok(["digest"], { now: "2026-11-10T00:00:00.000Z" })).toContain("recent pushes (0):");
        expect(pushes(box)).toHaveLength(2);
    });

    test("a local push is logged as by this machine, with no task or word", () => {
        const { box } = mini();
        box.ok(["push", "app"], { now: AT });
        const [entry] = pushes(box);
        expect(entry).toMatchObject({ machine: "mini", by: "mini", task: null, word: null });
        expect(box.ok(["push-log", "list"])).toContain(" app feature (new)..");
        expect(box.ok(["push-log", "list"])).toContain(" by mini");
    });

    test("a push inside a bin/toli exec run takes the issuing machine and task from the environment", () => {
        const { box, dir } = mini();
        const env = { TOLI_ISSUED_BY: "mac", TOLI_ISSUED_TASK: "T110" };
        box.ok(["push", "app"], { now: AT, env });
        expect(pushes(box)[0]).toMatchObject({ machine: "mini", by: "mac", task: "T110" });
        commitFile(box, dir, "b.txt");
        box.ok(["push", "app", "--for", "T9"], { env });
        expect(pushes(box)[1]).toMatchObject({ by: "mac", task: "T9" });
        expect(box.toli(["push", "app", "--by", "../evil"]).stderr).toContain('invalid machine name "../evil"');
    });

    test("push-log add records a raw git push from origin's tracking ref and its reflog", () => {
        const { box, dir } = mini();
        expect(box.toli(["push-log", "add", "app"]).stderr).toContain("origin/feature is not known");
        box.git(dir, ["push", "-u", "origin", "feature"]);
        const first = box.git(dir, ["rev-parse", "HEAD"]);
        box.ok(["push-log", "add", "app", "--by", "mac", "--for", "T110", "--word", "Yes, push it."], { now: AT });
        const second = commitFile(box, dir, "b.txt");
        box.git(dir, ["push", "--no-verify", "origin", "feature"]);
        box.ok(["push-log", "add", "app", "--by", "mac", "--for", "T118"], { now: AT });
        expect(pushes(box).map(({ old, new: after, by, task, word }) => ({ old, after, by, task, word }))).toEqual([
            { old: null, after: first, by: "mac", task: "T110", word: "Yes, push it." },
            { old: first, after: second, by: "mac", task: "T118", word: null },
        ]);

        box.git(dir, ["checkout", "--detach"]);
        expect(box.toli(["push-log", "add", "app"]).stderr).toContain("detached HEAD: pass --branch");
        box.ok(["push-log", "add", "app", "--branch", "feature", "--old", first, "--new", "feature"]);
        expect(pushes(box)[2]).toMatchObject({ branch: "feature", old: first, new: second, by: "mini" });
        expect(box.toli(["push-log", "add", "app", "--branch", "feature", "--old", "nope"]).stderr).toContain(
            "--old nope is not a commit",
        );
        expect(box.toli(["push-log", "add", "ghost"]).stderr).toContain('unknown project "ghost"');
        expect(box.toli(["push-log", "nope"]).stderr).toContain("usage: toli push-log add|list|remove");
    });

    test("push-log add toli records a push of toli's own checkout", () => {
        const { box } = mini();
        const origin = join(box.root, ".toli-origin.git");
        box.git(box.root, ["init", "--bare", "--initial-branch=main", origin]);
        box.git(box.root, ["init", "--initial-branch=main"]);
        box.git(box.root, ["commit", "--allow-empty", "-m", "toli"]);
        box.git(box.root, ["remote", "add", "origin", origin]);
        box.git(box.root, ["push", "--no-verify", "origin", "main"]);
        const head = box.git(box.root, ["rev-parse", "HEAD"]);
        box.ok(["push-log", "add", "toli", "--by", "mac", "--word", "yes"], { now: AT });
        expect(pushes(box)[0]).toMatchObject({ project: "toli", branch: "main", new: head, by: "mac", word: "yes" });
    });

    test("push-log add refuses a branch origin's tracking ref did not get from a push, naming --branch", () => {
        const { box, dir } = mini();
        const origin = join(box.root, ".origin", "app.git");
        const other = join(box.root, "other");
        box.git(box.root, ["clone", origin, other]);
        commitFile(box, other, "o.txt");
        box.git(other, ["push", "--no-verify", "origin", "main"]);
        // origin/main moves by a fetch here; the push from this clone is a raw refspec to another branch.
        box.git(dir, ["fetch", "origin"]);
        box.git(dir, ["switch", "main"]);
        box.git(dir, ["merge", "--ff-only", "origin/main"]);
        const feature = box.git(dir, ["rev-parse", "feature"]);
        box.git(dir, ["push", "--no-verify", "origin", `${feature}:refs/heads/idx/feature`]);
        for (const argv of [
            ["push-log", "add", "app"],
            ["push-log", "add", "app", "--branch", "main"],
        ]) {
            const refused = box.toli(argv).stderr;
            expect(refused).toContain("origin/main was last updated by a fetch, not a push from");
            expect(refused).toContain("pass --branch <the branch you pushed>");
        }
        expect(pushes(box)).toEqual([]);
        box.ok(["push-log", "add", "app", "--branch", "idx/feature", "--for", "T2811"], { now: AT });
        expect(pushes(box)).toMatchObject([{ branch: "idx/feature", old: null, new: feature, task: "T2811" }]);

        // A logged tip that is no longer origin's branch head is refused, --new or not.
        box.git(other, ["fetch", "origin"]);
        box.git(other, ["switch", "-c", "idx/feature", "origin/idx/feature"]);
        const moved = commitFile(box, other, "p.txt");
        box.git(other, ["push", "--no-verify", "origin", "idx/feature"]);
        expect(box.toli(["push-log", "add", "app", "--branch", "idx/feature"]).stderr).toContain(
            `origin's idx/feature is at ${moved.slice(0, 9)}, not ${feature.slice(0, 9)}`,
        );
        expect(box.toli(["push-log", "add", "app", "--branch", "idx/feature", "--new", feature]).stderr).toContain(
            `origin's idx/feature is at ${moved.slice(0, 9)}`,
        );
        expect(pushes(box)).toHaveLength(1);
    });

    test("push-log remove drops a wrong entry by its number in push-log list", () => {
        const { box, dir } = mini();
        box.ok(["push", "app"], { now: AT });
        commitFile(box, dir, "b.txt");
        box.ok(["push", "app"], { now: AT });
        appendFileSync(join(box.root, "data", "pushes.jsonl"), '{"at":"2026-11-02T0\n');
        const [first, second] = pushes(box) as [Push, Push];
        expect(box.ok(["push-log", "list"])).toContain(`2. ${pushLine(second)}`);
        expect(box.ok(["push-log", "remove", "1"])).toBe(`push log: removed 1. ${pushLine(first)}`);
        expect(pushes(box)).toEqual([second]);
        expect(box.ok(["push-log", "list"])).toBe(`1. ${pushLine(second)}`);
        expect(box.toli(["push-log", "remove", "2"]).stderr).toContain("no push #2 in the log (1 entry)");
        expect(box.toli(["push-log", "remove", "x"]).stderr).toContain("push-log remove <n>");
    });

    test("an empty log reads as empty and a torn line is skipped", () => {
        const { box } = mini();
        expect(box.ok(["push-log", "list"])).toBe("push log: empty");
        box.ok(["push", "app"], { now: AT });
        appendFileSync(join(box.root, "data", "pushes.jsonl"), '{"at":"2026-11-02T0\n{"not":"a push"}\n');
        expect(pushes(box)).toHaveLength(1);
        expect(box.ok(["digest"], { now: AT })).toContain("recent pushes (1):");
    });
});
