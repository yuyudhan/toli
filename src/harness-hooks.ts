// `bin/toli hook <name>`: harness hook entry points. Claude Code runs these from .claude/settings.json
// (written by `bin/toli harness sync`); each reads the hook's JSON on stdin. A hook never fails closed:
// any internal error allows the call, so a toli bug can never block a jawan or the lead's bookkeeping.
import { closeSync, openSync, readSync } from "node:fs";
import { leadGuidance } from "./guidance.ts";
import { claudeAction, guardDecision, isBrief, jawanEnv } from "./lead-guard.ts";
import { paths } from "./paths.ts";
import { out, readStdin, ToliError, warn } from "./util.ts";
import { takeWake, wakeMessage } from "./wake.ts";

type ClaudeHookInput = {
    cwd?: string;
    transcript_path?: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    agent_id?: string;
    prompt?: string;
};

const TRANSCRIPT_PREFIX_BYTES = 256 * 1024;

/** Whether the session's first user message is a jawan brief (a jawan started with `claude -p` by hand). */
export function transcriptIsBrief(transcriptPath: string): boolean {
    let text: string;
    try {
        const fd = openSync(transcriptPath, "r");
        try {
            const buffer = Buffer.alloc(TRANSCRIPT_PREFIX_BYTES);
            const read = readSync(fd, buffer, 0, buffer.length, 0);
            text = buffer.subarray(0, read).toString("utf8");
        } finally {
            closeSync(fd);
        }
    } catch {
        return false;
    }
    for (const line of text.split("\n")) {
        let entry: { type?: string; isMeta?: boolean; message?: { content?: unknown } };
        try {
            entry = JSON.parse(line) as typeof entry;
        } catch {
            continue;
        }
        if (entry.type !== "user" || entry.isMeta === true) continue;
        const content = entry.message?.content;
        if (typeof content === "string") return isBrief(content);
        if (Array.isArray(content)) {
            const first: unknown = content.find(
                (block: unknown) =>
                    typeof block === "object" && block !== null && "type" in block && block.type === "text",
            );
            const text = typeof first === "object" && first !== null && "text" in first ? first.text : undefined;
            return typeof text === "string" && isBrief(text);
        }
        return false;
    }
    return false;
}

function parseInput(): ClaudeHookInput {
    const raw = readStdin();
    return raw.trim() === "" ? {} : (JSON.parse(raw) as ClaudeHookInput);
}

/** PreToolUse decision for one Claude Code tool call; null means allow (print nothing). */
export function claudePreToolDecision(input: ClaudeHookInput, env: Record<string, string | undefined>): string | null {
    const jawan =
        jawanEnv(env) ||
        (input.agent_id ?? "") !== "" ||
        (input.transcript_path !== undefined && transcriptIsBrief(input.transcript_path));
    const decision = guardDecision(
        { root: paths.root(), cwd: input.cwd ?? process.cwd(), jawan },
        claudeAction(input.tool_name ?? "", input.tool_input ?? {}),
    );
    return decision.allow ? null : decision.reason;
}

/** UserPromptSubmit context for the lead: the guidance plus any results that arrived; null for jawans. */
export function claudePromptContext(input: ClaudeHookInput, env: Record<string, string | undefined>): string | null {
    if (jawanEnv(env) || isBrief(input.prompt ?? "")) return null;
    if (input.cwd !== undefined && input.cwd !== paths.root()) return null;
    const wake = wakeMessage(takeWake());
    return wake === "" ? leadGuidance() : `${leadGuidance()}\n\n${wake}`;
}

function guarded(name: string, body: () => void): void {
    try {
        body();
    } catch (error) {
        warn(`toli hook ${name}: ${error instanceof Error ? error.message : String(error)} (allowing)`);
    }
}

export function hookCommand(argv: string[]): void {
    const [name, ...rest] = argv;
    if (rest.length > 0) throw new ToliError(`toli hook ${name ?? ""}: unexpected arguments`);
    switch (name) {
        case "claude-pre-tool":
            guarded(name, () => {
                const reason = claudePreToolDecision(parseInput(), process.env);
                if (reason === null) return;
                out(
                    JSON.stringify({
                        hookSpecificOutput: {
                            hookEventName: "PreToolUse",
                            permissionDecision: "deny",
                            permissionDecisionReason: reason,
                        },
                    }),
                );
            });
            return;
        case "claude-prompt":
            guarded(name, () => {
                const context = claudePromptContext(parseInput(), process.env);
                if (context === null) return;
                out(
                    JSON.stringify({
                        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
                    }),
                );
            });
            return;
        default:
            throw new ToliError("usage: toli hook claude-pre-tool|claude-prompt (JSON on stdin)");
    }
}
