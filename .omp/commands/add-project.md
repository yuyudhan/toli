---
description: "Register a project: `/add-project <name> <git-url> [machine] [delivery answers]`"
---

Load `skill://toli-projects` and follow its "Adding a project" section.

Add the project described in the arguments (name, git URL, and optionally the machine it is cloned on). Unless the
arguments already answer it, first ask me the one batched delivery question from the skill (pull/merge requests,
commit on the current branch, or commit on a fixed branch; the no-mistakes gate; the test/smoke command), then have a
jawan clone it, record my answers with `bin/toli project set`, seed `data/projects/<name>/notes.md`, and report forge
and no-mistakes readiness.

Arguments: $ARGUMENTS
