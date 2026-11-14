import { out, ToliError, warn } from "./core/util.ts";
import { buildSlotCommand } from "./fleet/build-slots.ts";
import { delegateCommand, delegationCommand } from "./fleet/delegate.ts";
import { diskCommand } from "./fleet/disk-command.ts";
import { execCommand } from "./fleet/exec.ts";
import { initCommand, syncCommand } from "./fleet/fleet.ts";
import { leadCommand } from "./fleet/lead.ts";
import { fleetCommand } from "./fleet/oversight.ts";
import { pickCommand } from "./fleet/pick.ts";
import { remoteCommand } from "./fleet/remote.ts";
import { resourcesCommand } from "./fleet/resources.ts";
import { shareCommand } from "./fleet/share.ts";
import { talkCommand } from "./fleet/talk.ts";
import { forgeCommand, prCommand, pushCommand } from "./forge/forge.ts";
import { gateCommand } from "./forge/gate-cli.ts";
import { guidanceCommand } from "./harness/guidance.ts";
import { hookCommand } from "./harness/hooks.ts";
import { sessionCommand } from "./harness/session.ts";
import { harnessCommand } from "./harness/sync.ts";
import { helperCommand } from "./helpers/helpers.ts";
import { resumeCommand, runCommand, runsCommand, spawnCommand } from "./jawans/spawn.ts";
import { outboxCommand } from "./jobs/pull.ts";
import { scheduleCommand } from "./jobs/schedule.ts";
import { jobCommand } from "./jobs/tick.ts";
import { peerCommand } from "./peer/command.ts";
import { branchCommand, commitCommand } from "./projects/commit.ts";
import { projectCommand } from "./projects/projects.ts";
import { workspaceCommand } from "./projects/workspace-command.ts";
import { taskCommand } from "./records/backlog.ts";
import { digestCommand } from "./records/digest.ts";
import { inboxCommand } from "./records/inbox.ts";
import { memoryCommand } from "./records/memory.ts";
import { migrateCommand } from "./records/migrate.ts";
import { needsCommand } from "./records/needs.ts";
import { pruneCommand } from "./records/prune.ts";
import { pushLogCommand } from "./records/push-log.ts";
import { wakeCommand } from "./records/wake.ts";
import { runtimeCommand } from "./release/runtime.ts";
import { updateCommand } from "./release/update-check.ts";
import { upgradeCommand, versionCommand } from "./release/upgrade.ts";
import { doctorCommand } from "./setup/doctor.ts";
import { setupCommand } from "./setup/setup.ts";

