import { describe, expect, test } from "bun:test";
import {
    changelogBetween,
    changelogHas,
    changelogSection,
    classifyCommit,
    compareVersions,
    latestTag,
    nextVersion,
    parseVersion,
    prependChangelog,
    releaseTags,
    tagsFromLsRemote,
} from "../src/release/release.ts";

function version(text: string) {
    const parsed = parseVersion(text);
    if (parsed === null) throw new Error(`bad test version ${text}`);
    return parsed;
}

describe("semver tags", () => {
    test("parses with or without v and rejects non-semver", () => {
        expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
        expect(parseVersion("0.10.0-rc.1")).toEqual({ major: 0, minor: 10, patch: 0, prerelease: "rc.1" });
        for (const bad of ["1.2", "v1.2.3.4", "v01.2.3", "release-1", "v1.2.x", ""])
            expect(parseVersion(bad)).toBeNull();
    });

    test("orders numerically, pre-releases below their release", () => {
        expect(compareVersions(version("v0.10.0"), version("v0.9.9"))).toBe(1);
        expect(compareVersions(version("v1.0.0-rc.2"), version("v1.0.0"))).toBe(-1);
        expect(compareVersions(version("v1.0.0-rc.10"), version("v1.0.0-rc.2"))).toBe(1);
        expect(compareVersions(version("v1.0.0-alpha"), version("v1.0.0-alpha.1"))).toBe(-1);
        expect(compareVersions(version("v2.0.0"), version("2.0.0"))).toBe(0);
    });

    test("latest is the highest vX.Y.Z; pre-releases and other tags are ignored unless asked", () => {
        const tags = ["v0.9.0", "v0.10.0", "v0.2.0", "v1.0.0-rc.1", "latest", "1.5.0", "v0.10.0-beta"];
        expect(latestTag(tags)).toBe("v0.10.0");
        expect(latestTag(tags, { prerelease: true })).toBe("v1.0.0-rc.1");
        expect(releaseTags(tags)).toEqual(["v0.10.0", "v0.9.0", "v0.2.0"]);
        expect(latestTag(["latest", "nightly"])).toBeNull();
    });

    test("reads tag names from ls-remote output", () => {
        const output = "a1\trefs/tags/v0.1.0\nb2\trefs/tags/v0.2.0\nc3\trefs/heads/main\n";
        expect(tagsFromLsRemote(output)).toEqual(["v0.1.0", "v0.2.0"]);
    });
});

describe("version bump", () => {
    test("patch, minor, major from the current version", () => {
        expect(nextVersion("0.1.0", "patch")).toBe("0.1.1");
        expect(nextVersion("0.1.9", "minor")).toBe("0.2.0");
        expect(nextVersion("0.4.2", "major")).toBe("1.0.0");
        expect(nextVersion("1.0.0-rc.1", "patch")).toBe("1.0.0");
    });

    test("an explicit version is taken as given, without the v", () => {
        expect(nextVersion("0.1.0", "v0.3.0")).toBe("0.3.0");
        expect(nextVersion("0.1.0", "2.0.0-rc.1")).toBe("2.0.0-rc.1");
    });

    test("rejects anything else", () => {
        expect(() => nextVersion("0.1.0", "huge")).toThrow(/patch, minor, major, or vX.Y.Z/);
        expect(() => nextVersion("one", "patch")).toThrow(/not semver/);
    });
});

describe("changelog", () => {
    test("groups commits by conventional prefix, leading verb, or gitmoji; skips release and merge commits", () => {
        expect(classifyCommit("feat(cli): add upgrade")).toEqual({ group: "Added", text: "add upgrade" });
        expect(classifyCommit("fix: EPIPE on head")).toEqual({ group: "Fixed", text: "EPIPE on head" });
        expect(classifyCommit("✨ Add memory budget")).toEqual({ group: "Added", text: "Add memory budget" });
        expect(classifyCommit("Drop the old layout")).toEqual({ group: "Removed", text: "Drop the old layout" });
        expect(classifyCommit("Make Sardar a dispatcher")).toEqual({
            group: "Changed",
            text: "Make Sardar a dispatcher",
        });

        const section = changelogSection("0.2.0", "2026-10-30", [
            { sha: "aaa1111", subject: "Add bin/toli upgrade" },
            { sha: "bbb2222", subject: "Release v0.1.0" },
            { sha: "ccc3333", subject: "Fix EPIPE when piping into head" },
            { sha: "ddd4444", subject: "Merge branch 'x'" },
            { sha: "eee5555", subject: "Rename data/malik.md to data/preferences.md" },
            { sha: "fff6666", subject: "feat: installer" },
        ]);
        expect(section).toBe(
            [
                "## v0.2.0 - 2026-10-30",
                "",
                "### Added",
                "",
                "- Add bin/toli upgrade (aaa1111)",
                "- installer (fff6666)",
                "",
                "### Changed",
                "",
                "- Rename data/malik.md to data/preferences.md (eee5555)",
                "",
                "### Fixed",
                "",
                "- Fix EPIPE when piping into head (ccc3333)",
                "",
            ].join("\n"),
        );
    });

    const existing = "# Changelog\n\nIntro line.\n\n## v0.1.0 - 2026-10-01\n\n### Added\n\n- First\n";

    test("a new section goes above the newest one, below the intro", () => {
        const updated = prependChangelog(existing, "## v0.2.0 - 2026-10-30\n\n### Fixed\n\n- Second (abc)\n");
        expect(updated).toBe(
            "# Changelog\n\nIntro line.\n\n## v0.2.0 - 2026-10-30\n\n### Fixed\n\n- Second (abc)\n\n## v0.1.0 - 2026-10-01\n\n### Added\n\n- First\n",
        );
        expect(prependChangelog("# Changelog\n", "## v0.1.0 - x\n")).toBe("# Changelog\n\n## v0.1.0 - x\n");
        expect(changelogHas(updated, "0.2.0")).toBe(true);
        expect(changelogHas(updated, "0.3.0")).toBe(false);
    });

    test("the sections between two versions: after `from`, up to and including `to`", () => {
        const text = [
            "# Changelog",
            "",
            "## v0.3.0 - c",
            "",
            "- three",
            "",
            "## v0.2.0 - b",
            "",
            "- two",
            "",
            "## v0.1.0 - a",
            "",
            "- one",
            "",
        ].join("\n");
        expect(changelogBetween(text, "v0.1.0", "v0.2.0")).toBe("## v0.2.0 - b\n\n- two");
        expect(changelogBetween(text, "v0.1.0", "v0.3.0")).toBe("## v0.3.0 - c\n\n- three\n\n## v0.2.0 - b\n\n- two");
        expect(changelogBetween(text, null, "v0.1.0")).toBe("## v0.1.0 - a\n\n- one");
        expect(changelogBetween(text, "v0.3.0", "v0.3.0")).toBe("");
    });
});
