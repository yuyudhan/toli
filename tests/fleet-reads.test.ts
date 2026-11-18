import { describe, expect, test } from "bun:test";
import { LEAD_PANES_SH, parseSections } from "../src/fleet/machine-script.ts";
import { inboxQuestion } from "../src/fleet/questions.ts";
import { findVersion, parseRelease, releaseScript } from "../src/fleet/releases.ts";
import { sayResult } from "../src/fleet/say.ts";
import { startResult } from "../src/fleet/start.ts";
import { ENV, fleet, remoteSnapshot } from "./fleet-fixture.ts";
import { AT, stubFleetScripts } from "./fleet-scripts-fixture.ts";
import { sandbox } from "./helpers.ts";

describe("fleet push", () => {
    test("lists every clone with ahead, ages, dirty files and the blocked report line", () => {
        const box = fleet(remoteSnapshot("m2"));
        stubFleetScripts(box);
        const output = box.ok(["fleet", "push"], { env: ENV, now: AT });
        const lines = output.split("\n");
        expect(lines[0]).toMatch(/^Machine +Project +Branch +Ahead +Origin tip +Oldest unpushed +Dirty +Blocked$/);
        expect(lines.find((line) => line.startsWith("m2 ") && line.includes("alpha"))).toMatch(
            /^m2 +alpha +nightly +3 +1 h +4 h +2 +yes$/,
        );
        expect(lines.find((line) => line.startsWith("m2 ") && line.includes("delta"))).toMatch(
            /^m2 +delta +main +0 +1 h +- +0$/,
        );
        expect(output).toContain("Blocked (newest report):\n  m2 alpha: report-T5.md: the push is blocked by the gate");
        expect(output).toContain("m3: unreachable: ssh host3 exited 255");
    });
});

describe("fleet questions", () => {
    test("one numbered list of every machine's holds with options, recommendation and what waits", () => {
        const box = fleet(remoteSnapshot("m2"));
        stubFleetScripts(box);
        const output = box.ok(["fleet", "questions"], { env: ENV, now: AT });
        expect(output).toStartWith("Open questions (1):\n");
        expect(output).toContain(
            [
                " 1. [m2 T7 beta] Ship the beta now?",
                "     1) yes => it ships tonight  (recommended)",
                "     2) no => it waits a week",
                "     blocks: the beta release",
                '     held 2 d; answer: bin/toli task answer m2/T7 "<answer>"',
            ].join("\n"),
        );
        expect(output).toContain("not read: m3: ssh host3 exited 255");
    });

    test("an inbox item asks something when a line after its title ends in a question mark", () => {
        expect(inboxQuestion("# talk from m2\nWe merged it.\nShould m2 cut v1.3 tonight?\n")).toBe(
            "Should m2 cut v1.3 tonight?",
        );
        expect(inboxQuestion("# Why?\nDone, nothing to decide.")).toBeNull();
    });
});

describe("fleet releases", () => {
    test("reads the release machine's clone: tag, commits since, unmerged nightlies, a cut in progress", () => {
        const box = fleet(remoteSnapshot("m2"));
        stubFleetScripts(box);
        const output = box.ok(["fleet", "releases", "alpha@m2"], { env: ENV, now: AT });
        expect(output).toBe(
            [
                "alpha (release machine m2)",
                "  latest tag: v1.2.0 (19 h ago); 5 commits on origin/main since",
                "  nightlies not merged into origin/main:",
                "    origin/m2/nightly +7 (tip 1 h ago)",
                "  cut in progress: release/v1.3.0 +2 (tip 0 min ago); release run j-9 (T44)",
                "  origin refs as of: 2 h ago (last fetch)",
            ].join("\n"),
        );
        expect(box.toli(["fleet", "releases", "alpha"], { env: ENV }).stderr).toContain(
            '"alpha" is not <project>@<machine>',
        );
    });

    test("the script reads origin's refs only and the deployed version is the first version field", () => {
        expect(releaseScript(["alpha"], "main")).not.toMatch(/git (-C "\$d" )?fetch/);
        expect(parseRelease("alpha", "m2", "error\tno origin/main in the clone", []).error).toBe(
            "no origin/main in the clone",
        );
        expect(findVersion({ data: { status: "ok", version: "v0.2.123" } })).toBe("v0.2.123");
        expect(findVersion({ data: [{ nested: { version: "1.0" } }] })).toBe("1.0");
        expect(findVersion({ ok: true })).toBeNull();
    });
});

describe("fleet say and start", () => {
    test("say types into every other machine's lead and confirms it per machine", () => {
        const box = fleet(remoteSnapshot("m2"));
        stubFleetScripts(box);
        const result = box.toli(["fleet", "say", "hello leads", "--key", "C-q", "--wait", "0"], { env: ENV });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe(
            [
                "m2: received (lead:toli: pane shows the text; last line: the typed text)",
                "m3: unreachable (ssh host3 exited 255: ssh: connect to host host3 port 22: Connection refused)",
                "",
            ].join("\n"),
        );
        expect(result.stdout).not.toContain("m1");
        const unconfirmed = sayResult({
            machine: "x",
            local: false,
            ok: true,
            sections: parseSections("@@sent s:w\n@@screen\nsame"),
        });
        expect(unconfirmed.outcome).toBe("typed, not confirmed");
        expect(sayResult({ machine: "x", local: false, ok: true, sections: [] }).outcome).toBe("no lead in tmux");
    });

    test("start never touches a machine whose lead runs, and reports the listener", () => {
        const box = fleet(remoteSnapshot("m2"));
        stubFleetScripts(box);
        const output = box.ok(["fleet", "start", "--listener", "--message", "hi"], { env: ENV });
        expect(output).toContain("m2: lead already running: lead:toli omp; listener already running (toli-peer-serve)");
        expect(
            startResult({ machine: "x", local: false, ok: true, sections: parseSections("@@started s:w") }).lead,
        ).toBe("started: s:w");
        expect(box.toli(["fleet", "start", "--session", "a b"], { env: ENV }).stderr).toContain(
            "--session and --window",
        );
    });
});

describe("lead panes", () => {
    test("a harness pane in the toli root counts, also when a runtime runs the harness's script", () => {
        const box = sandbox();
        const root = Bun.spawnSync(["pwd", "-P"], { cwd: box.root }).stdout.toString().trim();
        box.stub(
            "tmux",
            [
                "printf '%s\\n'",
                `  '%1|lead:main|omp|${root}|11'`,
                `  '%2|lead:bun|bun|${root}|22'`,
                `  '%3|other:bun|bun|${root}|33'`,
                `  '%4|lead:elsewhere|omp|/tmp|44'`,
                `  '%5|lead:shell|zsh|${root}|55'`,
            ].join(" \\\n"),
        );
        box.stub("ps", "printf '%s\\n' '22 bun /home/u/.bun/bin/omp' '33 bun /srv/app/server.js'");
        const result = Bun.spawnSync(["sh", "-c", `${LEAD_PANES_SH}\nlead_panes`], {
            cwd: box.root,
            env: { ...process.env, PATH: `${box.stubs}:/usr/bin:/bin` },
        });
        expect(result.stdout.toString()).toBe("%1|lead:main|omp\n%2|lead:bun|omp\n");
    });
});
