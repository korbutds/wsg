# wsg --json contract

For scripts and apps that drive wsg. With `--json`, a command prints exactly one JSON document on
stdout — the envelope — and nothing else there; stderr carries only diagnostics (a rollback's
messages, a crash's stack). This file describes `schemaVersion` 1, as `lib/json.js` and
`bin/cli.js` produce it.

Commands that take `--json`: `new`, `add`, `remove`, `refresh`, `check`, `list`, `status`, `close`,
`context add`, `context note`, `context remove`, `context list`, `mcp add`, `mcp remove`,
`mcp disable`, `mcp enable`, `mcp list`, and `wsg --version --json`. Any other command given `--json` refuses it as an unknown flag, in the
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
{"schemaVersion": 1, "wsgVersion": "0.7.0", "ok": true, "command": "close", "dryRun": false,
 "result": {}, "error": null, "warnings": []}
```

| Key | Value |
|---|---|
| `schemaVersion` | `1`. Raised on any breaking change: a key removed or renamed, a meaning or a value changed. New keys may be added without a raise. |
| `wsgVersion` | the wsg that printed it |
| `ok` | `true` when the command did what was asked; `false` with `error` set |
| `command` | the command (`check` for `--check` too); a two-word command is named by both words, separated by one space: `context add`, `context note`, `context remove`, `context list`, `mcp add`, `mcp remove`, `mcp disable`, `mcp enable`, `mcp list`; `null` for an unknown command (`context` or `mcp` alone, or with a word it doesn't have, included), a global flag or `--version` |
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

`{workspace, kind, slug, title, epic, ticket, ticketText, status, noCode, spec, sources, launched}`. `epic` is
the epic's slug or `null`; `ticket` the parsed key, `ticketText` the text as given (a standalone
task keeps its ticket only in `AGENTS.md`, not in its state, so `list` gives it `ticket: null`); `status` is
`"open"` (`null` for an epic); `noCode` is `true` for `--no-code` (a task without a repository:
it takes no source of its epic), else `false`; `spec` is `true` for `--spec` (`spec.md`, `plan.md`
and the Stages section of `AGENTS.md`), else `false`; `sources` are the sources taken from the epic, as planned or
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
| `status` | `open`, `review`, `done`, `archived` for a task or a process — or a value a later wsg wrote, as it is (`problems` says so); `null` for an epic, a 0.1 workspace and one whose state does not read |
| `closed` | the UTC date it was closed, while done; else `null` |
| `archived` | the UTC date `wsg archive` took it, an epic included; else `null` |
| `noCode` | `true` for a task made with `wsg new --no-code` (no repository, no branch: `wsg add` takes `--link` and `--reference` only); `false` for any other workspace whose state reads; `null` for a 0.1 workspace and one whose state does not read |
| `spec` | `true` for a task made with `wsg new --spec`; `false` for any other workspace whose state reads; `null` as for `noCode` |
| `checklist` | a task's `checklist.md` counted: `{done, total}` — checkboxes in `-`, `*`, `+` or `1.` list items at any indent, `[x]` or `[X]` done; lines in HTML comments or fenced code blocks and lines that say FILL IN are not counted. `null` for a task without the file (made before wsg 0.8: none is added) and for anything but a task |
| `forEpicPending` | for a task of an epic: `true` while `## For the epic` in its `notes.md` has entries (lines outside HTML comments), i.e. not merged into the epic yet; `null` for anything else |
| `created` | the UTC date the workspace was made, from the state |
| `epic` | the epic its state names, or `null` |
| `legacy` | `true` for a wsg 0.1 workspace (no `.claude/wsg.json`) |
| `problems` | text: why the state does not read, a status this wsg doesn't know, a source entry that is no source, a task in the wrong place |
| `extraDirs` | the directories a session reads besides its own: the epic's for a task of one, then its link and reference paths |
| `sources` | Source objects; `[]` while archived |
| `archivedSources` | while archived, the Source objects as they were attached, which `wsg unarchive` attaches again; else `[]` |
| `tasks` | an epic's tasks, entries like this one, in the epic's order: the slugs its `taskOrder` names first (`wsg reorder`), the rest by name; `[]` for anything else |
| `trackerTasks` | an epic's tracker tasks: the list items under `## Other tasks` in its `tasks.md` (not in a fenced block), in their order, `[{id, text}]` — `id` the tracker key the item starts with (`ACME-12`, `#12`), or `null` for an item without one; `text` the item's first line, its bullet dropped. A table or other text there gives no items; a `tasks.md` without the section, or none, gives `[]`, as does anything but an epic |

### status and close

`wsg close <task>` is `wsg status <task> done`, with the same result. `wsg status <task>` reads.

`{workspace, task, epic, status, previous, closed, archived, changed, forEpicPending, checklist, sources, tasksMdUpdated}`

| Key | Value |
|---|---|
| `workspace` | the task, as given (`..` and a trailing `/` resolved); a task directory that is itself a symlink is given as the task it leads to |
| `task` | its directory name |
| `epic` | its epic's slug, or `null` |
| `status`, `previous` | the status after and before; equal when reading |
| `closed` | the UTC date it was closed, `YYYY-MM-DD` as `created`, while done; else `null` |
| `archived` | the date `wsg archive` took it, while archived; else `null`. An archived task reads `archived`; setting any status is `invalid_input` (`wsg unarchive` puts back the one it had), and so is setting `archived`, which only `wsg archive` sets |
| `changed` | `false` when reading, or setting the status it has (nothing written) |
| `forEpicPending` | as in list |
| `checklist` | as in list: `{done, total}` of the task's `checklist.md`, as it is before the change; `null` without one |
| `sources` | `[{name, mode, branch, dirty, unpushed}]`. Git is asked only on a move to done, and only about worktrees: then `dirty` is the list of changed files as `git status --porcelain` shows them (`[]`: clean) and `unpushed` the number of commits not on the branch's upstream, or without one not on its base. `dirty: null` and `unpushed: null` mean git was not asked, or could not tell |
| `tasksMdUpdated` | whether the epic's `tasks.md` block changed (planned, in a dry run) |

Only `.claude/wsg.json` and the epic's `tasks.md` block are written, in one transaction — and, when a
done task of an epic is reopened, its other generated parts, so it gets what the epic changed while it
was done (its context index, its MCP servers). A render refused at plan time (a broken marker, say) is a
warning and the status is set anyway; a write that fails rolls the whole reopening back (`step_failed`). Uncommitted
or unpushed work, entries left under `## For the epic` and, on a move to review or done, unchecked
items of `checklist.md` ("N of M checklist items unchecked") are warnings, never refusals; so is done
set for a task of an epic from inside its own workspace (a standalone task or a process gets no
such warning: it has no epic session).

### archive

`wsg archive [<task>]`: a task, a process or an epic with its tasks. Everything is checked before the
first change (`wsg unarchive` brings it back); anything that refuses — a worktree with changes, untracked files, edits hidden by
skip-worktree or assume-unchanged, ignored files that exist nowhere else (without
`--delete-ignored`), a detached commit no local branch has, a lock (`git worktree lock`), a
submodule checked out, something in place of a worktree that is not one wsg made (a symlink
included), a render that can't be done, a task of the epic that does not read — is `invalid_input` with `result` present and `rollback` `"none"`, the same document
with `--dry-run` and without. Another wsg command holding the workspace, or one of the epic's tasks,
is `busy`; a dry run takes no lock. Archiving again is a no-op, `changed` `false`. An epic's tasks
are archived first, each in its own transaction, the epic last: a task that fails is rolled back alone
(`step_failed`, its `rollback`), the ones before it stay archived and the message names them; a
run again goes on. Then `result` is `{done, failedTask, reason}`: the tasks this run archived, the
task that failed (`null` when the epic itself did, or for a stop signal between two steps —
`interrupted`, `reason` `"interrupted"`), and why. The record is written before the first removal,
so a run killed half-way leaves a state that says what was there; `wsg archive` again goes on from it.
An epic archived already archives a task in it that is not, and adds it to its cascade. The record
keeps each worktree's branch as it is checked out at the archive (the attached one when its HEAD is
detached), and an archived state is version 4, which wsg 0.7 and earlier refuse to read. Branches are never deleted; worktrees are removed without `--force`, links only
unlinked; rules, notes, memory, `.learnings/`, knowledge and context stay as they are.

