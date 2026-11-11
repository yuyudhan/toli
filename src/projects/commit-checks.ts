// The private index and the refusals of `bin/toli commit` (src/projects/commit.ts): leaks, lock files, reverts, and
// the project's commit-msg hook.
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { git, gitOk } from "../core/git.ts";
import { type RunResult, run, ToliError } from "../core/util.ts";

/** Recent commits on the branch whose changes a new commit must not undo. */
export const REVERT_WINDOW = 20;
/** A reverted hunk shorter than this (non-whitespace characters, e.g. a lone `}`) is not evidence of a stale file. */
const REVERT_MIN_CHARS = 8;
const LOCK_CHECK_TIMEOUT_MS = 300_000;
const HOOK_TIMEOUT_MS = 300_000;
const TAIL_LINES = 20;

/**
 * One `-U0` hunk: its removed and added lines, and where it starts on each side. A side with no lines (a pure
 * insertion's old side, a pure removal's new side) starts at the line the gap follows (0: the top of the file).
 */
export type Hunk = { file: string; removed: string[]; added: string[]; oldStart: number; newStart: number };

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function tail(text: string): string {
    return text.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
}

/** `git diff -U0` output as hunks: the removed and added lines of each, per file. */
export function parseHunks(diff: string): Hunk[] {
    const hunks: Hunk[] = [];
    let file = "";
    let current: Hunk | null = null;
    for (const line of diff.split("\n")) {
        if (line.startsWith("diff --git ")) {
            current = null;
            continue;
        }
        if (current === null && line.startsWith("+++ ")) {
            file = line === "+++ /dev/null" ? file : line.replace(/^\+\+\+ b\//, "");
            continue;
        }
        if (current === null && line.startsWith("--- ")) {
            if (line !== "--- /dev/null") file = line.replace(/^--- a\//, "");
            continue;
        }
        if (line.startsWith("@@")) {
            const header = HUNK_HEADER.exec(line);
            current = {
                file,
                removed: [],
                added: [],
                oldStart: Number(header?.[1] ?? 0),
                newStart: Number(header?.[2] ?? 0),
            };
            hunks.push(current);
        } else if (current !== null && line.startsWith("-")) current.removed.push(line.slice(1));
        else if (current !== null && line.startsWith("+")) current.added.push(line.slice(1));
    }
    return hunks;
}

/** The lines of `file` at `rev` (a commit or tree), empty when it has no such file; cached per rev and file. */
type Lines = (rev: string, file: string) => string[];

function fileLines(dir: string): Lines {
    const cache = new Map<string, string[]>();
    return (rev, file) => {
        const key = `${rev}:${file}`;
        let lines = cache.get(key);
        if (lines === undefined) {
            const shown = git(dir, ["cat-file", "blob", key]);
            lines = shown.code === 0 ? shown.stdout.split("\n") : [];
            if (lines.at(-1) === "") lines.pop();
            cache.set(key, lines);
        }
        return lines;
    };
}

/** The two lines around the gap after line `at` (null past either end of the file). */
function around(lines: string[], at: number): [string | null, string | null] {
    return [at >= 1 ? (lines[at - 1] ?? null) : null, lines[at] ?? null];
}

/** The revisions of our diff and theirs, before and after (null before: their commit is a root). */
type Sides = { ours: [string, string]; theirs: [string | null, string] };

/**
 * Whether `ours` undoes `theirs` exactly: it removes what theirs added and adds back what theirs removed. A pure
 * insertion or removal undoes theirs only in the same place: the same lines border the gap the block leaves, on
 * our side without it and theirs. Adding a line a recent commit removed elsewhere in the file is a new change.
 */
function reverts(ours: Hunk, theirs: Hunk, lines: Lines, sides: Sides): boolean {
    if (ours.file !== theirs.file) return false;
    const undone = [...theirs.added, ...theirs.removed].join("").replace(/\s/g, "");
    if (undone.length < REVERT_MIN_CHARS) return false;
    if (ours.removed.join("\n") !== theirs.added.join("\n") || ours.added.join("\n") !== theirs.removed.join("\n"))
        return false;
    if (ours.removed.length > 0 && ours.added.length > 0) return true;
    // Pure insertion of ours: the gap is in our parent and their commit; pure removal: our tree and their base.
    const inserting = ours.removed.length === 0;
    const theirRev = inserting ? sides.theirs[1] : sides.theirs[0];
    const ourGap = around(
        lines(inserting ? sides.ours[0] : sides.ours[1], ours.file),
        inserting ? ours.oldStart : ours.newStart,
    );
    const theirGap = around(
        theirRev === null ? [] : lines(theirRev, theirs.file),
        inserting ? theirs.newStart : theirs.oldStart,
    );
    return ourGap[0] === theirGap[0] && ourGap[1] === theirGap[1];
}

/** One commit attempt's private temporary index (GIT_INDEX_FILE), built and read without the shared one. */
export class Attempt {
    readonly index: string;
    private readonly scratch: string;

    constructor(readonly dir: string) {
        this.scratch = mkdtempSync(join(tmpdir(), "toli-index-"));
        this.index = join(this.scratch, "index");
    }

    /** git with this attempt's private index. */
    git(args: string[], stdin?: string): RunResult {
        return run(["git", "-C", this.dir, ...args], {
            env: { GIT_INDEX_FILE: this.index },
            ...(stdin === undefined ? {} : { stdin }),
        });
    }

    gitOk(args: string[], stdin?: string): string {
        const result = this.git(args, stdin);
        if (result.code !== 0)
            throw new ToliError(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
        return result.stdout.trim();
    }

    /**
     * The private index's files written out under the scratch folder once (git checkout-index), so tools that read
     * files see exactly the tree being committed, including what a merge brings before it reaches the working tree.
     */
    staged(): string {
        const tree = join(this.scratch, "tree");
        if (!existsSync(tree)) this.gitOk(["checkout-index", "--all", `--prefix=${tree}/`]);
        return tree;
    }

    /** A path for a scratch file of this attempt, removed with it. */
    file(name: string): string {
        return join(this.scratch, name);
    }

    dispose(): void {
        rmSync(this.scratch, { recursive: true, force: true });
    }
}

/** Refuse when the staged set holds a secret (gitleaks over the private index). */
export function scanLeaks(attempt: Attempt): void {
    const config = join(attempt.dir, ".gitleaks.toml");
    const result = run(
        [
            "gitleaks",
            "git",
            "--staged",
            "--redact",
            "--no-banner",
            "--log-level",
            "warn",
            ...(existsSync(config) ? ["--config", config] : []),
        ],
        { cwd: attempt.dir, env: { GIT_INDEX_FILE: attempt.index } },
    );
    if (result.code === 127)
        throw new ToliError(
            "refusing: gitleaks is not on PATH, so the staged set cannot be scanned for secrets (install it: just setup lists the command)",
        );
    if (result.code !== 0)
        throw new ToliError(
            `refusing: gitleaks found a secret in the staged set; nothing was committed. Remove it from the file:\n${tail(`${result.stdout}${result.stderr}`)}`,
        );
}

/**
 * Run the repo's commit-msg hook (core.hooksPath honoured, as git resolves it) on `message` and return the message as
 * the hook left it; refuse when the hook exits non-zero. It runs from the checkout root with GIT_INDEX_FILE at the
 * private index, so a hook that reads the staged set (`git diff --cached`) sees exactly the commit being made. A
 * missing or non-executable hook is skipped, as git skips it. Pre-commit hooks are not run: toli's own checks cover
 * the staged set, and those hooks often assume the shared index (formatters that re-stage, `git stash`).
 */
export function commitMsgHook(attempt: Attempt, message: string): string {
    const hook = gitOk(attempt.dir, ["rev-parse", "--path-format=absolute", "--git-path", "hooks/commit-msg"]);
    try {
        accessSync(hook, constants.X_OK);
    } catch {
        return message;
    }
    const file = attempt.file("COMMIT_EDITMSG");
    writeFileSync(file, `${message}\n`);
    const result = run([hook, file], {
        cwd: attempt.dir,
        env: { GIT_INDEX_FILE: attempt.index, GIT_EDITOR: ":" },
        timeoutMs: HOOK_TIMEOUT_MS,
    });
    if (result.code !== 0)
        throw new ToliError(
            `refusing: the commit-msg hook ${hook} rejected the message; nothing was committed:\n${tail(`${result.stdout}${result.stderr}`)}`,
        );
    const edited = readFileSync(file, "utf8").replace(/\s+$/, "");
    if (edited === "") throw new ToliError(`refusing: the commit-msg hook ${hook} left the message empty`);
    return edited;
}

/** A line git writes around a merge conflict. */
const CONFLICT_MARKER = /^(<{7}|={7}|>{7})( |$)/m;

/**
 * Refuse a resolved merge whose conflicted paths are not all named (`named`: whether the committer named a path) or
 * whose staged version still holds a conflict marker.
 */
export function checkResolved(attempt: Attempt, conflicts: string[], named: (file: string) => boolean): void {
    const unnamed = conflicts.filter((file) => !named(file));
    if (unnamed.length > 0)
        throw new ToliError(
            `refusing: --resolved, but conflicted ${unnamed.join(", ")} not named; name every resolved file after --`,
        );
    for (const file of conflicts) {
        const staged = attempt.git(["show", `:${file}`]);
        if (staged.code !== 0) continue; // resolved by deleting it
        const marker = CONFLICT_MARKER.exec(staged.stdout);
        if (marker !== null)
            throw new ToliError(
                `refusing: ${file} still has a merge conflict marker ${marker[1]}; finish resolving it`,
            );
    }
}

/**
 * The named paths that match nothing in the working tree or the private index, which `git add` cannot stage. Each is
 * already absent from the merge result in the private index, so leaving it unstaged records it as deleted; that holds
 * only for a path the merge conflicts on or changes (resolved by deleting it). Any other such path is refused.
 */
export function absentPaths(
    attempt: Attempt,
    named: string[],
    merge: { ref: string; conflicts: string[]; files: string[] } | null,
): string[] {
    const absent = named.filter(
        (file) =>
            !existsSync(resolve(attempt.dir, file)) &&
            attempt.gitOk(["ls-files", "--cached", "--others", "--", file]) === "",
    );
    const unrelated = absent.filter(
        (file) => merge === null || (!merge.conflicts.includes(file) && !merge.files.includes(file)),
    );
    if (unrelated.length > 0)
        throw new ToliError(
            `refusing: ${unrelated.join(", ")} not in the working tree or the commit` +
                (merge === null ? "" : `, and not among the paths merging ${merge.ref} conflicts on or changes`) +
                "; nothing was committed. Check the path",
        );
    return absent;
}

/** A lock file the package manager regenerates: checked by `checkLockFiles`, never merged by hand. */
export function isLockFile(file: string): boolean {
    const name = basename(file);
    return name === "Cargo.lock" || name === "bun.lock";
}

/** Refuse a staged Cargo.lock or bun.lock that does not parse (and a Cargo.lock that cargo rejects in the staged tree). */
export function checkLockFiles(attempt: Attempt, files: string[]): void {
    for (const file of files) {
        if (!isLockFile(file)) continue;
        const name = basename(file);
        const staged = attempt.git(["show", `:${file}`]);
        if (staged.code !== 0) continue; // deleted in this commit
        const blob = staged.stdout;
        try {
            const marker = CONFLICT_MARKER.exec(blob);
            if (marker !== null) throw new Error(`merge conflict marker ${marker[1]}`);
            if (name === "bun.lock") {
                const parsed: unknown = Bun.JSONC.parse(blob);
                if (typeof parsed !== "object" || parsed === null || !("lockfileVersion" in parsed))
                    throw new Error("no lockfileVersion");
            } else {
                // Bun.TOML.parse stops quietly at some invalid lines: every [[package]] must come through.
                const parsed: unknown = Bun.TOML.parse(blob);
                const packages =
                    typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "package") : undefined;
                const headers = blob.match(/^\[\[package\]\]\s*$/gm)?.length ?? 0;
                if ((Array.isArray(packages) ? packages.length : 0) !== headers)
                    throw new Error(
                        `${headers} [[package]] entries, ${Array.isArray(packages) ? packages.length : 0} parsed`,
                    );
            }
        } catch (error) {
            throw new ToliError(
                `refusing: the staged ${file} does not parse (${error instanceof Error ? error.message : String(error)}); ` +
                    "regenerate it (cargo generate-lockfile / bun install) instead of merging it by hand",
            );
        }
        if (name !== "Cargo.lock") continue;
        // cargo reads files: check the staged tree, which holds the crates a merge adds before the working tree does.
        const cargo = run(["cargo", "metadata", "--locked", "--format-version", "1"], {
            cwd: dirname(join(attempt.staged(), file)),
            timeoutMs: LOCK_CHECK_TIMEOUT_MS,
        });
        if (cargo.code === 127)
            throw new ToliError(
                `refusing: ${file} is staged but cargo is not on PATH to check it (cargo metadata --locked)`,
            );
        if (cargo.code !== 0)
            throw new ToliError(`refusing: cargo metadata --locked rejects the staged ${file}:\n${tail(cargo.stderr)}`);
    }
}

/**
 * Refuse when the change to `files` exactly undoes a hunk of one of the last REVERT_WINDOW commits. `files` are the
 * committer's own changes: the files a clean merge brings (unchanged on top of the merge result) are never passed in.
 * `brought`: the merged ref's own hunks (merge base to ref); a hunk of ours equal to one of them is the ref's change,
 * taken as it is in a resolved conflict, so it is not checked.
 */
export function checkReverts(
    dir: string,
    parent: string,
    tree: string,
    files: string[],
    allowed: string[],
    brought: Hunk[] = [],
): void {
    if (files.length === 0) return;
    const ours = parseHunks(
        gitOk(dir, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", parent, tree, "--", ...files]),
    ).filter(
        (hunk) =>
            !brought.some(
                (other) =>
                    other.file === hunk.file &&
                    other.removed.join("\n") === hunk.removed.join("\n") &&
                    other.added.join("\n") === hunk.added.join("\n"),
            ),
    );
    if (ours.length === 0) return;
    const recent = gitOk(dir, ["log", `-${REVERT_WINDOW}`, "--format=%H", parent, "--", ...files])
        .split("\n")
        .filter(Boolean);
    const lines = fileLines(dir);
    for (const commit of recent) {
        if (allowed.some((prefix) => commit.startsWith(prefix))) continue;
        const found = git(dir, ["rev-parse", "--verify", "--quiet", `${commit}^1`]);
        const base = found.code === 0 ? found.stdout.trim() : null;
        const theirs = parseHunks(
            base === null
                ? gitOk(dir, ["show", "-U0", "--no-color", "--no-ext-diff", "--format=", commit, "--", ...files])
                : gitOk(dir, [
                      "diff",
                      "-U0",
                      "--no-color",
                      "--no-ext-diff",
                      "--no-renames",
                      base,
                      commit,
                      "--",
                      ...files,
                  ]),
        );
        const sides = { ours: [parent, tree], theirs: [base, commit] } satisfies Sides;
        const hit = ours.find((hunk) => theirs.some((other) => reverts(hunk, other, lines, sides)));
        if (hit === undefined) continue;
        const subject = gitOk(dir, ["log", "-1", "--format=%h %s", commit]);
        throw new ToliError(
            `refusing: this commit would revert ${hit.file} lines from ${subject} (one of the last ${REVERT_WINDOW} commits). ` +
                "The file is probably stale: re-read it, re-apply your change on top, and commit again. " +
                `If undoing that change is the point, pass --allow-revert ${commit.slice(0, 12)}.`,
        );
    }
}

/**
 * Apply each `--patch` diff to the attempt's index in order, naming one that fails; returns every file they touch
 * (both sides of renames).
 */
export function applyPatches(attempt: Attempt, patches: { name: string; diff: string }[]): string[] {
    return patches.flatMap((patch) => {
        const files = attempt.gitOk(["apply", "--numstat", "-z", "-"], patch.diff).split("\0");
        const applied = attempt.git(["apply", "--cached", "-"], patch.diff);
        if (applied.code !== 0)
            throw new ToliError(`--patch ${patch.name} does not apply: ${(applied.stderr || applied.stdout).trim()}`);
        return files.flatMap((field) => field.split("\t").slice(2)).filter(Boolean);
    });
}
