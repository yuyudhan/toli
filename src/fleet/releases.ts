// `bin/toli fleet releases <project>@<machine>... [--health <project>=<url>]... [--main <branch>] [--json]`: where
// each project's releases stand, read from the clone on the machine that cuts them: the newest tag and its date,
// commits on origin's main branch since that tag, origin's branches with "nightly" in their name that hold commits
// main does not (pushed, not merged), a cut in progress (a `release/*` branch not merged into main, or a running
// `--work release` jawan), and the version the deployed app's health URL reports. Read-only: no fetch, so origin's
// refs are as fresh as that clone's last fetch, whose age is shown.
import { Args } from "../core/args.ts";
import { isJsonObject, now, out, printJson, requireName, shellQuote, ToliError, waited } from "../core/util.ts";
import { runOnMachine, type ScriptOutcome, type Section } from "./machine-script.ts";

const HEALTH_TIMEOUT_MS = 8_000;

/** One branch with commits main does not have. */
export type Unmerged = { ref: string; ahead: number; at: string | null };

export type ReleaseStatus = {
    project: string;
    machine: string;
    /** Why the clone could not be read, when it could not. */
    error?: string;
    tag: string | null;
    tagAt: string | null;
    sinceTag: number | null;
    nightlies: Unmerged[];
    cuts: Unmerged[];
    releaseRuns: string[];
    fetchedAt: string | null;
    health: { url: string; version: string | null; error?: string } | null;
};

/** The script for `projects` on their release machine; `$TOLI` is its CLI. */
export function releaseScript(projects: string[], main: string): string {
    return `
main=${shellQuote(`origin/${main}`)}
echo "@@runs"; "$TOLI" runs --json --active 2>/dev/null
for p in ${projects.map(shellQuote).join(" ")}; do
  d="projects/$p"
  if [ ! -e "$d/.git" ]; then echo "@@missing $p"; continue; fi
  echo "@@release $p"
  if ! git -C "$d" rev-parse --quiet --verify "$main" >/dev/null; then echo "error	no $main in the clone"; continue; fi
  f="$d/.git/FETCH_HEAD"; [ -f "$f" ] && printf 'fetched\\t%s\\n' "$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")"
  tag=$(git -C "$d" for-each-ref --sort=-creatordate --count=1 --format='%(refname:short)' refs/tags)
  if [ -n "$tag" ]; then
    printf 'tag\\t%s\\t%s\\t%s\\n' "$tag" "$(git -C "$d" log -1 --format=%ct "$tag^{commit}")" "$(git -C "$d" rev-list --count "$tag..$main")"
  fi
  git -C "$d" for-each-ref --format='%(refname:short)' refs/remotes/origin refs/heads/release |
  while read -r ref; do
    case "$ref" in
      *nightly*) kind=nightly ;;
      release/*|origin/release/*) kind=cut ;;
      *) continue ;;
    esac
    n=$(git -C "$d" rev-list --count "$main..$ref" 2>/dev/null)
    [ -n "$n" ] && [ "$n" -gt 0 ] && printf '%s\\t%s\\t%s\\t%s\\n' "$kind" "$ref" "$n" "$(git -C "$d" log -1 --format=%ct "$ref")"
  done
done
`;
}

function epoch(text: string | undefined): string | null {
    return text === undefined || !/^\d+$/.test(text) ? null : new Date(Number(text) * 1000).toISOString();
}

/** The `@@release <project>` section's lines as a status (health filled in later). */
export function parseRelease(project: string, machine: string, body: string, runs: unknown[]): ReleaseStatus {
    const status: ReleaseStatus = {
        project,
        machine,
        tag: null,
        tagAt: null,
        sinceTag: null,
        nightlies: [],
        cuts: [],
        releaseRuns: runs.flatMap((run) =>
            isJsonObject(run) && run.work === "release" && run.project === project && typeof run.id === "string"
                ? [`${run.id}${typeof run.task === "string" ? ` (${run.task})` : ""}`]
                : [],
        ),
        fetchedAt: null,
        health: null,
    };
    for (const line of body.split("\n")) {
        const [kind, a, b, c] = line.split("\t");
        if (kind === "error") status.error = a ?? "clone not readable";
        else if (kind === "fetched") status.fetchedAt = epoch(a);
        else if (kind === "tag") {
            status.tag = a ?? null;
            status.tagAt = epoch(b);
            status.sinceTag = c !== undefined && /^\d+$/.test(c) ? Number(c) : null;
        } else if ((kind === "nightly" || kind === "cut") && a !== undefined && b !== undefined && /^\d+$/.test(b))
            (kind === "nightly" ? status.nightlies : status.cuts).push({ ref: a, ahead: Number(b), at: epoch(c) });
    }
    status.nightlies.sort((x, y) => y.ahead - x.ahead || x.ref.localeCompare(y.ref));
    return status;
}

/** The first `version` string anywhere in a JSON document, depth first. */
export function findVersion(value: unknown): string | null {
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findVersion(item);
            if (found !== null) return found;
        }
        return null;
    }
    if (!isJsonObject(value)) return null;
    if (typeof value.version === "string") return value.version;
    for (const item of Object.values(value)) {
        const found = findVersion(item);
        if (found !== null) return found;
    }
    return null;
}

