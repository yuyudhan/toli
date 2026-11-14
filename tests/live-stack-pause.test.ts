import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Started, slotBox, start, toliArgs, until } from "./build-slot-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";

/** A `docker` stub that keeps container states in `state` (one file per container) and logs every call to `log`. */
function dockerStub(box: Sandbox, state: string, log: string): void {
    box.stub(
        "docker",
        [
            `echo "$*" >> "${log}"`,
            'case "$1" in',
            `    inspect) [ -f "${state}/$4" ] || { echo "Error: No such object: $4" >&2; exit 1; }; cat "${state}/$4" ;;`,
            `    pause) echo paused > "${state}/$2" ;;`,
            `    unpause) echo running > "${state}/$2" ;;`,
            `    stop) echo exited > "${state}/$2" ;;`,
            `    start) echo running > "${state}/$2" ;;`,
            "esac",
        ].join("\n"),
    );
}

/** Register live-stack project `name` with `notes`; returns its checkout. */
function liveProject(box: Sandbox, name: string, notes: string): string {
    const checkout = withProject(box, name);
    box.ok(["project", "set", name, "--live-stack", "yes"]);
    mkdirSync(join(box.root, "data", "projects", name), { recursive: true });
    writeFileSync(join(box.root, "data", "projects", name, "notes.md"), notes);
    return checkout;
}

/**
 * A live-stack project `app` whose notes declare `notes`, beside a `docker` stub that keeps container states, on a
 * machine of two build slots.
 */
function liveBox(notes: (stackLog: string) => string): {
    box: Sandbox;
    checkout: string;
    stackLog: string;
    dockerLog: string;
    state: string;
} {
    const { box } = slotBox(2, 3);
    const state = join(box.root, ".docker-state");
    mkdirSync(state);
    for (const name of ["app-watch", "app-db", "web-watch"]) writeFileSync(join(state, name), "running");
    const dockerLog = join(box.root, ".docker-log");
    dockerStub(box, state, dockerLog);
    const stackLog = join(box.root, ".stack-log");
    const checkout = liveProject(box, "app", notes(stackLog));
    return { box, checkout, stackLog, dockerLog, state };
}

const DECLARED = (stackLog: string): string =>
    [
        "# app",
        "",
        "## Live stack mode",
        "- Start: `docker compose up -d`",
        `- Pause: \`echo pause >> ${stackLog}\``,
        `- Resume: \`echo resume >> ${stackLog}\``,
        "",
        "## Local stack",
        "- Pause during builds: app-watch",
        "",
    ].join("\n");

// A container named on both lines is stopped: stopping frees its memory, pausing keeps it.
const STOP_NOTES = [
    "# app",
    "",
    "## Local stack",
    "- Stop during builds: app-watch",
    "- Pause during builds: app-watch",
    "",
].join("\n");

const lines = (file: string): string[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : []);
const status = (state: string, name: string): string => readFileSync(join(state, name), "utf8").trim();

/** Start a build in the checkout that runs until `<box>/.release-<label>` exists, and wait until its command runs. */
async function holdBuild(box: Sandbox, checkout: string, label: string): Promise<Started> {
    const started = join(box.root, `.started-${label}`);
    const release = join(box.root, `.release-${label}`);
    const build = start(
        box,
        toliArgs("build-slot", "--", "sh", "-c", `touch "${started}"; while [ ! -e "${release}" ]; do sleep 0.1; done`),
        {},
        checkout,
    );
    await until(`build ${label} running`, () => existsSync(started));
    return build;
}

