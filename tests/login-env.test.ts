import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialNames, mergeLoginEnv } from "../src/core/login-env.ts";
import type { Sandbox } from "./helpers.ts";
import { brief, coordinator, type Run, waitFor } from "./jawan-fixture.ts";

// Each test runs bash login shells and waits on a detached run.
setDefaultTimeout(30_000);

/**
 * A service-like environment: the sandbox's bare PATH and a HOME whose bash login profile alone exports `profile`.
 * Nothing else the test sets carries those variables, as under a launchd agent or systemd user service.
 */
function loginHome(box: Sandbox, profile: Record<string, string>): Record<string, string> {
    const home = join(box.root, ".home");
    mkdirSync(home, { recursive: true });
    const lines = Object.entries(profile).map(([key, value]) => `export ${key}=${value}`);
    writeFileSync(join(home, ".bash_profile"), `echo "profile noise"\n${lines.join("\n")}\n`);
    return { HOME: home, SHELL: "/bin/bash", TOLI_LOGIN_ENV: "" };
}

describe("login environment", () => {
    test("a jawan spawned from a service-like environment gets a variable only the login profile exports", async () => {
        const box = coordinator();
        box.stub("omp", `echo "key=\${TOLI_TEST_LOGIN_KEY:-missing} path=$PATH"`);
        const env = loginHome(box, { TOLI_TEST_LOGIN_KEY: "from-profile", PATH: "/profile/bin:$PATH" });
        const started = JSON.parse(
            box.ok(["spawn", "--harness", "omp", "--brief", brief(box), "--cwd", box.root, "--json"], { env }),
        ) as Run;
        const done = await waitFor(box, started.id, (run) => run.status === "done");
        const log = readFileSync(done.logPath, "utf8");
        expect(log).toContain("key=from-profile");
        // The service's PATH wins over the profile's.
        expect(log).not.toContain("/profile/bin");
    });

    test("doctor warns, by name only, about a credential the login profile does not export", () => {
        const box = coordinator();
        const marker = `value-${crypto.randomUUID()}`;
        // The host's own credential variables are blanked: only the test's one is set in "this shell".
        const hostKeys = Object.fromEntries(credentialNames(process.env).map((name) => [name, ""]));
        const check = (profile: Record<string, string>): { level: string; detail: string } => {
            const result = box.toli(["doctor", "--json"], {
                env: { ...hostKeys, ...loginHome(box, profile), TOLI_TEST_SERVICE_API_KEY: marker },
            });
            expect(result.stdout).not.toContain(marker);
            const checks = JSON.parse(result.stdout) as { level: string; name: string; detail: string }[];
            const found = checks.find((entry) => entry.name === "service-env");
            if (found === undefined) throw new Error(`no service-env check in ${result.stdout}`);
            return found;
        };
        const missing = check({});
        expect(missing.level).toBe("warn");
        expect(missing.detail).toContain("TOLI_TEST_SERVICE_API_KEY set in this shell but not by the login profile");
        const present = check({ TOLI_TEST_SERVICE_API_KEY: "other-value" });
        expect(present.level).toBe("ok");
        expect(present.detail).toContain("services see TOLI_TEST_SERVICE_API_KEY");
    });

    test("merging adds only what the environment lacks and never the shell's bookkeeping", () => {
        const base: Record<string, string | undefined> = { PATH: "/service/bin", EMPTY: "" };
        const added = mergeLoginEnv(base, {
            PATH: "/profile/bin",
            EMPTY: "filled",
            NEW_KEY: "new",
            PWD: "/somewhere",
            SHLVL: "2",
        });
        expect(added).toEqual(["EMPTY", "NEW_KEY"]);
        expect(base).toEqual({ PATH: "/service/bin", EMPTY: "filled", NEW_KEY: "new" });
    });
});
