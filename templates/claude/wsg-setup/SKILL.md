---
name: wsg-setup
description: Set up this wsg workspace with the owner — the task, its repositories and the verification command — following the wsg setup guide.
disable-model-invocation: true
argument-hint: "[what to add or fix]"
allowed-tools: Bash(wsg *)
---

Run `wsg guide setup` and follow it for: $ARGUMENTS

With nothing after the command, go through the guide from the start; in a workspace that is
already set up, fill only the gaps. Without `wsg` on PATH, use `npx @korbutds/wsg` instead.
