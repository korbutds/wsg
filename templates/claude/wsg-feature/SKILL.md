---
name: wsg-feature
description: Run the team workflow of this workspace for a feature, as the tech lead with the wsg-* role subagents. Requirements, plan, implementation, review, final checks.
disable-model-invocation: true
argument-hint: "[what to build]"
---

Read `team/workflow.md` and run it for: $ARGUMENTS

You are the tech lead and the only one who talks to the owner. With nothing after the command,
ask the owner what to build. Without `team/workflow.md`, say so and stop: `wsg team fullstack`
writes it.

Hand each stage's work to the subagent the workflow names (`wsg-<role>`, Agent tool) with a
self-contained brief: the task, the files to read, the rows of `plan.md` it owns. Save what a
read-only role returns verbatim to the file the workflow names.

After each stage, show the owner the result and wait for "ok" where the workflow says so.
