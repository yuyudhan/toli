// Preloaded into a test's toli processes (BUN_OPTIONS="--preload <this file>"): reading the folder named by
// STALL_READDIR blocks the reading thread for good, as a macOS privacy prompt nobody answers does (T2243).
import { createRequire } from "node:module";

type Fs = { readdirSync: (...args: unknown[]) => unknown };

const stalled = process.env.STALL_READDIR;
if (stalled !== undefined && stalled !== "") {
    const fs = createRequire(import.meta.url)("node:fs") as Fs;
    const readdir = fs.readdirSync;
    fs.readdirSync = (...args: unknown[]): unknown => {
        if (String(args[0]) === stalled) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        return readdir(...args);
    };
}
