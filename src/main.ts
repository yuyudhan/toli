import { out, ToliError, warn } from "./core/util.ts";
import { buildSlotCommand } from "./fleet/build-slots.ts";
import { diskCommand } from "./fleet/disk.ts";
import { execCommand } from "./fleet/exec.ts";
import { initCommand, syncCommand } from "./fleet/fleet.ts";
import { fleetCommand, pickCommand } from "./fleet/pick.ts";
import { remoteCommand } from "./fleet/remote.ts";
import { resourcesCommand } from "./fleet/resources.ts";
import { forgeCommand, prCommand, pushCommand } from "./forge/forge.ts";
import { gateCommand } from "./forge/gate.ts";
import { guidanceCommand } from "./harness/guidance.ts";
import { hookCommand } from "./harness/hooks.ts";
import { sessionCommand } from "./harness/session.ts";
import { harnessCommand } from "./harness/sync.ts";
import { helperCommand } from "./helpers/helpers.ts";
import { resumeCommand, runCommand, runsCommand, spawnCommand } from "./jawans/spawn.ts";
import { scheduleCommand } from "./jobs/schedule.ts";
import { jobCommand } from "./jobs/tick.ts";
import { branchCommand, commitCommand } from "./projects/commit.ts";
import { projectCommand } from "./projects/projects.ts";
import { workspaceCommand } from "./projects/workspace.ts";
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

  init --name <machine> --role coordinator|worker [--coordinator-ssh <host> --coordinator-root <path>]
  setup status [--json] | notice [--json] | snooze | seed-local
  doctor [--json]
  digest [--json] [--fleet]
  project add <name> <git-url> [--mode commit|pr|no-mistakes]
  project ensure <name> <git-url> [--mode commit|pr|no-mistakes]
  project link <name> <path> [--mode commit|pr|no-mistakes]
  project list [--json] | path <name>
  project set <name> [--mode <m>] [--branch <b>|none] [--forge github|gitlab|bitbucket|none] [--forge-host <h>|none]
              [--workspace same-branch|branch-per-task|worktree-per-task] [--standing-push yes|no] [--standing-pr yes|no]
  project set --all --workspace <strategy>
  project drop <name> [--delete-clone] [--delete-data] | import [--dir projects]
  project setup <name> [--json] | setup --all [--json]
  task add <project> "<title>" [--shape ship|scout] [--tier light|standard|deep] [--note "..."]
  task list [--json] [--status queued|active|held|done|dropped]
  task start <id> [--agent <id>] | done <id> [--report <path>] [--commit <sha>] [--note "..."]
  task hold <id> --question "..." [--option "<choice> => <what happens then>"]... [--recommend <n|choice>] [--blocks "..."] [--reversible]
  task answer <id> "<answer>" | drop <id>
  needs [--json]
  commit <project> [--task T<n>] -m "<message>"... [--merge <ref> [--resolved]] [--patch <file>] [--allow-revert <sha>]... [-- <path>...]
  branch <project> <branch>
  workspace prepare T<n> [--json] | list [--project <p>] [--json] | prune [--project <p>] [--force] [--json]
  self sync [--json] | status [--json]
  forge <project> [--json]
  push <project> [--task T<n>] [--gate "<recipe>"] [--by <machine>] [--for T<n>] [--word "<owner's word>"]
  gate run <project> [--task T<n>] --recipe "<shell command>" [--stall <minutes>] [--json]
  gate check <project> [--task T<n>] [--sha <commit>] --recipe "<shell command>" [--json] | status <project> [--json]
  push-log add <project> [--branch <b>] [--old <sha>] [--new <sha>] [--by <machine>] [--for T<n>] [--word "..."]
  push-log list [--json]
  pr create <project> --title <t> (--body <b> | --body-file <f>) [--base <b>] [--draft] [--task T<n>]
  pr status <project> [<id>] [--task T<n>] [--json] | list <project> [--json]
  pr merge <project> <id> [--method merge|squash|rebase]
  job add <name> --cron "<m h dom mon dow>" --prompt "<text>" [--project <p>] [--machine <m>] [--shape scout|ship] [--tier light|standard|deep]
  job list [--json] | pause|resume|remove <name> | due [--json] | run <name> | run-due | tick
  job begin <name> --via session|headless [--json] | finish <name> <runId> [--status ok|failed] (result on stdin)
  job results [--unseen] [--json] | ack
  schedule install|uninstall|status
  helper list [--json] | install <name>|--all | uninstall <name>|--all | run <name> | status [<name>] [--json]
  inbox add --from <machine> --title "<t>" (body on stdin) | list [--json] [--unseen] | ack
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
  pick [--project <name>] [--json]
  exec [--from <machine>] [--task <id>] (prompt on stdin)
  remote <machine|auto> "<prompt>" [--project <name>] [--task T<n>] [--max-time <minutes>] [--tier <t>] [--work <w>]
  session start|end --pid <n>
  spawn --brief <file> [--harness omp|claude|codex|cursor|grok|pi] [--task T<n>] [--project <p>] [--model <m>]
        [--tier light|standard|deep] [--work scout|mechanical|ship|verify|release] [--cwd <dir>] [--max-time <minutes>]
        [--now] [--replace] [--dry-run] [--json]
  runs [--json] [--active] | run status <id> [--json] | run log <id> [--lines <n>] | run kill <id>
  resume <run> [--note "<text>"] [--max-time <minutes>] [--now] [--json]
  harness sync [--check] [--json] | status [--json]
  hook claude-pre-tool|claude-prompt|claude-session-start (hook JSON on stdin)
  guidance
  version [--json]
  upgrade [vX.Y.Z|--latest] [--check]
  update check [--due] [--json] | status [--json] | snooze <vX.Y.Z> | off | on`;

/** Dispatch one CLI invocation; resolves to the process exit code. */
export async function main(argv: string[]): Promise<number> {
    const [command, ...rest] = argv;
    try {
        switch (command) {
            case "init":
                initCommand(rest);
                return 0;
            case "setup":
                setupCommand(rest);
                return 0;
            case "doctor":
                return await doctorCommand(rest);
            case "digest":
                await digestCommand(rest);
                return 0;
            case "project":
                projectCommand(rest);
                return 0;
            case "task":
                taskCommand(rest);
                return 0;
            case "needs":
                needsCommand(rest);
                return 0;
            case "commit":
                commitCommand(rest);
                return 0;
            case "branch":
                branchCommand(rest);
                return 0;
            case "workspace":
                workspaceCommand(rest);
                return 0;
            case "self":
                runtimeCommand(rest);
                return 0;
            case "forge":
                forgeCommand(rest);
                return 0;
            case "push":
                await pushCommand(rest);
                return 0;
            case "gate":
                return await gateCommand(rest);
            case "push-log":
                pushLogCommand(rest);
                return 0;
            case "pr":
                await prCommand(rest);
                return 0;
            case "job":
                await jobCommand(rest);
                return 0;
            case "schedule":
                scheduleCommand(rest);
                return 0;
            case "helper":
                return await helperCommand(rest);
            case "inbox":
                inboxCommand(rest);
                return 0;
            case "wake":
                wakeCommand(rest);
                return 0;
            case "memory":
                memoryCommand(rest);
                return 0;
            case "migrate":
                migrateCommand(rest);
                return 0;
            case "prune":
                pruneCommand(rest);
                return 0;
            case "sync":
                return await syncCommand(rest);
            case "build-slot":
                return await buildSlotCommand(rest);
            case "resources":
                resourcesCommand(rest);
                return 0;
            case "disk":
                diskCommand(rest);
                return 0;
            case "fleet":
                await fleetCommand(rest);
                return 0;
            case "pick":
                return await pickCommand(rest);
            case "exec":
                return await execCommand(rest);
            case "remote":
                return await remoteCommand(rest);
            case "session":
                sessionCommand(rest);
                return 0;
            case "spawn":
                spawnCommand(rest);
                return 0;
            case "resume":
                resumeCommand(rest);
                return 0;
            case "runs":
                runsCommand(rest);
                return 0;
            case "run":
                await runCommand(rest);
                return 0;
            case "harness":
                harnessCommand(rest);
                return 0;
            case "hook":
                hookCommand(rest);
                return 0;
            case "guidance":
                guidanceCommand(rest);
                return 0;
            case "upgrade":
                return await upgradeCommand(rest);
            case "update":
                updateCommand(rest);
                return 0;
            case "version":
            case "--version":
                versionCommand(rest);
                return 0;
            case undefined:
            case "help":
            case "--help":
            case "-h":
                out(USAGE);
                return command === undefined ? 2 : 0;
            default:
                warn(`toli: unknown command "${command}"`);
                warn(USAGE);
                return 2;
        }
    } catch (error) {
        if (error instanceof ToliError) {
            warn(`toli: ${error.message}`);
            return 1;
        }
        throw error;
    }
}
