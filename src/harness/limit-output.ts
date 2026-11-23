// What a harness run's output says about provider limits and usage: whether it stopped on a rate or usage limit, the
// reset the error names, and the tokens and cost it printed. src/harness/models.ts decides what such a run retries on.

// A rate or usage limit as harnesses and provider APIs report it: Anthropic's rate_limit_error, Claude Code's
// "usage limit reached", HTTP 429 named next to a rate/limit/too-many word.
const LIMIT_PATTERNS: readonly RegExp[] = [
    /rate_limit_error/i,
    /usage limit/i,
    /rate limit(ed)?\b/i,
    /too many requests/i,
    /\b429\b.{0,80}\b(rate|limit|too many)/i,
    /\b(rate|limit|too many)\b.{0,80}\b429\b/i,
];

/** Lines of the attempt's output tail searched for a limit error; a report earlier in the log never counts. */
const LIMIT_TAIL_LINES = 15;

function tailLines(output: string, count: number): string[] {
    return output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .slice(-count);
}

/**
 * Whether a finished attempt stopped on a rate or usage limit: a failed exit whose output tail names one, or a clean
 * exit whose last line does (print modes that exit 0 after an API error).
 */
export function hitLimit(output: string, exitCode: number | null): boolean {
    if (exitCode !== 0)
        return tailLines(output, LIMIT_TAIL_LINES).some((line) => LIMIT_PATTERNS.some((pattern) => pattern.test(line)));
    // A clean exit counts only when the output is little more than the API error itself: a finished report that
    // mentions rate limits must never be run again.
    const lines = tailLines(output, CLEAN_EXIT_LINES + 1);
    return lines.length <= CLEAN_EXIT_LINES && CLEAN_EXIT_LIMIT.test(lines.at(-1) ?? "");
}

/** At most this many output lines on a clean exit, the last an API limit error, count as a limit. */
const CLEAN_EXIT_LINES = 3;
const CLEAN_EXIT_LIMIT = /rate_limit_error|usage limit reached|\b429\b/i;

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

/**
 * The reset time the limit error names, or null: an ISO instant, Claude Code's `|<epoch>`, `in/after N units`,
 * `retry-after-ms: N` (milliseconds), `retry-after: N` (seconds), or `resets 3pm`.
 */
export function limitReset(output: string, at: Date): Date | null {
    const text = tailLines(output, LIMIT_TAIL_LINES).join("\n");
    const iso = /reset\w*\D{0,20}(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d))/i.exec(text);
    if (iso?.[1] !== undefined) return new Date(iso[1]);
    const epoch = /limit reached\|(\d{10})\b/i.exec(text);
    if (epoch?.[1] !== undefined) return new Date(Number(epoch[1]) * 1000);
    const relative =
        /(?:try again|retry|resets?)\s+(?:in|after)\s+(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hours?)\b/i.exec(text);
    if (relative?.[1] !== undefined && relative[2] !== undefined)
        return new Date(at.getTime() + Number(relative[1]) * (UNIT_MS[relative[2][0]?.toLowerCase() ?? "s"] ?? 1000));
    const millis = /retry-after-ms["']?\s*[:=]\s*["']?(\d+)/i.exec(text);
    if (millis?.[1] !== undefined) return new Date(at.getTime() + Number(millis[1]));
    const header = /retry-after["']?\s*[:=]\s*["']?(\d+)/i.exec(text);
    if (header?.[1] !== undefined) return new Date(at.getTime() + Number(header[1]) * 1000);
    const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d\d))?\s*(am|pm)\b/i.exec(text);
    if (clock?.[1] !== undefined && clock[3] !== undefined) {
        const hour = (Number(clock[1]) % 12) + (clock[3].toLowerCase() === "pm" ? 12 : 0);
        const reset = new Date(at);
        reset.setHours(hour, Number(clock[2] ?? "0"), 0, 0);
        if (reset.getTime() <= at.getTime()) reset.setDate(reset.getDate() + 1);
        return reset;
    }
    return null;
}

/** Tokens and cost a harness printed for a run, when it prints them. */
export type Usage = { tokens?: number; costUsd?: number };

/**
 * Tokens and cost from the output tail, when the harness prints them: Codex's `tokens used` line, and `cost: $x` /
 * `total_cost_usd` lines. Null when none is there (omp, Claude Code and others in text mode print neither).
 */
export function parseUsage(output: string): Usage | null {
    const text = tailLines(output, 20).join("\n");
    const usage: Usage = {};
    const tokens = /tokens used[:\s]+([\d,]+)/i.exec(text);
    if (tokens?.[1] !== undefined) usage.tokens = Number(tokens[1].replaceAll(",", ""));
    const cost = /(?:total_cost_usd|total cost|^cost)["']?\s*[:=]?\s*\$?(\d+(?:\.\d+)?)/im.exec(text);
    if (cost?.[1] !== undefined) usage.costUsd = Number(cost[1]);
    return Object.keys(usage).length === 0 ? null : usage;
}

/** `12345 tokens, $0.42`. */
export function usageText(usage: Usage): string {
    return [
        usage.tokens === undefined ? null : `${usage.tokens} tokens`,
        usage.costUsd === undefined ? null : `$${usage.costUsd.toFixed(2)}`,
    ]
        .filter((part) => part !== null)
        .join(", ");
}
