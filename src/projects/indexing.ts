// Keep build output out of macOS Spotlight and Time Machine. Worktrees of worktree-per-task projects each grow their
// own `target/`, `node_modules/` and `dist/`; indexing and backing those up costs CPU and disk for nothing.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { platform, run, warn } from "../core/util.ts";

/** Spotlight skips a folder that holds a file of this name. */
const SPOTLIGHT_MARKER = ".metadata_never_index";
/**
 * The sticky Time Machine exclusion `tmutil addexclusion` sets: this extended attribute holding the binary plist
 * string "com.apple.backupd". Written with `xattr`, which takes milliseconds where `tmutil` can take ten seconds.
 */
const TM_EXCLUDE_ATTR = "com.apple.metadata:com_apple_backup_excludeItem";
const TM_EXCLUDE_VALUE =
    "62706c69737430305f1011636f6d2e6170706c652e6261636b75706408000000000000010100000000000000010000000000000000000000000000001c";

/**
 * Exclude `dir` and everything below it from Spotlight and Time Machine on macOS (a no-op elsewhere). Best effort: a
 * failure only warns, never blocks the caller.
 */
export function excludeFromIndexing(dir: string): void {
    if (platform() !== "darwin") return;
    try {
        writeFileSync(join(dir, SPOTLIGHT_MARKER), "", { flag: "a" });
    } catch (error) {
        warn(`warning: could not exclude ${dir} from Spotlight: ${(error as Error).message}`);
    }
    const result = run(["xattr", "-wx", TM_EXCLUDE_ATTR, TM_EXCLUDE_VALUE, dir]);
    if (result.code !== 0)
        warn(`warning: could not exclude ${dir} from Time Machine: ${(result.stderr || result.stdout).trim()}`);
}
