// The tick's background disk keeper: one it recorded and that still runs holds the next off; past 1 h it is killed
// and replaced; a recorded pid now owned by another program is never killed (T2170).
import { describe, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "../src/core/util.ts";
import { buildOutput, dfLine, keeperBox, keeperTest, setCapacity } from "./disk-fixture.ts";
import { tempDir, withProject } from "./helpers.ts";

describe("the tick's background disk keeper", () => {
    // A keeper hung in a macOS privacy prompt had already released its lock, so every tick under the floor started
    // another: 140 hung keepers.
    keeperTest(
        "a live background keeper it recorded holds the tick off; past 1 h the tick kills it and starts another",
        async () => {
            const box = keeperBox();
            box.ok(["init", "--name", "m1", "--role", "coordinator"]);
            box.stub("docker", "exit 1");
            box.stub("sccache", "exit 2");
            buildOutput(box, withProject(box, "alpha"));
            setCapacity(box, { diskKeepGB: 20 });
            box.stub("df", `kb=1048576\n${dfLine(1000)}`);
            // ps still lists no host processes, but describes one pid, as the tick's check of its recorded keeper asks.
            box.stub("ps", 'case " $* " in *" -p "*) exec /bin/ps "$@" ;; esac');
            const env = { TOLI_DRY_RUN: "0" };
            const tickLog = join(box.root, "logs", "tick.log");
            const recordPath = join(box.root, "state", "disk-keep.background.json");
            const recorded = (): number => (JSON.parse(readFileSync(recordPath, "utf8")) as { pid: number }).pid;
            // A hung keeper: a toli `disk keep` that never ends and holds no keeper lock.
            const fake = join(tempDir("fake"), "toli");
            writeFileSync(fake, "sleep 60\n");
            const hung = Bun.spawn(["sh", fake, "disk", "keep", "--background"]);
            // Some other program that now has a pid toli once recorded.
            const stranger = Bun.spawn(["sleep", "60"]);
            try {
                mkdirSync(join(box.root, "state"), { recursive: true });
                writeFileSync(recordPath, JSON.stringify({ pid: hung.pid, startedAt: new Date().toISOString() }));

                box.ok(["job", "tick"], { env });
                expect(existsSync(tickLog) ? readFileSync(tickLog, "utf8") : "").not.toContain("disk keeper:");
                expect(recorded()).toBe(hung.pid);
                expect(hung.exitCode).toBeNull();

                const later = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
                box.ok(["job", "tick"], { env, now: later });
                expect(await hung.exited).not.toBe(0);
                expect(hung.signalCode).toBe("SIGKILL");
                const log = readFileSync(tickLog, "utf8");
                expect(log).toContain(`disk keeper: killed background keeper pid ${hung.pid}, running 120 min`);
                expect(log).toContain("free 1.0 GB < floor 20.0 GB: started in the background");
                const replacement = recorded();
                expect(replacement).not.toBe(hung.pid);

                // A recorded pid that is no longer a toli process is never killed, only replaced.
                const keeperDone = Date.now() + 90_000;
                while (Date.now() < keeperDone && pidAlive(replacement)) Bun.sleepSync(200);
                const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
                writeFileSync(recordPath, JSON.stringify({ pid: stranger.pid, startedAt: old }));
                box.ok(["job", "tick"], { env });
                expect(stranger.exitCode).toBeNull();
                expect(recorded()).not.toBe(stranger.pid);
                expect(readFileSync(tickLog, "utf8")).not.toContain(`pid ${stranger.pid}`);
            } finally {
                hung.kill("SIGKILL");
                stranger.kill("SIGKILL");
            }
        },
    );
});
