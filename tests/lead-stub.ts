// The lead service's test machine: an initialized m1 with an `omp` stub that records each headless turn.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox } from "./helpers.ts";

export type Lead = { box: Sandbox; calls: string; sessions: string };

/**
 * An initialized machine m1 whose `omp` stub writes each invocation's argv (one word per line) to `.omp-calls/<n>`,
 * exits 1 while `.fail` exists, fails to resume a conversation as omp does for a removed model while `.pinned`
 * exists, and otherwise leaves a conversation file in its --session-dir, as omp does.
 */
export function lead(): Lead {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    const calls = join(box.root, ".omp-calls");
    mkdirSync(calls);
    box.stub(
        "omp",
        `dir=""; prev=""; resume=""
for word in "$@"; do [ "$prev" = "--session-dir" ] && dir="$word"; [ "$word" = "--resume" ] && resume=1; prev="$word"; done
n=$(ls "${calls}" | wc -l | tr -d ' ')
printf '%s\\n' "$@" > "${calls}/$n"
printf '%s\\n' "$TOLI_LEAD_TURN" >> "${join(box.root, ".turn-env")}"
[ -f "${join(box.root, ".fail")}" ] && exit 1
if [ -f "${join(box.root, ".pinned")}" ] && [ -n "$resume" ]; then
  echo "SessionModelRestoreError: Could not restore model anthropic/claude-sonnet-5" >&2
  exit 1
fi
mkdir -p "$dir" && touch "$dir/conversation.jsonl"
exit 0`,
    );
    return { box, calls, sessions: join(box.root, "state", "lead", "sessions") };
}

export function deliver(box: Sandbox, title: string, body: string): void {
    box.ok(["inbox", "add", "--from", "m2", "--title", title], { stdin: body });
}

export function calls(setup: Lead): string[] {
    return readdirSync(setup.calls)
        .sort((a, b) => Number(a) - Number(b))
        .map((name) => readFileSync(join(setup.calls, name), "utf8"));
}

export function once(box: Sandbox): void {
    box.ok(["lead", "run", "--once"]);
}
