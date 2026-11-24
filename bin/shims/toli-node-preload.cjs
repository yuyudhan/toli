// toli's Node preload: `--require`d through NODE_OPTIONS in every jawan's and lead session's environment
// (src/jawans/env.ts leadBuildEnv), so the native subagents a session starts (omp `task`, Claude Code's Agent tool),
// which inherit it, carry it too. A Node test runner (Vitest, Jest) started outside a heavy-build slot takes one before
// its tests run, the way toli's cargo shim and rustc wrapper make a cargo build take one:
// `bin/toli build-slot --runner <this pid>` waits in line until a detached holder holds a slot for this process
// (src/fleet/cargo-slot.ts slotForRunner) and frees it once this process exits, however it exits, or once it and its
// children have run nothing for the idle window (T2668); inside a slot
// already (TOLI_BUILD_SLOT naming a busy slot and TOLI_BUILD_SLOT_HOLDER its holder, or its holder among this process's
// ancestors) it returns at once. The holder leaves the project's dev and live stacks running, which its tests may talk
// to. The runner then exports the slot as TOLI_BUILD_SLOT, so its workers and any build it starts run in that slot
// instead of queueing again. Watch and UI modes never end on their own, so they never take a slot. `playwright test`
// never takes one either (T2635): an e2e run drives browsers at a stack that is already up and compiles nothing, and
// queueing it behind other projects' cargo builds left that stack idle for hours; a build its config starts (a cargo
// through the shim or the rustc wrapper) takes a slot of its own. Every other Node process, and Bun (which ignores
// NODE_OPTIONS' `--require`), returns at once. It never fails: a runner runs even when toli cannot take a slot.
"use strict";

(() => {
    const script = (process.argv[1] ?? "").split("\\").join("/");
    const args = process.argv.slice(2);
    const positional = args.filter((arg) => !arg.startsWith("-"));
    const flag = (...names) => args.some((arg) => names.includes(arg.split("=")[0]) && !arg.endsWith("=false"));
    const vitest = /(^|\/)node_modules\/(\.bin\/vitest|vitest\/vitest\.mjs)$/.test(script);
    const jest = /(^|\/)node_modules\/(\.bin\/jest|jest(-cli)?\/bin\/jest\.js)$/.test(script);
    if (!vitest && !jest) return;
    // Vitest watches unless told to run once (`run`, or a non-interactive or CI shell); `--watch`, `watch`, `dev` and
    // `--ui` keep it running, as Jest's `--watch`/`--watchAll` does.
    const vitestWatch =
        vitest &&
        (["watch", "dev"].includes(positional[0] ?? "") ||
            flag("--watch", "-w", "--ui") ||
            (positional[0] !== "run" && process.stdin.isTTY === true && (process.env.CI ?? "") === ""));
    if (vitestWatch || (jest && flag("--watch", "--watchAll"))) return;
    const { spawnSync } = require("node:child_process");
    const { join } = require("node:path");
    try {
        const took = spawnSync(join(__dirname, "..", "toli"), ["build-slot", "--runner", String(process.pid)], {
            stdio: ["ignore", "pipe", "inherit"],
            encoding: "utf8",
        });
        const slot = (took.stdout ?? "").trim();
        if (/^\d+$/.test(slot)) process.env.TOLI_BUILD_SLOT = slot;
    } catch {
        // No slot: the runner runs at once, as it did before toli.
    }
})();