describe("a live-stack project's stack while a build runs in its checkout", () => {
    test("is paused when the build starts and resumed when it ends, databases untouched", async () => {
        const { box, checkout, stackLog, dockerLog, state } = liveBox(DECLARED);
        const seen = join(box.root, ".seen");
        const built = await start(
            box,
            toliArgs("build-slot", "--", "sh", "-c", `cat "${stackLog}" "${state}/app-watch" > "${seen}"`),
            {},
            checkout,
        ).done;
        expect(built.code).toBe(0);
        expect(readFileSync(seen, "utf8")).toBe("pause\npaused\n");
        expect(lines(stackLog)).toEqual(["pause", "resume"]);
        expect([status(state, "app-watch"), status(state, "app-db")]).toEqual(["running", "running"]);
        expect(lines(dockerLog).filter((call) => call.includes("app-db"))).toEqual([]);
    }, 30_000);

    test("is resumed when the build fails", async () => {
        const { box, checkout, stackLog, state } = liveBox(DECLARED);
        const failed = await start(box, toliArgs("build-slot", "--", "sh", "-c", "exit 3"), {}, checkout).done;
        expect(failed.code).toBe(3);
        expect(lines(stackLog)).toEqual(["pause", "resume"]);
        expect(status(state, "app-watch")).toBe("running");
    }, 30_000);

    test("is resumed when the build is killed", async () => {
        const { box, checkout, stackLog, state } = liveBox(DECLARED);
        const build = await holdBuild(box, checkout, "a");
        expect(status(state, "app-watch")).toBe("paused");
        build.proc.kill("SIGTERM");
        writeFileSync(join(box.root, ".release-a"), "");
        await build.done;
        expect(lines(stackLog)).toEqual(["pause", "resume"]);
        expect(status(state, "app-watch")).toBe("running");
    }, 30_000);

    test("stays paused until the last of several builds ends, paused and resumed once", async () => {
        const { box, checkout, stackLog, state } = liveBox(DECLARED);
        const first = await holdBuild(box, checkout, "a");
        const quick = await start(box, toliArgs("build-slot", "--", "true"), {}, checkout).done;
        expect(quick.code).toBe(0);
        expect(lines(stackLog)).toEqual(["pause"]);
        expect(status(state, "app-watch")).toBe("paused");
        writeFileSync(join(box.root, ".release-a"), "");
        expect((await first.done).code).toBe(0);
        expect(lines(stackLog)).toEqual(["pause", "resume"]);
        expect(status(state, "app-watch")).toBe("running");
    }, 30_000);

    test("with nothing declared is left alone, said once", async () => {
        const { box, checkout, dockerLog } = liveBox(() => "# app\n\n## Live stack mode\n- Start: `make up`\n");
        const first = await start(box, toliArgs("build-slot", "--", "true"), {}, checkout).done;
        const second = await start(box, toliArgs("build-slot", "--", "true"), {}, checkout).done;
        expect([first.code, second.code]).toEqual([0, 0]);
        expect(first.stderr).toContain("app: live-stack mode, but its notes declare no way to pause its stack");
        expect(second.stderr).not.toContain("declare no way to pause");
        expect(lines(dockerLog)).toEqual([]);
    }, 30_000);

    test("left paused by a holder that was killed outright is resumed by the next tick", async () => {
        const { box, checkout, stackLog, state } = liveBox(DECLARED);
        const build = await holdBuild(box, checkout, "a");
        build.proc.kill("SIGKILL");
        writeFileSync(join(box.root, ".release-a"), "");
        await build.done;
        expect(lines(stackLog)).toEqual(["pause"]);
        expect(status(state, "app-watch")).toBe("paused");
        box.ok(["job", "tick"]);
        expect(lines(stackLog)).toEqual(["pause", "resume"]);
        expect(status(state, "app-watch")).toBe("running");
    }, 30_000);
});

describe("every live-stack project's stack while any heavy build runs on the machine", () => {
    test("declared `Stop during builds` is stopped, not paused, and started again; databases untouched", async () => {
        const { box, checkout, dockerLog, state } = liveBox(() => STOP_NOTES);
        const seen = join(box.root, ".seen");
        const built = await start(
            box,
            toliArgs("build-slot", "--", "sh", "-c", `cat "${state}/app-watch" > "${seen}"`),
            {},
            checkout,
        ).done;
        expect(built.code).toBe(0);
        expect(readFileSync(seen, "utf8")).toBe("exited\n");
        expect([status(state, "app-watch"), status(state, "app-db")]).toEqual(["running", "running"]);
        const calls = lines(dockerLog).filter((call) => !call.startsWith("inspect"));
        expect(calls).toEqual(["stop app-watch", "start app-watch"]);
        expect(lines(dockerLog).filter((call) => call.includes("app-db"))).toEqual([]);
    }, 30_000);

    test("is paused while another project's builds hold slots, and resumed once when the last ends", async () => {
        const { box, stackLog, dockerLog, state } = liveBox(DECLARED);
        const other = withProject(box, "other");
        const first = await holdBuild(box, other, "a");
        expect(lines(stackLog)).toEqual(["pause"]);
        expect(status(state, "app-watch")).toBe("paused");
        const quick = await start(box, toliArgs("build-slot", "--", "true"), {}, other).done;
        expect(quick.code).toBe(0);
        expect(lines(stackLog)).toEqual(["pause"]);
        expect(status(state, "app-watch")).toBe("paused");
        writeFileSync(join(box.root, ".release-a"), "");
        expect((await first.done).code).toBe(0);
        expect(lines(stackLog)).toEqual(["pause", "resume"]);
        expect([status(state, "app-watch"), status(state, "app-db")]).toEqual(["running", "running"]);
        expect(lines(dockerLog).filter((call) => call.includes("app-db"))).toEqual([]);
    }, 30_000);

    test("a build in one live-stack checkout pauses every other live-stack project's stack too", async () => {
        const { box, checkout, stackLog, state } = liveBox(DECLARED);
        liveProject(box, "web", "# web\n\n## Local stack\n- Pause during builds: web-watch\n");
        const seen = join(box.root, ".seen");
        const built = await start(
            box,
            toliArgs("build-slot", "--", "sh", "-c", `cat "${state}/app-watch" "${state}/web-watch" > "${seen}"`),
            {},
            checkout,
        ).done;
        expect(built.code).toBe(0);
        expect(readFileSync(seen, "utf8")).toBe("paused\npaused\n");
        expect(lines(stackLog)).toEqual(["pause", "resume"]);
        expect([status(state, "app-watch"), status(state, "web-watch")]).toEqual(["running", "running"]);
    }, 30_000);
});
