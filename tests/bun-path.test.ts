// The bun and PATH the tick and helpers are installed with: never bun's `bun-node-*` temp dirs, and a warning when
// the bun an installed tick runs is gone.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { type Sandbox, sandbox, withCrontab, withSystemd } from "./helpers.ts";

const TAG = "# toli tick";
const linux = { TOLI_PLATFORM: "linux", TOLI_DRY_RUN: "0" };

/**
 * The PATH `bin/toli` sees when run from toli's root: bun prepends a `bun-node-*` temp dir holding bun and node
 * shims (deleted by the next reboot) to the sandbox's stable directories.
 */
function bunNodePath(box: Sandbox): { dir: string; PATH: string } {
    const dir = join(box.root, "bun-node-1a2b3c4d");
    mkdirSync(dir);
    symlinkSync(process.execPath, join(dir, "bun"));
    symlinkSync(process.execPath, join(dir, "node"));
    return { dir, PATH: [dir, box.stubs, dirname(process.execPath), "/usr/bin", "/bin"].join(":") };
}

function expectStableBun(bun: string): void {
    expect(isAbsolute(bun)).toBe(true);
    expect(existsSync(bun)).toBe(true);
}

describe("schedule install run with a bun-node temp dir first on PATH", () => {
    test("launchd: the plist names a stable bun and leaves the temp dir out of PATH", () => {
        const box = sandbox();
        const shim = bunNodePath(box);
        const output = box.ok(["schedule", "install"], {
            env: { TOLI_PLATFORM: "darwin", TOLI_LAUNCH_AGENTS_DIR: box.root, PATH: shim.PATH },
        });
        expect(output).not.toContain(shim.dir);
        expectStableBun([...output.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1] ?? "")[1] ?? "");
    });

    test("crontab: the line names a stable bun and leaves the temp dir out of PATH", () => {
        const box = sandbox();
        const shim = bunNodePath(box);
        withCrontab(box, null);
        const output = box.ok(["schedule", "install"], { env: { TOLI_PLATFORM: "linux", PATH: shim.PATH } });
        const line = output.split("\n").find((entry) => entry.endsWith(TAG)) ?? "";
        expect(line).toContain("PATH=");
        expect(line).not.toContain(shim.dir);
        expectStableBun(/PATH=\S+ (\S+) /.exec(line)?.[1] ?? "");
    });

    test("systemd: the service names a stable bun and leaves the temp dir out of PATH", () => {
        const box = sandbox();
        const shim = bunNodePath(box);
        const systemd = withSystemd(box);
        const output = box.ok(["schedule", "install"], {
            env: { ...systemd.env, TOLI_DRY_RUN: "1", PATH: shim.PATH },
        });
        expect(output).toContain("Environment=PATH=");
        expect(output).not.toContain(shim.dir);
        expectStableBun(/^ExecStart=(\S+) /m.exec(output)?.[1] ?? "");
    });

    test("helpers: no launchd, systemd or crontab unit puts the temp dir on PATH", () => {
        const box = sandbox();
        const shim = bunNodePath(box);
        mkdirSync(join(box.root, "local", "scripts"), { recursive: true });
        const script = join(box.root, "local", "scripts", "sweep");
        writeFileSync(script, "#!/bin/sh\n");
        chmodSync(script, 0o755);
        const helper = { name: "sweep", exec: "local/scripts/sweep", schedule: { every: "15m" } };
        writeFileSync(join(box.root, "local", "helpers.json"), JSON.stringify({ helpers: [helper] }));
        box.stub("crontab", 'case "$1" in -l) exit 1 ;; *) exit 2 ;; esac');
        for (const env of [
            { TOLI_PLATFORM: "darwin" },
            { TOLI_SCHEDULER: "systemd", TOLI_SYSTEMD_USER_DIR: join(box.root, "units") },
            { TOLI_SCHEDULER: "crontab" },
        ]) {
            const output = box.ok(["helper", "install", "sweep"], { env: { ...env, PATH: shim.PATH } });
            expect(output).toContain("PATH");
            expect(output).toContain(dirname(process.execPath));
            expect(output).not.toContain(shim.dir);
        }
    });
});

describe("an installed tick whose bun no longer exists", () => {
    const setup = (): { box: Sandbox; gone: string; bin: string; warning: string } => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const gone = join(box.root, "bun-node-gone", "bun");
        const warning = `the tick runs ${gone}, which no longer exists`;
        return { box, gone, bin: join(box.root, "bin", "toli"), warning };
    };

    function doctorWarnings(box: Sandbox, env: Record<string, string>): string[] {
        const checks = JSON.parse(box.toli(["doctor", "--json"], { env }).stdout) as {
            level: string;
            name: string;
            detail: string;
        }[];
        return checks
            .filter((check) => check.name === "scheduler" && check.level === "warn")
            .map((check) => check.detail);
    }

    test("crontab: schedule status and doctor warn until install rewrites the line", () => {
        const { box, gone, bin, warning } = setup();
        withCrontab(
            box,
            `* * * * * cd ${box.root} && PATH=/usr/bin ${gone} ${bin} job tick >> /dev/null 2>&1 ${TAG}\n`,
        );
        expect(box.ok(["schedule", "status"], { env: linux })).toContain(`warn: ${warning}`);
        expect(JSON.parse(box.ok(["schedule", "status", "--json"], { env: linux }))).toMatchObject({
            otherBin: null,
            missingBun: gone,
        });
        expect(doctorWarnings(box, linux)).toEqual([expect.stringContaining(warning)]);
        box.ok(["schedule", "install"], { env: linux });
        expect(box.ok(["schedule", "status"], { env: linux })).not.toContain("warn");
        expect(doctorWarnings(box, linux)).toEqual([]);
    });

    test("launchd: schedule status and doctor warn", () => {
        const { box, gone, bin, warning } = setup();
        box.stub("launchctl", "exit 0");
        const darwin = { TOLI_PLATFORM: "darwin", TOLI_DRY_RUN: "0", TOLI_LAUNCH_AGENTS_DIR: box.root };
        writeFileSync(
            join(box.root, "com.toli.tick.plist"),
            `<plist><array>\n<string>${gone}</string>\n<string>${bin}</string>\n</array></plist>\n`,
        );
        expect(box.ok(["schedule", "status"], { env: darwin })).toContain(`warn: ${warning}`);
        expect(doctorWarnings(box, darwin)).toEqual([expect.stringContaining(warning)]);
    });

    test("systemd: schedule status and doctor warn", () => {
        const { box, gone, bin, warning } = setup();
        const systemd = withSystemd(box);
        box.ok(["schedule", "install"], { env: systemd.env });
        expect(box.ok(["schedule", "status"], { env: systemd.env })).not.toContain("warn");
        writeFileSync(join(systemd.units, "toli-tick.service"), `[Service]\nExecStart=${gone} ${bin} job tick\n`);
        expect(box.ok(["schedule", "status"], { env: systemd.env })).toContain(`warn: ${warning}`);
        expect(doctorWarnings(box, systemd.env)).toEqual([expect.stringContaining(warning)]);
    });
});
