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
3. Show the owner the command and wait for "ok":

   ```bash
   wsg new <slug> --epic <epic> --ticket <KEY> [--title T] [--sources a,b|none]
   ```

   Without `--sources` the task gets no repository, unless the epic has exactly one with a branch
   template. A task without a git repository reports "setup not finished" until one is attached:
   say so. When the owner wants to see the branches first, run
   `wsg new <slug> --epic <epic> --dry-run` with the same flags: it prints the plan, nothing made.
4. After it runs, the task's `AGENTS.md` points to `../knowledge.md` and `../tasks.md`, and holds
   the epic's Owner rules when they are filled in here. Tell the owner how to open a session in
   the task directory; the task is worked on there, not here.

## Working

In the task's own session.

1. Before the first edit, read `../knowledge.md`.
2. Work as in any task: the task's `AGENTS.md` governs.
3. What the next task of the epic should know — a decision, a repository fact, a pitfall — goes
   into the task's `notes.md` under `## For the epic`: dated, with the evidence (a file and line,
   a commit, a link). Never edit the epic's files from a task: they are merged at close.

## Closing

From the epic session, when a task is done (`/wsg-epic-close <task>` in Claude Code).

1. Read the task's `notes.md` → `## For the epic`, its `.learnings/`, its invariants, and
   `git log` of its branches.
2. Draft one diff:
   - `knowledge.md` rewritten, not appended to, within 4 KiB;
   - facts of one repository to `.claude/rules/<repo>.md`;
   - the rationale of a new decision to `decisions.md`;
   - a line for the task in `tasks.md` → Status: date, outcome.
3. Send the draft to the advisor, show the owner the result, and write it only after "ok".
4. Run `wsg check`: it warns about a `knowledge.md` over 4 KiB and fails one over 8 KiB.

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
   an existing task takes it with `wsg add <name>` from its own directory.
4. Record what the repository is for in `knowledge.md` → Repositories; its facts go into
   `.claude/rules/<repo>.md`, which loads in the epic and in each task that reads the repository.

`wsg remove <name>` drops the link and its defaults; tasks that already have the repository keep
their worktrees and branches, and the removal names them.
