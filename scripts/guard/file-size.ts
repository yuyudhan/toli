// Code files (TypeScript and bin/toli) stay at or under LIMIT lines.
// scripts/file-size-exceptions.txt ratchets pre-existing offenders: each entry is debt with a
// ceiling, never permission. A listed file fails if it grows past its ceiling, and also fails once
// it is back under LIMIT (or gone) so the stale entry gets deleted. Unlisted files get the real limit.
import { existsSync, readFileSync } from "node:fs";
import { eachLine, type Guard, isCode, lineCount, ROOT, type Violation } from "../guard-lib.ts";

const LIMIT = 400;
const EXCEPTIONS = "scripts/file-size-exceptions.txt";

function loadCeilings(): Map<string, number> {
    const ceilings = new Map<string, number>();
    const path = `${ROOT}${EXCEPTIONS}`;
    if (!existsSync(path)) return ceilings;
    eachLine(readFileSync(path, "utf8"), (line, number) => {
        const entry = line.trim();
        if (entry === "" || entry.startsWith("#")) return;
        const match = /^(\d+)\s+(\S+)$/.exec(entry);
        if (!match?.[1] || !match[2]) throw new Error(`${EXCEPTIONS}:${number}: expected "<ceiling> <path>"`);
        ceilings.set(match[2], Number(match[1]));
    });
    return ceilings;
}

export default {
    name: "file-size",
    run(files) {
        const ceilings = loadCeilings();
        const violations: Violation[] = [];
        for (const file of files) {
            if (!isCode(file.path)) continue;
            const lines = lineCount(file.text);
            const ceiling = ceilings.get(file.path);
            if (ceiling === undefined) {
                if (lines > LIMIT) violations.push({ path: file.path, message: `${lines} lines, limit is ${LIMIT}` });
            } else if (lines > ceiling) {
                violations.push({
                    path: file.path,
                    message: `${lines} lines, past its ${EXCEPTIONS} ceiling ${ceiling}`,
                });
            } else if (lines <= LIMIT) {
                violations.push({
                    path: file.path,
                    message: `${lines} lines is within the ${LIMIT} limit; delete its ${EXCEPTIONS} entry`,
                });
            }
        }
        for (const path of ceilings.keys()) {
            if (!existsSync(`${ROOT}${path}`)) {
                violations.push({ path: EXCEPTIONS, message: `${path} no longer exists; delete its entry` });
            }
        }
        return violations;
    },
} satisfies Guard;
