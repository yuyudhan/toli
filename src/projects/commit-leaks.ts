// The secrets refusal of `bin/toli commit` (src/projects/commit.ts): gitleaks over the attempt's private index.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
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

/** The entries of a `.gitleaksignore`'s lines: trimmed, without blanks and `#` comments. */
function ignoreEntries(lines: string[]): string[] {
    return lines.map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
}

/** Whether `.gitleaksignore` at `rev` holds `entry` as a whole entry line. */
function listsEntry(attempt: Attempt, rev: string, entry: string): boolean {
    return ignoreEntries(blobLines(attempt, `${rev}:${IGNORE_FILE}`) ?? []).includes(entry);
}

/**
 * The commits reachable from `roots` that added `entry` to `.gitleaksignore`: their file lists it as a whole line and
 * none of their parents' does. `git log -S` only narrows the search (it also finds substrings, comments, removals).
 */
function addingCommits(attempt: Attempt, roots: string[], entry: string): string[] {
    const log = attempt.git(["log", "--format=%H", "-S", entry, ...roots, "--", IGNORE_FILE]);
    if (log.code !== 0) return [];
    return log.stdout
        .split("\n")
        .filter((sha) => sha !== "")
        .filter((sha) => {
            if (!listsEntry(attempt, sha, entry)) return false;
            const parents = attempt.git(["rev-parse", `${sha}^@`]);
            if (parents.code !== 0) return false;
            return !parents.stdout
                .split("\n")
                .filter((parent) => parent !== "")
                .some((parent) => listsEntry(attempt, parent, entry));
        });
}

/**
 * Whether `leak`, found in the staged set, is one `ignore` (the staged `.gitleaksignore` entries) covers, and only for
 * the text that was reviewed: gitleaks itself applies no ignore file here (see `scanLeaks`), since it would let any
 * secret through on a plain entry naming the same file, rule and line, and never matches a commit-keyed entry in a
 * staged scan. A `<commit>:<file>:<rule>:<line>` entry covers the leak when that commit holds exactly the leak's lines
 * there (wherever they start now). A `<file>:<rule>:<line>` entry covers it at that very line when the file held
 * exactly the leak's lines in a commit reachable from `roots` (the parent, and a merged commit) that added the entry;
 * with no such commit, nothing was reviewed.
 */
function fingerprinted(attempt: Attempt, leak: Leak, ignore: string[], roots: string[]): boolean {
    const found = blobLines(attempt, `:${leak.File}`)?.slice(leak.StartLine - 1, leak.EndLine) ?? [];
    if (found.length !== leak.EndLine - leak.StartLine + 1) return false;
    return ignore.some((entry) => {
        const [, commit, keyedFile, keyedRule, keyedLine] = COMMIT_FINGERPRINT.exec(entry) ?? [];
        if (commit !== undefined)
            return (
                keyedFile === leak.File &&
                keyedRule === leak.RuleID &&
                holds(attempt, commit, leak.File, Number(keyedLine), found)
            );
        const [, file, rule, line] = PLAIN_FINGERPRINT.exec(entry) ?? [];
        if (file !== leak.File || rule !== leak.RuleID || Number(line) !== leak.StartLine) return false;
        return addingCommits(attempt, roots, entry).some((sha) =>
            holds(attempt, sha, leak.File, leak.StartLine, found),
        );
    });
}

/** gitleaks loads `[extend]` of the configs above this depth only (the main config is 0); a deeper one's is ignored. */
const EXTEND_DEPTH = 2;

/** What a config chain gives gitleaks: rule ids, the ids `disabledRules` drops, and whether it uses the defaults. */
type RuleSet = { rules: Set<string>; disabled: Set<string>; useDefault: boolean };