`{workspace, kind, slug, epic, status, previous, archived, changed, deleteIgnored, removes, keeps, blockers, tasks, bytes, files, tasksMdUpdated}`

| Key | Value |
|---|---|
| `workspace`, `kind`, `slug` | the workspace, its kind and directory name |
| `epic` | a task's epic, or `null` |
| `status` | `archived`; `null` for an epic, which has no status |
| `previous` | `{status, closed}` before the archive, kept in the record for `wsg unarchive`; `null` for an epic |
| `archived` | the date of the archive: today, or the date it was archived before |
| `changed` | `false` when it was archived already: nothing written |
| `deleteIgnored` | whether `--delete-ignored` was given |
| `removes` | what goes from the workspace itself: `[{name, mode, source, path, branch, sha, bytes, files, ignored, unpushed}]` — `source` the repository or directory, `path` the worktree or link in the workspace, `branch` and `sha` the worktree's branch and its tip (`null` for a link), `bytes` and `files` what the worktree holds (its files' apparent size and number, symlinks not followed; `0` for a link or a worktree already gone — an upper bound: copy-on-write clones free less), `ignored` the ignored files that go with it (absolute), `unpushed` the commits not on the branch's upstream, or without one not on its base (`null`: could not tell) |
| `keeps` | `{folder, notes, memory, rules, context, branches}`: the workspace, its `notes.md` and `.claude-memory/` (`null` when there are none), its rule files (absolute), an epic's `context/` (`null` otherwise), and `branches` `[{task, name, repo, branch, sha}]` — every branch kept, the epic's tasks' included (`task` `null` for the workspace's own); `sha` is `null` for a workspace archived before (its record keeps no tip) |
| `blockers` | `{dirty, ignored, detached}`, each `[{task, source, …}]`: `changes` (as `git status --porcelain` shows them), `files` (absolute) or `commit`; `task` the epic's task it is in, else `null`. Empty lists when nothing refuses |
| `tasks` | an epic's tasks it takes: `[{task, workspace, status, previous, changed, removes, bytes, files}]`; a task archived on its own before is not taken (its record stays its own). `[]` for a task or a process |
| `bytes`, `files` | the totals of every `removes`, the tasks' included: what is freed |
| `tasksMdUpdated` | whether a `tasks.md` block changed (planned, in a dry run) |

