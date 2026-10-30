import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCron } from "../src/core/cron.ts";
import { type Helper, parseDuration, parseHelpers } from "../src/helpers/registry.ts";
import { cronToCalendar, cronToOnCalendar, everyToCron } from "../src/helpers/units.ts";
import { type Sandbox, sandbox } from "./helpers.ts";

type Entry = Record<string, unknown>;

/** A sandbox with local/helpers.json holding `helpers`, each pointing at an existing executable script. */
function withHelpers(helpers: Entry[]): Sandbox {
    const box = sandbox();
    mkdirSync(join(box.root, "local", "scripts"), { recursive: true });
    for (const helper of helpers) {
        const script = join(box.root, "local", "scripts", String(helper.name));
        writeFileSync(script, '#!/bin/sh\necho ran "$@"\n');
        chmodSync(script, 0o755);
    }
    writeFileSync(join(box.root, "local", "helpers.json"), JSON.stringify({ helpers }));
    return box;
}

const sweep: Entry = {
    name: "sweep",
    exec: "local/scripts/sweep",
    args: ["--fast"],
    schedule: { every: "15m" },
    nice: 10,
    lowPriorityIO: true,
};
const daemon: Entry = { name: "daemon", exec: "local/scripts/daemon", schedule: { always: true } };
const nightly: Entry = { name: "nightly", exec: "local/scripts/nightly", schedule: { cron: "30 2 * * 1-5" } };

/**
 * A stateful fake `launchctl`: bootstrap marks a label loaded (failing when it already is, like the real one),
 * bootout unloads it, print succeeds only while loaded. Every call is appended to .launchctl/log.
 */
function fakeLaunchctl(box: Sandbox): string {
    const state = join(box.root, ".launchctl");
    mkdirSync(state, { recursive: true });
    box.stub(
        "launchctl",
        `state="${state}"; echo "$*" >> "$state/log"
case "$1" in
    print) label="\${2##*/}"; [ -f "$state/$label" ] || exit 113; printf 'state = running\\npid = 4242\\nlast exit code = 0\\n' ;;
    bootstrap) label="$(basename "$3" .plist)"; [ -f "$state/$label" ] && { echo "already loaded" >&2; exit 5; }; touch "$state/$label" ;;
    bootout) label="\${2##*/}"; [ -f "$state/$label" ] || exit 3; rm -f "$state/$label" ;;
    *) exit 2 ;;
esac`,
    );
    return state;
}

function launchdEnv(box: Sandbox): Record<string, string> {
    return { TOLI_DRY_RUN: "0", TOLI_PLATFORM: "darwin", TOLI_LAUNCH_AGENTS_DIR: join(box.root, "agents") };
}

describe("helpers.json parsing", () => {
    const root = "/toli";
    const parse = (helpers: unknown[]): Helper[] => parseHelpers({ helpers }, root, "helpers.json");

    test("resolves repo-relative exec against the root and fills defaults", () => {
        const [helper] = parse([sweep, { name: "abs", exec: "/usr/bin/true", schedule: { cron: "0 * * * *" } }]);
        expect(helper).toMatchObject({
            name: "sweep",
            exec: "/toli/local/scripts/sweep",
            args: ["--fast"],
            schedule: { kind: "every", seconds: 900 },
            nice: 10,
            lowPriorityIO: true,
            runAtLoad: false,
            enabled: true,
            env: {},
            platforms: undefined,
        });
        expect(parse([{ name: "abs", exec: "/usr/bin/true", schedule: { always: true } }])[0]?.exec).toBe(
            "/usr/bin/true",
        );
    });

    test("rejects malformed entries with the helper named", () => {
        const cases: [unknown[], string][] = [
            [[{ ...sweep, colour: "red" }], 'unknown key "colour"'],
            [[sweep, sweep], 'helper "sweep" is declared twice'],
            [[{ ...sweep, name: "../evil" }], ".name must be a name"],
            [[{ ...sweep, exec: "" }], '"exec" must be'],
            [[{ ...sweep, schedule: { every: "15m", cron: "* * * * *" } }], "exactly one of"],
            [[{ ...sweep, schedule: { every: "soon" } }], 'bad duration "soon"'],
            [[{ ...sweep, schedule: { cron: "* * *" } }], "expected 5 fields"],
            [[{ ...sweep, schedule: { always: false } }], "always must be true"],
            [[{ ...sweep, nice: 25 }], '"nice" must be an integer 0-19'],
            [[{ ...sweep, env: { "BAD-NAME": "x" } }], 'bad env name "BAD-NAME"'],
            [[{ ...sweep, args: [1] }], '"args" must be an array of strings'],
        ];
        for (const [helpers, message] of cases) expect(() => parse(helpers)).toThrow(message);
        expect(() => parseHelpers({ helpers: [], extra: 1 }, root, "h.json")).toThrow('unknown top-level key "extra"');
        expect(() => parseHelpers([], root, "h.json")).toThrow('must be {"helpers": [...]}');
    });

    test("durations", () => {
        expect([parseDuration("90s"), parseDuration("15m"), parseDuration("2h"), parseDuration("1d")]).toEqual([
            90, 900, 7200, 86400,
        ]);
        expect(() => parseDuration("0m")).toThrow("bad duration");
    });

    test("a missing local/helpers.json means no helpers", () => {
        const box = sandbox();
        expect(box.ok(["helper", "list"])).toContain("no helpers");
        expect(JSON.parse(box.ok(["helper", "status", "--json"], { env: { TOLI_SCHEDULER: "crontab" } }))).toEqual([]);
    });
});

