/**
 * The variables that point git at a repository, index or object store other than the one it finds from its working
 * directory. Toli addresses every repository by path (`git -C <dir>`, a cwd), so an inherited one only misleads: a
 * shell that once exported GIT_INDEX_FILE made toli read and stage into a scratch index for hours (T2052).
 */
const REPO_LOCATING_GIT_ENV: readonly string[] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
];

/**
 * Remove the repository-locating git variables from `env` (default: this process's, so no program toli starts, by
 * any spawn API, inherits them); returns the names that were set, in list order. A variable toli sets on purpose (a
 * commit's private GIT_INDEX_FILE) is passed to that one child explicitly and is unaffected.
 */
export function dropInheritedGitEnv(env: Record<string, string | undefined> = process.env): string[] {
    const set = REPO_LOCATING_GIT_ENV.filter((name) => (env[name] ?? "") !== "");
    for (const name of REPO_LOCATING_GIT_ENV) delete env[name];
    return set;
}
