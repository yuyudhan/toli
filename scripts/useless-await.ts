// Fails when any file tsconfig.json covers has TypeScript suggestion 80007 ("'await' has no effect on the type of
// this expression"): an await on a value that is not a promise, or on a call whose types say it returns no promise.
// tsc --noEmit never reports suggestion diagnostics, and Biome's useAwaitThenable cannot see through bun-types, so
// this asks the TypeScript language service directly. `just lint` runs it.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import ts from "typescript";

const USELESS_AWAIT = 80007;
const ROOT = new URL("..", import.meta.url).pathname;
const out = (line: string) => process.stdout.write(`${line}\n`);

const configPath = `${ROOT}tsconfig.json`;
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) {
    out(`useless-await: ${ts.flattenDiagnosticMessageText(config.error.messageText, "\n")}`);
    process.exit(1);
}
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
if (parsed.fileNames.length === 0) {
    out("useless-await: tsconfig.json matches no files; refusing to pass vacuously");
    process.exit(1);
}

const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => parsed.fileNames,
    getScriptVersion: () => "0",
    getScriptSnapshot: (file) =>
        ts.sys.fileExists(file) ? ts.ScriptSnapshot.fromString(readFileSync(file, "utf8")) : undefined,
    getCurrentDirectory: () => ROOT,
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
};
const service = ts.createLanguageService(host);

const hits: string[] = [];
for (const file of parsed.fileNames) {
    for (const diagnostic of service.getSuggestionDiagnostics(file)) {
        if (diagnostic.code !== USELESS_AWAIT || diagnostic.file === undefined) continue;
        const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
        hits.push(`[fail] ${relative(ROOT, file)}:${line + 1} — TS${USELESS_AWAIT} ${message}`);
    }
}

for (const hit of hits) out(hit);
out(
    hits.length === 0
        ? `useless-await: ${parsed.fileNames.length} files OK`
        : `useless-await: ${hits.length} await(s) on non-promise values`,
);
process.exit(hits.length === 0 ? 0 : 1);
