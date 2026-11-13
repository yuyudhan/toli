TOLI_BRIEF v1

<!--
Jawan brief template. Sardar fills this in for every task before spawning a jawan (on omp, a `task` subagent). The
brief is the jawan's entire context: it cannot see the conversation with the user. Copy the whole file, replace each
`<...>`, drop this comment, and keep the Rules section unchanged (the one exception: a brief that carries out a push,
PR, merge, or tag replaces the "Never push" line with the user's word for that action, quoted verbatim, or, for a push
or PR/MR only, the project's standing grant from `bin/toli project list --json`). A push brief also says how to
record the push where it runs: `bin/toli push <project> [--task <T-id>] --by <this machine> --for <T-id> --word
"<the user's word>"`, run in the toli checkout of the machine whose clone pushes (over ssh for another machine), logs
it in that machine's `data/pushes.jsonl` and its `bin/toli digest`; after a raw `git push` there, the jawan runs
`bin/toli push-log add <project> --by <this machine> --for <T-id> --word "<the user's word>"` on that machine. The
first line `TOLI_BRIEF v1` must stay the first line of every brief: AGENTS.md uses it to tell jawans apart from Sardar.
Independent verification of ship work uses docs/verify-brief-template.md.
Model tier: the work type picks the jawan's model (docs/harnesses.md "Model tiers": scout and ship standard,
mechanical light, verify and release deep). A hard brief adds a line `Tier: deep` (or `light`, `standard`) right under
the title, before the first `## ` section; `bin/toli spawn --tier` and `--model` still override it.
Live-stack projects (`liveStack: true` in `bin/toli project list --json`, docs/projects.md "Live-stack mode"): keep
the `## Live stack` section and fill its commands from the notes' `## Live stack mode`; drop it for every other
project and for scouts. `bin/toli spawn` warns when a live-stack project's code brief lacks it.
-->

# Task <T-id>: <short title>

## The user's intent (verbatim words)

> <The user's exact words, unedited>

The user is whoever asked for this work. Their name belongs in this brief only; never write it into commits, PR
bodies, code, or project files (write "the user" if you must refer to them).

## Goal

<Keep exactly one form. Full form: every ship brief and any long or multi-step jawan. Short form: scouts and quick
lookups.>

Full form:

- Objective: <one sentence, one concrete outcome; never "improve" or "look into">
- Constraints / out of scope: <what must not change: APIs, files, dependencies; plus the Out of scope section below>
- Validate: `<literal command, runnable as-is: the project's test or smoke command from the notes, plus any check
this task adds>`
- Stop when: <a machine-checkable state, e.g. "Validate exits 0 with 0 skipped and `curl -s <url>/health` prints
  ok">
- Record: <where the result goes: the report below; scouts: data/projects/<project>/reports/<T-id>.md>

Short form:

- Objective: <what to find out>
- Stop when: <the exact questions the report answers, each with evidence (file:line or command output)>

Work in a loop: plan, act, run Validate, and repeat until Stop when holds or you are blocked; report which one ended
the loop. Never delete, skip, weaken, narrow, or special-case tests or assertions, add skip markers, or change
Validate's command or inputs to make it pass. If the only path to green is removing or weakening a check, stop and
report instead.

## Project

- Name: <project>
- Workspace: <same-branch | branch-per-task | worktree-per-task> (`workspace` in `bin/toli project list --json`)
- Path: <same-branch: `bin/toli project path <project>`; per-task: the path `bin/toli workspace prepare <T-id>`
  printed (a `bin/toli spawn --task` jawan gets it in a Workspace block appended below)> - work only here
- Notes: <absolute path to data/projects/<project>/notes.md> - read it first (stack, commands, URLs, proof, gotchas)
- Branch: <same-branch: fixed branch from `bin/toli project list --json`, or "current branch"; per-task: the task
  branch `toli/<T-id>-<slug>` the workspace was prepared on> - stay on it; never switch
- Shape: <ship | scout>

## Spec

<What to do, concretely. Include the current behaviour, the wanted behaviour, relevant files or symbols if known,
links to scout reports (data/projects/<project>/reports/<T-id>.md), and any decisions the user already made.>

Other jawans may be working in the same project at the same time, possibly in the same files. Change only what this
task needs, and never revert or reformat changes you did not make.

## Live stack

<Keep only for a live-stack project; drop for any other project and for scouts.>

