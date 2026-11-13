import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Started, slotBox, start, toliArgs, until } from "./build-slot-fixture.ts";
import { type Sandbox, withProject } from "./helpers.ts";

/** A live-stack project `app` whose notes declare `notes`, beside a `docker` stub that keeps container states. */
function liveBox(notes: (stackLog: string) => string): {
    box: Sandbox;
    checkout: string;
    stackLog: string;
    dockerLog: string;
    state: string;
} {
    const { box } = slotBox(1, 3);
    const state = join(box.root, ".docker-state");
    mkdirSync(state);
    for (const name of ["app-watch", "app-db"]) writeFileSync(join(state, name), "running");
    const dockerLog = join(box.root, ".docker-log");
    box.stub(
        "docker",
        [
            `echo "$*" >> "${dockerLog}"`,
            'case "$1" in',
            `    inspect) [ -f "${state}/$4" ] || { echo "Error: No such object: $4" >&2; exit 1; }; cat "${state}/$4" ;;`,
            `    pause) echo paused > "${state}/$2" ;;`,
            `    unpause) echo running > "${state}/$2" ;;`,
            "esac",
        ].join("\n"),
    );
    const checkout = withProject(box, "app");
    box.ok(["project", "set", "app", "--live-stack", "yes"]);
    const stackLog = join(box.root, ".stack-log");
    mkdirSync(join(box.root, "data", "projects", "app"), { recursive: true });
    writeFileSync(join(box.root, "data", "projects", "app", "notes.md"), notes(stackLog));
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
