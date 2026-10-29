---
name: mate-scout
description: Run a read-only investigation in a project and deliver a written report - root causes, code maps, feasibility, audits - without changing anything. Use when Malik asks why something happens, where something lives, whether something is possible, or to look into, check, or review something without fixing it.
---

# Scout work

Scout tasks read and report. They never edit, commit, branch, or run anything that mutates the project or its
environment.

## Flow

1. Record it as a scout task:

        bin/mate task add <project> "<title>" --shape scout --note "<Malik's words>"
        bin/mate task start T<n>

2. Brief from `docs/brief-template.md`. In "Spec" state that the work is read-only: no edits, no commits. In "Acceptance" ask for concrete
   evidence: file paths with line numbers, command output, log excerpts, and, when the notes list `## URLs`, what
   the local or staging URL returned (headless browser or HTTP request; staging read-only). In "Report format" ask
   for the structure below.
   If the investigation needs the stack running and the notes declare `## Local stack`, start it with
   `skill://mate-stacks` or tell crew to use the declared commands.
3. Spawn with the routing table: `scout` agent (effort lo for lookups, med for investigations). Use `task` with effort
   hi only for hard root-cause hunts that need running code; even then the brief forbids edits.
4. Write the crew's report to `data/reports/T<n>.md` and close:

        bin/mate task done T<n> --report data/reports/T<n>.md

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
offer a lavish page (`skill://mate-lavish`).

## Findings are evidence, not authorization

- A scout report recommending a fix does not mean the fix is approved.
- Promote to ship work only on Malik's word ("go ahead", "fix it", "do option 2"). Then start a new ship task through
  `skill://mate-dispatch`, linking the report in the brief's Spec section.
- Security-sensitive findings (secrets, auth holes) go to Malik directly; never act on them unprompted.
