// Shared plumbing for scripts/guard.ts and the rules in scripts/guard/*.ts.
//
// Scope modes (one is chosen per run):
//   MATE_GUARD_HOOK=1        staged files only, content read from the index (pre-commit)
//   MATE_GUARD_RANGE=A..B    files changed in A..B, content read at B (pushed commits)
//   neither                  every tracked file, content read from the working tree
// Git failures throw: a guard that cannot list or read its files must fail, never pass.
import { lstatSync, readFileSync } from "node:fs";

export const ROOT = new URL("..", import.meta.url).pathname;

export type GuardFile = { path: string; text: string };
export type Violation = { path: string; line?: number; message: string };
export type Guard = { name: string; run(files: GuardFile[]): Violation[] };
export type Scope = { description: string; files: GuardFile[]; notes: string[]; allowEmpty: boolean };

function git(args: string[], stdin?: string): Buffer {
    const result = Bun.spawnSync(["git", "-C", ROOT, ...args], {
        stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
        stdout: "pipe",
        stderr: "pipe",
    });
    if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} exited ${result.exitCode}: ${result.stderr.toString().trim()}`);
    }
    return result.stdout;
}

function nulList(output: Buffer): string[] {
    return output
        .toString("utf8")
        .split("\0")
        .filter((entry) => entry.length > 0);
}

type ChangedBlob = { path: string; sha: string };

/**
 * Regular files (mode 100644/100755) added or modified by `git diff <args>`, with their new blob ids.
 * Symlinks and submodules are skipped: their "content" is a link target or a commit id, not text.
 */
function changedBlobs(diffArgs: string[], notes: string[]): ChangedBlob[] {
    const fields = git(["diff", ...diffArgs, "--raw", "-z", "--no-renames", "--no-abbrev", "--diff-filter=ACM"])
        .toString("utf8")
        .split("\0");
    const blobs: ChangedBlob[] = [];
    let skipped = 0;
    for (let index = 0; index + 1 < fields.length; index += 2) {
        const meta = fields[index] ?? "";
        const path = fields[index + 1] ?? "";
        const match = /^:\d{6} (\d{6}) [0-9a-f]+ ([0-9a-f]+) [ACM]$/.exec(meta);
        if (!match?.[1] || !match[2]) throw new Error(`unexpected git diff --raw record: ${JSON.stringify(meta)}`);
        if (match[1] === "100644" || match[1] === "100755") blobs.push({ path, sha: match[2] });
        else skipped += 1;
    }
    if (skipped > 0) notes.push(`skipped ${skipped} symlink/submodule entr${skipped === 1 ? "y" : "ies"}`);
    return blobs;
}

/** Read every blob in one `git cat-file --batch` process. */
function readBlobs(blobs: ChangedBlob[]): Array<[string, Buffer]> {
    if (blobs.length === 0) return [];
    const output = git(["cat-file", "--batch"], `${blobs.map((blob) => blob.sha).join("\n")}\n`);
    const entries: Array<[string, Buffer]> = [];
    let offset = 0;
    for (const { path, sha } of blobs) {
        const headerEnd = output.indexOf(0x0a, offset);
        if (headerEnd < 0) throw new Error(`git cat-file output ended before ${path}`);
        const header = output.subarray(offset, headerEnd).toString("utf8");
        const match = /^[0-9a-f]+ blob (\d+)$/.exec(header);
        if (!match?.[1]) throw new Error(`git cat-file could not read ${sha} (${path}): ${header}`);
        const start = headerEnd + 1;
        const end = start + Number(match[1]);
        entries.push([path, output.subarray(start, end)]);
        offset = end + 1;
    }
    return entries;
}

function textFiles(entries: Array<[string, Buffer]>, notes: string[]): GuardFile[] {
    const files: GuardFile[] = [];
    let binaries = 0;
    for (const [path, bytes] of entries) {
        // A NUL byte in the first 8000 bytes is git's own binary heuristic.
        if (bytes.subarray(0, 8000).includes(0)) binaries += 1;
        else files.push({ path, text: bytes.toString("utf8") });
    }
    if (binaries > 0) notes.push(`skipped ${binaries} binary file(s)`);
    return files;
}

function stagedScope(): Scope {
    const notes: string[] = [];
    const blobs = changedBlobs(["--cached"], notes);
    return {
        description: `hook mode: ${blobs.length} staged file(s), read from the index`,
        files: textFiles(readBlobs(blobs), notes),
        notes,
        allowEmpty: true,
    };
}

function rangeScope(range: string): Scope {
    if (!/^[^.\s]+\.\.[^.\s]+$/.test(range)) {
        throw new Error(`MATE_GUARD_RANGE must look like <rev>..<rev>, got ${JSON.stringify(range)}`);
    }
    const notes: string[] = [];
    const blobs = changedBlobs([range], notes);
    return {
        description: `range mode: ${blobs.length} file(s) changed in ${range}, read at the range tip`,
        files: textFiles(readBlobs(blobs), notes),
        notes,
        allowEmpty: true,
    };
}

function treeScope(): Scope {
    const notes: string[] = [];
    let paths = nulList(git(["ls-files", "-z"]));
    let source = "git ls-files";
    if (paths.length === 0) {
        paths = nulList(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));
        source = "git ls-files --cached --others --exclude-standard";
        notes.push("nothing is tracked yet, so untracked non-ignored files are scanned instead");
    }
    const absent: string[] = [];
    const entries: Array<[string, Buffer]> = [];
    for (const path of paths) {
        const stat = lstatSync(`${ROOT}${path}`, { throwIfNoEntry: false });
        // Tracked-but-absent paths (deleted in the working tree) are reported, never silently measured as empty.
        if (!stat) absent.push(path);
        else if (stat.isFile()) entries.push([path, readFileSync(`${ROOT}${path}`)]);
    }
    if (absent.length > 0) notes.push(`skipped ${absent.length} tracked-but-absent path(s): ${absent.join(", ")}`);
    return {
        description: `full tree: ${entries.length} file(s) from ${source}`,
        files: textFiles(entries, notes),
        notes,
        allowEmpty: false,
    };
}

export function collectScope(env: NodeJS.ProcessEnv = process.env): Scope {
    if (env.MATE_GUARD_HOOK === "1") return stagedScope();
    const range = env.MATE_GUARD_RANGE;
    if (range) return rangeScope(range);
    return treeScope();
}

/** Number of lines, not counting the empty string after a final newline. */
export function lineCount(text: string): number {
    if (text.length === 0) return 0;
    const lines = text.split("\n").length;
    return text.endsWith("\n") ? lines - 1 : lines;
}

/** Call `visit` with each 1-based line number and line text. */
export function eachLine(text: string, visit: (line: string, number: number) => void): void {
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) visit(lines[index] ?? "", index + 1);
}

/** TypeScript source and test files the code-only rules apply to. */
export function isCode(path: string): boolean {
    return path.endsWith(".ts") || path === "bin/mate";
}
