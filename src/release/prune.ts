// The GitHub Releases prune step of `just release` (scripts/publish.ts): after a publish, keep only the newest
// GITHUB_RELEASES_KEPT published Release entries on the releases page. Drafts are left alone and not counted. Version
// tags are never deleted (no --cleanup-tag). A failed gh call is reported and never stops the release. Pure logic;
// the caller supplies the command runner.

/** How many GitHub Release entries the releases page keeps; older ones are deleted after each publish. */
export const GITHUB_RELEASES_KEPT = 5;

/** One GitHub Release entry as `gh release list --json` reports it. */
export type GithubRelease = { tag: string; createdAt: string; isDraft: boolean };

/** A finished command: its trimmed stdout, or why it failed. */
export type CommandResult = { ok: true; stdout: string } | { ok: false; detail: string };

/**
 * The GitHub Releases to delete so that only the `keep` newest published ones remain, by creation time (`createdAt`,
 * ISO 8601). Drafts are never named and never counted. Only the Release entries: a tag is never named here, so its
 * tag stays on the remote.
 */
export function githubReleasesToPrune(
    releases: readonly GithubRelease[],
    keep: number = GITHUB_RELEASES_KEPT,
): string[] {
    const newestFirst = releases
        .filter((release) => !release.isDraft)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return newestFirst.slice(keep).map((release) => release.tag);
}

/** The `gh release list` argv that reads every GitHub Release entry of `repo` (drafts included) as JSON. */
export function githubReleaseListArgs(repo: string): string[] {
    return ["gh", "release", "list", "--repo", repo, "--limit", "1000", "--json", "tagName,createdAt,isDraft"];
}

/**
 * The `gh release delete` argv for one GitHub Release entry. It never passes `--cleanup-tag`: the version tag stays
 * on the remote, so the release's history and installs keep working.
 */
export function githubReleaseDeleteArgs(repo: string, tag: string): string[] {
    return ["gh", "release", "delete", tag, "--repo", repo, "--yes"];
}

/** Parse `gh release list --json` output; null when it is not the expected list. */
function parseReleaseList(stdout: string): GithubRelease[] | null {
    let listed: unknown;
    try {
        listed = JSON.parse(stdout);
    } catch {
        return null;
    }
    if (!Array.isArray(listed)) return null;
    const releases: GithubRelease[] = [];
    for (const entry of listed) {
        const tag: unknown = Reflect.get(Object(entry), "tagName");
        const createdAt: unknown = Reflect.get(Object(entry), "createdAt");
        const isDraft: unknown = Reflect.get(Object(entry), "isDraft");
        if (typeof tag !== "string" || typeof createdAt !== "string" || typeof isDraft !== "boolean") return null;
        releases.push({ tag, createdAt, isDraft });
    }
    return releases;
}

/**
 * Prune `repo`'s GitHub Releases with `run`, returning one line per outcome to report. Nothing here throws: a failed
 * list prunes nothing, and a failed delete (guard refusal, no auth, network) is reported and the next one still runs.
 */
export function pruneGithubReleases(repo: string, run: (argv: string[]) => CommandResult): string[] {
    const list = run(githubReleaseListArgs(repo));
    const releases = list.ok ? parseReleaseList(list.stdout) : null;
    if (releases === null) {
        const why = list.ok ? "it did not return the expected JSON" : `gh release list failed: ${list.detail}`;
        return [`release: could not list GitHub Releases to prune (${why}); nothing was pruned`];
    }
    return githubReleasesToPrune(releases).map((tag) => {
        const argv = githubReleaseDeleteArgs(repo, tag);
        const deleted = run(argv);
        return deleted.ok
            ? `release: pruned GitHub Release ${tag} (its tag is kept)`
            : `release: could not prune GitHub Release ${tag} (gh release delete failed: ${deleted.detail}); ` +
                  `delete it by hand: ${argv.join(" ")}`;
    });
}
