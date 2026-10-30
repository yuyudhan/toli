import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { type Sandbox, sandbox } from "./helpers.ts";

const TAG = "# toli tick";

function plist(box: Sandbox): string {
    return box.ok(["schedule", "install"], { env: { TOLI_PLATFORM: "darwin", TOLI_LAUNCH_AGENTS_DIR: box.root } });
}

/** A file-backed `crontab` stub: `-l` prints the file (exit 1 when absent), `-` replaces it from stdin. */
function withCrontab(box: Sandbox, initial: string | null): string {
    const file = join(box.root, ".crontab");
    if (initial !== null) writeFileSync(file, initial);
    box.stub(
        "crontab",
        `case "$1" in
    -l) [ -f "${file}" ] || { echo "no crontab for test" >&2; exit 1; }; cat "${file}" ;;
    -) cat > "${file}" ;;
    *) exit 2 ;;
esac`,
    );
    return file;
}

const linux = { TOLI_PLATFORM: "linux", TOLI_DRY_RUN: "0" };

describe("schedule install on macOS (dry run)", () => {
    test("plist runs `bun bin/toli job tick` every 60s from absolute paths, touching nothing", () => {
        const box = sandbox();
        const output = plist(box);
        const strings = [...output.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1] ?? "");
        const [label, bun, toli, job, tick, workdir] = strings;
        expect(label).toBe("com.toli.tick");
        expect([job, tick]).toEqual(["job", "tick"]);
        expect(toli).toBe(join(box.root, "bin", "toli"));
        expect(workdir).toBe(box.root);
        for (const path of [bun, toli, workdir]) expect(isAbsolute(path ?? "")).toBe(true);
        expect(output).toContain("<key>StartInterval</key>\n    <integer>60</integer>");
        expect(output).toContain(`<string>${join(box.root, "logs", "launchd.err.log")}</string>`);
        expect(existsSync(join(box.root, "com.toli.tick.plist"))).toBe(false);
    });

    test("PATH holds the directories of the tools jobs call, plus the system dirs", () => {
        const box = sandbox();
        box.stub("omp", "exit 0");
        const output = plist(box);
        const path = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(output)?.[1] ?? "";
        const dirs = path.split(":");
        expect(dirs).toContain(box.stubs);
        expect(dirs).toContain(dirname(process.execPath));
        expect(dirs).toEqual(expect.arrayContaining(["/usr/bin", "/bin", "/opt/homebrew/bin"]));
        expect(new Set(dirs).size).toBe(dirs.length);
    });

    test("XML-special characters in the repo path are escaped", () => {
        const box = sandbox();
        const root = join(box.root, "a&b<c>");
        const output = box.ok(["schedule", "install"], {
            env: { TOLI_PLATFORM: "darwin", TOLI_LAUNCH_AGENTS_DIR: box.root, TOLI_ROOT: root },
        });
        expect(output).toContain("a&amp;b&lt;c&gt;");
        expect(output).not.toContain("a&b<c>");
    });
});