describe("scheduler selection", () => {
    const schedulerOf = (box: Sandbox, env: Record<string, string>): unknown =>
        (JSON.parse(box.ok(["helper", "status", "--json"], { env })) as { scheduler: string }[])[0]?.scheduler;

    test("macOS uses launchd; Linux uses systemd user units when `systemctl --user` works, else crontab", () => {
        const box = withHelpers([sweep]);
        box.stub("launchctl", "exit 113");
        box.stub("crontab", "exit 1");
        expect(schedulerOf(box, { TOLI_PLATFORM: "darwin", TOLI_LAUNCH_AGENTS_DIR: join(box.root, "agents") })).toBe(
            "launchd",
        );
        expect(schedulerOf(box, { TOLI_PLATFORM: "linux" })).toBe("crontab");
        box.stub("systemctl", 'case "$2" in show-environment) echo HOME=/home/test ;; *) exit 3 ;; esac');
        expect(schedulerOf(box, { TOLI_PLATFORM: "linux", TOLI_SYSTEMD_USER_DIR: join(box.root, "units") })).toBe(
            "systemd",
        );
        expect(schedulerOf(box, { TOLI_PLATFORM: "linux", TOLI_SCHEDULER: "crontab" })).toBe("crontab");
    });
});

describe("schedule translation", () => {
    test("every → crontab only when exact", () => {
        expect(everyToCron(60, "1m")).toBe("* * * * *");
        expect(everyToCron(900, "15m")).toBe("*/15 * * * *");
        expect(everyToCron(3600, "1h")).toBe("0 * * * *");
        expect(everyToCron(6 * 3600, "6h")).toBe("0 */6 * * *");
        expect(everyToCron(86400, "1d")).toBe("0 0 * * *");
        expect(() => everyToCron(7 * 60, "7m")).toThrow("no exact crontab form");
        expect(() => everyToCron(90, "90s")).toThrow("no exact crontab form");
    });

    test("cron → launchd calendar entries and systemd OnCalendar", () => {
        const weekdays = parseCron("30 2 * * 1-5");
        expect(cronToCalendar(weekdays, "")).toHaveLength(5);
        expect(cronToCalendar(weekdays, "")[0]).toEqual({ Minute: 30, Hour: 2, Weekday: 1 });
        expect(cronToOnCalendar(weekdays, "")).toBe("Mon,Tue,Wed,Thu,Fri *-*-* 2:30:00");
        const quarter = parseCron("*/15 * * * *");
        expect(cronToCalendar(quarter, "")).toEqual([{ Minute: 0 }, { Minute: 15 }, { Minute: 30 }, { Minute: 45 }]);
        expect(cronToOnCalendar(quarter, "")).toBe("*-*-* *:0,15,30,45:00");
        expect(cronToOnCalendar(parseCron("0 9 1 * *"), "")).toBe("*-*-1 9:0:00");
        expect(() => cronToCalendar(parseCron("0 9 1 * 1"), "0 9 1 * 1")).toThrow("not both");
    });
});