Unpushed commits, a branch with no upstream, a `node_modules` wsg cloned and commits only the
worktree's HEAD reflog has (on no branch: they become unreachable) are warnings, never refusals.

### unarchive

`wsg unarchive [<task>]`: every source of the archive record attached again — a worktree on its branch
as it is, a link made again, a rule file the archive kept adopted as it is — and the status and closing
date it had put back; the record and the `<!-- wsg:archive -->` block go. A source that can't come
back (its checkout or its branch gone, the branch checked out in another worktree, its name taken in
the workspace) is `invalid_input` with `result` present, nothing changed. An epic brings back its
links and the tasks its archive took (the record's cascade) that are still archived by it, the tasks
first, the epic last: a task that fails is rolled back alone (`step_failed`, `result` `{done, failedTask,
reason}` as in archive), the ones before it stay unarchived, and the epic keeps its record so a run
again goes on. A task of an archived epic is not unarchived alone (`invalid_input`): it comes back
with its epic. The record goes only once every source is back, so a run killed half-way keeps it,
and a run again attaches what is missing; the sources still attached are left as they are, one listed
but gone from the workspace is attached again (a warning), and a worktree there on the recorded
branch but not listed (a run killed after `git worktree add`) is adopted as it is. A stop signal
during the plan is `interrupted`, "Cancelled, nothing changed." The
worktree comes back on the branch the record names: the one checked out when it was archived. Not archived: a no-op, `changed`
`false`. Ignored files deleted with `--delete-ignored` and copies made when the worktree was first
created do not come back; carried files and a cloned `node_modules` are copied again as the source
says.

`{workspace, kind, slug, epic, status, closed, archived, changed, restores, tasks, tasksMdUpdated}`

| Key | Value |
|---|---|
| `status`, `closed` | the status after, and its closing date while done; `null` for an epic |
| `archived` | the date it had been archived; `null` when it was not |
| `changed` | `false` when it was not archived: nothing written |
| `restores` | `[{name, mode, source, path, branch}]`, the sources attached again; `branch` `null` for a link |
| `tasks` | an epic's tasks it brings back: `[{task, workspace, status, closed, changed, restores}]` |
| `tasksMdUpdated` | whether a `tasks.md` block changed (planned, in a dry run) |

### reorder

`wsg reorder <item> (--before X | --after X | --to N)`: an epic's tasks, in two groups that never mix.
The task directories are ordered by `taskOrder` in the epic's `.claude/wsg.json` (a list of slugs,
each once; a slug no task has any more is ignored, a task it does not name comes after the ones it
does, by name), which the `<!-- wsg:tasks -->` block of `tasks.md`, `wsg list` and `wsg check` follow.
The tracker tasks are the list items under `## Other tasks` (the heading in any case, a `(synced …)`
or a `:` after it) in `tasks.md`, each named by the key it starts with, case ignored, and moved with its indented lines; the rest of the section (blank lines,
comments at column 0) stays where it is. In a task of an epic, its epic is the one acted on. The state
and `tasks.md` are written in one transaction under the epic's lock (`busy` when another command holds
it; a dry run takes none). Refused, `invalid_input` with `result` present, the same document with
`--dry-run` and without: an item or a target the epic has in neither group; a task directory whose
name is no slug (renamed by hand: the others are ordered without it, and a warning names it); the two in different groups; a move relative to itself; `--to` outside
1..the group's size; an archived epic; for a tracker task, no section, a section with an item
without a key, a key twice, a table, other text (a fenced block at column 0 too) or a comment or a
fence still open where the section ends (there is no `#N` addressing by position: `#12` is a key).
Refused before the plan, `invalid_input` with `result` `null`: no item, not exactly one of
`--before`, `--after`, `--to`, an unknown flag, a workspace that is not an epic or a task of one.
Moving a task where it is already is a no-op, `changed` `false`. The section's line ends are kept:
each line keeps its own, a line moved off the end gets the file's, and the file ends as it did.

