// The lead-only tool guard shared by every harness adapter (the omp extension and the Claude Code PreToolUse
// hook). It is pure: callers pass the tool call and where it runs, and get back allow or a reason to deny.
// The lead (the session the user starts in toli's root) keeps to bookkeeping: it may write toli's private
// records (data/, state/, config/) and scratch files, and never reads or edits project code. Jawans are never
// blocked, whatever harness they run on.
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

export type GuardAction = { kind: "write" | "read"; paths: string[] } | { kind: "other" };

export type GuardContext = {
    /** toli's root directory. */
    root: string;
    /** The session's working directory; only a session started in toli's root can be the lead. */
    cwd: string;
    /** Set when anything marks the session as a jawan or gate agent (env, subagent id, TOLI_BRIEF prompt). */
    jawan: boolean;
};

export type GuardDecision = { allow: true } | { allow: false; reason: string };

const LEAD_WRITABLE = ["data", "state", "config"];
const ALLOW: GuardDecision = { allow: true };

/** A path and its symlink-resolved form, so /tmp vs /private/tmp style aliases compare equal. */
function forms(path: string): string[] {
    try {
        const real = realpathSync(path);
        return real === path ? [path] : [path, real];
    } catch {
        return [path];
    }
}

function within(path: string, dirs: string[]): boolean {
    return dirs.some((dir) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`));
}

/** Resolve a tool path against the session cwd; `~/` is the home dir. Internal URIs (`agent://`) yield null. */
function resolveToolPath(raw: string, cwd: string): string | null {
    const path = raw.trim();
    if (path === "" || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null;
    if (path === "~" || path.startsWith("~/")) return join(homedir(), path.slice(1));
    return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/** Env markers set on jawans: `bin/toli spawn` sets TOLI_ROLE=jawan; no-mistakes gate agents carry NO_MISTAKES_GATE. */
export function jawanEnv(env: Record<string, string | undefined>): boolean {
    return env.TOLI_ROLE === "jawan" || (env.NO_MISTAKES_GATE ?? "") !== "";
}

/** Whether a prompt is a jawan brief (first line `TOLI_BRIEF v1`). */
export function isBrief(prompt: string): boolean {
    return prompt.trimStart().startsWith("TOLI_BRIEF v1");
}

export function guardDecision(context: GuardContext, action: GuardAction): GuardDecision {
    if (context.jawan || action.kind === "other") return ALLOW;
    const roots = forms(resolve(context.root));
    if (!forms(resolve(context.cwd)).some((cwd) => roots.includes(cwd))) return ALLOW;
    const projects = roots.map((root) => join(root, "projects"));
    if (action.kind === "read") {
        for (const raw of action.paths) {
            const path = resolveToolPath(raw, context.cwd);
            if (path !== null && within(path, projects))
                return {
                    allow: false,
                    reason: `toli lead guard: reading project code (${raw}) is jawan work. Dispatch a scout jawan (load the toli-dispatch skill) instead of exploring yourself.`,
                };
        }
        return ALLOW;
    }
    const records = roots.flatMap((root) => LEAD_WRITABLE.map((dir) => join(root, dir)));
    // Scratch dirs (temp, Claude plan files) are fine, but never as a way into toli's root (which may live in temp).
    const scratch = [...forms(tmpdir()), ...forms("/tmp"), join(homedir(), ".claude", "plans")];
    for (const raw of action.paths) {
        const path = resolveToolPath(raw, context.cwd);
        if (path === null) continue;
        const candidates = forms(path);
        const allowed = candidates.some((candidate) => within(candidate, roots))
            ? candidates.some((candidate) => within(candidate, records))
            : candidates.some((candidate) => within(candidate, scratch));
        if (!allowed)
            return {
                allow: false,
                reason: `toli lead guard: the lead only writes toli's records (data/, state/, config/); editing ${raw} is jawan work. Write a brief and dispatch a jawan (load the toli-dispatch skill).`,
            };
    }
    return ALLOW;
}

function stringField(input: Record<string, unknown>, key: string): string[] {
    const value = input[key];
    return typeof value === "string" && value !== "" ? [value] : [];
}

/** Claude Code tool call (PreToolUse `tool_name` + `tool_input`) as a guard action. */
export function claudeAction(toolName: string, input: Record<string, unknown>): GuardAction {
    switch (toolName) {
        case "Edit":
        case "MultiEdit":
        case "Write":
            return { kind: "write", paths: stringField(input, "file_path") };
        case "NotebookEdit":
            return { kind: "write", paths: stringField(input, "notebook_path") };
        case "Read":
            return { kind: "read", paths: stringField(input, "file_path") };
        case "Grep":
            return { kind: "read", paths: stringField(input, "path") };
        case "Glob":
            return { kind: "read", paths: [...stringField(input, "path"), ...stringField(input, "pattern")] };
        default:
            return { kind: "other" };
    }
}

/** Paths an omp hashline `edit` input touches: `[PATH#TAG]` file headers and `MV DEST` renames. */
function ompEditPaths(text: string): string[] {
    const found: string[] = [];
    for (const line of text.split("\n")) {
        const header = /^\[(.+)#[0-9A-Fa-f]{4}\]\s*$/.exec(line.trim());
        if (header?.[1]) found.push(header[1]);
        const move = /^MV\s+(?:"([^"]+)"|(\S+))\s*$/.exec(line.trim());
        const dest = move?.[1] ?? move?.[2];
        if (dest) found.push(dest);
    }
    return found;
}

/** omp tool call (`tool_call` event `toolName` + `input`) as a guard action. Path lists use `;` separators. */
export function ompAction(toolName: string, input: Record<string, unknown>): GuardAction {
    const pathList = stringField(input, "path").flatMap((value) => value.split(";"));
    switch (toolName) {
        case "edit":
            return {
                kind: "write",
                paths: [...stringField(input, "input").flatMap(ompEditPaths), ...pathList],
            };
        case "write":
        case "ast_edit":
            return { kind: "write", paths: pathList };
        case "read":
        case "grep":
        case "glob":
        case "find":
        case "ast_grep":
            return { kind: "read", paths: pathList };
        default:
            return { kind: "other" };
    }
}
