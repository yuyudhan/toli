import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkDue, type UpdateState } from "../src/release/update-check.ts";
import { type Sandbox, sandbox } from "./helpers.ts";

// Each test builds a release repo with ~20 git processes plus several bin/toli runs; allow 20 s per test.
setDefaultTimeout(20_000);

const NOW = "2026-11-01T09:00:00.000Z";
const DAY_MS = 86_400_000;
const later = (days: number): string => new Date(Date.parse(NOW) + days * DAY_MS).toISOString();

function changelog(versions: string[]): string {
    const sections = versions.map((version) => `## ${version} - 2026-10-30\n\n### Added\n\n- Feature of ${version}\n`);
    return `# Changelog\n\n${sections.join("\n")}`;
}

/**
 * The sandbox root as a release install: an `origin` bare repo with tags v0.1.0, v0.2.0 and the pre-release
 * v0.3.0-rc.1, the root checked out detached at `installed`, and a `git` wrapper that logs every ls-remote.
 */
function releaseInstall(installed = "v0.1.0"): Sandbox {
    const box = sandbox();
    const origin = join(box.root, ".origin", "toli.git");
    const seed = join(box.root, ".seed");
    mkdirSync(origin, { recursive: true });
    mkdirSync(join(seed, "bin"), { recursive: true });
    box.git(origin, ["init", "--bare", "--initial-branch=main"]);
    box.git(seed, ["init", "--initial-branch=main"]);
    writeFileSync(
        join(seed, ".gitignore"),
        "/data/\n/state/\n/config/\n/logs/\n/.stubs/\n/.origin/\n/.seed/\n/ls-remote.log\n",
    );
    writeFileSync(join(seed, "bin", "toli"), '#!/bin/sh\necho "fake toli $*"\n');
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
    box.git(box.root, ["fetch", "--quiet", "origin", `refs/tags/${installed}:refs/tags/${installed}`]);
    box.git(box.root, ["checkout", "--quiet", "--detach", installed]);
    const realGit = Bun.which("git");
    if (realGit === null) throw new Error("git not found");
    // ls-remote is logged, and takes 2 s while a `slow` file exists in the root.
    const slow = join(box.root, "slow");
    box.stub(
        "git",
        `case "$*" in *ls-remote*) echo "$*" >> "${join(box.root, "ls-remote.log")}"; [ -f "${slow}" ] && sleep 2 ;; esac\nexec "${realGit}" "$@"`,
    );
    return box;
}

const lsRemoteCalls = (box: Sandbox): number =>
    existsSync(join(box.root, "ls-remote.log"))
        ? readFileSync(join(box.root, "ls-remote.log"), "utf8").trimEnd().split("\n").length
        : 0;

