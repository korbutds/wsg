# wsg --json contract

For scripts and apps that drive wsg. With `--json`, a command prints exactly one JSON document on
stdout — the envelope — and nothing else there; stderr carries only diagnostics (a rollback's
messages, a crash's stack). This file describes `schemaVersion` 1, as `lib/json.js` and
`bin/cli.js` produce it.

Commands that take `--json`: `new`, `add`, `remove`, `check`, `list`, `status`, `close`, and
`wsg --version --json`. Any other command given `--json` refuses it as an unknown flag, in the
envelope (`invalid_input`). `--json` is read before anything else can refuse, so a flag error, a
settings file that can't be read or an unknown command is an envelope too.

## Rules

- Every key described here is always present. The tables list them in the order wsg prints them
  today, but don't rely on key order: read keys by name. A value that is unknown or does not apply
  is `null`; a list is always a list, possibly empty.
- Dates are UTC dates, `YYYY-MM-DD`: `created`, `closed`, and the date in a `[done <date>]` marker.
  Near midnight they can differ from the local date.
- Paths are absolute.
- `error.code`, `error.rollback`, `kind`, `mode`, `status` and `level` are stable values to branch
  on. `message`, `details`, `warnings`, `problems` and the text of check items are for people: in the
  UI language (`WSG_LANG`), never to be parsed.
- Exit codes are those of the plain commands: `0` ok, `1` a step failed and was rolled back, check
  found errors, or an internal error, `2` invalid input (nothing was changed), `130` interrupted.
- The plain output of every command, `--dry-run` included, is unchanged by this contract: only
  with `--json` is it an envelope.
- `--json` on `new` never starts the agent.

## Envelope

```json
{"schemaVersion": 1, "wsgVersion": "0.6.1", "ok": true, "command": "close", "dryRun": false,
 "result": {}, "error": null, "warnings": []}
```

| Key | Value |
|---|---|
| `schemaVersion` | `1`. Raised on any breaking change: a key removed or renamed, a meaning or a value changed. New keys may be added without a raise. |
| `wsgVersion` | the wsg that printed it |
| `ok` | `true` when the command did what was asked; `false` with `error` set |
| `command` | the command (`check` for `--check` too); `null` for an unknown command, a global flag or `--version` |
| `dryRun` | `true` when the command ran with `--dry-run` (a command that has one) |
| `result` | the command's outcome, below; on an error it may still hold the refused plan (a refused `add`, `new`, `remove`, `status`, `close`, a `check` that found errors), else `null` |
| `error` | `null` on success, else the object below |
| `warnings` | text: the command's own warnings, then those printed on the way |

`error`:

| Key | Value |
|---|---|
| `code` | `invalid_input` (exit 2: refused before anything was touched), `busy` (exit 2: another wsg command holds the workspace's lock), `step_failed` (exit 1: a step failed, rolled back), `check_failed` (exit 1: `wsg check` found errors), `interrupted` (exit 130: Ctrl+C, a closed terminal, `kill`), `internal` (exit 1: a crash, an error from outside a step; also a settings file that can't be read and the refusal on Windows, both with `rollback: "none"`) |
| `exitCode` | the process's exit code for that code |
| `message` | text |
| `details` | text: each refusal of a refused plan; the fail lines of a `check_failed` |
| `rollback` | `none` — nothing had been changed; `done` — put back as it was, except `kept` and the files a worktree got copied in (`.env`, `node_modules`) or ignored files deleted with `--delete-ignored`; `incomplete` — a step of the rollback failed, the workspace may be broken; `unknown` — no rollback ran and nothing says whether anything changed |
| `kept` | paths the rollback left as they are, because they were edited during the run |

## Results

### Source

`new`, `add` and `list` describe a source the same way:

| Key | Value |
|---|---|
| `name` | its name in the workspace |
| `mode` | `worktree`, `link` or `reference` (a link outside git, never branched) |
| `path` | the repository or directory; for a link, its target |
| `workspacePath` | where it is in the workspace |
| `branch`, `base` | a worktree's branch and what it started from; `null` for a link |
| `target`, `verify`, `note` | the merge target, the verification command, the note |
| `carry` | the ignored files a worktree got |
| `cloneNm` | whether `node_modules` was cloned into the worktree |
| `from` | `"epic"` for a source a task of an epic took from its epic |
| `task` | in an epic, the defaults its tasks get: `{branch, base, carry, cloneNm}` (`base` `null`: the default); else `null` |

### new

`{workspace, kind, slug, title, epic, ticket, ticketText, status, sources, launched}`. `epic` is
the epic's slug or `null`; `ticket` the parsed key, `ticketText` the text as given (a standalone
task keeps its ticket only in `AGENTS.md`, not in its state, so `list` gives it `ticket: null`); `status` is
`"open"` (`null` for an epic); `sources` are the sources taken from the epic, as planned or
attached; `launched` is always `false`.

