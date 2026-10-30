// Release-version logic shared by `bin/toli upgrade|version` and `just release` (scripts/publish.ts):
// semver tags `vX.Y.Z`, bumps, and CHANGELOG.md sections. Pure functions; git and file I/O live in the callers.

/** Where toli releases are published (the same default as install.sh); `TOLI_REPO_URL` overrides it at runtime. */
export const TOLI_REPO_URL = "https://github.com/yuyudhan/toli";

/** The release repository URL: the `TOLI_REPO_URL` environment variable, else the public repository. */
export function toliRepoUrl(): string {
    return process.env.TOLI_REPO_URL ?? TOLI_REPO_URL;
}

export type Version = { major: number; minor: number; patch: number; prerelease: string | null };

const VERSION_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Parse `vX.Y.Z[-pre]` or `X.Y.Z[-pre]`; null for anything else (build metadata is not used by toli). */
export function parseVersion(text: string): Version | null {
    const match = VERSION_PATTERN.exec(text.trim());
    if (!match) return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] ?? null,
    };
}

export function formatVersion(version: Version): string {
    const core = `${version.major}.${version.minor}.${version.patch}`;
    return version.prerelease === null ? core : `${core}-${version.prerelease}`;
}

function comparePrerelease(a: string | null, b: string | null): number {
    if (a === b) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    const left = a.split(".");
    const right = b.split(".");
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const x = left[i];
        const y = right[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        const xNumeric = /^\d+$/.test(x);
        const yNumeric = /^\d+$/.test(y);
        if (xNumeric && yNumeric) {
            const diff = Number(x) - Number(y);
            if (diff !== 0) return Math.sign(diff);
        } else if (xNumeric !== yNumeric) {
            return xNumeric ? -1 : 1;
        } else if (x !== y) {
            return x < y ? -1 : 1;
        }
    }
    return 0;
}

/** Semver precedence: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: Version, b: Version): number {
    return (
        Math.sign(a.major - b.major) ||
        Math.sign(a.minor - b.minor) ||
        Math.sign(a.patch - b.patch) ||
        comparePrerelease(a.prerelease, b.prerelease)
    );
}

/** Release tags (`v` + semver) from a tag list, highest first; pre-releases only when asked. */
export function releaseTags(tags: readonly string[], options: { prerelease?: boolean } = {}): string[] {
    const parsed: Array<{ tag: string; version: Version }> = [];
    for (const tag of tags) {
        if (!tag.startsWith("v")) continue;
        const version = parseVersion(tag);
        if (version === null) continue;
        if (version.prerelease !== null && options.prerelease !== true) continue;
        parsed.push({ tag, version });
    }
    return parsed.sort((a, b) => compareVersions(b.version, a.version)).map((entry) => entry.tag);
}

/** The highest release tag, or null when there is none. */
export function latestTag(tags: readonly string[], options: { prerelease?: boolean } = {}): string | null {
    return releaseTags(tags, options)[0] ?? null;
}

/** Tag names from `git ls-remote --tags --refs` output (`<sha>\trefs/tags/<name>` per line). */
export function tagsFromLsRemote(output: string): string[] {
    const tags: string[] = [];
    for (const line of output.split("\n")) {
        const ref = line.split("\t")[1]?.trim();
        if (ref?.startsWith("refs/tags/")) tags.push(ref.slice("refs/tags/".length));
    }
    return tags;
}

/** Feature work lands on DEVELOP_BRANCH (`bin/toli self land`); RELEASE_BRANCH only moves at a release. */
export const DEVELOP_BRANCH = "develop";
export const RELEASE_BRANCH = "main";

export type ReleaseBranches = {
    /** The branch checked out where `just release` runs, or null on a detached HEAD. */
    current: string | null;
    /** Whether a local RELEASE_BRANCH exists. */
    mainExists: boolean;
    /** Whether RELEASE_BRANCH is an ancestor of (or equal to) DEVELOP_BRANCH, so it can be fast-forwarded. */
    mainContained: boolean;
    /** A worktree that has RELEASE_BRANCH checked out, or null. */
    mainCheckedOutAt: string | null;
};

