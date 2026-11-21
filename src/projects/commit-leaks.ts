// The secrets refusal of `bin/toli commit` (src/projects/commit.ts): gitleaks over the attempt's private index.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run, ToliError } from "../core/util.ts";
import { type Attempt, tail } from "./commit-checks.ts";

/** A gitleaks finding, as its JSON report lists it (lines 1-based, inclusive). */
type Leak = { RuleID: string; File: string; StartLine: number; EndLine: number };

/** A `.gitleaksignore` entry a history scan writes: `<commit>:<file>:<rule>:<line>`. */
const COMMIT_FINGERPRINT = /^([0-9a-f]{40}|[0-9a-f]{64}):(.+):([^:]+):(\d+)$/;
/** A `.gitleaksignore` entry a scan without history writes: `<file>:<rule>:<line>`. */
const PLAIN_FINGERPRINT = /^(.+):([^:]+):(\d+)$/;
const IGNORE_FILE = ".gitleaksignore";

/** The lines of blob `spec` (`<commit>:<file>`, or `:<file>` for the private index), null when there is none. */
function blobLines(attempt: Attempt, spec: string): string[] | null {
    const shown = attempt.git(["cat-file", "blob", spec]);
    return shown.code === 0 ? shown.stdout.split("\n") : null;
}

/** Whether `file` at `commit` holds exactly `found` from line `line` (1-based) on. */
function holds(attempt: Attempt, commit: string, file: string, line: number, found: string[]): boolean {
    const known = blobLines(attempt, `${commit}:${file}`)?.slice(line - 1, line - 1 + found.length) ?? [];
    return known.length === found.length && known.every((text, at) => text === found[at]);
}

/**
 * Whether `leak`, found in the staged set, is one `ignore` (the staged `.gitleaksignore`) covers, and only for the
 * text that was reviewed: gitleaks itself applies no ignore file here (see `scanLeaks`), since it would let any secret
 * through on a plain entry naming the same file, rule and line, and never matches a commit-keyed entry in a staged
 * scan. A `<commit>:<file>:<rule>:<line>` entry covers the leak when that commit holds exactly the leak's lines there
 * (wherever they start now). A `<file>:<rule>:<line>` entry covers it at that very line when the file held exactly
 * the leak's lines in a commit that added the entry to the ignore file; with no such commit, nothing was reviewed.
 */
function fingerprinted(attempt: Attempt, leak: Leak, ignore: string[]): boolean {
    const found = blobLines(attempt, `:${leak.File}`)?.slice(leak.StartLine - 1, leak.EndLine) ?? [];
    if (found.length !== leak.EndLine - leak.StartLine + 1) return false;
    return ignore.some((raw) => {
        const entry = raw.trim();
        const [, commit, keyedFile, keyedRule, keyedLine] = COMMIT_FINGERPRINT.exec(entry) ?? [];
        if (commit !== undefined)
            return (
                keyedFile === leak.File &&
                keyedRule === leak.RuleID &&
                holds(attempt, commit, leak.File, Number(keyedLine), found)
            );
        const [, file, rule, line] = PLAIN_FINGERPRINT.exec(entry) ?? [];
        if (file !== leak.File || rule !== leak.RuleID || Number(line) !== leak.StartLine) return false;
        const added = attempt.git(["log", "--all", "--format=%H", "-S", entry, "--", IGNORE_FILE]);
        return (
            added.code === 0 &&
            added.stdout
                .split("\n")
                .filter((sha) => sha !== "")
                .some((sha) => holds(attempt, sha, leak.File, leak.StartLine, found))
        );
    });
}

/**
 * Refuse when the staged set holds a secret: gitleaks over the private index (the repository's `.gitleaks.toml`
 * applies). It runs from an empty folder of the attempt, the repository named by GIT_DIR and GIT_WORK_TREE, so it
 * finds no `.gitleaksignore` of its own; the staged one is applied here, by `fingerprinted`, and any other finding
 * refuses the commit.
 */
export function scanLeaks(attempt: Attempt): void {
    const root = attempt.gitOk(["rev-parse", "--show-toplevel"]);
    const config = join(root, ".gitleaks.toml");
    const neutral = attempt.file("gitleaks");
    mkdirSync(neutral, { recursive: true });
    const report = attempt.file("gitleaks.json");
    const result = run(
        [
            "gitleaks",
            "git",
            "--staged",
            "--redact",
            "--no-banner",
            "--log-level",
            "warn",
            "--gitleaks-ignore-path",
            neutral,
            "--report-format",
            "json",
            "--report-path",
            report,
            ...(existsSync(config) ? ["--config", config] : []),
            neutral,
        ],
        {
            cwd: neutral,
            env: {
                GIT_DIR: attempt.gitOk(["rev-parse", "--absolute-git-dir"]),
                GIT_WORK_TREE: root,
                GIT_INDEX_FILE: attempt.index,
            },
        },
    );
    if (result.code === 127)
        throw new ToliError(
            "refusing: gitleaks is not on PATH, so the staged set cannot be scanned for secrets (install it: just setup lists the command)",
        );
    if (result.code === 0) return;
    const reported = existsSync(report) ? (JSON.parse(readFileSync(report, "utf8")) as Leak[]) : [];
    if (reported.length === 0)
        throw new ToliError(
            `refusing: gitleaks failed and wrote no report, so the staged set was not scanned; nothing was committed:\n${tail(`${result.stdout}${result.stderr}`)}`,
        );
    const ignore = blobLines(attempt, `:${IGNORE_FILE}`) ?? [];
    const leaks = reported.filter((leak) => !fingerprinted(attempt, leak, ignore));
    if (leaks.length > 0)
        throw new ToliError(
            `refusing: gitleaks found a secret in the staged set; nothing was committed. Remove it from the file:\n${leaks.map((leak) => `${leak.File}:${leak.StartLine}: ${leak.RuleID}`).join("\n")}`,
        );
}