`{workspace, item, group, from, to, order, changed, tasksMdUpdated}`

| Key | Value |
|---|---|
| `workspace` | the epic |
| `item` | the task's slug, or the tracker key as `tasks.md` writes it; as given while the plan is refused before it is found |
| `group` | `task` or `tracker`; `null` when the item was not found |
| `from`, `to` | its position in its group before and after, from 1; `null` when refused before they are known |
| `order` | the group's order after the move: slugs or keys; `[]` when refused before it is known |
| `changed` | `false` when it is there already: nothing written |
| `tasksMdUpdated` | whether `tasks.md` changed (planned, in a dry run): the block for a task, the section for a tracker task |

### context add, context note, context remove

An epic's context (epics only: a task or a process is `invalid_input`). The epic is written in one
transaction under its lock, then every task of it is refreshed, each under its own lock; a task that
can't be refreshed is reported in `tasks`, never a rollback of the epic's change. A stop signal
during that refresh keeps the epic's change: `interrupted` with `rollback: "unknown"` and `result`
present, the tasks left with `code` `interrupted`.
A file or note edited by hand since wsg wrote it is refused by `context remove` and
`context note --replace` (`invalid_input`) unless `--discard-edits` is given.

`{workspace, item, files, restartNeeded, tasks}`

| Key | Value |
|---|---|
| `workspace` | the epic |
| `item` | the item added, rewritten or removed, as in `context list`; `null` when a refused plan got no further |
| `files` | the epic's paths written or removed: the copied file or the note, `AGENTS.md`, `.claude/wsg.json`; `[]` when refused |
| `restartNeeded` | whether the index block changed: a session already running keeps the `AGENTS.md` it started with (the files themselves are readable at once) |
| `tasks` | `[{task, path, refreshed, code, reason}]`, one per task directory of the epic, by name (one whose state does not read included, as `failed`). `refreshed` `true` once its generated parts were rendered again, with `code` and `reason` `null`; otherwise `code` says why, a stable value: `done` (left as it is), `archived` (left as it is), `busy` (another wsg command holds it), `other_epic` (its state names another epic), `interrupted` (stopped before it), `failed`; `reason` says the same for people. A task not refreshed catches up at its next `wsg refresh`. In a dry run nothing is refreshed: `refreshed` `false` with `code` and `reason` `null` for each task a real run would refresh |

### context list

