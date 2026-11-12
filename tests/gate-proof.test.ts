import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { commitFile, type GateRecord, gatesLog, recipe, records, runs, setup } from "./gate-fixture.ts";
import { TOLI_BIN } from "./helpers.ts";

setDefaultTimeout(60_000);

describe("gate proofs", () => {
    test("a commit with the same tree reuses the pass: no re-run, and the skip and the proof are logged", () => {
        const { box, dir } = setup();
        const verify = recipe(box, "verify", "echo ok");
        box.ok(["gate", "run", "app", "--recipe", verify]);
        const first = box.git(dir, ["rev-parse", "HEAD"]);
        box.git(dir, ["commit", "--allow-empty", "-m", "same files, new commit"]);
        expect(box.git(dir, ["rev-parse", "HEAD"])).not.toBe(first);
        const again = box.ok(["gate", "run", "app", "--recipe", verify]);
        expect(again).toContain(`already passed at ${first.slice(0, 12)} on tree`);
        expect(again).toContain("skipping the re-run");
        expect(runs(box)).toBe(1);
        expect(records(box)).toHaveLength(1);
        expect(box.toli(["gate", "check", "app", "--recipe", verify]).code).toBe(0);
        expect(gatesLog(box)).toMatch(/ app [0-9a-f]{12} skip: .*on tree [0-9a-f]{12} .*proof [0-9a-f]{12}/);
        expect(gatesLog(box)).toMatch(/ app [0-9a-f]{12} proof: .*on tree [0-9a-f]{12} .*needs no re-run/);
    });

    test("a pass does not cover another tree, another recipe, or a checkout that differs from the commit", () => {
        const { box, dir } = setup();
        const verify = recipe(box, "verify", "echo ok");
        box.ok(["gate", "run", "app", "--recipe", verify]);
        expect(box.toli(["gate", "check", "app", "--recipe", "just other"]).code).toBe(1);
        const passed = commitFile(box, dir, "a.txt");
        const changed = box.toli(["gate", "check", "app", "--recipe", verify]);
        expect(changed.code).toBe(1);
        expect(changed.stderr).toContain("has not passed on tree");
        box.ok(["gate", "run", "app", "--recipe", verify]);
        expect(runs(box)).toBe(2);
        expect(box.toli(["gate", "check", "app", "--recipe", verify]).code).toBe(0);
        writeFileSync(join(dir, "README"), "edited after the gate\n");
        const dirty = box.toli(["gate", "check", "app", "--recipe", verify]);
        expect(dirty.code).toBe(1);
        expect(dirty.stderr).toContain("differs from its HEAD commit (README)");
        // An explicit commit names exactly that commit's tree, whatever the checkout holds.
        expect(box.toli(["gate", "check", "app", "--sha", passed, "--recipe", verify]).code).toBe(0);
    });

    test("a forged proof is refused: an edited, copied or invented record never skips the gate", () => {
        const { box, dir } = setup();
        const failing = recipe(box, "broken", "exit 1");
        box.toli(["gate", "run", "app", "--recipe", failing]);
        const gates = join(box.root, "state", "gates", "app");
        const failedFile = join(gates, readdirSync(gates).find((name) => name.endsWith(".json")) ?? "");
        const failed = JSON.parse(readFileSync(failedFile, "utf8")) as GateRecord;
        // Edited by hand to say passed, with and without a made-up proof.
        writeFileSync(failedFile, JSON.stringify({ ...failed, status: "passed" }));
        const edited = box.toli(["gate", "check", "app", "--recipe", failing]);
        expect(edited.code).toBe(1);
        expect(edited.stderr).toContain("no valid proof");
        writeFileSync(failedFile, JSON.stringify({ ...failed, status: "passed", proof: "0".repeat(64) }));
        expect(box.toli(["gate", "check", "app", "--recipe", failing]).code).toBe(1);
        // The variables a push hands its hooks decide nothing; only the recorded proof does.
        const env = { TOLI_GATE_SHA: failed.sha, TOLI_GATE_TREE: failed.tree, TOLI_GATE_RECIPE: failing };
        expect(box.toli(["gate", "check", "app", "--recipe", failing], { env }).code).toBe(1);
        const rerun = box.toli(["gate", "run", "app", "--recipe", failing]);
        expect(rerun.code).toBe(1);
        expect(runs(box)).toBe(2);
        expect(gatesLog(box)).toMatch(/ app [0-9a-f]{12} forged: /);
        // A real pass copied onto another tree's record file.
        const verify = recipe(box, "verify", "echo ok");
        box.ok(["gate", "run", "app", "--recipe", verify]);
        const real = readdirSync(gates).find((name) => name.endsWith(".json") && name !== basename(failedFile));
        expect(real).toBeDefined();
        commitFile(box, dir, "a.txt");
        const treeB = box.git(dir, ["rev-parse", "HEAD^{tree}"]);
        const copy = join(gates, (real ?? "").replace(/^[0-9a-f]+/, treeB));
        writeFileSync(copy, readFileSync(join(gates, real ?? ""), "utf8"));
        expect(box.toli(["gate", "check", "app", "--recipe", verify]).code).toBe(1);
        const before = runs(box);
        box.ok(["gate", "run", "app", "--recipe", verify]);
        expect(runs(box)).toBe(before + 1);
    });

    test("a pre-push hook run by push skips its own run only for a tree the gate passed on", () => {
        const { box, dir } = setup();
        box.ok(["project", "set", "app", "--standing-push", "yes"]);
        box.git(dir, ["switch", "-c", "feature"]);
        const verify = recipe(box, "verify", "echo ok");
        const seen = join(box.root, "hook-log");
        const toli = `"${process.execPath}" "${TOLI_BIN}"`;
        writeFileSync(
            join(dir, ".git", "hooks", "pre-push"),
            [
                "#!/bin/sh",
                "while read -r _ sha _ _; do",
                `  if ${toli} gate check app --recipe '${verify}' --sha "$sha" >/dev/null 2>&1; then`,
                `    echo skipped >> ${seen}`,
                "  else",
                `    echo ran >> ${seen}`,
                "  fi",
                "done",
                "",
            ].join("\n"),
            { mode: 0o755 },
        );
        commitFile(box, dir, "a.txt");
        box.ok(["push", "app", "--gate", verify]);
        // A new commit, the same files: the gate's pass still holds.
        box.git(dir, ["commit", "--allow-empty", "-m", "same files"]);
        box.ok(["push", "app"]);
        // New files: no pass, so the hook runs its check in full.
        commitFile(box, dir, "b.txt");
        box.ok(["push", "app"]);
        expect(readFileSync(seen, "utf8").trim().split("\n")).toEqual(["skipped", "skipped", "ran"]);
        expect(runs(box)).toBe(1);
    });

    test("an unsafe gate key or a malformed proof proves nothing", () => {
        const { box } = setup();
        const verify = recipe(box, "verify", "echo ok");
        box.ok(["gate", "run", "app", "--recipe", verify]);
        const key = join(box.root, "state", "gate-key");
        expect(statSync(key).mode & 0o777).toBe(0o600);
        expect(readFileSync(key, "utf8")).toMatch(/^[0-9a-f]{64}$/);
        expect(box.toli(["gate", "check", "app", "--recipe", verify]).code).toBe(0);
        // Readable by others: anyone could have sealed a pass with it.
        chmodSync(key, 0o644);
        const loose = box.toli(["gate", "check", "app", "--recipe", verify]);
        expect(loose.code).toBe(1);
        expect(loose.stderr).toContain("mode 0600");
        chmodSync(key, 0o600);
        // A symlink to a key elsewhere is refused even when its target is owner-only.
        const elsewhere = join(box.root, "other-key");
        writeFileSync(elsewhere, readFileSync(key, "utf8"), { mode: 0o600 });
        rmSync(key);
        symlinkSync(elsewhere, key);
        const linked = box.toli(["gate", "check", "app", "--recipe", verify]);
        expect(linked.code).toBe(1);
        expect(linked.stderr).toContain("a symlink");
        rmSync(key);
        writeFileSync(key, readFileSync(elsewhere, "utf8"), { mode: 0o600 });
        expect(box.toli(["gate", "check", "app", "--recipe", verify]).code).toBe(0);
        // The real proof with junk after it is not that proof.
        const [record] = records(box);
        expect(record?.proof).toMatch(/^[0-9a-f]{64}$/);
        const gates = join(box.root, "state", "gates", "app");
        const file = join(gates, readdirSync(gates).find((name) => name.endsWith(".json")) ?? "");
        writeFileSync(file, JSON.stringify({ ...record, proof: `${record?.proof}zz` }));
        expect(box.toli(["gate", "check", "app", "--recipe", verify]).code).toBe(1);
    });
});
