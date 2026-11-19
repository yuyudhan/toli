// `bin/toli commit` stops a project's commit hook only past its configured limit: the project's
// `project set --hook-timeout <seconds|none>`, else config/machine.json capacity.commitHookTimeoutSeconds, else 300 s.
import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox, withProject } from "./helpers.ts";

/** Install an executable `name` hook (`body` is bash) in the clone's .git/hooks. */
function installHook(dir: string, name: string, body: string): void {
    const file = join(dir, ".git", "hooks", name);
    writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
    chmodSync(file, 0o755);
}

/** Merge `capacity` into the sandbox's config/machine.json. */
function setCapacity(box: Sandbox, capacity: Record<string, unknown>): void {
    const file = join(box.root, "config", "machine.json");
    const machine = JSON.parse(readFileSync(file, "utf8")) as { capacity?: Record<string, unknown> };
    machine.capacity = { ...machine.capacity, ...capacity };
    writeFileSync(file, `${JSON.stringify(machine, null, 2)}\n`);
}

function setup(): { box: Sandbox; dir: string } {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    return { box, dir: withProject(box, "app") };
}

describe("bin/toli commit: the commit-hook time limit", () => {
    test("a pre-commit hook past the machine default is stopped, naming the settings; a longer or no project limit lets it finish", () => {
        const { box, dir } = setup();
        setCapacity(box, { commitHookTimeoutSeconds: 1 });
        installHook(dir, "pre-commit", "exec sleep 2");
        writeFileSync(join(dir, "a.txt"), "a\n");
        const before = box.git(dir, ["rev-parse", "HEAD"]);
        const refused = box.toli(["commit", "app", "-m", "Add a", "--", "a.txt"]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("the pre-commit hook .git/hooks/pre-commit ran past its 1 s limit");
        expect(refused.stderr).toContain("bin/toli project set app --hook-timeout <seconds|none>");
        expect(refused.stderr).toContain("capacity.commitHookTimeoutSeconds");
        expect(box.git(dir, ["rev-parse", "HEAD"])).toBe(before);

        expect(box.ok(["project", "set", "app", "--hook-timeout", "10"])).toContain("hook-timeout=10s");
        const sha = box.ok(["commit", "app", "-m", "Add a", "--", "a.txt"]);
        expect(box.git(dir, ["rev-parse", "HEAD"])).toBe(sha);

        expect(box.ok(["project", "set", "app", "--hook-timeout", "none"])).toContain("hook-timeout=none");
        writeFileSync(join(dir, "b.txt"), "b\n");
        const second = box.ok(["commit", "app", "-m", "Add b", "--", "b.txt"]);
        expect(box.git(dir, ["rev-parse", "HEAD"])).toBe(second);
        const listed = JSON.parse(box.ok(["project", "list", "--json"])) as { hookTimeoutSeconds: unknown }[];
        expect(listed[0]?.hookTimeoutSeconds).toBe("none");

        expect(box.ok(["project", "set", "app", "--hook-timeout", "default"])).not.toContain("hook-timeout=");
        writeFileSync(join(dir, "c.txt"), "c\n");
        expect(box.toli(["commit", "app", "-m", "Add c", "--", "c.txt"]).stderr).toContain("ran past its 1 s limit");
    }, 30_000);

    test("the project's limit applies to the commit-msg hook too, and the error names it", () => {
        const { box, dir } = setup();
        box.ok(["project", "set", "app", "--hook-timeout", "1"]);
        installHook(dir, "commit-msg", "exec sleep 2");
        writeFileSync(join(dir, "a.txt"), "a\n");
        const refused = box.toli(["commit", "app", "-m", "Add a", "--", "a.txt"]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("ran past its 1 s limit (bin/toli project set app --hook-timeout 1)");
        box.ok(["project", "set", "app", "--hook-timeout", "none"]);
        box.ok(["commit", "app", "-m", "Add a", "--", "a.txt"]);
    }, 30_000);

    test("refuses a limit that is not a positive whole number of seconds, none or default", () => {
        const { box } = setup();
        for (const value of ["0", "-5", "1.5", "soon"]) {
            const refused = box.toli(["project", "set", "app", "--hook-timeout", value]);
            expect(refused.code).toBe(1);
            expect(refused.stderr).toContain("--hook-timeout must be");
        }
        const { box: other, dir } = setup();
        setCapacity(other, { commitHookTimeoutSeconds: "later" });
        installHook(dir, "pre-commit", "true");
        writeFileSync(join(dir, "a.txt"), "a\n");
        expect(other.toli(["commit", "app", "-m", "Add a", "--", "a.txt"]).stderr).toContain(
            "capacity.commitHookTimeoutSeconds must be",
        );
    });
});
