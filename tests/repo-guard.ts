// Keeps the test run away from the toli checkout it runs in (T897: a run under the pre-push hook inherited the hook's
// GIT_DIR, so every `git init`/`commit` in a temp dir wrote into the real repository: 64 commits and a v1.2.3 tag).
// isolateGit() runs first in the preload, before any test file loads; realRefs() snapshots the real repository's refs
// then, and the preload fails the run at the end when refProblems() finds a test touched them.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The checkout these tests belong to. */
export const REAL_REPO = resolve(import.meta.dir, "..");

/** The author every test commit carries (GIT_ENV in tests/helpers.ts). */
export const TEST_AUTHOR_EMAIL = "test@example.com";

const REAL_GIT_DIR = join(REAL_REPO, ".git");

/**
 * Strip every inherited `GIT_*` variable (a git hook exports GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE, ...), stop git's
 * repository discovery at the OS temp dir so a temp repo can never resolve to a checkout above it, and give the run its
 * own HOME so no user-level git, ssh or toli config is read or written. Returns that HOME.
 */
export function isolateGit(): string {
    for (const name of Object.keys(process.env)) if (name.startsWith("GIT_")) delete process.env[name];
    const temp = realpathSync(tmpdir());
    process.env.GIT_CEILING_DIRECTORIES = [temp, tmpdir()].join(":");
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    const home = mkdtempSync(join(temp, "toli-home-"));
    // rustup's cargo proxy finds its toolchains under HOME; keep the real ones (read only) for the cargo checks.
    if (process.env.RUSTUP_HOME === undefined && process.env.HOME !== undefined)
        process.env.RUSTUP_HOME = join(process.env.HOME, ".rustup");
    process.env.HOME = home;
    return home;
}

function git(gitDir: string, args: string[]): { code: number; stdout: string } {
    const proc = Bun.spawnSync(["git", `--git-dir=${gitDir}`, ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString() };
}

/** `refname -> object` for every ref in a repository (default: the real one); null when it is not a git checkout. */
export function realRefs(gitDir = REAL_GIT_DIR): Map<string, string> | null {
    const listed = git(gitDir, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    if (listed.code !== 0) return null;
    const refs = new Map<string, string>();
    for (const line of listed.stdout.split("\n")) {
        const [name, object] = line.split(" ");
        if (name && object) refs.set(name, object);
    }
    return refs;
}

/**
 * What a test did to a repository between two snapshots. Other agents keep committing to this checkout while the
 * tests run (`bin/toli commit` moves `develop`), so a moved or new branch counts only when it brings in a commit by the
 * test author; a tag created, moved or deleted, or a branch deleted, always counts.
 */
export function refProblems(before: Map<string, string>, after: Map<string, string>, gitDir = REAL_GIT_DIR): string[] {
    const problems: string[] = [];
    for (const [name, object] of before)
        if (!after.has(name) && (name.startsWith("refs/tags/") || name.startsWith("refs/heads/")))
            problems.push(`${name} was deleted (was ${object.slice(0, 12)})`);
    const old = [...before.values()].map((sha) => `^${sha}`);
    for (const [name, object] of after) {
        const was = before.get(name);
        if (was === object) continue;
        if (name.startsWith("refs/tags/")) {
            problems.push(`${name} ${was === undefined ? "was created" : `moved from ${was.slice(0, 12)}`}`);
            continue;
        }
        const added = git(gitDir, ["log", "--format=%h %ae %s", object, ...old, "--"]);
        const leaked = added.stdout.split("\n").filter((line) => line.split(" ")[1] === TEST_AUTHOR_EMAIL);
        if (leaked.length > 0)
            problems.push(`${name} gained ${leaked.length} test commit(s): ${leaked.slice(0, 3).join("; ")}`);
    }
    return problems;
}
