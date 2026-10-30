import { taskCommand } from "./backlog.ts";
import { branchCommand, commitCommand } from "./commit.ts";
import { digestCommand } from "./digest.ts";
import { doctorCommand } from "./doctor.ts";
import { execCommand, initCommand, remoteCommand, syncCommand } from "./fleet.ts";
import { forgeCommand, prCommand, pushCommand } from "./forge.ts";
import { inboxCommand } from "./inbox.ts";
import { memoryCommand } from "./memory.ts";
import { fleetCommand, pickCommand } from "./pick.ts";
import { projectCommand } from "./projects.ts";
import { pruneCommand } from "./prune.ts";
import { resourcesCommand } from "./resources.ts";
import { scheduleCommand } from "./schedule.ts";
import { sessionCommand } from "./session.ts";
import { jobCommand } from "./tick.ts";
import { out, ToliError, warn } from "./util.ts";
import { wakeCommand } from "./wake.ts";

const USAGE = `usage: bin/toli <command> [args]

  init --name <machine> --role coordinator|worker [--coordinator-ssh <host> --coordinator-root <path>]
  doctor [--json]
  digest [--json] [--fleet]
  project add <name> <git-url> [--mode commit|pr|no-mistakes]
  project ensure <name> <git-url> [--mode commit|pr|no-mistakes]
  project list [--json] | path <name>
  project set <name> [--mode <m>] [--branch <b>|none] [--forge github|gitlab|bitbucket|none] [--forge-host <h>|none]
  project drop <name> [--delete-clone] | import [--dir projects]
  task add <project> "<title>" [--shape ship|scout] [--note "..."]
  task list [--json] [--status queued|active|held|done|dropped]
  task start <id> | done <id> [--report <path>] [--commit <sha>] [--note "..."]
  task hold <id> --question "..." | answer <id> "<answer>" | drop <id>
  commit <project> -m "<message>" -- <path>...
  branch <project> <branch>
  forge <project> [--json]
  push <project>
  pr create <project> --title <t> (--body <b> | --body-file <f>) [--base <b>] [--draft]
  pr status <project> [<id>] [--json] | list <project> [--json]
  pr merge <project> <id> [--method merge|squash|rebase]
  job add <name> --cron "<m h dom mon dow>" --prompt "<text>" [--project <p>] [--machine <m>] [--shape scout|ship]
  job list [--json] | pause|resume|remove <name> | due [--json] | run <name> | run-due | tick
  job begin <name> --via session|headless [--json] | finish <name> <runId> [--status ok|failed] (result on stdin)
  job results [--unseen] [--json] | ack
  schedule install|uninstall|status
  inbox add --from <machine> --title "<t>" (body on stdin) | list [--json] [--unseen] | ack
  wake [--json]
  memory [--json] | stale [--json] | archive <file> <line-or-id> --reason "<text>" [--force]
  prune [--apply] [--json]
  sync [--all]
  resources [--json]
  fleet status [--json]
  pick [--project <name>] [--json]
  exec [--from <machine>] [--task <id>] (prompt on stdin)
  remote <machine|auto> "<prompt>" [--project <name>]
  session start|end --pid <n>`;

/** Dispatch one CLI invocation; resolves to the process exit code. */
export async function main(argv: string[]): Promise<number> {
    const [command, ...rest] = argv;
    try {
        switch (command) {
            case "init":
                initCommand(rest);
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
            case "commit":
                commitCommand(rest);
                return 0;
            case "branch":
                branchCommand(rest);
                return 0;
            case "forge":
                forgeCommand(rest);
                return 0;
            case "push":
                await pushCommand(rest);
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
            case "inbox":
                inboxCommand(rest);
                return 0;
            case "wake":
                wakeCommand(rest);
                return 0;
            case "memory":
                memoryCommand(rest);
                return 0;
            case "prune":
                pruneCommand(rest);
                return 0;
            case "sync":
                return syncCommand(rest);
            case "resources":
                resourcesCommand(rest);
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
