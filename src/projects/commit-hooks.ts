// The project's own git hooks as `bin/toli commit` (src/projects/commit.ts) runs them on its private index:
// pre-commit on exactly the commit being made, then commit-msg on its message.
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { machineSettings } from "../core/config.ts";
import { gitOk } from "../core/git.ts";
import { run, ToliError } from "../core/util.ts";
import { type Attempt, tail } from "./commit-checks.ts";
import { type HookTimeout, loadProjects } from "./projects.ts";

/** A commit hook's limit when neither the project nor config/machine.json sets one. */
export const DEFAULT_HOOK_TIMEOUT_SECONDS = 300;
const MACHINE_SETTING = "capacity.commitHookTimeoutSeconds in config/machine.json";

/**
 * How long each commit hook may run before it is stopped: `seconds` (null: no limit), the registered `project` it was
 * resolved for (null: none), and `source`, the setting it came from, named when a hook runs past it.
 */
export type HookLimit = { seconds: number | null; project: string | null; source: string };

export const DEFAULT_HOOK_LIMIT: HookLimit = {
    seconds: DEFAULT_HOOK_TIMEOUT_SECONDS,
    project: null,
    source: "the default",
};

/** Whether `value` is a stored limit: a positive whole number of seconds, or `none`. */
function isHookTimeout(value: unknown): value is HookTimeout {
    return value === "none" || (typeof value === "number" && Number.isInteger(value) && value > 0);
}

/** `project set --hook-timeout`: seconds or `none` to store, `default` (null) to clear back to the machine's default. */
export function parseHookTimeout(value: string | undefined): HookTimeout | null | undefined {
    if (value === undefined) return undefined;
    if (value === "default") return null;
    const parsed = value === "none" ? value : /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!isHookTimeout(parsed))
        throw new ToliError(
            `--hook-timeout must be a positive whole number of seconds, none (no limit) or default, got "${value}"`,
        );
    return parsed;
}

/**
 * The commit-hook limit for `name`: the registered project's `hookTimeoutSeconds` (`project set --hook-timeout`), else
 * this machine's capacity.commitHookTimeoutSeconds, else DEFAULT_HOOK_TIMEOUT_SECONDS.
 */
export function hookLimit(name: string): HookLimit {
    const project = loadProjects().find((entry) => entry.name === name);
    const registered = project === undefined ? null : name;
    const own = project?.hookTimeoutSeconds;
    if (own !== undefined)
        return {
            seconds: own === "none" ? null : own,
            project: registered,
            source: `bin/toli project set ${name} --hook-timeout ${own}`,
        };
    const machine = machineSettings().capacity?.commitHookTimeoutSeconds;
    if (machine === undefined) return { ...DEFAULT_HOOK_LIMIT, project: registered };
    if (!isHookTimeout(machine))
        throw new ToliError(
            "config/machine.json capacity.commitHookTimeoutSeconds must be a positive whole number of seconds or none",
        );
    return { seconds: machine === "none" ? null : machine, project: registered, source: MACHINE_SETTING };
}

/** `run` options' timeout for `limit`. */
function timeout(limit: HookLimit): { timeoutMs?: number } {
    return limit.seconds === null ? {} : { timeoutMs: limit.seconds * 1000 };
}

/** The refusal for a hook stopped at `limit`, naming the settings that give it longer. */
function timedOut(kind: string, hook: string, limit: HookLimit, output: string): ToliError {
    const project =
        limit.project === null ? "" : `bin/toli project set ${limit.project} --hook-timeout <seconds|none>, or `;
    return new ToliError(
        `refusing: the ${kind} hook ${hook} ran past its ${limit.seconds} s limit (${limit.source}) and was stopped; ` +
            `nothing was committed. To give it longer or no limit, set ${project}for every project on this machine ` +
            `${MACHINE_SETTING} (seconds or "none"), then commit again:\n${output}`,
    );
}

