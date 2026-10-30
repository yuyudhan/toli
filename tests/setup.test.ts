import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { liveProbe, pendingIds, type SetupItem, type SetupProbe, setupChecklist } from "../src/setup/checklist.ts";
import { noticeText, readMarker, takeSetupNotice } from "../src/setup/setup.ts";
import { type Sandbox, sandbox } from "./helpers.ts";

const saved = process.env.TOLI_ROOT;

/** A machine with nothing installed: no git, no harness CLI, no scheduler tick, hooks path unset. */
const bareProbe: SetupProbe = {
    which: () => null,
    harness: () => ({ ready: null, detail: "none on PATH", loggedOut: [] }),
    scheduler: () => ({ scheduler: "launchd", installed: false, loaded: false, otherBin: null }),
    hooksPath: () => null,
};

/** Everything outside TOLI_ROOT in place. */
const readyProbe: SetupProbe = {
    which: (tool) => `/usr/bin/${tool}`,
    harness: () => ({ ready: "omp", detail: "omp installed", loggedOut: [] }),
    scheduler: () => ({ scheduler: "launchd", installed: true, loaded: true, otherBin: null }),
    hooksPath: () => ".githooks",
};

function status(items: SetupItem[]): Record<string, string> {
    return Object.fromEntries(items.map((item) => [item.id, item.status]));
}

let box: Sandbox;

beforeEach(() => {
    box = sandbox();
    // A fresh clone of toli carries .githooks; nothing else the checklist looks at exists yet.
    mkdirSync(join(box.root, ".githooks"));
    process.env.TOLI_ROOT = box.root;
});

afterEach(() => {
    if (saved === undefined) delete process.env.TOLI_ROOT;
    else process.env.TOLI_ROOT = saved;
});

describe("setup checklist", () => {
    test("a fresh clone has every required step missing; persona and fleet are optional", () => {
        const items = setupChecklist(bareProbe);
        expect(status(items)).toEqual({
            tools: "missing",
            machine: "missing",
            persona: "optional",
            "harness-sync": "missing",
            "harness-cli": "missing",
            scheduler: "missing",
            local: "missing",
            "git-hooks": "missing",
            fleet: "optional",
            project: "missing",
        });
        for (const item of items.filter((entry) => entry.status !== "done")) expect(item.fix).not.toBe("");
        const machine = items.find((item) => item.id === "machine");
        expect(machine?.who).toBe("user");
        expect(machine?.fix).toContain("bin/toli init --name <machine> --role coordinator");
        expect(items.find((item) => item.id === "local")?.who).toBe("lead-command");
        expect(items.find((item) => item.id === "scheduler")?.fix).toBe("bin/toli schedule install");
    });

    test("init closes the machine and local steps; the probes and a project close the rest", () => {
        const before = pendingIds(setupChecklist(bareProbe));
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const after = pendingIds(setupChecklist(bareProbe));
        expect(after.length).toBeLessThan(before.length);
        expect(after).not.toContain("machine");
        expect(after).not.toContain("local");

        box.ok(["harness", "sync"]);
        mkdirSync(join(box.root, "data"), { recursive: true });
        writeFileSync(
            join(box.root, "data", "projects.json"),
            JSON.stringify({ projects: [{ name: "app", url: "git@example.com:app.git", mode: "commit" }] }),
        );
        expect(pendingIds(setupChecklist(readyProbe))).toEqual([]);
    });

    test("a logged-out harness asks the user to log in; a worker without a coordinator is missing", () => {
        const loggedOut = setupChecklist({
            ...bareProbe,
            harness: () => ({ ready: null, detail: "logged out", loggedOut: ["claude"] }),
        }).find((item) => item.id === "harness-cli");
        expect(loggedOut?.who).toBe("user");
        expect(loggedOut?.fix).toContain("claude auth login");

        mkdirSync(join(box.root, "config"), { recursive: true });
        writeFileSync(join(box.root, "config", "machine.json"), JSON.stringify({ name: "w1", role: "worker" }));
        expect(status(setupChecklist(bareProbe)).fleet).toBe("missing");
    });

    test("re-running init keeps the harness and capacity settings", () => {
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const file = join(box.root, "config", "machine.json");
        const machine = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        writeFileSync(file, JSON.stringify({ ...machine, harness: { jawan: "claude" }, capacity: { maxRuns: 2 } }));
        box.ok(["init", "--name", "m2", "--role", "coordinator"]);
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
            name: "m2",
            role: "coordinator",
            harness: { jawan: "claude" },
            capacity: { maxRuns: 2 },
        });
    });

    test("a tick installed for another toli checkout is not this checkout's tick", () => {
        const savedEnv = { PATH: process.env.PATH, TOLI_PLATFORM: process.env.TOLI_PLATFORM };
        const crontab = (root: string) =>
            box.stub("crontab", `echo "* * * * * cd ${root} && bun ${root}/bin/toli job tick # toli tick"`);
        try {
            process.env.PATH = `${box.stubs}:${savedEnv.PATH ?? ""}`;
            process.env.TOLI_PLATFORM = "linux";
            crontab("/srv/other-toli");
            const other = setupChecklist({ ...readyProbe, scheduler: liveProbe().scheduler }).find(
                (item) => item.id === "scheduler",
            );
            expect(other?.status).toBe("missing");
            expect(other?.who).toBe("user");
            expect(other?.detail).toBe("crontab tick runs /srv/other-toli/bin/toli, not this checkout");
            crontab(box.root);
            expect(liveProbe().scheduler()).toMatchObject({
                scheduler: "crontab",
                installed: true,
                loaded: true,
                otherBin: null,
            });
        } finally {
            process.env.PATH = savedEnv.PATH;
            if (savedEnv.TOLI_PLATFORM === undefined) delete process.env.TOLI_PLATFORM;
            else process.env.TOLI_PLATFORM = savedEnv.TOLI_PLATFORM;
        }
    });
});

