// `bin/toli talk <machine|person> ["<words>"]`: talk to a machine's lead (docs/sardars.md). With words, they go to that
// machine's inbox, which wakes its lead; this is also how leads message each other. Without, this terminal opens that
// machine's lead conversation (`bin/toli lead attach`, over `ssh -t` for another machine). A person is named by their
// first name, alone or with this installation's title ("Sam", "Sam <user>"), as their machine shared it (docs/peers.md).
import { Args } from "../core/args.ts";
import { fleetMachine, inboundOff, inboundOffText, loadFleet, loadMachine, remoteToliCommand } from "../core/config.ts";
import { persona } from "../core/persona.ts";
import { isValidName, out, stamp, ToliError, warn } from "../core/util.ts";
import { queuedText, sendToMachine } from "../jobs/outbox.ts";
import { loadPeers } from "../peer/store.ts";
import { addInboxItem } from "../records/inbox.ts";
import { noteTalkSent } from "../records/word-holds.ts";
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

/** The message a lead gets for `words` from `from`, with how to answer. */
export function talkMessage(from: string, words: string): { title: string; body: string } {
    return {
        title: `message from ${from}`,
        body: [
            words.trim(),
            "",
            `- from: ${from} (its lead, or the user there)`,
            `- reply: \`bin/toli talk ${from} "<reply>"\`; work to hand over: \`bin/toli delegate ${from} ...\``,
        ].join("\n"),
    };
}

export async function talkCommand(argv: string[]): Promise<number> {
    const args = new Args(argv);
    args.maxPositional(2);
    const self = loadMachine().name;
    const machineName = talkTarget(args.pos(0, "machine"), self);
    const words = args.positional[1];
    if (words !== undefined) {
        if (words.trim() === "") throw new ToliError("talk: the message is empty");
        const { title, body } = talkMessage(self, words);
        if (machineName === self) {
            out(`posted to this machine's inbox: ${addInboxItem(self, title, body)}`);
            return 0;
        }
        const sent = sendToMachine(self, fleetMachine(machineName), title, body, `talk-${self}-${stamp()}`);
        noteTalkSent(machineName, words);
        if (sent.delivered) out(`sent to ${machineName}'s lead; its reply arrives here as a wake`);
        else {
            if (!sent.pulled) warn(sent.error);
            out(queuedText(machineName, sent));
        }
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
