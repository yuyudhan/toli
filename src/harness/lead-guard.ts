// The lead-only tool guard shared by every harness adapter (the omp extension and the Claude Code PreToolUse
// hook). It is pure: callers pass the tool call and where it runs, and get back allow or a reason to deny.
// The lead (the session the user starts in toli's root) keeps to bookkeeping: it may write toli's private
// records (data/, state/, config/) and scratch files, and never reads or edits project code. Jawans are never
// blocked, whatever harness they run on.
import { readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

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

/**
 * The symlink-resolved form of an absolute path, so /tmp vs /private/tmp style aliases and linked checkouts compare
 * by where they really are. A path that does not exist (a new file, a glob) resolves through its deepest existing
 * ancestor.
 */
function realPath(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        const parent = dirname(path);
        return parent === path ? path : join(realPath(parent), basename(path));
    }
}

function within(path: string, dirs: string[]): boolean {
    return dirs.some((dir) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`));
}

/**
 * Project territory: the real projects/ dir and the real checkout of every project there (linked ones included).
 * A linked checkout that contains toli's root itself is left out, so the lead's own records stay writable.
 */
function projectDirs(root: string): string[] {
    const projects = join(root, "projects");
    let names: string[] = [];
    try {
        names = readdirSync(projects);
    } catch {
        // no projects/ yet: only the dir itself
    }
    const checkouts = names.map((name) => realPath(join(projects, name))).filter((dir) => !within(root, [dir]));
    return [projects, ...checkouts];
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
    const root = realPath(resolve(context.root));
    if (realPath(resolve(context.cwd)) !== root) return ALLOW;
    const projects = projectDirs(root);
    const targets = action.paths.flatMap((raw) => {
        const path = resolveToolPath(raw, context.cwd);
        return path === null ? [] : [{ raw, path: realPath(path) }];
    });
    if (action.kind === "read") {
        const read = targets.find(({ path }) => within(path, projects));
        if (read === undefined) return ALLOW;
        return {
            allow: false,
            reason: `toli lead guard: reading project code (${read.raw}) is jawan work. Dispatch a scout jawan (load the toli-dispatch skill) instead of exploring yourself.`,
        };
    }
    const records = LEAD_WRITABLE.map((dir) => join(root, dir));
    // Scratch dirs (temp, Claude plan files) are fine, but never as a way into toli's root or a project checkout
    // (either may live in temp).
    const scratch = [tmpdir(), "/tmp", join(homedir(), ".claude", "plans")].map(realPath);
    const write = targets.find(({ path }) => {
        if (within(path, projects)) return true;
        return within(path, [root]) ? !within(path, records) : !within(path, scratch);
    });
    if (write === undefined) return ALLOW;
    return {
        allow: false,
        reason: `toli lead guard: the lead only writes toli's records (data/, state/, config/); editing ${write.raw} is jawan work. Write a brief and dispatch a jawan (load the toli-dispatch skill).`,
    };
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
