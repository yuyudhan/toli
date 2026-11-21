// The secrets refusal of `bin/toli commit` (src/projects/commit.ts): gitleaks over the attempt's private index.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run, ToliError } from "../core/util.ts";
import { type Attempt, tail } from "./commit-checks.ts";

/** A gitleaks finding, as its JSON report lists it (lines 1-based, inclusive). */
type Leak = { RuleID: string; File: string; StartLine: number; EndLine: number };

/** A `.gitleaksignore` entry a history scan writes: `<commit>:<file>:<rule>:<line>`. */
const COMMIT_FINGERPRINT = /^([0-9a-f]{40}):(.+):([^:]+):(\d+)$/;

/** The lines of blob `spec` (`<commit>:<file>`, or `:<file>` for the private index), null when there is none. */
function blobLines(attempt: Attempt, spec: string): string[] | null {
    const shown = attempt.git(["cat-file", "blob", spec]);
    return shown.code === 0 ? shown.stdout.split("\n") : null;
}

/**
 * Whether `leak`, found in the staged set, is one `ignore` (the repository's `.gitleaksignore`) already fingerprints
 * as `<commit>:<file>:<rule>:<line>`. A staged scan has no commit, so gitleaks matches only `<file>:<rule>:<line>`
 * entries itself and never the commit-keyed ones `gitleaks git` reports; a merge staging an ignored secret it brings
 * would be refused. Such an entry covers the leak when it names the same file and rule and that commit holds exactly
 * the leak's lines there (wherever they start now): the very text already reviewed, never a new secret beside it.
 */
function fingerprinted(attempt: Attempt, leak: Leak, ignore: string[]): boolean {
    const found = blobLines(attempt, `:${leak.File}`)?.slice(leak.StartLine - 1, leak.EndLine) ?? [];
    if (found.length !== leak.EndLine - leak.StartLine + 1) return false;
    return ignore.some((entry) => {
        const [, commit, file, rule, line] = COMMIT_FINGERPRINT.exec(entry.trim()) ?? [];
        if (commit === undefined || file !== leak.File || rule !== leak.RuleID) return false;
        const start = Number(line) - 1;
        const known = blobLines(attempt, `${commit}:${file}`)?.slice(start, start + found.length) ?? [];
        return known.length === found.length && known.every((text, at) => text === found[at]);
    });
}

/**
 * Refuse when the staged set holds a secret (gitleaks over the private index, run at the checkout's top level so it
 * reads the repository's `.gitleaks.toml` and `.gitleaksignore`). Findings the ignore file fingerprints by commit
 * are dropped (see `fingerprinted`); any other refuses the commit.
 */
export function scanLeaks(attempt: Attempt): void {
    const root = attempt.gitOk(["rev-parse", "--show-toplevel"]);
    const config = join(root, ".gitleaks.toml");
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
            "--report-format",
            "json",
            "--report-path",
            report,
            ...(existsSync(config) ? ["--config", config] : []),
        ],
        { cwd: root, env: { GIT_INDEX_FILE: attempt.index } },
    );
    if (result.code === 127)
        throw new ToliError(
            "refusing: gitleaks is not on PATH, so the staged set cannot be scanned for secrets (install it: just setup lists the command)",
        );
    if (result.code === 0) return;
    const refuse = (found: string): never => {
        throw new ToliError(
            `refusing: gitleaks found a secret in the staged set; nothing was committed. Remove it from the file:\n${found}`,
        );
    };
    // No findings reported: gitleaks itself failed, and the staged set stays unscanned.
    const reported = existsSync(report) ? (JSON.parse(readFileSync(report, "utf8")) as Leak[]) : [];
    if (reported.length === 0) refuse(tail(`${result.stdout}${result.stderr}`));
    const ignorePath = join(root, ".gitleaksignore");
    const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8").split("\n") : [];
    const leaks = reported.filter((leak) => !fingerprinted(attempt, leak, ignore));
    if (leaks.length > 0) refuse(leaks.map((leak) => `${leak.File}:${leak.StartLine}: ${leak.RuleID}`).join("\n"));
}
