// `bin/toli talk <machine|person> [--run <id>] ["<words>"]`: talk to a machine's lead (docs/sardars.md). With words,
// they go to that machine's inbox, which wakes its lead; this is also how leads message each other. Without, this
// terminal opens that machine's lead conversation (`bin/toli lead attach`, over `ssh -t` for another machine). A person
// is named by their first name, alone or with this installation's title ("Sam", "Sam <user>"), as their machine shared
// it (docs/peers.md). A jawan run's talk names its run, and `--run <id>` sends the reply to that run on the target
// machine instead of its lead (src/jawans/replies.ts, docs/sardars.md "Replies to a jawan's talk").
// Words that are a jawan brief (`TOLI_BRIEF` first) or over 4 KB still go, with a warning to send work by
// `bin/toli delegate <machine> "<title>" --brief <file>` instead.
import { Args } from "../core/args.ts";
import { fleetMachine, inboundOff, inboundOffText, loadFleet, loadMachine, remoteToliCommand } from "../core/config.ts";
import { persona } from "../core/persona.ts";
import { isValidName, out, stamp, ToliError, warn } from "../core/util.ts";
import { deliverRunReply, forRunLine, ownRun, runIdArg, runTalkLines } from "../jawans/replies.ts";
import { queuedText, sendToMachine } from "../jobs/outbox.ts";
import { loadPeers } from "../peer/store.ts";
import { addInboxItem } from "../records/inbox.ts";
import { isBriefText, noteTalkSent } from "../records/word-holds.ts";
import { attachLead } from "./lead.ts";

/**
 * The machine `word` names: a machine (this one, the fleet's, an active paired peer) by its own name first, else the
 * one whose user has that first name, alone or followed by this installation's title. A name two machines share is
 * refused, naming both; a peer's person is only matched here, never acted on.
 */
export function talkTarget(word: string, self: string): string {
    const peers = loadPeers().filter((peer) => peer.status === "active");
    if (word === self || loadFleet().machines.some((m) => m.name === word) || peers.some((p) => p.name === word))
        return word;
    const names = persona();
    const spoken = word.trim().replace(/\s+/g, " ").toLowerCase();
    const people = [
        { machine: self, person: names.userFirstName },
        ...peers.map((peer) => ({ machine: peer.name, person: peer.person ?? "" })),
    ];
    const matches = people
        .filter(
            ({ person }) =>
                person !== "" && [person, `${person} ${names.user}`].some((n) => n.toLowerCase() === spoken),
        )
        .map(({ machine }) => machine);
    if (matches.length > 1)
        throw new ToliError(
            `talk: "${word}" is the person at ${matches.length} machines (${matches.join(", ")}): name the machine instead`,
        );
    if (matches[0] !== undefined) return matches[0];
    if (!isValidName(word))
        throw new ToliError(
            `talk: "${word}" is no machine here and no paired peer's person (bin/toli peer list shows each peer's person)`,
        );
    return word;
}

/** A `talk` longer than this is work to hand over, not a message: it goes by `delegate --brief`. */
const TALK_MAX_BYTES = 4096;

/** Why `words` should go by `bin/toli delegate ... --brief` instead of `talk` to `machine`, or null when they need not. */
function talkBriefWarning(machine: string, words: string): string | null {
    const bytes = Buffer.byteLength(words, "utf8");
    const why = isBriefText(words)
        ? "starts with TOLI_BRIEF: a brief is work to run, not a message"
        : bytes > TALK_MAX_BYTES
          ? `is ${Math.ceil(bytes / 1024)} KB, over ${TALK_MAX_BYTES / 1024} KB: a message that long is work to hand over`
          : null;
    return why === null
        ? null
        : `talk: this message ${why}; send work with \`bin/toli delegate ${machine} "<title>" --brief <file>\` (it arrives as a task its lead runs, and its questions come back held)`;
}

/** The message a lead gets for `words` from `from`, with how to answer, and `lines` after (a run's tags). */
export function talkMessage(from: string, words: string, lines: string[] = []): { title: string; body: string } {
    return {
        title: `message from ${from}`,
        body: [
            words.trim(),
            "",
            `- from: ${from} (its lead, or the user there)`,
            `- reply: \`bin/toli talk ${from} "<reply>"\`; work to hand over: \`bin/toli delegate ${from} ...\``,
            ...lines,
        ].join("\n"),
    };
}

export async function talkCommand(argv: string[]): Promise<number> {
    const args = new Args(argv, { values: ["run"] });
    args.maxPositional(2);
    const self = loadMachine().name;
    const machineName = talkTarget(args.pos(0, "machine"), self);
    const words = args.positional[1];
    const forRun = args.str("run");
    if (forRun !== undefined && words === undefined) throw new ToliError("talk --run needs the reply's words");
    if (words !== undefined) {
        if (words.trim() === "") throw new ToliError("talk: the message is empty");
        const warning = talkBriefWarning(machineName, words);
        if (warning !== null) warn(warning);
        const run = ownRun();
        const { title, body } = talkMessage(self, words, [
            ...(run === null ? [] : runTalkLines(self, run)),
            ...(forRun === undefined ? [] : [forRunLine(runIdArg(forRun))]),
        ]);
        const replies =
            run === null
                ? []
                : [`a reply sent with --run ${run.id} comes to this run: bin/toli run replies --wait <minutes>`];
        if (machineName === self) {
            const toRun = deliverRunReply(self, title, body);
            if (toRun !== null && "delivered" in toRun) out(toRun.delivered);
            else out(`posted to this machine's inbox: ${addInboxItem(self, title, toRun?.inboxBody ?? body)}`);
            for (const line of replies) out(line);
            return 0;
        }
        const sent = sendToMachine(self, fleetMachine(machineName), title, body, `talk-${self}-${stamp()}`);
        noteTalkSent(machineName, words);
        if (sent.delivered) out(`sent to ${machineName}'s lead; its reply arrives here as a wake`);
        else {
            if (!sent.pulled) warn(sent.error);
            out(queuedText(machineName, sent));
        }
        for (const line of replies) out(line);
        return 0;
    }
    if (machineName === self) return attachLead();
    const target = fleetMachine(machineName);
    if (inboundOff(target))
        throw new ToliError(
            `${inboundOffText(target)}: talk to its lead there, or with \`bin/toli talk ${machineName} "<words>"\``,
        );
    const proc = Bun.spawn(["ssh", "-t", target.ssh, remoteToliCommand(target.root, "lead attach")], {
        env: process.env,
        stdio: ["inherit", "inherit", "inherit"],
    });
    return await proc.exited;
}
