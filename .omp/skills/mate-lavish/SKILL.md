---
name: mate-lavish
description: Mate's policy for when to show Malik a lavish review page instead of a chat reply, where pages live, and how answers are recorded. Use when mate has 2+ decisions for Malik, a multi-option choice, a large status overview, a scout report with options, or Malik asks to "show me" or "put it on a page".
---

# Lavish pages under mate

`skill://lavish` owns the mechanics (creating the HTML, `npx -y lavish-axi <file>`, `poll`, `end`, playbooks, design
rules). Read it before building a page. This skill decides when mate uses one.

## Page or chat

| Situation | Use |
|---|---|
| One yes/no question | chat |
| One question with two short options | chat |
| Two or more decisions at once (`/ahoy`, several no-mistakes `ask-user` findings) | lavish `input` page |
| A choice between options with real tradeoffs | lavish `comparison` page |
| `/bearings lavish`, or a fleet overview too big for chat | lavish `table` page |
| Scout report with a diagram, code map, or several options | lavish page |
| Malik asks to see something visually | lavish page |

When unsure, give the short chat answer and offer the page.

## Where pages live

- Write artifacts to `.lavish/<name>.html` in the mate repo root. `.lavish/` is gitignored.
- Name pages by purpose and date: `.lavish/ahoy-2026-10-29.html`, `.lavish/bearings-fleet.html`,
  `.lavish/T12-options.html`.
- Copy any images or assets next to the HTML and use relative paths.

## Polling

- Run `npx -y lavish-axi poll <file>` in the foreground, or via `bash` with `async: true`. Never `nohup`, `&`, or
  `disown`.
- Tell Malik the page is open and what to look at first. Keep working on other things only if the poll is async.

## Receipts for tracked batches

When a page collects answers for backlog tasks (held tasks, gate findings), every answer must land somewhere durable:

- Held task answered: `bin/mate task answer <id> "<answer as given>"`.
- no-mistakes finding answered: the matching `no-mistakes axi respond` call.
- After applying the batch, post a receipt back on the page (`poll --agent-reply`) and in chat: one line per item with
  task id, the answer recorded, and what happens next. Items left unanswered stay held and are listed as such.

## Never share

Never run `lavish-axi share` and never use the page's publish-link action; both publish to a public third-party site.
For a portable copy, `npx -y lavish-axi export <file>` only.
