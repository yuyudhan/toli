import { describe, expect, test } from "bun:test";
import { cargoConfigPath } from "../src/jawans/env.ts";
import { cargoJobsCheck } from "../src/setup/machine-checks.ts";

describe("cargo jobs mirror (doctor)", () => {
    test("ok when cargo's user config caps build jobs at capacity.cargoJobs", () => {
        const config = '[build]\nrustc-wrapper = "/opt/homebrew/bin/sccache"\njobs = 12\n';
        expect(cargoJobsCheck(config, 12)).toEqual({ level: "ok", name: "cargo-jobs", detail: "[build] jobs = 12" });
    });

    test("warns when the config is missing, has no jobs, or a different number", () => {
        expect(cargoJobsCheck(null, 12)).toMatchObject({ level: "warn", detail: expect.stringContaining("jobs = 12") });
        expect(cargoJobsCheck("[build]\nincremental = false\n", 12)).toMatchObject({
            level: "warn",
            detail: expect.stringContaining("no [build] jobs"),
        });
        expect(cargoJobsCheck("[build]\njobs = 18\n", 12)).toMatchObject({
            level: "warn",
            detail: expect.stringContaining("[build] jobs = 18"),
        });
    });

    test("the config lives under CARGO_HOME when set", () => {
        expect(cargoConfigPath({ CARGO_HOME: "/opt/cargo" })).toBe("/opt/cargo/config.toml");
    });
});
