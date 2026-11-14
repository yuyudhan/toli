// `bin/toli push --gate "<recipe>"` and the repo's own pre-push hook: one gate run per push (T1418). A hook that runs
// exactly the gate's recipe and nothing else would repeat a run that just passed, so the push skips it, but only when
// the gate's sealed pass (src/forge/gate-record.ts) is for the tree of exactly the commit being pushed, the checkout is
// exactly that commit, and the hook's one command is the recipe's text. Anything else keeps the hook: another command,
// a hook doing more (a secret scan, a second check), a hook in another language, a moved HEAD, a dirty checkout.
import { readFileSync } from "node:fs";
import { headSha, treeSha } from "../core/git.ts";
import { out } from "../core/util.ts";
import { activeHookPath } from "../projects/hooks.ts";
import { changesText, checkoutChanges, type GateRun, gateForPush } from "./gate.ts";
import { logDecision, provenPass, readRecord, recordFile, short } from "./gate-record.ts";

/** A shebang git's own `sh` reading would match: a POSIX-family shell, directly or through env. */
const SHELL_SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+)?(?:\/\S*\/)?(?:sh|bash|dash|zsh|ksh)(?:\s|$)/;
/** `set -e`, `set -euo pipefail`, `set -o errexit`: shell options that change no command the hook runs. */
const SET_OPTIONS = /^set(?:\s+(?:[-+][a-zA-Z]*o\s+[a-z]+|[-+][a-zA-Z]+))+$/;

/**
 * The one command a plain shell hook runs (an `exec` prefix dropped), or null when it runs none, several, or is not a
 * shell script. Comments, blank lines and `set` options are not commands.
 */
export function hookCommand(script: string): string | null {
    const lines = script.split("\n");
    if (lines[0]?.startsWith("#!")) {
        if (!SHELL_SHEBANG.test(lines[0])) return null;
        lines.shift();
    }
    const commands = lines.map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
    const run = commands.filter((line) => !SET_OPTIONS.test(line));
    if (run.length !== 1) return null;
    return (run[0] as string).replace(/^exec\s+/, "");
}

export type HookDecision = { skip: true; message: string } | { skip: false; reason: string };

/**
 * Whether `git push` may skip the active pre-push hook of `dir` because the gate `recipe` of `project` already passed
 * on commit `sha`: the hook runs only that recipe, HEAD is still `sha`, the checkout is exactly HEAD, and a sealed
 * pass exists for HEAD's tree. The reason names the first condition that failed.
 */
export function pushHookDecision(input: { project: string; dir: string; recipe: string; sha: string }): HookDecision {
    const { project, dir, recipe, sha } = input;
    const hook = activeHookPath(dir, "pre-push");
    if (hook === null) return { skip: false, reason: "no pre-push hook is active" };
    const command = hookCommand(readFileSync(hook, "utf8"));
    if (command !== recipe.trim())
        return {
            skip: false,
            reason:
                command === null
                    ? `${hook} does more than one command, so it is not only the gate ${recipe}`
                    : `${hook} runs ${command}, not the gate ${recipe}`,
        };
    const head = headSha(dir);
    if (head !== sha) return { skip: false, reason: `HEAD is now ${short(head)}, not the gated ${short(sha)}` };
    const changes = checkoutChanges(dir);
    if (changes !== null) return { skip: false, reason: `the checkout differs from HEAD (${changesText(changes)})` };
    const tree = treeSha(dir);
    const record = readRecord(recordFile(project, tree, recipe));
    if (record === null || !provenPass(record, project, tree, recipe))
        return { skip: false, reason: `no sealed pass of ${recipe} on tree ${short(tree)}` };
    return {
        skip: true,
        message:
            `skipping the pre-push hook ${hook}: it runs only ${recipe}, which passed on ${short(sha)} (tree ` +
            `${short(tree)}, proof ${short(record.proof ?? "")}); pushing exactly that commit with --no-verify`,
    };
}

/**
 * `push --gate`: run the gate until it passed on HEAD's tree (gateForPush), then return what the push needs. `env`
 * (TOLI_GATE_PROJECT, _SHA, _TREE, _RECIPE) tells the push's hooks which gate passed; a hook must still ask
 * `bin/toli gate check`, since anyone can set the variables. `skipHookAt` is the gated commit when the active pre-push
 * hook would only repeat the gate there (pushHookDecision): the push must then push exactly that sha with
 * `--no-verify`. Either way the decision is printed, and a skip is logged as `hook-skip` in logs/gates.log.
 */
export async function gatePush(
    input: GateRun,
    waitMinutes: number,
): Promise<{ env: Record<string, string>; skipHookAt: string | null }> {
    const { project, dir, recipe } = input;
    const gate = await gateForPush(input, waitMinutes);
    const sha = headSha(dir);
    const env = { TOLI_GATE_PROJECT: project, TOLI_GATE_SHA: sha, TOLI_GATE_TREE: gate.tree, TOLI_GATE_RECIPE: recipe };
    if (activeHookPath(dir, "pre-push") === null) return { env, skipHookAt: null };
    const decision = pushHookDecision({ project, dir, recipe, sha });
    if (!decision.skip) {
        out(`push: running the pre-push hook: ${decision.reason}`);
        return { env, skipHookAt: null };
    }
    logDecision({ project, sha }, "hook-skip", decision.message);
    out(`push: ${decision.message}`);
    return { env, skipHookAt: sha };
}
