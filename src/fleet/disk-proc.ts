// Linux's /proc as the disk keeper's use probes (src/fleet/disk-scan.ts, target-use.ts) read it, so they work where
// lsof is missing: each process's working directory, executable, mapped files, open files and, for one in a
// container, its mounts. `TOLI_PROC_DIR` points it elsewhere in tests. A process that is gone, or not ours to inspect,
// simply reads as nothing.
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { procFile } from "./resources.ts";

/** Every pid in /proc but this process's. */
function pids(): string[] {
    const me = String(process.pid);
    try {
        return readdirSync(procFile("")).filter((name) => /^\d+$/.test(name) && name !== me);
    } catch {
        return [];
    }
}

/** Target of /proc/<pid>/<name>, without the kernel's ` (deleted)` suffix; null when it cannot be read. */
export function procLink(pid: string, name: string): string | null {
    try {
        return readlinkSync(procFile(`${pid}/${name}`)).replace(/ \(deleted\)$/, "");
    } catch {
        return null;
    }
}

/** The working directory of every process that can be inspected. */
export function procCwds(): { pid: string; cwd: string }[] {
    const cwds: { pid: string; cwd: string }[] = [];
    for (const pid of pids()) {
        const cwd = procLink(pid, "cwd");
        if (cwd !== null) cwds.push({ pid, cwd });
    }
    return cwds;
}

/** The files a process maps (`/proc/<pid>/maps`, as lsof lists them): the path column of each file-backed mapping. */
function mappedFiles(pid: string): string[] {
    let text: string;
    try {
        text = readFileSync(procFile(`${pid}/maps`), "utf8");
    } catch {
        return [];
    }
    const files: string[] = [];
    for (const line of text.split("\n")) {
        const path = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/.exec(line)?.[1];
        if (path !== undefined) files.push(path.replace(/ \(deleted\)$/, ""));
    }
    return files;
}

/**
 * Every file each process holds open (`fd/*`), runs (`exe`) or maps (`maps`), and its working directory, as lsof
 * lists them. Sockets, pipes and other links that are not paths are left out.
 */
export function procOpenFiles(): { path: string; pid: string }[] {
    const held: { path: string; pid: string }[] = [];
    for (const pid of pids()) {
        const files = new Set<string>(mappedFiles(pid));
        for (const name of ["cwd", "exe"]) {
            const path = procLink(pid, name);
            if (path !== null) files.add(path);
        }
        let fds: string[] = [];
        try {
            fds = readdirSync(procFile(`${pid}/fd`));
        } catch {
            // Gone, or not ours to read.
        }
        for (const fd of fds) {
            const path = procLink(pid, `fd/${fd}`);
            if (path?.startsWith("/")) files.add(path);
        }
        for (const path of files) held.push({ path, pid });
    }
    return held;
}

/** The working directory of every cargo process (`cargo`, `cargo-clippy`, `cargo-nextest`, ...: its `comm`). */
export function procCargoCwds(): { pid: string; cwd: string }[] {
    return procCwds().filter(({ pid }) => {
        try {
            return readFileSync(procFile(`${pid}/comm`), "utf8").startsWith("cargo");
        } catch {
            return false;
        }
    });
}

/**
 * A running cargo or rustc: its pid, `comm`, working directory, the CARGO_TARGET_DIR in its environment and its
 * command-line arguments (empty when they cannot be read).
 */
export type ProcBuild = { pid: string; name: string; cwd: string | null; targetDir: string | null; args: string[] };

/**
 * Every running cargo (`cargo`, `cargo-clippy`, ...) and rustc this account can inspect, with where it builds: its
 * working directory, its environment's CARGO_TARGET_DIR (/proc/<pid>/environ, as it started) and its arguments
 * (/proc/<pid>/cmdline: `--target-dir`, `--manifest-path`, rustc's `--out-dir`).
 */
export function procBuilds(): ProcBuild[] {
    const builds: ProcBuild[] = [];
    for (const pid of pids()) {
        let name: string;
        let environ: string;
        try {
            name = readFileSync(procFile(`${pid}/comm`), "utf8").trim();
            if (!name.startsWith("cargo") && name !== "rustc") continue;
            environ = readFileSync(procFile(`${pid}/environ`), "utf8");
        } catch {
            continue; // Gone, or not ours to read.
        }
        const entry = environ.split("\0").find((pair) => pair.startsWith("CARGO_TARGET_DIR="));
        const targetDir = entry === undefined ? "" : entry.slice("CARGO_TARGET_DIR=".length);
        const args = readArgs(pid);
        const cwd = procLink(pid, "cwd");
        builds.push({ pid, name, cwd, targetDir: targetDir === "" ? null : targetDir, args });
    }
    return builds;
}

/** A process's arguments from /proc/<pid>/cmdline, without the program; empty when it cannot be read. */
function readArgs(pid: string): string[] {
    try {
        return readFileSync(procFile(`${pid}/cmdline`), "utf8")
            .split("\0")
            .slice(1)
            .filter(Boolean);
    } catch {
        return [];
    }
}

/** One mount a process sees: the folder it shows at `at`, as this host's own view names it (`host`). */
export type ProcMount = { at: string; host: string };

type MountLine = { device: string; root: string; point: string };

/** A mountinfo path field, with the kernel's octal escapes (`\040` for a space, ...) decoded. */
function unescapeMount(field: string): string {
    return field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** The mounts of a /proc/<pid>/mountinfo (`id parent major:minor root mountpoint ...`); null when unreadable. */
function mountLines(file: string): MountLine[] | null {
    let text: string;
    try {
        text = readFileSync(procFile(file), "utf8");
    } catch {
        return null;
    }
    const lines: MountLine[] = [];
    for (const line of text.split("\n")) {
        const [, , device, root, point] = line.split(" ");
        if (device === undefined || root === undefined || point === undefined) continue;
        lines.push({ device, root: unescapeMount(root), point: unescapeMount(point) });
    }
    return lines;
}

/** `path` is `dir` or lies below it. */
function under(path: string, dir: string): boolean {
    return path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

/**
 * The mounts of a process in a container (its cgroup names a 64-hex container id, as docker, podman and containerd
 * do), each mapped to the path this host shows the same folder at; null when it is not in a container or its mounts
 * cannot be read. Both the cgroup and the mountinfo of a process are world-readable, even where its working directory
 * and executable are not (a non-dumpable process, a container's). A mount of a folder this host does not show is left
 * out: nothing on the host can be under it.
 */
export function containerMounts(pid: string): ProcMount[] | null {
    let cgroup: string;
    try {
        cgroup = readFileSync(procFile(`${pid}/cgroup`), "utf8");
    } catch {
        return null;
    }
    if (!/[0-9a-f]{64}/.test(cgroup)) return null;
    const inside = mountLines(`${pid}/mountinfo`);
    const host = mountLines("self/mountinfo");
    if (inside === null || host === null) return null;
    const mounts: ProcMount[] = [];
    for (const mount of inside) {
        let best: MountLine | undefined;
        for (const line of host) {
            if (line.device !== mount.device || !under(mount.root, line.root)) continue;
            if (best === undefined || line.root.length > best.root.length) best = line;
        }
        if (best !== undefined)
            mounts.push({ at: mount.point, host: join(best.point, relative(best.root, mount.root)) });
    }
    return mounts;
}
