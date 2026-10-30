---
name: toli-deliver
description: Land verified jawan work in a project using the right delivery mode - commit on the current branch (default), a branch plus PR, or the no-mistakes gate - with jawans carrying out every step and Sardar only taking Malik's word and relaying the landing. Use after a verifier passes jawan work, or when Malik asks for a branch, a PR, a push, or to ship through no-mistakes.
---

# Delivering work

Delivery happens only after an independent verifier jawan passed the work (`skill://toli-dispatch`, step 6). The
project's mode comes from `bin/toli project list --json`; Malik's word for a specific change overrides it. Sardar never
runs a delivery step itself: it takes Malik's word, writes it verbatim into a brief, dispatches a jawan, ends the
turn, and relays the result.

## Hard limits

- Never push, merge, or open a PR without Malik's explicit word for that specific change. A project's `pr` mode is a
  preference, not standing permission.
- A brief that pushes, opens a PR, merges, or tags quotes Malik's word for that action verbatim in place of the
  brief's "Never push, merge, or open a PR" rule, and allows exactly that action and nothing more.
- Branches only when Malik asks, or when the project's mode (`pr`, `no-mistakes` without a fixed branch) is his
  standing choice of a work branch per change.
- Never discard uncommitted work: no `git reset --hard`, `git checkout -- .`, `git stash`, `git clean`, branch
  deletion, or force push. If git state is in the way, the jawan stops and reports; ask Malik.
- No AI co-author trailers; `bin/toli commit` strips them. Never put "Malik" in commit messages or PR bodies.

## Mode: commit (default)

The verifier jawan (or a land-yourself implementer) already did it:

    bin/toli commit <project> -m "<message>" -- <paths the jawan changed...>
    bin/toli task done <id> --commit <sha>

Stages only the given paths, commits on whatever branch the project is on, never pushes. Commit messages follow the
project's own conventions (its AGENTS.md / recent `git log`).

When the project has a fixed working branch (`branch` in `bin/toli project list`), `bin/toli commit` refuses on any
other branch. Nobody switches, creates, or reconfigures branches to get past it: tell Malik which branch the clone is
on and ask how to proceed (the refusal message lists the options).

## Mode: pr

When the project's mode is `pr` (Malik chose pull/merge requests at `/add-project` or `/setup-project`), or Malik
asked for a branch or PR on this work. The mode makes a work branch the default; pushing and opening the PR still
need his word for the change.

1. Branch before the implementer starts, if possible: put `bin/toli branch <project> <branch>` as the first step of
   the implementer's brief (the project's mode, or Malik's request for the branch, is the word for it).
2. The verifier commits with `bin/toli commit` as above.
3. Ask Malik for the go-ahead to push and open the PR, unless he already said so for this change.
4. Dispatch a `sonic` jawan whose brief quotes his word and runs (readiness first with `bin/toli forge <project>`;
   works for GitHub, GitLab incl. self-hosted, and Bitbucket Cloud):

        bin/toli push <project>
        bin/toli pr create <project> --title "<title>" --body-file <file> [--base <branch>] [--draft]
        bin/toli task done <id> --commit <sha> --note "<full PR URL>"

    `pr create` refuses until the branch is pushed and prints the PR/MR URL. Never raw `git push`, never force, and
    never `gh`/`glab`/the Bitbucket API directly for these steps.

5. Follow-ups (`bin/toli pr status <project> [<id>]`: state, mergeable, CI) go to a jawan too, run as `bash` async or
   inside a brief. `bin/toli pr merge <project> <id>` only in a brief that quotes Malik's word to merge that PR.

## Mode: no-mistakes

When the project's mode is `no-mistakes`, or Malik asked for a branch/PR through the gate on this work. The gate
validates committed history on a non-default branch: the project's fixed branch when it has one, otherwise branch
first (step 1 above). Let the verifier commit, then dispatch a gate jawan per `skill://toli-nm`. The gate itself pushes
and opens the PR, so ask Malik for his word on this change first unless he already gave it.

## Landing report

From the jawan's report, outcome first, in plain words:

- project and what changed (one or two lines)
- branch and commit sha
- evidence that passed (test or smoke command)
- full PR URL, e.g. `https://github.com/owner/repo/pull/123`, never "PR #123"
- anything Malik must do next (review, merge, answer a question)
