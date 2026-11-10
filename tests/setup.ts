// Preloaded by bunfig.toml: runs before any test file loads; a top-level hook here runs once, after every test file.
import { afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { removeTempDirs } from "./helpers.ts";
import { isolateGit, REAL_REPO, realRefs, refProblems } from "./repo-guard.ts";

const home = isolateGit();
const before = realRefs();

afterAll(() => {
    removeTempDirs();
    rmSync(home, { recursive: true, force: true });
    if (before === null) return;
    const after = realRefs();
    const problems = after === null ? [`${REAL_REPO} is no longer a git repository`] : refProblems(before, after);
    if (problems.length > 0)
        throw new Error(`the tests changed the real repository at ${REAL_REPO}:\n${problems.join("\n")}`);
});
