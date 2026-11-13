import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    type Launchctl,
    type LaunchctlOptions,
    type Sandbox,
    sandbox,
    withCrontab,
    withLaunchctl,
    withSystemd,
} from "./helpers.ts";

const linux = { TOLI_PLATFORM: "linux", TOLI_DRY_RUN: "0" };

describe("lead install", () => {
    test("launchd (dry run): a kept-alive agent running `lead run`, touching nothing", () => {
        const box = sandbox();
        const output = box.ok(["lead", "install"], {
            env: { TOLI_PLATFORM: "darwin", TOLI_LAUNCH_AGENTS_DIR: box.root },
        });
        expect(output).toContain("<string>com.toli.lead</string>");
        expect(output).toContain("<key>KeepAlive</key>\n    <true/>");
        expect(output).toContain("<key>RunAtLoad</key>\n    <true/>");
        expect(output).toContain("<string>Interactive</string>");
        expect(output).toContain(
            `<string>${join(box.root, "bin", "toli")}</string>\n        <string>lead</string>\n        <string>run</string>`,
        );
        expect(output).toContain(`<string>${join(box.root, "logs", "lead.log")}</string>`);
        expect(existsSync(join(box.root, "com.toli.lead.plist"))).toBe(false);
    });

    test("systemd: a Restart=always user service, enabled and (re)started; reinstall is safe", () => {
        const box = sandbox();
        const systemd = withSystemd(box);
        box.ok(["lead", "install"], { env: systemd.env });
        box.ok(["lead", "install"], { env: systemd.env });
        const unit = readFileSync(join(systemd.units, "toli-lead.service"), "utf8");
        expect(unit).toContain("Type=simple");
        expect(unit).toContain("Restart=always");
        expect(unit).toContain("RestartSec=10");
        expect(unit).toContain("WantedBy=default.target");
        expect(unit).toContain(`${join(box.root, "bin", "toli")} lead run\n`);
        expect(systemd.calls()).toContain("--user enable toli-lead.service");
        expect(systemd.calls()).toContain("--user restart toli-lead.service");
        expect(JSON.parse(box.ok(["lead", "status", "--json"], { env: systemd.env }))).toMatchObject({
            scheduler: "systemd",
            installed: true,
            running: true,
        });
        box.ok(["lead", "uninstall"], { env: systemd.env });
        expect(existsSync(join(systemd.units, "toli-lead.service"))).toBe(false);
        expect(systemd.calls()).toContain("--user disable --now toli-lead.service");
    });

    test("systemd: the unit ends only `lead run` when stopped, and is loaded before the restart that stops the old one", () => {
        const box = sandbox();
        const systemd = withSystemd(box);
        box.ok(["lead", "install"], { env: systemd.env });
        // A restart, a crash or the loop exiting for a newer runtime must not kill the jawan supervisors and the turn
        // left in the unit's cgroup.
        expect(readFileSync(join(systemd.units, "toli-lead.service"), "utf8")).toContain("KillMode=process\n");
        const calls = systemd.calls();
        expect(calls.indexOf("--user daemon-reload")).toBeGreaterThan(-1);
        expect(calls.indexOf("--user daemon-reload")).toBeLessThan(calls.indexOf("--user restart toli-lead.service"));
    });

    test("crontab fallback: one tagged per-minute `lead run --once` line, kept once across reinstalls", () => {
        const box = sandbox();
        const file = withCrontab(box, "0 3 * * * /usr/bin/backup\n");
        box.ok(["lead", "install"], { env: linux });
        box.ok(["lead", "install"], { env: linux });
        const lines = readFileSync(file, "utf8").trimEnd().split("\n");
        expect(lines[0]).toBe("0 3 * * * /usr/bin/backup");
        const tagged = lines.filter((line) => line.includes("# toli lead"));
        expect(tagged).toHaveLength(1);
        const line = tagged[0] ?? "";
        expect(line.startsWith("* * * * * cd ")).toBe(true);
        expect(line).toContain(
            `${join(box.root, "bin", "toli")} lead run --once >> ${join(box.root, "logs", "lead.log")} 2>&1`,
        );
        expect(line.endsWith("# toli lead")).toBe(true);
        expect(box.ok(["lead", "uninstall"], { env: linux })).toBe("removed the toli lead crontab line");
        expect(readFileSync(file, "utf8")).toBe("0 3 * * * /usr/bin/backup\n");
    });
});

