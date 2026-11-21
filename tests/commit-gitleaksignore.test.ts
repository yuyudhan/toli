// T2209: the staged-set gitleaks scan of `bin/toli commit` honours the repository's .gitleaksignore. A history scan
// fingerprints a finding as <commit>:<file>:<rule>:<line>, which gitleaks never matches in a staged scan (no commit),
// so a merge bringing an already-ignored sample key was refused while `gitleaks git` over the same range found none.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeCommit } from "../src/projects/commit.ts";
import { git, head, repo, useGitEnv } from "./commit-fixture.ts";
import { tempDir } from "./helpers.ts";

// Real repos and gitleaks scans (see commit.test.ts).
setDefaultTimeout(180_000);
useGitEnv();

/** A random GitHub token shape, generated per run, that gitleaks' github-pat rule matches on its own. */
function token(): string {
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    return `ghp_${Array.from(crypto.getRandomValues(new Uint8Array(36)), (byte) => alphabet[byte % 62]).join("")}`;
}

/** A finding of a history scan, as gitleaks' JSON report lists it. */
type HistoryLeak = { Fingerprint: string };

/** The fingerprints `gitleaks git` reports over `dir`'s history, as it writes them for .gitleaksignore. */
function historyFingerprints(dir: string): string[] {
    const report = join(tempDir("gitleaks-report"), "report.json");
    const scan = Bun.spawnSync(
        ["gitleaks", "git", "--no-banner", "--log-level", "error", "--report-format", "json", "--report-path", report],
        { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    expect(scan.exitCode).toBe(1);
    const leaks = JSON.parse(readFileSync(report, "utf8")) as HistoryLeak[];
    return leaks.map((leak) => leak.Fingerprint);
}

/** The message `land` throws (it must throw). */
function refusal(land: () => unknown): string {
    try {
        land();
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected a refusal, but the commit landed");
}

/**
 * main, and branch `samples` adding samples/key.txt with a sample key, then a commit that moves it a line down (so the
 * ignored text no longer sits on the fingerprinted line). main gets its own commit and a .gitleaksignore with the
 * history scan's fingerprint. Returns the checkout on main and the tip of `samples`.
 */
function ignoredSample(): { dir: string; samples: string } {
    const dir = repo({ "app.txt": "app\n" });
    git(dir, ["switch", "--quiet", "-c", "samples"]);
    mkdirSync(join(dir, "samples"));
    writeFileSync(join(dir, "samples", "key.txt"), `${token()}\n`);
    git(dir, ["add", "--all"]);
    git(dir, ["commit", "--quiet", "-m", "samples: a fake key for the parser tests"]);
    const fingerprints = historyFingerprints(dir);
    expect(fingerprints).toHaveLength(1);
    expect(fingerprints[0]).toMatch(/^[0-9a-f]{40}:samples\/key\.txt:github-pat:1$/);
    const key = readFileSync(join(dir, "samples", "key.txt"), "utf8");
    writeFileSync(join(dir, "samples", "key.txt"), `# fake, for tests\n${key}`);
    git(dir, ["commit", "--quiet", "-am", "samples: say it is fake"]);
    const samples = head(dir);
    git(dir, ["switch", "--quiet", "main"]);
    writeFileSync(join(dir, ".gitleaksignore"), `${fingerprints.join("\n")}\n`);
    writeFileSync(join(dir, "app.txt"), "app on main\n");
    git(dir, ["add", "--all"]);
    git(dir, ["commit", "--quiet", "-m", "main: ignore the sample key"]);
    return { dir, samples };
}

/** Commit `files` on the checkout's current branch; returns the new tip. */
function commitFiles(dir: string, files: Record<string, string>, message: string): string {
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(dir, name, ".."), { recursive: true });
        writeFileSync(join(dir, name), text);
    }
    git(dir, ["add", "--all"]);
    git(dir, ["commit", "--quiet", "-m", message]);
    return head(dir);
}

/** A plain `<file>:<rule>:<line>` entry, as a scan without git history writes it, for the sample key. */
const PLAIN_ENTRY = "samples/key.txt:github-pat:1\n";

describe("bin/toli commit's staged gitleaks scan and .gitleaksignore", () => {
    test("a merge staging a key .gitleaksignore fingerprints by commit is accepted", () => {
        const { dir, samples } = ignoredSample();
        const before = head(dir);
        const merged = safeCommit({ dir, paths: [], merge: samples, message: "Merge samples" });
        expect(git(dir, ["rev-list", "--parents", "-n", "1", merged.sha]).split(" ")).toEqual([
            merged.sha,
            before,
            samples,
        ]);
        expect(git(dir, ["show", `${merged.sha}:samples/key.txt`])).toContain("ghp_");
    });

    test("an un-ignored key in the same merge, or a new key in the ignored file, is still refused", () => {
        const { dir, samples } = ignoredSample();
        const before = head(dir);
        git(dir, ["switch", "--quiet", "samples"]);
        writeFileSync(join(dir, "config.txt"), `${token()}\n`);
        git(dir, ["add", "config.txt"]);
        git(dir, ["commit", "--quiet", "-m", "config: a real-looking key"]);
        const leaky = head(dir);
        git(dir, ["switch", "--quiet", "main"]);
        const message = refusal(() => safeCommit({ dir, paths: [], merge: leaky, message: "Merge samples" }));
        expect(message).toContain("gitleaks found a secret");
        expect(message).toContain("config.txt:1: github-pat");
        expect(message).not.toContain("samples/key.txt");
        expect(head(dir)).toBe(before);

        // Another key put where the ignored one was: same file, rule and line, different text.
        git(dir, ["switch", "--quiet", "-c", "swapped", samples]);
        writeFileSync(join(dir, "samples", "key.txt"), `# fake, for tests\n${token()}\n`);
        git(dir, ["commit", "--quiet", "-am", "samples: swap the key"]);
        const swapped = head(dir);
        git(dir, ["switch", "--quiet", "main"]);
        expect(refusal(() => safeCommit({ dir, paths: [], merge: swapped, message: "Merge swapped" }))).toContain(
            "samples/key.txt:2: github-pat",
        );
    });

    test("a plain file:rule:line entry lets the reviewed line land, never another secret at that line", () => {
        // Branch `samples` adds the key with its plain entry; main moved on meanwhile.
        const dir = repo({ "app.txt": "app\n" });
        git(dir, ["switch", "--quiet", "-c", "samples"]);
        const samples = commitFiles(
            dir,
            { "samples/key.txt": `${token()}\n`, ".gitleaksignore": PLAIN_ENTRY },
            "samples: a fake key, ignored",
        );
        git(dir, ["switch", "--quiet", "-c", "swapped"]);
        const swapped = commitFiles(dir, { "samples/key.txt": `${token()}\n` }, "samples: another key in its place");
        git(dir, ["switch", "--quiet", "main"]);
        const before = commitFiles(dir, { "app.txt": "app on main\n" }, "main: app");

        // Another key on the ignored file, rule and line: gitleaks alone would let it through on the plain entry.
        expect(refusal(() => safeCommit({ dir, paths: [], merge: swapped, message: "Merge swapped" }))).toContain(
            "samples/key.txt:1: github-pat",
        );
        expect(head(dir)).toBe(before);
        // The very line the entry was committed with lands.
        const merged = safeCommit({ dir, paths: [], merge: samples, message: "Merge samples" });
        expect(git(dir, ["rev-parse", `${merged.sha}^2`])).toBe(samples);
    });

    test("a plain entry with no committed line to compare with is refused", () => {
        const dir = repo({ "app.txt": "app\n" });
        mkdirSync(join(dir, "samples"));
        writeFileSync(join(dir, "samples", "key.txt"), `${token()}\n`);
        writeFileSync(join(dir, ".gitleaksignore"), PLAIN_ENTRY);
        const before = head(dir);
        expect(
            refusal(() => safeCommit({ dir, paths: ["samples/key.txt", ".gitleaksignore"], message: "Sample key" })),
        ).toContain("samples/key.txt:1: github-pat");
        expect(head(dir)).toBe(before);
    });

    test("gitleaks failing without a report refuses, saying the staged set was not scanned", () => {
        const dir = repo({ ".gitleaks.toml": "not = [valid\n" });
        writeFileSync(join(dir, "app.txt"), "app\n");
        const message = refusal(() => safeCommit({ dir, paths: ["app.txt"], message: "App" }));
        expect(message).toContain("gitleaks failed and wrote no report");
        expect(message).toContain("unable to load gitleaks config");
        expect(message).not.toContain("found a secret");
    });
});
