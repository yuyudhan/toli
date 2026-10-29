// Runs every rule in scripts/guard/*.ts (globbed, so adding a file registers it), numbers each
// `[n/N] name`, keeps going past failures, and exits 1 with a tally if any rule failed.
// Scope: see scripts/guard-lib.ts (TOLI_GUARD_HOOK=1, TOLI_GUARD_RANGE=A..B, or the full tree).
import { collectScope, type Guard, ROOT, type Scope } from "./guard-lib.ts";

function isGuard(value: unknown): value is Guard {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.name === "string" && typeof candidate.run === "function";
}

const out = (line: string) => process.stdout.write(`${line}\n`);

let scope: Scope;
try {
    scope = collectScope();
} catch (error) {
    out(`guard: cannot list files to scan: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
out(`guard: ${scope.description}`);
for (const note of scope.notes) out(`guard: note: ${note}`);
if (scope.files.length === 0 && !scope.allowEmpty) {
    out("guard: no files to scan; refusing to pass vacuously");
    process.exit(1);
}

const modules = [...new Bun.Glob("scripts/guard/*.ts").scanSync({ cwd: ROOT })].sort();
if (modules.length === 0) {
    out("guard: no guards found in scripts/guard/");
    process.exit(1);
}

let failed = 0;
for (const [index, module] of modules.entries()) {
    const label = `[${index + 1}/${modules.length}]`;
    try {
        // Dynamic import is the point: rules are discovered by glob, so there is no static list.
        const loaded: unknown = (await import(`${ROOT}${module}`)).default;
        if (!isGuard(loaded)) throw new Error(`${module} must default-export { name, run(files) }`);
        const violations = loaded.run(scope.files);
        if (violations.length === 0) {
            out(`${label} ${loaded.name}: OK`);
            continue;
        }
        failed += 1;
        out(`${label} ${loaded.name}: ${violations.length} violation(s)`);
        for (const { path, line, message } of violations) {
            out(`[fail] ${path}${line === undefined ? "" : `:${line}`} — ${message}`);
        }
    } catch (error) {
        failed += 1;
        out(`${label} ${module}: internal error — ${error instanceof Error ? error.message : String(error)}`);
    }
}

out(failed === 0 ? `guard: all ${modules.length} passed` : `guard: ${failed} of ${modules.length} failed`);
process.exit(failed === 0 ? 0 : 1);
