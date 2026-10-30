// How the live extension reports a failing bin/toli: once per distinct error, never every minute.
//
// The extension's minute tick runs bin/toli; while the CLI is broken (a bad checkout, a missing config) every tick
// fails the same way. The first failure, and any later failure with a different message, yields one notice that points
// to `bin/toli doctor`; repeats are silent. The first success forgets the error, so the CLI recovers silently and a
// later breakage is reported again.

/**
 * The line of an error that names what broke: the first `...Error: ...` line (Bun prints source frames above it), else
 * the first non-blank line. Stack frames and long stderr stay out of the notice and out of the dedupe key.
 */
function headline(error: unknown): string {
    const lines = (error instanceof Error ? error.message : String(error))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    return lines.find((line) => line.includes("Error: ")) ?? lines[0] ?? "unknown error";
}

export class CliHealth {
    #reported: string | null = null;

    /** The notice to show for this failure, or null when the same error was already reported. */
    failed(error: unknown): string | null {
        const message = headline(error);
        if (message === this.#reported) return null;
        this.#reported = message;
        return `toli CLI is failing: ${message}\nRun bin/toli doctor; the background check retries every minute and stays quiet until the error changes or it works again.`;
    }

    /** A run succeeded: the CLI works again. */
    succeeded(): void {
        this.#reported = null;
    }
}
