// docs/cli.md covers the whole CLI: every line of `bin/toli --help` appears in it (compared trimmed), so a new
// command or flag cannot ship undocumented. Runs when docs/cli.md or src/ is in scope.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Guard, ROOT, type Violation } from "../guard-lib.ts";

const DOC = "docs/cli.md";

export default {
    name: "cli-docs",
    run(files) {
        if (!files.some(({ path }) => path === DOC || path.startsWith("src/"))) return [];
        const help = spawnSync(join(ROOT, "bin/toli"), ["--help"], { cwd: ROOT, encoding: "utf8" });
        if (help.status !== 0) throw new Error(`bin/toli --help exited ${help.status}: ${help.stderr}`);
        const documented = new Set(
            (files.find(({ path }) => path === DOC)?.text ?? readFileSync(join(ROOT, DOC), "utf8"))
                .split("\n")
                .map((line) => line.trim()),
        );
        const violations: Violation[] = [];
        for (const line of help.stdout.split("\n").slice(1)) {
            const entry = line.trim();
            if (entry !== "" && !documented.has(entry)) {
                violations.push({ path: DOC, message: `missing \`bin/toli --help\` line: ${entry}` });
            }
        }
        return violations;
    },
} satisfies Guard;
