// A heavy build in its own systemd scope compiles through an sccache server of its own (T24): sccache's server, not
// cargo, starts every rustc, so the server must live in the build's scope for the build's MemoryMax to cap its rustc.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scopeBox, scopeLines, slotBox, start, TERMINAL_CGROUP, toliArgs } from "./build-slot-fixture.ts";
import type { Sandbox } from "./helpers.ts";

/** A stub sccache that logs each call with the server socket it would use; `--start-server` binds that socket. */
function stubSccache(box: Sandbox, calls: string): void {
    box.stub(
        "sccache",
        [
            `printf '%s %s\\n' "$*" "\${SCCACHE_SERVER_UDS:-shared}" >> "${calls}"`,
            `[ "$1" = --start-server ] && [ -n "\${SCCACHE_SERVER_UDS:-}" ] && : > "$SCCACHE_SERVER_UDS"`,
            "exit 0",
        ].join("\n"),
    );
}

const build = toliArgs("build-slot", "--", "sh", "-c", "sccache --start-server");

describe("a heavy build's sccache server", () => {
    test("a build in its scope gets its own server there, stopped once the build ends", async () => {
        const { box, scopeLog, env } = scopeBox(TERMINAL_CGROUP);
        const calls = join(box.root, ".sccache-calls");
        stubSccache(box, calls);
        expect((await start(box, build, env).done).code).toBe(0);
        const pid = /--unit=toli-build-1-(\d+)\.scope/.exec(scopeLines(scopeLog)[0] ?? "")?.[1];
        expect(pid).toBeDefined();
        // The server a compile in the scope starts lives in that scope, so the build's MemoryMax caps the rustc it
        // runs; the machine's shared server (default socket) is never started from inside a build scope.
        const socket = join(env.XDG_RUNTIME_DIR ?? "", `toli-sccache-1-${pid}.sock`);
        expect(readFileSync(calls, "utf8").split("\n")).toEqual([
            `--start-server ${socket}`,
            `--stop-server ${socket}`,
            "",
        ]);
        expect(existsSync(socket)).toBe(false);
    }, 30_000);

    test("a build without a scope keeps the shared server, and nothing is stopped", async () => {
        const { box } = slotBox(1, 3);
        const calls = join(box.root, ".sccache-calls");
        stubSccache(box, calls);
        expect((await start(box, build, { SCCACHE_SERVER_UDS: "" }).done).code).toBe(0);
        expect(readFileSync(calls, "utf8")).toBe("--start-server shared\n");
    }, 30_000);
});
