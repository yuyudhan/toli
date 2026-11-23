// Shared setup for tests/word-holds.test.ts: the held tasks in a sandbox, the tick's first look at the inbox, and an
// inbox item as `talk` leaves it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Task, tasks } from "./delegate-fixture.ts";
import type { Sandbox } from "./helpers.ts";

export function held(box: Sandbox): Task[] {
    return tasks(box).filter((task) => task.status === "held");
}

/** This machine's tick first looked at the inbox `minutesAgo` ago (state/word-holds.json `since`). */
export function ticking(box: Sandbox, minutesAgo: number): void {
    const dir = join(box.root, "state");
    mkdirSync(dir, { recursive: true });
    const since = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    writeFileSync(join(dir, "word-holds.json"), JSON.stringify({ since, holds: {}, read: {} }));
}

/** An inbox item from `from` as a `talk` leaves it, received `minutesAgo` ago, written without `inbox add`. */
export function talkItem(box: Sandbox, from: string, words: string, minutesAgo: number): void {
    const at = new Date(Date.now() - minutesAgo * 60_000);
    const stamp = at.toISOString().replace(/:/g, "-").replace(".", "-");
    const body = [
        `# message from ${from}`,
        "",
        `- from: ${from}`,
        `- received: ${at.toISOString()}`,
        "",
        words,
        "",
        `- from: ${from} (its lead, or the user there)`,
        `- reply: \`bin/toli talk ${from} "<reply>"\``,
        "",
    ].join("\n");
    const dir = join(box.root, "data", "inbox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${stamp}-${from}.md`), body);
}
