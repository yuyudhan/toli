// Every project clone under a machine's toli root, read with plain git for the fleet reads (`fleet work`, `fleet
// push`, src/fleet/machine-script.ts): branch, commits not pushed, when it was last pushed, uncommitted files, and
// whether the project's newest jawan report says its push is blocked.

/** One clone's branch and push state. */
export type Clone = {
    project: string;
    /** The checked-out branch; null on a detached HEAD. */
    branch: string | null;
    /** Commits not on origin's branch of the same name (else the upstream); null when neither exists. */
    ahead: number | null;
    /** When this clone last pushed the branch (its remote-tracking reflog). */
    pushedAt: string | null;
    /** The commit time of origin's tip of the branch (else the upstream's). */
    upstreamAt: string | null;
    /** The commit time of the oldest commit not pushed. */
    oldestUnpushedAt: string | null;
    /** Changed and untracked files in the checkout. */
    dirty: number;
    /** The line of the project's newest report that says its push is blocked, with the report's name. */
    blocked: string | null;
};

/**
 * The `@@clones` section: one tab-separated line per clone, one background job per clone (a busy machine has dozens),
 * each printed in a single write. Without `detail` the costlier fields (oldest unpushed commit, uncommitted files, the
 * report's blocked line) are left empty and read as none.
 */
export function clonesScript(detail: boolean): string {
    return `
echo "@@clones"
detail=${detail ? "1" : ""}
for d in projects/*/; do
  d=\${d%/}; [ -e "$d/.git" ] || continue
  (
    p=\${d#projects/}
    b=$(git -C "$d" symbolic-ref --quiet --short HEAD) || b=
    ahead=; pushed=; tip=; oldest=; dirty=; blocked=
    if [ -n "$b" ]; then
      up="refs/remotes/origin/$b"
      git -C "$d" rev-parse --quiet --verify "$up" >/dev/null || up='@{u}'
      if ahead=$(git -C "$d" rev-list --count "$up..HEAD" 2>/dev/null); then
        tip=$(git -C "$d" log -1 --format=%ct "$up" 2>/dev/null)
        [ -n "$detail" ] && oldest=$(git -C "$d" log --reverse --format=%ct "$up..HEAD" 2>/dev/null | head -n 1)
      else
        ahead=
      fi
      pushed=$(git -C "$d" log -g -n 200 --format='%ct %gs' "refs/remotes/origin/$b" 2>/dev/null | grep -m 1 'update by push' | cut -d' ' -f1)
    fi
    if [ -n "$detail" ]; then
      dirty=$(git -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
      report=$(ls -t "data/projects/$p/reports/"*.md 2>/dev/null | head -n 1)
      if [ -n "$report" ]; then
        line=$(grep -i -m 1 -E 'push[^.]{0,60}block|block[^.]{0,60}push' "$report" | tr '\\t' ' ' | cut -c 1-160)
        [ -n "$line" ] && blocked="$(basename "$report"): $line"
      fi
    fi
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$p" "$b" "$ahead" "$pushed" "$tip" "$oldest" "$dirty" "$blocked"
  ) &
done
wait
`;
}

/** Unix seconds as an ISO time; null for anything else. */
function epoch(text: string | undefined): string | null {
    return text === undefined || !/^\d+$/.test(text) ? null : new Date(Number(text) * 1000).toISOString();
}

/** The clones in a `@@clones` section, by project name. */
export function parseClones(text: string): Clone[] {
    return text
        .split("\n")
        .flatMap((line): Clone[] => {
            const [project, branch, ahead, pushed, tip, oldest, dirty, blocked] = line.split("\t");
            if (project === undefined || project === "" || branch === undefined) return [];
            return [
                {
                    project,
                    branch: branch === "" ? null : branch,
                    ahead: ahead !== undefined && /^\d+$/.test(ahead) ? Number(ahead) : null,
                    pushedAt: epoch(pushed),
                    upstreamAt: epoch(tip),
                    oldestUnpushedAt: epoch(oldest),
                    dirty: dirty !== undefined && /^\d+$/.test(dirty) ? Number(dirty) : 0,
                    blocked: blocked === undefined || blocked.trim() === "" ? null : blocked.trim(),
                },
            ];
        })
        .sort((a, b) => a.project.localeCompare(b.project));
}
