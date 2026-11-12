import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { git, isGitRepo } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { isJsonObject, readJson, run, shellQuote, ToliError, warn } from "../core/util.ts";
import type { Check } from "../setup/doctor.ts";

/**
 * The repo's own git hooks (docs/projects.md#git-hooks): what a clone declares through a hook manager or a tracked hooks
 * directory, whether git would actually run each declared hook, and installing them where toli can tell how. Detection
 * is generic: it reads only the repo's tracked conventions (husky, a `core.hooksPath` directory a recipe or doc names,
 * pre-commit, lefthook), never a project-specific table.
 */

/** Every client- and server-side hook name git runs (githooks(5)). */
const GIT_HOOKS: ReadonlySet<string> = new Set([
    "applypatch-msg",
    "pre-applypatch",
    "post-applypatch",
    "pre-commit",
    "pre-merge-commit",
    "prepare-commit-msg",
    "commit-msg",
    "post-commit",
    "pre-rebase",
    "post-checkout",
    "post-merge",
    "pre-push",
    "pre-receive",
    "update",
    "proc-receive",
    "post-receive",
    "post-update",
    "reference-transaction",
    "push-to-checkout",
    "pre-auto-gc",
    "post-rewrite",
    "sendemail-validate",
    "fsmonitor-watchman",
    "post-index-change",
]);

/** How toli installs a declaration itself: point core.hooksPath at a directory, or run the repo's own installer. */
type Installer = { hooksPath: string } | { command: string[] };

type Declaration = {
    /** The hook manager or convention: `husky`, `hooks-dir`, `pre-commit`, `lefthook`. */
    tool: string;
    /** The tracked file or directory that declares the hooks, relative to the checkout root. */
    source: string;
    /** Git hook names it declares, sorted. */
    hooks: string[];
    /** The shell command that installs them, run from the checkout root. */
    fix: string;
    /** Set when toli can install them itself (`installHooks`); otherwise the fix is only reported. */
    installer: Installer | null;
};

/** One declaration and which of its hooks git would not run now. */
export type HookCheck = Omit<Declaration, "installer"> & { missing: string[]; installable: boolean };

/** The executable hook git runs for `name` in `dir` (core.hooksPath honoured, as git resolves it), else null. */
export function activeHookPath(dir: string, name: string): string | null {
    const hook = git(dir, ["rev-parse", "--path-format=absolute", "--git-path", `hooks/${name}`]);
    if (hook.code !== 0) return null;
    const path = hook.stdout.trim();
    try {
        if (!statSync(path).isFile()) return null;
        accessSync(path, constants.X_OK);
        return path;
    } catch {
        return null;
    }
}

