import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Args } from "../core/args.ts";
import { paths } from "../core/paths.ts";
import { now, out, printJson, readStdin, requireName, stamp, ToliError, writeTextAtomic } from "../core/util.ts";
import { ackedThrough, ackThrough } from "./acks.ts";

export type InboxItem = { file: string; path: string; stamp: string; from: string; title: string; unseen: boolean };

const STAMP_LENGTH = stamp(new Date(0)).length;

export function listInbox(): InboxItem[] {
    const dir = paths.inboxDir();
    if (!existsSync(dir)) return [];
    const acked = ackedThrough("inbox");
    return readdirSync(dir)
        .filter((file) => file.endsWith(".md"))
        .sort()
        .map((file) => {
            const itemStamp = file.slice(0, STAMP_LENGTH);
            const from = file.slice(STAMP_LENGTH + 1, -".md".length);
            const path = join(dir, file);
            const firstLine = readFileSync(path, "utf8").split("\n", 1)[0] ?? "";
            return {
                file,
                path,
                stamp: itemStamp,
                from,
                title: firstLine.replace(/^#\s*/, ""),
                unseen: itemStamp > acked,
            };
        });
}

/** Store one inbox message; used locally and by workers delivering over ssh. */
export function addInboxItem(from: string, title: string, body: string): string {
    const at = now();
    let path = join(paths.inboxDir(), `${stamp(at)}-${from}.md`);
    // Same-millisecond deliveries get the next free millisecond so neither overwrites the other.
    for (let bump = 1; existsSync(path); bump++) {
        path = join(paths.inboxDir(), `${stamp(new Date(at.getTime() + bump))}-${from}.md`);
    }
    writeTextAtomic(path, `# ${title}\n\n- from: ${from}\n- received: ${at.toISOString()}\n\n${body.trimEnd()}\n`);
    return path;
}

function add(argv: string[]): void {
    const args = new Args(argv, { values: ["from", "title"] });
    args.maxPositional(0);
    const from = requireName("machine", args.str("from"));
    const title = args.str("title");
    if (!title) throw new ToliError("inbox add needs --title");
    const body = readStdin();
    if (body.trim() === "") throw new ToliError("inbox add needs the message body on stdin");
    out(addInboxItem(from, title, body));
}

function list(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json", "unseen"] });
    args.maxPositional(0);
    const items = listInbox().filter((item) => !args.bool("unseen") || item.unseen);
    if (args.bool("json")) {
        printJson(items);
        return;
    }
    if (items.length === 0) {
        out(args.bool("unseen") ? "inbox: nothing unseen" : "inbox: empty");
        return;
    }
    for (const item of items)
        out(`${item.unseen ? "*" : " "} ${item.stamp}\t${item.from}\t${item.title}\t${item.path}`);
}

function ack(argv: string[]): void {
    new Args(argv).maxPositional(0);
    const items = listInbox();
    const last = items[items.length - 1];
    const unseen = items.filter((item) => item.unseen).length;
    if (last) ackThrough("inbox", last.stamp);
    out(`acknowledged ${unseen} inbox item${unseen === 1 ? "" : "s"}`);
}

export function inboxCommand(argv: string[]): void {
    const [sub, ...rest] = argv;
    switch (sub) {
        case "add":
            add(rest);
            break;
        case "list":
            list(rest);
            break;
        case "ack":
            ack(rest);
            break;
        default:
            throw new ToliError("usage: toli inbox add|list|ack");
    }
}
