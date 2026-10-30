// Relative links in tracked Markdown resolve: the target file or directory exists, and a `#fragment` names a heading
// in the target Markdown file (GitHub's slug rules). Links with a scheme (https:, mailto:, skill:, ...) are skipped,
// as are fenced code, indented code, and inline code. Targets are looked up in the working tree.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { eachLine, type Guard, ROOT, type Violation } from "../guard-lib.ts";

const INLINE_LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

/** Lines outside fenced and indented code blocks; `prose` has inline code removed, `line` is untouched. */
function proseLines(text: string): Array<{ line: string; prose: string; number: number }> {
    const lines: Array<{ line: string; prose: string; number: number }> = [];
    let fence: string | null = null;
    let previousBlank = true;
    eachLine(text, (line, number) => {
        const marker = FENCE.exec(line)?.[1];
        if (fence !== null) {
            if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
            return;
        }
        if (marker !== undefined) {
            fence = marker;
            return;
        }
        const indentedCode = previousBlank && /^( {4}|\t)/.test(line);
        previousBlank = line.trim() === "" || (indentedCode && previousBlank);
        if (indentedCode) return;
        lines.push({ line, prose: line.replace(/(`+)[^`]*?\1/g, ""), number });
    });
    return lines;
}

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens, repeats suffixed -1, -2, ... */
function anchors(text: string): Set<string> {
    const seen = new Map<string, number>();
    const result = new Set<string>();
    for (const { line } of proseLines(text)) {
        const heading = HEADING.exec(line)?.[1];
        if (heading === undefined) continue;
        const base = heading
            .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s_-]/gu, "")
            .replace(/\s/g, "-");
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        result.add(count === 0 ? base : `${base}-${count}`);
    }
    return result;
}

function targets(line: string): string[] {
    const found = [...line.matchAll(INLINE_LINK)].map((match) => match[1] ?? "");
    const definition = REFERENCE_DEFINITION.exec(line)?.[1];
    if (definition !== undefined) found.push(definition);
    return found.filter((target) => target !== "" && !SCHEME.test(target));
}

export default {
    name: "markdown-links",
    run(files) {
        const violations: Violation[] = [];
        const anchorCache = new Map<string, Set<string>>();
        const anchorsOf = (path: string, text?: string): Set<string> => {
            let cached = anchorCache.get(path);
            if (cached === undefined) {
                cached = anchors(text ?? readFileSync(join(ROOT, path), "utf8"));
                anchorCache.set(path, cached);
            }
            return cached;
        };
        for (const { path, text } of files) {
            if (!path.endsWith(".md")) continue;
            for (const { prose, number } of proseLines(text)) {
                for (const target of targets(prose)) {
                    const [rawPath = "", fragment] = target.split("#", 2);
                    const filePart = decodeURIComponent(rawPath.split("?", 1)[0] ?? "");
                    const resolved = filePart === "" ? path : normalize(join(dirname(path), filePart));
                    if (resolved.startsWith("..") || !existsSync(join(ROOT, resolved))) {
                        violations.push({ path, line: number, message: `link target not found: ${target}` });
                        continue;
                    }
                    if (fragment === undefined || fragment === "") continue;
                    if (!resolved.endsWith(".md") || statSync(join(ROOT, resolved)).isDirectory()) continue;
                    const known = resolved === path ? anchorsOf(path, text) : anchorsOf(resolved);
                    if (!known.has(decodeURIComponent(fragment).toLowerCase())) {
                        violations.push({ path, line: number, message: `no heading for anchor: ${target}` });
                    }
                }
            }
        }
        return violations;
    },
} satisfies Guard;
