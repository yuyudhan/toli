import { run } from "./util.ts";

/** This process and its ancestors, nearest first, from one `ps` listing; just this process when `ps` fails. */
export function ancestry(): number[] {
    const ps = run(["ps", "-A", "-o", "pid=,ppid="], { timeoutMs: 20_000 });
    const parents = new Map<number, number>();
    if (ps.code === 0)
        for (const line of ps.stdout.split("\n")) {
            const [pid, ppid] = line.trim().split(/\s+/).map(Number);
            if (pid !== undefined && ppid !== undefined && pid > 0) parents.set(pid, ppid);
        }
    const chain: number[] = [];
    for (let pid: number | undefined = process.pid; pid !== undefined && pid > 1 && !chain.includes(pid); ) {
        chain.push(pid);
        pid = parents.get(pid);
    }
    return chain;
}
