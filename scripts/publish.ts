// `just release [patch|minor|major|vX.Y.Z] [--dry-run] [--remote <name>]` (alias `just publish`): cut a toli release.
//
// Feature work lands on develop (`bin/toli self land`); main moves only here.
//
//   1. On develop with a clean tree, with main contained in develop and checked out nowhere, compute the version:
//      bump package.json's, or the explicit vX.Y.Z.
//   2. `bun run verify` (the full gate plus CLI smoke checks).
//   3. Bump package.json, prepend a CHANGELOG.md section grouped from the commits since the last tag.
//   4. Commit "Release vX.Y.Z" on develop, merge develop into main (a fast-forward: main never has commits of its
//      own), and create the annotated tag vX.Y.Z on that commit.
//   5. Ask "Push main, develop and vX.Y.Z to <remote>? [y/N]"; push (atomically) only on y.
//
// The first release tags the version CHANGELOG.md was seeded with: `just release v0.1.0` when package.json is
// already 0.1.0, the section exists, and no tag does (nothing to bump; the tag goes on HEAD).
// --dry-run does all of it in a temporary clone of develop and never asks or pushes; the clone is removed afterwards.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Args } from "../src/core/args.ts";
import { now, ToliError } from "../src/core/util.ts";
import {
    type Commit,
    changelogBetween,
    changelogHas,
    changelogSection,
    compareVersions,
    DEVELOP_BRANCH,
    dateChangelogSection,
    latestTag,
    nextVersion,
    parseVersion,
    prependChangelog,
    RELEASE_BRANCH,
    releaseBranchProblem,
} from "../src/release/release.ts";

const ROOT = resolve(import.meta.dir, "..");
const CHANGELOG_INTRO = "# Changelog\n";

class ReleaseError extends Error {}

const say = (line: string) => process.stdout.write(`${line}\n`);

/** Run a command and return trimmed stdout; any failure aborts the release with the command's own message. */
function capture(cwd: string, cmd: string[]): string {
    const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) {
        const detail = (result.stderr.toString() || result.stdout.toString()).trim();
        throw new ReleaseError(`${cmd.join(" ")} failed${detail ? `: ${detail}` : ""}`);
    }
    return result.stdout.toString().trim();
}

/** Run a command with live output; a non-zero exit aborts the release. */
function stream(cwd: string, cmd: string[]): void {
    say(`release: ${cmd.join(" ")}`);
    const result = Bun.spawnSync(cmd, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    if (result.exitCode !== 0) throw new ReleaseError(`${cmd.join(" ")} failed (exit ${result.exitCode})`);
}

type Plan = { current: string; version: string; tag: string; lastTag: string | null; seeded: boolean };

/** Validate the request against package.json, existing tags, and CHANGELOG.md before anything is changed. */
function plan(root: string, request: string, changelog: string): Plan {
    const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const current = typeof pkg === "object" && pkg !== null ? Reflect.get(pkg, "version") : undefined;
    if (typeof current !== "string") throw new ReleaseError('package.json has no "version"');
    const tags = capture(root, ["git", "tag", "--list", "v*"]).split("\n").filter(Boolean);
    const lastTag = latestTag(tags);
    let version: string;
    try {
        version = nextVersion(current, request);
    } catch (error) {
        throw new ReleaseError(error instanceof Error ? error.message : String(error));
    }
    const tag = `v${version}`;
    if (tags.includes(tag)) throw new ReleaseError(`tag ${tag} already exists`);
    const seeded = version === current && changelogHas(changelog, version);
    const target = parseVersion(version);
    const base = parseVersion(current);
    if (target === null || base === null) throw new ReleaseError(`bad version ${current} -> ${version}`);
    if (!seeded && compareVersions(target, base) <= 0)
        throw new ReleaseError(`${tag} is not newer than package.json's ${current}`);
    const last = lastTag === null ? null : parseVersion(lastTag);
    if (last !== null && compareVersions(target, last) <= 0)
        throw new ReleaseError(`${tag} is not newer than the latest tag ${lastTag}`);
    return { current, version, tag, lastTag, seeded };
}

function commitsSince(root: string, lastTag: string | null): Commit[] {
    const log = capture(root, [
        "git",
        "log",
        "--no-merges",
        "--format=%h%x09%s",
        lastTag ? `${lastTag}..HEAD` : "HEAD",
    ]);
    return log
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const [sha = "", ...subject] = line.split("\t");
            return { sha, subject: subject.join("\t") };
        });
}

