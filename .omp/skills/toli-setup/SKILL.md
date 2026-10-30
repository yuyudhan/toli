---
name: toli-setup
description: First-run and resumed setup of this toli installation, done by the lead with the user's answers and jawans. Use when the user says "set up toli", "setup", "finish setup", runs /setup, on a fresh clone (no config/machine.json), or when the session-start notice says setup steps remain.
---

# Setting up toli (/setup)

`bin/toli setup status` is the checklist; it always shows the full state. Every item has a stable id, a status
(`done`, `missing`, `optional`), who closes it (`user`, `lead-command`, `jawan`), and the exact fix command or the
question to ask. Setup is idempotent: run the same flow on a fresh clone or a half-done one and it picks up where it
stopped.

| id             | closes it       | fix                                                                                         |
| -------------- | --------------- | ------------------------------------------------------------------------------------------- |
| `tools`        | jawan           | install git (Bun is present when `bin/toli` runs)                                           |
| `machine`      | user, then lead | ask name and role, then `bin/toli init --name <m> --role coordinator\|worker [...]`         |
| `persona`      | user (optional) | defaults are fine; custom names go in `config/persona.json`                                 |
| `harness-sync` | jawan           | `bin/toli harness sync` (writes tracked shim files)                                         |
| `harness-cli`  | jawan + user    | a jawan installs a harness CLI; the user logs in (browser or API key)                       |
| `scheduler`    | jawan           | `bin/toli schedule install` (launchd agent, systemd user timer, or crontab line)            |
| `local`        | lead            | `bin/toli setup seed-local`                                                                 |
| `git-hooks`    | jawan           | `git config core.hooksPath .githooks` in toli's root                                        |
| `fleet`        | user (optional) | other machines in `config/fleet.json`; a worker needs its coordinator (`skill://toli-sync`) |
| `project`      | user, then lead | ask which repo, then `/add-project <name> <git-url>` (`skill://toli-projects`)              |

## Flow

1. Run `bin/toli setup status --json` and read every item that is not `done`.
2. Ask the user **one batched message** covering every `user` item still open, numbered, each with its default so
   "defaults" is a complete answer:
    - this machine's name (default: the short hostname) and role: coordinator (the machine they talk to) or worker
      (then the coordinator's ssh host and toli path);
    - persona names: keep the defaults (`bin/toli setup status` shows them) or give the user, lead and worker names;
    - the default jawan harness (omp, claude, codex, cursor, grok, pi; default: the one they started this session in),
      only when `config/machine.json` has no `harness.jawan`;
    - the default workspace strategy for jawans, only when `config/machine.json` has no `defaults.workspace`:
      `same-branch` (recommended and the default: every jawan works in the one clone on the project's branch, and
      `bin/toli commit` lands only each jawan's own paths from the branch tip, so many parallel jawans need no
      worktrees or merges), `branch-per-task` (one clone, a branch `toli/<T-id>-<slug>` and a PR/MR per task), or
      `worktree-per-task` (opt-in: a git worktree per task under `projects/.worktrees/<project>/<T-id>`, its own
      branch and PR/MR; a full checkout and build per task, which does not scale to many agents);
    - the first project to add: a name and its git URL, plus how it ships (`skill://toli-projects` delivery question);
    - whether toli runs on other machines (only when the role is coordinator and `fleet` is optional);
    - any harness login the checklist says is missing: they run it themselves (it may open a browser).

    Skip questions whose answers are already recorded. End the turn after asking.

3. With the answers, run the lead bookkeeping yourself, in this order:
    - `bin/toli init --name <name> --role <role> [--coordinator-ssh <host> --coordinator-root <path>]` (re-running it
      keeps every other setting in `config/machine.json`);
    - persona: write `config/persona.json` with only the names that differ from the defaults
      (`user`, `lead`, `leadPlural`, `worker`, `workerPlural`);
    - default jawan harness: set `"harness": {"jawan": "<h>"}` in `config/machine.json` (`docs/harnesses.md`);
    - workspace strategy: set `"defaults": {"workspace": "<strategy>"}` in `config/machine.json`;
    - `bin/toli setup seed-local`;
    - the first project: follow `/add-project` in `skill://toli-projects`;
    - other machines: add them to `config/fleet.json` (`skill://toli-sync`).
4. Dispatch **one jawan** (`docs/brief-template.md`; it works in toli's root) for every remaining
   `jawan` item, with the exact fix commands from the checklist as its steps and `bin/toli setup status` as its
   acceptance check: harness CLI installs, `bin/toli harness sync`, `bin/toli schedule install`, the git hooks path,
   git. Install commands for harnesses are in `docs/harnesses.md`; a login is never done by a jawan, it reports the
   login command for the user instead. Setup works on toli itself, not a registered project, so there is no
   `bin/toli task` for it: dispatch in the background (`bin/toli spawn --brief <file>` records its run) and track it
   with the re-check below.
5. When the jawan reports, run `bin/toli setup status` again. Relay what is now done in one or two lines; repeat steps
   2-4 for anything still `missing`. Setup is finished when status says `complete`.

## Rules

- Never ask the same question twice: answers already recorded (config files, registered projects) show as `done`.
- `optional` items are offered once in the batched question and never nagged about.
- If the user wants to stop for now, run `bin/toli setup snooze`: session start stays quiet until a new step is
  missing, and the digest's Next block shows only `Setup snoozed: N steps remain` (do not offer setup from it);
  `bin/toli setup status` still shows everything.
- The session-start notice (`Setup: N steps remain - say "set up toli"`) comes from `bin/toli setup notice`; it is
  told once per new missing set, so never repeat it on your own every turn. The digest's Next block names the
  remaining steps every time as a reminder for you, not a line to repeat to the user.