### add

`{workspace, source, files, settingsChanged, backupBranch, notes, plan}`. `files` are the paths
written; `backupBranch` the `backup/…` branch `--reset-to-base` made; `notes` what the plain add
says about the source before it starts. `plan` is `{start, branchExists, remoteBranch,
carryCandidates}` for a dry run or a refusal, `null` once done.

### remove

`{workspace, name, path, mode, branchKept, ignored, files, settingsChanged}`. `path` is the source's
repository or directory and `mode` how it was attached (as in Source), both `null` for a name the
workspace has no source by; `branchKept` is the worktree's branch, which is never deleted;
`ignored` the ignored files that go with the worktree, as absolute paths; `files` the paths removed
or rewritten (the source in the workspace, its rule, the generated files that change);
`settingsChanged` whether `.claude/settings.json` changes, so a new session is needed.

### check

`{workspace, kind, summary: {fails, warns}, sections: [{title, items: [{level, text}]}]}`. `kind` is
what `.claude/ws-kind` says, `task` when there is none. A section
is a heading the plain check prints, its items the lines under it: `level` `ok`, `warn`, `fail`, or
`info` for a note. check's warnings are items, not the envelope's `warnings`. Errors found: `ok`
`false`, `check_failed`, exit 1, `result` present.

### list

`{wsgVersion, wsRoot, workspaces}`. Read-only, without git. `workspaces` holds the roots — epics,
tasks and processes in `WS_ROOT` — each epic's tasks in its `tasks`. Each entry:

| Key | Value |
|---|---|
| `slug` | the directory name |
| `kind` | `task`, `process`, `epic`; `null` when the state does not read, or for a 0.1 workspace whose `.claude/ws-kind` names no known kind |
| `path` | the workspace, as `WS_ROOT` gives it (a symlinked `WS_ROOT` is kept) |
| `title` | from the state |
| `ticket` | the key a task of an epic keeps in its state; `null` for anything else, a standalone task with a ticket included (it keeps it only in `AGENTS.md`) |
| `status` | `open`, `review`, `done` for a task or a process — or a value a later wsg wrote, as it is (`problems` says so); `null` for an epic, a 0.1 workspace and one whose state does not read |
| `closed` | the UTC date it was closed, while done; else `null` |
| `forEpicPending` | for a task of an epic: `true` while `## For the epic` in its `notes.md` has entries (lines outside HTML comments), i.e. not merged into the epic yet; `null` for anything else |
| `created` | the UTC date the workspace was made, from the state |
| `epic` | the epic its state names, or `null` |
| `legacy` | `true` for a wsg 0.1 workspace (no `.claude/wsg.json`) |
| `problems` | text: why the state does not read, a status this wsg doesn't know, a source entry that is no source, a task in the wrong place |
| `extraDirs` | the directories a session reads besides its own: the epic's for a task of one, then its link and reference paths |
| `sources` | Source objects |
| `tasks` | an epic's tasks, entries like this one; `[]` for anything else |

### status and close

`wsg close <task>` is `wsg status <task> done`, with the same result. `wsg status <task>` reads.

`{workspace, task, epic, status, previous, closed, changed, forEpicPending, sources, tasksMdUpdated}`

| Key | Value |
|---|---|
| `workspace` | the task, as given (`..` and a trailing `/` resolved); a task directory that is itself a symlink is given as the task it leads to |
| `task` | its directory name |
| `epic` | its epic's slug, or `null` |
| `status`, `previous` | the status after and before; equal when reading |
| `closed` | the UTC date it was closed, `YYYY-MM-DD` as `created`, while done; else `null` |
| `changed` | `false` when reading, or setting the status it has (nothing written) |
| `forEpicPending` | as in list |
| `sources` | `[{name, mode, branch, dirty, unpushed}]`. Git is asked only on a move to done, and only about worktrees: then `dirty` is the list of changed files as `git status --porcelain` shows them (`[]`: clean) and `unpushed` the number of commits not on the branch's upstream, or without one not on its base. `dirty: null` and `unpushed: null` mean git was not asked, or could not tell |
| `tasksMdUpdated` | whether the epic's `tasks.md` block changed (planned, in a dry run) |

Only `.claude/wsg.json` and the epic's `tasks.md` block are written, in one transaction. Uncommitted
or unpushed work and entries left under `## For the epic` are warnings, never refusals; so is done
set for a task of an epic from inside its own workspace (a standalone task or a process gets no
such warning: it has no epic session).

### --version

`wsg --version --json`: `result` is `{version}`, `command` `null`.
