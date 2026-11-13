// Internal names (a client, its projects, machine names, people, company mail, private network addresses) never
// belong in this public repository: not in tracked files, commit messages, CHANGELOG sections or release notes.
//
// The denylist is stored as salted SHA-256 prefixes so this file does not publish the names it guards. Text is
// lowercased and split into words ([a-z0-9]+); each word, the word without trailing digits ("box3" -> "box"), and
// each pair of words joined by one "-", "_" or "." is hashed and looked up. Pairs catch dotted or hyphenated names
// and address prefixes ("x.y" for "x.y.z.w").
//
//   bun scripts/internal-names.ts hash <name>...   print the entry to add to DENIED for each name
//   bun scripts/internal-names.ts check [file]     scan a message (the file, or stdin); exit 1 on any hit
//
// Used by scripts/guard/internal-names.ts (tracked files), .githooks/commit-msg and scripts/publish.ts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const SALT = "toli-internal-names-v1:";

const DENIED: Readonly<Record<string, true>> = {
    "5961e8aaf4e6be35": true,
    cf860c0852fd1664: true,
    f996ce8620b88c7c: true,
    "8713f7604f8d289e": true,
    "72586fd620b654c5": true,
    ca104c1323c053f1: true,
    d0298c958d68c116: true,
    "8a415c5b708d5839": true,
    de026e94bb665dfa: true,
    "12ab36970249e44d": true,
    "24f436868449d1e8": true,
    "6e2f3c372262a699": true,
    efe42166ccec9dd8: true,
    b62a864bfe54e0ee: true,
    "48df36764889396c": true,
    b43a598f72a25d79: true,
    "331b3282016df2c4": true,
    "4e093ba67d215892": true,
    ba8a3b44ea544c36: true,
    a9121cc0c84cd9b0: true,
    d3f41e30238b7308: true,
    f256ef51baf951a9: true,
    ec3d8193a98eb820: true,
};

export function nameHash(name: string): string {
    return createHash("sha256")
        .update(SALT + name.toLowerCase())
        .digest("hex")
        .slice(0, 16);
}

const verdicts = new Map<string, boolean>();

function denied(candidate: string): boolean {
    let verdict = verdicts.get(candidate);
    if (verdict === undefined) {
        verdict = DENIED[nameHash(candidate)] === true;
        verdicts.set(candidate, verdict);
    }
    return verdict;
}

const WORD = /[a-z0-9]+/g;
const SEPARATORS: Readonly<Record<string, true>> = { "-": true, _: true, ".": true };

/**
 * The internal names in one line of text, as written there (lowercased), in order of appearance. `isDenied` is the
 * lookup (tests pass their own list).
 */
export function internalNamesIn(line: string, isDenied: (candidate: string) => boolean = denied): string[] {
    const lower = line.toLowerCase();
    const hits: string[] = [];
    let previous: { text: string; end: number } | null = null;
    for (const match of lower.matchAll(WORD)) {
        const word = match[0];
        const start = match.index;
        const stripped = word.replace(/\d+$/, "");
        if (isDenied(word) || (stripped !== "" && stripped !== word && isDenied(stripped))) hits.push(word);
        if (previous !== null && start === previous.end + 1 && SEPARATORS[lower.charAt(previous.end)] === true) {
            const pair = lower.slice(start - previous.text.length - 1, start + word.length);
            if (isDenied(pair)) hits.push(pair);
        }
        previous = { text: word, end: start + word.length };
    }
    return hits;
}

export type NameHit = { line: number; names: string[] };

/** Every line of `text` that holds an internal name, 1-based. */
export function internalNameHits(text: string): NameHit[] {
    const hits: NameHit[] = [];
    for (const [index, line] of text.split("\n").entries()) {
        const names = internalNamesIn(line);
        if (names.length > 0) hits.push({ line: index + 1, names });
    }
    return hits;
}

function main(argv: string[]): number {
    const [command, ...rest] = argv;
    if (command === "hash" && rest.length > 0) {
        for (const name of rest) process.stdout.write(`    "${nameHash(name)}",\n`);
        return 0;
    }
    if (command === "check" && rest.length <= 1) {
        const text = readFileSync(rest[0] ?? 0, "utf8");
        const hits = internalNameHits(text);
        for (const { line, names } of hits) {
            process.stderr.write(`internal name on line ${line}: ${names.join(", ")}\n`);
        }
        return hits.length === 0 ? 0 : 1;
    }
    process.stderr.write("usage: bun scripts/internal-names.ts hash <name>... | check [file]\n");
    return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
