import { existsSync } from "node:fs";
import { join } from "node:path";
import { type RunResult, run, ToliError } from "./util.ts";

export function git(dir: string, args: string[], stdin?: string): RunResult {
    return run(["git", "-C", dir, ...args], stdin === undefined ? {} : { stdin });
}

/** Run git and return trimmed stdout, throwing a ToliError with git's own message on failure. */
export function gitOk(dir: string, args: string[]): string {
    const result = git(dir, args);
    if (result.code !== 0) {
        const detail = (result.stderr || result.stdout).trim();
        throw new ToliError(`git ${args.join(" ")} failed in ${dir}${detail ? `: ${detail}` : ""}`);
    }
    return result.stdout.trim();
}

/** The names of a `-z` path listing: NUL-separated, never C-quoted the way core.quotePath quotes non-ASCII names. */
export function nulPaths(stdout: string): string[] {
    return stdout.split("\0").filter(Boolean);
}

/**
 * Run a git command that lists paths with `-z` and return the names as git stores them (see nulPaths); stdout is not
 * trimmed, which would eat a name's leading or trailing spaces. Throws like gitOk.
 */
export function gitPaths(dir: string, args: string[]): string[] {
    const result = git(dir, args);
    if (result.code !== 0) {
        const detail = (result.stderr || result.stdout).trim();
        throw new ToliError(`git ${args.join(" ")} failed in ${dir}${detail ? `: ${detail}` : ""}`);
    }
    return nulPaths(result.stdout);
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The commit `rev` names in `dir`, or null when git says there is none. Its output is checked to be a full sha: on a
 * loaded machine a successful child's stdout has been seen to arrive empty, so an empty or malformed answer is read
 * once more (rev-parse is read-only) and then refused, never returned as a sha.
 */
export function resolveSha(dir: string, rev: string): string | null {
    const args = ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`];
    let printed = "";
    for (let attempt = 0; attempt < 2; attempt++) {
        const result = git(dir, args);
        if (result.code !== 0) return null;
        printed = result.stdout.trim();
        if (SHA.test(printed)) return printed;
    }
    throw new ToliError(
        `git ${args.join(" ")} in ${dir} succeeded twice but printed ${printed === "" ? "nothing" : `"${printed}"`} instead of a commit sha`,
    );
}

/** The commit `rev` (default HEAD) names in `dir`; throws when there is none. See resolveSha. */
export function headSha(dir: string, rev = "HEAD"): string {
    const sha = resolveSha(dir, rev);
    if (sha === null) throw new ToliError(`git rev-parse ${rev} failed in ${dir}: no such commit`);
    return sha;
}

/**
 * The tree object of the commit `rev` (default HEAD) names in `dir`: what the commit contains, whatever its parents,
 * message or author. Two commits with the same tree hold byte-identical files. Checked like resolveSha.
 */
export function treeSha(dir: string, rev = "HEAD"): string {
    const args = ["rev-parse", "--verify", "--quiet", `${rev}^{tree}`];
    let printed = "";
    for (let attempt = 0; attempt < 2; attempt++) {
        const result = git(dir, args);
        if (result.code !== 0) throw new ToliError(`git rev-parse ${rev}^{tree} failed in ${dir}: no such commit`);
        printed = result.stdout.trim();
        if (SHA.test(printed)) return printed;
    }
    throw new ToliError(
        `git ${args.join(" ")} in ${dir} succeeded twice but printed ${printed === "" ? "nothing" : `"${printed}"`} instead of a tree sha`,
    );
}

/** `git <args>` asked a yes/no question by exit status: 0 no, 1 yes, anything else an error. */
function differs(dir: string, args: string[]): boolean {
    const result = git(dir, args);
    if (result.code === 0) return false;
    if (result.code === 1) return true;
    const detail = result.stderr.trim();
    throw new ToliError(`git ${args.join(" ")} failed in ${dir}${detail ? `: ${detail}` : ""}`);
}

export type DirtyOptions = {
    /** Count untracked files (default true). */
    untracked?: boolean;
    /** Count ignored files too, as untracked ones (default false). */
    ignored?: boolean;
    /** Only these paths (default the whole checkout). */
    paths?: string[];
};

/**
 * Whether the checkout in `dir` differs from its HEAD commit: changed tracked files (staged or not) and, unless
 * `untracked` is false, untracked files that are not ignored (any untracked file with `ignored`). Tracked changes are
 * decided by `git diff --quiet` exit statuses, never by reading stdout, so output lost on a loaded machine can never
 * make a dirty tree look clean; the untracked listing has no such status, so an empty one is read twice before it
 * counts as none.
 */
export function checkoutDirty(dir: string, options: DirtyOptions = {}): boolean {
    const only = options.paths === undefined ? [] : ["--", ...options.paths];
    if (differs(dir, ["diff", "--quiet", ...only]) || differs(dir, ["diff", "--cached", "--quiet", ...only]))
        return true;
    if (options.untracked === false) return false;
    const args = ["ls-files", "--others", ...(options.ignored === true ? [] : ["--exclude-standard"]), "-z", ...only];
    for (let attempt = 0; attempt < 2; attempt++) {
        const listed = git(dir, args);
        if (listed.code !== 0)
            throw new ToliError(`git ls-files --others failed in ${dir}: ${listed.stderr.trim() || "no detail"}`);
        if (listed.stdout !== "") return true;
    }
    return false;
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
