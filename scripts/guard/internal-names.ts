// No internal names (scripts/internal-names.ts) in tracked files. scripts/internal-names-allow.txt lists the few
// allowed fragments per file (the default persona name, an open-source credit); a stale entry fails too.
import { existsSync, readFileSync } from "node:fs";
import { eachLine, type Guard, ROOT, type Violation } from "../guard-lib.ts";
import { internalNamesIn } from "../internal-names.ts";

const ALLOW = "scripts/internal-names-allow.txt";

function loadAllowed(): Map<string, string[]> {
    const allowed = new Map<string, string[]>();
    const file = `${ROOT}${ALLOW}`;
    if (!existsSync(file)) return allowed;
    eachLine(readFileSync(file, "utf8"), (line, number) => {
        if (line.trim() === "" || line.startsWith("#")) return;
        const match = /^(\S+) (.+)$/.exec(line);
        if (!match?.[1] || !match[2]) throw new Error(`${ALLOW}:${number}: expected "<path> <fragment>"`);
        allowed.set(match[1], [...(allowed.get(match[1]) ?? []), match[2]]);
    });
    return allowed;
}

export default {
    name: "internal-names",
    run(files) {
        const allowed = loadAllowed();
        const violations: Violation[] = [];
        for (const { path, text } of files) {
            if (path === ALLOW) continue;
            const fragments = allowed.get(path) ?? [];
            const used = new Set<string>();
            eachLine(text, (line, number) => {
                let rest = line;
                for (const fragment of fragments) {
                    if (!rest.includes(fragment)) continue;
                    used.add(fragment);
                    rest = rest.replaceAll(fragment, " ");
                }
                const names = internalNamesIn(rest);
                if (names.length > 0) {
                    violations.push({ path, line: number, message: `internal name: ${names.join(", ")}` });
                }
            });
            for (const fragment of fragments) {
                if (!used.has(fragment)) {
                    violations.push({ path: ALLOW, message: `"${fragment}" no longer appears in ${path}; delete it` });
                }
            }
        }
        return violations;
    },
} satisfies Guard;
