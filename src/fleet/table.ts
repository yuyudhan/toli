/**
 * A plain-text table for the fleet reads: the first `left` columns left-aligned, the rest right-aligned, two spaces
 * apart, with a rule under the header.
 */
export function renderTable(header: string[], rows: string[][], left = 1): string[] {
    const widths = header.map((cell, column) =>
        Math.max(cell.length, ...rows.map((row) => (row[column] ?? "").length)),
    );
    const line = (row: string[]): string =>
        row
            .map((cell, column) =>
                column < left ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0),
            )
            .join("  ")
            .trimEnd();
    return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)];
}
