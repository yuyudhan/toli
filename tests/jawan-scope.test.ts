import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Sandbox } from "./helpers.ts";
import { brief, coordinator, type Run, waitFor } from "./jawan-fixture.ts";

setDefaultTimeout(30_000);

/** Linux with a user manager (a fake runtime dir with its private socket) and a systemd-run that logs and execs. */
function linuxBox(withManager: boolean): { box: Sandbox; env: Record<string, string>; log: string } {
    const box = coordinator();
    const runtime = join(box.root, ".run-user");
    mkdirSync(join(runtime, "systemd"), { recursive: true });
    if (withManager) writeFileSync(join(runtime, "systemd", "private"), "");
    const log = join(box.root, ".systemd-run.log");
    box.stub(
        "systemd-run",
        [
            `printf '%s\\n' "$*" >> "${log}"`,
            'while [ "$#" -gt 0 ]; do case "$1" in --*) shift ;; *) break ;; esac; done',
            'exec "$@"',
        ].join("\n"),
    );
    box.stub("omp", 'echo "in scope"');
    return { box, env: { TOLI_PLATFORM: "linux", TOLI_JAWAN_SCOPE: "", XDG_RUNTIME_DIR: runtime }, log };
}

function spawn(box: Sandbox, env: Record<string, string>): Run {
    return JSON.parse(
        box.ok(["spawn", "--harness", "omp", "--brief", brief(box), "--cwd", box.root, "--json"], { env }),
    ) as Run;
}

describe("each jawan in its own systemd scope", () => {
    test("on Linux with a user manager the supervisor starts through systemd-run --user --scope", async () => {
        const { box, env, log } = linuxBox(true);
        const started = spawn(box, env);
        const done = await waitFor(box, started.id, (run) => run.status === "done" && run.inbox !== null);
        expect(readFileSync(done.logPath, "utf8")).toBe("in scope\n");
        const line = readFileSync(log, "utf8").trim();
        expect(line).toStartWith(
            `--user --scope --quiet --collect --unit=toli-jawan-${started.id}.scope --description=toli jawan `,
        );
        expect(line).toEndWith(`run supervise ${started.id}`);
    });

    test("without a user manager, or off Linux, it starts as before", async () => {
        const { box, env, log } = linuxBox(false);
        const started = spawn(box, env);
        await waitFor(box, started.id, (run) => run.status === "done");
        const mac = spawn(box, { ...env, TOLI_PLATFORM: "darwin" });
        await waitFor(box, mac.id, (run) => run.status === "done");
        expect(existsSync(log)).toBe(false);
    });
});
