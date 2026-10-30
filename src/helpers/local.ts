import { accessSync, constants, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../core/paths.ts";
import { run, warn } from "../core/util.ts";

const LOCAL_README = `# local/ — this machine's private helpers

Everything in this directory is gitignored: it never reaches the toli repo or its forks.

- scripts/        helper programs (any language) that the lead's workers write on request
- helpers.json    the registry: each helper's exec, args and schedule
- hooks/          optional executables toli runs itself: post-init, pre-tick, post-tick

Install a registered helper with \`bin/toli helper install <name>\` and check it with
\`bin/toli helper status\`. The format and commands are in docs/helpers.md.
`;

/** Create local/ with its README and an empty helpers.json; never overwrites anything already there. */
export function seedLocal(): void {
    mkdirSync(paths.localScriptsDir(), { recursive: true });
    mkdirSync(paths.localHooksDir(), { recursive: true });
    const readme = join(paths.localDir(), "README.md");
    if (!existsSync(readme)) writeFileSync(readme, LOCAL_README);
    if (!existsSync(paths.helpersConfig())) writeFileSync(paths.helpersConfig(), '{\n    "helpers": []\n}\n');
}

export type HookName = "post-init" | "pre-tick" | "post-tick";

const HOOK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Run local/hooks/<name> when it exists and is executable, with the toli root as $1 and as cwd. A hook is
 * optional: absence is silent, and a non-executable file, a failure or a timeout is reported on stderr but never
 * fails the command that ran it. Hook output goes to stderr so it cannot corrupt a command's stdout.
 */
export function runHook(name: HookName): void {
    const file = join(paths.localHooksDir(), name);
    try {
        if (!existsSync(file) || !statSync(file).isFile()) return;
        try {
            accessSync(file, constants.X_OK);
        } catch {
            warn(`toli: local/hooks/${name} is not executable; skipped (chmod +x to enable it)`);
            return;
        }
        const result = run([file, paths.root()], { cwd: paths.root(), timeoutMs: HOOK_TIMEOUT_MS });
        const output = `${result.stdout}${result.stderr}`.trimEnd();
        if (output !== "") warn(output);
        if (result.code !== 0) warn(`toli: local/hooks/${name} exited ${result.code}; continuing`);
    } catch (error) {
        warn(`toli: local/hooks/${name} failed: ${error instanceof Error ? error.message : String(error)}; continuing`);
    }
}
