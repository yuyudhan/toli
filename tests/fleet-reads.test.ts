import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { LEAD_PANES_SH, parseSections } from "../src/fleet/machine-script.ts";
import { inboxQuestion } from "../src/fleet/questions.ts";
import { findVersion, parseRelease, releaseScript } from "../src/fleet/releases.ts";
import { SAY_SEND_SECONDS, type SayOptions, sayResult, sayScript } from "../src/fleet/say.ts";
import { type StartOptions, startResult, startScript } from "../src/fleet/start.ts";
import { SPECS } from "../src/harness/harness.ts";
import { ENV, fleet, remoteSnapshot } from "./fleet-fixture.ts";
import { AT, stubFleetScripts } from "./fleet-scripts-fixture.ts";
import { type Sandbox, SSH_STUB_ARGS, sandbox } from "./helpers.ts";

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
    test("say types into every other machine's lead and prints ok or fail per machine", () => {
        const box = fleet(remoteSnapshot("m2"));
        stubFleetScripts(box);
        const result = box.toli(["fleet", "say", "hello leads", "--wait", "5"], { env: ENV });
        expect(result.code).toBe(1);
        expect(result.stdout.split("\n").sort()).toEqual(
            [
                "",
                "m2: ok received (lead:toli: pane shows the text; last line: the typed text)",
                "m3: fail unreachable (ssh host3 exited 255: ssh: connect to host host3 port 22: Connection refused)",
            ].sort(),
        );
        expect(result.stdout).not.toContain("m1");
        const unconfirmed = sayResult({
            machine: "x",
            local: false,
            ok: true,
            sections: parseSections("@@sent s:w\n@@screen\nsame"),
        });
        expect(unconfirmed.outcome).toBe("typed, not confirmed");
        expect(unconfirmed.status).toBe("fail");
        expect(sayResult({ machine: "x", local: false, ok: true, sections: [] }).outcome).toBe("no lead in tmux");
        const noInbound = { name: "x", ssh: "hx", root: "/srv/toli", inbound: false };
        expect(
            sayResult({ machine: "x", local: false, ok: false, reason: "takes no inbound ssh", fleet: noInbound })
                .status,
        ).toBe("skip");
    });

    // m2 answers `fleet say` after `m2Delay` seconds; m3 hangs (`exec sleep 30`) or refuses at once.
    function slowSayFleet(m2Delay: number, m3: "hang" | "refuse"): Sandbox {
        const box = fleet(remoteSnapshot("m2"));
        box.stub(
            "ssh",
            [
                SSH_STUB_ARGS,
                'case "$host" in',
                `  host2) cat >/dev/null; sleep ${m2Delay}; printf '%s\\n' '@@sent lead:toli' '@@seen' '@@screen' 'typed' ;;`,
                m3 === "hang"
                    ? "  host3) exec sleep 30 ;;"
                    : "  host3) cat >/dev/null; echo 'ssh: connect to host host3 port 22: Connection refused' >&2; exit 255 ;;",
                "  *) exit 255 ;;",
                "esac",
            ].join("\n"),
        );
        return box;
    }

    test("say bounds every machine by --wait: a hung ssh is a fail line, never a hang (T2086)", async () => {
        const box = slowSayFleet(0, "hang");
        const started = Date.now();
        const result = await box.toliAsync(["fleet", "say", "hello leads", "--wait", "2"], { env: ENV });
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(result.code).toBe(1);
        expect(result.stdout).toContain("m2: ok received (lead:toli: pane shows the text; last line: typed)\n");
        expect(result.stdout).toContain("m3: fail unreachable (no answer from host3 within 2s)\n");
    }, 20_000);

    test("say prints each machine's line as soon as that machine answers (T2086)", () => {
        const box = slowSayFleet(2, "refuse");
        const result = box.toli(["fleet", "say", "hello leads", "--wait", "10"], { env: ENV });
        expect(result.stdout.split("\n").map((line) => line.split(":")[0])).toEqual(["m3", "m2", ""]);
    }, 20_000);

    test("say waits for a ready lead only what --wait leaves after typing and confirming (T2086)", () => {
        expect(sayScript(say({ waitSeconds: 60 }))).toContain(`deadline=$(( $(date +%s) + ${60 - SAY_SEND_SECONDS} ))`);
        expect(sayScript(say({ waitSeconds: 3 }))).toContain("deadline=$(( $(date +%s) + 0 ))");
    });

    test("start never touches a machine whose lead runs", () => {
        const box = fleet(remoteSnapshot("m2"));
        stubFleetScripts(box);
        const output = box.ok(["fleet", "start", "--message", "hi"], { env: ENV });
        expect(output).toContain("m2: lead already running: lead:toli omp\n");
        expect(
            startResult({ machine: "x", local: false, ok: true, sections: parseSections("@@started s:w") }).lead,
        ).toBe("started: s:w");
        expect(box.toli(["fleet", "start", "--session", "a b"], { env: ENV }).stderr).toContain(
            "--session and --window",
        );
    });

    test("start leaves the peer listener to the lead service: no second supervisor looping on its lock (T1946)", () => {
        const box = fleet(remoteSnapshot("m2"));
        stubFleetScripts(box);
        const result = box.toli(["fleet", "start", "--listener", "--message", "hi"], { env: ENV });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("unknown option --listener");
        const script = startScript({
            session: "toli",
            window: "lead",
            harness: "omp",
            key: null,
            message: null,
            attach: null,
            os: null,
        });
        expect(script).not.toContain("peer serve");
        expect(script).not.toContain("systemd-run");
    });

    // What a pane in the toli root shows: a shell whose prompt draws its own bar line (powerline themes do), and the
    // same pane once omp has drawn its status bar below it.
    const SHELL_SCREEN = " ~/code/toli ────────────────\n❯ omp";
    const OMP_SCREEN = `${SHELL_SCREEN}\n Opus · ~/code/toli ──────────────── 5%\n╰─`;

    // A fake tmux: one lead pane running `harness` in the toli root, or none. The pane shows `initial` (OMP_SCREEN
    // with a harness, SHELL_SCREEN without), which becomes `launched` once a command line is submitted with Enter
    // (unless null), and below it an input still holding `held.text` until Ctrl+S was pressed `held.presses` times.
    // Every send-keys call's arguments are recorded one line each.
    type FakePane = { launched?: string | null; initial?: string; held?: { text: string; presses: number } };
    function fakeTmux(
        harness: string | null,
        pane: FakePane = {},
    ): { run: (script: string) => string[]; output: () => string } {
        const box = sandbox();
        const root = Bun.spawnSync(["pwd", "-P"], { cwd: box.root }).stdout.toString().trim();
        const log = `${box.root}/keys.log`;
        const screen = `${box.root}/screen`;
        const next = `${box.root}/launched`;
        const launched = pane.launched === undefined ? OMP_SCREEN : pane.launched;
        writeFileSync(screen, pane.initial ?? (harness === null ? SHELL_SCREEN : OMP_SCREEN));
        if (launched !== null) writeFileSync(next, launched);
        const list = harness === null ? ":" : `printf '%s\\n' '%1|lead:toli|${harness}|${root}|11'`;
        const held =
            pane.held === undefined
                ? ""
                : `; n=$(grep -c 'C-s$' '${log}' 2>/dev/null); [ "\${n:-0}" -lt ${pane.held.presses} ] && printf '╰─ %s\\n' '${pane.held.text}'`;
        box.stub(
            "tmux",
            [
                'case "$1" in',
                `  list-panes) ${list} ;;`,
                "  has-session) exit 1 ;;",
                `  capture-pane) cat '${screen}'${held}; : ;;`,
                `  send-keys) shift; printf '%s\\n' "$*" >> '${log}'`,
                `    case "$*" in *" Enter") [ -f '${next}' ] && cp '${next}' '${screen}' ;; esac ;;`,
                "esac",
            ].join("\n"),
        );
        box.stub("sleep", ":");
        let stdout = "";
        return {
            run: (script) => {
                const result = Bun.spawnSync(["sh", "-c", script], {
                    cwd: box.root,
                    env: { ...process.env, PATH: `${box.stubs}:/usr/bin:/bin` },
                });
                expect(result.exitCode).toBe(0);
                stdout = result.stdout.toString();
                return existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : [];
            },
            output: () => stdout,
        };
    }
    const say = (options: Partial<SayOptions>): SayOptions => ({
        text: "hello",
        key: null,
        os: null,
        waitSeconds: 0,
        ...options,
    });
    const start = (options: Partial<StartOptions>): StartOptions => ({
        session: "toli",
        window: "lead",
        harness: "omp",
        key: null,
        message: "hi",
        attach: null,
        os: null,
        ...options,
    });

    test("say submits into an omp lead with Ctrl+S, the fleet's omp submit key, never Ctrl+Q or Enter (T2086)", () => {
        expect(SPECS.omp.submitKey).toBe("C-s");
        expect(fakeTmux("omp").run(sayScript(say({})))).toEqual(["-t %1 -l hello", "-t %1 C-s"]);
    });

    test("say keeps Enter for a harness that submits on it, and --key overrides any default (T1960)", () => {
        expect(fakeTmux("claude").run(sayScript(say({})))).toEqual(["-t %1 -l hello", "-t %1 Enter"]);
        expect(fakeTmux("omp").run(sayScript(say({ key: "M-Enter" })))).toEqual(["-t %1 -l hello", "-t %1 M-Enter"]);
    });

    test("say has no --steer: omp's one submit key already steers into a running turn (T2086)", () => {
        const box = fleet(remoteSnapshot("m2"));
        stubFleetScripts(box);
        const result = box.toli(["fleet", "say", "hi", "--steer", "--to", "m2"], { env: ENV });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("unknown option --steer");
    });

    test("start launches the harness with Enter and submits the first message with its submit key (T2086)", () => {
        expect(fakeTmux(null).run(startScript(start({})))).toEqual([
            "-t toli:lead omp Enter",
            "-t toli:lead -l hi",
            "-t toli:lead C-s",
        ]);
        expect(fakeTmux(null).run(startScript(start({ harness: "claude" })))).toEqual([
            "-t toli:lead claude Enter",
            "-t toli:lead -l hi",
            "-t toli:lead Enter",
        ]);
    });

    test("start never types into a pane whose only bar is the shell prompt's own line (T2086)", () => {
        const tmux = fakeTmux(null, { launched: null });
        expect(tmux.run(startScript(start({})))).toEqual(["-t toli:lead omp Enter"]);
        expect(tmux.output()).toContain("@@failed omp drew no status bar in 90 s in toli:lead");
    }, 30_000);

    test("start presses the submit key again while omp, drawn but still starting, holds the message (T2086)", () => {
        const tmux = fakeTmux(null, { held: { text: "hi", presses: 2 } });
        expect(tmux.run(startScript(start({})))).toEqual([
            "-t toli:lead omp Enter",
            "-t toli:lead -l hi",
            "-t toli:lead C-s",
            "-t toli:lead C-s",
        ]);
        expect(tmux.output()).toBe("@@started toli:lead\n");
    });

    test("say never types into a lead pane that shows only the shell prompt's bar: its harness is still starting (T2086)", () => {
        const tmux = fakeTmux("omp", { launched: null, initial: SHELL_SCREEN });
        expect(tmux.run(sayScript(say({})))).toEqual([]);
        expect(tmux.output()).toBe("@@none\n");
    });

    test("say presses the submit key until the text leaves the input, and fails when it never does (T2086)", () => {
        const later = fakeTmux("omp", { held: { text: "hello", presses: 2 } });
        expect(later.run(sayScript(say({ waitSeconds: 60 })))).toEqual(["-t %1 -l hello", "-t %1 C-s", "-t %1 C-s"]);
        expect(later.output()).not.toContain("@@pending");
        const never = fakeTmux("omp", { held: { text: "hello", presses: 99 } });
        expect(never.run(sayScript(say({ waitSeconds: 1 })))).toEqual(["-t %1 -l hello", "-t %1 C-s"]);
        const outcome = sayResult({ machine: "x", local: false, ok: true, sections: parseSections(never.output()) });
        expect(outcome.outcome).toBe("typed, not submitted");
        expect(outcome.status).toBe("fail");
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