const state = (box: Sandbox): UpdateState => {
    const file = join(box.root, "state", "update-check.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as UpdateState) : {};
};

describe("checkDue", () => {
    const at = new Date(NOW);
    test("due on the first run and every 3 days after a successful check", () => {
        expect(checkDue({}, at)).toBe(true);
        expect(checkDue({ lastChecked: later(-2), lastAttempt: later(-2) }, at)).toBe(false);
        expect(checkDue({ lastChecked: later(-2.99), lastAttempt: later(-2.99) }, at)).toBe(false);
        expect(checkDue({ lastChecked: later(-3), lastAttempt: later(-3) }, at)).toBe(true);
    });

    test("a failed attempt (offline) is retried an hour later, not every tick", () => {
        const failed: UpdateState = { lastChecked: later(-4), lastAttempt: later(-0.5 / 24) };
        expect(checkDue(failed, at)).toBe(false);
        expect(checkDue({ ...failed, lastAttempt: later(-1 / 24) }, at)).toBe(true);
        expect(checkDue({ lastAttempt: later(-0.5 / 24) }, at)).toBe(false);
    });
});

describe("bin/toli update check", () => {
    test("records the latest stable tag and its changelog; the digest tells it once, never again", () => {
        const box = releaseInstall();
        const checked = box.ok(["update", "check"], { now: NOW });
        expect(checked).toContain("v0.2.0 is available (installed 0.1.0)");
        const recorded = state(box);
        expect(recorded.latest).toBe("v0.2.0");
        expect(recorded.lastChecked).toBe(NOW);
        expect(recorded.changelog).toContain("## v0.2.0 - 2026-10-30");
        expect(recorded.changelog).toContain("Feature of v0.2.0");
        expect(recorded.changelog).not.toContain("## v0.1.0");
        expect(recorded.changelog).not.toContain("v0.3.0-rc.1");

        const first = box.ok(["digest"], { now: NOW });
        expect(first).toContain("Update: toli v0.2.0 is out (installed 0.1.0)");
        expect(first).toContain("bin/toli upgrade");
        expect(first).toContain("bin/toli update snooze v0.2.0");
        expect(first).toContain("Feature of v0.2.0");
        expect(state(box).notified).toEqual(["v0.2.0"]);

        expect(box.ok(["digest"], { now: NOW })).not.toContain("Update:");
        box.ok(["update", "check"], { now: later(3) });
        expect(box.ok(["digest"], { now: later(3) })).not.toContain("Update:");
    });

    test("offline: a failing ls-remote records nothing new and does not fail", () => {
        const box = releaseInstall();
        box.ok(["update", "check"], { now: NOW });
        const before = state(box);
        box.git(box.root, ["remote", "set-url", "origin", join(box.root, ".nowhere", "toli.git")]);
        const result = box.toli(["update", "check"], { now: later(4) });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("could not reach origin");
        const after = state(box);
        expect(after.lastChecked).toBe(before.lastChecked);
        expect(after.latest).toBe(before.latest);
        expect(after.changelog).toBe(before.changelog);
        expect(after.notified).toEqual(before.notified);

        const fresh = releaseInstall();
        fresh.git(fresh.root, ["remote", "set-url", "origin", join(fresh.root, ".nowhere", "toli.git")]);
        expect(fresh.toli(["update", "check"], { now: NOW }).code).toBe(0);
        expect(state(fresh).latest).toBeUndefined();
        expect(state(fresh).lastChecked).toBeUndefined();
        expect(fresh.ok(["digest"], { now: NOW })).not.toContain("Update:");
    });

    test("older, equal and pre-release tags are ignored", () => {
        const box = releaseInstall("v0.2.0");
        expect(box.ok(["update", "check"], { now: NOW })).toContain("up to date (installed 0.2.0, latest v0.2.0)");
        expect(state(box).latest).toBe("v0.2.0");
        expect(state(box).changelog).toBeUndefined();
        expect(box.ok(["digest"], { now: NOW })).not.toContain("Update:");
    });

    test("a snoozed version is never shown", () => {
        const box = releaseInstall();
        expect(box.ok(["update", "snooze", "v0.2.0"])).toContain("snoozed v0.2.0");
        box.ok(["update", "check"], { now: NOW });
        expect(box.ok(["digest"], { now: NOW })).not.toContain("Update:");
        expect(box.ok(["update", "status"], { now: NOW })).toContain("snoozed: v0.2.0");
        expect(box.toli(["update", "snooze", "0.2"]).stderr).toContain("is not a release tag vX.Y.Z");
    });

    test("off: no network call from the tick or a due check, and no notice; on resumes", () => {
        const box = releaseInstall();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        box.ok(["update", "check"], { now: NOW });
        expect(lsRemoteCalls(box)).toBe(1);
        box.ok(["update", "off"]);
        expect(JSON.parse(readFileSync(join(box.root, "config", "updates.json"), "utf8"))).toMatchObject({
            check: false,
        });
        box.ok(["update", "check", "--due"], { now: later(4) });
        box.ok(["job", "tick"], { now: later(4) });
        expect(box.toli(["update", "check"], { now: later(4) }).stderr).toContain("update checks are off");
        expect(box.ok(["digest"], { now: later(4) })).not.toContain("Update:");
        Bun.sleepSync(500);
        expect(lsRemoteCalls(box)).toBe(1);
        expect(box.ok(["update", "status"], { now: later(4) })).toContain("update check: off");
        box.ok(["update", "on"]);
        box.ok(["update", "check", "--due"], { now: later(4) });
        expect(lsRemoteCalls(box)).toBe(2);
    });

    test("a due check runs only when due", () => {
        const box = releaseInstall();
        box.ok(["update", "check", "--due"], { now: NOW });
        box.ok(["update", "check", "--due"], { now: later(1) });
        expect(lsRemoteCalls(box)).toBe(1);
        box.ok(["update", "check", "--due"], { now: later(3) });
        expect(lsRemoteCalls(box)).toBe(2);
    });

    test("a development clone on a branch is told to update with git, not bin/toli upgrade", () => {
        const box = releaseInstall();
        box.git(box.root, ["switch", "--quiet", "--create", "develop"]);
        box.ok(["update", "check"], { now: NOW });
        const digest = box.ok(["digest"], { now: NOW });
        expect(digest).toContain("Update: toli v0.2.0 is out (installed 0.1.0)");
        expect(digest).toContain("development clone on branch develop");
        expect(digest).toContain("a jawan updates it with git");
        expect(digest).not.toContain("run `bin/toli upgrade`");
    });
});

describe("the tick", () => {
    test("starts a due check in the background without waiting for it", () => {
        const box = releaseInstall();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        box.ok(["job", "tick"], { now: NOW });
        const deadline = Date.now() + 10_000;
        while (state(box).lastChecked === undefined && Date.now() < deadline) Bun.sleepSync(100);
        expect(state(box).latest).toBe("v0.2.0");
        expect(readFileSync(join(box.root, "logs", "tick.log"), "utf8")).toContain("update check: started");
    });

    test("never checks a root that is not a git checkout", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        box.ok(["job", "tick"], { now: NOW });
        expect(existsSync(join(box.root, "state", "update-check.json"))).toBe(false);
        expect(readFileSync(join(box.root, "logs", "tick.log"), "utf8")).not.toContain("update check");
    });
});

