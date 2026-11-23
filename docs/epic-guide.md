# wsg epic guide

Followed by the agent in an epic workspace (`.claude/ws-kind` says `epic`) or in a task inside one.
An epic is one tracker epic: `knowledge.md` — what every task must know, the single source of
truth; `decisions.md` — the rationale behind its decisions; `tasks.md` — the epic's tasks; the
epic's repositories, attached as links with the settings its tasks reuse; and the tasks
themselves, each an ordinary task workspace in a directory of the epic.

Every procedure here is a proposal first: show the owner what you are about to run or write, and
run or write it only after "ok". Questions for the owner go through the advisor first, as
AGENTS.md says. Never write to the tracker.

Never skip a tracker task silently. Every child issue of the epic is accounted for in `tasks.md`:
one with a task directory here is in the `<!-- wsg:tasks -->` block, every other one is a line under
`## Other tasks` (see Syncing). A task without a repository to change — a spec, a research, a
decision — is never left out or set aside by you on your own: it becomes a question to the owner
when it is to be started, with three answers — create it without code (`wsg new <slug> --epic <epic> --no-code`), attach a
repository (`--sources <name>`, or `wsg add` in the task later), or do not start it.

The epic's skills (`/wsg-epic-task`, `/wsg-epic-sync`, `/wsg-epic-close`) are written once, when the
epic is made, and only point here: an epic made by an older wsg keeps its skill files as they were,
and gets these rules through this guide.

## Starting a task

From the epic session, when the owner asks to start work on a ticket.

