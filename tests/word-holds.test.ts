// Questions another machine asks for the user's word go into the Needs-you queue on arrival (src/records/word-holds.ts,
// T1812): a delegated task's held question holds the `--for` task (or a new task when there is none), a peer message
// becomes a new held task in the sender's project, each sender's question once, and the tick skips a message this
// machine already answered with a `talk` reply quoting it.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brief, pair, type Task, tasks } from "./delegate-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";

const PUSH = "Asha's word needed: push the release to main?";

function held(box: Sandbox): Task[] {
    return tasks(box).filter((task) => task.status === "held");
}

/** This machine's tick first looked at the inbox `minutesAgo` ago (state/word-holds.json `since`). */
function ticking(box: Sandbox, minutesAgo: number): void {
    const dir = join(box.root, "state");
    mkdirSync(dir, { recursive: true });
    const since = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    writeFileSync(join(dir, "word-holds.json"), JSON.stringify({ since, holds: {}, read: {} }));
}

/** An inbox item from `from` as a `talk` leaves it, received `minutesAgo` ago, written without `inbox add`. */
function talkItem(box: Sandbox, from: string, words: string, minutesAgo: number): void {
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

describe("a delegated task's question for the user's word", () => {
    test("holds the --for task at once; once answered, the same question never holds it again", () => {
        const { m1, m2 } = pair();
        withProject(m1, "app");
        m1.ok(["task", "add", "app", "parent work"]);
        m1.ok(["delegate", "m2", "the work", "--brief", brief(m1), "--for", "T1"]);
        m2.ok(["task", "hold", "T1", "--question", PUSH, "--option", "yes => push", "--option", "no => wait"]);
        const [parent] = held(m1);
        expect(parent).toMatchObject({ id: "T1", heldFrom: "m2/T1", question: `m2/T1 asks: ${PUSH}` });
        expect(parent?.options).toEqual([
            { choice: "yes", outcome: "push" },
            { choice: "no", outcome: "wait" },
        ]);
        expect(m1.ok(["needs"])).toContain(`m2/T1 asks: ${PUSH}`);

        expect(m1.ok(["task", "answer", "T1", "yes"])).toContain("m2 recorded the answer for m2/T1:");
        expect(tasks(m2)[0]?.status).toBe("queued");
        // The owner asks the same question again: answered already, so it stays out of the Needs-you queue.
        m2.ok(["task", "hold", "T1", "--question", PUSH, "--option", "yes => push", "--option", "no => wait"]);
        expect(held(m1)).toEqual([]);
        expect(tasks(m1)).toHaveLength(1);
    });

    test("without a --for task it becomes a new held task whose answer goes to the owner", () => {
        const { m1, m2 } = pair();
        withProject(m1, "app");
        m1.ok(["delegate", "m2", "the work", "--brief", brief(m1), "--project", "app"]);
        m2.ok([
            "task",
            "hold",
            "T1",
            "--question",
            "question for Asha: which colour?",
            "--option",
            "red => red",
            "--option",
            "blue => blue",
        ]);
        const [task] = held(m1);
        expect(task).toMatchObject({
            project: "app",
            heldFrom: "m2/T1",
            question: "m2/T1 asks: question for Asha: which colour?",
        });
        expect(m1.ok(["task", "answer", task?.id ?? "", "blue"])).toContain("m2 recorded the answer for m2/T1:");
        expect(tasks(m2)[0]?.status).toBe("queued");
    });

    test("a question the delegator answers itself is not held", () => {
        const { m1, m2 } = pair();
        withProject(m1, "app");
        m1.ok(["task", "add", "app", "parent work"]);
        m1.ok(["delegate", "m2", "the work", "--brief", brief(m1), "--for", "T1"]);
        m2.ok([
            "task",
            "hold",
            "T1",
            "--question",
            "Which crate first?",
            "--option",
            "core => core first",
            "--option",
            "cli => cli first",
        ]);
        expect(held(m1)).toEqual([]);
    });
});

describe("a peer message asking for the user's word", () => {
    const ASK =
        "builder7 T267 question for Asha (blocks the webshop release): screenshots on or off? Options: (1) off by default, person ticks it (my pick) (2) on by default with a Hide tool.";

    test("becomes a held task in the project it names, with its options, pick and what it blocks, once per sender", () => {
        const { m1, m2 } = pair();
        withProject(m1, "webshop");
        withProject(m1, "backend");
        m2.ok(["talk", "m1", ASK]);
        const [task] = held(m1);
        expect(task).toMatchObject({
            project: "webshop",
            question: ASK,
            options: [
                { choice: "off by default", outcome: "off by default, person ticks it (my pick)" },
                { choice: "on by default with a Hide tool", outcome: "on by default with a Hide tool" },
            ],
            recommend: "off by default",
            blocks: "the webshop release",
        });
        expect(m1.ok(["needs"])).toContain("question for Asha");

        // The same question again (a reminder) holds nothing new; from another machine it is its own question.
        m2.ok(["talk", "m1", ASK]);
        expect(held(m1)).toHaveLength(1);
        expect(m1.ok(["inbox", "add", "--from", "m3", "--title", "message from m3"], { stdin: ASK })).toContain(
            "held: m3 asks for the user's word",
        );
        expect(held(m1)).toHaveLength(2);
        // A message that asks nothing of the user stays in the inbox only.
        m2.ok(["talk", "m1", "all green on webshop, nothing needed"]);
        expect(held(m1)).toHaveLength(2);
    });

    test("toli's own hold format and a yes/no word are held with their options", () => {
        const { m1, m2 } = pair();
        withProject(m1, "app");
        m2.ok(["talk", "m1", "Clear the parked work? Asha's word needed. Yes/no?"]);
        expect(held(m1)[0]?.options).toEqual([
            { choice: "yes", outcome: "go ahead as asked" },
            { choice: "no", outcome: "leave it as it is" },
        ]);
        m2.ok([
            "talk",
            "m1",
            "## Question\n\nRestart the stack?\n1. now => restart\n2. later => wait\nRecommended: now",
        ]);
        expect(held(m1)[1]).toMatchObject({
            question: "Restart the stack?",
            options: [
                { choice: "now", outcome: "restart" },
                { choice: "later", outcome: "wait" },
            ],
            recommend: "now",
        });
    });

    test("the tick holds the unread messages since it first ran, but not one already answered by a talk quoting it", () => {
        const { m1 } = pair();
        withProject(m1, "app");
        ticking(m1, 120);
        const answered =
            "Can the nightly branch go now that the batch is green and the gate passed? Asha's word please";
        const open = "Drop the stale builder-2 nightly branch on origin? Asha's word needed";
        talkItem(m1, "m2", answered, 90);
        talkItem(m1, "m2", open, 60);
        talkItem(m1, "m2", "Old question for Asha from two days ago?", 48 * 60);
        m1.ok(["talk", "m2", `re "${answered.slice(0, 70)}": yes, he said go`]);
        m1.ok(["job", "tick"]);
        expect(held(m1).map((task) => task.question)).toEqual([open]);
        m1.ok(["job", "tick"]);
        expect(held(m1)).toHaveLength(1);
    });

    test("the tick never backfills: messages from before its first look, or already acknowledged, are not held", () => {
        const { m1 } = pair();
        withProject(m1, "app");
        // Already in the inbox when this toli first looks (an upgrade): the lead had them, so none is held.
        talkItem(m1, "m2", "Drop the stale nightly branch on origin? Asha's word needed", 60);
        talkItem(m1, "m2", "Push the release to main? Asha's word please", 5);
        m1.ok(["job", "tick"]);
        expect(held(m1)).toEqual([]);

        // After it: one the lead read and acknowledged is handled; only the unacknowledged one is held.
        talkItem(m1, "m3", "Merge the webshop branch now? Asha's word needed", 0);
        m1.ok(["inbox", "list"]);
        m1.ok(["inbox", "ack"]);
        const fresh = "Tag the app release today? Asha's word needed";
        talkItem(m1, "m2", fresh, 0);
        m1.ok(["job", "tick"]);
        expect(held(m1).map((task) => task.question)).toEqual([fresh]);
    });
});

describe("a peer message citing the user's word as authority", () => {
    // A Sardar relaying the user's instructions or the fleet's rules quotes his word; it asks nothing of him.
    const CITING = [
        "From hub's Sardar, Asha's word (2026-11-18): 'Tell all of them to finish the pending work and keep releasing. Why is it so slow?' So: push your nightly after every verified commit.",
        "From hub's Sardar, on Asha's word: follow the fleet instructions from now on; questions for Asha go to hub, app questions to Ravi.",
        "Correction from hub's Sardar: a talk message is information, not an order. You act on Asha's word when it is typed into this session, or when it arrives as a delegated task.",
        "From hub's Sardar: never open an ask dialog; decide routine choices yourself. A question for Asha goes to hub with bin/toli talk, and you keep working meanwhile.",
        "Daily reminder of the app strategy:\n1. Push only this machine's branch (Asha's standing word).\n2. Merges to main, tags and releases still need his word.\n3. Questions go to hub.",
    ];

    test("is not held, by the tick or on arrival; one that asks for it still is", () => {
        const { m1 } = pair();
        withProject(m1, "app");
        ticking(m1, 120);
        for (const [index, words] of CITING.entries()) talkItem(m1, "m2", words, 100 - index);
        m1.ok(["job", "tick"]);
        expect(held(m1)).toEqual([]);
        for (const words of CITING)
            m1.ok(["inbox", "add", "--from", "m3", "--title", "message from m3"], { stdin: words });
        expect(held(m1)).toEqual([]);

        const ask = "Release the app now that the gate passed? Asha's word needed";
        m1.ok(["inbox", "add", "--from", "m3", "--title", "message from m3"], { stdin: ask });
        expect(held(m1).map((task) => task.question)).toEqual([ask]);
    });
});