const USAGE = `usage: bin/toli <command> [args]

  init --name <machine> --role coordinator|worker [--coordinator-ssh <host> --coordinator-root <path>] [--inbound on|off]
  setup status [--json] | notice [--json] | snooze | seed-local
  doctor [--json]
  digest [--json] [--fleet]
  project add <name> <git-url> [--mode commit|pr|no-mistakes]
  project ensure <name> <git-url> [--mode commit|pr|no-mistakes]
  project link <name> <path> [--mode commit|pr|no-mistakes]
  project list [--json] | path <name>
  project set <name> [--mode <m>] [--branch <b>|none] [--forge github|gitlab|bitbucket|none] [--forge-host <h>|none]
              [--workspace same-branch|branch-per-task|worktree-per-task] [--standing-push yes|no] [--standing-pr yes|no]
              [--live-stack yes|no]
  project set --all --workspace <strategy>
  project drop <name> [--delete-clone] [--delete-data] | import [--dir projects]
  project setup <name> [--json] | setup --all [--json]
  task add <project> "<title>" [--shape ship|scout] [--tier light|standard|deep] [--note "..."]
  task list [--json] [--status queued|active|held|done|dropped] [--project <p>] [--fleet [--cached]]
  task start <id> [--agent <id>] | done <id> [--report <path>] [--commit <sha>] [--note "..."]
  task wait <id> --on "<what it waits on>"
  task pin <id> [--reason "..."] | unpin <id>
  task hold <id> --question "..." [--option "<choice> => <what happens then>"]... [--recommend <n|choice>] [--blocks "..."] [--reversible]
  task answer <id|machine/T<n>> "<answer>" [--from <machine>] | drop <id>
  task link <id> <machine>/T<n> | escalate <machine>/T<n> | handback <id> --reason "..." [--full]
  delegate <machine> "<title>" --brief <file> [--project <p>] [--note "..."] [--for T<n>] [--shape ship|scout] [--tier <t>]
  delegation receive|update|link [--from <machine>] (JSON on stdin)
  talk <machine> ["<words>"]
  share "<learning>" [--to <machine>]... [--all] [--project <p>] [--source "..."] [--from-user] | share --list [--json]
  share answer <id> adopt|adapt|decline [--into learnings|preferences|notes] [--text "..."] [--note "..."]
  share receive (JSON on stdin)
  lead install|uninstall | status [--json] | run [--once] | attach | full [--reason "..."] [--until 30m|2h|<time>] | full --clear|--status
  needs [--json]
  commit <project> [--task T<n>] -m "<message>"... [--merge <ref> [--resolved]] [--patch <file>]... [--allow-revert <sha>]... [--patch-out <file>] [-- <path>...]
  branch <project> <branch>
  workspace prepare T<n> [--json] | list [--project <p>] [--json] | prune [--project <p>] [--json]
  self sync [--json] | status [--json]
  forge <project> [--json]
  push <project> [--task T<n>] [--gate "<recipe>" [--gate-wait <minutes>]] [--by <machine>] [--for T<n>] [--word "<owner's word>"] [--no-hooks-ok]
  gate run <project> [--task T<n>] --recipe "<shell command>" [--stall <minutes>] [--json]
  gate check <project> [--task T<n>] [--sha <commit>] --recipe "<shell command>" [--json] | status <project> [--json]
  push-log add <project> [--branch <b>] [--old <sha>] [--new <sha>] [--by <machine>] [--for T<n>] [--word "..."]
  push-log list [--json]
  pr create <project> --title <t> (--body <b> | --body-file <f>) [--base <b>] [--draft] [--task T<n>]
  pr status <project> [<id>] [--task T<n>] [--json] | list <project> [--json]
  pr merge <project> <id> [--method merge|squash|rebase]
  job add <name> --cron "<m h dom mon dow>" --prompt "<text>" [--project <p>] [--machine <m>] [--shape scout|ship] [--tier light|standard|deep]
  job list [--json] | pause|resume|remove <name> | due [--json] | run <name> | run-due | tick
  job begin <name> --via session|headless [--json] | finish <name> <runId> [--status ok|failed] [--quiet] (result on stdin)
  job results [--unseen] [--json] | ack [--through <stamp>]
  schedule install|uninstall|status
  helper list [--json] | install <name>|--all | uninstall <name>|--all | run <name> | status [<name>] [--json]
  inbox add --from <machine> --title "<t>" [--via "<how it arrived>"] (body on stdin) | list [--json] [--unseen] | ack [--through <stamp>]
  outbox pull [--json] | pending --for <machine> (its fleet export on stdin) | ack --for <machine> (JSON on stdin)
  outbox list [--to <machine>] [--cancelled] [--json] | cancel <id>|--to <machine> [--why "..."] | expire --older <N>d
  peer init | status [--json] | list [--json] | apply (envelopes on stdin)
  peer serve | listen on|off | set [--port <n>] [--bind private|<ip,...>] [--interfaces <name,...>|none]
    [--ssh-fallback on|off]
  peer add <host[:port]> [--code NNNN] [--by owner|sardar] [--why "..."] | requests [--json]
  peer accept <request> [--by owner|sardar] [--why "..."] | decline <request> [--why "..."]
  peer trust <peer> --key <key> --via <relay> [--by owner|sardar] [--why "..."]
  peer allow|deny <peer> <talk|delegate|share|answer|status> [--why "..."] | remove <peer> [--why "..."]
  peer flush <peer>|--all [--json] | pull [--json] | stats [--peer <p>] [--json] | ask <peer> status [--json] | rotate
  peer scan [--netbird] [--tailscale] [--subnet <cidr>] [--port <n>] [--json]
  wake [--json]
  memory [--json] | stale [--json] | archive <file> <line-or-id> --reason "<text>" [--force]
  prune [--apply] [--json]
  migrate [--dry-run] [--json]
  sync [--all]
  resources [--json]
  build-slot -- <command...>
  disk keep [--dry-run] [--floor <GB>] [--json]
  disk alert
  fleet status [--json]
  fleet queues [--json]
  fleet export | sync
  fleet check [--json] [--wake] [--local]
  pick [--project <name>] [--json]
  exec [--task <id>] (prompt on stdin; runs here only)
  session start|end --pid <n>
  spawn --brief <file> [--harness omp|claude|codex|cursor|grok|pi] [--task T<n>] [--project <p>] [--model <m>]
        [--tier light|standard|deep] [--work scout|mechanical|ship|verify|release] [--cwd <dir>] [--max-time <minutes>]
        [--now] [--replace] [--dry-run] [--json]
  runs [--json] [--active]
  run status <id> [--json] | run log <id> [--lines <n>] | run kill <id>
  resume <run> [--note "<text>"] [--max-time <minutes>] [--now] [--json]
  harness sync [--check] [--json] | status [--json]
  hook claude-pre-tool|claude-prompt|claude-session-start (hook JSON on stdin) | lead-build-env
  guidance
  version [--json]
  upgrade [vX.Y.Z|--latest] [--check]
  update check [--due] [--json] | status [--json] | snooze <vX.Y.Z> | off | on`;

