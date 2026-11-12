import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { automationBrowser, markedPids, runBrowsers } from "../src/jawans/browsers.ts";
import { tempDir } from "./helpers.ts";
import { brief, coordinator, type Run, waitFor } from "./jawan-fixture.ts";

setDefaultTimeout(30_000);

describe("which processes are automation browsers", () => {
    test("a browser with an automation flag or a temp profile is one", () => {
        for (const args of [
            "/opt/google/chrome/chrome --headless=new --remote-debugging-port=0 about:blank",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222",
            "/home/u/.cache/ms-playwright/chromium_headless_shell-1179/chrome-linux/headless_shell --remote-debugging-pipe",
            "chromium --user-data-dir=/tmp/playwright_chromiumdev_profile-x1 about:blank",
            "/usr/lib/firefox/firefox -marionette -profile /tmp/rust_mozprofile",
            "msedge --enable-automation",
            "/Applications/Chromium.app/Contents/MacOS/Chromium --headless",
            "/usr/bin/chromium-browser --headless",
            "/usr/bin/google-chrome-stable --remote-debugging-port=0",
            "/opt/chrome-headless-shell/chrome-headless-shell --remote-debugging-pipe",
            "/usr/bin/brave-browser --enable-automation",
        ])
            expect([args, automationBrowser(args)]).toEqual([args, true]);
    });

    test("the user's default-profile browser, Chrome's helpers and browser-named tools are not", () => {
        for (const args of [
            "/opt/google/chrome/chrome",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --restore-last-session",
            "/opt/google/chrome/chrome --user-data-dir=/home/u/.config/google-chrome",
            "/opt/google/chrome/chrome --type=renderer --enable-automation --headless",
            "node /home/u/.npm/_npx/1/node_modules/chrome-devtools-mcp/build/src/index.js --headless",
            "bash -c chrome --headless",
            "npx chrome-devtools-mcp --headless",
            "python3 /home/u/src/chromium_tests.py --headless",
            "/usr/bin/python3 /home/u/src/chromium/tools/run.py --remote-debugging-port=0",
        ])
            expect([args, automationBrowser(args)]).toEqual([args, false]);
    });
});

describe("which browsers belong to the run", () => {
    const NOW = 10_000_000_000;
    const root = { pid: 100, spawnedAtMs: NOW - 60_000 };
    // pid ppid pgid stat etime args, as `ps -A -o pid=,ppid=,pgid=,stat=,etime=,args=` prints them.
    const PS = [
        "   50     1    50 Ss   10:00 toli run supervise j-1",
        "  100    50   100 S    01:00 omp -p --mode text",
        "  101   100   100 S    00:50 node /x/node_modules/@playwright/mcp/cli.js",
        "  102     1   102 S    00:40 /opt/chrome/chrome --headless --user-data-dir=/tmp/playwright_profile-a",
        "  103   102   102 S    00:39 /opt/chrome/chrome --type=renderer --headless",
        "  104   100   100 S    00:30 /opt/google/chrome/chrome",
        "  200     1   200 S    99:00 /opt/google/chrome/chrome",
        "  201     1   201 S    10:00 /opt/google/chrome/chrome --headless --remote-debugging-port=9222",
        "  300     1   300 S    00:20 chromium --remote-debugging-pipe",
    ].join("\n");

    test("only the run's own automation browsers: orphaned ones it saw before and ones carrying its run id", () => {
        // 102 was seen in the run's tree by an earlier sample, before its launcher exited and it was reparented.
        const tree = new Map([[102, NOW - 40_000]]);
        const found = runBrowsers(PS, NOW, root, tree, [300]);
        expect([...found.keys()].sort()).toEqual([102, 300]);
        // The default-profile browser the jawan opened (104) is in the tree but never a target; the user's own (200)
        // and another tool's automation browser (201) are not the run's at all.
        expect([...tree.keys()].sort()).toEqual([100, 101, 102, 103, 104, 300]);
    });

    test("a pid the system gave to another process since is not the run's", () => {
        const tree = new Map([[102, NOW - 500_000]]);
        expect([...runBrowsers(PS, NOW, root, tree, []).keys()]).toEqual([]);
    });

    test("the run id in a process's environment marks it as the run's (Linux /proc)", () => {
        const proc = tempDir("proc");
        const environ = (pid: string, text: string): void => {
            mkdirSync(join(proc, pid));
            writeFileSync(join(proc, pid, "environ"), text);
        };
        environ("10", "A=1\0TOLI_RUN_ID=j-1\0");
        environ("11", "TOLI_RUN_ID=j-1\0B=2\0");
        environ("12", "TOLI_RUN_ID=j-10\0");
        environ("13", "X=TOLI_RUN_ID=j-1\0");
        mkdirSync(join(proc, "self"));
        const saved = process.env.TOLI_PROC_DIR;
        process.env.TOLI_PROC_DIR = proc;
        try {
            expect(markedPids("j-1").sort()).toEqual([10, 11]);
        } finally {
            if (saved === undefined) delete process.env.TOLI_PROC_DIR;
            else process.env.TOLI_PROC_DIR = saved;
        }
    });
});

/** Whether `pid` is gone (or a zombie waiting to be reaped). */
function gone(pid: number): boolean {
    const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
        .stdout.toString()
        .trim();
    return stat === "" || stat.startsWith("Z");
}

/** A bash script `ps` lists as `<command line> 300`: `exec -a` sets sleep's argv[0] to the whole fake command line. */
function fakeBrowser(commandLine: string): string {
    return `exec -a "${commandLine}" sleep 300`;
}

describe("a spawn run closes the browsers it left open", () => {
    test("its own automation browser is stopped; its default-profile one and every outside browser are not", async () => {
        const box = coordinator();
        const pids = join(box.root, ".pids");
        mkdirSync(pids);
        // The harness starts an automation browser and a default-profile one in the background, then exits: both are
        // reparented, as a browser launched detached by Playwright is.
        box.stub(
            "omp",
            [
                `bash -c '${fakeBrowser("chrome --headless --remote-debugging-port=0")}' &`,
                `echo $! > "${pids}/automation"`,
                `bash -c '${fakeBrowser("chrome")}' &`,
                `echo $! > "${pids}/default"`,
                "sleep 1",
                "echo reported",
            ].join("\n"),
        );
        const outside = [
            Bun.spawn(["bash", "-c", fakeBrowser("chrome --headless --remote-debugging-port=9222")]),
            Bun.spawn(["bash", "-c", fakeBrowser("chrome")]),
        ];
        const read = (name: string): number => Number(readFileSync(join(pids, name), "utf8").trim());
        try {
            const started = JSON.parse(
                box.ok(["spawn", "--harness", "omp", "--brief", brief(box), "--cwd", box.root, "--json"], {
                    env: { TOLI_RUN_MINUTE_MS: "600" },
                }),
            ) as Run;
            const done = await waitFor(box, started.id, (run) => run.status === "done");
            const automation = read("automation");
            expect(gone(automation)).toBe(true);
            expect(readFileSync(done.logPath, "utf8")).toContain(
                `[toli] closed the automation browser(s) the run left open: pid ${automation}`,
            );
            expect(gone(read("default"))).toBe(false);
            for (const proc of outside) expect(gone(proc.pid)).toBe(false);
        } finally {
            for (const proc of outside) proc.kill("SIGKILL");
            for (const name of ["automation", "default"]) {
                try {
                    process.kill(read(name), "SIGKILL");
                } catch {
                    // Already stopped, or never started.
                }
            }
        }
    });
});
