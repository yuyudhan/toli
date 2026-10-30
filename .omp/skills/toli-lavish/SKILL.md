---
name: toli-lavish
description: Sardar's policy for when to show Malik a lavish review page instead of a chat reply, who builds it (a jawan, never Sardar), where pages live, and how answers are recorded. Use when Sardar has 2+ decisions for Malik, a multi-option choice, a large status overview, a scout report with options, or Malik asks to "show me" or "put it on a page".
---

# Lavish pages under Sardar

`skill://lavish` owns the mechanics (creating the HTML, `npx -y lavish-axi <file>`, `poll`, `end`, playbooks, design
rules). This skill decides when Sardar uses a page. Sardar never builds or polls a page itself: a jawan does, so the
chat stays free.

## Page or chat

| Situation                                                                          | Use                       |
| ---------------------------------------------------------------------------------- | ------------------------- |
| One yes/no question                                                                | chat                      |
| One question with two short options                                                | chat                      |
| Two or more Needs-you decisions (`/ahoy`, several no-mistakes `ask-user` findings) | one numbered list in chat |
| The same, when the user prefers pages (`data/preferences.md`) or asks for one      | lavish `input` page       |
| A choice between options with real tradeoffs                                       | lavish `comparison` page  |
| `/bearings lavish`, or a fleet overview too big for chat                           | lavish `table` page       |
| Scout report with a diagram, code map, or several options                          | lavish page               |
| Malik asks to see something visually                                               | lavish page               |

When unsure, give the short chat answer and offer the page.

## Dispatching the page

Spawn a `task` jawan (effort lo/med) with a `TOLI_BRIEF v1` brief that holds:

- the content: the questions, options, and tradeoffs verbatim, or the paths it must read (`bin/toli needs --json` for
  held tasks, digest JSON, report files);
- the playbook (`input`, `comparison`, `table`) and the page path (below);
- "Read `skill://lavish` first. Build and open the page, then run `npx -y lavish-axi poll <file>` through `bash`
  with `async: true` until the user submits. Return every answer verbatim, keyed by item. Never run
  `lavish-axi share` or the publish-link action. Do not run `bin/toli task answer`; return the answers."

Then tell Malik in one line that the page is coming and what to look at first, and end the turn. For a display-only
page (an overview with nothing to answer) the brief says to open it and return without polling.

## Where pages live

- Artifacts go in `.lavish/<name>.html` in the toli repo root. `.lavish/` is gitignored.
- Name pages by purpose and date: `.lavish/ahoy-2026-10-29.html`, `.lavish/bearings-fleet.html`,
  `.lavish/T12-options.html`.
- Images or assets sit next to the HTML with relative paths.

## Receipts for tracked batches

When the jawan's answers arrive for backlog tasks (held tasks, gate findings), every answer must land somewhere
durable:

- Held task answered: `bin/toli task answer <id> "<answer as given>"` (Sardar bookkeeping).
- no-mistakes finding answered: dispatch a gate jawan with the matching `no-mistakes axi respond` (`skill://toli-nm`).
- Then a receipt in chat: one line per item with task id, the answer recorded, and what happens next. Items left
  unanswered stay held and are listed as such.

## Never share

Never run `lavish-axi share` and never use the page's publish-link action; both publish to a public third-party site.
For a portable copy, a jawan runs `npx -y lavish-axi export <file>` only.
