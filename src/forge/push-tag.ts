// `bin/toli push <project> --tag <name>`: push one tag, and nothing else, to origin (T2288). A release tag usually lands
// on a commit whose tree the gate already passed (the gated release commit, or the merge of exactly it), yet a plain
// `git push origin refs/tags/<tag>` reruns the project's whole pre-push check on it: hours, for a tree that has a sealed
// pass. When the hook declares the gate recipes that are all it checks on a tag push and each passed on the tagged
// tree (tagPushHookDecision), the push skips the hook with --no-verify, says why and logs it; otherwise the hook runs
// exactly as on a branch push.
import { git, resolveSha } from "../core/git.ts";
import { out, runInherit, ToliError, warn } from "../core/util.ts";
import { runCheckInSlot } from "../fleet/check-slot.ts";
import { activeHookPath, lightPushCondition } from "../projects/hooks.ts";
import { appendPush, type PushAttribution, pushLine } from "../records/push-log.ts";
import { slotFreePushSha, tagPushHookDecision } from "./gate-hook.ts";
import { logDecision, short } from "./gate-record.ts";

const OBJECT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** The object `ref` names in `dir` (an annotated tag's own object, not its commit), or null when there is none. */
function refObject(dir: string, ref: string): string | null {
    const result = git(dir, ["rev-parse", "--verify", "--quiet", ref]);
    const sha = result.stdout.trim();
    return result.code === 0 && OBJECT_SHA.test(sha) ? sha : null;
}

/** What origin's `ref` names now, or null when origin has no such ref. */
function remoteObject(dir: string, ref: string): string | null {
    const listed = git(dir, ["ls-remote", "origin", ref]);
    if (listed.code !== 0)
        throw new ToliError(`git ls-remote origin failed: ${(listed.stderr || listed.stdout).trim()}`);
    return listed.stdout.trim().split(/\s+/)[0] || null;
}

/**
 * Push the local tag `name` of `project`'s checkout `dir` to origin's `refs/tags/<name>`: exactly the object it names
 * now, never `--tags`, never forced. A tag origin already holds is left alone, and one origin holds at another object
 * is refused, since a pushed tag is never moved. The pre-push hook is skipped only on tagPushHookDecision's proof
 * (logged `hook-skip` in logs/gates.log); otherwise it runs as a branch push runs it: without a heavy-build slot when
 * it declares itself light, else in one. The push is recorded in the push log under `refs/tags/<name>`.
 */
export async function pushTag(project: string, dir: string, name: string, attribution: PushAttribution): Promise<void> {
    const ref = `refs/tags/${name}`;
    const object = refObject(dir, ref);
    if (object === null) throw new ToliError(`refusing to push ${project}: ${dir} has no tag ${name}`);
    const commit = resolveSha(dir, object);
    if (commit === null) throw new ToliError(`refusing to push ${project}: tag ${name} names no commit`);
    const remote = remoteObject(dir, ref);
    if (remote === object) {
        out(`push log: nothing new: origin already has tag ${name} at ${short(object)}`);
        return;
    }
    if (remote !== null)
        throw new ToliError(
            `refusing to push ${project}: origin's tag ${name} is ${short(remote)}, not the local ${short(object)}; a pushed tag is never moved`,
        );
    const push = (flags: string[]) => ["git", "-C", dir, "push", ...flags, "origin", `${object}:${ref}`];
    const code = await runTagPush(project, dir, { object, commit, ref }, push);
    if (code !== 0) throw new ToliError(`git push origin ${ref} failed (exit ${code})`);
    out(`push log: ${pushLine(appendPush({ project, branch: ref, old: null, new: object, ...attribution }))}`);
}

/** Run the tag's push, deciding what happens to the pre-push hook; returns git's exit code. */
async function runTagPush(
    project: string,
    dir: string,
    tag: { object: string; commit: string; ref: string },
    push: (flags: string[]) => string[],
): Promise<number> {
    const hook = activeHookPath(dir, "pre-push");
    if (hook === null) return runInherit(push([]));
    const decision = tagPushHookDecision(project, dir, hook, [{ object: tag.object, remote: tag.ref }]);
    if (decision.skip) {
        logDecision({ project, sha: tag.commit }, "hook-skip", decision.message);
        out(`push: ${decision.message}`);
        return runInherit(push(["--no-verify"]));
    }
    out(`push: running the pre-push hook: ${decision.reason}`);
    const light = lightPushCondition(hook);
    if (light !== null) {
        warn(`toli: the pre-push hook declares no heavy step with ${light}: pushing without a heavy-build slot`);
        return runInherit(push([]));
    }
    if (slotFreePushSha(project, dir, hook, tag.commit) !== null) return runInherit(push([]));
    return runCheckInSlot(dir, project, hook, push([]), {}, false);
}
