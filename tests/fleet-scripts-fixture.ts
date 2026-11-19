// What a reachable fleet machine (m2 in tests/fleet-fixture.ts) prints for each fleet read script, and an ssh stub
// answering every script from these texts; shared by the fleet health/work and fleet reads tests.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, SSH_STUB_ARGS } from "./helpers.ts";

export const LINUX_HEALTH = `@@ncpu
12
@@loadavg
3.35 4.91 6.31 6/3516 605204
@@meminfo
MemTotal:       32768000 kB
MemFree:        12472776 kB
MemAvailable:   24576000 kB
SwapTotal:       8192000 kB
SwapFree:        6144000 kB
@@stat
cpu  1000 0 1000 7000 1000 0 0 0 0 0
cpu  1300 0 1300 7300 1100 0 0 0 0 0
@@df
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/nvme0n1p2   524288000 131072000 393216000      25% /`;

export const WORK = `@@lead
service: systemd installed, not running (/home/u/.config/systemd/user/toli-lead.service)
interactive: pid 9638
@@pane paltan:toli omp
  some earlier output
  ├─ agent line
  \u{f12b7} Waiting for 2 background jobs: A, B          \u{f1218} Session: Greet
 \u{ec19} Opus · ~/code/toli ─────────────────────────────── 16%
╰─
@@tasks
[
  {"id": "T5", "project": "alpha", "title": "Build the thing", "status": "active", "agent": "BuildT5",
   "createdAt": "2026-03-04T08:00:00.000Z", "dispatchedAt": "2026-03-04T08:30:00.000Z"},
  {"id": "T6", "project": "alpha", "title": "Next thing", "status": "queued", "createdAt": "2026-03-04T08:00:00.000Z"},
  {"id": "T7", "project": "beta", "title": "Asks", "status": "held", "createdAt": "2026-03-04T08:00:00.000Z"},
  {"id": "T8", "project": "beta", "title": "Old", "status": "done", "createdAt": "2026-03-04T08:00:00.000Z"},
  {"id": "T9", "project": "beta", "title": "Ended agent", "status": "active", "agent": "GoneT9",
   "createdAt": "2026-03-04T07:00:00.000Z"}
]
@@runs
[{"id": "j-1", "task": "T10", "project": "gamma", "status": "running", "startedAt": "2026-03-04T08:50:00.000Z"}]
@@agents
BuildT5\t{"pid": 1, "at": "2026-03-04T08:59:00.000Z"}
GoneT9\t{"pid": 1, "at": "2026-03-04T07:30:00.000Z", "endedAt": "2026-03-04T07:30:00.000Z"}
@@clones
alpha\tnightly\t3\t1772611200\t1772611200\t1772600000\t2\treport-T5.md: the push is blocked by the gate
delta\tmain\t0\t\t1772611200\t\t0\t
epsilon\tmain\t2\t\t\t\t0\t`;

export const AT = "2026-03-04T09:00:00.000Z";

const HELD = JSON.stringify([
    {
        id: "T7",
        project: "beta",
        title: "Asks",
        status: "held",
        question: "Ship the beta now?",
        options: [
            { choice: "yes", outcome: "it ships tonight" },
            { choice: "no", outcome: "it waits a week" },
        ],
        recommend: "yes",
        blocks: "the beta release",
        createdAt: "2026-03-01T08:00:00.000Z",
        heldAt: "2026-03-02T08:00:00.000Z",
        updatedAt: "2026-03-02T08:00:00.000Z",
    },
]);

const RELEASE = `@@runs
[{"id": "j-9", "task": "T44", "project": "alpha", "status": "running", "work": "release"}]
@@release alpha
fetched\t1772607600
tag\tv1.2.0\t1772546400\t5
nightly\torigin/m2/nightly\t7\t1772611200
cut\trelease/v1.3.0\t2\t1772614800`;

/** m2 answers each fleet script from these texts; m3 is unreachable. */
export function stubFleetScripts(box: Sandbox): void {
    const answers: Array<[string, string]> = [
        ["@@ncpu", LINUX_HEALTH],
        ["@@tasks", WORK],
        ["@@held", `@@held\n${HELD}`],
        ["@@sent", "@@sent lead:toli\n@@seen\n@@changed\n@@screen\nthe typed text"],
        ["@@started", "@@running lead:toli omp"],
        ["@@release", RELEASE],
        ["@@clones", WORK.slice(WORK.indexOf("@@clones"))],
    ];
    for (const [index, [, text]] of answers.entries()) writeFileSync(join(box.root, `.m2-answer-${index}`), text);
    box.stub(
        "ssh",
        [
            SSH_STUB_ARGS,
            'case "$host" in',
            '  host2) script=$(cat); case "$script" in',
            ...answers.map(([marker], index) => `    *"${marker}"*) cat "${join(box.root, `.m2-answer-${index}`)}" ;;`),
            "    *) exit 1 ;;",
            "  esac ;;",
            "  *) cat >/dev/null; echo 'ssh: connect to host host3 port 22: Connection refused' >&2; exit 255 ;;",
            "esac",
        ].join("\n"),
    );
}
