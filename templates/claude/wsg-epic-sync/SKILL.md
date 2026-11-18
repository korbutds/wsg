---
name: wsg-epic-sync
description: Sync the other tasks of this epic from the tracker into tasks.md, read-only — every child issue listed by its key, none skipped silently — following the wsg epic guide.
disable-model-invocation: true
argument-hint: "[what to look at]"
allowed-tools: Bash(wsg *)
---

Run `wsg guide epic`, section "Syncing", for: $ARGUMENTS

Without `wsg` on PATH, use `npx @korbutds/wsg` instead.
