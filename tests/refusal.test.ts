// A receiver's refusal (docs/peers.md "Delivery"): only the receiving command's own `toli: <reason>` exit is final,
// so the sender cancels that item once; everything else stays queued and is retried.
import { describe, expect, test } from "bun:test";
import { refusalOf } from "../src/jobs/refusal.ts";

const failed = (code: number, stderr: string, timedOut = false) => refusalOf({ code, stderr, timedOut });

describe("refusalOf", () => {
    test("the receiving command's own `toli:` line is a refusal, with that line as the reason", () => {
        expect(failed(1, 'toli: unknown task ""')).toBe('unknown task ""');
        expect(failed(1, "warning first\ntoli: T60 was delegated by linux-6, not laptop\n")).toBe(
            "T60 was delegated by linux-6, not laptop",
        );
    });

    test("ssh failures, timeouts, crashes, lock waits and version gaps are retried", () => {
        expect(failed(255, "ssh: connect to host h port 22: Connection refused")).toBeNull();
        expect(failed(1, "toli: unknown task", true)).toBeNull();
        expect(failed(1, "error: ENOSPC: no space left on device\n    at write (x.ts:1:1)")).toBeNull();
        expect(failed(1, "toli: timed out waiting for lock /x/backlog.lock")).toBeNull();
        expect(failed(1, "toli: unknown option --via")).toBeNull();
        expect(failed(1, "toli: usage: toli delegation receive|update|link")).toBeNull();
        expect(failed(2, 'toli: unknown command "peer"')).toBeNull();
    });
});
