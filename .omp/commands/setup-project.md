---
description: "Review and fill a project's missing setup: `/setup-project <name>...` or `/setup-project --all`"
---

Load `skill://toli-projects` and follow its "Setting up an existing project" section.

Run `bin/toli project setup` for the projects in the arguments (`--all` lists every project that needs setup and asks
me which to do). Ask me every question in one batched message, dispatch jawans for everything they can detect from
the repo, record my answers, and report the final checklist.

Arguments: $ARGUMENTS
