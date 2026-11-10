import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, SSH_STUB_ARGS, sandbox } from "./helpers.ts";

type FleetFile = { machines: { name: string; ssh: string; root: string }[] };

function fleetOf(box: Sandbox): FleetFile {
    return JSON.parse(readFileSync(join(box.root, "config", "fleet.json"), "utf8")) as FleetFile;
}

/** The coordinator's `fleet export`, as worker w1's ssh stub answers it. */
const EXPORT = {
    coordinator: "m1",
    machines: [
        { name: "m1", ssh: "m1", root: "/srv/coord" },
        { name: "w1", ssh: "kalki@w1.example", root: "/srv/w1" },
        { name: "w2", ssh: "kalki@w2.example", root: "/srv/w2" },
        { name: "w3", ssh: "kalki@w3.example", root: "/srv/w3" },
    ],
};

/** Worker w1 (coordinator m1 at ssh `coord`), listing itself, m1, w2 by its own alias, and a machine m1 dropped. */
function worker(): Sandbox {
    const box = sandbox();
    box.ok([
        "init",
        "--name",
        "w1",
        "--role",
        "worker",
        "--coordinator-ssh",
        "coord",
        "--coordinator-root",
        "/srv/coord",
    ]);
    writeFileSync(
        join(box.root, "config", "fleet.json"),
        JSON.stringify({
            machines: [
                { name: "m1", ssh: "old-coord", root: "/srv/old" },
                { name: "w1", ssh: "w1", root: box.root },
                { name: "w2", ssh: "w2-alias", root: "/srv/w2" },
                { name: "gone", ssh: "gone", root: "/srv/gone" },
            ],
        }),
    );
    const exported = join(box.root, ".export.json");
    writeFileSync(exported, JSON.stringify(EXPORT));
    box.stub(
        "ssh",
        [
            `if [ -e "${box.root}/.coord-down" ]; then echo "ssh: connect to host coord: Connection refused" >&2; exit 255; fi`,
            SSH_STUB_ARGS,
            `case "$cmd" in *"fleet export"*) cat "${exported}" ;; *) exit 1 ;; esac`,
        ].join("\n"),
    );
    return box;
}

describe("config/fleet.json comes from the coordinator", () => {
    test("fleet sync takes the coordinator's machines, keeping this worker's own ssh names", () => {
        const box = worker();
        expect(box.ok(["fleet", "sync"])).toBe(
            "fleet: config/fleet.json updated from the coordinator (4 machines; added w3; removed gone)",
        );
        expect(fleetOf(box).machines).toEqual([
            { name: "m1", ssh: "coord", root: "/srv/coord" },
            { name: "w1", ssh: "w1", root: box.root },
            { name: "w2", ssh: "w2-alias", root: "/srv/w2" },
            { name: "w3", ssh: "kalki@w3.example", root: "/srv/w3" },
        ]);
        expect(box.ok(["fleet", "sync"])).toBe("fleet: config/fleet.json already matches the coordinator (4 machines)");
    });

    test("an unreachable coordinator leaves the list as it is and says why", () => {
        const box = worker();
        writeFileSync(join(box.root, ".coord-down"), "1");
        const before = fleetOf(box);
        expect(box.toli(["fleet", "sync"]).stderr).toContain(
            "could not read the coordinator's fleet list (ssh coord exited 255)",
        );
        expect(fleetOf(box)).toEqual(before);
    });

    test("the coordinator exports each machine as user@host from its ssh config", () => {
        const box = sandbox();
        box.ok(["init", "--name", "m1", "--role", "coordinator"]);
        writeFileSync(
            join(box.root, "config", "fleet.json"),
            JSON.stringify({
                machines: [
                    { name: "m1", ssh: "m1", root: "/srv/coord" },
                    { name: "w1", ssh: "w1", root: "/srv/w1" },
                    { name: "w2", ssh: "w2", root: "/srv/w2" },
                ],
            }),
        );
        box.stub(
            "ssh",
            [
                'if [ "$1" = -G ]; then',
                '  case "$2" in',
                '    w1) printf "user kalki\\nhostname w1.example\\nport 22\\n" ;;',
                '    *) printf "user ankur\\nhostname $2.example\\nport 2222\\n" ;;',
                "  esac; exit 0",
                "fi",
                "exit 1",
            ].join("\n"),
        );
        expect(JSON.parse(box.ok(["fleet", "export"]))).toEqual({
            coordinator: "m1",
            machines: [
                { name: "m1", ssh: "m1", root: "/srv/coord" },
                { name: "w1", ssh: "kalki@w1.example", root: "/srv/w1" },
                { name: "w2", ssh: "ssh://ankur@w2.example:2222", root: "/srv/w2" },
            ],
        });
        expect(box.ok(["fleet", "sync"])).toBe(
            "fleet: this machine is the coordinator; its config/fleet.json is the list",
        );
    });
});
