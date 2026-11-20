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
 * Remove the repository-locating git variables from `env` (default: this process's); returns the names that were set,
 * in list order. A child gets the result only when its spawn passes `env` (Bun hands one without it, and a Worker, the
 * environment the process started with; the spawn-env guard enforces it). A variable toli sets on purpose (a commit's
 * private GIT_INDEX_FILE) is passed to that one child explicitly and is unaffected.
 */
export function dropInheritedGitEnv(env: Record<string, string | undefined> = process.env): string[] {
    const set = REPO_LOCATING_GIT_ENV.filter((name) => (env[name] ?? "") !== "");
    for (const name of REPO_LOCATING_GIT_ENV) delete env[name];
    return set;
}

/**
 * This process's environment as a Worker's `env` option takes it. Bun starts a Worker given no `env` with the
 * environment the process started with, the git variables dropInheritedGitEnv removed included.
 */
export function workerEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
    return env;
}
