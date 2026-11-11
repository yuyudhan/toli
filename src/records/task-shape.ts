import { ToliError } from "../core/util.ts";
import type { Shape } from "./backlog.ts";

/** `--shape`: ship or scout; `fallback` when the flag is absent. */
export function parseShape(value: string | undefined, fallback: Shape): Shape {
    if (value === undefined) return fallback;
    if (value !== "ship" && value !== "scout") throw new ToliError("--shape must be ship or scout");
    return value;
}
