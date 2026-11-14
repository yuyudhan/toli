// Linux's /proc as the disk keeper's use probes (src/fleet/disk-scan.ts) read it, so they work where lsof is missing:
// each process's working directory, executable, mapped files and open files. `TOLI_PROC_DIR` points it elsewhere in
// tests. A process that is gone, or not ours to inspect, simply reads as nothing.
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
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

/** A running cargo or rustc: its pid, `comm`, working directory and the CARGO_TARGET_DIR in its environment. */
export type ProcBuild = { pid: string; name: string; cwd: string | null; targetDir: string | null };

/**
 * Every running cargo (`cargo`, `cargo-clippy`, ...) and rustc this account can inspect, with where it builds: its
 * working directory and its environment's CARGO_TARGET_DIR (/proc/<pid>/environ, as it started).
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
        builds.push({ pid, name, cwd: procLink(pid, "cwd"), targetDir: targetDir === "" ? null : targetDir });
    }
    return builds;
}
