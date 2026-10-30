import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Args } from "../core/args.ts";
import { currentBranch, git, gitOk, isGitRepo } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { out, printJson, runInherit, ToliError } from "../core/util.ts";
import {
    changelogBetween,
    compareVersions,
    latestTag,
    parseVersion,
    releaseTags,
    tagsFromLsRemote,
    toliRepoUrl,
} from "./release.ts";

export type Installed = {
    /** The release tag HEAD sits exactly on, or null on an untagged commit. */
    tag: string | null;
    /** package.json `version` of the checked-out tree. */
    version: string;
    commit: string;
    branch: string | null;
};

function packageVersion(root: string): string {
    const file = join(root, "package.json");
    if (!existsSync(file)) return "unknown";
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const version = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "version") : undefined;
    return typeof version === "string" ? version : "unknown";
}

/** What this toli checkout is: its release tag (if HEAD is exactly on one), version, commit, branch. */
export function installedVersion(root: string): Installed {
    if (!isGitRepo(root)) throw new ToliError(`${root} is not a git checkout`);
    const pointing = gitOk(root, ["tag", "--points-at", "HEAD", "--list", "v*"]).split("\n").filter(Boolean);
    return {
        tag: latestTag(pointing, { prerelease: true }),
        version: packageVersion(root),
        commit: gitOk(root, ["rev-parse", "--short", "HEAD"]),
        branch: currentBranch(root),
    };
}

/** `v0.2.0`, or `0.2.0 (untagged: main @ abc1234)` off a release tag. */
export function describeInstalled(installed: Installed): string {
    if (installed.tag !== null) return installed.tag;
    const where = installed.branch ?? "detached";
    return `${installed.version} (untagged: ${where} @ ${installed.commit})`;
}

export function versionCommand(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const installed = installedVersion(paths.root());
    if (args.bool("json")) printJson(installed);
    else out(`toli ${describeInstalled(installed)}`);
}

/** The remote to fetch releases from: the clone's `origin`, else the release URL. */
export function releaseRemote(root: string): string {
    if (git(root, ["remote", "get-url", "origin"]).code === 0) return "origin";
    return toliRepoUrl();
}

/** Refuse to move a checkout that has local edits to tracked files or works on a branch. */
export function upgradeBlockers(root: string): string[] {
    const blockers: string[] = [];
    const dirty = gitOk(root, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty !== "")
        blockers.push(
            `tracked files have local changes; commit or move them first:\n${dirty
                .split("\n")
                .map((line) => `  ${line}`)
                .join("\n")}`,
        );
    const branch = currentBranch(root);
    if (branch !== null)
        blockers.push(
            `HEAD is on branch "${branch}"; upgrade moves release installs (detached at a vX.Y.Z tag). On a development clone use git directly.`,
        );
    return blockers;
}

/**
 * `bin/toli upgrade [vX.Y.Z|--latest] [--check]`: list the remote's release tags, show current vs target, and
 * (without --check) check the target tag out, then run `migrate` and `harness sync` from the new code and print the
 * CHANGELOG sections in between. Private dirs (data/, state/, config/, logs/, projects/, local/) are gitignored, so
 * the checkout never touches them.
 */
export async function upgradeCommand(argv: string[]): Promise<number> {
    const args = new Args(argv, { booleans: ["check", "latest"] });
    args.maxPositional(1);
    const requested = args.positional[0];
    if (requested !== undefined && args.bool("latest")) throw new ToliError("give a version or --latest, not both");
    if (requested !== undefined && (!requested.startsWith("v") || parseVersion(requested) === null))
        throw new ToliError(`"${requested}" is not a release tag vX.Y.Z`);

    const root = paths.root();
    const installed = installedVersion(root);
    const remote = releaseRemote(root);
    const tags = tagsFromLsRemote(gitOk(root, ["ls-remote", "--tags", "--refs", remote]));
    const latest = latestTag(tags);
    if (requested !== undefined && !tags.includes(requested)) {
        const known = releaseTags(tags, { prerelease: true });
        throw new ToliError(
            `unknown release tag ${requested} at ${remote} (available: ${known.length > 0 ? known.join(", ") : "none"})`,
        );
    }
    const target = requested ?? latest;
    if (target === null) throw new ToliError(`no release tags (vX.Y.Z) at ${remote}`);

    out(`current: ${describeInstalled(installed)}`);
    out(`latest:  ${latest ?? "(none)"}`);
    if (target !== latest) out(`target:  ${target}`);

    if (installed.tag === target) {
        out(`toli is already at ${target}`);
        return 0;
    }
    const fromVersion = installed.tag ?? `v${installed.version}`;
    const from = parseVersion(fromVersion);
    const to = parseVersion(target);
    const downgrade = from !== null && to !== null && compareVersions(to, from) < 0;
    if (args.bool("check")) {
        out(
            downgrade
                ? `${target} is older than the installed version`
                : `upgrade available: bin/toli upgrade ${requested ?? ""}`.trimEnd(),
        );
        return 0;
    }

    const blockers = upgradeBlockers(root);
    if (blockers.length > 0) throw new ToliError(`upgrade refused:\n- ${blockers.join("\n- ")}`);

    const shallow = gitOk(root, ["rev-parse", "--is-shallow-repository"]) === "true";
    gitOk(root, [
        "fetch",
        "--quiet",
        "--no-tags",
        ...(shallow ? ["--depth", "1"] : []),
        remote,
        `+refs/tags/${target}:refs/tags/${target}`,
    ]);
    gitOk(root, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", `${target}^{commit}`]);
    out(`checked out ${target}${downgrade ? " (downgrade)" : ""}`);

    // The new code runs in fresh processes: this one still holds the old modules.
    for (const step of [["migrate"], ["harness", "sync"]]) {
        out(`bin/toli ${step.join(" ")}`);
        const code = await runInherit([paths.toliBin(), ...step], { cwd: root });
        if (code !== 0) {
            out(`toli: bin/toli ${step.join(" ")} failed (exit ${code}); rerun it after fixing the cause`);
            return 1;
        }
    }

    const changelogFile = join(root, "CHANGELOG.md");
    if (!downgrade && existsSync(changelogFile)) {
        const notes = changelogBetween(readFileSync(changelogFile, "utf8"), fromVersion, target);
        if (notes !== "") out(`\nWhat changed since ${fromVersion}:\n\n${notes}`);
    }
    out(`toli upgraded: ${fromVersion} -> ${target}`);
    return 0;
}
