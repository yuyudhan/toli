import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_ENV } from "./helpers.ts";

const INSTALL_SH = join(import.meta.dir, "..", "install.sh");

function git(args: string[], cwd: string): void {
    const proc = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...GIT_ENV }, stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
}

/** A bare release repository tagged v1.2.3 whose bin/toli answers `version` and `doctor`. */
function releaseRepo(base: string): string {
    const seed = join(base, "seed");
    mkdirSync(join(seed, "bin"), { recursive: true });
    writeFileSync(join(seed, "bin", "toli"), '#!/bin/sh\necho "toli v1.2.3"\n');
    chmodSync(join(seed, "bin", "toli"), 0o755);
    git(["init", "--quiet", "-b", "main"], seed);
    git(["add", "."], seed);
    git(["commit", "--quiet", "-m", "release"], seed);
    git(["tag", "v1.2.3"], seed);
    const bare = join(base, "toli.git");
    git(["clone", "--quiet", "--bare", seed, bare], base);
    return bare;
}

describe("install.sh", () => {
    test("the Cloning line shows the resolved absolute path of a relative --dir", () => {
        const base = mkdtempSync(join(tmpdir(), "toli-install-"));
        const bare = releaseRepo(base);
        mkdirSync(join(base, "work"));
        mkdirSync(join(base, "real"));
        // A symlinked parent and a not-yet-existing folder below it: both resolve before cloning.
        symlinkSync(join(base, "real"), join(base, "alias"));
        const proc = Bun.spawnSync(["sh", INSTALL_SH, "--dir", "../alias/new/toli", "--yes"], {
            cwd: join(base, "work"),
            env: { ...process.env, ...GIT_ENV, TOLI_REPO_URL: `file://${bare}` },
            stdout: "pipe",
            stderr: "pipe",
        });
        const output = proc.stdout.toString();
        expect(proc.exitCode).toBe(0);
        const expected = join(realpathSync(base), "real", "new", "toli");
        expect(output).toContain(`Cloning toli v1.2.3 into ${expected}\n`);
        expect(output).toContain(`toli v1.2.3 is installed in ${expected}\n`);
    });
});
