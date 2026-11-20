// Preloaded by bunfig.toml: runs before any test file loads; a top-level hook here runs around every test, or once
// after every test file.
import { afterAll, afterEach, beforeEach } from "bun:test";
import { join } from "node:path";
import { beginTestTemps, endTestTemps, removeTempDirs } from "./helpers.ts";
import { isolateGit, REAL_REPO, realRefs, refProblems } from "./repo-guard.ts";
import { sweepDeadRunTemps } from "./temp-dirs.ts";

// Temp dirs an earlier run left when it was killed before its own cleanup (T2150); ssh.test.ts makes its under /tmp.
sweepDeadRunTemps();
sweepDeadRunTemps("/tmp");
const home = isolateGit();
// The host's /Library/LaunchDaemons may hold toli's own jobs (a machine running them as LaunchDaemons): never read it.
process.env.TOLI_LAUNCH_DAEMONS_DIR = join(home, "LaunchDaemons");
const before = realRefs();

// Each test's temp dirs go when it ends, so a run never piles up a folder per test (tests/helpers.ts tempDir).
beforeEach(beginTestTemps);
afterEach(endTestTemps);
// A test that exits the process (process.exit) or a run stopped by a signal skips afterAll: clean up on the way out.
process.on("exit", removeTempDirs);
for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
] as const)
    process.on(signal, () => process.exit(code));

afterAll(() => {
    removeTempDirs();
    if (before === null) return;
    const after = realRefs();
    const problems = after === null ? [`${REAL_REPO} is no longer a git repository`] : refProblems(before, after);
    if (problems.length > 0)
        throw new Error(`the tests changed the real repository at ${REAL_REPO}:\n${problems.join("\n")}`);
});
