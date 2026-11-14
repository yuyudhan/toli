import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseStackDeclaration } from "../src/fleet/stack-pause.ts";
import { holdSlot, slotBox, start, toliArgs } from "./build-slot-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";

const NOTES = [
    "# app",
    "",
    "## Local stack",
    "- Start: `docker compose up -d`",
    "- Pause during builds: app-watch, `app-web`",
    "",
    "## URLs",
    "- Pause during builds: not-in-the-stack-section",
].join("\n");

/**
 * A `docker` stub with a container state folder (one file per container holding its status) that logs every call.
 * `unpause` fails while `<state>/.unpause-fails` exists, as a daemon that went away would.
 */
function dockerBox(slots: number, names: string[]): { box: Sandbox; log: string; cargoLog: string; state: string } {
    const { box, log: cargoLog } = slotBox(slots, 3);
    const state = join(box.root, ".docker-state");
    mkdirSync(state);
    for (const name of names) writeFileSync(join(state, name), "running");
    const log = join(box.root, ".docker-log");
    box.stub(
        "docker",
        [
            `echo "$*" >> "${log}"`,
            'case "$1" in',
            `    inspect) [ -f "${state}/$4" ] || { echo "Error: No such object: $4" >&2; exit 1; }; cat "${state}/$4" ;;`,
            `    pause) echo paused > "${state}/$2" ;;`,
            `    unpause) [ -e "${state}/.unpause-fails" ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }`,
            `        echo running > "${state}/$2" ;;`,
            `    stop) echo exited > "${state}/$2" ;;`,
            `    start) echo running > "${state}/$2" ;;`,
            "esac",
        ].join("\n"),
    );
    return { box, log, cargoLog, state };
}

// Not named `declare`: Bun 1.3 parses a statement `declare(...)` as a TypeScript `declare` and drops the call.
function declareStack(box: Sandbox, project: string): void {
    withProject(box, project);
    mkdirSync(join(box.root, "data", "projects", project), { recursive: true });
    writeFileSync(join(box.root, "data", "projects", project, "notes.md"), NOTES);
}

const status = (state: string, name: string): string => readFileSync(join(state, name), "utf8").trim();
const dockerCalls = (log: string): string[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

describe("a project's declared dev-stack containers", () => {
    test("are read from the Local stack section only, names cleaned of backticks and commas", () => {
        expect(parseStackDeclaration(NOTES)).toEqual({ containers: ["app-watch", "app-web"], stop: [], invalid: [] });
        expect(parseStackDeclaration("## Local stack\n- Pause during builds: a b;c, a\n")).toEqual({
            containers: ["a"],
            stop: [],
            invalid: ["b;c"],
        });
        expect(
            parseStackDeclaration("## Local stack\n- Stop during builds: `a`, b\n- Pause during builds: b, c\n"),
        ).toEqual({ containers: ["c"], stop: ["a", "b"], invalid: [] });
    });

    test("are paused while a build holds a slot and unpaused after, databases and others untouched", async () => {
        const { box, log, state } = dockerBox(1, ["app-watch", "app-web", "app-db"]);
        declareStack(box, "app");
        const seen = join(box.root, ".seen");
        const built = await start(
            box,
            toliArgs("build-slot", "--", "sh", "-c", `cat "${state}/app-watch" "${state}/app-web" > "${seen}"`),
        ).done;
        expect(built.code).toBe(0);
        expect(readFileSync(seen, "utf8")).toBe("paused\npaused\n");
        expect([status(state, "app-watch"), status(state, "app-web"), status(state, "app-db")]).toEqual([
            "running",
            "running",
            "running",
        ]);
        expect(dockerCalls(log).filter((call) => call.includes("app-db"))).toEqual([]);
        expect(dockerCalls(log).filter((call) => /^(stop|rm|kill)\b/.test(call))).toEqual([]);
    }, 30_000);

    test("stay paused until the last of several builds frees its slot", async () => {
        const { box, cargoLog, state } = dockerBox(2, ["app-watch"]);
        declareStack(box, "app");
        const holder = await holdSlot(box, cargoLog);
        const quick = await start(box, toliArgs("build-slot", "--", "true")).done;
        expect(quick.code).toBe(0);
        expect(status(state, "app-watch")).toBe("paused");
        writeFileSync(`${cargoLog}.done-a`, "");
        expect((await holder.done).code).toBe(0);
        expect(status(state, "app-watch")).toBe("running");
    }, 30_000);

    test("a failed unpause is reported with the fix and retried at the next idle moment", async () => {
        const { box, state } = dockerBox(1, ["app-watch"]);
        declareStack(box, "app");
        writeFileSync(join(state, ".unpause-fails"), "");
        const failed = await start(box, toliArgs("build-slot", "--", "true")).done;
        expect(failed.code).toBe(0);
        expect(failed.stderr).toContain("could not unpause app-watch");
        expect(failed.stderr).toContain("docker unpause app-watch");
        expect(status(state, "app-watch")).toBe("paused");
        rmSync(join(state, ".unpause-fails"));
        const retried = await start(box, toliArgs("build-slot", "--", "true")).done;
        expect(retried.code).toBe(0);
        expect(status(state, "app-watch")).toBe("running");
    }, 30_000);

    test("declared `Stop during builds` are stopped while a build holds a slot and started after", async () => {
        const { box, log, state } = dockerBox(1, ["app-watch", "app-db"]);
        withProject(box, "app");
        mkdirSync(join(box.root, "data", "projects", "app"), { recursive: true });
        writeFileSync(
            join(box.root, "data", "projects", "app", "notes.md"),
            "# app\n\n## Local stack\n- Stop during builds: app-watch\n",
        );
        const seen = join(box.root, ".seen");
        const built = await start(box, toliArgs("build-slot", "--", "sh", "-c", `cat "${state}/app-watch" > "${seen}"`))
            .done;
        expect(built.code).toBe(0);
        expect(readFileSync(seen, "utf8")).toBe("exited\n");
        expect([status(state, "app-watch"), status(state, "app-db")]).toEqual(["running", "running"]);
        expect(dockerCalls(log).filter((call) => !call.startsWith("inspect"))).toEqual([
            "stop app-watch",
            "start app-watch",
        ]);
        expect(dockerCalls(log).filter((call) => call.includes("app-db"))).toEqual([]);
    }, 30_000);

    test("of a live-stack project are paused by any build too, through its live-stack record", async () => {
        const { box, state } = dockerBox(1, ["app-watch"]);
        declareStack(box, "app");
        box.ok(["project", "set", "app", "--live-stack", "yes"]);
        const seen = join(box.root, ".seen");
        const built = await start(box, toliArgs("build-slot", "--", "sh", "-c", `cat "${state}/app-watch" > "${seen}"`))
            .done;
        expect(built.code).toBe(0);
        expect(readFileSync(seen, "utf8")).toBe("paused\n");
        expect(status(state, "app-watch")).toBe("running");
        expect(existsSync(join(box.root, "state", "build-slots", "stacks.paused"))).toBe(false);
        expect(existsSync(join(box.root, "state", "build-slots", "live-app.json"))).toBe(false);
    }, 30_000);
});
