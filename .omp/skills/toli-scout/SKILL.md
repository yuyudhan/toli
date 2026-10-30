---
name: toli-scout
description: Run a read-only investigation in a project and deliver a written report - root causes, code maps, feasibility, audits - without changing anything. Use when Malik asks why something happens, where something lives, whether something is possible, or to look into, check, or review something without fixing it.
---

# Scout work

Scout tasks read and report. They never edit, commit, branch, or run anything that mutates the project or its
environment.

## Flow

1. Record it as a scout task:

        bin/toli task add <project> "<title>" --shape scout --note "<Malik's words>"
        bin/toli task start T<n>

2. Brief from `docs/brief-template.md`. In "Spec" state that the work is read-only: no edits, no commits. In "Acceptance" ask for concrete
   evidence: file paths with line numbers, command output, log excerpts, and, when the notes list `## URLs`, what
   the local or staging URL returned (headless browser or HTTP request; staging read-only). In "Report format" ask
   for the structure below. In "Landing" keep the Scout option: the jawan writes its report to
   `data/projects/<project>/reports/T<n>.md` and closes the task itself with `bin/toli task done T<n> --report data/projects/<project>/reports/T<n>.md`.
   If the investigation needs the stack running and the notes declare `## Local stack`, tell jawans to use the
   declared commands (`skill://toli-stacks`).
3. Spawn with the routing table: `task` agent (effort lo for lookups, med for investigations, hi only for hard
   root-cause hunts that need running code); the brief forbids edits to the project. Not the read-only `scout` agent:
   it cannot write the report or close the task. Then end the turn (`skill://toli-dispatch`, the async rule).
4. When the result arrives, the report is already written and the task closed. Relay the answer; never write or
   rewrite the report yourself. If the jawan could not close the task, dispatch a `sonic` jawan to do it.

## Report structure

    # T<n>: <title>
    Question: <Malik's words>
    Answer: <one or two sentences>
    Evidence:
        - path/to/file.ts:42 - what it shows
        - `command` output excerpt
    Options (if any): short list with tradeoffs
    Unknowns: what was not verified and why

Tell Malik the answer first, in plain words, then where the full report is. If there are two or more options to weigh,
offer a lavish page (`skill://toli-lavish`).

## Findings are evidence, not authorization

- A scout report recommending a fix does not mean the fix is approved.
- Promote to ship work only on Malik's word ("go ahead", "fix it", "do option 2"). Then start a new ship task through
  `skill://toli-dispatch`, linking the report in the brief's Spec section.
- Security-sensitive findings (secrets, auth holes) go to Malik directly; never act on them unprompted.
