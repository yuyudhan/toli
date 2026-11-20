// The spawn-env guard (scripts/guard/spawn-env.ts): main() drops inherited repository-locating git variables from
// process.env, but Bun gives a spawn without an `env` option, and a Worker, the environment the process started with
// (T2052). Every program toli starts must therefore get an explicit env.
import { describe, expect, test } from "bun:test";
import guard, { spawnsWithoutEnv } from "../scripts/guard/spawn-env.ts";
import { collectScope } from "../scripts/guard-lib.ts";

describe("the spawn-env guard", () => {
    test("flags Bun.spawn, Bun.spawnSync, Worker and child_process calls without an env option", () => {
        const text = [
            'import { execSync, spawn as spawnChild } from "node:child_process";',
            'Bun.spawn(["ssh", host], { stdio: ["inherit", "inherit", "inherit"] });',
            'const sync = Bun.spawnSync(["git", "status"]);',
            'const worker = new Worker(new URL("./w.ts", import.meta.url).href);',
            `spawnChild(process.execPath, [\`\${dir}/x\`, "("], {`,
            "    cwd: root, // env comes later? no",
            "    detached: true,",
            "});",
            'execSync("git status");',
        ].join("\n");
        expect(spawnsWithoutEnv("src/x.ts", text).map((violation) => violation.line)).toEqual([2, 3, 4, 5, 9]);
    });

    test("accepts calls that pass env, inline or shorthand, and ignores look-alikes", () => {
        const text = [
            'import { spawn } from "node:child_process";',
            'Bun.spawn(["ssh"], { env: process.env, stdio: ["inherit", "inherit", "inherit"] });',
            'Bun.spawnSync(["git"], {\n    cwd,\n    env,\n});',
            "new Worker(url, { env: workerEnv() });",
            'spawn(cmd, args, { cwd, env: { ...env, A: "1" } });',
            "const match = PATTERN.exec(line);",
            "server.spawn(thing);",
        ].join("\n");
        expect(spawnsWithoutEnv("src/x.ts", text)).toEqual([]);
    });

    test("the tree passes it", () => {
        expect(guard.run(collectScope({}).files)).toEqual([]);
    });
});
