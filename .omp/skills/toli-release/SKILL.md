---
name: toli-release
description: Run a project's release from the `## Release` section of its notes file - integration branch into main, release notes file, tag, staging smoke, Jira transitions through the Atlassian MCP tools. Use when Malik asks to release, cut, tag, or ship a version of a project, or to prepare release notes. Push, merge and tag only on Malik's word for that release.
---

# Releasing a project

A release follows the project's own recipe, never a guess. The recipe lives in `data/notes/<project>.md` under
`## Release`. No section means no recipe: ask Malik for the steps once, write them into that section (with his
confirmation), then continue.

## Hard limits

- Push, merge, and tag only on Malik's explicit word for this release. "Prepare the release" is not that word; "ship
  v1.4.0" is. When unsure, stop at the step before and ask.
- Never force-push, rewrite tags, delete branches, or move an existing tag. A wrong tag goes to Malik.
- Staging is read-only during the smoke: look, do not change data, stop on OTP/captcha and ask Malik.
- Jira: transition only the issues that are actually in this release, and only to the states the recipe names.
- Malik's name never appears in release notes, tags, commits, or PR text.

## What the `## Release` section should give

Read it fully before starting. Typical entries (only what the project actually uses):

- integration branch and main branch (e.g. work lands on an integration branch, release merges it into main)
- how the version is chosen (semver bump rules, tag format such as `v<major>.<minor>.<patch>`)
- release notes file path and format (e.g. `docs/releases/<tag>.md` plus an index), audience, grouping, and whether
  each item carries its Jira key
- merge method (PR/MR through `bin/toli pr`, or a local merge), and anything that must happen before the tag
- staging URL and the smoke checks to run after deploy
- Jira project key, the transition names (e.g. "Ready for release" -> "Released"), and the fix-version convention
- post-deploy steps and who announces the release

## Flow

1. **Scope.** From the integration branch, list what is new since the last tag:
   `git -C projects/<p> log --oneline <last-tag>..<integration-branch>` (find the last tag with
   `git describe --tags --abbrev=0 <main-branch>`). Collect the Jira keys from commit subjects/bodies and branch names.
2. **Jira check.** For each key, read the issue with the Atlassian MCP tools (`getJiraIssue`, or
   `searchJiraIssuesUsingJql` for the fix version) to confirm its status and title. Flag keys that are not in the
   expected state and issues in the fix version that have no commit; these go to Malik before the release.
3. **Version and notes.** Propose the next version per the recipe. Have a jawan write the release notes file
   in the format the recipe gives (user-facing words, grouped by area, Jira key per item, post-deploy steps), and
   update any index file. Commit it on the integration branch with `bin/toli commit` so the tagged commit contains
   the notes.
4. **Show Malik.** One message: version, notes path (and a lavish page for long notes), flagged Jira issues, and
   the exact next steps (merge, tag, push). Wait for his word.
5. **Merge to main** (on his word), the way the recipe says:
    - via PR/MR: `bin/toli push <p>`,
      `bin/toli pr create <p> --title "Release <tag>" --body-file <notes> --base <main-branch>`,
      `bin/toli pr status <p> <id>` until CI is green, then `bin/toli pr merge <p> <id>`;
    - or a local fast-forward/merge if the recipe says so, followed by `bin/toli push <p>` from the main branch.
6. **Tag** (on his word): `git -C projects/<p> tag -a <tag> -m "<tag>" <main-branch-commit>` then
   `git -C projects/<p> push origin refs/tags/<tag>` (one tag, never `--tags`, never `-f`).
7. **Staging smoke.** After the deploy the recipe describes, run its smoke checks against staging (headless browser
   for UI, read-only requests for APIs), save evidence (screenshots, responses) under `data/reports/`.
8. **Jira transitions.** With `getTransitionsForJiraIssue` and `transitionJiraIssue`, move each issue in the release
   to the state the recipe names; set the fix version with `editJiraIssue` if the recipe uses one. Add a short
   comment with the tag and notes link (`addCommentToJiraIssue`) only when the recipe asks for it.
9. **Report.** Outcome first: tag, main commit, release notes path/URL, PR/MR URL, smoke result with evidence,
   Jira issues moved (and any that could not be), post-deploy steps still open for Malik.

## When something fails

CI red, merge conflict, smoke failure, or a Jira transition missing: stop, report exactly what failed with its
output, and propose the next step. Do not retry destructive steps or work around protections.