describe("lead install under launchd (a launchctl stub)", () => {
    const label = "com.toli.lead";
    const booted = (calls: string[]): string[] => calls.filter((call) => /^boot(out|strap) /.test(call));

    /** A launchd sandbox whose agents dir already holds `previous` as the lead plist, and (when `loaded`) the loaded agent. */
    function installed(
        options: LaunchctlOptions & { loaded?: boolean },
        previous: string | null,
    ): { box: Sandbox; env: Record<string, string>; plist: string; launchctl: Launchctl } {
        const box = sandbox();
        const launchctl = withLaunchctl(box, options);
        const agents = join(box.root, "agents");
        const plist = join(agents, `${label}.plist`);
        if (previous !== null) {
            mkdirSync(agents, { recursive: true });
            writeFileSync(plist, previous);
        }
        if (options.loaded !== false) launchctl.load(label);
        const env = { TOLI_PLATFORM: "darwin", TOLI_DRY_RUN: "0", TOLI_LAUNCH_AGENTS_DIR: agents };
        return { box, env, plist, launchctl };
    }

    test("a session launchd cannot bootstrap into is refused before the running agent is booted out", () => {
        const { box, env, plist, launchctl } = installed({ gui: false }, "previous plist\n");
        const result = box.toli(["lead", "install"], { env });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("cannot load com.toli.lead from this session, and nothing was changed");
        expect(result.stderr).toContain("launchctl session: Background");
        expect(result.stderr).toContain("Terminal in the login session");
        expect(booted(launchctl.calls())).toEqual([]);
        expect(launchctl.loaded(label)).toBe(true);
        expect(readFileSync(plist, "utf8")).toBe("previous plist\n");
    });

    test("a changed plist is booted out and bootstrapped; an unchanged one is restarted in place", () => {
        const { box, env, plist, launchctl } = installed({}, "previous plist\n");
        expect(box.ok(["lead", "install"], { env })).toContain(`installed and loaded ${plist}`);
        expect(readFileSync(plist, "utf8")).toContain("<key>KeepAlive</key>");
        expect(booted(launchctl.calls()).map((call) => call.split(" ")[0])).toEqual(["bootout", "bootstrap"]);

        expect(box.ok(["lead", "install"], { env })).toContain("restarted it in place");
        const calls = launchctl.calls();
        expect(booted(calls)).toHaveLength(2);
        expect(calls.at(-1)).toMatch(/^kickstart -k gui\/\d+\/com\.toli\.lead$/);
        expect(launchctl.loaded(label)).toBe(true);
    });

    test("a failed bootstrap of the new plist puts the previous agent back and reports the failure", () => {
        const { box, env, plist, launchctl } = installed({ rejects: "KeepAlive" }, "previous plist\n");
        const result = box.toli(["lead", "install"], { env });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("Bootstrap failed: 5");
        expect(result.stderr).toContain("com.toli.lead is loaded again, unchanged");
        expect(readFileSync(plist, "utf8")).toBe("previous plist\n");
        expect(launchctl.loaded(label)).toBe(true);
        expect(booted(launchctl.calls()).map((call) => call.split(" ")[0])).toEqual([
            "bootout",
            "bootstrap",
            "bootstrap",
        ]);
    });

    test("when restoring the previous agent fails too, both errors are reported and the old plist is back on disk", () => {
        const { box, env, plist, launchctl } = installed({ rejects: "KeepAlive" }, "previous KeepAlive plist\n");
        const result = box.toli(["lead", "install"], { env });
        expect(result.code).toBe(1);
        expect(result.stderr.match(/Bootstrap failed: 5/g)).toHaveLength(2);
        expect(result.stderr).toContain("restoring the previous agent failed too");
        expect(result.stderr).toContain("com.toli.lead is now unloaded");
        expect(readFileSync(plist, "utf8")).toBe("previous KeepAlive plist\n");
        expect(launchctl.loaded(label)).toBe(false);
    });
});

type Lead = { box: Sandbox; calls: string; sessions: string };

/**
 * An initialized machine m1 whose `omp` stub writes each invocation's argv (one word per line) to `.omp-calls/<n>`,
 * exits 1 while `.fail` exists, and otherwise leaves a conversation file in its --session-dir, as omp does.
 */
