// T2266: a toli started by a service (minimal PATH) still finds the user's toolchains (~/.cargo/bin, ~/.bun/bin, ...),
// with the cargo shim first on a jawan's PATH, and a Cargo.lock check without cargo says so plainly.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { paths } from "../src/core/paths.ts";
import { TOOL_DIRS_FLAG, withUserToolDirs } from "../src/core/tool-path.ts";
import { safeCommit } from "../src/projects/commit.ts";
import { repo, useGitEnv } from "./commit-fixture.ts";
import { tempDir } from "./helpers.ts";
import { brief, coordinator, type Run, waitFor } from "./jawan-fixture.ts";

setDefaultTimeout(60_000);
useGitEnv();

/** A home folder holding the given tool folders, each made to exist. */
function homeWith(dirs: string[]): string {
    const home = tempDir("tool-home");
    for (const dir of dirs) mkdirSync(join(home, dir), { recursive: true });
    return home;
}

describe("the user's tool folders on PATH", () => {
    test("existing tool folders PATH lacks are appended after it, in order, once", () => {
        const home = homeWith([".cargo/bin", ".bun/bin", ".local/bin"]);
        const env = {
            HOME: home,
            PATH: `/service/bin${delimiter}${join(home, ".bun/bin")}`,
            CARGO_HOME: "",
            BUN_INSTALL: "",
        };
        const path = (withUserToolDirs(env) ?? "").split(delimiter);
        expect(path.slice(0, 3)).toEqual(["/service/bin", join(home, ".bun/bin"), join(home, ".cargo/bin")]);
        expect(path).toContain(join(home, ".local/bin"));
        expect(path).not.toContain(join(home, "bin"));
        expect(path.filter((dir) => dir === join(home, ".bun/bin"))).toHaveLength(1);
    });

    test("CARGO_HOME and BUN_INSTALL name cargo's and Bun's folders; off leaves PATH alone", () => {
        const home = homeWith(["rust/bin", "bun-home/bin", ".cargo/bin"]);
        const env = {
            HOME: home,
            PATH: "/service/bin",
            CARGO_HOME: join(home, "rust"),
            BUN_INSTALL: join(home, "bun-home"),
        };
        const path = (withUserToolDirs(env) ?? "").split(delimiter);
        expect(path.slice(0, 3)).toEqual(["/service/bin", join(home, "rust/bin"), join(home, "bun-home/bin")]);
        expect(path).not.toContain(join(home, ".cargo/bin"));
        expect(withUserToolDirs({ ...env, [TOOL_DIRS_FLAG]: "off" })).toBe("/service/bin");
    });

    test("a world-writable folder or one another user owns is never added; a user-owned group-writable one is", () => {
        const home = homeWith([".cargo/bin", ".bun/bin", ".local/bin"]);
        // Real mode bits: ~/.cargo/bin is world-writable (0777), so anyone could plant a cargo there.
        chmodSync(join(home, ".cargo/bin"), 0o777);
        const uid = process.getuid?.() ?? 0;
        const stranger = uid + 4242;
        // The owner is simulated: ~/.bun/bin belongs to another (non-root) user, ~/.local/bin is ours and 0775.
        const owners: Record<string, number> = { [join(home, ".bun/bin")]: stranger };
        const modes: Record<string, number> = { [join(home, ".local/bin")]: 0o40775 };
        const stat = (dir: string) => {
            const real = statSync(dir, { throwIfNoEntry: false });
            if (real === undefined) return undefined;
            return { isDirectory: () => real.isDirectory(), uid: owners[dir] ?? uid, mode: modes[dir] ?? real.mode };
        };
        const env = { HOME: home, PATH: "/service/bin", CARGO_HOME: "", BUN_INSTALL: "" };
        const path = (withUserToolDirs(env, stat, uid) ?? "").split(delimiter);
        expect(path).not.toContain(join(home, ".cargo/bin"));
        expect(path).not.toContain(join(home, ".bun/bin"));
        expect(path).toContain(join(home, ".local/bin"));
    });

    test("a folder PATH already holds with a trailing slash is not added again", () => {
        const home = homeWith([".cargo/bin"]);
        const env = {
            HOME: home,
            PATH: `/service/bin${delimiter}${join(home, ".cargo/bin")}/`,
            CARGO_HOME: "",
            BUN_INSTALL: "",
        };
        // The host's own /opt/homebrew/bin or /usr/local/bin may still be appended: only cargo's folder matters here.
        const path = (withUserToolDirs(env) ?? "").split(delimiter);
        expect(path.slice(0, 2)).toEqual(["/service/bin", `${join(home, ".cargo/bin")}/`]);
        expect(path).not.toContain(join(home, ".cargo/bin"));
    });

    test("a jawan spawned with a service's PATH and no login shell finds ~/.cargo/bin's cargo through the shim", async () => {
        const box = coordinator();
        // The sandbox is the toli root a jawan's PATH starts with: give it toli's real shim folder.
        const shims = join(box.root, "bin", "shims");
        mkdirSync(join(box.root, "bin"), { recursive: true });
        symlinkSync(paths.buildShimsDir(), shims);
        const home = homeWith([".cargo/bin", ".local/bin"]);
        const cargo = join(home, ".cargo/bin/cargo");
        writeFileSync(cargo, '#!/bin/sh\necho "cargo from home $*"\n');
        chmodSync(cargo, 0o755);
        box.stub("omp", 'cargo --version; echo "path=$PATH"');
        // TOLI_LOGIN_ENV stays off: the folders come without the login profile's help.
        const env = { HOME: home, [TOOL_DIRS_FLAG]: "", CARGO_HOME: "", BUN_INSTALL: "" };
        const started = JSON.parse(
            box.ok(["spawn", "--harness", "omp", "--brief", brief(box), "--cwd", box.root, "--json"], { env }),
        ) as Run;
        const done = await waitFor(box, started.id, (run) => run.status === "done");
        const log = readFileSync(done.logPath, "utf8");
        expect(log).toContain("cargo from home --version");
        const path = (/^path=(.*)$/m.exec(log)?.[1] ?? "").split(delimiter);
        expect(path[0]).toBe(shims);
        expect(path).toContain(join(home, ".local/bin"));
        // The service's own PATH keeps its precedence over the added folders.
        expect(path.indexOf(box.stubs)).toBeLessThan(path.indexOf(join(home, ".cargo/bin")));
    });
});

describe("the Cargo.lock check without cargo", () => {
    /** A PATH folder with only git, gitleaks and what the cargo shim needs: no cargo anywhere on it. */
    function toolsWithoutCargo(): string {
        const bin = tempDir("no-cargo-bin");
        for (const tool of ["git", "gitleaks", "dirname", "sed"]) {
            const found = Bun.which(tool);
            if (found !== null) symlinkSync(found, join(bin, tool));
        }
        return bin;
    }

    const lock = 'version = 4\n\n[[package]]\nname = "a"\nversion = "0.1.0"\n';

    test.each([
        ["no cargo on PATH", false],
        ["only the cargo shim on PATH", true],
    ])("%s: refuses with cargo not found on PATH", (_, shim) => {
        const dir = repo();
        writeFileSync(join(dir, "Cargo.lock"), lock);
        const bin = toolsWithoutCargo();
        const saved = process.env.PATH;
        process.env.PATH = shim ? `${paths.buildShimsDir()}${delimiter}${bin}` : bin;
        try {
            expect(() => safeCommit({ dir, paths: ["Cargo.lock"], message: "Lock" })).toThrow(
                "cargo not found on PATH",
            );
        } finally {
            process.env.PATH = saved;
        }
    });
});
