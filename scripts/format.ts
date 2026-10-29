// One entry point for every formatter and file-type linter, so `bun run format`, `just fmt`, the pre-commit hook,
// and CI agree on which tool owns which file.
//
//   bun scripts/format.ts write [-- <paths>]   format in place
//   bun scripts/format.ts check [-- <paths>]   report unformatted files (exit 1), change nothing
//   bun scripts/format.ts lint                 check every non-Biome formatter, then shellcheck and actionlint
//                                              (`bun run lint` runs `biome check` itself, formatting included)
//   bun scripts/format.ts tools                list the system tools and how to install the missing ones
//
// Without paths the scope is every tracked or untracked-but-not-ignored file; with paths (the pre-commit hook passes
// the staged files) only those. Ownership:
//   .ts .json .jsonc                     Biome (biome.json)
//   .md .yml .yaml                       Prettier (.prettierrc.json, .prettierignore)
//   .toml                                Taplo (.taplo.toml)
//   *.sh *.bash, sh/bash shebang files   shfmt (options from .editorconfig) + shellcheck
//   Justfile                             just --fmt
//   .github/workflows/*.yml|yaml         actionlint
// A system tool a step needs that is not on PATH fails the run with an install hint; nothing is skipped silently.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { ROOT } from "./guard-lib.ts";

type Mode = "write" | "check" | "lint";
type Step = { name: string; command: string[] };

const SYSTEM_TOOLS = {
    shfmt: "brew install shfmt",
    shellcheck: "brew install shellcheck",
    actionlint: "brew install actionlint",
    just: "brew install just",
    gitleaks: "brew install gitleaks",
} as const;
type SystemTool = keyof typeof SYSTEM_TOOLS;

const out = (line: string) => process.stdout.write(`${line}\n`);

function fail(message: string): never {
    out(`format: ${message}`);
    process.exit(1);
}

function git(args: string[]): string {
    const result = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) fail(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
    return result.stdout.toString();
}

/** Tracked plus untracked-but-not-ignored regular files, relative to the repo root. */
function repoFiles(): string[] {
    const listed = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0");
    return [...new Set(listed)].filter((path) => path !== "" && isRegularFile(path));
}

function isRegularFile(path: string): boolean {
    const full = `${ROOT}${path}`;
    return existsSync(full) && statSync(full).isFile();
}

const SHELL_SHEBANG = /^#!\s*(?:\/usr)?\/bin\/(?:env\s+)?(?:ba)?sh(?:\s|$)/;

function isShell(path: string): boolean {
    const extension = extname(path);
    if (extension === ".sh" || extension === ".bash") return true;
    if (extension !== "") return false;
    const firstLine = readFileSync(`${ROOT}${path}`, "utf8").split("\n", 1)[0] ?? "";
    return SHELL_SHEBANG.test(firstLine);
}

type FileSets = Record<"biome" | "prettier" | "taplo" | "shell" | "justfiles" | "workflows", string[]>;

function classify(files: string[]): FileSets {
    const has =
        (...extensions: string[]) =>
        (path: string) =>
            extensions.includes(extname(path));
    return {
        biome: files.filter(has(".ts", ".json", ".jsonc")),
        prettier: files.filter(has(".md", ".yml", ".yaml")),
        taplo: files.filter(has(".toml")),
        shell: files.filter(isShell),
        justfiles: files.filter((path) => basename(path).toLowerCase() === "justfile" || extname(path) === ".just"),
        workflows: files.filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)),
    };
}

function localBin(name: string): string {
    const path = `${ROOT}node_modules/.bin/${name}`;
    if (!existsSync(path)) fail(`${path} missing; run \`bun install\``);
    return path;
}

function requireSystemTools(plan: Step[]): void {
    const needed = plan.map((step) => step.command[0] ?? "").filter((tool): tool is SystemTool => tool in SYSTEM_TOOLS);
    const missing = [...new Set(needed)].filter((tool) => Bun.which(tool) === null);
    if (missing.length === 0) return;
    for (const tool of missing) out(`format: ${tool} not found on PATH; install it: ${SYSTEM_TOOLS[tool]}`);
    fail(`${missing.length} required tool(s) missing`);
}

function steps(mode: Mode, scoped: boolean, files: FileSets): Step[] {
    const write = mode === "write";
    const list: Step[] = [];
    if (mode !== "lint" && files.biome.length > 0) {
        const target = scoped
            ? ["--no-errors-on-unmatched", "--files-ignore-unknown=true", "--", ...files.biome]
            : ["."];
        list.push({
            name: "biome",
            command: [localBin("biome"), "check", ...(write ? ["--write"] : []), "--linter-enabled=false", ...target],
        });
    }
    if (files.prettier.length > 0) {
        list.push({
            name: "prettier",
            command: [
                localBin("prettier"),
                write ? "--write" : "--check",
                "--log-level",
                "warn",
                "--",
                ...files.prettier,
            ],
        });
    }
    if (files.taplo.length > 0) {
        list.push({
            name: "taplo",
            command: [localBin("taplo"), "fmt", ...(write ? [] : ["--check"]), ...files.taplo],
        });
    }
    if (files.shell.length > 0) {
        list.push({ name: "shfmt", command: ["shfmt", write ? "-w" : "-d", "--", ...files.shell] });
    }
    for (const justfile of files.justfiles) {
        list.push({
            name: `just --fmt ${justfile}`,
            command: ["just", "--unstable", "--fmt", ...(write ? [] : ["--check"]), "--justfile", justfile],
        });
    }
    if (mode === "lint") {
        if (files.shell.length > 0) list.push({ name: "shellcheck", command: ["shellcheck", "--", ...files.shell] });
        if (files.workflows.length > 0) list.push({ name: "actionlint", command: ["actionlint", ...files.workflows] });
    }
    return list;
}

function listTools(): never {
    const missing = (Object.keys(SYSTEM_TOOLS) as SystemTool[]).filter((tool) => Bun.which(tool) === null);
    for (const tool of Object.keys(SYSTEM_TOOLS) as SystemTool[]) {
        out(missing.includes(tool) ? `[missing] ${tool}: ${SYSTEM_TOOLS[tool]}` : `[ok] ${tool}`);
    }
    if (missing.length > 0) fail(`install the missing tool(s): brew install ${missing.join(" ")}`);
    out("format: all system tools present");
    process.exit(0);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "tools") listTools();
if (mode !== "write" && mode !== "check" && mode !== "lint")
    fail("usage: format.ts <write|check|lint|tools> [-- <paths>]");
const paths = rest[0] === "--" ? rest.slice(1) : rest;
if (mode === "lint" && paths.length > 0) fail("lint mode always covers the whole repo; drop the paths");
const scoped = paths.length > 0;
const files = classify(scoped ? paths.filter(isRegularFile) : repoFiles());
const plan = steps(mode, scoped, files);
requireSystemTools(plan);

const failed: string[] = [];
for (const { name, command } of plan) {
    out(`format: ${name}`);
    const result = Bun.spawnSync(command, {
        cwd: ROOT,
        stdout: "inherit",
        stderr: "inherit",
        env: { ...process.env, RUST_LOG: "warn" },
    });
    if (result.exitCode !== 0) failed.push(name);
}
if (failed.length > 0) fail(`${failed.length} of ${plan.length} step(s) failed: ${failed.join(", ")}`);
out(`format: ${mode} OK (${plan.length} step(s))`);