describe("rendering (dry run)", () => {
    test("launchd: label, absolute exec, args, interval, nice, low-priority I/O, per-helper log", () => {
        const box = withHelpers([sweep]);
        const output = box.ok(["helper", "install", "sweep"], { env: { TOLI_PLATFORM: "darwin" } });
        expect(output).toContain(`<string>com.toli.helper.sweep</string>`);
        expect(output).toContain(
            `<string>${join(box.root, "local", "scripts", "sweep")}</string>\n        <string>--fast</string>`,
        );
        expect(output).toContain("<key>StartInterval</key>\n    <integer>900</integer>");
        expect(output).toContain("<key>Nice</key>\n    <integer>10</integer>");
        expect(output).toContain("<key>LowPriorityIO</key>\n    <true/>");
        expect(output).not.toContain("RunAtLoad");
        expect(output).toContain(`<string>${join(box.root, "logs", "helpers", "sweep.log")}</string>`);
    });

    test("launchd: always-running helpers keep alive in the background; cron uses StartCalendarInterval", () => {
        const box = withHelpers([daemon, nightly]);
        const always = box.ok(["helper", "install", "daemon"], { env: { TOLI_PLATFORM: "darwin" } });
        expect(always).toContain("<key>KeepAlive</key>\n    <true/>");
        expect(always).toContain("<key>RunAtLoad</key>\n    <true/>");
        expect(always).toContain("<key>ProcessType</key>\n    <string>Background</string>");
        expect(always).not.toContain("StartInterval");
        const cron = box.ok(["helper", "install", "nightly"], { env: { TOLI_PLATFORM: "darwin" } });
        expect(cron).toContain("<key>StartCalendarInterval</key>");
        expect(cron.match(/<key>Weekday<\/key>/g)).toHaveLength(5);
    });

    test("systemd: oneshot service plus timer; always-running is a restarting service with no timer", () => {
        const box = withHelpers([sweep, daemon, nightly]);
        const env = { TOLI_SCHEDULER: "systemd", TOLI_SYSTEMD_USER_DIR: join(box.root, "units") };
        const output = box.ok(["helper", "install", "sweep"], { env });
        expect(output).toContain(`would write ${join(box.root, "units", "toli-helper-sweep.service")}`);
        expect(output).toContain("Type=oneshot");
        expect(output).toContain(`ExecStart=${join(box.root, "local", "scripts", "sweep")} --fast`);
        expect(output).toContain("Nice=10\nIOSchedulingClass=idle");
        expect(output).toContain("OnActiveSec=900s\nOnUnitActiveSec=900s");
        expect(output).toContain("Unit=toli-helper-sweep.service");
        expect(output).toContain("WantedBy=timers.target");
        const always = box.ok(["helper", "install", "daemon"], { env });
        expect(always).toContain("Type=simple");
        expect(always).toContain("Restart=always");
        expect(always).toContain("WantedBy=default.target");
        expect(always).not.toContain(".timer");
        expect(box.ok(["helper", "install", "nightly"], { env })).toContain(
            "OnCalendar=Mon,Tue,Wed,Thu,Fri *-*-* 2:30:00\nPersistent=true",
        );
    });

    test("systemd: words with spaces, % and $ are quoted the systemd way", () => {
        const box = withHelpers([
            {
                name: "odd",
                exec: "local/scripts/odd",
                args: ["a b", "50%", "$HOME"],
                env: { GREETING: "hi $USER, 50%" },
                schedule: { every: "1h" },
            },
        ]);
        const output = box.ok(["helper", "install", "odd"], {
            env: { TOLI_SCHEDULER: "systemd", TOLI_SYSTEMD_USER_DIR: join(box.root, "units") },
        });
        expect(output).toContain(`ExecStart=${join(box.root, "local", "scripts", "odd")} "a b" 50%% $$HOME`);
        // Environment= expands % specifiers but never $ variables.
        expect(output).toContain('\nEnvironment="GREETING=hi $USER, 50%%"\n');
        expect(output).toContain(`\nWorkingDirectory=${box.root}\n`);
    });

    test("crontab: tagged line with cd, env, nice and log; always-running refused", () => {
        const box = withHelpers([sweep, daemon]);
        const env = { TOLI_SCHEDULER: "crontab" };
        box.stub("crontab", 'case "$1" in -l) echo "0 3 * * * /usr/bin/backup" ;; *) exit 2 ;; esac');
        const output = box.ok(["helper", "install", "sweep"], { env });
        const line = output.split("\n").find((entry) => entry.endsWith("# toli helper sweep")) ?? "";
        expect(line.startsWith(`*/15 * * * * cd ${box.root} && env PATH=`)).toBe(true);
        expect(line).toContain(` nice -n 10 ${join(box.root, "local", "scripts", "sweep")} --fast >> `);
        expect(line).toContain(`${join(box.root, "logs", "helpers", "sweep.log")} 2>&1 # toli helper sweep`);
        expect(output).toContain("0 3 * * * /usr/bin/backup");
        const refused = box.toli(["helper", "install", "daemon"], { env });
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("crontab cannot keep alive");
    });
});