This project runs in live-stack mode: every jawan on this machine writes code in the one shared checkout, on its one
branch, and the machine's dev stack is the one build. It is already running and rebuilds on every save (backend
recompiles, dashboard hot-reloads); never stop, restart or rebuild it from scratch yourself.

- Start (only if it is down): `<start command from the notes' ## Live stack mode>`
- Follow the logs: `<logs command from the notes>`
- Health: `<health command from the notes>`

1. While coding, never run your own build, test or lint of the whole project (`cargo build`/`test`/`clippy`, the
   full test suites, the project's full check): the running stack compiles everyone's changes. Backend first, then
   the frontend, then migrations and anything else the feature needs, in this shared checkout.
2. Commit only your own paths with `bin/toli commit` (Landing below), never anyone else's.
3. Follow the live logs after every save. Fix every compile or runtime error your change caused; an error in a file
   you did not touch belongs to the jawan who did: leave it to them (tell them in an agent message when you can
   name them), and wait for it to clear instead of editing their code.
4. Once the stack is green (the backend compiles and answers Health, the dashboard builds) with your change in it,
   run your browser tests against the live stack and your own scoped automated tests (the notes' scoped commands for
   the crates and folders you changed), and fix what fails.
5. The full check runs once per machine, at integration or before a push, not per change: leave it out unless this
   brief's Landing asks for it.

## Acceptance / evidence required

- <observable result 1>
- <observable result 2>
- Run the project's tests (<command from notes>) and/or this smoke check: <command>.
- <UI/API work: keep when the notes list `## URLs`, else drop> Check the logs (<log command or file from notes>)
  and show no new errors; verify <local URL from notes> with a headless browser (UI) or HTTP request (API) and paste
  what it returned.
- <UI changes: keep, else drop> Before/after screenshots at each width in the notes' `## Proof` section
  (<widths>); give their file paths.
- <browser or screenshot work: keep, else drop> Close every browser you start before you report (Playwright or
  Puppeteer `browser.close()`, or the browser MCP's close tool). toli closes the automation browsers a `bin/toli
spawn` run leaves open when it exits; a native subagent's stay open until you close them.
- <bug fixes: keep, else drop> A test that reproduces the bug: paste its failing output before the fix and its
  passing output after.
- Verify your own work before reporting: run every check above yourself and paste the exact commands and their
  output (pass/fail lines and counts). A claim without output is not evidence. If something could not be run, say so
  and why.

## Out of scope

- <things not to touch or change>
- Unrelated refactors, formatting sweeps, dependency upgrades.

## Rules

- Read the project's own AGENTS.md / CLAUDE.md (and any nested ones for files you touch) before editing, and follow
  them.
- Never kill a process you did not start (no `kill` by port, no `pkill`); on a port clash pick another free port or
  report.
- There is no time limit: work until the Goal's Stop when holds. Commit as you go (when the Landing section lets you
  commit; otherwise keep the tree in a state you can describe), because your session may be resumed: a run that shows
  no progress for 30 minutes is stopped and resumed where it stopped, in the same session. Long builds or tests you wait
  on count as progress while they use CPU.
- Work directly in the workspace path above. Never create a git worktree yourself (toli prepares the one a
  worktree-per-task project uses). Stay on the branch named above; never create, switch, or rebase branches.
- Run git only through `bash` (git CLI), never through other git tools or integrations.
- Never push, merge, or open a PR.
- Never discard uncommitted work: no `git reset --hard`, `git checkout -- .`, `git stash`, `git clean`, branch
  deletion, or force push. If git state blocks you, stop and report.
- Never send signals (STOP, CONT, TERM, KILL, ...) to omp, claude, tmux, terminals, the lead, or any process you did
  not start yourself. To pause, stop starting new steps.
- No AI co-author trailers or "generated by" lines in commits, code, or docs.
- Commit only as the Landing section below says, and then only the paths you changed, via
  `<toli root>/bin/toli commit <project> -m "<message>" -- <paths you changed...>` (`--patch <file>` for hunks of a
  file others are also editing; per-task workspaces add `--task <T-id>` so the commit lands on the task branch in its
  workspace). Never plain `git commit`, `git add` or `git stash`, and never a git worktree, not even a temporary one:
  other jawans work in the same checkout, and `bin/toli commit` builds the commit from the branch tip, not from the
  shared index. If it refuses (a moved branch, a revert of a recent commit, a lock file that does not parse, a
  secret), fix the cause; never work around it.
- Of toli's own commands, run only those the Landing section names, and only for task <T-id>. Never run
  `bin/toli task add|start|answer|drop`, `bin/toli job`, `bin/toli delegate`, `bin/toli talk`, `bin/toli share`, or
  `bin/toli lead`.
- Destructive, irreversible, or security-sensitive steps: stop and report instead of doing them.
- Never end your turn while a subagent, background job, build, or poll you started is still running: wait for its
  result in the same turn, then finish the work. A headless run that yields with nothing more to do is over.
- Browsers run headless only; never open a visible browser window.
- Stop and report if a login asks for an OTP, captcha, or any second factor. Never try to get past it.
- Staging and any other shared environment are read-only: look, never change data, settings, or deployments.
- One code folder, one build folder: build and test in the workspace path above, into its normal build folder
  (`target/`, `node_modules/`, `dist/`). Never a private `CARGO_TARGET_DIR` or other side build directory, a `/tmp`
  target, or a `git archive`/temporary copy of the code to verify "cleanly". Cargo's build-directory lock handles
  other jawans' builds: wait for it, never work around it. Build jobs have one cap per machine, `capacity.cargoJobs`
  in config/machine.json (`bin/toli spawn` sets `CARGO_BUILD_JOBS` to it; ~/.cargo/config.toml `[build] jobs`
  mirrors it for every other cargo run): never pass `-j` or set `CARGO_BUILD_JOBS` yourself. Use the project's own
  check/test commands (project notes) unchanged, with no extra `RUSTFLAGS`, `--release`/`--profile`, or `--features`:
  a different build setting in a shared build folder makes every other jawan rebuild. Follow the project notes'
  cleanup rules (what to delete after your last test run) and leave no stray files outside the project path. Low
  disk never stops the work: run `bin/toli disk keep` and carry on (it frees idle build output; docs/disk.md).
- Work on toli itself (the toli repository, not a project): edit in place, in the toli checkout on `develop`; no
  worktrees. The live session runs an installed runtime, so half-edited files do not break it; `TOLI_DEV=1 bin/toli`
  runs your uncommitted code. Run `just check`, paste its tail, then land with
  `bin/toli commit toli -m "<message>" -- <paths you changed>` (`main` moves only at a release). See
  docs/development.md.

## Landing and bookkeeping

Toli root: <absolute path of the toli repo>. Run `bin/toli` from there.

<Keep exactly one of these and drop the others:>

- Ship, verified by a second jawan (default): do not commit and do not close the task. Report; a verifier jawan
  checks your evidence and lands the work.
- Ship, land yourself (the user waived review, or the change is docs/config only): after your checks pass, commit via
  `bin/toli commit` as above, then `bin/toli task done <T-id> --commit <sha> --note "<one line>"`.
- Scout: write your report (format below) to `<toli root>/data/projects/<project>/reports/<T-id>.md`, then
  `bin/toli task done <T-id> --report data/projects/<project>/reports/<T-id>.md`.

Never ask the user directly. Decide, then tell: when the recommended option follows the user's earlier words (the
brief, the project notes, its decisions) and is reversible, take it yourself and report it as `decided: <X>,
reversible by <Y>`. Hold the task in the Needs-you format and report, without guessing, only for: new scope or
behaviour that contradicts the user's words, destructive or irreversible steps, security-sensitive changes, money,
and push to main, MRs/PRs, merges, tags or releases:

    bin/toli task hold <T-id> --question "<one crisp question in plain words>" \
        --option "<choice> => <what happens then>" --option "<choice> => <what happens then>" \
        --recommend <option number> --blocks "<what waits on the answer>" [--reversible]

Give 2-4 options (or none for an open question), each with its consequence. Add `--reversible` when the recommended
option is safe to undo (it may be applied if the hold stays unanswered); never for the kinds above (toli refuses
holds that mention them).

## Report format

    Outcome: <done | partial | blocked> - one sentence
    Stop when: <met | not met: blocked on <what>> - the Goal's Stop when, checked by your last Validate run
    Changes: <file: what changed>, one per line (scout: "none")
    Evidence:
        $ <command>
        <output excerpt>
    Findings / decisions made: <anything the user should know>
    Open questions: <anything needing the user's decision, or "none">