/** The worktree that has `branch` checked out (from `git worktree list --porcelain`), or null. */
function checkedOutAt(root: string, branch: string): string | null {
    let path: string | null = null;
    for (const line of capture(root, ["git", "worktree", "list", "--porcelain"]).split("\n")) {
        if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
        else if (line === `branch refs/heads/${branch}`) return path;
    }
    return null;
}

function succeeds(root: string, cmd: string[]): boolean {
    return Bun.spawnSync(cmd, { cwd: root, stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

/** Step 1's branch rules: on develop, main exists, is contained in develop, and is checked out nowhere. */
function checkBranches(root: string): string {
    const head = Bun.spawnSync(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root });
    const current = head.exitCode === 0 ? head.stdout.toString().trim() : null;
    const main = `refs/heads/${RELEASE_BRANCH}`;
    const mainExists = succeeds(root, ["git", "show-ref", "--verify", "--quiet", main]);
    const problem = releaseBranchProblem({
        current,
        mainExists,
        mainContained:
            mainExists && succeeds(root, ["git", "merge-base", "--is-ancestor", main, `refs/heads/${DEVELOP_BRANCH}`]),
        mainCheckedOutAt: checkedOutAt(root, RELEASE_BRANCH),
    });
    if (problem !== null) throw new ReleaseError(problem);
    return capture(root, ["git", "rev-parse", main]);
}

/** Steps 1-4 in `root`; returns the tag created. */
function cutRelease(root: string, request: string): string {
    // The main this check saw: the fast-forward below is compare-and-swapped against it, so a main that moves
    // during the verify run fails the release instead of losing its new commits.
    const checkedMain = checkBranches(root);
    const dirty = capture(root, ["git", "status", "--porcelain"]);
    if (dirty !== "") throw new ReleaseError(`the working tree is not clean:\n${dirty}`);

    const changelogFile = join(root, "CHANGELOG.md");
    const changelog = existsSync(changelogFile) ? readFileSync(changelogFile, "utf8") : CHANGELOG_INTRO;
    const { current, version, tag, lastTag, seeded } = plan(root, request, changelog);
    say(
        `release: ${lastTag ?? "(no previous tag)"} -> ${tag}${seeded ? " (tagging the seeded CHANGELOG section)" : ""}`,
    );
    if (!seeded && lastTag === null && changelogHas(changelog, current))
        say(`release: note: v${current} was never tagged; \`just release v${current}\` tags it as the first release`);

    stream(root, ["bun", "run", "verify"]);

    const date = now().toISOString().slice(0, 10);
    let updated = changelog;
    if (!seeded) {
        const commits = commitsSince(root, lastTag);
        if (commits.length === 0) throw new ReleaseError(`no commits since ${lastTag}; nothing to release`);
        // A section drafted on develop (`## vX.Y.Z - unreleased`) is kept and dated; otherwise one is generated.
        updated = changelogHas(changelog, version)
            ? dateChangelogSection(changelog, version, date)
            : prependChangelog(changelog, changelogSection(version, date, commits));
        writeFileSync(changelogFile, updated);
        const pkgFile = join(root, "package.json");
        const pkgText = readFileSync(pkgFile, "utf8");
        const bumped = pkgText.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
        if (bumped === pkgText) throw new ReleaseError("could not update package.json's version");
        writeFileSync(pkgFile, bumped);
        stream(root, ["bun", "scripts/format.ts", "write", "--", "CHANGELOG.md", "package.json"]);
        stream(root, ["git", "add", "--", "CHANGELOG.md", "package.json"]);
        stream(root, ["git", "commit", "--quiet", "-m", `Release ${tag}`, "--", "CHANGELOG.md", "package.json"]);
        updated = readFileSync(changelogFile, "utf8");
    } else if (dateChangelogSection(changelog, version, date) !== changelog) {
        // The seeded section still carries a draft heading (`- unreleased`): date it in the release commit.
        writeFileSync(changelogFile, dateChangelogSection(changelog, version, date));
        stream(root, ["bun", "scripts/format.ts", "write", "--", "CHANGELOG.md"]);
        stream(root, ["git", "commit", "--quiet", "-m", `Release ${tag}`, "--", "CHANGELOG.md"]);
        updated = readFileSync(changelogFile, "utf8");
    }
    // Only this release's section: after the previous version (package.json's before the bump; the last tag when
    // tagging the seeded section). verbatim keeps the `### Added` headings git would strip as comments.
    const notes = changelogBetween(updated, seeded ? lastTag : `v${current}`, tag);
    // Merge develop into main: main is contained in develop (checked above), so this is a fast-forward of the ref,
    // compare-and-swapped against the main the check saw.
    const release = capture(root, ["git", "rev-parse", "HEAD"]);
    stream(root, ["git", "update-ref", "-m", `release ${tag}`, `refs/heads/${RELEASE_BRANCH}`, release, checkedMain]);
    say(`release: ${RELEASE_BRANCH} fast-forwarded to ${DEVELOP_BRANCH} at ${release.slice(0, 12)}`);
    stream(root, ["git", "tag", "--annotate", "--cleanup=verbatim", tag, "--message", `toli ${tag}\n\n${notes}`]);
    return tag;
}

function pushPrompt(root: string, remote: string, tag: string): void {
    const url = Bun.spawnSync(["git", "remote", "get-url", remote], { cwd: root }).stdout.toString().trim();
    const where = url === "" ? remote : `${remote} (${url})`;
    const refs = [RELEASE_BRANCH, DEVELOP_BRANCH, tag];
    const answer = prompt(`Push ${RELEASE_BRANCH}, ${DEVELOP_BRANCH} and ${tag} to ${where}? [y/N]`);
    if (answer !== null && /^y(es)?$/i.test(answer.trim())) {
        stream(root, [
            "git",
            "push",
            "--atomic",
            remote,
            `refs/heads/${RELEASE_BRANCH}`,
            `refs/heads/${DEVELOP_BRANCH}`,
            `refs/tags/${tag}`,
        ]);
        say(`release: pushed ${refs.join(", ")} to ${remote}`);
    } else {
        say(`release: not pushed. When ready: git push --atomic ${remote} ${refs.join(" ")}`);
    }
}

function dryRun(request: string, remote: string): void {
    if (capture(ROOT, ["git", "status", "--porcelain"]) !== "")
        say(`release: dry run uses the committed ${DEVELOP_BRANCH}; uncommitted changes here are not part of it`);
    const tmp = mkdtempSync(join(tmpdir(), "toli-release-"));
    const clone = join(tmp, "toli");
    try {
        say(`release: dry run in ${clone}`);
        capture(ROOT, ["git", "clone", "--quiet", "--no-hardlinks", "--branch", DEVELOP_BRANCH, ROOT, clone]);
        capture(clone, ["git", "branch", "--quiet", RELEASE_BRANCH, `origin/${RELEASE_BRANCH}`]);
        capture(clone, ["git", "config", "core.hooksPath", ".githooks"]);
        stream(clone, ["bun", "install", "--frozen-lockfile"]);
        const tag = cutRelease(clone, request);
        say("");
        say(capture(clone, ["git", "log", "-1", "--format=commit %h %s"]));
        say(
            capture(clone, ["git", "tag", "--list", tag, "--format=tag %(refname:short) (%(objecttype)): %(contents)"]),
        );
        say("");
        say(
            `release: dry run done. A real run would now ask: Push ${RELEASE_BRANCH}, ${DEVELOP_BRANCH} and ${tag} ` +
                `to ${remote}? [y/N]`,
        );
        say("release: nothing was pushed; this repository is unchanged");
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

try {
    const args = new Args(process.argv.slice(2), { booleans: ["dry-run"], values: ["remote"] });
    args.maxPositional(1);
    const request = args.positional[0] ?? "patch";
    const remote = args.str("remote") ?? "origin";
    if (args.bool("dry-run")) {
        dryRun(request, remote);
    } else {
        const tag = cutRelease(ROOT, request);
        pushPrompt(ROOT, remote, tag);
    }
} catch (error) {
    if (!(error instanceof ReleaseError || error instanceof ToliError)) throw error;
    process.stderr.write(`release: ${error.message}\n`);
    process.exit(1);
}
