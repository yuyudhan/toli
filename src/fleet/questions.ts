// `bin/toli fleet questions [--json]`: every open question across the fleet as one numbered list: each machine's held
// tasks (its Needs-you queue: question, options, recommendation, what waits on it) and this machine's unread inbox
// items that ask something. The same question held on two machines (a delegated task and its delegator) is listed
// once. Held tasks are read with `task list --json --status held`, which every toli release has.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { Args } from "../core/args.ts";
import { paths } from "../core/paths.ts";
import { now, out, printJson } from "../core/util.ts";
import type { Task } from "../records/backlog.ts";
import { matchOption } from "../records/hold-options.ts";
import { listInbox } from "../records/inbox.ts";
import { type NeedItem, needsQueue } from "../records/needs.ts";
import { runOnFleet, section } from "./machine-script.ts";
import { parseTasks } from "./work.ts";

const QUESTIONS_SCRIPT = `
echo "@@held"; "$TOLI" task list --json --status held 2>/dev/null
`;

/** One open question: a held task on `machine`, or an unread inbox item here. */
export type Question =
    | { kind: "hold"; machine: string; local: boolean; item: NeedItem; alsoOn: string[] }
    | { kind: "inbox"; file: string; from: string; title: string; question: string };

/** A held task's question, or its title when it was held without one, compared without case or spacing. */
function questionKey(text: string): string {
    return text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 240);
}

/** The first line of an inbox item that ends in a question mark, or null. */
export function inboxQuestion(body: string): string | null {
    const line = body
        .split("\n")
        .slice(1)
        .map((entry) => entry.trim())
        .find((entry) => /\?["')\]]*$/.test(entry));
    return line ?? null;
}

/**
 * Every machine's holds in fleet order (this machine first, so a question held here and on another machine is
 * listed under this one), most urgent first within a machine, deduplicated by question text.
 */
export function collectHolds(
    machines: Array<{ machine: string; local: boolean; tasks: Task[] }>,
    at: Date,
): Question[] {
    const byKey = new Map<string, Question & { kind: "hold" }>();
    const holds: Array<Question & { kind: "hold" }> = [];
    for (const machine of machines)
        for (const group of needsQueue(machine.tasks, at).groups)
            for (const item of group.items) {
                const key = questionKey(item.question ?? `${item.project} ${item.title}`);
                const seen = byKey.get(key);
                if (seen !== undefined) {
                    seen.alsoOn.push(`${machine.machine}/${item.id}`);
                    continue;
                }
                const question = {
                    kind: "hold" as const,
                    machine: machine.machine,
                    local: machine.local,
                    item,
                    alsoOn: [],
                };
                byKey.set(key, question);
                holds.push(question);
            }
    return holds;
}

/** This machine's unread inbox items that ask something. */
function inboxQuestions(): Question[] {
    return listInbox()
        .filter((item) => item.unseen)
        .flatMap((item): Question[] => {
            const question = inboxQuestion(readFileSync(item.path, "utf8"));
            if (question === null) return [];
            return [
                {
                    kind: "inbox",
                    file: relative(paths.root(), item.path),
                    from: item.from,
                    title: item.title,
                    question,
                },
            ];
        });
}

export type FleetQuestions = { questions: Question[]; unreachable: Array<{ machine: string; reason: string }> };

/** Every open question across the fleet, and the machines that could not be read. */
export async function fleetQuestions(): Promise<FleetQuestions> {
    const outcomes = await runOnFleet(QUESTIONS_SCRIPT);
    const machines: Array<{ machine: string; local: boolean; tasks: Task[] }> = [];
    const unreachable: Array<{ machine: string; reason: string }> = [];
    for (const outcome of outcomes) {
        const tasks = outcome.ok ? parseTasks(section(outcome.sections, "held")) : null;
        if (tasks !== null) machines.push({ machine: outcome.machine, local: outcome.local, tasks });
        else
            unreachable.push({
                machine: outcome.machine,
                reason: outcome.ok ? "task list --json gave no list" : outcome.reason,
            });
    }
    return { questions: [...collectHolds(machines, now()), ...inboxQuestions()], unreachable };
}

function holdLines(question: Question & { kind: "hold" }): string[] {
    const { item } = question;
    const recommended = item.recommend === null ? undefined : matchOption(item.options, item.recommend);
    const where = `${question.machine} ${item.id} ${item.project}`;
    const answer = question.local ? item.reply : `bin/toli task answer ${question.machine}/${item.id} "<answer>"`;
    return [
        `[${where}] ${item.question ?? `(held with no question) ${item.title}`}`,
        ...item.options.map(
            (option, index) =>
                `   ${index + 1}) ${option.choice} => ${option.outcome}${option === recommended ? "  (recommended)" : ""}`,
        ),
        ...(item.recommend !== null && recommended === undefined ? [`   recommended: ${item.recommend}`] : []),
        ...(item.blocks === null ? [] : [`   blocks: ${item.blocks}`]),
        `   held ${item.ageDays} d; answer: ${answer}${question.alsoOn.length > 0 ? `; also held as ${question.alsoOn.join(", ")}` : ""}`,
    ];
}

/** The numbered list, then the machines that could not be read. */
export function questionsText(result: FleetQuestions): string {
    const lines = [`Open questions (${result.questions.length}):`];
    result.questions.forEach((question, index) => {
        const body =
            question.kind === "hold"
                ? holdLines(question)
                : [
                      `[inbox from ${question.from}] ${question.title}: ${question.question}`,
                      `   file: ${question.file}`,
                  ];
        lines.push(`${String(index + 1).padStart(2)}. ${body[0] ?? ""}`, ...body.slice(1).map((line) => `  ${line}`));
    });
    for (const machine of result.unreachable) lines.push(`not read: ${machine.machine}: ${machine.reason}`);
    return lines.join("\n");
}

/** `toli fleet questions [--json]`. */
export async function questionsCommand(argv: string[]): Promise<void> {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const result = await fleetQuestions();
    if (args.bool("json")) printJson(result);
    else out(questionsText(result));
}
