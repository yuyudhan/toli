import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    describeInstalled,
    installedVersion,
    releaseRemote,
    upgradeBlockers,
    versionCommand,
} from "../src/release/upgrade.ts";
import { commandIn, type Sandbox, sandbox } from "./helpers.ts";

// Each test builds a release repo with ~20 git processes plus several bin/toli runs (~1.5 s idle); under a loaded
// machine that can pass Bun's 5 s default, so this file allows 20 s per test.
setDefaultTimeout(20_000);

const FAKE_TOLI = '#!/bin/sh\necho "fake toli $*"\n';

function changelog(versions: string[]): string {
    const sections = versions.map((version) => `## ${version} - 2026-10-30\n\n### Added\n\n- Feature of ${version}\n`);
    return `# Changelog\n\n${sections.join("\n")}`;
}

/**
 * The sandbox root as a release install: an `origin` bare repo with tags v0.1.0, v0.2.0 and the pre-release
 * v0.3.0-rc.1, and the root checked out detached at v0.1.0. bin/toli in the release is a stub that echoes its args.
 */
function releaseInstall(): Sandbox {
    const box = sandbox();
    const origin = join(box.root, ".origin", "toli.git");
    const seed = join(box.root, ".seed");
    mkdirSync(origin, { recursive: true });
    mkdirSync(join(seed, "bin"), { recursive: true });
    box.git(origin, ["init", "--bare", "--initial-branch=main"]);
    box.git(seed, ["init", "--initial-branch=main"]);
    writeFileSync(join(seed, ".gitignore"), "/data/\n/.stubs/\n/.origin/\n/.seed/\n");
    writeFileSync(join(seed, "bin", "toli"), FAKE_TOLI);
    chmodSync(join(seed, "bin", "toli"), 0o755);
    const released: string[] = [];
    for (const version of ["v0.1.0", "v0.2.0", "v0.3.0-rc.1"]) {
        released.unshift(version);
        writeFileSync(join(seed, "package.json"), `{ "version": "${version.slice(1)}" }\n`);
        writeFileSync(join(seed, "CHANGELOG.md"), changelog(released));
        box.git(seed, ["add", "-A"]);
        box.git(seed, ["commit", "-m", `Release ${version}`]);
        box.git(seed, ["tag", "--annotate", version, "--message", version]);
    }
    box.git(seed, ["push", "--quiet", origin, "main", "--tags"]);
    box.git(box.root, ["init", "--initial-branch=main"]);
    box.git(box.root, ["remote", "add", "origin", origin]);
    box.git(box.root, ["fetch", "--quiet", "origin", "refs/tags/v0.1.0:refs/tags/v0.1.0"]);
    box.git(box.root, ["checkout", "--quiet", "--detach", "v0.1.0"]);
    mkdirSync(join(box.root, "data"));
    writeFileSync(join(box.root, "data", "preferences.md"), "private\n");
    return box;
}

const headTag = (box: Sandbox) => box.git(box.root, ["describe", "--tags", "--exact-match", "HEAD"]);

describe("bin/toli version", () => {
    test("prints the release tag the checkout sits on", () => {
        const box = releaseInstall();
        expect(box.ok(["version"])).toBe("toli v0.1.0");
        expect(JSON.parse(box.ok(["version", "--json"]))).toMatchObject({
            tag: "v0.1.0",
            version: "0.1.0",
            branch: null,
        });
    });
});

describe("bin/toli upgrade", () => {
    test("--check shows current and latest (pre-releases ignored) without moving HEAD", () => {
        const box = releaseInstall();
        const output = box.ok(["upgrade", "--check"]);
        expect(output).toContain("current: v0.1.0");
        expect(output).toContain("latest:  v0.2.0");
        expect(output).toContain("upgrade available: bin/toli upgrade");
        expect(headTag(box)).toBe("v0.1.0");
    });

    test("checks out the latest tag, runs migrate and harness sync, prints the changelog in between", () => {
        const box = releaseInstall();
        const output = box.ok(["upgrade"]);
        expect(headTag(box)).toBe("v0.2.0");
        expect(output).toContain("checked out v0.2.0");
        expect(output).toContain("fake toli migrate");
        expect(output).toContain("fake toli harness sync");
        expect(output).toContain("## v0.2.0 - 2026-10-30");
        expect(output).not.toContain("## v0.1.0");
        expect(output).toContain("toli upgraded: v0.1.0 -> v0.2.0");
        expect(readFileSync(join(box.root, "data", "preferences.md"), "utf8")).toBe("private\n");
        expect(box.ok(["upgrade"])).toContain("toli is already at v0.2.0");
    });

    test("an explicit tag, including a pre-release, is installed when it exists", () => {
        const box = releaseInstall();
        box.ok(["upgrade", "v0.3.0-rc.1"]);
        expect(headTag(box)).toBe("v0.3.0-rc.1");
    });

    test("refuses an unknown tag", () => {
        const box = releaseInstall();
        const result = box.toli(["upgrade", "v9.9.9"]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("unknown release tag v9.9.9");
        expect(result.stderr).toContain("v0.2.0");
        expect(box.toli(["upgrade", "latest-please"]).stderr).toContain("is not a release tag vX.Y.Z");
        expect(headTag(box)).toBe("v0.1.0");
    });

    test("refuses when tracked files are dirty; untracked and private files do not count", () => {
        const box = releaseInstall();
        writeFileSync(join(box.root, "notes.txt"), "untracked\n");
        writeFileSync(join(box.root, "CHANGELOG.md"), "edited\n");
        const result = box.toli(["upgrade"]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("tracked files have local changes");
        expect(result.stderr).toContain("CHANGELOG.md");
        expect(headTag(box)).toBe("v0.1.0");
        box.git(box.root, ["checkout", "--", "CHANGELOG.md"]);
        box.ok(["upgrade"]);
        expect(existsSync(join(box.root, "notes.txt"))).toBe(true);
    });

    test("refuses on a branch (a development clone)", () => {
        const box = releaseInstall();
        box.git(box.root, ["switch", "--quiet", "--create", "main"]);
        const result = box.toli(["upgrade"]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('HEAD is on branch "main"');
    });
});

describe("version and upgrade checks in process", () => {
    test("describe the install, its release remote, and what blocks an upgrade", () => {
        const box = releaseInstall();
        const version = commandIn(box.root, versionCommand);
        expect(version([])).toBe("toli v0.1.0");
        expect(JSON.parse(version(["--json"]))).toMatchObject({ tag: "v0.1.0", version: "0.1.0", branch: null });
        expect(releaseRemote(box.root)).toBe("origin");
        expect(upgradeBlockers(box.root)).toEqual([]);

        writeFileSync(join(box.root, "CHANGELOG.md"), "edited\n");
        box.git(box.root, ["switch", "--quiet", "--create", "main"]);
        const installed = installedVersion(box.root);
        expect(installed).toMatchObject({ tag: "v0.1.0", branch: "main" });
        expect(describeInstalled({ ...installed, tag: null })).toBe(`0.1.0 (untagged: main @ ${installed.commit})`);
        expect(describeInstalled({ ...installed, tag: null, branch: null })).toContain("(untagged: detached @");
        expect(upgradeBlockers(box.root)).toEqual([
            "tracked files have local changes; commit or move them first:\n  M CHANGELOG.md",
            'HEAD is on branch "main"; upgrade moves release installs (detached at a vX.Y.Z tag). On a development clone use git directly.',
        ]);
        expect(() => installedVersion(mkdtempSync(join(tmpdir(), "toli-not-git-")))).toThrow("is not a git checkout");
    });
});
