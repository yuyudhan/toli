import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Sandbox, sandbox, withProject } from "./helpers.ts";

export type GateRecord = {
    project: string;
    sha: string;
    tree: string;
    proof?: string;
    recipe: string;
    status: string;
    pid: number | null;
    startedAt: string;
    endedAt: string | null;
    lastOutputAt: string | null;
    exitCode: number | null;
    log: string;
    reason?: string;
};

/** A coordinator with project "app"; returns the clone. */
export function setup(): { box: Sandbox; dir: string } {
    const box = sandbox();
    box.ok(["init", "--name", "mini", "--role", "coordinator"]);
    return { box, dir: withProject(box, "app") };
}

/** A recipe script outside the clone (so the worktree stays clean) that counts its runs in `<root>/count`. */
export function recipe(box: Sandbox, name: string, body: string): string {
    const file = join(box.root, `${name}.sh`);
    writeFileSync(file, `echo run >> "${join(box.root, "count")}"\n${body}\n`);
    return `sh ${file}`;
}

export function runs(box: Sandbox): number {
    const file = join(box.root, "count");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").length : 0;
}

export function commitFile(box: Sandbox, dir: string, name: string): string {
    writeFileSync(join(dir, name), `${name}\n`);
    box.git(dir, ["add", name]);
    box.git(dir, ["commit", "-m", `add ${name}`]);
    return box.git(dir, ["rev-parse", "HEAD"]);
}

export function records(box: Sandbox): GateRecord[] {
    const dir = join(box.root, "state", "gates", "app");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as GateRecord);
}

export function gatesLog(box: Sandbox): string {
    const file = join(box.root, "logs", "gates.log");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
}
