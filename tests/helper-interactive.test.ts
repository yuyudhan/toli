import { describe, expect, test } from "bun:test";
import { type Helper, parseHelpers } from "../src/helpers/registry.ts";
import { renderHelperCronLine, renderHelperPlist, renderHelperSystemd } from "../src/helpers/units.ts";

/** Parse one helpers.json entry the way `helper install` does. */
function helper(entry: Record<string, unknown>): Helper {
    const [parsed] = parseHelpers({ helpers: [{ name: "tick", exec: "/usr/bin/true", ...entry }] }, "/toli", "h.json");
    if (parsed === undefined) throw new Error("no helper parsed");
    return parsed;
}

const INTERACTIVE = "<key>ProcessType</key>\n    <string>Interactive</string>";
const BACKGROUND = "<key>ProcessType</key>\n    <string>Background</string>";

describe('helper "interactive"', () => {
    test("defaults to false and renders no ProcessType on an interval helper", () => {
        const tick = helper({ schedule: { every: "60s" } });
        expect(tick.interactive).toBe(false);
        expect(renderHelperPlist(tick)).not.toContain("ProcessType");
    });

    test("true renders launchd ProcessType Interactive on interval and cron helpers", () => {
        expect(renderHelperPlist(helper({ schedule: { every: "60s" }, interactive: true }))).toContain(INTERACTIVE);
        expect(renderHelperPlist(helper({ schedule: { cron: "0 * * * *" }, interactive: true }))).toContain(
            INTERACTIVE,
        );
    });

    test("an always-running helper stays Background, interactive or not", () => {
        for (const interactive of [false, true]) {
            const plist = renderHelperPlist(helper({ schedule: { always: true }, interactive }));
            expect(plist).toContain(BACKGROUND);
            expect(plist).not.toContain("Interactive");
        }
    });

    test("systemd and crontab already run at normal priority: the field changes nothing there", () => {
        const plain = helper({ schedule: { every: "15m" } });
        const interactive = helper({ schedule: { every: "15m" }, interactive: true });
        expect(renderHelperSystemd(interactive)).toEqual(renderHelperSystemd(plain));
        expect(renderHelperCronLine(interactive)).toBe(renderHelperCronLine(plain));
    });
});
