import { ToliError } from "./util.ts";

export type ParsedArgs = {
    positional: string[];
    /** Paths after a bare `--`. */
    rest: string[];
    flags: Map<string, string | true>;
    /** Every value given for each value flag, in order (a repeated `--flag` keeps all of them). */
    lists: Map<string, string[]>;
};

const SHORT_FLAGS: Record<string, string> = { m: "message" };

/**
 * Parse `argv` into positionals, `--flag value` / `--flag=value` options and booleans.
 * Flags listed in `booleans` never consume the next word; every other flag requires a value.
 */
export function parseArgs(argv: string[], booleans: readonly string[] = []): ParsedArgs {
    const positional: string[] = [];
    const rest: string[] = [];
    const flags = new Map<string, string | true>();
    const lists = new Map<string, string[]>();
    const setValue = (name: string, value: string): void => {
        flags.set(name, value);
        const list = lists.get(name);
        if (list === undefined) lists.set(name, [value]);
        else list.push(value);
    };
    for (let i = 0; i < argv.length; i++) {
        const word = argv[i] as string;
        if (word === "--") {
            rest.push(...argv.slice(i + 1));
            break;
        }
        let name: string | undefined;
        let inline: string | undefined;
        if (word.startsWith("--") && word.length > 2) {
            const eq = word.indexOf("=");
            name = eq === -1 ? word.slice(2) : word.slice(2, eq);
            inline = eq === -1 ? undefined : word.slice(eq + 1);
        } else if (/^-[A-Za-z]$/.test(word)) {
            const long = SHORT_FLAGS[word.slice(1)];
            if (long === undefined) throw new ToliError(`unknown option ${word}`);
            name = long;
        }
        if (name === undefined) {
            positional.push(word);
            continue;
        }
        if (booleans.includes(name)) {
            if (inline !== undefined) throw new ToliError(`--${name} takes no value`);
            flags.set(name, true);
            continue;
        }
        if (inline !== undefined) {
            setValue(name, inline);
            continue;
        }
        const value = argv[i + 1];
        if (value === undefined) throw new ToliError(`--${name} needs a value`);
        setValue(name, value);
        i++;
    }
    return { positional, rest, flags, lists };
}

export class Args {
    readonly positional: string[];
    readonly rest: string[];
    private readonly flags: Map<string, string | true>;
    private readonly lists: Map<string, string[]>;
    private readonly allowed: Set<string>;

    constructor(argv: string[], options: { booleans?: readonly string[]; values?: readonly string[] } = {}) {
        const booleans = options.booleans ?? [];
        const parsed = parseArgs(argv, booleans);
        this.positional = parsed.positional;
        this.rest = parsed.rest;
        this.flags = parsed.flags;
        this.lists = parsed.lists;
        this.allowed = new Set([...booleans, ...(options.values ?? [])]);
        for (const name of this.flags.keys()) {
            if (!this.allowed.has(name)) throw new ToliError(`unknown option --${name}`);
        }
    }

    bool(name: string): boolean {
        return this.flags.get(name) === true;
    }

    str(name: string): string | undefined {
        const value = this.flags.get(name);
        return typeof value === "string" ? value : undefined;
    }

    /** Every value of a repeatable value flag, in the order given; empty when absent. */
    all(name: string): string[] {
        return this.lists.get(name) ?? [];
    }

    has(name: string): boolean {
        return this.flags.has(name);
    }

    pos(index: number, label: string): string {
        const value = this.positional[index];
        if (value === undefined || value === "") throw new ToliError(`missing <${label}>`);
        return value;
    }

    /** Fail on positionals beyond `count` so typos do not pass silently. */
    maxPositional(count: number): void {
        if (this.positional.length > count) {
            throw new ToliError(`unexpected argument "${this.positional[count]}"`);
        }
    }
}
