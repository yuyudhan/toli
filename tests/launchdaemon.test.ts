// toli's launchd jobs (helpers, tick, lead) installed as system LaunchDaemons (src/jobs/launchd.ts): status sees
// them, install and uninstall keep them in the system domain through `sudo -n` and never add a user agent beside them.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { type Launchctl, type Sandbox, sandbox, withLaunchctl, withSudo } from "./helpers.ts";

const HELPER = "com.toli.helper.sweep";
const TICK = "com.toli.tick";
const LEAD = "com.toli.lead";
const PREVIOUS = "previous daemon plist\n";

type Box = { box: Sandbox; env: Record<string, string>; agents: string; daemons: string; launchctl: Launchctl };

/** A darwin sandbox with one registered helper (sweep) and launchctl stubbed; nothing installed yet. */
function darwin(): Box {
    const box = sandbox();
    mkdirSync(join(box.root, "local", "scripts"), { recursive: true });
    const script = join(box.root, "local", "scripts", "sweep");
    writeFileSync(script, "#!/bin/sh\necho swept\n");
    chmodSync(script, 0o755);
    writeFileSync(
        join(box.root, "local", "helpers.json"),
        JSON.stringify({ helpers: [{ name: "sweep", exec: "local/scripts/sweep", schedule: { every: "15m" } }] }),
    );
    const agents = join(box.root, "agents");
    const daemons = join(box.root, "daemons");
    const env = { TOLI_PLATFORM: "darwin", TOLI_DRY_RUN: "0", TOLI_LAUNCH_AGENTS_DIR: agents };
    return { box, env, agents, daemons, launchctl: withLaunchctl(box) };
}

/** `label` installed and loaded as a LaunchDaemon, as root would have left it. */
function daemon(fixture: Box, label: string): string {
    mkdirSync(fixture.daemons, { recursive: true });
    const plist = join(fixture.daemons, `${label}.plist`);
    writeFileSync(plist, PREVIOUS);
    fixture.launchctl.load(label, "system");
    return plist;
}

/** `label` installed and loaded as a user agent too: the duplicate an older toli's install added. */
function agent(fixture: Box, label: string): string {
    mkdirSync(fixture.agents, { recursive: true });
    const plist = join(fixture.agents, `${label}.plist`);
    writeFileSync(plist, "older agent plist\n");
    fixture.launchctl.load(label);
    return plist;
}

