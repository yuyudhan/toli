// Every program toli starts gets an explicit `env`. main() drops inherited repository-locating git variables
// (GIT_DIR, GIT_INDEX_FILE, ...) from process.env, but Bun hands a spawn without an `env` option, and a Worker, the
// environment the process started with, so such a call would still pass them on (T2052).
import type { Guard, Violation } from "../guard-lib.ts";

const CHILD_PROCESS_FUNCTIONS: Readonly<Record<string, true>> = {
    spawn: true,
    spawnSync: true,
    exec: true,
    execSync: true,
    execFile: true,
    execFileSync: true,
    fork: true,
};

const CHILD_PROCESS_IMPORT = /import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/g;
const CHILD_PROCESS_NAMESPACE = /import\s*\*\s*as\s+(\w+)\s+from\s*["'](?:node:)?child_process["']/g;
const ENV_OPTION = /(?:^|[{,\s])env\s*(?:[:,}]|$)/m;

/** The call patterns that start a program in `text`: Bun's, Worker, and this file's child_process imports. */
function spawnPatterns(text: string): RegExp[] {
    // Identifiers hold only word characters and `$`, the one a pattern must escape.
    const callees = ["Bun\\.spawn(?:Sync)?", "new\\s+Worker"];
    for (const match of text.matchAll(CHILD_PROCESS_IMPORT)) {
        for (const entry of (match[1] ?? "").split(",")) {
            const [name, alias] = entry
                .trim()
                .replace(/^type\s+/, "")
                .split(/\s+as\s+/);
            if (name !== undefined && Object.hasOwn(CHILD_PROCESS_FUNCTIONS, name))
                callees.push(`(?<![\\w.$])${(alias ?? name).replaceAll("$", "\\$")}`);
        }
    }
    const functions = Object.keys(CHILD_PROCESS_FUNCTIONS).join("|");
    for (const match of text.matchAll(CHILD_PROCESS_NAMESPACE))
        callees.push(`(?<![\\w.$])${(match[1] ?? "").replaceAll("$", "\\$")}\\.(?:${functions})`);
    return callees.map((callee) => new RegExp(`${callee}\\s*\\(`, "g"));
}

/**
 * The code of the call whose `(` is at `open`, through its matching `)`: string contents and comments are dropped, so
 * only real code can name `env`. Null when the call never closes.
 */
function callCode(text: string, open: number): string | null {
    const modes: string[] = [];
    let depth = 0;
    let code = "";
    for (let index = open; index < text.length; index++) {
        const char = text[index] as string;
        const next = text[index + 1];
        const mode = modes.at(-1);
        if (mode === "'" || mode === '"' || mode === "`") {
            if (char === "\\") index++;
            else if (char === mode) {
                modes.pop();
                code += char;
            } else if (mode === "`" && char === "$" && next === "{") {
                modes.push("${");
                index++;
            }
            continue;
        }
        if (char === "/" && next === "/") {
            const end = text.indexOf("\n", index);
            index = end === -1 ? text.length : end - 1;
            continue;
        }
        if (char === "/" && next === "*") {
            const end = text.indexOf("*/", index + 2);
            index = end === -1 ? text.length : end + 1;
            continue;
        }
        code += char;
        if (char === "'" || char === '"' || char === "`") modes.push(char);
        else if (char === "{") modes.push("{");
        else if (char === "}" && (mode === "{" || mode === "${")) modes.pop();
        else if (char === "(") depth++;
        else if (char === ")" && --depth === 0) return code;
    }
    return null;
}

/** Each call in `text` that starts a program without an `env` option. */
export function spawnsWithoutEnv(path: string, text: string): Violation[] {
    const violations: Violation[] = [];
    for (const pattern of spawnPatterns(text)) {
        for (const match of text.matchAll(pattern)) {
            const open = (match.index ?? 0) + match[0].length - 1;
            const code = callCode(text, open);
            if (code !== null && ENV_OPTION.test(code)) continue;
            violations.push({
                path,
                line: text.slice(0, match.index).split("\n").length,
                message: `${match[0].replace(/\s*\($/, "")} without an explicit env: pass env (process.env or one built from it), or Bun hands the child the environment toli started with`,
            });
        }
    }
    return violations.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

export default {
    name: "spawn-env",
    run(files) {
        return files
            .filter(({ path }) => path.startsWith("src/") || path === "bin/toli")
            .flatMap(({ path, text }) => spawnsWithoutEnv(path, text));
    },
} satisfies Guard;
