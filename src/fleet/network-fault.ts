// Most fleet machines unreachable the same way are one fault of the network between them and here, not one fault per
// host: `fleet check` (src/fleet/oversight.ts) prints them as one `network fault` line.
import type { FleetEntry } from "./resources.ts";

/** Other machines unreachable the same way (`kind`), out of `of` other machines. */
export type NetworkFaultGroup = { kind: string; machines: string[]; of: number };

/** How a machine can be unreachable in a way many share, most specific first; the first that matches names it. */
const UNREACHABLE_KINDS: readonly [RegExp, string][] = [
    [
        /EAI_AGAIN|ENOTFOUND|could not resolve hostname|name resolution|name or service not known|nodename nor servname/i,
        "names do not resolve",
    ],
    [/off the network/i, "off the network"],
    [/no route|network is unreachable|host is down|host down|timed out|no answer from/i, "no route or timed out"],
    [/connection refused/i, "connection refused"],
];

/** The kind of an unreachable machine's reason that other hosts can share, or null when it names none. */
export function unreachableKind(reason: string): string | null {
    return UNREACHABLE_KINDS.find(([pattern]) => pattern.test(reason))?.[1] ?? null;
}

/** At least two and more than half of the other machines unreachable the same way, or null. */
export function commonNetworkFault(entries: FleetEntry[]): NetworkFaultGroup | null {
    const others = entries.filter((entry) => !entry.local);
    const byKind = new Map<string, string[]>();
    for (const entry of others) {
        if (entry.reachable && entry.resources !== null) continue;
        const kind = unreachableKind(entry.reasons.join("; "));
        if (kind !== null) byKind.set(kind, [...(byKind.get(kind) ?? []), entry.machine]);
    }
    for (const [kind, machines] of byKind)
        if (machines.length >= 2 && machines.length * 2 > others.length) return { kind, machines, of: others.length };
    return null;
}

/** The one line a common network fault reads as. */
export function networkFaultLine(group: NetworkFaultGroup): string {
    return `network fault: ${group.machines.length} of ${group.of} other machines unreachable the same way (${group.kind}): ${group.machines.join(", ")}; check this machine's network first (\`bin/toli fleet status\` has each reason)`;
}