1. Sync first (section Syncing): a task that already exists elsewhere is not started twice.
2. Read the ticket with any tracker MCP read tool you have; without one, ask the owner for its
   summary. A ticket with no code to change (a spec, a research, a decision), or none of whose
   repositories the epic has: do not skip it and do not pick for the owner — ask, through the
   advisor: create it with `--no-code`, attach a repository (`wsg add <path>` in the epic first,
   then `--sources <name>`), or do not start it. Pick a slug: kebab-case, not a name the epic uses (`knowledge.md`, `tasks.md`, a
   source's name).
3. If the `wsg-advisor` agent is available, send it the command and the dry-run first. Then show
   the owner the command and wait for "ok":

   ```bash
   wsg new <slug> --epic <epic> --ticket <KEY> [--title T] [--sources a,b|none] [--no-code] [--spec]
   ```

   `--no-code` (the owner's answer above): no repository, no branch, `--sources` refused but for
   `none`; material to read is attached later with `wsg add <name> --link`. `--spec` when the
   owner wants the spec and the plan approved before any code (`spec.md`, `plan.md`).

   Without `--sources` the task gets no repository, unless the epic has exactly one with a branch
   template. A source with a template becomes the task's own worktree on the branch it gives
   (`{ticket}` needs `--ticket`: the key is written into the task's state once, at creation, and a
   task made without it takes such a source only with `wsg add <name> --branch B`, or `--link` to
   link it as is); a branch of
   that name that exists is attached as it is, one only on origin is continued. A source without
   one is linked as is. A task without a git repository reports "setup not finished" until one is
   attached: say so. When the owner wants to see the branches first, run
   `wsg new <slug> --epic <epic> --dry-run` with the same flags: it prints the plan, nothing made.
   A source that can't be attached refuses the whole task, nothing made.
4. After it runs, the output names the sources the task took; the task's `AGENTS.md` points to
   `../knowledge.md` and `../tasks.md`, and renders the epic's Owner rules (see Owner rules below).
   Tell the owner how to open a session in the task directory — `ws <epic>/<task>` or the
   `cd … && <agent>` line, as the output says; the task is worked on there, not here. Its first session runs the setup
   (`wsg guide setup`) for what the epic does not give: why, done, scope, invariants.

### A reported problem

When the owner reports a problem in the epic's session, it is not fixed there. Make a task as above,
or update the matching one listed in `tasks.md`, and write into its `notes.md` the symptoms, the
evidence, the expected behavior and the current status. Then suggest opening that task's session for
the fix. The fix is made from the epic's session only when the owner explicitly asks. The epic's
`AGENTS.md` says the same in its `epic-problems` block; the epic's Owner rules win.

### A task made elsewhere

A task that exists already — made standalone, or in another epic — is moved, not made again:

```bash
wsg move <task> --epic <epic> --dry-run      # the plan: paths, sources, what is regenerated
wsg move <task> --epic <epic>                # after the owner's "ok"
```

The directory moves whole (notes, memory, worktrees, branches); its `AGENTS.md` gets this epic's
blocks, and both epics' `tasks.md` are updated. A source it took from its old epic stays taken from
this one when this epic has the same source, else it becomes the task's own. `wsg move <task> --out`
takes a task out of its epic, `--new-epic` makes a new epic for it. A session open in the task keeps
the old path: tell the owner to close it first, and to open the task again with `ws <epic>/<task>`,
which also resumes the session from before the move.

### A task that grew into an epic

A task whose work turned out to be several tasks becomes an epic in its own folder:

```bash
wsg promote <task> --dry-run   # the plan: what is rewritten, made, dropped, adopted
wsg promote <task>             # after the owner's "ok"
```

Its notes, memory, rules and link sources stay; the epic's `knowledge.md`, `tasks.md`,
`decisions.md`, its rule and skills are added. Then fill `knowledge.md` from the task's notes and
make the next pieces of work as tasks of it. A task with a worktree is refused (an epic's sources are
links): `wsg move <task> --epic <name> --new-epic` nests it in a new epic instead. A session open in
the folder keeps the task's instructions: tell the owner to restart it.

## Working

In the task's own session.

1. Before the first edit, read `../knowledge.md`.
2. Work as in any task: the task's `AGENTS.md` governs.
3. What the next task of the epic should know — a decision, a repository fact, a pitfall — goes
   into the task's `notes.md` under `## For the epic`: dated, with the evidence (a file and line,
   a commit, a link). Never edit the epic's files from a task: they are merged at close.
4. After showing review results, when a commit is next and not approved yet, ask in the same reply
   whether to commit; an explicit instruction to commit is that approval. Handing back an
   implementation, say that it needs verification: what to verify, the expected observations, and
   the build link if there is a build.
5. When the work is finished, read `checklist.md` and show the owner the items still unchecked
   (a task made before wsg 0.8 has none), then show `wsg status <epic>/<task> review` and run it after
   "ok": the task is ready for the epic's closing. Unchecked items are a warning, never a refusal. Only review is the task session's to set; done
   is set by the epic session (Closing) or by the owner.

## Closing

From the epic session, when a task is finished (`/wsg-epic-close <task>` in Claude Code). Codex has
no such skill: tell it, in plain text, "Run `wsg guide epic`, section Closing, for <epic>/<task>".

A task's status is the `status` field of its `.claude/wsg.json` — `open`, `review` or `done`, with
`closed`, the date, while it is done. That field is the source of truth: the `[review]` or
`[done <date>]` marker after the task's line in the `<!-- wsg:tasks -->` block of `tasks.md` is
rendered from it, and the free-text `## Status` section of `tasks.md` is a summary in words.
`wsg status <epic>/<task>` prints it; `wsg list` shows every task with its marker.

1. Read the task's `notes.md` → `## For the epic`, its `.learnings/`, its invariants, and
   `git log` of its branches. Read its `checklist.md` and show the owner the items still unchecked:
   `wsg close` warns about them too ("N of M checklist items unchecked"), and never refuses.
2. Draft one diff:
   - `knowledge.md` rewritten, not appended to, within 4 KiB;
   - facts of one repository to `.claude/rules/<repo>.md`;
   - the rationale of a new decision to `decisions.md`;
   - a line for the task in `tasks.md` → Status: date, outcome;
   - in the task's `notes.md`, the merged entries moved out of `## For the epic` to the top of
     `## Notes`, under `### Merged into the epic <date>`. `## For the epic` keeps only its comment:
     an entry left there reads as not merged, and `wsg close` and `wsg check` warn about it.
3. Send the draft to the advisor, show the owner the result, and write it only after "ok".
4. Then, after "ok", the last write: run `wsg close <epic>/<task> --dry-run`, show the owner its
   warnings — uncommitted or unpushed work in the task's worktrees, entries still under
   `## For the epic` — then `wsg close <epic>/<task>`. It sets done with today's UTC date and
   renders the task's marker in `tasks.md`; it merges, pushes and removes nothing, and a warning
   never stops it. A task named by its slug alone is looked up in `WS_ROOT`, not in the epic:
   always give `<epic>/<task>`.
5. Run `wsg check`: it warns about a `knowledge.md` over 4 KiB and fails one over 8 KiB, and about
   a done task whose `## For the epic` still has entries.

## Syncing

From the epic session (`/wsg-epic-sync` in Claude Code), and as step 1 of Starting a task.

1. With any tracker MCP read tool, read the epic's child issues and linked issues: key, summary,
   status, assignee, updated.
2. Rewrite only the "Other tasks" section of `tasks.md`, under the heading
   `## Other tasks (synced <date> via <tool>)`. Every child issue the tracker has whose key is not on
   a line of the `<!-- wsg:tasks -->` block is listed there — none is left out, whatever its status, assignee or
   whether it has a repository: one list item per task, starting with its key
   (`- KEY-12 summary — status, assignee`). Keep the order the items already have, update them in
   place, and append new ones at the end; no table, no other bullets in the section. The
   `<!-- wsg:tasks -->` block lists the tasks in this directory and is wsg's: `wsg refresh` renders it.
   The owner sets the order of either list with `wsg reorder` (`wsg reorder <task> --to 1`,
   `wsg reorder ACME-12 --before ACME-7`): keep it — never re-sort the items, and do not edit the
   block by hand. It reads the items by their keys, so an item without a key, a key twice, a table
   or other text in the section makes it refuse.
3. A child issue without a repository to change (a spec, a research) is listed like any other. When
   the owner wants it started, it is a question, never your call: `--no-code`, a repository, or not
   now (Starting a task).
4. A tracker change that looks like a decision (a scope cut, a new dependency) is shown to the
   owner as a candidate for `knowledge.md`, never written without "ok".
5. Only when there is no tracker tool at all: report `SKIPPED tracker: no tool available` and change
   nothing. With a tool, nothing is skipped: an issue you can't place is listed all the same, and
   said to the owner.

## Owner rules

The epic's `## Owner rules` section in its `AGENTS.md` holds the rules for every task of it. Each
task renders it, heading dropped, in a `<!-- wsg:epic-rules -->` block of its own `AGENTS.md`:
rendered, not copied, so a rule added here reaches a task at its next `wsg refresh` (also `wsg add`,
`wsg remove`, `wsg team` there). A refresh of the epic does not write into its tasks: `wsg check`
here names the tasks whose block is behind; tell the owner to run `wsg refresh --tasks` here (all
open tasks at once), or `wsg refresh` in the task's session before it goes on. A rule only one task needs goes into that task's own
`## Owner rules` section, which adds to the epic's and wins. A section with FILL IN renders as "no
rules yet"; one with a `<!-- wsg:… -->` marker or an open code fence is not rendered — the tasks
keep what they had, and `wsg check` says why. So does an epic whose `AGENTS.md` is missing, or has
no `## Owner rules` section at all (deleted, or the heading renamed): a task's refresh keeps the
block as it was, with a warning, rather than drop the rules.

A task made by wsg 0.6.0 or earlier has the epic's section copied once into its own
`## Owner rules`. Its first refresh adds the block and warns when that section repeats the epic's;
`wsg check` keeps warning. wsg never edits that section: delete it, or keep only the task's own
rules there, after the owner's "ok".

## Context

What the epic's tasks may need beyond `knowledge.md` — a spec, a brief, mockups, a runbook — is the
epic's context, changed only through the commands below, from the epic session, after the owner's "ok":

```bash
wsg context add <url|path> [--id ID] [--title T] [--desc D] [--dry-run]
wsg context note <id> (--text T | --from FILE | --from -) [--title T] [--desc D] [--replace] [--dry-run]
wsg context remove <id> [--dry-run]
wsg context list
```

An http(s) URL is kept as a link, a file is copied into `context/` (one already there is listed as
it is), a note is written to `context/notes/<id>.md`. `wsg context remove` deletes from `context/`
only what wsg wrote there — a file it copied in, a note; a file that was there already is only
unlisted. A file or note edited by hand since wsg wrote it is neither removed nor rewritten by
`wsg context note <id> --replace` without `--discard-edits`. A file in `context/notes/` is a note's:
write a note with `wsg context note <id> --from <file>`, never list such a file with `add`. A directory is refused: attach it as a
reference source (`wsg add <path> --reference`). The epic's `.claude/wsg.json` keeps the index, the
paths relative to the epic. The index — not the bodies — is rendered in a
`<!-- wsg:epic-context -->` block of the epic's `AGENTS.md` and of every task's, after the epic's
Owner rules: one line per item with its type, title, description, `../context/<file>` or the URL,
and its size. An agent opens an item only when its work touches the topic, so keep each
description to one line that says when it is needed (at most 200 characters).

Unlike the Owner rules, a change is rendered into every task at once, each under its own lock; a
task that is busy is reported and catches up at its next `wsg refresh`, a done task is left as it
is. Sessions already running keep the index they started with; the files are readable at once.
Limits: a file above 1 MiB is a warning, above 20 MiB refused (add it as a link); the index block
above 2 KiB is a warning, above 4 KiB refused. A binary file (PDF, image) is copied as it is and
marked: Claude Code reads it, other agents may not. `wsg check` here fails on a listed file that is
missing, and warns about a file in `context/` the index does not list and about tasks whose block is
behind. Epics only in this version.

## MCP

MCP servers every task of the epic should have — a tracker, a database, docs — are the epic's,
changed only through the commands below, from the epic session, after the owner's "ok". Claude Code
only in this version:

```bash
wsg mcp add <name> [--env A,B=value] [--dry-run] -- <command> [args...]
wsg mcp add <name> --url URL [--bearer-env VAR] [--dry-run]
wsg mcp remove <name> [--dry-run]
wsg mcp disable <name> [--dry-run]     # a global server, off in the epic and its tasks
wsg mcp enable <name> [--dry-run]
wsg mcp list
```

The epic's servers go into `<epic>/.mcp.json`, which Claude Code finds from the epic and from every
task inside it, and each workspace's own `.claude/settings.json` enables them by name
(`enabledMcpjsonServers`: a parent's settings do not apply in a task). A global server the epic
turns off is listed there as `deniedMcpServers`, by name — one from the user's config (`wsg mcp
list` shows those), or a plugin's as `plugin:<plugin>:<server>`. The owner's own entries in both
files stay: each workspace's `.claude/wsg.json` records what wsg put there, and a removal takes out
exactly that. A name the owner's `.mcp.json` has already is refused, never overwritten. A change is
rendered into every task at once, as for the context; a busy task catches up at its next
`wsg refresh` (`wsg refresh --tasks` here does all of them), and `wsg check` here names the tasks
that are behind. A task made later gets the servers at `wsg new --epic`.

Secrets never go into the files. `--env NAME` forwards a variable by name — `${NAME}` in
`.mcp.json`, which Claude Code fills from the environment it runs in; `--bearer-env VAR` sends an
http server's token as `Authorization: Bearer ${VAR}`. A literal `--env NAME=value` is refused for a
name that looks like a secret (TOKEN, KEY, SECRET, PASSWORD, AUTH, …); a token typed into an
argument or a URL is warned about — `.mcp.json` is readable by every task's agent. `wsg mcp list`
and `wsg check` name the variables this shell has no value for; ask the owner to export them where
the agent runs.

Limits, say them to the owner when they matter:
- Running sessions keep their servers: restart them after a change.
- In a terminal, the epic's servers stay "Pending approval" in a task until that task's folder is
  trusted — one trust dialog per task directory; trusting the epic does not carry over.
- A server that signs in with OAuth: authenticate it once in a terminal session (`/mcp`).
- Plugin servers are turned off by `plugin:<plugin>:<server>`; whether a claude.ai connector can be
  turned off by name is not verified. `wsg mcp list` does not list either.
- Codex: not yet (`--agent codex` is refused). Epics only.

## Adding a repository

From the epic session. A repository of an epic is a link to its shared checkout, with the defaults
its tasks reuse; each task gets its own worktree of it.

1. Inspect the repository as the setup guide says: the branch naming convention
   (`git -C <repo> for-each-ref --sort=-committerdate --format='%(refname:short)' refs/heads`),
   the default branch, the verification command.
2. Run it with `--dry-run` first and show the owner the plan:

   ```bash
   wsg add <path> --branch-template '<user>/task/{slug}/{ticket}' [--base REF] [--carry all|none|a,b] \
     [--[no-]clone-node-modules] [--target T] [--verify CMD] --dry-run
   ```

   - `--branch-template` follows the repository's convention. `{slug}` (the task's directory) and
     `{ticket}` (its ticket key) are the only placeholders, at least one is required, and the plan
     shows a sample branch (`task.sampleBranch`). Quote it: the braces are literal.
   - `--base` is what a task's branch starts from; without it, `origin/<target>`.
   - `--carry` picks the ignored files each task's worktree gets (`task.carryCandidates`): `all` by
     default, resolved to the list there is now.
   - `--target` and `--verify` are the repository's own, and its tasks reuse them.
   - Without `--branch-template` the repository is linked into each task as is, and `--base`,
     `--carry` and `--[no-]clone-node-modules` are refused. `--worktree`, `--branch` and
     `--reset-to-base` are always refused: an epic has no branch of its own. `--reference`
     attaches material outside git, never branched.
3. After "ok", run it without `--dry-run`. Tasks created afterwards may take it with `--sources`;
   an existing task takes it with `wsg add <name>` from its own directory (`--dry-run` shows the
   branch first; a flag given there wins over the epic's default; `./<name>` is a path instead).
4. Record what the repository is for in `knowledge.md` → Repositories; its facts go into
   `.claude/rules/<repo>.md`, which loads in the epic and in each task that reads the repository.

`wsg remove <name>` drops the link and its defaults; tasks that already have the repository keep
their worktrees and branches, and the removal names them.
