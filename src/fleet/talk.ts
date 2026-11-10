// `bin/toli talk <machine> ["<words>"]`: talk to a machine's lead (docs/sardars.md). With words, they go to that
// machine's inbox, which wakes its lead; this is also how leads message each other. Without, this terminal opens that
// machine's lead conversation (`bin/toli lead attach`, over `ssh -t` for another machine).
import { Args } from "../core/args.ts";
import { fleetMachine, inboundOff, inboundOffText, loadMachine, remoteToliCommand } from "../core/config.ts";
import { out, requireName, stamp, ToliError, warn } from "../core/util.ts";
import { queuedText, sendToMachine } from "../jobs/outbox.ts";
import { addInboxItem } from "../records/inbox.ts";
import { attachLead } from "./lead.ts";

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
    const machineName = requireName("machine", args.pos(0, "machine"));
    const words = args.positional[1];
    const self = loadMachine().name;
    if (words !== undefined) {
        if (words.trim() === "") throw new ToliError("talk: the message is empty");
        const { title, body } = talkMessage(self, words);
        if (machineName === self) {
            out(`posted to this machine's inbox: ${addInboxItem(self, title, body)}`);
            return 0;
        }
        const sent = sendToMachine(self, fleetMachine(machineName), title, body, `talk-${self}-${stamp()}`);
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
        stdio: ["inherit", "inherit", "inherit"],
    });
    return await proc.exited;
}