describe("robustness", () => {
    test("a corrupt state file never breaks the digest and the next check repairs it", () => {
        const box = releaseInstall();
        mkdirSync(join(box.root, "state"), { recursive: true });
        writeFileSync(join(box.root, "state", "update-check.json"), "{ not json");
        expect(box.toli(["digest"], { now: NOW }).code).toBe(0);
        expect(box.toli(["update", "status"], { now: NOW }).code).toBe(0);
        box.ok(["update", "check", "--due"], { now: NOW });
        expect(state(box).latest).toBe("v0.2.0");
        expect(box.ok(["digest"], { now: NOW })).toContain("Update: toli v0.2.0 is out");
    });

    test("a corrupt settings file counts as off: no network call, digest still works", () => {
        const box = releaseInstall();
        box.ok(["update", "check"], { now: NOW });
        mkdirSync(join(box.root, "config"), { recursive: true });
        writeFileSync(join(box.root, "config", "updates.json"), "{ not json");
        const digest = box.toli(["digest"], { now: NOW });
        expect(digest.code).toBe(0);
        expect(digest.stdout).not.toContain("Update:");
        expect(box.toli(["update", "check", "--due"], { now: later(4) }).code).toBe(0);
        expect(lsRemoteCalls(box)).toBe(1);
        expect(box.ok(["update", "status"], { now: later(4) })).toContain("update check: off");
        box.ok(["update", "on"]);
        box.ok(["update", "check", "--due"], { now: later(4) });
        expect(lsRemoteCalls(box)).toBe(2);
    });

    test("reading the changelog never moves a local tag of the same name", () => {
        const box = releaseInstall();
        box.git(box.root, ["switch", "--quiet", "--create", "develop"]);
        box.git(box.root, ["tag", "v0.2.0"]);
        const before = box.git(box.root, ["rev-parse", "v0.2.0"]);
        box.ok(["update", "check"], { now: NOW });
        expect(box.git(box.root, ["rev-parse", "v0.2.0"])).toBe(before);
        expect(state(box).changelog).toContain("Feature of v0.2.0");
    });

    test("the tick claims a due check before it returns, so the next tick does not start another", () => {
        const box = releaseInstall();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        writeFileSync(join(box.root, "slow"), "");
        box.ok(["job", "tick"], { now: NOW });
        expect(state(box).lastAttempt).toBe(NOW);
        box.ok(["job", "tick"], { now: NOW });
        const deadline = Date.now() + 10_000;
        while (state(box).lastChecked === undefined && Date.now() < deadline) Bun.sleepSync(100);
        expect(state(box).latest).toBe("v0.2.0");
        expect(lsRemoteCalls(box)).toBe(1);
    });
});
