// The disk keeper's watchdog thread (src/fleet/disk-watchdog.ts): it runs while the keeper's own thread may be blocked
// in a call that never returns, and past the time limit logs the stop and kills the keeper.
import { appendFileSync, mkdirSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../core/paths.ts";
import { now } from "../core/util.ts";
import { limitText, type Watch } from "./disk-watchdog.ts";

declare const self: Worker;

self.onmessage = (event: MessageEvent<Watch>) => {
    const { limitMs, pid } = event.data;
    setTimeout(() => {
        const line =
            `disk keeper: stopped after its time limit of ${limitText(limitMs)}: a call it made never returned ` +
            "(a macOS privacy prompt nobody answered, a hung disk or tool); the next run starts over";
        try {
            mkdirSync(dirname(paths.diskLog()), { recursive: true });
            appendFileSync(paths.diskLog(), `${now().toISOString()} ${line}\n`);
        } catch {
            // A full or unwritable disk: stderr still says it, and the keeper must stop either way.
        }
        try {
            writeSync(2, `toli: ${line}\n`);
        } catch {
            // No stderr (a detached keeper whose log is gone): the stop goes on regardless.
        }
        process.kill(pid, "SIGKILL");
    }, limitMs);
};
