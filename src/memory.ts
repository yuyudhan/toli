import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { Args } from "./args.ts";
import { machineSettings } from "./config.ts";
import { paths } from "./paths.ts";
import { now, out, printJson, ToliError, withLock, writeTextAtomic } from "./util.ts";

/** pinned: never ages (Malik's word only); aging: stale after 30 days; perishable `(until: ...)`: after 7 days. */
export type Tier = "pinned" | "aging" | "perishable";

export const DEFAULT_MEMORY_BUDGET = 7500;
export const STALE_DAYS: Record<Exclude<Tier, "pinned">, number> = { aging: 30, perishable: 7 };

const DAY_MS = 24 * 60 * 60 * 1000;
const BULLET = /^- (?:\*\*)?(\d{4}-\d{2}-\d{2})?/;
const DATED_HEADING = /^#{2,6} (\d{4}-\d{2}-\d{2})\b/;
const PERISHABLE = /\(until:[^)]*\)/i;

export type MemoryFile = { file: string; path: string; tier: Exclude<Tier, "perishable">; exists: boolean };

export type FileSize = MemoryFile & { bytes: number; tokens: number };

export type MemoryReport = { budget: number; total: number; over: boolean; files: FileSize[]; notes: FileSize[] };

export type Entry = {
    file: string;
    /** 1-based first and last line of the entry in its file. */
    line: number;
    endLine: number;
    /** Short content hash; stable while the entry text is unchanged. */
    id: string;
    date: string | null;
    tier: Tier;
    text: string;
};

export type StaleEntry = Entry & { ageDays: number | null; reason: string };

/** Conservative local token estimate: ceil(UTF-8 bytes / 3). */
export function estimateTokens(bytes: number): number {
    return Math.ceil(bytes / 3);
}

/** Positive-integer `memoryBudgetTokens` from config/machine.json, else the default; anything else is an error. */
export function memoryBudget(): number {
    const value = machineSettings().memoryBudgetTokens;
    if (value === undefined) return DEFAULT_MEMORY_BUDGET;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
        throw new ToliError(`config/machine.json memoryBudgetTokens must be a positive integer, got ${String(value)}`);
    return value;
}

function memoryFile(path: string, tier: MemoryFile["tier"]): MemoryFile {
    return { file: relative(paths.root(), path), path, tier, exists: existsSync(path) };
}

/** Always-loaded memory: counted against the budget. */
export function alwaysLoaded(): MemoryFile[] {
    return [memoryFile(paths.malik(), "pinned"), memoryFile(paths.learnings(), "aging")];
}

/** Per-project notes (`data/projects/<p>/notes.md`): loaded only into briefs for that project, so reported but not counted. */
export function noteFiles(): MemoryFile[] {
    const dir = paths.projectsDataDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .map((project) => paths.projectNotes(project))
        .filter((path) => existsSync(path))
        .map((path) => memoryFile(path, "aging"));
}

function sized(file: MemoryFile): FileSize {
    const bytes = file.exists ? Buffer.byteLength(readFileSync(file.path, "utf8"), "utf8") : 0;
    return { ...file, bytes, tokens: estimateTokens(bytes) };
}

export function memoryReport(): MemoryReport {
    const budget = memoryBudget();
    const files = alwaysLoaded().map(sized);
    const total = files.reduce((sum, file) => sum + file.tokens, 0);
    return { budget, total, over: total > budget, files, notes: noteFiles().map(sized) };
}

