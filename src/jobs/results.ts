// Scheduled jobs' results (data/jobs/<job>/<stamp>.md): listing them, `job results` and `job ack`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Args } from "../core/args.ts";
import { paths } from "../core/paths.ts";
import { out, printJson, stamp } from "../core/util.ts";
import { ackedThrough, acknowledge, markShown } from "../records/acks.ts";

/** A quiet result is an idle run's record (`job finish --quiet`): kept in the history, never unseen, never a wake. */
export type JobResult = {
    job: string;
    file: string;
    path: string;
    stamp: string;
    status: string;
    quiet: boolean;
    unseen: boolean;
};

const STAMP_LENGTH = stamp(new Date(0)).length;

export function listResults(): JobResult[] {
    const base = paths.jobResultsDir();
    if (!existsSync(base)) return [];
    const acked = ackedThrough("jobs");
    const results: JobResult[] = [];
    for (const job of readdirSync(base)) {
        const dir = join(base, job);
        if (!statSync(dir).isDirectory()) continue;
        for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
            const path = join(dir, file);
            const resultStamp = file.slice(0, STAMP_LENGTH);
            const text = readFileSync(path, "utf8");
            const status = /^- status: (\S+)$/m.exec(text)?.[1] ?? "unknown";
            const quiet = /^- quiet: yes$/m.test(text);
            results.push({ job, file, path, stamp: resultStamp, status, quiet, unseen: !quiet && resultStamp > acked });
        }
    }
    return results.sort((a, b) => a.stamp.localeCompare(b.stamp) || a.job.localeCompare(b.job));
}

function results(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json", "unseen"], values: ["job"] });
    args.maxPositional(0);
    const job = args.str("job");
    const items = listResults().filter(
        (item) => (!args.bool("unseen") || item.unseen) && (job === undefined || item.job === job),
    );
    // One job's results say nothing of other jobs' newer ones, so only an unfiltered listing raises the shown mark.
    if (job === undefined)
        markShown(
            "jobs",
            items.map((item) => item.stamp),
        );
    if (args.bool("json")) {
        printJson(items);
        return;
    }
    if (items.length === 0) {
        out(args.bool("unseen") ? "no unseen job results" : "no job results");
        return;
    }
    for (const item of items)
        out(`${item.unseen ? "*" : " "} ${item.stamp}\t${item.job}\t${item.status}\t${item.path}`);
}

function ack(argv: string[]): void {
    acknowledge(
        "jobs",
        argv,
        listResults().flatMap((item) => (item.quiet ? [] : [item.stamp])),
        "job result",
    );
}

export const resultSubcommands = { results, ack };
