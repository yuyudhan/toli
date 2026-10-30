// `just release [patch|minor|major|vX.Y.Z] [--dry-run] [--remote <name>]` (alias `just publish`): cut a toli release.
//
//   1. On main with a clean tree, compute the version: bump package.json's, or the explicit vX.Y.Z.
//   2. `bun run verify` (the full gate plus CLI smoke checks).
//   3. Bump package.json, prepend a CHANGELOG.md section grouped from the commits since the last tag.
//   4. Commit "Release vX.Y.Z" and create the annotated tag vX.Y.Z.
//   5. Ask "Push main and vX.Y.Z to <remote>? [y/N]"; push (atomically) only on y.
//
// The first release tags the version CHANGELOG.md was seeded with: `just release v0.1.0` when package.json is
// already 0.1.0, the section exists, and no tag does (nothing to bump; the tag goes on HEAD).
// --dry-run does all of it in a temporary clone of HEAD and never asks or pushes; the clone is removed afterwards.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Args } from "../src/args.ts";
import {
    type Commit,
    changelogBetween,
    changelogHas,
    changelogSection,
    compareVersions,
    latestTag,
    nextVersion,
    parseVersion,
    prependChangelog,
} from "../src/release.ts";
import { now, ToliError } from "../src/util.ts";

const ROOT = resolve(import.meta.dir, "..");
const RELEASE_BRANCH = "main";
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

/** Steps 1-4 in `root`; returns the tag created. */
function cutRelease(root: string, request: string): string {
    const branch = Bun.spawnSync(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root });
    if (branch.stdout.toString().trim() !== RELEASE_BRANCH)
        throw new ReleaseError(`releases are cut from ${RELEASE_BRANCH}; check it out first`);
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

    let updated = changelog;
    if (!seeded) {
        const commits = commitsSince(root, lastTag);
        if (commits.length === 0) throw new ReleaseError(`no commits since ${lastTag}; nothing to release`);
        updated = prependChangelog(changelog, changelogSection(version, now().toISOString().slice(0, 10), commits));
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
    }
    // Only this release's section: after the previous version (package.json's before the bump; the last tag when
    // tagging the seeded section). verbatim keeps the `### Added` headings git would strip as comments.
    const notes = changelogBetween(updated, seeded ? lastTag : `v${current}`, tag);
    stream(root, ["git", "tag", "--annotate", "--cleanup=verbatim", tag, "--message", `toli ${tag}\n\n${notes}`]);
    return tag;
}

function pushPrompt(root: string, remote: string, tag: string): void {
    const url = Bun.spawnSync(["git", "remote", "get-url", remote], { cwd: root }).stdout.toString().trim();
    const where = url === "" ? remote : `${remote} (${url})`;
    const answer = prompt(`Push ${RELEASE_BRANCH} and ${tag} to ${where}? [y/N]`);
    if (answer !== null && /^y(es)?$/i.test(answer.trim())) {
        stream(root, ["git", "push", "--atomic", remote, `refs/heads/${RELEASE_BRANCH}`, `refs/tags/${tag}`]);
        say(`release: pushed ${RELEASE_BRANCH} and ${tag} to ${remote}`);
    } else {
        say(`release: not pushed. When ready: git push --atomic ${remote} ${RELEASE_BRANCH} ${tag}`);
    }
}

function dryRun(request: string, remote: string): void {
    if (capture(ROOT, ["git", "status", "--porcelain"]) !== "")
        say("release: dry run uses the committed HEAD; uncommitted changes here are not part of it");
    const tmp = mkdtempSync(join(tmpdir(), "toli-release-"));
    const clone = join(tmp, "toli");
    try {
        say(`release: dry run in ${clone}`);
        capture(ROOT, ["git", "clone", "--quiet", "--no-hardlinks", ROOT, clone]);
        capture(clone, ["git", "config", "core.hooksPath", ".githooks"]);
        stream(clone, ["bun", "install", "--frozen-lockfile"]);
        const tag = cutRelease(clone, request);
        say("");
        say(capture(clone, ["git", "log", "-1", "--format=commit %h %s"]));
        say(
            capture(clone, ["git", "tag", "--list", tag, "--format=tag %(refname:short) (%(objecttype)): %(contents)"]),
        );
        say("");
        say(`release: dry run done. A real run would now ask: Push ${RELEASE_BRANCH} and ${tag} to ${remote}? [y/N]`);
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