function lead(): Lead {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    const calls = join(box.root, ".omp-calls");
    mkdirSync(calls);
    box.stub(
        "omp",
        `dir=""; prev=""
for word in "$@"; do [ "$prev" = "--session-dir" ] && dir="$word"; prev="$word"; done
n=$(ls "${calls}" | wc -l | tr -d ' ')
printf '%s\\n' "$@" > "${calls}/$n"
printf '%s\\n' "$TOLI_LEAD_TURN" >> "${join(box.root, ".turn-env")}"
[ -f "${join(box.root, ".fail")}" ] && exit 1
mkdir -p "$dir" && touch "$dir/conversation.jsonl"
exit 0`,
    );
    return { box, calls, sessions: join(box.root, "state", "lead", "sessions") };
}

function deliver(box: Sandbox, title: string, body: string): void {
    box.ok(["inbox", "add", "--from", "m2", "--title", title], { stdin: body });
}

function calls(setup: Lead): string[] {
    return readdirSync(setup.calls)
        .sort((a, b) => Number(a) - Number(b))
        .map((name) => readFileSync(join(setup.calls, name), "utf8"));
}

function once(box: Sandbox): void {
    box.ok(["lead", "run", "--once"]);
}

describe("lead run --once", () => {
    test("one headless turn per batch of wake items, resuming the conversation it left", () => {
        const setup = lead();
        const { box, sessions } = setup;
        deliver(box, "delegated T1 from m2: first", "first body");
        once(box);
        const [first] = calls(setup);
        expect(first).toStartWith("-p\n--wait-async\n");
        expect(first).toContain(`--session-dir\n${sessions}\n`);
        expect(first).not.toContain("--resume");
        expect(first).toContain("[toli lead m1] headless turn");
        expect(first).toContain("first body");
        expect(first).toContain("bin/toli spawn --task T<n> --brief <file>");

        once(box);
        expect(calls(setup)).toHaveLength(1);

        deliver(box, "message from m2", "second body");
        once(box);
        const second = calls(setup)[1] ?? "";
        expect(second).toContain(`--resume\n${join(sessions, "conversation.jsonl")}\n`);
        expect(second).toContain("second body");
        expect(second).not.toContain("first body");

        const state: unknown = JSON.parse(readFileSync(join(box.root, "state", "lead", "state.json"), "utf8"));
        expect(state).toMatchObject({ turns: 2, lastExit: 0, pid: null, ompPid: null });
        expect(existsSync(join(box.root, "state", "lead", "pending.md"))).toBe(false);
        const log = readFileSync(join(box.root, "logs", "lead.log"), "utf8");
        expect(log).toContain("lead turn 1 done");
        expect(log).toContain("lead turn 2 done");
    });

    test("a failed turn keeps its wake in pending.md and the next pass sends it again", () => {
        const setup = lead();
        const { box } = setup;
        const pending = join(box.root, "state", "lead", "pending.md");
        writeFileSync(join(box.root, ".fail"), "");
        deliver(box, "delegated T1 from m2: build", "build body");
        once(box);
        expect(readFileSync(pending, "utf8")).toContain("build body");
        expect(readFileSync(join(box.root, "logs", "lead.log"), "utf8")).toContain("lead turn 1 exited 1");

        rmSync(join(box.root, ".fail"));
        once(box);
        const [, retry] = calls(setup);
        expect(retry).toContain("build body");
        expect(existsSync(pending)).toBe(false);
    });

    test("the turn runs marked headless, and on a full machine its prompt says to delegate instead of spawning", () => {
        const setup = lead();
        const { box } = setup;
        deliver(box, "message from m2", "first body");
        once(box);
        box.ok(["lead", "full", "--reason", "coordination only"]);
        deliver(box, "message from m2", "second body");
        once(box);
        const [first, second] = calls(setup);
        expect(first).not.toContain("start no jawan here");
        expect(second).toContain(
            "This machine is full: coordination only (until lead full --clear): start no jawan here",
        );
        expect(readFileSync(join(box.root, ".turn-env"), "utf8")).toBe("headless\nheadless\n");
    });

    test("a live interactive session makes the pass skip and take nothing", () => {
        const setup = lead();
        const { box } = setup;
        writeFileSync(
            join(box.root, "state", "session.json"),
            JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        );
        deliver(box, "message from m2", "hello");
        once(box);
        expect(calls(setup)).toHaveLength(0);
        const wake = JSON.parse(box.ok(["wake", "--json"])) as { items: unknown[] };
        expect(wake.items).toHaveLength(1);
    });

    test("a turn already running elsewhere makes the pass skip", () => {
        const setup = lead();
        const { box } = setup;
        mkdirSync(join(box.root, "state", "lead"), { recursive: true });
        writeFileSync(
            join(box.root, "state", "lead", "state.json"),
            JSON.stringify({ turns: 3, pid: process.pid, ompPid: null }),
        );
        deliver(box, "message from m2", "hello");
        once(box);
        expect(calls(setup)).toHaveLength(0);
        expect((JSON.parse(box.ok(["wake", "--json"])) as { items: unknown[] }).items).toHaveLength(1);
    });

    test('under lead.dispatch "subagents" the turn starts no jawan, and what it leaves unacked wakes the interactive session', () => {
        const setup = lead();
        const { box } = setup;
        const file = join(box.root, "config", "machine.json");
        writeFileSync(
            file,
            JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), lead: { dispatch: "subagents" } }),
        );
        deliver(box, "delegated T1 from m2: build", "build body");
        once(box);
        const [first] = calls(setup);
        expect(first).toContain("Start no jawan in this turn");
        expect(first).toContain('`lead.dispatch: "subagents"`');
        expect(first).toContain("Acknowledge only what you settled");
        expect(first).not.toContain("bin/toli spawn --task T<n> --brief <file>");
        expect(first).toContain("build body");

        // The turn acked nothing (the stub runs no command): the next pass takes nothing new...
        once(box);
        expect(calls(setup)).toHaveLength(1);
        // ...and the interactive session is still woken by the item, once.
        const wake = JSON.parse(box.ok(["wake", "--json"])) as { items: { body: string }[] };
        expect(wake.items).toHaveLength(1);
        expect(wake.items[0]?.body).toContain("build body");
        expect((JSON.parse(box.ok(["wake", "--json"])) as { items: unknown[] }).items).toHaveLength(0);

        // An item the turn acknowledges never reaches the interactive session.
        deliver(box, "message from m2", "settled body");
        once(box);
        expect(calls(setup)[1]).toContain("settled body");
        const shown = JSON.parse(box.ok(["inbox", "list", "--json"])) as { stamp: string }[];
        box.ok(["inbox", "ack", "--through", shown.at(-1)?.stamp ?? ""]);
        expect((JSON.parse(box.ok(["wake", "--json"])) as { items: unknown[] }).items).toHaveLength(0);
    });
});

