// .editorconfig, enforced: LF line endings, a final newline, no tab indentation (Makefiles excepted),
// and no trailing whitespace (Markdown excepted: two trailing spaces are a hard line break there).
import { eachLine, type Guard, type Violation } from "../guard-lib.ts";

export default {
    name: "whitespace",
    run(files) {
        const violations: Violation[] = [];
        for (const { path, text } of files) {
            const tabsAllowed = path === "Makefile" || path.endsWith("/Makefile");
            const trailingAllowed = path.endsWith(".md");
            if (text.length > 0 && !text.endsWith("\n")) violations.push({ path, message: "missing final newline" });
            eachLine(text, (line, number) => {
                if (line.endsWith("\r")) violations.push({ path, line: number, message: "CRLF line ending" });
                else if (!trailingAllowed && /[ \t]$/.test(line)) {
                    violations.push({ path, line: number, message: "trailing whitespace" });
                }
                if (!tabsAllowed && line.startsWith("\t")) {
                    violations.push({ path, line: number, message: "tab indentation" });
                }
            });
        }
        return violations;
    },
} satisfies Guard;
