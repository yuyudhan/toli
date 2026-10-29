import { Args } from "./args.ts";
import { git, gitOk } from "./git.ts";
import { projectCloneDir } from "./projects.ts";
import { MateError, out } from "./util.ts";

// Word boundaries keep human sign-offs such as "<dev@gmail.com>" (contains "ai") intact.
const AI_TRAILER = /^(Co-authored-by|Co-Authored-By|Generated-by|Signed-off-by: .*\b(Claude|GPT|AI|omp|Oh My Pi)\b).*/i;

/** Remove AI attribution trailer lines, then trailing blank lines. */
export function stripAiTrailers(message: string): string {
    const lines = message.split(/\r?\n/).filter((line) => !AI_TRAILER.test(line.trim()));
    while (lines.length > 0 && (lines[lines.length - 1] as string).trim() === "") lines.pop();
    return lines.join("\n");
}

export function commitCommand(argv: string[]): void {
    const args = new Args(argv, { values: ["message"] });
    args.maxPositional(1);
    const dir = projectCloneDir(args.pos(0, "project"));
    const raw = args.str("message");
    if (raw === undefined) throw new MateError('commit needs -m "<message>"');
    const message = stripAiTrailers(raw);
    if (message.trim() === "") throw new MateError("commit message is empty after removing AI trailers");
    const files = args.rest.filter((file) => file !== "");
    if (files.length === 0)
        throw new MateError('commit needs paths after --: mate commit <project> -m "..." -- <path>...');
    gitOk(dir, ["add", "--", ...files]);
    // --only commits exactly these paths even when other paths are staged by parallel crew.
    const commit = git(dir, ["commit", "--only", "-m", message, "--", ...files]);
    if (commit.code !== 0) throw new MateError(`git commit failed: ${(commit.stderr || commit.stdout).trim()}`);
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
        throw new MateError(`git switch -c ${branch} failed: ${(result.stderr || result.stdout).trim()}`);
    out(`switched to new branch ${branch} in ${dir}`);
}
