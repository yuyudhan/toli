import { expect, test } from "bun:test";
import { join } from "node:path";

const UTIL = join(import.meta.dir, "..", "src", "util.ts");

test("a reader closing stdout early (toli ... | head) ends the run quietly", async () => {
    // Far more than a pipe buffer, so writes keep going after the reader is gone.
    const script = `import { out } from ${JSON.stringify(UTIL)};
for (let i = 0; i < 20000; i++) out("line " + i + " ".padEnd(80, "x"));
process.stderr.write("finished\\n");`;
    const command = `set -o pipefail; "${process.execPath}" -e '${script.replaceAll("'", "'\\''")}' | head -1`;
    const child = Bun.spawn(["bash", "-c", command], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    expect(stdout).toStartWith("line 0 ");
    expect(stderr).toBe("finished\n");
    expect(code).toBe(0);
});