/** Every command, by its first word; each resolves to the process exit code. */
const COMMANDS: Record<string, (argv: string[]) => number | Promise<number>> = {
    init: (argv) => {
        initCommand(argv);
        return 0;
    },
    setup: (argv) => {
        setupCommand(argv);
        return 0;
    },
    doctor: doctorCommand,
    digest: async (argv) => {
        await digestCommand(argv);
        return 0;
    },
    project: (argv) => {
        projectCommand(argv);
        return 0;
    },
    task: async (argv) => {
        await taskCommand(argv);
        return 0;
    },
    delegate: delegateCommand,
    delegation: (argv) => {
        delegationCommand(argv);
        return 0;
    },
    talk: talkCommand,
    share: (argv) => {
        shareCommand(argv);
        return 0;
    },
    lead: leadCommand,
    needs: (argv) => {
        needsCommand(argv);
        return 0;
    },
    commit: (argv) => {
        commitCommand(argv);
        return 0;
    },
    branch: (argv) => {
        branchCommand(argv);
        return 0;
    },
    workspace: (argv) => {
        workspaceCommand(argv);
        return 0;
    },
    self: (argv) => {
        runtimeCommand(argv);
        return 0;
    },
    forge: (argv) => {
        forgeCommand(argv);
        return 0;
    },
    push: async (argv) => {
        await pushCommand(argv);
        return 0;
    },
    gate: gateCommand,
    "push-log": (argv) => {
        pushLogCommand(argv);
        return 0;
    },
    pr: async (argv) => {
        await prCommand(argv);
        return 0;
    },
    job: async (argv) => {
        await jobCommand(argv);
        return 0;
    },
    schedule: (argv) => {
        scheduleCommand(argv);
        return 0;
    },
    helper: helperCommand,
    inbox: (argv) => {
        inboxCommand(argv);
        return 0;
    },
    outbox: async (argv) => {
        await outboxCommand(argv);
        return 0;
    },
    peer: peerCommand,
    wake: (argv) => {
        wakeCommand(argv);
        return 0;
    },
    memory: (argv) => {
        memoryCommand(argv);
        return 0;
    },
    migrate: (argv) => {
        migrateCommand(argv);
        return 0;
    },
    prune: (argv) => {
        pruneCommand(argv);
        return 0;
    },
    sync: syncCommand,
    "build-slot": buildSlotCommand,
    resources: (argv) => {
        resourcesCommand(argv);
        return 0;
    },
    disk: (argv) => {
        diskCommand(argv);
        return 0;
    },
    fleet: async (argv) => {
        await fleetCommand(argv);
        return 0;
    },
    pick: pickCommand,
    exec: execCommand,
    remote: remoteCommand,
    session: (argv) => {
        sessionCommand(argv);
        return 0;
    },
    spawn: (argv) => {
        spawnCommand(argv);
        return 0;
    },
    resume: (argv) => {
        resumeCommand(argv);
        return 0;
    },
    runs: (argv) => {
        runsCommand(argv);
        return 0;
    },
    run: async (argv) => {
        await runCommand(argv);
        return 0;
    },
    harness: (argv) => {
        harnessCommand(argv);
        return 0;
    },
    hook: (argv) => {
        hookCommand(argv);
        return 0;
    },
    guidance: (argv) => {
        guidanceCommand(argv);
        return 0;
    },
    upgrade: upgradeCommand,
    update: (argv) => {
        updateCommand(argv);
        return 0;
    },
    version: (argv) => {
        versionCommand(argv);
        return 0;
    },
    "--version": (argv) => {
        versionCommand(argv);
        return 0;
    },
};