describe("lead status and attach", () => {
    test("status --json reports the service, conversation, last turn and pending wake", () => {
        const setup = lead();
        const { box, sessions } = setup;
        const env = { TOLI_SCHEDULER: "crontab" };
        expect(JSON.parse(box.ok(["lead", "status", "--json"], { env }))).toEqual({
            scheduler: "crontab",
            installed: false,
            running: false,
            detail: "no crontab line",
            interactivePid: null,
            sessionFile: null,
            lastTurnAt: null,
            lastExit: null,
            turns: 0,
            turnPid: null,
            pendingWake: false,
        });
        deliver(box, "message from m2", "hello");
        once(box);
        const status = JSON.parse(box.ok(["lead", "status", "--json"], { env })) as Record<string, unknown>;
        expect(status).toMatchObject({
            sessionFile: join(sessions, "conversation.jsonl"),
            lastExit: 0,
            turns: 1,
            turnPid: null,
            pendingWake: false,
        });
        expect(typeof status.lastTurnAt).toBe("string");
    });

    test("attach refuses a second interactive lead and points to talk", () => {
        const { box } = lead();
        writeFileSync(
            join(box.root, "state", "session.json"),
            JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        );
        const result = box.toli(["lead", "attach"]);
        expect(result.code).toBe(1);
        expect(result.stdout).toContain(`the lead is already open in a terminal (pid ${process.pid})`);
        expect(result.stdout).toContain('bin/toli talk m1 "<words>"');
        expect(JSON.parse(box.ok(["lead", "status", "--json"], { env: { TOLI_SCHEDULER: "crontab" } }))).toMatchObject({
            interactivePid: process.pid,
        });
    });

    test("doctor warns until the lead service is installed", () => {
        const { box } = lead();
        withCrontab(box, null);
        const env = { TOLI_SCHEDULER: "crontab", TOLI_DRY_RUN: "0" };
        const leadCheck = (): unknown =>
            (JSON.parse(box.toli(["doctor", "--json"], { env }).stdout) as { name: string }[]).find(
                (check) => check.name === "lead",
            );
        expect(leadCheck()).toEqual({
            level: "warn",
            name: "lead",
            detail: "crontab lead service not installed: run bin/toli lead install",
        });
        box.ok(["lead", "install"], { env });
        expect(leadCheck()).toEqual({
            level: "ok",
            name: "lead",
            detail: "crontab lead service installed and running",
        });
    });
});
