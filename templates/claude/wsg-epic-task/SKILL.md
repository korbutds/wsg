---
name: wsg-epic-task
description: Start work on a ticket of this epic — a task workspace inside the epic, with what the epic knows; a ticket without a repository is never skipped, it is a question to the owner (--no-code, a repository, or not now) — following the wsg epic guide.
disable-model-invocation: true
argument-hint: "<ticket or what to work on>"
allowed-tools: Bash(wsg *)
---

Run `wsg guide epic`, section "Starting a task", for: $ARGUMENTS

Without `wsg` on PATH, use `npx @korbutds/wsg` instead.
