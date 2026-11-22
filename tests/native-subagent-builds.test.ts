import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "../src/core/paths.ts";
import { jawanEnv, leadBuildEnv, nodePreloadOptions, nodePreloadStub } from "../src/jawans/env.ts";
import { CARGO_SHIM, holdSlot, runs, slotBox, start, until } from "./build-slot-fixture.ts";
import { tempDir, withProject } from "./helpers.ts";

// The lead's calls clear the jawan markers themselves: these tests may run inside a jawan or a gate agent.
const LEAD = { TOLI_ROLE: "", NO_MISTAKES_GATE: "" };

describe("a lead session's build variables, inherited by its native subagents", () => {
    test("put toli's shims first on PATH, once, cap cargo jobs and test threads, chain toli's rustc wrapper and preload Node", () => {
        const shims = paths.buildShimsDir();
        const wrapper = join(shims, "toli-rustc-wrapper");
        const preload = `--require ${nodePreloadStub()}`;
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
            NODE_OPTIONS: preload,
        });
        expect(leadBuildEnv({ ...home, PATH: `/bin:${shims}` }, 4).PATH).toBe(`${shims}:/bin`);
        expect(leadBuildEnv(home, 4).PATH).toBe(shims);
        // The caller's own Node options stay, and the preload is added once.
        const options = `--max-old-space-size=512 ${preload}`;
        expect(leadBuildEnv({ ...home, NODE_OPTIONS: "--max-old-space-size=512" }, 4).NODE_OPTIONS).toBe(options);
        expect(leadBuildEnv({ ...home, NODE_OPTIONS: options }, 4).NODE_OPTIONS).toBe(options);
        expect(nodePreloadOptions({ NODE_OPTIONS: options })).toBe(options);
        // An older toli's direct `--require` of the preload gives way to the stub; a stub not written stays out.
        const direct = `--max-old-space-size=512 --require ${join(shims, "toli-node-preload.cjs")}`;
        expect(leadBuildEnv({ ...home, NODE_OPTIONS: direct }, 4).NODE_OPTIONS).toBe(options);
        expect(leadBuildEnv({ ...home, NODE_OPTIONS: options }, 4, false).NODE_OPTIONS).toBe(
            "--max-old-space-size=512",
        );
        // The wrapper it replaces is chained to: an inherited one, else cargo's user config's (sccache).
        expect(leadBuildEnv({ ...home, RUSTC_WRAPPER: "sccache" }, 4).TOLI_RUSTC_WRAPPER_NEXT).toBe("sccache");
        const again = { ...home, RUSTC_WRAPPER: wrapper, TOLI_RUSTC_WRAPPER_NEXT: "sccache" };
        expect(leadBuildEnv(again, 4)).toMatchObject({ RUSTC_WRAPPER: wrapper, TOLI_RUSTC_WRAPPER_NEXT: "sccache" });
        const cargoHome = tempDir("cargo-home");
        writeFileSync(join(cargoHome, "config.toml"), '[build]\nrustc-wrapper = "/opt/bin/sccache"\njobs = 4\n');
        expect(leadBuildEnv({ CARGO_HOME: cargoHome }, 4).TOLI_RUSTC_WRAPPER_NEXT).toBe("/opt/bin/sccache");
    });

    test("a jawan gets the Node preload; a live-stack project's jawan drops an inherited one", () => {
        const preload = nodePreloadOptions({});
        const base = { PATH: "/usr/bin", NODE_OPTIONS: `--max-old-space-size=512 ${preload}` };
        expect(jawanEnv({ PATH: "/usr/bin" }, "j-1", 4).NODE_OPTIONS).toBe(preload);
        expect(jawanEnv(base, "j-1", 4, true).NODE_OPTIONS).toBe("--max-old-space-size=512");
        expect(jawanEnv({ PATH: "/usr/bin", NODE_OPTIONS: preload }, "j-1", 4, true).NODE_OPTIONS).toBeUndefined();
    });

    test("the stable stub runs node normally with the preload gone, and loads it while it is there (T2259)", () => {
        const { box } = slotBox(1, 3);
        const vars = JSON.parse(box.ok(["hook", "lead-build-env"], { env: LEAD })) as Record<string, string>;
        const stub = join(box.root, ".toli-preload");
        // Inside a build slot the caller's NODE_OPTIONS already holds a heap cap: the stub's `--require` follows it.
        expect(vars.NODE_OPTIONS).toContain(`--require ${stub}/node-`);
        const node = (): { code: number; out: string } => {
            const ran = Bun.spawnSync([Bun.which("node") ?? "node", "-e", "console.log('ok')"], {
                env: { PATH: process.env.PATH ?? "", NODE_OPTIONS: vars.NODE_OPTIONS ?? "" },
            });
            return { code: ran.exitCode, out: ran.stdout.toString() };
        };
        // The sandbox's checkout has no bin/shims/toli-node-preload.cjs: an older commit, a pruned runtime.
        expect(node()).toEqual({ code: 0, out: "ok\n" });
        const marker = join(box.root, "preloaded");
        mkdirSync(join(box.root, "bin", "shims"), { recursive: true });
        writeFileSync(
            join(box.root, "bin", "shims", "toli-node-preload.cjs"),
            `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1");\n`,
        );
        expect(node()).toEqual({ code: 0, out: "ok\n" });
        expect(readFileSync(marker, "utf8")).toBe("1");
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
