import { describe, expect, test } from "bun:test";
import { CliHealth } from "../src/harness/cli-health.ts";

const BROKEN = new Error(
    "bin/toli job due --json: 1 | import { perTask } from './projects.ts';\n" +
        "SyntaxError: Export named 'perTask' not found in module '/toli/src/projects.ts'.\n" +
        "      at loadAndEvaluateModule (2:1)",
);

describe("CliHealth: the extension tick reports a broken CLI once per distinct error", () => {
    test("the first failure yields a notice that names the error and points to bin/toli doctor", () => {
        const notice = new CliHealth().failed(BROKEN);
        expect(notice).toContain("toli CLI is failing: SyntaxError: Export named 'perTask' not found");
        expect(notice).toContain("Run bin/toli doctor");
        expect(notice).not.toContain("loadAndEvaluateModule");
    });

    test("the same error every minute is reported once", () => {
        const health = new CliHealth();
        const notices = Array.from({ length: 5 }, () => health.failed(BROKEN));
        expect(notices.filter((notice) => notice !== null)).toHaveLength(1);
        expect(health.failed(new Error(BROKEN.message.replace("(2:1)", "(9:9)")))).toBeNull();
    });

    test("a different error is reported again", () => {
        const health = new CliHealth();
        expect(health.failed(BROKEN)).not.toBeNull();
        const other = health.failed(new Error("bin/toli wake --json: toli: config/machine.json missing"));
        expect(other).toContain("toli: config/machine.json missing");
        expect(health.failed("timed out")).toContain("toli CLI is failing: timed out");
    });

    test("recovery is silent and a later breakage is reported anew", () => {
        const health = new CliHealth();
        expect(health.failed(BROKEN)).not.toBeNull();
        health.succeeded();
        health.succeeded();
        expect(health.failed(BROKEN)).not.toBeNull();
        expect(health.failed(BROKEN)).toBeNull();
    });

    test("an empty error still yields a notice", () => {
        expect(new CliHealth().failed(new Error(""))).toContain("toli CLI is failing: unknown error");
    });
});