`{workspace, items, blockBytes}`. Read-only. `items`: `[{id, type, title, description, url, path,
bytes, binary, copied}]` in their order; `type` `file`, `note` or `link`; `url` only for a link, `path`
(absolute) and `bytes` only for a file or a note, else `null`; `binary` `true` for a file that is
not UTF-8 text; `copied` `true` for a note and for a file wsg copied in — `context remove` deletes
those — `false` for a link and for a file that was in `context/` already and was only listed, which a
removal only unlists. `blockBytes`: the size of the `<!-- wsg:epic-context -->` block every task carries,
markers included.

### refresh

`{workspace, files, settingsChanged, tasks}`. The plain `wsg refresh --dry-run` keeps its own JSON
(relative paths, `errors`, `warnings`); with `--json` it is this envelope, `dryRun` `true`. A
generated part that can't be rendered (a broken marker, a `.mcp.json` that does not read, an entry
of the owner's in it by the name of the epic's server) is `invalid_input`, nothing written.

| Key | Value |
|---|---|
| `workspace` | the workspace |
| `files` | the paths written or removed (planned, in a dry run); `[]` when there was nothing to bring up to date |
| `settingsChanged` | whether `.claude/settings.json` changed: a running session keeps the settings it started with |
| `tasks` | with `--tasks` (an epic only; anything else is `invalid_input`): every task of the epic, after the epic, each under its own lock, as in `context add`; `null` without `--tasks` |

### mcp add, mcp remove, mcp disable, mcp enable

An epic's MCP servers for Claude Code (epics only: a task or a process is `invalid_input`; so is
`--agent codex` — "not supported yet"). The epic is written in one transaction under its lock — its
`.claude/wsg.json`, `.mcp.json` (the epic's servers, next to the owner's own entries, which are
kept) and `.claude/settings.json` (`enabledMcpjsonServers`, `deniedMcpServers`, the owner's entries
kept) — then every task of it is refreshed as in `context add`. A name the owner's `.mcp.json` has
already is refused, never overwritten. `--env NAME=value` with a name that looks like a secret
(`TOKEN`, `KEY`, `SECRET`, `PASSWORD`, `AUTH`, … as a whole name or a part between `_`, `-`, `.`)
is `invalid_input`; an argument or a URL that looks like it carries one is a warning, naming the
argument's position and flag, never its value. `disable` of a name already off and `enable` of one
that is not off change nothing: `ok` with a warning, `restartNeeded` `false`.

`{workspace, name, server, disabled, files, settingsChanged, restartNeeded, tasks}`

| Key | Value |
|---|---|
| `workspace` | the epic |
| `name` | the server's name as given (as the epic has it, for `remove`) |
| `server` | the server added or removed, as in `mcp list`; `null` for `disable`, `enable` and a refused plan that got no further |
| `disabled` | `{claude: [names]}`: the global servers the epic turns off, after the command (as they are, when refused) |
| `files` | the epic's paths written or removed: `.mcp.json`, `.claude/settings.json`, `.claude/wsg.json`; `[]` when refused |
| `settingsChanged` | whether the epic's `.claude/settings.json` changed |
| `restartNeeded` | whether the epic's MCP servers changed at all: Claude Code reads them when a session starts |
| `tasks` | as in `context add` |

### mcp list

`{workspace, servers, disabled, global, missingEnv}`. Read-only.

| Key | Value |
|---|---|
| `servers` | `[{name, transport, command, args, url, env, bearerEnv, agents}]` in their order. `transport` `stdio` (`command`, `args`; `url` `null`) or `http` (`url`; `command` `null`, `args` `[]`). `env`: the names of the variables the server gets, never a value — neither one forwarded from the environment (`${NAME}` in `.mcp.json`) nor a literal given with `--env NAME=value`. `bearerEnv`: the name of the variable that holds an http server's token, or `null`. `agents`: `["claude"]` in this version |
| `disabled` | `{claude: [names]}`: the global servers the epic turns off, any name Claude Code may know one by — `plugin:<plugin>:<server>` for a plugin's |
| `global` | `{claude: [{name, transport}]}`: the servers of the user-scope Claude Code config (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`), names and transports only. Plugin servers and claude.ai connectors are not in that file, so not here: a UI that turns servers off takes a free-text name too |
| `missingEnv` | the variables the epic's servers read that the environment wsg runs in has no value for |

`command`, `args` and `url` are what the owner gave. A token typed into them by hand is in the
result, and in `.mcp.json`, which every task's agent can read: `mcp add` warns about it; keep
secrets in variables.

### --version

`wsg --version --json`: `result` is `{version}`, `command` `null`.
