import { Args } from "./args.ts";
import { currentBranch, git, gitOk } from "./git.ts";
import { findProject, projectCloneDir } from "./projects.ts";
import { out, ToliError } from "./util.ts";

// Word boundaries keep human sign-offs such as "<dev@gmail.com>" (contains "ai") intact.
const AI_TRAILER = /^(Co-authored-by|Co-Authored-By|Generated-by|Signed-off-by: .*\b(Claude|GPT|AI|omp|Oh My Pi)\b).*/i;

/** Remove AI attribution trailer lines, then trailing blank lines. */
export function stripAiTrailers(message: string): string {
    const lines = message.split(/\r?\n/).filter((line) => !AI_TRAILER.test(line.trim()));
    while (lines.length > 0 && (lines[lines.length - 1] as string).trim() === "") lines.pop();
    return lines.join("\n");
}

/** Refuse when the project has a fixed working branch and the clone is on another one (or detached). */
function requireWorkingBranch(name: string, dir: string): void {
    const expected = findProject(name).branch;
    if (!expected) return;
    const actual = currentBranch(dir);
    if (actual === expected) return;
    throw new ToliError(
        `refusing: projects/${name} is on ${actual === null ? "a detached HEAD" : `"${actual}"`}, but its working branch is "${expected}". ` +
            `If this work belongs on "${expected}", switch first (git -C ${dir} switch ${expected}, only with a clean tree); ` +
            `otherwise ask Malik, and change the setting only on his word (bin/toli project set ${name} --branch <b>|none).`,
    );
}

export function commitCommand(argv: string[]): void {
    const args = new Args(argv, { values: ["message"] });
    args.maxPositional(1);
    const name = args.pos(0, "project");
    const dir = projectCloneDir(name);
    requireWorkingBranch(name, dir);
    const raw = args.str("message");
    if (raw === undefined) throw new ToliError('commit needs -m "<message>"');
    const message = stripAiTrailers(raw);
    if (message.trim() === "") throw new ToliError("commit message is empty after removing AI trailers");
    const files = args.rest.filter((file) => file !== "");
    if (files.length === 0)
        throw new ToliError('commit needs paths after --: toli commit <project> -m "..." -- <path>...');
    gitOk(dir, ["add", "--", ...files]);
    // --only commits exactly these paths even when other paths are staged by other jawans in the same toli.
    const commit = git(dir, ["commit", "--only", "-m", message, "--", ...files]);
    if (commit.code !== 0) throw new ToliError(`git commit failed: ${(commit.stderr || commit.stdout).trim()}`);
    out(gitOk(dir, ["rev-parse", "HEAD"]));
}

export function branchCommand(argv: string[]): void {
    const args = new Args(argv);
    args.maxPositional(2);
    const dir = projectCloneDir(args.pos(0, "project"));
    const branch = args.pos(1, "branch");
    gitOk(dir, ["check-ref-format", "--branch", branch]);
    const result = git(dir, ["switch", "-c", branch]);
    if (result.code !== 0)
        throw new ToliError(`git switch -c ${branch} failed: ${(result.stderr || result.stdout).trim()}`);
    out(`switched to new branch ${branch} in ${dir}`);
}
