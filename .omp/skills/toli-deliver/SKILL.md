---
name: toli-deliver
description: Land verified jawan work in a project using the right delivery mode - commit on the current branch (default), a branch plus PR, or the no-mistakes gate - and report the landing to Malik. Use after jawan work is verified, or when Malik asks for a branch, a PR, a push, or to ship through no-mistakes.
---

# Delivering work

Delivery happens only after evidence is verified (`skill://toli-dispatch`, step 6). The project's mode comes from
`bin/toli project list --json`; Malik's word for a specific change overrides it.

## Hard limits

- Never push, merge, or open a PR without Malik's explicit word for that specific change. A project's `pr` mode is a
  preference, not standing permission.
- Branches only when Malik asks.
- Never discard uncommitted work: no `git reset --hard`, `git checkout -- .`, `git stash`, `git clean`, branch
  deletion, or force push. If git state is in the way, stop and ask Malik.
- No AI co-author trailers; `bin/toli commit` strips them. Never put "Malik" in commit messages or PR bodies.

## Mode: commit (default)

    bin/toli commit <project> -m "<message>" -- <paths the jawan changed...>
    bin/toli task done <id> --commit <sha>

Stages only the given paths, commits on whatever branch the project is on, never pushes. Commit messages follow the
project's own conventions (check its AGENTS.md / recent `git log`).

When the project has a fixed working branch (`branch` in `bin/toli project list`), `bin/toli commit` refuses on any
other branch. Do not switch, create, or reconfigure branches to get past it: tell Malik which branch the clone is on
and ask how to proceed (the refusal message lists the options).

## Mode: pr

Only when Malik asked for a branch or PR on this work.

1. Create the branch before the jawan starts, if possible:

        bin/toli branch <project> <branch>

2. Commit with `bin/toli commit` as above.
3. Ask Malik for the go-ahead to push and open the PR, unless he already said so for this change.
4. Push and open the PR/MR through Sardar (works for GitHub, GitLab incl. self-hosted, and Bitbucket Cloud; check
   readiness with `bin/toli forge <project>` first):

        bin/toli push <project>
        bin/toli pr create <project> --title "<title>" --body-file <file> [--base <branch>] [--draft]

    `pr create` refuses until the branch is pushed and prints the PR/MR URL. Never push with raw `git push`, never
    force, and never call `gh`/`glab`/the Bitbucket API directly for these steps.

5. Record it: `bin/toli task done <id> --commit <sha> --note "<full PR URL>"`.
6. Follow up with `bin/toli pr status <project> [<id>]` (state, mergeable, CI). `bin/toli pr merge <project> <id>`
   only on Malik's explicit word to merge that PR.

## Mode: no-mistakes

Only when Malik asked for a branch/PR on this work. The gate validates committed history on a non-default branch, so:

1. `bin/toli branch <project> <branch>` (if not already on a feature branch).
2. Commit the verified work with `bin/toli commit`.
3. Drive the gate per `skill://toli-nm`. The gate itself pushes and opens the PR; Malik's request for the branch/PR
   is that word.

## Landing report

Outcome first, then detail, in plain words:

- project and what changed (one or two lines)
- branch and commit sha
- evidence that passed (test or smoke command)
- full PR URL, e.g. `https://github.com/owner/repo/pull/123`, never "PR #123"
- anything Malik must do next (review, merge, answer a question)
