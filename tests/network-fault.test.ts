// Network faults: a run that dies on the model API's network error is requeued in the same session once the network is
// back (at most once per 10 minutes per chain), no jawan starts while the API host does not resolve, and the fleet check
// reads most machines unreachable the same way as one network fault.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commonNetworkFault, unreachableKind } from "../src/fleet/network-fault.ts";
import type { FleetEntry } from "../src/fleet/resources.ts";
import { modelApiHost, networkFault, networkRequeueAt } from "../src/jawans/network.ts";
import type { JawanRun } from "../src/jawans/runs.ts";
import { ENV, remoteSnapshot } from "./fleet-fixture.ts";
import { type Sandbox, SSH_STUB_ARGS, sandbox } from "./helpers.ts";

type Run = {
    id: string;
    status: string;
    error: string | null;
    inbox: string | null;
    startedAt: string;
    resumeOf?: string;
    resumeReason?: string;
    resumeSession?: string;
    notBefore?: string;
};

const RETRYING = "Retrying (1/3): getaddrinfo EAI_AGAIN";
const EXHAUSTED = "Retry budget exhausted after 3 retries: getaddrinfo EAI_AGAIN";

function coordinator(): Sandbox {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    const file = join(box.root, "config", "machine.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), capacity: { maxRuns: 4 } }));
    return box;
}

/**
 * An omp stand-in that logs its argv. A fresh run writes its session file and dies the way omp does when the model
 * API's name does not resolve (`host`); a resumed run (`--resume`) does too for its first `failResumes` resumes, then
 * reports.
 */
function flakyOmp(box: Sandbox, host: string, failResumes: number): string {
    const argvLog = join(box.root, ".omp-argv.log");
    const resumes = join(box.root, ".omp-resumes");
    box.stub(
        "omp",
        [
            'dir=""; resume=""; prev=""',
            'for arg in "$@"; do',
            '    case "$prev" in --session-dir) dir="$arg" ;; --resume) resume="$arg" ;; esac',
            '    prev="$arg"',
            "done",
            "cat >/dev/null",
            `printf '%s\\n' "$*" >> "${argvLog}"`,
            'if [ -n "$resume" ]; then',
            `    count=$(cat "${resumes}" 2>/dev/null || echo 0); echo $((count + 1)) > "${resumes}"`,
            `    if [ "$count" -ge ${failResumes} ]; then echo "Jane, the work is done and committed as abc123."; exit 0; fi`,
            "else",
            '    echo "{}" > "$dir/s1.jsonl"',
            "fi",
            `echo "${RETRYING} ${host}" >&2`,
            `echo "${EXHAUSTED} ${host}" >&2`,
            "exit 1",
        ].join("\n"),
    );
    return argvLog;
}

function brief(box: Sandbox, body: string): string {
    const path = join(box.root, `brief-${body}.md`);
    writeFileSync(path, `TOLI_BRIEF v1\n${body}\n`);
    return path;
}

function spawnJson(box: Sandbox, body: string): Run {
    return JSON.parse(
        box.ok(["spawn", "--harness", "omp", "--cwd", box.root, "--brief", brief(box, body), "--json"]),
    ) as Run;
}

function runs(box: Sandbox): Run[] {
    return JSON.parse(box.ok(["runs", "--json"])) as Run[];
}

/** Poll until `done` holds; supervisors and harnesses are detached processes, so real time is unavoidable. */
async function waitForRuns(box: Sandbox, done: (all: Run[]) => boolean): Promise<Run[]> {
    for (let attempt = 0; attempt < 300; attempt++) {
        const all = runs(box);
        if (done(all)) return all;
        await Bun.sleep(100);
    }
    throw new Error(`runs never reached the expected state: ${box.ok(["runs"])}`);
}

function networkLog(box: Sandbox): string[] {
    const path = join(box.root, "logs", "network.log");
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
}

describe("a run that ends on a network fault", () => {
    test("names the fault and its host from the harness's last lines, never from earlier work or a clean exit", () => {
        const output = `Warning: x\nsome work hit ECONNRESET in a test\nreport line\n${RETRYING} api.anthropic.com\n${EXHAUSTED} api.anthropic.com\n`;
        expect(networkFault(output, 1)).toEqual({
            code: "EAI_AGAIN",
            host: "api.anthropic.com",
            line: `${EXHAUSTED} api.anthropic.com`,
        });
        // Bun names no host: the model's provider does.
        expect(
            networkFault("Retry budget exhausted after 3 retries: DNSException: getaddrinfo DNS_ENOTFOUND", 1),
        ).toEqual(expect.objectContaining({ code: "ENOTFOUND", host: null }));
        expect(networkFault("fetch https://api.openai.com/v1/responses failed: ECONNRESET", 1)?.host).toBe(
            "api.openai.com",
        );
        expect(networkFault(output, 0)).toBeNull();
        expect(networkFault("a test hit ECONNRESET\nthen\nthe jawan\nwrote its report", 1)).toBeNull();
        expect(modelApiHost("omp", "claude-sonnet-5-5")).toBe("api.anthropic.com");
        expect(modelApiHost("omp", "openai/gpt-5")).toBe("api.openai.com");
        expect(modelApiHost("codex", null)).toBe("api.openai.com");
        expect(modelApiHost("pi", null)).toBeNull();
    });

    test("a chain requeued for a network fault less than 10 minutes ago waits out the rest", () => {
        const at = new Date("2026-11-20T16:20:00.000Z");
        const run = { startedAt: "2026-11-20T16:15:00.000Z", resumeReason: "network fault" } as JawanRun;
        expect(networkRequeueAt(run, at)).toBe("2026-11-20T16:25:00.000Z");
        expect(networkRequeueAt({ ...run, startedAt: "2026-11-20T16:05:00.000Z" }, at)).toBeUndefined();
        expect(networkRequeueAt({ ...run, resumeReason: "stalled" }, at)).toBeUndefined();
    });

    test("while the API host does not resolve it stays queued with every new jawan, one line says why; then it resumes in the same session", async () => {
        const box = coordinator();
        const argvLog = flakyOmp(box, "api.example.invalid", 0);
        const first = spawnJson(box, "first");
        const [continuation] = await waitForRuns(
            box,
            (all) => all.length === 2 && all.some((run) => run.id === first.id && run.inbox !== null),
        );
        const failed = runs(box).find((run) => run.id === first.id);
        expect(failed?.status).toBe("failed");
        expect(failed?.error).toBe(`network fault: ${EXHAUSTED} api.example.invalid`);
        expect(continuation?.status).toBe("queued");
        expect(continuation?.resumeOf).toBe(first.id);
        expect(continuation?.resumeReason).toBe("network fault");
        expect(continuation?.resumeSession).toEndWith("s1.jsonl");

        // No new jawan starts meanwhile, and the hold is logged once, not once per start.
        const text = box.ok(["spawn", "--harness", "omp", "--cwd", box.root, "--brief", brief(box, "second")]);
        expect(text).toStartWith("queued ");
        expect(text).toContain("the model API host api.example.invalid does not resolve; it starts once it does");
        expect(spawnJson(box, "third").status).toBe("queued");
        box.ok(["job", "tick"]);
        expect(runs(box).filter((run) => run.status === "queued")).toHaveLength(3);
        const held = networkLog(box);
        expect(held).toHaveLength(1);
        expect(held[0]).toContain(
            "jawan starts held: the model API host api.example.invalid does not resolve (EAI_AGAIN since ",
        );

        // The network is back: the recorded host resolves now.
        const faultPath = join(box.root, "state", "network-fault.json");
        writeFileSync(faultPath, JSON.stringify({ ...JSON.parse(readFileSync(faultPath, "utf8")), host: "localhost" }));
        flakyOmp(box, "localhost", 0);
        box.ok(["job", "tick"]);
        // The continuation resumes; the two held fresh runs start, die on the (now resolving) host and resume at once.
        const all = await waitForRuns(box, (list) => list.length === 6 && list.every((run) => run.inbox !== null));
        expect(all.find((run) => run.id === continuation?.id)?.status).toBe("done");
        expect(all.filter((run) => run.status === "done")).toHaveLength(3);
        expect(readFileSync(argvLog, "utf8")).toContain(`--resume ${continuation?.resumeSession}`);
        expect(networkLog(box)).toHaveLength(2);
        expect(networkLog(box)[1]).toContain("localhost resolves again: jawan starts held since ");
        expect(existsSync(faultPath)).toBe(false);
    }, 60_000);

    test("once the host resolves it is resumed at once, and a chain is requeued for it at most once per 10 minutes", async () => {
        const box = coordinator();
        const argvLog = flakyOmp(box, "localhost", 1);
        const first = spawnJson(box, "first");
        // The first requeue starts at once; it fails the same way, and the next waits 10 minutes from its start.
        const [third, second] = await waitForRuns(
            box,
            (all) => all.length === 3 && all.filter((run) => run.inbox !== null).length === 2,
        );
        expect(second?.resumeOf).toBe(first.id);
        expect(second?.status).toBe("failed");
        expect(third?.resumeOf).toBe(second?.id);
        expect(third?.status).toBe("queued");
        expect(third?.notBefore).toBe(new Date(Date.parse(second?.startedAt ?? "") + 10 * 60_000).toISOString());
        box.ok(["job", "tick"]);
        expect(runs(box).find((run) => run.id === third?.id)?.status).toBe("queued");

        box.ok(["job", "tick"], { now: new Date(Date.parse(third?.notBefore ?? "") + 60_000).toISOString() });
        const all = await waitForRuns(box, (list) => list.every((run) => run.inbox !== null));
        expect(all.find((run) => run.id === third?.id)?.status).toBe("done");
        expect(readFileSync(argvLog, "utf8").match(/--resume /g)).toHaveLength(2);
        expect(networkLog(box)).toEqual([]);
    }, 60_000);
});

function entry(machine: string, reason: string | null): FleetEntry {
    return {
        machine,
        local: false,
        reachable: reason === null,
        available: reason === null,
        reasons: reason === null ? [] : [reason],
        resources: null,
    };
}

describe("the fleet check under a network fault", () => {
    test("most machines unreachable the same way are one network fault; a minority keeps its own lines", () => {
        expect(
            unreachableKind(
                "unreachable: ssh host3 exited 255: ssh: Could not resolve hostname host3: Temporary failure in name resolution",
            ),
        ).toBe("names do not resolve");
        expect(unreachableKind("unreachable: no route / host down (ssh u@h exited 255: Connection timed out)")).toBe(
            "no route or timed out",
        );
        expect(unreachableKind("unreachable: pull-only, not probed")).toBeNull();
        const local = { ...entry("m1", null), local: true };
        const dns = (name: string): FleetEntry =>
            entry(
                name,
                `unreachable: ssh ${name} exited 255: ssh: Could not resolve hostname ${name}: Temporary failure in name resolution`,
            );
        expect(commonNetworkFault([local, dns("m2"), dns("m3"), entry("m4", null)])).toEqual({
            kind: "names do not resolve",
            machines: ["m2", "m3"],
            of: 3,
        });
        expect(commonNetworkFault([local, dns("m2"), entry("m3", null), entry("m4", null)])).toBeNull();
        expect(commonNetworkFault([local, dns("m2"), entry("m3", null)])).toBeNull();
    });

    test("fleet check prints one network fault line instead of one line per host", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        const machines = ["m1", "m2", "far1", "far2", "far3"].map((name, index) => ({
            name,
            ssh: `host${index + 1}`,
            root: "/srv/toli",
        }));
        writeFileSync(join(box.root, "config", "fleet.json"), JSON.stringify({ machines }));
        writeFileSync(join(box.root, ".m2.json"), remoteSnapshot("m2"));
        writeFileSync(
            join(box.root, ".m2-check.json"),
            JSON.stringify({ machine: "m2", stale: [], waiting: [], listener: null }),
        );
        box.stub(
            "ssh",
            [
                SSH_STUB_ARGS,
                'case "$host" in',
                `  host2) case "$cmd" in *"resources --json"*) cat "${join(box.root, ".m2.json")}" ;; *"fleet check --local --json"*) cat "${join(box.root, ".m2-check.json")}" ;; *) exit 1 ;; esac ;;`,
                '  *) echo "ssh: Could not resolve hostname $host: Temporary failure in name resolution" >&2; exit 255 ;;',
                "esac",
            ].join("\n"),
        );
        const output = box.ok(["fleet", "check"], { env: ENV });
        expect(output).toContain(
            "network fault: 3 of 4 other machines unreachable the same way (names do not resolve): far1, far2, far3",
        );
        expect(output).not.toContain("far1 (unreachable");
        expect(output).not.toContain("Could not resolve hostname host3");
    });
});