describe("told-once notice", () => {
    function itemsMissing(ids: string[]): SetupItem[] {
        return setupChecklist(readyProbe).map((item) =>
            ids.includes(item.id) ? { ...item, status: "missing" } : { ...item, status: "done" },
        );
    }

    test("first run shows, a repeat is silent, a finished step stays silent, a new missing step shows again", () => {
        expect(takeSetupNotice(itemsMissing(["machine", "project"]))).toBe(noticeText(2));
        expect(noticeText(2)).toBe('Setup: 2 steps remain - say "set up toli" (bin/toli setup status lists them)');
        expect(readMarker()?.pending).toEqual(["machine", "project"]);
        expect(takeSetupNotice(itemsMissing(["machine", "project"]))).toBeNull();
        expect(takeSetupNotice(itemsMissing(["project"]))).toBeNull();
        expect(readMarker()?.pending).toEqual(["project"]);
        expect(takeSetupNotice(itemsMissing(["project", "scheduler"]))).toBe(noticeText(2));
        expect(takeSetupNotice(itemsMissing(["project", "scheduler"]))).toBeNull();
        // A step that was finished and then goes missing again is new.
        expect(takeSetupNotice(itemsMissing(["machine", "project", "scheduler"]))).toBe(noticeText(3));
    });

    test("nothing missing never shows", () => {
        expect(takeSetupNotice(itemsMissing([]))).toBeNull();
        expect(readMarker()?.pending).toEqual([]);
        expect(takeSetupNotice(itemsMissing(["scheduler"]))).toBe(noticeText(1));
        expect(noticeText(1)).toStartWith("Setup: 1 step remains");
    });

    test("snooze silences the notice until something new is missing", () => {
        box.ok(["setup", "snooze"]);
        expect(readMarker()?.snoozed).toBe(true);
        expect(box.ok(["setup", "notice"])).toBe("");
        expect(box.ok(["digest"])).not.toMatch(/^Setup:/m);
        // The snoozed set lacks a step that now goes missing: told again.
        const marker = readMarker();
        if (marker === null) throw new Error("no marker after snooze");
        writeFileSync(
            join(box.root, "state", "setup-shown.json"),
            JSON.stringify({ ...marker, pending: marker.pending.filter((id) => id !== "machine") }),
        );
        expect(box.ok(["setup", "notice"])).toStartWith("Setup: ");
    });
});

describe("setup CLI", () => {
    test("digest shows the setup line once on a fresh clone; status always shows the full state", () => {
        expect(existsSync(join(box.root, "config", "machine.json"))).toBe(false);
        const first = box.ok(["digest"]);
        expect(first).toContain("machine (unnamed) (not initialized)");
        expect(first).toMatch(/^Setup: \d+ steps remain - say "set up toli"/m);
        expect(box.ok(["digest"])).not.toMatch(/^Setup:/m);
        const text = box.ok(["setup", "status"]);
        expect(text).toContain("missing  machine - Machine config");
        expect(text).toContain("user: Question: what should this machine be called");
        const json = JSON.parse(box.ok(["setup", "status", "--json"])) as { remaining: number; items: SetupItem[] };
        expect(json.items.map((item) => item.id)).toEqual([
            "tools",
            "machine",
            "persona",
            "harness-sync",
            "harness-cli",
            "scheduler",
            "local",
            "git-hooks",
            "fleet",
            "project",
        ]);
        expect(json.remaining).toBeGreaterThan(0);
    });

    test("the Claude Code SessionStart hook hands the notice to the lead once", () => {
        const input = JSON.stringify({ cwd: box.root, hook_event_name: "SessionStart" });
        // A jawan never takes the notice, so the lead still gets it afterwards.
        expect(box.ok(["hook", "claude-session-start"], { stdin: input, env: { TOLI_ROLE: "jawan" } })).toBe("");
        expect(readMarker()).toBeNull();
        const first = JSON.parse(box.ok(["hook", "claude-session-start"], { stdin: input })) as {
            hookSpecificOutput: { hookEventName: string; additionalContext: string };
        };
        expect(first.hookSpecificOutput.hookEventName).toBe("SessionStart");
        expect(first.hookSpecificOutput.additionalContext).toContain('say "set up toli"');
        expect(box.ok(["hook", "claude-session-start"], { stdin: input })).toBe("");
    });

    test("seed-local creates local/ without touching existing files", () => {
        mkdirSync(join(box.root, "local"), { recursive: true });
        writeFileSync(join(box.root, "local", "helpers.json"), '{"helpers": [{"name": "keep"}]}');
        box.ok(["setup", "seed-local"]);
        expect(readFileSync(join(box.root, "local", "helpers.json"), "utf8")).toContain("keep");
        expect(existsSync(join(box.root, "local", "README.md"))).toBe(true);
        expect(status(setupChecklist(bareProbe)).local).toBe("done");
    });
});
