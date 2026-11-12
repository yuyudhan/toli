// The plist of one toli launchd job (launchd.ts): a user agent, or a LaunchDaemon that runs as the installing user.
import { userInfo } from "node:os";
import { ToliError } from "../core/util.ts";
import { launchdDomain } from "./launchd.ts";

function xml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** One launchd job. Optional keys are written only when set, in a fixed order. */
export type PlistSpec = {
    label: string;
    program: string[];
    workingDirectory: string;
    env: Record<string, string>;
    /** Run every N seconds. */
    startInterval?: number;
    /** StartCalendarInterval entries (keys Minute, Hour, Day, Month, Weekday); absent keys mean "every". */
    calendar?: Record<string, number>[];
    runAtLoad?: boolean;
    /** Restart whenever it exits (a long-running service). */
    keepAlive?: boolean;
    /** Background: throttled, efficiency cores; Interactive: full priority (launchd's default is throttled). */
    processType?: "Background" | "Interactive";
    nice?: number;
    lowPriorityIO?: boolean;
    /** Soft and hard NumberOfFiles resource limits. */
    numberOfFiles?: number;
    stdoutPath: string;
    stderrPath: string;
};

/** The user a LaunchDaemon of toli's runs as (`UserName`): whoever runs toli, never root. */
function daemonUser(): { name: string; home: string } {
    if (process.getuid?.() === 0)
        throw new ToliError(
            "run toli as the user its jobs run as, not as root or under sudo: a LaunchDaemon of toli's runs as the user " +
                "who installs it (UserName), and toli calls sudo -n itself for the steps that need root",
        );
    const user = userInfo();
    return { name: user.username, home: user.homedir };
}

/**
 * The plist for `spec.label` in the launchd domain it lives in (launchdDomain): a user agent as given, or, for a
 * LaunchDaemon, with `UserName` set to the installing user and HOME, USER and LOGNAME set from the user database
 * (a daemon gets no login environment) unless `spec.env` names them.
 */
export function renderLaunchdPlist(spec: PlistSpec): string {
    const daemon = launchdDomain(spec.label) === "system" ? daemonUser() : null;
    const env =
        daemon === null ? spec.env : { HOME: daemon.home, USER: daemon.name, LOGNAME: daemon.name, ...spec.env };
    const lines: string[] = [
        "    <key>Label</key>",
        `    <string>${xml(spec.label)}</string>`,
        "    <key>ProgramArguments</key>",
        "    <array>",
        ...spec.program.map((value) => `        <string>${xml(value)}</string>`),
        "    </array>",
        "    <key>WorkingDirectory</key>",
        `    <string>${xml(spec.workingDirectory)}</string>`,
        ...(daemon === null ? [] : ["    <key>UserName</key>", `    <string>${xml(daemon.name)}</string>`]),
        "    <key>EnvironmentVariables</key>",
        "    <dict>",
        ...Object.entries(env).flatMap(([key, value]) => [
            `        <key>${xml(key)}</key>`,
            `        <string>${xml(value)}</string>`,
        ]),
        "    </dict>",
    ];
    if (spec.startInterval !== undefined)
        lines.push("    <key>StartInterval</key>", `    <integer>${spec.startInterval}</integer>`);
    if (spec.calendar !== undefined) {
        lines.push("    <key>StartCalendarInterval</key>", "    <array>");
        for (const entry of spec.calendar) {
            lines.push("        <dict>");
            for (const [key, value] of Object.entries(entry))
                lines.push(`            <key>${key}</key>`, `            <integer>${value}</integer>`);
            lines.push("        </dict>");
        }
        lines.push("    </array>");
    }
    if (spec.runAtLoad) lines.push("    <key>RunAtLoad</key>", "    <true/>");
    if (spec.keepAlive) lines.push("    <key>KeepAlive</key>", "    <true/>");
    if (spec.processType !== undefined)
        lines.push("    <key>ProcessType</key>", `    <string>${spec.processType}</string>`);
    if (spec.nice !== undefined) lines.push("    <key>Nice</key>", `    <integer>${spec.nice}</integer>`);
    if (spec.lowPriorityIO) lines.push("    <key>LowPriorityIO</key>", "    <true/>");
    if (spec.numberOfFiles !== undefined)
        for (const key of ["SoftResourceLimits", "HardResourceLimits"])
            lines.push(
                `    <key>${key}</key>`,
                "    <dict>",
                "        <key>NumberOfFiles</key>",
                `        <integer>${spec.numberOfFiles}</integer>`,
                "    </dict>",
            );
    lines.push(
        "    <key>StandardOutPath</key>",
        `    <string>${xml(spec.stdoutPath)}</string>`,
        "    <key>StandardErrorPath</key>",
        `    <string>${xml(spec.stderrPath)}</string>`,
    );
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${lines.join("\n")}
</dict>
</plist>
`;
}
