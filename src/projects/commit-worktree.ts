// After `bin/toli commit` moves the branch: bring the committed paths' working-tree files to the commit (T2106).
// A named path's file is what was committed, but a `--patch` hunk never had to be in the working tree, so its file
// may still hold the version the commit started from. Such a file is checked out from the commit; one that already
// matches it stays; one that matches neither (the user's own uncommitted edit, made before or during the commit) is
// left as it is and named in a warning. No other path is read or written.
import { lstatSync, readlinkSync, rmSync, type Stats } from "node:fs";
import { join } from "node:path";
import { git, gitOk } from "../core/git.ts";
import { ToliError, warn } from "../core/util.ts";

/** A blob's git mode and id. A working-tree regular file's mode is null when the repo ignores the executable bit. */
type Entry = { mode: string | null; id: string };

const SYMLINK = "120000";

/** The blob entries of `files` in `tree`; a path absent from it (or a submodule, which is not a blob) is not a key. */
function blobs(dir: string, tree: string, files: string[]): Map<string, Entry> {
    const listed = git(dir, ["--literal-pathspecs", "ls-tree", "-r", "-z", "--full-tree", tree, "--", ...files]);
    if (listed.code !== 0) throw new ToliError(`git ls-tree ${tree} failed in ${dir}: ${listed.stderr.trim()}`);
    const entries = new Map<string, Entry>();
    for (const line of listed.stdout.split("\0").filter(Boolean)) {
        const tab = line.indexOf("\t");
        const [mode, type, id] = line.slice(0, tab).split(" ");
        if (type === "blob" && mode !== undefined && id !== undefined) entries.set(line.slice(tab + 1), { mode, id });
    }
    return entries;
}

/** The working-tree file at `file`, hashed as git would store it; null when absent; "other" for a directory and such. */
function worktreeEntry(dir: string, file: string, fileMode: boolean): Entry | null | "other" {
    const path = join(dir, file);
    let stat: Stats;
    try {
        stat = lstatSync(path);
    } catch {
        return null;
    }
    if (stat.isSymbolicLink()) {
        const hashed = git(dir, ["hash-object", "--no-filters", "--stdin"], readlinkSync(path));
        if (hashed.code !== 0) throw new ToliError(`git hash-object failed for ${file}: ${hashed.stderr.trim()}`);
        return { mode: SYMLINK, id: hashed.stdout.trim() };
    }
    if (!stat.isFile()) return "other";
    const id = gitOk(dir, ["hash-object", `--path=${file}`, "--", path]);
    const executable = (stat.mode & 0o111) !== 0;
    return { mode: fileMode ? (executable ? "100755" : "100644") : null, id };
}

/** Whether the working-tree state `work` is the tree state `entry` (both absent counts). */
function matches(work: Entry | null | "other", entry: Entry | undefined): boolean {
    if (work === "other") return false;
    if (work === null || entry === undefined) return work === null && entry === undefined;
    if (work.id !== entry.id) return false;
    // Without core.fileMode a regular file matches either regular mode, never a symlink.
    return work.mode === null ? entry.mode !== SYMLINK : work.mode === entry.mode;
}

/**
 * Bring `files`' working-tree files to commit `sha` where they still hold a version of one of `before` (the first
 * parent and the tree the commit was built on), leaving any other content in place with one warning naming it.
 */
export function syncCommittedWorktree(dir: string, sha: string, before: string[], files: string[]): void {
    if (files.length === 0) return;
    const fileMode = git(dir, ["config", "--bool", "core.fileMode"]).stdout.trim() !== "false";
    const after = blobs(dir, sha, files);
    const olds = [...new Set(before)].map((tree) => blobs(dir, tree, files));
    const checkout: string[] = [];
    const remove: string[] = [];
    const kept: string[] = [];
    for (const file of files) {
        const work = worktreeEntry(dir, file, fileMode);
        if (matches(work, after.get(file))) continue;
        if (!olds.some((old) => matches(work, old.get(file)))) kept.push(file);
        else if (after.has(file)) checkout.push(file);
        else remove.push(file);
    }
    for (const file of remove) rmSync(join(dir, file), { force: true });
    if (checkout.length > 0) {
        const restored = git(dir, [
            "--literal-pathspecs",
            "restore",
            `--source=${sha}`,
            "--worktree",
            "--",
            ...checkout,
        ]);
        if (restored.code !== 0)
            warn(
                `toli: committed, but the committed files were not checked out (git restore --source=${sha.slice(0, 12)} --worktree -- <paths>): ${restored.stderr.trim()}`,
            );
    }
    if (kept.length > 0)
        warn(
            `toli: committed, but left your uncommitted edits in ${kept.join(", ")}: the working-tree file matches neither the commit nor the version before it (git diff ${sha.slice(0, 12)} -- <path> shows the difference)`,
        );
}