describe("schedule on Linux (crontab)", () => {
    test("install appends one tagged line and keeps unrelated entries; reinstall stays idempotent", () => {
        const box = sandbox();
        const file = withCrontab(box, "0 3 * * * /usr/bin/backup\n");
        box.ok(["schedule", "install"], { env: linux });
        box.ok(["schedule", "install"], { env: linux });
        const lines = readFileSync(file, "utf8").trimEnd().split("\n");
        expect(lines[0]).toBe("0 3 * * * /usr/bin/backup");
        expect(lines.filter((line) => line.includes(TAG))).toHaveLength(1);
        const line = lines[1] ?? "";
        expect(line.startsWith("* * * * * cd ")).toBe(true);
        expect(line).toContain(
            `${join(box.root, "bin", "toli")} job tick >> ${join(box.root, "logs", "cron.log")} 2>&1`,
        );
        expect(line.endsWith(TAG)).toBe(true);
    });

    test("a repo path with spaces is shell-quoted in the cron line", () => {
        const box = sandbox();
        const file = withCrontab(box, null);
        const root = join(box.root, "my toli");
        box.ok(["schedule", "install"], { env: { ...linux, TOLI_ROOT: root } });
        const line = readFileSync(file, "utf8");
        expect(line).toContain(`cd '${root}' && `);
        expect(line).toContain(`'${join(root, "bin", "toli")}' job tick`);
    });

    test("install works when the user has no crontab yet", () => {
        const box = sandbox();
        const file = withCrontab(box, null);
        box.ok(["schedule", "install"], { env: linux });
        expect(readFileSync(file, "utf8").trimEnd().split("\n")).toHaveLength(1);
        expect(JSON.parse(box.ok(["schedule", "status", "--json"], { env: linux }))).toMatchObject({
            scheduler: "crontab",
            installed: true,
        });
    });

    test("uninstall removes only the tagged line", () => {
        const box = sandbox();
        const file = withCrontab(box, "0 3 * * * /usr/bin/backup\n");
        box.ok(["schedule", "install"], { env: linux });
        expect(box.ok(["schedule", "uninstall"], { env: linux })).toBe("removed toli crontab line");
        expect(readFileSync(file, "utf8")).toBe("0 3 * * * /usr/bin/backup\n");
        expect(box.ok(["schedule", "uninstall"], { env: linux })).toBe("no toli crontab line installed");
    });

    test("dry run prints the would-be crontab and leaves the real one untouched", () => {
        const box = sandbox();
        const file = withCrontab(box, "0 3 * * * /usr/bin/backup\n");
        const output = box.ok(["schedule", "install"], { env: { TOLI_PLATFORM: "linux" } });
        expect(output).toContain("# dry run: would install crontab:");
        expect(output).toContain(TAG);
        expect(readFileSync(file, "utf8")).toBe("0 3 * * * /usr/bin/backup\n");
    });

    test("a failing crontab write is an error, not a silent success", () => {
        const box = sandbox();
        box.stub("crontab", `[ "$1" = "-l" ] && exit 1; echo "crontab: permission denied" >&2; exit 1`);
        const result = box.toli(["schedule", "install"], { env: linux });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("permission denied");
    });
});

describe("a tick installed for another toli checkout", () => {
    const other = "/srv/other-toli/bin/toli";

    function doctorScheduler(box: Sandbox, env: Record<string, string>): string {
        const checks = JSON.parse(box.toli(["doctor", "--json"], { env }).stdout) as {
            level: string;
            name: string;
            detail: string;
        }[];
        const check = checks.find((entry) => entry.name === "scheduler");
        return `${check?.level} ${check?.detail}`;
    }

    test("crontab: schedule status and doctor warn with the other checkout's path", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        withCrontab(box, `* * * * * cd /srv/other-toli && bun ${other} job tick ${TAG}\n`);
        expect(doctorScheduler(box, linux)).toBe(
            `warn crontab tick runs ${other}, not this checkout (bin/toli schedule install moves it here)`,
        );
        const status = box.ok(["schedule", "status"], { env: linux });
        expect(status).toContain(`warn: the tick runs ${other}, not this checkout`);
        expect(JSON.parse(box.ok(["schedule", "status", "--json"], { env: linux }))).toMatchObject({ otherBin: other });
        box.ok(["schedule", "install"], { env: linux });
        expect(box.ok(["schedule", "status"], { env: linux })).not.toContain("warn");
        expect(doctorScheduler(box, linux)).toBe("ok crontab installed and loaded");
    });

    test("launchd: schedule status and doctor warn with the other checkout's path", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        box.stub("launchctl", "exit 0");
        const darwin = { TOLI_PLATFORM: "darwin", TOLI_DRY_RUN: "0", TOLI_LAUNCH_AGENTS_DIR: box.root };
        writeFileSync(
            join(box.root, "com.toli.tick.plist"),
            `<plist><array><string>${other}</string></array></plist>\n`,
        );
        expect(box.ok(["schedule", "status"], { env: darwin })).toContain(`warn: the tick runs ${other}`);
        expect(doctorScheduler(box, darwin)).toBe(
            `warn launchd tick runs ${other}, not this checkout (bin/toli schedule install moves it here)`,
        );
    });
});
