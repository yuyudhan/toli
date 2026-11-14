import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths } from "../src/core/paths.ts";
import { leadBuildEnv } from "../src/jawans/env.ts";
import { CARGO_SHIM, holdSlot, runs, slotBox, start, until } from "./build-slot-fixture.ts";
import { withProject } from "./helpers.ts";

// The lead's calls clear the jawan markers themselves: these tests may run inside a jawan or a gate agent.
const LEAD = { TOLI_ROLE: "", NO_MISTAKES_GATE: "" };

describe("a lead session's build variables, inherited by its native subagents", () => {
    test("put toli's cargo shim first on PATH, once, cap cargo jobs and test threads and chain toli's rustc wrapper", () => {
        const shims = paths.buildShimsDir();
        const wrapper = join(shims, "toli-rustc-wrapper");
        const home = { CARGO_HOME: "/nonexistent-cargo-home" };
        expect(leadBuildEnv({ ...home, PATH: "/usr/bin:/bin" }, 4)).toEqual({
            PATH: `${shims}:/usr/bin:/bin`,
            CARGO_BUILD_JOBS: "4",
            RUST_TEST_THREADS: "4",
            NEXTEST_TEST_THREADS: "4",
            VITEST_MAX_WORKERS: "4",
            VITEST_MAX_THREADS: "4",
            VITEST_MAX_FORKS: "4",
            CARGO_CACHE_RUSTC_INFO: "0",
            RUSTC_WRAPPER: wrapper,
            TOLI_RUSTC_WRAPPER_NEXT: "",
        });
        expect(leadBuildEnv({ ...home, PATH: `/bin:${shims}` }, 4).PATH).toBe(`${shims}:/bin`);
        expect(leadBuildEnv(home, 4).PATH).toBe(shims);
        // The wrapper it replaces is chained to: an inherited one, else cargo's user config's (sccache).
        expect(leadBuildEnv({ ...home, RUSTC_WRAPPER: "sccache" }, 4).TOLI_RUSTC_WRAPPER_NEXT).toBe("sccache");
        const again = { ...home, RUSTC_WRAPPER: wrapper, TOLI_RUSTC_WRAPPER_NEXT: "sccache" };
        expect(leadBuildEnv(again, 4)).toMatchObject({ RUSTC_WRAPPER: wrapper, TOLI_RUSTC_WRAPPER_NEXT: "sccache" });
        const cargoHome = mkdtempSync(join(tmpdir(), "toli-cargo-home-"));
        writeFileSync(join(cargoHome, "config.toml"), '[build]\nrustc-wrapper = "/opt/bin/sccache"\njobs = 4\n');
        expect(leadBuildEnv({ CARGO_HOME: cargoHome }, 4).TOLI_RUSTC_WRAPPER_NEXT).toBe("/opt/bin/sccache");
    });

    test("bin/toli hook lead-build-env gives a lead the shim and the machine's cargo jobs, a jawan nothing", () => {
        const { box } = slotBox(1, 3);
        const vars = JSON.parse(box.ok(["hook", "lead-build-env"], { env: LEAD })) as Record<string, string>;
        expect(vars.CARGO_BUILD_JOBS).toBe("3");
        // The shim folder is the toli root's: the sandbox's here.
        expect(vars.PATH?.startsWith(`${join(box.root, "bin", "shims")}:${box.stubs}:`)).toBe(true);
        expect(box.ok(["hook", "lead-build-env"], { env: { ...LEAD, TOLI_ROLE: "jawan" } })).toBe("{}");
    });

    test("a Claude Code lead's SessionStart exports them, so a subagent's cargo build waits for the slot", async () => {
        const { box, log } = slotBox(1, 3);
        const envFile = join(box.root, ".claude-env");
        // The sandbox is the toli root the exported PATH names: give it toli's real shim folder.
        mkdirSync(join(box.root, "bin"));
        symlinkSync(dirname(CARGO_SHIM), join(box.root, "bin", "shims"));
        const input = JSON.stringify({ cwd: box.root, hook_event_name: "SessionStart" });
        writeFileSync(envFile, "");
        box.ok(["hook", "claude-session-start"], {
            stdin: input,
            env: { ...LEAD, TOLI_ROLE: "jawan", CLAUDE_ENV_FILE: envFile },
        });
        expect(readFileSync(envFile, "utf8")).toBe("");
        box.ok(["hook", "claude-session-start"], { stdin: input, env: { ...LEAD, CLAUDE_ENV_FILE: envFile } });
        expect(readFileSync(envFile, "utf8")).toContain("export CARGO_BUILD_JOBS=3\n");
        const holder = await holdSlot(box, log);
        // A Bash call of the session (or of its subagent): Claude Code sources the file first; the stub cargo is the
        // first cargo on the session's own PATH.
        const sessionPath = [box.stubs, dirname(process.execPath), "/usr/bin", "/bin"].join(":");
        const build = start(box, ["sh", "-c", `. '${envFile}' && exec cargo build`], {
            STUB_LABEL: "b",
            PATH: sessionPath,
        });
        await until("the subagent's build waiting", () =>
            build.stderr.join("").includes("waiting for a heavy-build slot"),
        );
        expect(runs(log).some((run) => run.label === "b")).toBe(false);
        writeFileSync(`${log}.done-a`, "");
        const [held, built] = await Promise.all([holder.done, build.done]);
        expect([held.code, built.code]).toEqual([0, 0]);
        expect(runs(log).find((run) => run.label === "b")).toMatchObject({ slot: "1", jobs: "3", args: "build" });
    }, 30_000);

    test("a build in a live-stack project's checkout skips the slots, its cargo jobs still capped", async () => {
        const { box, log } = slotBox(1, 3);
        withProject(box, "app");
        box.ok(["project", "set", "app", "--live-stack", "yes"]);
        const holder = await holdSlot(box, log);
        const checkout = join(box.root, "projects", "app");
        const result = await start(box, [CARGO_SHIM, "test"], { STUB_LABEL: "b", CARGO_BUILD_JOBS: "" }, checkout).done;
        holder.proc.kill("SIGKILL");
        expect(result.code).toBe(0);
        expect(result.stderr).not.toContain("waiting");
        expect(runs(log).find((run) => run.label === "b")).toMatchObject({ slot: "none", jobs: "3", args: "test" });
    }, 30_000);
});
