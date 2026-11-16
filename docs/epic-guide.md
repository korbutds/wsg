# wsg epic guide

Followed by the agent in an epic workspace (`.claude/ws-kind` says `epic`) or in a task inside one.
An epic is one tracker epic: `knowledge.md` — what every task must know, the single source of
truth; `decisions.md` — the rationale behind its decisions; `tasks.md` — the epic's tasks; the
epic's repositories, attached as links with the settings its tasks reuse; and the tasks
themselves, each an ordinary task workspace in a directory of the epic.

Every procedure here is a proposal first: show the owner what you are about to run or write, and
run or write it only after "ok". Questions for the owner go through the advisor first, as
AGENTS.md says. Never write to the tracker.

## Starting a task

From the epic session, when the owner asks to start work on a ticket.

1. Sync first (section Syncing): a task that already exists elsewhere is not started twice.
2. Read the ticket with any tracker MCP read tool you have; without one, ask the owner for its
   summary. Pick a slug: kebab-case, not a name the epic uses (`knowledge.md`, `tasks.md`, a
   source's name).
3. If the `wsg-advisor` agent is available, send it the command and the dry-run first. Then show
   the owner the command and wait for "ok":

   ```bash
   wsg new <slug> --epic <epic> --ticket <KEY> [--title T] [--sources a,b|none]
   ```

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

## Working

In the task's own session.

1. Before the first edit, read `../knowledge.md`.
2. Work as in any task: the task's `AGENTS.md` governs.
3. What the next task of the epic should know — a decision, a repository fact, a pitfall — goes
   into the task's `notes.md` under `## For the epic`: dated, with the evidence (a file and line,
   a commit, a link). Never edit the epic's files from a task: they are merged at close.
4. When the work is finished, show the owner `wsg status <epic>/<task> review` and run it after
   "ok": the task is ready for the epic's closing. Only review is the task session's to set; done
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
   `git log` of its branches.
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
   `## Other tasks (synced <date> via <tool>)`. The `<!-- wsg:tasks -->` block lists the tasks in
   this directory and is wsg's: `wsg refresh` renders it.
3. A tracker change that looks like a decision (a scope cut, a new dependency) is shown to the
   owner as a candidate for `knowledge.md`, never written without "ok".
4. No tracker tool: report `SKIPPED tracker: no tool available` and change nothing.

## Owner rules

The epic's `## Owner rules` section in its `AGENTS.md` holds the rules for every task of it. Each
task renders it, heading dropped, in a `<!-- wsg:epic-rules -->` block of its own `AGENTS.md`:
rendered, not copied, so a rule added here reaches a task at its next `wsg refresh` (also `wsg add`,
`wsg remove`, `wsg team` there). A refresh of the epic does not write into its tasks: `wsg check`
here names the tasks whose block is behind; tell the owner to run `wsg refresh` in each, or in the
task's session before it goes on. A rule only one task needs goes into that task's own
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