describe("install and uninstall", () => {
    test("launchd: install is idempotent, status reports it, uninstall twice is safe", () => {
        const box = withHelpers([sweep]);
        const state = fakeLaunchctl(box);
        const env = launchdEnv(box);
        const plist = join(box.root, "agents", "com.toli.helper.sweep.plist");
        expect(box.ok(["helper", "install", "sweep"], { env })).toContain(
            "installed sweep: launchd com.toli.helper.sweep",
        );
        box.ok(["helper", "install", "sweep"], { env });
        expect(existsSync(plist)).toBe(true);
        expect(existsSync(join(state, "com.toli.helper.sweep"))).toBe(true);
        const log = readFileSync(join(state, "log"), "utf8");
        expect(log.match(/^bootstrap /gm)).toHaveLength(2);
        expect(log.match(/^bootout /gm)).toHaveLength(1);
        const [status] = JSON.parse(box.ok(["helper", "status", "--json"], { env })) as Entry[];
        expect(status).toMatchObject({
            name: "sweep",
            scheduler: "launchd",
            installed: true,
            loaded: true,
            running: true,
            pid: 4242,
            lastExit: "0",
        });
        expect(box.ok(["helper", "uninstall", "sweep"], { env })).toBe("uninstalled sweep");
        expect(existsSync(plist)).toBe(false);
        expect(box.ok(["helper", "uninstall", "sweep"], { env })).toBe("sweep: not installed");
    });

    test("launchd: an installed helper dropped from helpers.json shows as unregistered; uninstall --all removes it", () => {
        const box = withHelpers([sweep]);
        fakeLaunchctl(box);
        const env = launchdEnv(box);
        box.ok(["helper", "install", "--all"], { env });
        writeFileSync(join(box.root, "local", "helpers.json"), '{"helpers": []}');
        expect(box.ok(["helper", "status"], { env })).toContain("NOT REGISTERED");
        expect(box.ok(["helper", "uninstall", "--all"], { env })).toBe("uninstalled sweep");
        expect(box.ok(["helper", "uninstall", "--all"], { env })).toBe("no toli helpers installed");
    });

    test("install refuses disabled, other-platform and missing helpers; --all skips them", () => {
        const box = withHelpers([
            { ...sweep, enabled: false },
            { ...daemon, platforms: ["linux"] },
        ]);
        fakeLaunchctl(box);
        const env = launchdEnv(box);
        expect(box.toli(["helper", "install", "sweep"], { env }).stderr).toContain("disabled");
        expect(box.toli(["helper", "install", "daemon"], { env }).stderr).toContain("is for linux, not darwin");
        expect(box.toli(["helper", "install", "ghost"], { env }).stderr).toContain('no helper "ghost"');
        expect(box.ok(["helper", "install", "--all"], { env })).toBe(
            "skipped sweep: disabled\nskipped daemon: platforms linux",
        );
    });

    test("systemd: writes units, reloads and enables the timer; uninstall disables and removes them", () => {
        const box = withHelpers([sweep]);
        const calls = join(box.root, ".systemctl");
        box.stub("systemctl", `echo "$*" >> "${calls}"`);
        const units = join(box.root, "units");
        const env = { TOLI_DRY_RUN: "0", TOLI_SCHEDULER: "systemd", TOLI_SYSTEMD_USER_DIR: units };
        box.ok(["helper", "install", "sweep"], { env });
        box.ok(["helper", "install", "sweep"], { env });
        expect(existsSync(join(units, "toli-helper-sweep.service"))).toBe(true);
        expect(existsSync(join(units, "toli-helper-sweep.timer"))).toBe(true);
        expect(readFileSync(calls, "utf8")).toContain(
            "--user daemon-reload\n--user enable toli-helper-sweep.timer\n--user restart toli-helper-sweep.timer\n",
        );
        expect(box.ok(["helper", "uninstall", "sweep"], { env })).toBe("uninstalled sweep");
        expect(existsSync(join(units, "toli-helper-sweep.timer"))).toBe(false);
        expect(readFileSync(calls, "utf8")).toContain("--user disable --now toli-helper-sweep.timer");
        expect(box.ok(["helper", "uninstall", "sweep"], { env })).toBe("sweep: not installed");
    });

    test("crontab: one tagged line per helper, kept unique and removed alone", () => {
        const box = withHelpers([sweep, { ...sweep, name: "sweep2" }]);
        const file = join(box.root, ".crontab");
        writeFileSync(file, "0 3 * * * /usr/bin/backup\n");
        box.stub("crontab", `case "$1" in -l) cat "${file}" ;; -) cat > "${file}" ;; *) exit 2 ;; esac`);
        const env = { TOLI_DRY_RUN: "0", TOLI_SCHEDULER: "crontab" };
        box.ok(["helper", "install", "--all"], { env });
        box.ok(["helper", "install", "sweep"], { env });
        const lines = readFileSync(file, "utf8").trimEnd().split("\n");
        expect(lines).toHaveLength(3);
        expect(lines.filter((line) => line.endsWith("# toli helper sweep"))).toHaveLength(1);
        box.ok(["helper", "uninstall", "sweep"], { env });
        const kept = readFileSync(file, "utf8");
        expect(kept).toContain("/usr/bin/backup");
        expect(kept).toContain("# toli helper sweep2");
        expect(kept).not.toMatch(/# toli helper sweep\n/);
    });

    test("run executes the helper once from the toli root and passes its exit code through", () => {
        const box = withHelpers([sweep]);
        expect(box.ok(["helper", "run", "sweep"])).toBe("ran --fast");
        writeFileSync(join(box.root, "local", "scripts", "sweep"), "#!/bin/sh\nexit 7\n");
        expect(box.toli(["helper", "run", "sweep"]).code).toBe(7);
    });
});

describe("local/ seeding and hooks", () => {
    test("init seeds local/ once and never overwrites helpers.json", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        expect(readFileSync(join(box.root, "local", "README.md"), "utf8")).toContain("gitignored");
        expect(JSON.parse(readFileSync(join(box.root, "local", "helpers.json"), "utf8"))).toEqual({ helpers: [] });
        expect(existsSync(join(box.root, "local", "scripts"))).toBe(true);
        expect(existsSync(join(box.root, "local", "hooks"))).toBe(true);
        writeFileSync(join(box.root, "local", "helpers.json"), JSON.stringify({ helpers: [sweep] }));
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        expect(readFileSync(join(box.root, "local", "helpers.json"), "utf8")).toContain("sweep");
    });

    function hook(box: Sandbox, name: string, body: string, mode = 0o755): void {
        const file = join(box.root, "local", "hooks", name);
        mkdirSync(join(box.root, "local", "hooks"), { recursive: true });
        writeFileSync(file, `#!/bin/sh\n${body}\n`);
        chmodSync(file, mode);
    }

    test("post-init runs with the root as $1; a failing hook never fails init", () => {
        const box = sandbox();
        hook(box, "post-init", `echo "$1" > "$1/hook-ran"; exit 3`);
        const result = box.toli(["init", "--name", "m1", "--role", "coordinator"]);
        expect(result.code).toBe(0);
        expect(readFileSync(join(box.root, "hook-ran"), "utf8").trim()).toBe(box.root);
        expect(result.stderr).toContain("local/hooks/post-init exited 3; continuing");
    });

    test("a non-executable hook is skipped with a note", () => {
        const box = sandbox();
        hook(box, "post-init", `touch "$1/hook-ran"`, 0o644);
        const result = box.toli(["init", "--name", "m1", "--role", "coordinator"]);
        expect(result.code).toBe(0);
        expect(existsSync(join(box.root, "hook-ran"))).toBe(false);
        expect(result.stderr).toContain("not executable; skipped");
    });

    test("pre-tick and post-tick run around every tick, output kept off stdout", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        hook(box, "pre-tick", `echo pre >> "$1/ticks"; echo noisy`);
        hook(box, "post-tick", `echo post >> "$1/ticks"`);
        const result = box.toli(["job", "tick"]);
        expect(result.code).toBe(0);
        expect(result.stdout).toBe("");
        expect(readFileSync(join(box.root, "ticks"), "utf8")).toBe("pre\npost\n");
    });
});