/** USAGE's entries: each command line with its indented continuation lines. */
const USAGE_ENTRIES: readonly string[] = USAGE.split("\n")
    .slice(2)
    .reduce<string[]>((entries, line) => {
        if (/^ {2}\S/.test(line)) entries.push(line);
        else if (entries.length > 0) entries[entries.length - 1] += `\n${line}`;
        return entries;
    }, []);

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `<command> ... --help` (or `-h`) anywhere before a bare `--`: its USAGE entries, narrowed to the entries naming
 * `sub` (its first positional) when any do; a command USAGE does not list (`remote`) gets the whole USAGE.
 */
function commandUsage(command: string, sub: string | undefined): string {
    const own = USAGE_ENTRIES.filter((entry) => entry.startsWith(`  ${command} `) || entry === `  ${command}`);
    if (own.length === 0) return USAGE;
    const named =
        sub === undefined
            ? []
            : own.filter((entry) =>
                  new RegExp(`(?:^ {2}${escapeRegex(command)} |\\| )${escapeRegex(sub)}(?=[ |\\]]|$)`, "m").test(entry),
              );
    const chosen = named.length > 0 ? named : own;
    const only = chosen.length === 1 ? (chosen[0] as string) : undefined;
    if (only !== undefined && !only.includes("\n")) return `usage: bin/toli ${only.trimStart()}`;
    return `usage: bin/toli ${command} [args]\n\n${chosen.join("\n")}`;
}

/** Whether `argv` asks for help: `--help` or `-h` before any bare `--`. */
function wantsHelp(argv: readonly string[]): boolean {
    const end = argv.indexOf("--");
    return (end === -1 ? argv : argv.slice(0, end)).some((word) => word === "--help" || word === "-h");
}

/** Dispatch one CLI invocation; resolves to the process exit code. */
export async function main(argv: string[]): Promise<number> {
    const [command, ...rest] = argv;
    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
        out(USAGE);
        return command === undefined ? 2 : 0;
    }
    const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
    if (run === undefined) {
        warn(`toli: unknown command "${command}"`);
        warn(USAGE);
        return 2;
    }
    if (wantsHelp(rest)) {
        out(
            commandUsage(
                command,
                rest.find((word) => !word.startsWith("-")),
            ),
        );
        return 0;
    }
    try {
        return await run(rest);
    } catch (error) {
        if (error instanceof ToliError) {
            warn(`toli: ${error.message}`);
            return 1;
        }
        throw error;
    }
}