/** Whether `path` is executable, as git checks a hook before running it. */
function executable(path: string): boolean {
    try {
        accessSync(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** The hook `name` as git resolves it (core.hooksPath honoured), absolute. */
function hookPath(attempt: Attempt, name: string): string {
    return gitOk(attempt.dir, ["rev-parse", "--path-format=absolute", "--git-path", `hooks/${name}`]);
}

/**
 * Link the checkout's ignored `entry` (a path git lists relative to `root`, a directory ending in `/`) into the staged
 * `tree` at the same place, so a hook finds a nested package's node_modules or a virtualenv as under `git commit`.
 * Missing parent directories are created; an entry the tree already has, or one under a link (into the checkout,
 * where creating anything would touch the shared working tree), is left alone.
 */
function linkIgnored(root: string, tree: string, entry: string): void {
    const name = entry.replace(/\/$/, "");
    if (name === "") return;
    const parts = name.split("/");
    let parent = tree;
    for (const part of parts.slice(0, -1)) {
        parent = join(parent, part);
        const stat = lstatSync(parent, { throwIfNoEntry: false });
        if (stat === undefined) mkdirSync(parent);
        else if (!stat.isDirectory()) return;
    }
    const target = join(tree, name);
    if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) return;
    symlinkSync(join(root, name), target);
}

/**
 * Run the repo's pre-commit hook on exactly the commit being made, and refuse when it exits non-zero or changes what
 * is committed. Its working tree is the private index's files written out (Attempt.staged), made a linked repository
 * of its own (Attempt.linkStaged: HEAD and objects the checkout's, index the private one), so `git diff --cached`
 * lists only the named paths and every file it reads is the committed version, even for a hook that unsets GIT_DIR,
 * GIT_WORK_TREE and GIT_INDEX_FILE: other jawans' staged or half-edited files in the shared checkout can neither fail
 * nor pass it. A hook file that is tracked runs as committed; the checkout's ignored entries at any depth (node_modules
 * of a nested package, a virtualenv, target) are linked in so its tools resolve. A hook that reformats or re-stages a
 * file is refused rather than followed: the commit would then differ from the working tree. A missing or
 * non-executable hook is skipped, as git skips it. A hook still running at `limit` is stopped and the commit refused.
 */
export function preCommitHook(attempt: Attempt, limit: HookLimit): void {
    const hook = hookPath(attempt, "pre-commit");
    if (!executable(hook)) return;
    const root = gitOk(attempt.dir, ["rev-parse", "--show-toplevel"]);
    const tree = attempt.staged();
    const rel = relative(root, hook);
    const inside = !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    const program = inside && executable(join(tree, rel)) ? join(tree, rel) : hook;
    const shown = inside ? rel : hook;
    const ignored = attempt.git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
    for (const entry of ignored.code === 0 ? ignored.stdout.split("\0") : []) linkIgnored(root, tree, entry);
    const before = attempt.gitOk(["write-tree"]);
    const env = { GIT_DIR: attempt.linkStaged(), GIT_WORK_TREE: tree, GIT_INDEX_FILE: attempt.index };
    const result = run([program], { cwd: tree, env, ...timeout(limit) });
    const output = tail(`${result.stdout}${result.stderr}`);
    if (result.timedOut) throw timedOut("pre-commit", shown, limit, output);
    if (result.code !== 0)
        throw new ToliError(
            `refusing: the pre-commit hook ${shown} failed on the staged set; nothing was committed. Fix what it reports, then commit again:\n${output}`,
        );
    const changed = run(["git", "diff", "--name-only", "-z", "--no-renames", before], { cwd: tree, env });
    if (changed.code !== 0)
        throw new ToliError(`git diff after the pre-commit hook failed: ${(changed.stderr || changed.stdout).trim()}`);
    const files = changed.stdout.split("\0").filter((file) => file !== "");
    if (attempt.gitOk(["write-tree"]) !== before || files.length > 0)
        throw new ToliError(
            `refusing: the pre-commit hook ${shown} changed ${files.join(", ") || "the staged set"} (a formatter?); nothing was committed. Run the project's formatter on those files, then commit again:\n${output}`,
        );
}

/**
 * Run the repo's commit-msg hook on `message` and return the message as the hook left it; refuse when the hook exits
 * non-zero. It runs from the checkout root with GIT_INDEX_FILE at the private index, so a hook that reads the staged
 * set (`git diff --cached`) sees exactly the commit being made. A missing or non-executable hook is skipped, as git
 * skips it. A hook still running at `limit` is stopped and the commit refused.
 */
export function commitMsgHook(attempt: Attempt, message: string, limit: HookLimit): string {
    const hook = hookPath(attempt, "commit-msg");
    if (!executable(hook)) return message;
    const file = attempt.file("COMMIT_EDITMSG");
    writeFileSync(file, `${message}\n`);
    const result = run([hook, file], {
        cwd: attempt.dir,
        env: { GIT_INDEX_FILE: attempt.index, GIT_EDITOR: ":" },
        ...timeout(limit),
    });
    if (result.timedOut) throw timedOut("commit-msg", hook, limit, tail(`${result.stdout}${result.stderr}`));
    if (result.code !== 0)
        throw new ToliError(
            `refusing: the commit-msg hook ${hook} rejected the message; nothing was committed:\n${tail(`${result.stdout}${result.stderr}`)}`,
        );
    const edited = readFileSync(file, "utf8").replace(/\s+$/, "");
    if (edited === "") throw new ToliError(`refusing: the commit-msg hook ${hook} left the message empty`);
    return edited;
}
