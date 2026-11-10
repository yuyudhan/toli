// `data/projects/<p>/decisions.md`: every held question with its options and the user's verbatim answer.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../core/paths.ts";
import { now, withLock } from "../core/util.ts";
import type { Task } from "./backlog.ts";
import { matchOption } from "./hold-options.ts";

/** Append the held question, its options, and the user's verbatim answer to `data/projects/<p>/decisions.md`. */
export function recordDecision(task: Task, reply: string): void {
    const file = paths.projectDecisions(task.project);
    const options = task.options ?? [];
    const chosen = matchOption(options, reply);
    const lines = [`- Q: ${task.question ?? ""}`];
    if (options.length > 0)
        lines.push(
            `- Options: ${options.map((option, index) => `${index + 1}. ${option.choice} => ${option.outcome}`).join("; ")}`,
        );
    if (task.recommend !== undefined) lines.push(`- Recommended: ${task.recommend}`);
    lines.push(`- A: ${reply}`);
    if (chosen !== undefined) lines.push(`- Chosen: ${chosen.choice} => ${chosen.outcome}`);
    withLock(paths.lock("decisions"), () => {
        mkdirSync(dirname(file), { recursive: true });
        const head = existsSync(file) ? "" : `# ${task.project} decisions\n`;
        const day = now().toISOString().slice(0, 10);
        appendFileSync(file, `${head}\n## ${day} ${task.id}: ${task.title}\n\n${lines.join("\n")}\n`);
    });
}
