// No `.only(` or `.skip(` left in tests: either silently shrinks the suite CI runs.
import { eachLine, type Guard, type Violation } from "../guard-lib.ts";

const FOCUS = /\.(only|skip)\(/;

export default {
    name: "focused-tests",
    run(files) {
        const violations: Violation[] = [];
        for (const { path, text } of files) {
            if (!(path.startsWith("tests/") || path.endsWith(".test.ts"))) continue;
            eachLine(text, (line, number) => {
                const match = FOCUS.exec(line);
                if (match) violations.push({ path, line: number, message: `.${match[1]}( narrows the test suite` });
            });
        }
        return violations;
    },
} satisfies Guard;