function isDir(path: string): boolean {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

function readText(path: string): string {
    try {
        return statSync(path).isFile() ? readFileSync(path, "utf8") : "";
    } catch {
        return "";
    }
}

function isExecutable(path: string): boolean {
    try {
        accessSync(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** Hook-named regular files directly in `dir`. */
function hookFiles(dir: string): string[] {
    if (!isDir(dir)) return [];
    return readdirSync(dir)
        .filter((name) => GIT_HOOKS.has(name) && statSync(join(dir, name), { throwIfNoEntry: false })?.isFile())
        .sort();
}

/** `./a/b/` -> `a/b`. */
function normalizePath(path: string): string {
    return path.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
}

/** The package manager the lockfile names, for the install hint. */
function packageManager(dir: string): string {
    if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun";
    if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(join(dir, "yarn.lock"))) return "yarn";
    return "npm";
}

function packageScripts(dir: string): Record<string, string> {
    const manifest = readJson<unknown>(join(dir, "package.json"), {});
    const scripts = isJsonObject(manifest) ? manifest.scripts : undefined;
    if (!isJsonObject(scripts)) return {};
    return Object.fromEntries(
        Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
}

/**
 * The husky arguments the repo's `prepare` (or `postinstall`) script runs, e.g. `[]` for husky 9's bare `husky` or
 * `["install"]` for husky 8; null when no script runs husky. Package-runner prefixes (`npx`, `bunx`, ...) are dropped.
 */
function scriptedHuskyArgs(dir: string): string[] | null {
    const scripts = packageScripts(dir);
    for (const script of [scripts.prepare, scripts.postinstall]) {
        if (script === undefined) continue;
        for (const segment of script.split(/&&|\|\||;/)) {
            const words = segment.trim().split(/\s+/);
            const at = words.indexOf("husky");
            if (at >= 0 && words.slice(0, at).every((word) => /^(npx|bunx|pnpm|yarn|exec|dlx)$/.test(word)))
                return words.slice(at + 1);
        }
    }
    return null;
}

/** husky's own installed major version from node_modules, or null. */
function huskyMajor(dir: string): number | null {
    const manifest = readJson<unknown>(join(dir, "node_modules", "husky", "package.json"), {});
    const version = isJsonObject(manifest) ? manifest.version : undefined;
    const major = typeof version === "string" ? Number.parseInt(version, 10) : Number.NaN;
    return Number.isInteger(major) ? major : null;
}

/**
 * husky: hook files in `.husky/`. Installed through what is already there: husky 9's generated `.husky/_/` (core.hooksPath
 * `.husky/_`), husky 8's `.husky/_/husky.sh` (core.hooksPath `.husky`), else the repo's own husky binary run as its
 * prepare script does, else (self-contained executable hook files) core.hooksPath `.husky`. Without any of those the
 * fix is the repo's dependency install, which runs husky through its prepare script.
 */
function huskyDeclaration(dir: string): Declaration | null {
    const root = join(dir, ".husky");
    const hooks = hookFiles(root);
    if (hooks.length === 0) return null;
    const base = { tool: "husky", source: ".husky", hooks };
    const pointAt = (hooksPath: string): Declaration => ({
        ...base,
        fix: `git config core.hooksPath ${hooksPath}`,
        installer: { hooksPath },
    });
    if (existsSync(join(root, "_", "h"))) return pointAt(".husky/_");
    if (existsSync(join(root, "_", "husky.sh"))) return pointAt(".husky");
    const scripted = scriptedHuskyArgs(dir);
    const binary = join(dir, "node_modules", ".bin", "husky");
    if (isExecutable(binary)) {
        const args = scripted ?? ((huskyMajor(dir) ?? 9) >= 9 ? [] : ["install"]);
        return {
            ...base,
            fix: ["node_modules/.bin/husky", ...args].map(shellQuote).join(" "),
            installer: { command: [binary, ...args] },
        };
    }
    const selfContained = hooks.every(
        (name) => isExecutable(join(root, name)) && !readText(join(root, name)).includes("husky.sh"),
    );
    if (selfContained) return pointAt(".husky");
    const manager = packageManager(dir);
    return {
        ...base,
        fix: scripted === null ? `${manager} install && npx husky` : `${manager} install`,
        installer: null,
    };
}

/** Recipe and doc files that may say how the repo's hooks directory is installed. */
function instructionFiles(dir: string): string[] {
    const fixed = [
        "justfile",
        "Justfile",
        ".justfile",
        "Makefile",
        "makefile",
        "GNUmakefile",
        "package.json",
        "README.md",
        "README",
        "CONTRIBUTING.md",
        "AGENTS.md",
        "CLAUDE.md",
    ].map((name) => join(dir, name));
    const docs = join(dir, "docs");
    const docFiles = isDir(docs)
        ? readdirSync(docs)
              .filter((name) => name.endsWith(".md"))
              .map((name) => join(docs, name))
        : [];
    return [...fixed, ...docFiles];
}

const HOOKS_PATH_SETTING = /core\.hooksPath\s*=?\s*["']?([^\s"'`;&|)]+)/g;

/** Repo-relative directories a recipe or doc sets core.hooksPath to (husky's own excluded). */
function documentedHooksPaths(dir: string): Set<string> {
    const named = new Set<string>();
    for (const file of instructionFiles(dir))
        for (const match of readText(file).matchAll(HOOKS_PATH_SETTING)) {
            const path = normalizePath(match[1] ?? "");
            if (path === "" || path.startsWith("/") || path.includes("$") || path.split("/").includes("..")) continue;
            if (path === ".husky" || path.startsWith(".husky/")) continue;
            named.add(path);
        }
    return named;
}

/**
 * Tracked hooks directories: every directory a justfile/Makefile/package.json recipe or doc sets core.hooksPath to,
 * plus a conventional `.githooks/`. toli sets core.hooksPath itself only for a directory the repo names that way; a
 * bare `.githooks/` is reported with the command.
 */
function hooksDirDeclarations(dir: string): Declaration[] {
    const documented = documentedHooksPaths(dir);
    const candidates = new Set([...documented, ".githooks"]);
    const declarations: Declaration[] = [];
    for (const path of [...candidates].sort()) {
        const hooks = hookFiles(join(dir, path));
        if (hooks.length === 0) continue;
        declarations.push({
            tool: "hooks-dir",
            source: path,
            hooks,
            fix: `git config core.hooksPath ${shellQuote(path)}`,
            installer: documented.has(path) ? { hooksPath: path } : null,
        });
    }
    return declarations;
}

/** Hook names a YAML block list or inline list under `key:` holds. */
function yamlList(text: string, key: string): string[] {
    const inline = new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, "m").exec(text);
    if (inline) return (inline[1] ?? "").split(",").map((item) => item.trim().replace(/^["']|["']$/g, ""));
    const block = new RegExp(`^${key}:\\s*\\n((?:[ \\t]*-[^\\n]*\\n?)+)`, "m").exec(text);
    if (!block) return [];
    return (block[1] ?? "")
        .split("\n")
        .map((line) =>
            line
                .replace(/^[ \t]*-\s*/, "")
                .trim()
                .replace(/^["']|["']$/g, ""),
        )
        .filter((item) => item !== "");
}

/** pre-commit: `.pre-commit-config.yaml`, installing `default_install_hook_types` (pre-commit when unset). */
function preCommitDeclaration(dir: string): Declaration | null {
    const source = ".pre-commit-config.yaml";
    const path = join(dir, source);
    if (!existsSync(path)) return null;
    const types = yamlList(readText(path), "default_install_hook_types").filter((name) => GIT_HOOKS.has(name));
    return {
        tool: "pre-commit",
        source,
        hooks: types.length === 0 ? ["pre-commit"] : [...new Set(types)].sort(),
        fix: "pre-commit install",
        installer: null,
    };
}

const LEFTHOOK_FILES = [
    "lefthook.yml",
    "lefthook.yaml",
    ".lefthook.yml",
    ".lefthook.yaml",
    "lefthook.toml",
    ".lefthook.toml",
    "lefthook.json",
    ".lefthook.json",
];

/** lefthook: its config's top-level hook sections (`pre-push:`, `[pre-push]`, `"pre-push": {`). */
function lefthookDeclaration(dir: string): Declaration | null {
    const source = LEFTHOOK_FILES.find((name) => existsSync(join(dir, name)));
    if (source === undefined) return null;
    const text = readText(join(dir, source));
    const section = /^(?:([a-z-]+):|\[([a-z-]+)\]|\s*"([a-z-]+)"\s*:)/gm;
    const hooks = new Set<string>();
    for (const match of text.matchAll(section)) {
        const name = match[1] ?? match[2] ?? match[3] ?? "";
        if (GIT_HOOKS.has(name)) hooks.add(name);
    }
    if (hooks.size === 0) return null;
    return { tool: "lefthook", source, hooks: [...hooks].sort(), fix: "lefthook install", installer: null };
}

function declarations(dir: string): Declaration[] {
    return [
        huskyDeclaration(dir),
        ...hooksDirDeclarations(dir),
        preCommitDeclaration(dir),
        lefthookDeclaration(dir),
    ].filter((declaration): declaration is Declaration => declaration !== null);
}

/** What the clone in `dir` declares and which declared hooks git would not run; empty when it declares none. */
export function hookChecks(dir: string): HookCheck[] {
    return declarations(dir).map(({ installer, ...declaration }) => ({
        ...declaration,
        missing: declaration.hooks.filter((name) => activeHookPath(dir, name) === null),
        installable: installer !== null,
    }));
}

/** `husky (.husky)`. */
export function hookLabel(check: Pick<HookCheck, "tool" | "source">): string {
    return check.tool === "hooks-dir" ? check.source : `${check.tool} (${check.source})`;
}

/** One line per declaration: active, or what is missing and how to install it (`setup`: toli's own command). */
export function hookCheckLine(check: HookCheck, setup: string): string {
    if (check.missing.length === 0) return `${hookLabel(check)}: ${check.hooks.join(", ")} active`;
    const how = check.installable ? `run ${setup}` : `run \`${check.fix}\` in the clone`;
    return `${hookLabel(check)} declares ${check.missing.join(", ")}, not installed: ${how}`;
}

/** Run one installer; returns null on success, else why it did not install. */
function install(dir: string, installer: Installer): string | null {
    if ("hooksPath" in installer) {
        const set = git(dir, ["config", "--get", "core.hooksPath"]);
        const current = set.code === 0 ? set.stdout.trim() : null;
        if (current !== null && normalizePath(current) !== installer.hooksPath)
            return `core.hooksPath is already ${current}; left as it is`;
        const result = git(dir, ["config", "core.hooksPath", installer.hooksPath]);
        return result.code === 0 ? null : (result.stderr || result.stdout).trim();
    }
    const result = run(installer.command, { cwd: dir, timeoutMs: 120_000 });
    return result.code === 0 ? null : `${installer.command.join(" ")} exited ${result.code}: ${result.stderr.trim()}`;
}

/**
 * Install every declaration with missing hooks that toli can install itself; returns one `hooks: ...` line per
 * attempt. Never overrides a core.hooksPath already set to something else.
 */
export function installHooks(dir: string): string[] {
    const lines: string[] = [];
    for (const declaration of declarations(dir)) {
        if (declaration.installer === null) continue;
        if (declaration.hooks.every((name) => activeHookPath(dir, name) !== null)) continue;
        const failure = install(dir, declaration.installer);
        lines.push(
            failure === null
                ? `hooks: ${hookLabel(declaration)}: installed (${declaration.fix})`
                : `hooks: ${hookLabel(declaration)}: not installed: ${failure}`,
        );
    }
    return lines;
}

/**
 * `project add` / `project ensure`: install what toli can, then one `hooks: ...` state line per declaration (`setup`:
 * the toli command that installs the rest). Nothing when the clone declares no hooks.
 */
export function ensureHooks(dir: string, setup: string): string[] {
    return [...installHooks(dir), ...hookChecks(dir).map((check) => `hooks: ${hookCheckLine(check, setup)}`)];
}

/**
 * `bin/toli push`: the delivery promise is "push through the project's own hooks", so refuse when the repo declares a
 * pre-push hook git would not run (unless `noHooksOk`), and warn about any other declared hook that is not installed.
 */
export function requirePushHooks(project: string, dir: string, noHooksOk: boolean): void {
    const setup = `bin/toli project setup ${project}`;
    for (const check of hookChecks(dir)) {
        if (check.missing.length === 0) continue;
        const line = hookCheckLine(check, setup);
        if (check.missing.includes("pre-push") && !noHooksOk)
            throw new ToliError(
                `refusing to push ${project}: ${line}; the project's pre-push check would not run. Install it, or pass --no-hooks-ok to push without it`,
            );
        warn(`toli: ${line}`);
    }
}

/**
 * `bin/toli doctor`: one warning per declaration in a registered clone whose hooks git would not run, else one ok line;
 * nothing when no clone declares any.
 */
export function hooksDoctorChecks(projects: string[]): Check[] {
    const warnings: Check[] = [];
    let declaring = 0;
    for (const name of projects) {
        const dir = paths.projectDir(name);
        if (!isGitRepo(dir)) continue;
        const checks = hookChecks(dir);
        if (checks.length > 0) declaring += 1;
        for (const check of checks)
            if (check.missing.length > 0)
                warnings.push({
                    level: "warn",
                    name: "hooks",
                    detail: `${name}: ${hookCheckLine(check, `bin/toli project setup ${name}`)}`,
                });
    }
    if (warnings.length > 0 || declaring === 0) return warnings;
    const detail = `declared git hooks active in ${declaring} clone${declaring === 1 ? "" : "s"}`;
    return [{ level: "ok", name: "hooks", detail }];
}
