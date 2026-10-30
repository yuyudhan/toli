---
name: toli-release
description: Run a project's release from the `## Release` section of its notes file - integration branch into main, release notes file, tag, staging smoke, issue-tracker updates (Jira, GitHub/GitLab issues, Linear, ... through the tools the recipe names) - with jawans doing every step and Sardar taking Malik's word in between. Use when Malik asks to release, cut, tag, or ship a version of a project, or to prepare release notes. Push, merge and tag only on Malik's word for that release.
---

# Releasing a project

A release follows the project's own recipe, never a guess. The recipe lives in `data/projects/<project>/notes.md` under
`## Release`. No section means no recipe: ask Malik for the steps once, then dispatch a `sonic` jawan to write them
into that section (with his confirmation), then continue.

Sardar never runs a release step itself. It runs the release as two jawan phases with Malik's word in between:
**prepare** (read-only on remotes, no push/merge/tag) and **ship** (only the actions Malik approved, quoted verbatim in
the brief). Each phase is a background spawn; end the turn after dispatching and relay the result when it arrives.

## Hard limits

- Push, merge, and tag only on Malik's explicit word for this release. "Prepare the release" is not that word; "ship
  v1.4.0" is. When unsure, stop at the step before and ask.
- The ship brief quotes his word verbatim and allows exactly the approved actions (merge, tag, push) and no others.
- Never force-push, rewrite tags, delete branches, or move an existing tag. A wrong tag goes to Malik.
- Staging is read-only during the smoke: look, do not change data, stop on OTP/captcha and report.
- Issue tracker: update only the issues that are actually in this release, and only to the states the recipe names.
- Malik's name never appears in release notes, tags, commits, or PR text.

## What the `## Release` section should give

Typical entries (only what the project actually uses):

- integration branch and main branch (e.g. work lands on an integration branch, release merges it into main)
- how the version is chosen (semver bump rules, tag format such as `v<major>.<minor>.<patch>`)
- release notes file path and format (e.g. `docs/releases/<tag>.md` plus an index), audience, grouping, and whether
  each item carries its issue key
- merge method (PR/MR through `bin/toli pr`, or a local merge), and anything that must happen before the tag
- staging URL and the smoke checks to run after deploy
- issue tracker, if any: which one (e.g. Jira, GitHub or GitLab issues, Linear), the tools to reach it (e.g. the
  Atlassian MCP tools for Jira, `gh issue`, `glab issue`), project key, the state names (e.g. "Ready for release" ->
  "Released"), and the fix-version or milestone convention
- post-deploy steps and who announces the release

## Phase 1: prepare (jawan, `task` effort med)

The brief (`docs/brief-template.md`, Landing "land yourself") points at the notes' `## Release` section and asks the
jawan to:

1. **Scope.** From the integration branch, list what is new since the last tag:
   `git -C projects/<p> log --oneline <last-tag>..<integration-branch>` (find the last tag with
   `git describe --tags --abbrev=0 <main-branch>`). Collect the issue keys from commit subjects/bodies and branch names.
2. **Issue check** (when the recipe names a tracker). For each key, read the issue with the tools the recipe names
   (for Jira, e.g. the Atlassian MCP `getJiraIssue`, or `searchJiraIssuesUsingJql` for the fix version) to confirm its
   status and title. Flag keys that are not in the expected state and issues in the release that have no commit.
3. **Version and notes.** Propose the next version per the recipe. Write the release notes file in the format the
   recipe gives (user-facing words, grouped by area, issue key per item, post-deploy steps), update any index file,
   and commit it on the integration branch with `bin/toli commit` so the tagged commit contains the notes.
4. **Report**: version, notes path, flagged issues, and the exact next steps (merge, tag, push) with commands.

## Show Malik

One message from the prepare report: version, notes path (and a lavish page built by a jawan for long notes), flagged
issues, and the exact next steps. Wait for his word; record any open question with `bin/toli task hold`.

## Phase 2: ship (jawan, `task` effort med, on Malik's word)

The brief quotes his word and asks the jawan to:

5. **Merge to main** the way the recipe says:
    - via PR/MR: `bin/toli push <p>`,
      `bin/toli pr create <p> --title "Release <tag>" --body-file <notes> --base <main-branch>`,
      `bin/toli pr status <p> <id>` until CI is green, then `bin/toli pr merge <p> <id>`;
    - or a local fast-forward/merge if the recipe says so, followed by `bin/toli push <p>` from the main branch.
6. **Tag**: `git -C projects/<p> tag -a <tag> -m "<tag>" <main-branch-commit>` then
   `git -C projects/<p> push origin refs/tags/<tag>` (one tag, never `--tags`, never `-f`).
7. **Staging smoke.** After the deploy the recipe describes, run its smoke checks against staging (headless browser
   for UI, read-only requests for APIs), and save evidence (screenshots, responses) under `data/projects/<project>/reports/`.
8. **Issue updates** (when the recipe names a tracker). Move each issue in the release to the state the recipe names
   and set the fix version or milestone if it uses one, with the tools it names (for Jira, e.g.
   `getTransitionsForJiraIssue`, `transitionJiraIssue`, `editJiraIssue`). Add a short comment with the tag and notes
   link only when the recipe asks for it.
9. **Report**, then `bin/toli task done <id> --note "<tag>"`.

## Report to Malik

Outcome first: tag, main commit, release notes path/URL, PR/MR URL, smoke result with evidence, issues moved (and
any that could not be), post-deploy steps still open for him.

## When something fails

CI red, merge conflict, smoke failure, or an issue transition missing: the jawan stops and reports exactly what failed
with its output. Relay it with a proposed next step. Nobody retries destructive steps or works around protections.
