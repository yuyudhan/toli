// Which checkout `bin/toli push` may push from, decided before any hook or gate runs. `--branch <b>`: the checkout
// must be on that branch (the release catch-up's push lines name it). A release train's checkout (T2232): a push whose
// pre-push hook runs the project's full check where a release train works holds the train up for hours, so a checkout
// on a `release/*` branch, or one a live jawan holds, is refused unless the train itself pushes (`--release-train`).
import { relative } from "node:path";
import { paths } from "../core/paths.ts";
import { now, ToliError } from "../core/util.ts";
import { checkoutHolder } from "../projects/catch-up.ts";

/** A release train's branch, `release/<version>` (src/fleet/releases.ts reads one as a cut in progress). */
const RELEASE_BRANCH = /^release\//;

/**
 * Refuse a push of `project` from `dir`, on `branch`: one on another branch than `expected` (`--branch`), and unless
 * `train` (`--release-train`), one on a `release/*` branch or held by a live jawan (checkoutHolder, the release
 * catch-up's own check; never `ownTask`'s jawan), since the project's pre-push check would run beside that work.
 */
export function requirePushCheckout(
    project: string,
    dir: string,
    branch: string,
    push: { expected: string | undefined; train: boolean; ownTask: string | null },
): void {
    const where = relative(paths.root(), dir);
    if (push.expected !== undefined && push.expected !== branch)
        throw new ToliError(`refusing: ${where} is on ${branch}, not ${push.expected}; not pushed`);
    if (push.train) return;
    if (RELEASE_BRANCH.test(branch))
        throw new ToliError(
            `refusing to push ${project}: ${where} is on ${branch}, a release train's branch; only the train pushes it (--release-train)`,
        );
    const holder = checkoutHolder(dir, now(), push.ownTask);
    if (holder !== null)
        throw new ToliError(
            `refusing to push ${project}: ${where} is held (${holder}); its pre-push check would run beside that work. ` +
                "Push once it ends, or --release-train from the train itself (a task's own jawan: --task <T-id>)",
        );
}
