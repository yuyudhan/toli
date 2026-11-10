import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox, withCrontab, withSystemd } from "./helpers.ts";

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