/** `value[key]` when `value` is a table, else undefined. */
function field(value: unknown, key: string): unknown {
    return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

/**
 * Load the staged config text `config` (staged path `from`, at `depth` of its extend chain) as gitleaks does: add its
 * rules to `ruleSet`, and below EXTEND_DEPTH follow its `[extend]`, writing the staged copy of the config it extends
 * under `into` (the folder gitleaks runs in, which resolves a relative path from its working directory as from the
 * repository's top level). Only staged copies count, never a working-tree edit. Refused: a config that does not
 * parse, and an extend path that leaves the repository (absolute, or `..` above it), names the ignore file in any
 * case, or has no staged copy.
 */
function loadConfig(
    attempt: Attempt,
    config: string,
    from: string,
    into: string,
    depth: number,
    ruleSet: RuleSet,
): void {
    let parsed: unknown;
    try {
        parsed = Bun.TOML.parse(config);
    } catch {
        throw new ToliError(
            `refusing: ${from} does not parse as TOML, so the secrets scan cannot use it; nothing was committed`,
        );
    }
    const rules = field(parsed, "rules");
    if (Array.isArray(rules))
        rules.forEach((rule, at) => {
            const id = field(rule, "id");
            ruleSet.rules.add(typeof id === "string" ? id : `${from}#${at}`);
        });
    if (depth >= EXTEND_DEPTH) return;
    const extend = field(parsed, "extend");
    if (field(extend, "useDefault") === true) ruleSet.useDefault = true;
    const disabled = field(extend, "disabledRules");
    if (Array.isArray(disabled)) for (const id of disabled) if (typeof id === "string") ruleSet.disabled.add(id);
    const path = field(extend, "path");
    if (typeof path !== "string" || path === "") return;
    const file = normalize(path);
    if (isAbsolute(path) || file === ".." || file.startsWith("../"))
        throw new ToliError(`refusing: ${from} extends ${path}, outside the repository; nothing was committed`);
    if (basename(file).toLowerCase() === IGNORE_FILE)
        throw new ToliError(`refusing: ${from} extends ${path}, the ignore file, not a gitleaks config`);
    const staged = attempt.git(["cat-file", "blob", `:${file}`]);
    if (staged.code !== 0)
        throw new ToliError(
            `refusing: ${from} extends ${path}, which is not in the staged set, so the secrets scan cannot use it; nothing was committed`,
        );
    mkdirSync(dirname(join(into, file)), { recursive: true });
    writeFileSync(join(into, file), staged.stdout);
    loadConfig(attempt, staged.stdout, file, into, depth + 1, ruleSet);
}

/**
 * Refuse when the staged set holds a secret: gitleaks over the private index, with the staged `.gitleaks.toml` and
 * the staged configs it extends (`loadConfig`; one that leaves gitleaks no rule refuses, since it scans nothing). It
 * runs from a folder of its own holding only those configs, scanning a separate empty folder (also its ignore path),
 * the repository named by GIT_DIR and GIT_WORK_TREE, so it reads no `.gitleaksignore` at all; the staged one is
 * applied here, by `fingerprinted` (`roots`: the commits the new one is made of, whose history is reviewed), and any
 * other finding refuses the commit. Only gitleaks' exit 1 means findings; any other failure is a scan that did not
 * happen.
 */
export function scanLeaks(attempt: Attempt, roots: string[]): void {
    const neutral = attempt.file("gitleaks");
    const configs = attempt.file("gitleaks-config");
    mkdirSync(neutral, { recursive: true });
    mkdirSync(configs, { recursive: true });
    const stagedConfig = attempt.git(["cat-file", "blob", ":.gitleaks.toml"]);
    const config = attempt.file("gitleaks.toml");
    if (stagedConfig.code === 0) {
        writeFileSync(config, stagedConfig.stdout);
        const ruleSet: RuleSet = { rules: new Set(), disabled: new Set(), useDefault: false };
        loadConfig(attempt, stagedConfig.stdout, ".gitleaks.toml", configs, 0, ruleSet);
        if (!ruleSet.useDefault && [...ruleSet.rules].every((id) => ruleSet.disabled.has(id)))
            throw new ToliError(
                "refusing: the staged .gitleaks.toml has no rules gitleaks would load (none of its own or within two [extend] levels, and no useDefault), so the secrets scan would find nothing; nothing was committed",
            );
    }
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
            ...(stagedConfig.code === 0 ? ["--config", config] : []),
            neutral,
        ],
        {
            cwd: configs,
            env: {
                GIT_DIR: attempt.gitOk(["rev-parse", "--absolute-git-dir"]),
                GIT_WORK_TREE: attempt.gitOk(["rev-parse", "--show-toplevel"]),
                GIT_INDEX_FILE: attempt.index,
            },
        },
    );
    if (result.code === 127)
        throw new ToliError(
            "refusing: gitleaks is not on PATH, so the staged set cannot be scanned for secrets (install it: just setup lists the command)",
        );
    if (result.code === 0) return;
    const output = tail(`${result.stdout}${result.stderr}`);
    if (result.code !== 1)
        throw new ToliError(
            `refusing: gitleaks failed (exit ${result.code}), so the staged set was not scanned; nothing was committed:\n${output}`,
        );
    const reported = existsSync(report) ? (JSON.parse(readFileSync(report, "utf8")) as Leak[]) : [];
    if (reported.length === 0)
        throw new ToliError(
            `refusing: gitleaks failed and wrote no report, so the staged set was not scanned; nothing was committed:\n${output}`,
        );
    const ignore = ignoreEntries(blobLines(attempt, `:${IGNORE_FILE}`) ?? []);
    const leaks = reported.filter((leak) => !fingerprinted(attempt, leak, ignore, roots));
    if (leaks.length > 0)
        throw new ToliError(
            `refusing: gitleaks found a secret in the staged set; nothing was committed. Remove it from the file:\n${leaks.map((leak) => `${leak.File}:${leak.StartLine}: ${leak.RuleID}`).join("\n")}`,
        );
}