const guiBootstraps = (calls: string[]): string[] => calls.filter((call) => /^bootstrap gui\//.test(call));

describe("status sees a LaunchDaemon", () => {
    test("helper status: installed and loaded, in the system domain", () => {
        const fixture = darwin();
        const plist = daemon(fixture, HELPER);
        const { box, env } = fixture;
        const [state] = JSON.parse(box.ok(["helper", "status", "--json"], { env })) as Record<string, unknown>[];
        expect(state).toMatchObject({
            name: "sweep",
            scheduler: "launchd",
            domain: "system",
            installed: true,
            loaded: true,
            running: true,
            detail: `${plist}, a LaunchDaemon in the system domain`,
        });
        expect(box.ok(["helper", "status"], { env })).toContain(
            "launchd LaunchDaemon (system domain): installed, loaded, running pid 4242",
        );
        expect(box.ok(["helper", "list"], { env })).toContain("\tinstalled\t");
    });

    test("schedule status and lead status: installed, naming the domain; a leftover agent beside it is reported", () => {
        const fixture = darwin();
        const tick = daemon(fixture, TICK);
        const lead = daemon(fixture, LEAD);
        const leftover = agent(fixture, LEAD);
        const { box, env } = fixture;
        expect(JSON.parse(box.ok(["schedule", "status", "--json"], { env }))).toMatchObject({
            installed: true,
            loaded: true,
            detail: `${tick}, a LaunchDaemon in the system domain`,
        });
        expect(JSON.parse(box.ok(["lead", "status", "--json"], { env }))).toMatchObject({
            installed: true,
            running: true,
            detail: `${lead}, a LaunchDaemon in the system domain; a LaunchAgent ${leftover} is still installed beside it (the next install retires it)`,
        });
    });
});

describe("install with a LaunchDaemon present", () => {
    test("helper install rewrites the daemon through sudo -n, runs it as the user and adds no LaunchAgent", () => {
        const fixture = darwin();
        const plist = daemon(fixture, HELPER);
        const { box, env, launchctl } = fixture;
        const sudo = withSudo(box);
        expect(box.ok(["helper", "install", "sweep"], { env })).toBe(
            `installed sweep: launchd LaunchDaemon ${HELPER} (every 15m)`,
        );
        expect(existsSync(join(fixture.agents, `${HELPER}.plist`))).toBe(false);
        const text = readFileSync(plist, "utf8");
        expect(text).toContain(`<key>UserName</key>\n    <string>${userInfo().username}</string>`);
        expect(text).toContain(`<key>LOGNAME</key>\n        <string>${userInfo().username}</string>`);
        expect(text).toContain("<key>HOME</key>");
        expect(text).toContain("local/scripts/sweep</string>");
        expect(launchctl.loaded(HELPER, "system")).toBe(true);
        expect(launchctl.loaded(HELPER)).toBe(false);
        expect(guiBootstraps(launchctl.calls())).toEqual([]);
        expect(sudo.calls()).toEqual([
            "true",
            `tee ${plist}.toli-new`,
            `chmod 644 ${plist}.toli-new`,
            `mv -f ${plist}.toli-new ${plist}`,
            `launchctl bootout system/${HELPER}`,
            `launchctl bootstrap system ${plist}`,
        ]);
    });

    test("schedule install and lead install keep the daemon and retire a duplicate LaunchAgent", () => {
        const fixture = darwin();
        const tick = daemon(fixture, TICK);
        const lead = daemon(fixture, LEAD);
        const leftover = agent(fixture, LEAD);
        const { box, env, launchctl } = fixture;
        withSudo(box);
        expect(box.ok(["schedule", "install"], { env })).toContain(`installed and loaded ${tick}`);
        expect(box.ok(["lead", "install"], { env })).toContain(
            `installed and loaded ${lead}: the lead service runs now and at every boot`,
        );
        expect(existsSync(join(fixture.agents, `${TICK}.plist`))).toBe(false);
        expect(existsSync(leftover)).toBe(false);
        expect(launchctl.loaded(LEAD)).toBe(false);
        expect(launchctl.loaded(LEAD, "system")).toBe(true);
        expect(launchctl.loaded(TICK, "system")).toBe(true);
        expect(guiBootstraps(launchctl.calls())).toEqual([]);
        expect(readFileSync(tick, "utf8")).toContain("<string>tick</string>");
        expect(readFileSync(lead, "utf8")).toContain("<key>KeepAlive</key>");

        expect(box.ok(["lead", "install"], { env })).toContain("restarted it in place");
        expect(launchctl.calls().at(-1)).toBe(`kickstart -k system/${LEAD}`);
    });

    test("without cached sudo credentials nothing changes and no LaunchAgent is added", () => {
        const fixture = darwin();
        const plist = daemon(fixture, TICK);
        const { box, env, launchctl } = fixture;
        const result = box.toli(["schedule", "install"], { env });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("installing com.toli.tick needs root");
        expect(result.stderr).toContain("Nothing was changed. Run `sudo -v` in this terminal");
        expect(readFileSync(plist, "utf8")).toBe(PREVIOUS);
        expect(existsSync(join(fixture.agents, `${TICK}.plist`))).toBe(false);
        expect(launchctl.loaded(TICK, "system")).toBe(true);
        expect(launchctl.calls().filter((call) => /^boot(out|strap) /.test(call))).toEqual([]);
    });

    test("a failed daemon bootstrap puts the previous daemon back and loads it again", () => {
        const fixture = darwin();
        const plist = daemon(fixture, HELPER);
        const { box, env, launchctl } = fixture;
        withLaunchctl(box, { rejects: "UserName" });
        withSudo(box);
        const result = box.toli(["helper", "install", "sweep"], { env });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("Bootstrap failed: 5");
        expect(result.stderr).toContain(`the previous ${plist} is back and ${HELPER} is loaded again, unchanged`);
        expect(readFileSync(plist, "utf8")).toBe(PREVIOUS);
        expect(launchctl.loaded(HELPER, "system")).toBe(true);
        expect(existsSync(join(fixture.agents, `${HELPER}.plist`))).toBe(false);
    });

    test("uninstall boots the daemon out and removes it through sudo -n", () => {
        const fixture = darwin();
        const plist = daemon(fixture, HELPER);
        const { box, env, launchctl } = fixture;
        withSudo(box);
        expect(box.ok(["helper", "uninstall", "--all"], { env })).toBe("uninstalled sweep");
        expect(existsSync(plist)).toBe(false);
        expect(launchctl.loaded(HELPER, "system")).toBe(false);
        expect(box.ok(["helper", "status"], { env })).toContain("launchd: not installed");
    });
});

describe("no LaunchDaemon: the user agent default", () => {
    test("install writes and loads the LaunchAgent in the gui domain and never calls sudo", () => {
        const fixture = darwin();
        const { box, env, launchctl } = fixture;
        const sudo = withSudo(box);
        const plist = join(fixture.agents, `${HELPER}.plist`);
        expect(box.ok(["helper", "install", "sweep"], { env })).toBe(`installed sweep: launchd ${HELPER} (every 15m)`);
        expect(readFileSync(plist, "utf8")).not.toContain("<key>UserName</key>");
        expect(launchctl.loaded(HELPER)).toBe(true);
        expect(launchctl.loaded(HELPER, "system")).toBe(false);
        expect(guiBootstraps(launchctl.calls())).toEqual([expect.stringContaining("bootstrap gui/")]);
        expect(sudo.calls()).toEqual([]);
        const [state] = JSON.parse(box.ok(["helper", "status", "--json"], { env })) as Record<string, unknown>[];
        expect(state).toMatchObject({ domain: "user", installed: true, loaded: true, detail: plist });
        expect(box.ok(["helper", "status"], { env })).toContain("\tlaunchd: installed, loaded");
        expect(existsSync(fixture.daemons)).toBe(false);
    });
});
