// Every fenced ```mermaid block in tracked Markdown parses with the mermaid version GitHub renders with. GitHub draws
// these blocks in an iframe and shows only a spinner or "Unable to render rich display" on a syntax error, so a
// broken diagram is invisible in review. Pin `mermaid` in package.json to GitHub's version: its renderer bundle
// (viewscreen.githubusercontent.com/static/assets/mermaidMarkdown-*.js) passes it to `renderer.draw`.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { eachLine, type Guard, type Violation } from "../guard-lib.ts";

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const ERROR_LINE = /\bon line (\d+)/;

type Block = { path: string; line: number; source: string };

/** Fenced blocks whose info string is `mermaid`; `line` is the 1-based line of the opening fence. */
function mermaidBlocks(path: string, text: string): Block[] {
    const blocks: Block[] = [];
    let open: { fence: string; line: number; mermaid: boolean; body: string[] } | null = null;
    eachLine(text, (line, number) => {
        const match = FENCE.exec(line);
        if (open === null) {
            if (match?.[1] !== undefined) {
                open = { fence: match[1], line: number, mermaid: match[2]?.toLowerCase() === "mermaid", body: [] };
            }
            return;
        }
        const marker = match?.[1];
        const closes =
            marker !== undefined && marker[0] === open.fence[0] && marker.length >= open.fence.length && !match?.[2];
        if (!closes) {
            open.body.push(line);
            return;
        }
        if (open.mermaid) blocks.push({ path, line: open.line, source: open.body.join("\n") });
        open = null;
    });
    return blocks;
}

/** One-line violation: the parser's own summary, with its block-relative line made file-relative. */
function violation(block: Block, error: unknown): Violation {
    const message = error instanceof Error ? error.message : String(error);
    const relative = Number(ERROR_LINE.exec(message)?.[1]);
    const lines = message.split("\n").filter((part) => part.trim() !== "" && !/^-*\^$/.test(part.trim()));
    const summary =
        lines.length > 1 ? `${lines[0]?.replace(/:$/, "")}: ${lines.at(-1)}` : (lines[0] ?? "unknown error");
    return {
        path: block.path,
        line: Number.isInteger(relative) ? block.line + relative : block.line,
        message: `mermaid cannot parse this diagram (GitHub shows a spinner): ${summary.replace(/\s+/g, " ")}`,
    };
}

export default {
    name: "mermaid",
    async run(files) {
        const blocks = files
            .filter(({ path }) => path.endsWith(".md"))
            .flatMap(({ path, text }) => mermaidBlocks(path, text));
        if (blocks.length === 0) return [];
        // mermaid's flowchart parser sanitizes labels with DOMPurify, which needs a DOM when the module loads, so the
        // globals go in first and mermaid is imported after them (a static import would load it without a window).
        GlobalRegistrator.register();
        try {
            const { default: mermaid } = await import("mermaid");
            const violations: Violation[] = [];
            for (const block of blocks) {
                try {
                    await mermaid.parse(block.source);
                } catch (error) {
                    violations.push(violation(block, error));
                }
            }
            return violations;
        } finally {
            await GlobalRegistrator.unregister();
        }
    },
} satisfies Guard;
