import { chmodSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, tempDir } from "./helpers.ts";

/** The release tags every release install's origin carries, oldest first; v0.3.0-rc.1 is a pre-release. */
const RELEASES = ["v0.1.0", "v0.2.0", "v0.3.0-rc.1"];

/** What a real install ignores (private data and per-machine state), plus the sandbox's stubs and ls-remote log. */
const GITIGNORE = "/data/\n/state/\n/config/\n/logs/\n/.stubs/\n/ls-remote.log\n";

/** A CHANGELOG.md with one section per version, newest first. */
export function changelog(versions: string[]): string {
    const sections = versions.map((version) => `## ${version} - 2026-10-30\n\n### Added\n\n- Feature of ${version}\n`);
    return `# Changelog\n\n${sections.join("\n")}`;
}

/** The shared origin, and one finished install per installed tag asked for in this run. */
let origin: string | null = null;
const templates = new Map<string, string>();

/**
 * A bare origin with tags v0.1.0, v0.2.0 and v0.3.0-rc.1; each release's package.json carries its version, its
 * CHANGELOG.md every section up to it, and bin/toli is a stub that echoes its args. Built once per run: no test
 * writes to it (upgrades and update checks only read it).
 */
function releaseOrigin(box: Sandbox): string {
    if (origin !== null) return origin;
    const dir = tempDir("release-origin");
    const bare = join(dir, "toli.git");
    const seed = join(dir, "seed");
    mkdirSync(bare);
    mkdirSync(join(seed, "bin"), { recursive: true });
    box.git(bare, ["init", "--bare", "--initial-branch=main"]);
    box.git(seed, ["init", "--initial-branch=main"]);
    writeFileSync(join(seed, ".gitignore"), GITIGNORE);
    writeFileSync(join(seed, "bin", "toli"), '#!/bin/sh\necho "fake toli $*"\n');
    chmodSync(join(seed, "bin", "toli"), 0o755);
    const released: string[] = [];
    for (const version of RELEASES) {
        released.unshift(version);
        writeFileSync(join(seed, "package.json"), `{ "version": "${version.slice(1)}" }\n`);
        writeFileSync(join(seed, "CHANGELOG.md"), changelog(released));
        box.git(seed, ["add", "-A"]);
        box.git(seed, ["commit", "-m", `Release ${version}`]);
        box.git(seed, ["tag", "--annotate", version, "--message", version]);
    }
    box.git(seed, ["push", "--quiet", bare, "main", "--tags"]);
    origin = bare;
    return bare;
}

/**
 * Make `box.root` a release install: a clone of the shared origin checked out detached at `installed`, with only
 * that tag fetched. Building one costs ~20 git processes (over 10 s per test on a loaded machine), so each install
 * is built once per run and copied into every sandbox that asks for it, which spawns nothing. The copy is a whole
 * clone: a test may move its HEAD, tags, remote or files without touching the template or any other test.
 */
export function releaseInstall(box: Sandbox, installed: string): void {
    const remote = releaseOrigin(box);
    let template = templates.get(installed);
    if (template === undefined) {
        template = tempDir("release-install");
        box.git(template, ["init", "--initial-branch=main"]);
        box.git(template, ["remote", "add", "origin", remote]);
        box.git(template, ["fetch", "--quiet", "origin", `refs/tags/${installed}:refs/tags/${installed}`]);
        box.git(template, ["checkout", "--quiet", "--detach", installed]);
        templates.set(installed, template);
    }
    cpSync(template, box.root, { recursive: true });
}
