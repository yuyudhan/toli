// src/ prints through the output helpers in src/core/util.ts; stray console.log calls bypass them
// (and corrupt --json output).
import { eachLine, type Guard, type Violation } from "../guard-lib.ts";

const OUTPUT_HELPER = "src/core/util.ts";

export default {
    name: "console-log",
    run(files) {
        const violations: Violation[] = [];
        for (const { path, text } of files) {
            if (!path.startsWith("src/") || path === OUTPUT_HELPER) continue;
            eachLine(text, (line, number) => {
                if (/\bconsole\.log\(/.test(line)) {
                    violations.push({ path, line: number, message: `console.log outside ${OUTPUT_HELPER}` });
                }
            });
        }
        return violations;
    },
} satisfies Guard;