/**
 * Why a release cannot merge DEVELOP_BRANCH into RELEASE_BRANCH, or null when it can. A release is cut on develop
 * and fast-forwards main to the release commit, so main must exist, be contained in develop, and not be checked out
 * anywhere (moving a checked-out branch would leave that worktree's files behind).
 */
export function releaseBranchProblem(facts: ReleaseBranches): string | null {
    if (facts.current !== DEVELOP_BRANCH)
        return `releases are cut from ${DEVELOP_BRANCH}, not ${facts.current ?? "a detached HEAD"}; git switch ${DEVELOP_BRANCH} first`;
    if (!facts.mainExists)
        return `no local ${RELEASE_BRANCH} branch; create it from the remote first: git branch ${RELEASE_BRANCH} origin/${RELEASE_BRANCH}`;
    if (!facts.mainContained)
        return `${RELEASE_BRANCH} has commits ${DEVELOP_BRANCH} does not; merge them first: git merge ${RELEASE_BRANCH}`;
    if (facts.mainCheckedOutAt !== null)
        return `${RELEASE_BRANCH} is checked out in ${facts.mainCheckedOutAt}; switch that worktree to another branch first`;
    return null;
}

export const BUMPS = ["patch", "minor", "major"] as const;
export type Bump = (typeof BUMPS)[number];

/**
 * The version a release request produces from the current `X.Y.Z`: `patch|minor|major` bumps it (dropping any
 * pre-release), `vX.Y.Z` / `X.Y.Z` names it explicitly. Returns `X.Y.Z` without the `v`.
 */
export function nextVersion(current: string, request: string): string {
    const base = parseVersion(current);
    if (base === null) throw new Error(`current version "${current}" is not semver X.Y.Z`);
    switch (request) {
        case "major":
            return formatVersion({ major: base.major + 1, minor: 0, patch: 0, prerelease: null });
        case "minor":
            return formatVersion({ major: base.major, minor: base.minor + 1, patch: 0, prerelease: null });
        case "patch":
            return formatVersion(
                base.prerelease === null
                    ? { ...base, patch: base.patch + 1 }
                    : { major: base.major, minor: base.minor, patch: base.patch, prerelease: null },
            );
        default: {
            const named = parseVersion(request);
            if (named === null) throw new Error(`"${request}" is not patch, minor, major, or vX.Y.Z`);
            return formatVersion(named);
        }
    }
}

export type Commit = { sha: string; subject: string };

const GROUPS = ["Added", "Changed", "Fixed", "Removed"] as const;
type Group = (typeof GROUPS)[number];

const CONVENTIONAL = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/;
const GROUP_BY_VERB: Record<string, Group> = {
    add: "Added",
    adds: "Added",
    added: "Added",
    create: "Added",
    introduce: "Added",
    implement: "Added",
    support: "Added",
    ship: "Added",
    new: "Added",
    fix: "Fixed",
    fixes: "Fixed",
    fixed: "Fixed",
    repair: "Fixed",
    correct: "Fixed",
    resolve: "Fixed",
    stop: "Fixed",
    prevent: "Fixed",
    remove: "Removed",
    removes: "Removed",
    removed: "Removed",
    drop: "Removed",
    delete: "Removed",
    retire: "Removed",
};

/**
 * Group one commit subject: conventional prefixes (`feat:`, `fix:`) or the leading verb; the rest is Changed.
 * Leading emoji or punctuation (gitmoji) is dropped from the listed text.
 */
