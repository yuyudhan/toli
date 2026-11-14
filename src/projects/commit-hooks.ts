// The project's own git hooks as `bin/toli commit` (src/projects/commit.ts) runs them on its private index:
// pre-commit on exactly the commit being made, then commit-msg on its message.
import { accessSync, constants, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { gitOk } from "../core/git.ts";
import { run, ToliError } from "../core/util.ts";
import { type Attempt, tail } from "./commit-checks.ts";

const HOOK_TIMEOUT_MS = 300_000;

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
 * Run the repo's pre-commit hook on exactly the commit being made, and refuse when it exits non-zero or changes what
 * is committed. Its working tree is the private index's files written out (Attempt.staged), made a linked repository
 * of its own (Attempt.linkStaged: HEAD and objects the checkout's, index the private one), so `git diff --cached`
 * lists only the named paths and every file it reads is the committed version, even for a hook that unsets GIT_DIR,
 * GIT_WORK_TREE and GIT_INDEX_FILE: other jawans' staged or half-edited files in the shared checkout can neither fail
 * nor pass it. A hook file that is tracked runs as committed; the checkout's top-level ignored entries (node_modules, a
 * virtualenv) are linked in so its tools resolve. A hook that reformats or re-stages a file is refused rather than
 * followed: the commit would then differ from the working tree. A missing or non-executable hook is skipped, as git
 * skips it.
 */
export function preCommitHook(attempt: Attempt): void {
    const hook = hookPath(attempt, "pre-commit");
    if (!executable(hook)) return;
    const root = gitOk(attempt.dir, ["rev-parse", "--show-toplevel"]);
    const tree = attempt.staged();
    const rel = relative(root, hook);
    const inside = !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    const program = inside && executable(join(tree, rel)) ? join(tree, rel) : hook;
    const shown = inside ? rel : hook;
    const ignored = attempt.git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
    for (const entry of ignored.code === 0 ? ignored.stdout.split("\0") : []) {
        const name = entry.replace(/\/$/, "");
        if (name === "" || name.includes("/") || existsSync(join(tree, name))) continue;
        symlinkSync(join(root, name), join(tree, name));
    }
    const before = attempt.gitOk(["write-tree"]);
    const env = { GIT_DIR: attempt.linkStaged(), GIT_WORK_TREE: tree, GIT_INDEX_FILE: attempt.index };
    const result = run([program], { cwd: tree, env, timeoutMs: HOOK_TIMEOUT_MS });
    const output = tail(`${result.stdout}${result.stderr}`);
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
 * skips it.
 */
export function commitMsgHook(attempt: Attempt, message: string): string {
    const hook = hookPath(attempt, "commit-msg");
    if (!executable(hook)) return message;
    const file = attempt.file("COMMIT_EDITMSG");
    writeFileSync(file, `${message}\n`);
    const result = run([hook, file], {
        cwd: attempt.dir,
        env: { GIT_INDEX_FILE: attempt.index, GIT_EDITOR: ":" },
        timeoutMs: HOOK_TIMEOUT_MS,
    });
    if (result.code !== 0)
        throw new ToliError(
            `refusing: the commit-msg hook ${hook} rejected the message; nothing was committed:\n${tail(`${result.stdout}${result.stderr}`)}`,
        );
    const edited = readFileSync(file, "utf8").replace(/\s+$/, "");
    if (edited === "") throw new ToliError(`refusing: the commit-msg hook ${hook} left the message empty`);
    return edited;
}
