// `just verify` = `just check` plus these smoke checks of the real CLI and installer (run after check):
//   bin/toli version, bin/toli doctor, bin/toli harness sync --check, bin/toli setup status (when the command exists),
//   install.sh under POSIX sh (`sh -n`, `dash -n` when dash is installed, `shellcheck -s sh`), and a file:// install
//   of the committed HEAD into a temp directory with install.sh --yes (run by `sh`: dash on Debian/Ubuntu).
// doctor's "fail" lines are tolerated only on a checkout without config/machine.json (a fresh clone or the release
// dry-run clone), where they are first-run setup rather than breakage. TOLI_DEV=1 makes bin/toli run this working
// tree even when the checkout has an installed runtime (src/release/runtime.ts).
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { latestTag } from "../src/release/release.ts";

const ROOT = resolve(import.meta.dir, "..");
const TOLI = join(ROOT, "bin", "toli");

const say = (line: string) => process.stdout.write(`${line}\n`);

function exec(cmd: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
    const result = Bun.spawnSync(cmd, {
        cwd: options.cwd ?? ROOT,
        env: { ...process.env, TOLI_DEV: "1", ...options.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    return { code: result.exitCode ?? 1, output: `${result.stdout.toString()}${result.stderr.toString()}`.trim() };
}

const failures: string[] = [];

function check(name: string, cmd: string[], accept: (code: number, output: string) => string | null): void {
    const { code, output } = exec(cmd);
    const problem = accept(code, output);
    say(`verify: ${problem === null ? "ok  " : "FAIL"} ${name}`);
    if (problem !== null) {
        failures.push(`${name}: ${problem}`);
        say(output.replace(/^/gm, "    "));
    }
}

const exitZero = (code: number) => (code === 0 ? null : `exit ${code}`);

check("bin/toli version", [TOLI, "version"], exitZero);
const machineConfigured = existsSync(join(ROOT, "config", "machine.json"));
check("bin/toli doctor", [TOLI, "doctor"], (code, output) => {
    if (code === 0) return null;
    if (code === 1 && !machineConfigured && /^fail machine /m.test(output)) return null;
    return `exit ${code}`;
});
check("bin/toli harness sync --check", [TOLI, "harness", "sync", "--check"], exitZero);
const usage = exec([TOLI, "help"]).output;
if (/^\s*setup status/m.test(usage)) check("bin/toli setup status", [TOLI, "setup", "status"], exitZero);
check("sh -n install.sh", ["sh", "-n", "install.sh"], exitZero);
if (Bun.which("dash") !== null) check("dash -n install.sh", ["dash", "-n", "install.sh"], exitZero);
check("shellcheck -s sh install.sh", ["shellcheck", "-s", "sh", "install.sh"], exitZero);

// Install the committed HEAD from a file:// bare copy, the way `curl .../install.sh | sh` installs a release.
const tmp = mkdtempSync(join(tmpdir(), "toli-verify-"));
try {
    const bare = join(tmp, "toli.git");
    const target = join(tmp, "install");
    exec(["git", "clone", "--quiet", "--bare", ROOT, bare]);
    const pkg: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const version = typeof pkg === "object" && pkg !== null ? String(Reflect.get(pkg, "version")) : "0.0.0";
    const tags = exec(["git", "tag", "--list", "v*"], { cwd: bare }).output.split("\n").filter(Boolean);
    if (!tags.includes(`v${version}`)) exec(["git", "tag", `v${version}`, "HEAD"], { cwd: bare });
    const expected = latestTag([...tags, `v${version}`]);
    const install = exec(["sh", join(ROOT, "install.sh"), "--dir", target, "--yes"], {
        env: { TOLI_REPO_URL: `file://${bare}` },
    });
    const installed = exec([join(target, "bin", "toli"), "version"], { cwd: target }).output;
    const problem =
        install.code !== 0
            ? `install.sh exit ${install.code}`
            : installed === `toli ${expected}`
              ? null
              : `installed "${installed}", expected toli ${expected}`;
    say(`verify: ${problem === null ? "ok  " : "FAIL"} install.sh --yes from file:// (${expected})`);
    if (problem !== null) {
        failures.push(`install.sh: ${problem}`);
        say(install.output.replace(/^/gm, "    "));
    }
} finally {
    rmSync(tmp, { recursive: true, force: true });
}

if (failures.length > 0) {
    say(`verify: ${failures.length} smoke check(s) failed:\n- ${failures.join("\n- ")}`);
    process.exit(1);
}
say("verify: all smoke checks passed");
