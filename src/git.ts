import { existsSync } from "node:fs";
import { join } from "node:path";
import { MateError, type RunResult, run } from "./util.ts";

export function git(dir: string, args: string[], stdin?: string): RunResult {
    return run(["git", "-C", dir, ...args], stdin === undefined ? {} : { stdin });
}

/** Run git and return trimmed stdout, throwing a MateError with git's own message on failure. */
export function gitOk(dir: string, args: string[]): string {
    const result = git(dir, args);
    if (result.code !== 0) {
        const detail = (result.stderr || result.stdout).trim();
        throw new MateError(`git ${args.join(" ")} failed in ${dir}${detail ? `: ${detail}` : ""}`);
    }
    return result.stdout.trim();
}

export function isGitRepo(dir: string): boolean {
    return existsSync(join(dir, ".git"));
}

export type RepoStatus = {
    branch: string;
    dirty: boolean;
    upstream: string | null;
    ahead: number | null;
    behind: number | null;
};

/** The checked-out branch, or null on a detached HEAD. */
export function currentBranch(dir: string): string | null {
    const result = git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return result.code === 0 ? result.stdout.trim() : null;
}

export function repoStatus(dir: string): RepoStatus {
    const branch = currentBranch(dir) ?? `(detached ${gitOk(dir, ["rev-parse", "--short", "HEAD"])})`;
    const dirty = gitOk(dir, ["status", "--porcelain"]) !== "";
    const upstreamResult = git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if (upstreamResult.code !== 0) return { branch, dirty, upstream: null, ahead: null, behind: null };
    const counts = gitOk(dir, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]).split(/\s+/);
    return {
        branch,
        dirty,
        upstream: upstreamResult.stdout.trim(),
        behind: Number(counts[0]),
        ahead: Number(counts[1]),
    };
}

/**
 * Local branches carrying commits that exist nowhere else: ahead of their upstream, or (without an upstream)
 * not on origin's default branch, falling back to "not on any remote-tracking ref".
 */
export function unpushedBranches(dir: string): string[] {
    const refs = gitOk(dir, ["for-each-ref", "--format=%(refname:short)%09%(upstream:short)", "refs/heads"]);
    const originHead = git(dir, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD"]).code === 0;
    const unpushed: string[] = [];
    for (const line of refs.split("\n")) {
        if (line === "") continue;
        const [branch = "", upstream = ""] = line.split("\t");
        let range: string[];
        if (upstream !== "" && git(dir, ["rev-parse", "--verify", "--quiet", upstream]).code === 0) {
            range = [`${upstream}..${branch}`];
        } else if (originHead) {
            range = [`refs/remotes/origin/HEAD..${branch}`];
        } else {
            range = [branch, "--not", "--remotes"];
        }
        const count = Number(gitOk(dir, ["rev-list", "--count", ...range]));
        if (count > 0) unpushed.push(`${branch} (${count} commit${count === 1 ? "" : "s"})`);
    }
    return unpushed;
}
