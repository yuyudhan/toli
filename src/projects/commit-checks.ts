// The private index and the refusals of `bin/toli commit` (src/projects/commit.ts): leaks, lock files, reverts.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { git, gitOk } from "../core/git.ts";
import { type RunResult, run, ToliError } from "../core/util.ts";

/** Recent commits on the branch whose changes a new commit must not undo. */
export const REVERT_WINDOW = 20;
/** A reverted hunk shorter than this (non-whitespace characters, e.g. a lone `}`) is not evidence of a stale file. */
const REVERT_MIN_CHARS = 8;
const LOCK_CHECK_TIMEOUT_MS = 300_000;
const TAIL_LINES = 20;

type Hunk = { file: string; removed: string[]; added: string[] };

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
            current = { file, removed: [], added: [] };
            hunks.push(current);
        } else if (current !== null && line.startsWith("-")) current.removed.push(line.slice(1));
        else if (current !== null && line.startsWith("+")) current.added.push(line.slice(1));
    }
    return hunks;
}

/** Whether `ours` undoes `theirs` exactly: it removes what theirs added and adds back what theirs removed. */
function reverts(ours: Hunk, theirs: Hunk): boolean {
    if (ours.file !== theirs.file) return false;
    const undone = [...theirs.added, ...theirs.removed].join("").replace(/\s/g, "");
    if (undone.length < REVERT_MIN_CHARS) return false;
    return ours.removed.join("\n") === theirs.added.join("\n") && ours.added.join("\n") === theirs.removed.join("\n");
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

/** Refuse a staged Cargo.lock or bun.lock that does not parse (and a Cargo.lock that cargo rejects). */
export function checkLockFiles(attempt: Attempt, files: string[]): void {
    for (const file of files) {
        const name = basename(file);
        if (name !== "Cargo.lock" && name !== "bun.lock") continue;
        const staged = attempt.git(["show", `:${file}`]);
        if (staged.code !== 0) continue; // deleted in this commit
        const blob = staged.stdout;
        try {
            const marker = /^(<{7}|={7}|>{7})( |$)/m.exec(blob);
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
        const onDisk = join(attempt.dir, file);
        // cargo reads the working tree: check it when that is what is staged (a whole-file commit).
        if (!existsSync(onDisk) || readFileSync(onDisk, "utf8") !== blob) continue;
        const cargo = run(["cargo", "metadata", "--locked", "--format-version", "1"], {
            cwd: dirname(onDisk),
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

/** Refuse when the staged change exactly undoes a hunk of one of the last REVERT_WINDOW commits. */
export function checkReverts(dir: string, parent: string, tree: string, files: string[], allowed: string[]): void {
    const ours = parseHunks(
        gitOk(dir, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", parent, tree, "--", ...files]),
    );
    if (ours.length === 0) return;
    const recent = gitOk(dir, ["log", `-${REVERT_WINDOW}`, "--format=%H", parent, "--", ...files])
        .split("\n")
        .filter(Boolean);
    for (const commit of recent) {
        if (allowed.some((prefix) => commit.startsWith(prefix))) continue;
        const base = git(dir, ["rev-parse", "--verify", "--quiet", `${commit}^1`]);
        const theirs = parseHunks(
            base.code === 0
                ? gitOk(dir, [
                      "diff",
                      "-U0",
                      "--no-color",
                      "--no-ext-diff",
                      "--no-renames",
                      base.stdout.trim(),
                      commit,
                      "--",
                      ...files,
                  ])
                : gitOk(dir, ["show", "-U0", "--no-color", "--no-ext-diff", "--format=", commit, "--", ...files]),
        );
        const hit = ours.find((hunk) => theirs.some((other) => reverts(hunk, other)));
        if (hit === undefined) continue;
        const subject = gitOk(dir, ["log", "-1", "--format=%h %s", commit]);
        throw new ToliError(
            `refusing: this commit would revert ${hit.file} lines from ${subject} (one of the last ${REVERT_WINDOW} commits). ` +
                "The file is probably stale: re-read it, re-apply your change on top, and commit again. " +
                `If undoing that change is the point, pass --allow-revert ${commit.slice(0, 12)}.`,
        );
    }
}

/** The files a patch touches (both sides of renames). */
export function patchFiles(attempt: Attempt, patch: string): string[] {
    return attempt
        .gitOk(["apply", "--numstat", "-z", "-"], patch)
        .split("\0")
        .flatMap((field) => field.split("\t").slice(2))
        .filter(Boolean);
}
