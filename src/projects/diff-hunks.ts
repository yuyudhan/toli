// `git diff -U0` output read as hunks, for the revert check of `bin/toli commit` (src/projects/commit-checks.ts).

/**
 * One `-U0` hunk: its removed and added lines, and where it starts on each side. A side with no lines (a pure
 * insertion's old side, a pure removal's new side) starts at the line the gap follows (0: the top of the file).
 * `oldFile` is the file's path before the change: `file` itself unless the diff found a rename.
 */
export type Hunk = {
    file: string;
    oldFile: string;
    removed: string[];
    added: string[];
    oldStart: number;
    newStart: number;
};

/** A file the diff found renamed, by its paths before and after. */
export type Rename = { from: string; to: string };

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** A git C-quoted string's bytes, decoded as UTF-8: `\ooo` octal bytes and the C escapes. */
function unquoteC(quoted: string): string {
    const raw = Buffer.from(quoted.slice(1, -1), "utf8");
    const bytes: number[] = [];
    for (let i = 0; i < raw.length; i++) {
        const byte = raw[i] ?? 0;
        if (byte !== 92) bytes.push(byte);
        else {
            const next = String.fromCharCode(raw[++i] ?? 0);
            if (/[0-7]/.test(next)) {
                bytes.push(Number.parseInt(raw.subarray(i, i + 3).toString("latin1"), 8));
                i += 2;
            } else bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
        }
    }
    return Buffer.from(bytes).toString("utf8");
}

/** A path as git prints it in a diff header: C-quoted when it holds non-ASCII or special bytes (core.quotePath). */
function storedName(text: string): string {
    return text.startsWith('"') ? unquoteC(text) : text;
}

/**
 * A `---`/`+++` header's path as stored (null: /dev/null). git C-quotes a name with non-ASCII or special bytes
 * (`"b/caf\303\251.txt"`, core.quotePath) and ends one holding a space with a tab; `rev:path` lookups need the name.
 */
function headerPath(raw: string): string | null {
    const text = raw.endsWith("\t") ? raw.slice(0, -1) : raw;
    if (text === "/dev/null") return null;
    return storedName(text).replace(/^[ab]\//, "");
}

/** The renames of a `git diff --find-renames` output, from its `rename from`/`rename to` header lines. */
export function parseRenames(diff: string): Rename[] {
    const renames: Rename[] = [];
    let from: string | null = null;
    for (const line of diff.split("\n")) {
        if (line.startsWith("diff --git ")) from = null;
        else if (line.startsWith("rename from ")) from = storedName(line.slice("rename from ".length));
        else if (line.startsWith("rename to ") && from !== null)
            renames.push({ from, to: storedName(line.slice("rename to ".length)) });
    }
    return renames;
}

/** `git diff -U0` output as hunks: the removed and added lines of each, per file (both paths of a rename). */
export function parseHunks(diff: string): Hunk[] {
    const hunks: Hunk[] = [];
    let file = "";
    let oldFile: string | null = null;
    let current: Hunk | null = null;
    for (const line of diff.split("\n")) {
        if (line.startsWith("diff --git ")) {
            current = null;
            oldFile = null;
            continue;
        }
        if (current === null && line.startsWith("--- ")) {
            oldFile = headerPath(line.slice(4));
            if (oldFile !== null) file = oldFile;
            continue;
        }
        if (current === null && line.startsWith("+++ ")) {
            file = headerPath(line.slice(4)) ?? file;
            continue;
        }
        if (line.startsWith("@@")) {
            const header = HUNK_HEADER.exec(line);
            current = {
                file,
                oldFile: oldFile ?? file,
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