export function classifyCommit(rawSubject: string): { group: Group; text: string } {
    const subject = rawSubject.replace(/^[^\p{L}\p{N}]+/u, "") || rawSubject;
    const conventional = CONVENTIONAL.exec(subject);
    if (conventional) {
        const type = (conventional[1] ?? "").toLowerCase();
        const text = conventional[2] ?? subject;
        if (type === "feat") return { group: "Added", text };
        if (type === "fix") return { group: "Fixed", text };
        return { group: "Changed", text };
    }
    const verb = (subject.split(/\s+/, 1)[0] ?? "").toLowerCase();
    return { group: GROUP_BY_VERB[verb] ?? "Changed", text: subject };
}

/** Commits worth listing: release and merge commits are bookkeeping. */
export function changelogCommits(commits: readonly Commit[]): Commit[] {
    return commits.filter((commit) => !/^Release v\d/.test(commit.subject) && !/^Merge\b/.test(commit.subject));
}

/** One CHANGELOG.md section: `## vX.Y.Z - YYYY-MM-DD`, then the commits grouped under Added/Changed/Fixed/Removed. */
export function changelogSection(version: string, date: string, commits: readonly Commit[]): string {
    const groups = new Map<Group, string[]>();
    for (const commit of changelogCommits(commits)) {
        const { group, text } = classifyCommit(commit.subject);
        const lines = groups.get(group) ?? [];
        lines.push(`- ${text} (${commit.sha})`);
        groups.set(group, lines);
    }
    const parts = [`## v${version} - ${date}`];
    for (const group of GROUPS) {
        const lines = groups.get(group);
        if (lines) parts.push(`### ${group}`, lines.join("\n"));
    }
    return `${parts.join("\n\n")}\n`;
}

const SECTION_HEADING = /^## (v\S+)/;

/** Insert a section above the newest one (after the file's intro), keeping one blank line between blocks. */
export function prependChangelog(existing: string, section: string): string {
    const lines = existing.split("\n");
    const first = lines.findIndex((line) => SECTION_HEADING.test(line));
    const body = section.trimEnd();
    if (first === -1) return `${existing.trimEnd()}\n\n${body}\n`;
    const intro = lines.slice(0, first).join("\n").trimEnd();
    const rest = lines.slice(first).join("\n").trimEnd();
    return `${intro}\n\n${body}\n\n${rest}\n`;
}

/** Whether CHANGELOG.md already has a section for `vX.Y.Z`. */
export function changelogHas(text: string, version: string): boolean {
    return text.split("\n").some((line) => SECTION_HEADING.exec(line)?.[1] === `v${version}`);
}

/**
 * Stamp a section drafted ahead of its release (`## vX.Y.Z - unreleased`, written on develop) with the release date:
 * its heading becomes `## vX.Y.Z - YYYY-MM-DD`; the body is kept as written.
 */
export function dateChangelogSection(text: string, version: string, date: string): string {
    return text
        .split("\n")
        .map((line) => (SECTION_HEADING.exec(line)?.[1] === `v${version}` ? `## v${version} - ${date}` : line))
        .join("\n");
}

/** The CHANGELOG.md sections for versions after `from` (exclusive; null = from the start) up to `to` (inclusive). */
export function changelogBetween(text: string, from: string | null, to: string): string {
    const lower = from === null ? null : parseVersion(from);
    const upper = parseVersion(to);
    if (upper === null) throw new Error(`"${to}" is not a version`);
    const kept: string[] = [];
    let current: string[] | null = null;
    for (const line of text.split("\n")) {
        const heading = SECTION_HEADING.exec(line);
        if (heading) {
            if (current) kept.push(current.join("\n").trimEnd());
            const version = parseVersion(heading[1] ?? "");
            const inRange =
                version !== null &&
                compareVersions(version, upper) <= 0 &&
                (lower === null || compareVersions(version, lower) > 0);
            current = inRange ? [line] : null;
        } else if (/^## /.test(line)) {
            if (current) kept.push(current.join("\n").trimEnd());
            current = null;
        } else if (current) {
            current.push(line);
        }
    }
    if (current) kept.push(current.join("\n").trimEnd());
    return kept.join("\n\n");
}