async function healthVersion(url: string): Promise<{ url: string; version: string | null; error?: string }> {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
        if (!response.ok) return { url, version: null, error: `HTTP ${response.status}` };
        return { url, version: findVersion(await response.json()) };
    } catch (error) {
        return { url, version: null, error: error instanceof Error ? error.message : String(error) };
    }
}

/** `<project>@<machine>` arguments, grouped by machine. */
function targets(argv: string[]): Map<string, string[]> {
    const byMachine = new Map<string, string[]>();
    for (const target of argv) {
        const [project, machine, extra] = target.split("@");
        if (project === undefined || machine === undefined || extra !== undefined)
            throw new ToliError(`"${target}" is not <project>@<machine>`);
        byMachine.set(requireName("machine", machine), [
            ...(byMachine.get(machine) ?? []),
            requireName("project", project),
        ]);
    }
    return byMachine;
}

function sectionsStatus(outcome: ScriptOutcome, projects: string[]): ReleaseStatus[] {
    const blank = (project: string, error: string): ReleaseStatus => ({
        ...parseRelease(project, outcome.machine, "", []),
        error,
    });
    if (!outcome.ok) return projects.map((project) => blank(project, `unreachable: ${outcome.reason}`));
    const sections: Section[] = outcome.sections;
    let runs: unknown[] = [];
    try {
        const parsed: unknown = JSON.parse(sections.find((entry) => entry.name === "runs")?.body ?? "[]");
        runs = Array.isArray(parsed) ? parsed : [];
    } catch {
        runs = [];
    }
    return projects.map((project) => {
        if (sections.some((entry) => entry.name === "missing" && entry.arg === project))
            return blank(project, `no clone of ${project} on ${outcome.machine}`);
        const body = sections.find((entry) => entry.name === "release" && entry.arg === project)?.body ?? "";
        return parseRelease(project, outcome.machine, body, runs);
    });
}

/** Every project's release status; health URLs are asked from this machine. */
export async function fleetReleases(
    argv: string[],
    health: Map<string, string>,
    main: string,
): Promise<ReleaseStatus[]> {
    const byMachine = targets(argv);
    const machines = [...byMachine.entries()];
    const [statuses, versions] = await Promise.all([
        Promise.all(
            machines.map(async ([machine, projects]) =>
                sectionsStatus(await runOnMachine(machine, releaseScript(projects, main)), projects),
            ),
        ),
        Promise.all([...health.entries()].map(async ([project, url]) => [project, await healthVersion(url)] as const)),
    ]);
    const healthOf = new Map(versions);
    return statuses.flat().map((status) => ({ ...status, health: healthOf.get(status.project) ?? null }));
}

function unmergedLine(entry: Unmerged, at: number): string {
    return `${entry.ref} +${entry.ahead}${entry.at === null ? "" : ` (tip ${waited(at - Date.parse(entry.at))} ago)`}`;
}

/** A block per project. */
export function releasesText(statuses: ReleaseStatus[], main: string, at: number = now().getTime()): string {
    return statuses
        .map((status) => {
            const head = `${status.project} (release machine ${status.machine})`;
            const health =
                status.health === null
                    ? []
                    : [
                          `  deployed: ${status.health.version ?? `unknown (${status.health.error ?? "no version in the reply"})`} at ${status.health.url}`,
                      ];
            if (status.error !== undefined) return [head, `  ${status.error}`, ...health].join("\n");
            const tag =
                status.tag === null
                    ? "  latest tag: none"
                    : `  latest tag: ${status.tag}${status.tagAt === null ? "" : ` (${waited(at - Date.parse(status.tagAt))} ago)`}; ${status.sinceTag ?? "?"} commits on origin/${main} since`;
            const inProgress = [
                ...status.cuts.map((entry) => unmergedLine(entry, at)),
                ...status.releaseRuns.map((run) => `release run ${run}`),
            ];
            return [
                head,
                tag,
                ...health,
                `  nightlies not merged into origin/${main}: ${status.nightlies.length === 0 ? "none" : ""}`.trimEnd(),
                ...status.nightlies.map((entry) => `    ${unmergedLine(entry, at)}`),
                `  cut in progress: ${inProgress.length === 0 ? "none seen" : inProgress.join("; ")}`,
                `  origin refs as of: ${status.fetchedAt === null ? "unknown" : `${waited(at - Date.parse(status.fetchedAt))} ago (last fetch)`}`,
            ].join("\n");
        })
        .join("\n\n");
}

/** `toli fleet releases <project>@<machine>... [--health <project>=<url>]... [--main <branch>] [--json]`. */
export async function releasesCommand(argv: string[]): Promise<void> {
    const args = new Args(argv, { booleans: ["json"], values: ["health", "main"] });
    if (args.positional.length === 0)
        throw new ToliError(
            "usage: toli fleet releases <project>@<machine>... [--health <project>=<url>]... [--main <branch>] [--json]",
        );
    const health = new Map<string, string>();
    for (const entry of args.all("health")) {
        const split = entry.indexOf("=");
        if (split <= 0) throw new ToliError(`--health "${entry}" is not <project>=<url>`);
        health.set(entry.slice(0, split), entry.slice(split + 1));
    }
    const main = args.str("main") ?? "main";
    const statuses = await fleetReleases(args.positional, health, main);
    if (args.bool("json")) printJson(statuses);
    else out(releasesText(statuses, main));
}
