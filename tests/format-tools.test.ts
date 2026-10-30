import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FORMAT = resolve(import.meta.dir, "..", "scripts", "format.ts");

/** `format.ts tools` with PATH holding only the named package managers (as stubs), so every tool is missing. */
function tools(platform: string, managers: string[]): string {
    const bin = mkdtempSync(join(tmpdir(), "toli-tools-"));
    for (const manager of managers) {
        writeFileSync(join(bin, manager), "#!/bin/sh\nexit 0\n");
        chmodSync(join(bin, manager), 0o755);
    }
    const proc = Bun.spawnSync([process.execPath, FORMAT, "tools"], {
        env: { ...process.env, PATH: bin, TOLI_PLATFORM: platform },
        stdout: "pipe",
        stderr: "pipe",
    });
    expect(proc.exitCode).toBe(1);
    return proc.stdout.toString();
}

describe("format.ts tools: install hints for this machine", () => {
    test("macOS gets brew commands", () => {
        const output = tools("darwin", []);
        expect(output).toContain("[missing] shfmt: brew install shfmt");
        expect(output).toContain("[missing] gitleaks: brew install gitleaks");
    });

    test("Debian/Ubuntu get apt, with release downloads for tools apt does not package", () => {
        const output = tools("linux", ["apt-get"]);
        expect(output).toContain("[missing] shfmt: sudo apt install shfmt");
        expect(output).toContain("[missing] shellcheck: sudo apt install shellcheck");
        expect(output).toContain("[missing] just: sudo apt install just");
        expect(output).toContain(
            "[missing] actionlint: download a release binary from https://github.com/rhysd/actionlint/releases",
        );
    });

    test("Fedora gets dnf with Fedora's package names", () => {
        const output = tools("linux", ["dnf"]);
        expect(output).toContain("[missing] shellcheck: sudo dnf install ShellCheck");
        expect(output).toContain("[missing] just: sudo dnf install just");
    });

    test("a Linux box with no known package manager gets release downloads", () => {
        expect(tools("linux", [])).toContain(
            "[missing] shfmt: download a release binary from https://github.com/mvdan/sh/releases",
        );
    });
});