/** Doctor's one-line memory verdict: over budget is a warning, never a failure. */
export function memoryCheck(): { level: "ok" | "warn"; detail: string } {
    try {
        const report = memoryReport();
        const summary = `${report.total}/${report.budget} estimated tokens in ${report.files.map((file) => file.file).join(" + ")}`;
        return report.over
            ? { level: "warn", detail: `${summary}: over budget by ${report.total - report.budget}; run /stow` }
            : { level: "ok", detail: summary };
    } catch (error) {
        return { level: "warn", detail: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Entries are top-level bullets (`- ...` plus indented continuation lines) and dated headings
 * (`## YYYY-MM-DD ...` through the next heading). An entry's date is the `YYYY-MM-DD` right after `- ` or `## `.
 */
export function parseEntries(file: string, text: string, fileTier: MemoryFile["tier"]): Entry[] {
    const lines = text.split("\n");
    const entries: Entry[] = [];
    let index = 0;
    while (index < lines.length) {
        const first = lines[index] ?? "";
        const heading = DATED_HEADING.exec(first);
        const bullet = heading ? null : BULLET.exec(first);
        if (!heading && !bullet) {
            index += 1;
            continue;
        }
        let end = index + 1;
        if (heading) {
            while (end < lines.length && !(lines[end] ?? "").startsWith("#")) end += 1;
        } else {
            while (end < lines.length && /^\s+\S/.test(lines[end] ?? "")) end += 1;
        }
        while (end > index + 1 && (lines[end - 1] ?? "").trim() === "") end -= 1;
        const body = lines.slice(index, end).join("\n");
        const date = (heading ?? bullet)?.[1] ?? null;
        entries.push({
            file,
            line: index + 1,
            endLine: end,
            id: createHash("sha1").update(body).digest("hex").slice(0, 7),
            date,
            tier: fileTier === "pinned" ? "pinned" : PERISHABLE.test(body) ? "perishable" : "aging",
            text: body,
        });
        index = end;
    }
    return entries;
}

/** Non-pinned entries past their tier's lifetime, plus undated ones (they have no clock until /stow dates them). */
export function staleEntries(at: Date = now()): StaleEntry[] {
    const stale: StaleEntry[] = [];
    const todayMs = Date.parse(at.toISOString().slice(0, 10));
    for (const file of [...alwaysLoaded(), ...noteFiles()]) {
        if (!file.exists) continue;
        for (const entry of parseEntries(file.file, readFileSync(file.path, "utf8"), file.tier)) {
            if (entry.tier === "pinned") continue;
            if (entry.date === null || Number.isNaN(Date.parse(entry.date))) {
                stale.push({ ...entry, ageDays: null, reason: "undated" });
                continue;
            }
            const age = Math.floor((todayMs - Date.parse(entry.date)) / DAY_MS);
            if (age >= STALE_DAYS[entry.tier]) stale.push({ ...entry, ageDays: age, reason: `unreinforced ${age}d` });
        }
    }
    return stale;
}

/**
 * Resolve `learnings`, `malik.md`, `notes/<project>`, `data/projects/<project>/notes.md` (or an absolute path)
 * to a memory file. `notes/<project>` is shorthand for `projects/<project>/notes`.
 */
export function resolveMemoryFile(spec: string): MemoryFile {
    const dataDir = join(paths.root(), "data");
    const absolute = isAbsolute(spec) ? spec : resolve(paths.root(), spec);
    const fromRoot = relative(paths.root(), absolute);
    const raw = (fromRoot.startsWith("data/") ? relative(dataDir, absolute) : spec).replace(/\.md$/, "");
    const name = raw.replace(/^notes\/([^/]+)$/, "projects/$1/notes");
    const known = [...alwaysLoaded(), ...noteFiles()];
    const match = known.find((file) => relative(dataDir, file.path).replace(/\.md$/, "") === name);
    if (!match?.exists)
        throw new ToliError(
            `unknown memory file "${spec}": use malik, learnings, or notes/<project> (an existing data/ file)`,
        );
    return match;
}

function findEntry(entries: Entry[], selector: string): Entry {
    if (/^\d+$/.test(selector)) {
        const line = Number(selector);
        const entry = entries.find((candidate) => candidate.line <= line && line <= candidate.endLine);
        if (!entry) throw new ToliError(`line ${line} is not inside a memory entry`);
        return entry;
    }
    const matches = entries.filter((candidate) => candidate.id.startsWith(selector.toLowerCase()));
    if (matches.length === 0) throw new ToliError(`no entry with id "${selector}"`);
    if (matches.length > 1) throw new ToliError(`id "${selector}" matches ${matches.length} entries; use more digits`);
    return matches[0] as Entry;
}

function archiveBlock(existing: string, entry: Entry, reason: string, at: Date): string {
    const day = at.toISOString().slice(0, 10);
    const lastHeading = existing.match(/^## .*$/gm)?.at(-1);
    const heading = lastHeading === `## ${day}` ? "" : `## ${day}\n\n`;
    const provenance = `From \`${entry.file}\` line ${entry.line} (tier ${entry.tier}, dated ${entry.date ?? "undated"}). Reason: ${reason}.`;
    const lead = existing === "" ? "" : existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${lead}${heading}${provenance}\n\n${entry.text}\n`;
}

export type ArchiveResult = { entry: Entry; archive: string };

/** Archive file for a memory file: project notes keep their per-project name (`<project>.md`), others their basename. */
function archiveName(file: MemoryFile): string {
    const project = /^projects\/([^/]+)\/notes\.md$/.exec(relative(join(paths.root(), "data"), file.path))?.[1];
    return project === undefined ? basename(file.path) : `${project}.md`;
}

/**
 * Move one entry to data/archive/<name>.md with provenance. The archive is written before the source, so a crash
 * in between leaves the entry in both places, never in neither. Pinned entries need `force` (Malik's explicit word).
 */
export function archiveEntry(spec: string, selector: string, reason: string, force: boolean): ArchiveResult {
    if (reason.trim() === "") throw new ToliError("memory archive needs --reason <text>");
    const file = resolveMemoryFile(spec);
    const archivePath = paths.archive(archiveName(file));
    return withLock(paths.lock("memory"), () => {
        const source = readFileSync(file.path, "utf8");
        const entry = findEntry(parseEntries(file.file, source, file.tier), selector);
        if (entry.tier === "pinned" && !force)
            throw new ToliError(
                `${file.file} line ${entry.line} is pinned (Malik's preference): archive it only on his explicit word, with --force`,
            );
        const at = now();
        const existing = existsSync(archivePath) ? readFileSync(archivePath, "utf8") : "";
        writeTextAtomic(archivePath, archiveBlock(existing, entry, reason.trim(), at));
        const lines = source.split("\n");
        lines.splice(entry.line - 1, entry.endLine - entry.line + 1);
        writeTextAtomic(file.path, lines.join("\n"));
        return { entry, archive: relative(paths.root(), archivePath) };
    });
}

function firstLine(entry: Entry): string {
    const line = entry.text.split("\n", 1)[0] ?? "";
    return line.length > 100 ? `${line.slice(0, 97)}...` : line;
}

function report(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const result = memoryReport();
    if (args.bool("json")) {
        printJson(result);
        return;
    }
    const verdict = result.over
        ? `over budget by ${result.total - result.budget}`
        : `${result.budget - result.total} under budget`;
    out(`memory: ${result.total}/${result.budget} estimated tokens (${verdict})`);
    for (const file of result.files)
        out(
            `  ${file.file}\t${file.tokens} tokens\t${file.bytes} bytes\t${file.tier}${file.exists ? "" : "\t(missing)"}`,
        );
    if (result.notes.length === 0) return;
    const notesTotal = result.notes.reduce((sum, file) => sum + file.tokens, 0);
    out(`notes (loaded per brief, not counted): ${notesTotal} tokens across ${result.notes.length} files`);
    for (const file of result.notes) out(`  ${file.file}\t${file.tokens} tokens\t${file.bytes} bytes`);
}

function stale(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(0);
    const entries = staleEntries();
    if (args.bool("json")) {
        printJson(entries);
        return;
    }
    if (entries.length === 0) {
        out("memory: no stale entries");
        return;
    }
    out(
        `memory: ${entries.length} stale entr${entries.length === 1 ? "y" : "ies"} (re-confirm and refresh the date, or archive)`,
    );
    for (const entry of entries) {
        const age = entry.ageDays === null ? "undated" : `${entry.ageDays}d`;
        out(
            `  ${entry.file}:${entry.line}\t${entry.id}\t${entry.date ?? "-"}\t${age}\t${entry.tier}\t${firstLine(entry)}`,
        );
    }
}

function archive(argv: string[]): void {
    const args = new Args(argv, { booleans: ["force"], values: ["reason"] });
    args.maxPositional(2);
    const result = archiveEntry(
        args.pos(0, "file"),
        args.pos(1, "line-or-id"),
        args.str("reason") ?? "",
        args.bool("force"),
    );
    out(
        `archived ${result.entry.file}:${result.entry.line} (${result.entry.id}) -> ${result.archive}: ${firstLine(result.entry)}`,
    );
}

export function memoryCommand(argv: string[]): void {
    const [sub, ...rest] = argv;
    switch (sub) {
        case "stale":
            stale(rest);
            break;
        case "archive":
            archive(rest);
            break;
        default:
            if (sub !== undefined && !sub.startsWith("--"))
                throw new ToliError(
                    "usage: toli memory [--json] | stale [--json] | archive <file> <line-or-id> --reason <text> [--force]",
                );
            report(argv);
    }
}
