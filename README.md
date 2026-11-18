# wsg — Workspace Generation

Task workspaces for coding agents: Claude Code, Codex, and anything else that reads `AGENTS.md`.
One directory per task — the repositories inside as `git worktree`s, the task's rules and
definition of done, a command that verifies the work, its own session history and agent memory.
On top of that, if you want it, a team of roles for Claude Code: pm, designer, frontend, backend,
devops and reviewer, with the main session as the tech lead.

## Why

An agent starts every session with a clean context. What carries over between sessions is
instruction files and auto-memory, and they are anchored differently: **session history to the
working directory, auto-memory to the git repository**. That leads to three problems.

**A task spanning several repositories gets split apart.** A feature that lives in two or three
repos produces as many unrelated context stores, and none of them has the whole picture.

**Task contexts get mixed up.** A repository's memory holds everything you have ever done in it.
A new task drags past ones into context, and its own conclusions end up where nobody will find them.

**Deliberate decisions look like bugs.** A repository has its rules in `AGENTS.md`. But the
decisions of a specific task — "this code lives in the legacy layer on purpose", "this path is out
of scope" — have nowhere to go. The agent doesn't know about them and dutifully "fixes" them,
breaking the work.

`wsg` makes the **task**, not the repository, the session's working directory.

**Set up, not trained.** wsg trains no model. An "agent trained for this repository" is usually
an ordinary model with the right context around it: instructions, tools, memory and a way
to check the result. wsg builds that context for each task, with the deterministic parts
(worktrees, rules, settings, validation) in the CLI and the conversation in the agent. What is
worth keeping carries over: a role's practices, added with `/wsg-teach`, go into that role's
user-level memory and apply wherever the role runs (Claude Code, with auto memory on).

## Installation

Try it without installing:

```bash
npx @korbutds/wsg new <slug>
```

This creates a workspace. The `ws` command that jumps into it needs `wsg` installed globally.

Install globally:

```bash
npm i -g @korbutds/wsg
wsg --help
```

The package is called `@korbutds/wsg`; the command is `wsg`.

The `ws` navigation function can't be a program: a child process can't change its parent's
directory. So its code is printed for `eval` — add this to `~/.zshrc`:

```bash
eval "$(wsg shell-init zsh)"
```

Then copy the settings and adjust `WS_ROOT`:

```bash
mkdir -p ~/.config/wsg
cp "$(wsg --where)/config.example" ~/.config/wsg/config
```

`wsg install-skills` adds the user-level parts: for Claude Code, the `wsg-new` skill (any session
can then create a workspace when you ask for one) and the `wsg-advisor` agent; for Codex, when it
is installed, the `wsg-advisor` agent (see [Advisor](#advisor)). `wsg install-skills --uninstall` removes them.

<details>
<summary>Without npm — from the repository</summary>

```bash
git clone https://github.com/korbutds/wsg.git
cd wsg
./install.sh
```

`install.sh` symlinks `wsg` into `~/.local/bin`, hooks `ws` into `~/.zshrc`, and runs
`wsg install-skills` — so a clone install gets the advisor agents too. There are no dependencies
to install.
</details>

**Requirements:** Node 20.19+ (or 22.13+) and git — for both installation methods. The `ws` function is for zsh.

**Windows is not supported yet:** it needs git worktrees and POSIX-style symlinks. Works under WSL.

## Quick start

```bash
wsg new oauth-refresh  # create the skeleton and start the agent in it with /wsg-setup
```

The agent leads the setup dialogue: what the task is and why, how to tell it is done, what is out
of scope, which repositories it touches. It looks at the repositories itself — branch naming, the
default branch, the test command in package scripts or CI, files outside git — proposes how to
attach each one and, after your "ok", calls `wsg add`. It finishes with `wsg check` and tells you
whether to restart the session. The dialogue follows [docs/setup-guide.md](docs/setup-guide.md)
(`wsg guide setup`), so any agent can run it: Claude Code gets the `/wsg-setup` skill, others are
pointed at `SETUP.md`. Re-run `/wsg-setup` later to attach another repository or fill gaps.

```bash
ws                     # list workspaces with checkout state
ws <slug>              # go there and launch the agent (asks which one on first run)
ws <slug> --claude     # this time with claude, whatever the setting (also --codex)
ws <epic>/<task>       # the same for a task inside an epic (see Epics)
ws --agent             # choose the agent again
wsg check              # check the workspace you are in against the conventions
```

The commands the agent (or you) call:

| Command | What it does |
|---|---|
| `wsg new <slug> [--title T] [--kind task\|process\|epic] [--skill NAME] [--ticket X] [--epic E] [--sources a,b\|none] [--no-code] [--spec] [--dry-run] [--json] [--no-launch]` | Creates the skeleton and starts the agent; `--no-launch` prints the next step instead. Only the slug is needed, and `--kind` for a process or an epic: the setup dialogue asks for the rest. `--epic E` makes a task inside the epic `E`, `--sources` picks the epic's repositories it takes (see [Epics](#epics)); `--no-code` makes a task without a repository (see [Tasks without code](#tasks-without-code)); `--spec` makes a task go spec first (see [Checklist and spec stages](#checklist-and-spec-stages)); `--dry-run` prints the plan as JSON; `--json` prints one JSON document, the outcome or the error, and never starts the agent. |
| `wsg add <path> [--worktree\|--link\|--reference] [--branch B] [--base REF] [--reset-to-base] [--target T] [--verify CMD] [--carry all\|none\|a,b] [--[no-]clone-node-modules] [--note TEXT] [--branch-template T] [--dry-run] [--json] [--ws SLUG\|PATH]` | Attaches one source to the workspace you are in. An existing branch is attached as it is, one only on origin is continued; `--reset-to-base` starts it over (with a `backup/…`). Every check happens before anything is touched; a failure rolls back only this source. `--dry-run` prints the plan as JSON; `--json` prints one JSON document, the outcome or the error, and nothing else. In an epic, a link with the defaults its tasks reuse; in a task of an epic, `wsg add <name>` takes the epic's source of that name. |
| `wsg remove <name> [--delete-ignored] [--dry-run] [--json] [--ws SLUG\|PATH]` | Detaches a source: a clean worktree (its branch is kept) or the symlink, its rule, and its generated parts. Ignored files that exist nowhere else (made in the worktree, or carried in and changed since) are deleted with the worktree only after `--delete-ignored`; a `node_modules` wsg cloned is not checked, so changes inside it are not protected. The way to fix a source attached with the wrong flags: remove, then add again. |
| `wsg refresh [--tasks] [--dry-run] [--json] [--ws SLUG\|PATH]` | Brings the generated parts up to date with this wsg — e.g. adds the advisor block to a workspace made by 0.2 — and touches nothing else. `--tasks` in an epic: then every task of it, each under its own lock. `--dry-run` prints the files it would change as JSON; `--json` prints one JSON document. |
| `wsg team <preset> [--without ROLE,...] [--dry-run] [--ws SLUG\|PATH]` | Adds a team of roles (preset `fullstack`): cards and a workflow in `team/`, a Claude Code subagent per role, `/wsg-feature`. Only adds; an existing file is kept. `--dry-run` prints what it would create, keep and update as JSON. Not in an epic: in its tasks. See [Team](#team). |
| `wsg check [path\|slug] [--json]` | Checks a workspace against the conventions; `--json` gives the report by section as one JSON document. A task of an epic is `<epic>/<task>`. |
| `wsg list [--json]` | Lists every workspace in `WS_ROOT`, each epic's tasks under it, with the kind, a task's status marker, the ticket and the title; a 0.1 workspace and one whose state does not read are listed with what is wrong. Only reads, runs no git. `--json` gives each workspace's state, sources and the directories a session needs, and an epic's tracker tasks from `tasks.md`. An epic's tasks come in its order (`wsg reorder`). |
| `wsg status <task> [open\|review\|done] [--dry-run] [--json]` | Prints a task's or a process's status (`archived` too, which only `wsg archive` sets), or sets it: only `.claude/wsg.json` and the epic's `tasks.md` block change (a done task of an epic reopened also gets its generated parts refreshed). The move to done warns about uncommitted or unpushed work and about entries left under `## For the epic`, and never refuses for them. The task is always named: a slug, `<epic>/<task>` or a path. |
| `wsg close <task> [--dry-run] [--json]` | `wsg status <task> done`. Merges, pushes and removes nothing. |
| `wsg archive [<task>] [--delete-ignored] [--dry-run] [--json] [--ws SLUG\|PATH]` | Archives a finished task, a process, or an epic with its tasks, to free the disk: its worktrees go (without `--force`), with the `node_modules` and builds in them, and its symlinks. The branches are never deleted; the workspace with its notes, memory, rules and knowledge stays, and so do the sources as they were attached, in `.claude/wsg.json`. Everything is checked first: changes (skip-worktree and assume-unchanged edits too), untracked files, ignored files that exist nowhere else (unless `--delete-ignored`), a detached commit no branch has, a locked worktree or a submodule checked out refuse the whole archive, nothing touched. Unpushed commits are a warning. `--dry-run` prints what goes, what stays and the size (an upper bound: copy-on-write clones free less). wsg 0.7 and earlier refuse an archived workspace. |
| `wsg unarchive [<task>] [--dry-run] [--json] [--ws SLUG\|PATH]` | Brings an archived workspace back: each worktree attached again on its branch as it is, each link made again, the status it had put back. Every source must be able to come back, or nothing changes. An epic brings back the tasks its archive took. Ignored files deleted with `--delete-ignored` do not come back. |
| `wsg reorder <item> (--before X\|--after X\|--to N) [--dry-run] [--json] [--ws E]` | Moves a task of an epic in the order `tasks.md` shows, within its group: a task directory (the `<!-- wsg:tasks -->` block; the order is kept in the epic's `.claude/wsg.json` as `taskOrder`, and `wsg list` follows it), or a tracker task under "## Other tasks", named by its key, moved with its indented lines. Never across the groups; a section with an item without a key, a key twice, a table or other text is refused. A new task goes to the end; the order survives status changes, archive and refresh. In a task of an epic it acts on the epic. |
| `wsg context add <url\|path> [--id ID] [--title T] [--desc D]`, `wsg context note <id> (--text T\|--from FILE\|--from -) [--replace]`, `wsg context remove <id>`, `wsg context list` (each with `--ws E`, `--json`; the writes with `--dry-run`) | An epic's context: links, files copied into `context/`, notes. Its index — one line per item — is rendered into the epic's and every task's `AGENTS.md` in a `<!-- wsg:epic-context -->` block, at once; the agent opens an item only when it needs it. See [Epics](#epics). |
| `wsg mcp add <name> [--env A,B=value] -- <command> [args...]`, `wsg mcp add <name> --url URL [--bearer-env VAR]`, `wsg mcp remove <name>`, `wsg mcp disable <name>`, `wsg mcp enable <name>`, `wsg mcp list` (each with `--ws E`, `--json`; the writes with `--dry-run`) | An epic's MCP servers for Claude Code: written into the epic's `.mcp.json` and enabled in the epic's and every task's `.claude/settings.json`, at once; `disable` turns a global server off there by name. Secrets by reference only (`${VAR}`). Codex not yet. See [Epics](#epics). |
| `wsg promote [slug\|path] --skill NAME` | Turns a task into a process. Not an epic or a task of one. |
| `wsg guide [setup\|advisor\|teach\|epic]` | Prints a guide an agent follows: the setup dialogue, the advisor's procedure, teaching a team role a practice, or working in an epic. |
| `wsg install-skills [--uninstall]` | Installs the `wsg-new` and `wsg-teach` skills into `~/.claude/skills` and the `wsg-advisor` agent into `~/.claude/agents` (or under `$CLAUDE_CONFIG_DIR`) and, when Codex is there, `~/.codex/agents` (or `$CODEX_HOME/agents`). Overwrites only files it wrote — they carry a marker — and refuses others with exit 1. `--uninstall` removes only its own files. |

Exit codes: `0` ok, `1` the check found errors or a step failed and was rolled back, `2` invalid
input — nothing was changed, `130` cancelled with Ctrl+C (or a closed terminal, `kill`) and rolled
back. `--check` and `--promote` still work as aliases. `wsg help <command>` (or `wsg <command> --help`)
describes a command's options. `--help`, `help`, `--version`, `--where`, `shell-init`, `guide` and
`install-skills` work even when the settings file can't be read.

What you get once setup is done:

```
$WS_ROOT/oauth-refresh/
├── CLAUDE.md          entry point for Claude: imports + specifics
├── AGENTS.md          task rules; the only source for Codex
├── README.md          task card: problem, sources, links, how to launch
├── notes.md           current state, code map, open questions
├── SETUP.md           how to run the setup again, for agents without skills
├── mr-target-branch.txt  target branch of the main repository
├── repo -> api        pointer to the main repository
├── api/               git worktree on the task branch
├── web                symlink to a shared checkout
├── .claude/
│   ├── settings.json  own auto-memory, permissions, push ban
│   ├── wsg.json       the sources and how each is attached: what wsg add renders from
│   ├── rules/<repo>.md rules loaded when working with the repo's files
│   └── skills/wsg-setup/ the setup dialogue, invoked as /wsg-setup
├── .claude-memory/    memory for this task only
└── .learnings/        lessons and failures of this task
```

## Kinds of workspace

| | **task** | **process** |
|---|---|---|
| lives | until merge | permanently |
| bound to | ticket and branch | nothing: each run gets its own input |
| main artifact | plan, spec, review | `.claude/skills/<name>/SKILL.md` |
| log | `notes.md` → "Current context" | `journal.md` + `runs/<date>-<short-name>.md` |
| memory | context of one task | accumulates across runs |

A **task** is regular ticket work. A **process** is a repeatable engineering procedure: a release,
a dependency upgrade, a routine migration. A process keeps its procedure in a skill that is invoked
manually (`/release 2.4`, or just `/release` to go through whatever is new), and its run log
accumulates what broke last time. No tracker needed: runs are named by date.
Create one with `wsg new <slug> --kind process`: the skill is named after the slug, `--skill <name>`
for another name.

A task that turns out to be repeatable is turned into a process: `wsg promote <slug> --skill <name>`.

A third kind, the **epic**, holds several tasks: see [Epics](#epics).

### Tasks without code

Not every ticket changes code: a spec, a research, a decision to make. `wsg new <slug> --no-code`
makes such a task (a task only: refused for a process or an epic), and its state keeps `noCode: true`.

| | ordinary task | `--no-code` task |
|---|---|---|
| repository | at least one git repository, a worktree on the task branch | none, no branch; in an epic it takes none of the epic's sources (`--sources a,b` is refused) |
| `wsg add` | `--worktree`, `--link`, `--reference` | `--link` and `--reference` only, to read material; `--worktree` is refused; a linked repository gets a read-only rule, and there is no `repo` pointer and no `mr-target-branch.txt` |
| Verification | a command the agent runs | `- None: no code in this task; ...`: done is what the owner checks |
| `wsg check` | warns until a git repository is attached | warns while the Definition of done says FILL IN |
| `wsg list --json`, `wsg new --json` | `noCode: false` | `noCode: true` |

`wsg promote` of such a task makes an ordinary process: `noCode` goes from the state, and says so.

### Checklist and spec stages

Every task made by wsg 0.8 gets `checklist.md`: the Definition of done as checkboxes, written by the
setup (`- [ ] FILL IN` until then) and ticked `- [x]` only with evidence. wsg counts the boxes —
`-`, `*`, `+` or `1.` items at any indent; lines in HTML comments, in code blocks and FILL IN lines are
not counted — and gives `checklist: {done, total}` in `wsg list --json` and `wsg status --json`.
Moving a task to review or done warns "N of M checklist items unchecked", and never refuses;
`wsg check` warns about a FILL IN left after the setup and about unchecked items on a done task.
Processes and epics get none, and tasks made before 0.8 get none added (`wsg check` notes it).

`wsg new <slug> --spec` (a task only) adds `spec.md` and `plan.md` templates and a `## Stages`
section in `AGENTS.md`: the agent writes the spec first and waits for your "ok", then builds
`checklist.md` from the spec's acceptance criteria and writes the plan for your "ok", then
implements, then reviews the checklist — each item ticked with evidence, what is unchecked shown to
you. With `--no-code`, `plan.md` has no files or tests. The state keeps `spec: true` (`wsg list --json` gives `spec`). Without `--spec` nothing
of this is added.

## Epics

An epic workspace is one tracker epic: what its tasks must know, the epic's repositories with the
settings its tasks reuse, and the tasks themselves, each an ordinary task workspace in a directory
of the epic. Use it when several tasks share repositories and decisions, and what one task learns
should reach the next. A single task needs no epic.

```bash
wsg new shop --kind epic --ticket ACME-1        # the epic; /wsg-setup attaches its repositories
cd "$WS_ROOT/shop"
wsg add ~/projects/api --branch-template 'alice/task/{slug}/{ticket}' --verify "npm test"
wsg new cart-fix --epic shop --ticket ACME-42   # a task; its api worktree on alice/task/cart-fix/ACME-42
ws shop/cart-fix                                # work in it (ws cart-fix finds it too)
```

```
$WS_ROOT/shop/
├── CLAUDE.md          a few hundred bytes: it loads in every task below too (see Limitations)
├── AGENTS.md          the epic's rules, for the epic's own sessions
├── knowledge.md       what every task must know: decisions, repositories, pitfalls
├── tasks.md           the tasks in this directory, and other people's from the tracker
├── decisions.md       the rationale behind the decisions
├── .mcp.json          the epic's MCP servers (wsg mcp), found from every task below
├── api -> ~/projects/api  a link, with the defaults its tasks reuse
├── .claude/
│   ├── rules/epic-knowledge.md  a pointer to knowledge.md, loaded every session
│   └── skills/wsg-epic-{task,close,sync}/  manual wrappers over wsg guide epic
└── cart-fix/          a task: its worktree api/, its own AGENTS.md, notes.md, memory
```

- **Repositories.** In an epic, a repository is always a link: the epic has no branch of its own.
  `--branch-template` gives each task a worktree of the repository on its own branch: `{slug}`
  (the task's directory) and `{ticket}` (its ticket key) are the placeholders, at least one is
  required, and `--dry-run` shows a sample branch. `--base`, `--carry` and
  `--[no-]clone-node-modules` become the defaults of that worktree; the task reuses the
  repository's `--target` and `--verify`. Without a template the repository is linked into each
  task as is. `--worktree`, `--branch` and `--reset-to-base` are refused. `wsg remove <name>` in the
  epic drops the link and its defaults; tasks that have the repository keep it.
- **Tasks.** `wsg new <slug> --epic <epic>` names the epic every time: it is never taken from the
  current directory. Without `--sources` the task takes the epic's repository with a branch
  template when there is exactly one, else none; `--sources a,b` or `--sources none` decides.
  `{ticket}` needs `--ticket`: the key is written once into the task's `.claude/wsg.json`. Every
  source is checked before anything is made, so one refused refuses the task; `--dry-run` shows
  the branches first. A task without a git repository reports setup not finished: from the task,
  `wsg add <name>` takes the epic's source of that name later (a flag given wins, `./<name>` is a
  path). The epic's `tasks.md` lists the task, and the task's `AGENTS.md` points to
  `../knowledge.md` and `../tasks.md` and renders the epic's Owner rules in a
  `<!-- wsg:epic-rules -->` block: a rule added to the epic later reaches the task at its next
  `wsg refresh`; `wsg check` on the epic names the tasks that need one.
- **Context.** Specs, briefs, mockups and runbooks the tasks may need go in with `wsg context add
  <url|path>` and `wsg context note <id>` from the epic: links stay in the state, files and notes
  live in the epic's `context/`. Every task's `AGENTS.md` gets only the index, in a
  `<!-- wsg:epic-context -->` block, rendered into all open tasks at once; bodies are read on demand.
- **MCP.** `wsg mcp add <name> -- <command> [args...]` (or `--url URL`) from the epic gives every
  task the server: it goes into the epic's `.mcp.json`, and the epic's and each task's
  `.claude/settings.json` enable it by name. `wsg mcp disable <name>` turns a global server off in
  the epic and its tasks (`deniedMcpServers`; a plugin's as `plugin:<plugin>:<server>`). The
  owner's own entries in both files are kept. Secrets stay in your environment: `--env NAME` and
  `--bearer-env VAR` put `${NAME}` into `.mcp.json`, a literal for a secret-looking name is refused,
  and `wsg mcp list` names the variables your shell lacks. Claude Code only; see Limitations.
- **Knowledge.** `knowledge.md` is the single source of truth, kept within 4 KiB and rewritten
  rather than appended to. A task never edits the epic's files: what the next task should know
  goes under `## For the epic` in the task's `notes.md`, dated, with evidence. When its work is
  finished, the task's session sets it to review (`wsg status shop/cart-fix review`). The agent in
  the epic session then merges it (`/wsg-epic-close <task>`; in Codex, ask it to run
  `wsg guide epic`, section Closing) into `knowledge.md`, `.claude/rules/<repo>.md`,
  `decisions.md` and `tasks.md`, after your "ok", and then marks it done with
  `wsg close shop/cart-fix`, the last write. The status lives in the task's `.claude/wsg.json`; `tasks.md` and `wsg list`
  show it as `[review]` or `[done <date>]`. `/wsg-epic-sync` reads
  the epic's other tasks from the tracker, with any read tool the agent has, into `tasks.md`:
  every child issue without a task directory is a line under "Other tasks", by its key, in the
  order kept, new ones appended; nothing is ever written to the tracker. `wsg reorder` changes the order
  of either group (`wsg reorder cart-fix --to 1`, `wsg reorder ACME-12 --before ACME-7`). To start a task, ask in the epic session
  (`/wsg-epic-task <ticket>`). A tracker task without a repository is never skipped by the agent:
  it asks you — create it with `--no-code`, attach a repository, or do not start it. The procedures are in [docs/epic-guide.md](docs/epic-guide.md)
  (`wsg guide epic`), so any agent can follow them; the skills only point there. The skill files
  are written once, when the epic is made: an older epic keeps its own, and gets new rules through the guide.
- **Check.** `wsg check` in the epic checks `knowledge.md` (a warning over 4 KiB, an error over
  8 KiB), the pointer rule, the `tasks.md` block, the skills and the tasks inside — a task whose
  state does not read, a done task whose `## For the epic` still has entries — and, with MCP
  servers, `.mcp.json`, the tasks whose settings are behind, variables your shell lacks and a
  server that takes the name of one in your user-scope config. In a task
  (`wsg check shop/cart-fix`) it checks the link to the epic and the epic block of `AGENTS.md`, and
  its always-on budget counts what loads from the epic: its `CLAUDE.md` and rules without `paths:`.
- **Not in an epic.** `wsg team` refuses an epic with exit 2 — its agents would load in every task
  below; run it in a task. `wsg promote` refuses an epic and a task of one.
- **`ws`** lists each epic with its tasks under it; `ws <epic>/<task>` jumps into one, and so does
  the task's name alone or a prefix when it is unambiguous.

## What the setup dialogue asks

Not only paths and branches, but also what the agent is useless without — each answer in its own
section of `AGENTS.md`. The agent reads them in every session, so 1–3 lines per answer is the goal.

| task | process |
|---|---|
| **problem** and why now — required, it defines the scope | **what it does** and what it gives you — required |
| **definition of done** | **when it runs** |
| **out of scope** — nearby things not to touch | **input of each run** — the skill's arguments |
| **invariants** — deliberate decisions that look like violations; without them the agent and the reviewer subagent will "fix" them | **rules and boundaries** — always-on, not only inside the skill |
| | **when a run is finished** |

A process's steps are not asked up front: the agent works them out with you on the first run.
Until the "Why" section is filled in and a git repository is attached, `wsg check` warns that
setup is not finished. A task without code (`--no-code`) is asked for a done criterion the owner
can check instead of a repository and a command.

## Sources

A workspace is for code: it needs at least one git repository — unless it is a
[task without code](#tasks-without-code).

| Type | Attached as |
|---|---|
| git repository you edit | `git worktree` inside the workspace, own branch (the default for a repository root) |
| git repository you read | `--link`: symlink + `additionalDirectories` (always for a subdirectory of a repository) |
| reference directory, no git | `--reference`: symlink + `additionalDirectories`, next to the repositories |

A reference directory holds material the task works from — specs, exports, designs. It has no
history, so the agent is told to change files there only when you ask; nothing makes it read-only.

When creating a worktree, the generator carries over what git doesn't — `.env`, certificates,
local configs — and populates `node_modules` with a clone instead of an install. On APFS this is
copy-on-write: a directory that `du` reports as 2 GB takes about 70 MB and a couple dozen
seconds instead of a full install.

## Generated parts

`.claude/wsg.json` records the sources and how each is attached. Every `wsg add` re-renders from it
what the generator owns: the blocks between `<!-- wsg:… -->` markers in `AGENTS.md`, `CLAUDE.md`
and `README.md` (in `AGENTS.md`, also the one-line advisor rule), `permissions.additionalDirectories` in `.claude/settings.json`, the `repo`
pointer and `mr-target-branch.txt` (an epic has neither); in an epic and its tasks also the
epic's MCP entries — its servers in the epic's `.mcp.json`, `enabledMcpjsonServers` and
`deniedMcpServers` in `.claude/settings.json` — next to the owner's own, which stay. Text outside the markers — what the agent and you write — is
never touched, and other keys in `settings.json` are kept. `wsg refresh` re-renders them without
attaching anything — for a workspace made by an earlier wsg. Details: [docs/conventions.md](docs/conventions.md).

## Validator

`wsg check` checks a workspace against the limits documented by the vendors:

| File | Target | Ceiling |
|---|---|---|
| `CLAUDE.md` | ≤ 100 lines | 200 lines |
| `AGENTS.md` | ≤ 16 KiB | 32 KiB for the whole chain in Codex |
| auto-memory index | — | 200 lines or 25 KB |

Plus: imports resolve and don't point outside the workspace, rules have `paths` set, `settings.json`
is valid, there is a section with a verification command, `.learnings/` isn't at the root of a git
checkout, and — for workspaces made by wsg 0.2 and later — whether setup is finished, whether
`AGENTS.md` has the advisor block, and whether the agent the workspace starts with has the
`wsg-advisor` agent installed and current (a warning, never an error). Workspaces made by 0.1
get the same report as before; `wsg add` refuses them, since they have no `wsg.json`.

Run it periodically, not just after creation: files grow.

## Advisor

A workspace agent tends to ask its owner what it could have found out itself: what CI runs, what
your rules say about MRs, how wsg treats a git repository given as `--reference`, an answer that
sits in a comment on a ticket nobody linked. `wsg-advisor` is a second, read-only agent that checks
those questions first, so that only real decisions reach you.

- **How it is called.** A one-line rule in a generated block of `AGENTS.md` (`<!-- wsg:advisor -->`):
  questions and decisions for the owner, and planned `wsg add`/`wsg remove` commands, go through the
  advisor first, and the owner sees only its FOR THE OWNER block, as is.
  `CLAUDE.md` has a block of the same name telling Claude Code to call the subagent with a
  self-contained brief, and the agent's description starts with "MUST BE USED before…". The setup
  guide does the same at each step. `wsg refresh` adds the blocks to a workspace made by an earlier
  wsg; `wsg check` warns when one is missing.
- **What it does.** It looks for evidence in a fixed order — the code and CI, your rules
  (`AGENTS.md`, `notes.md`, `.claude/wsg.json`), facts about wsg, sibling workspaces under
  `WS_ROOT`, git history, the tracker if a read tool for it is configured — and replies in a fixed
  contract: ANSWERED (each with its evidence), OWNER, THIRD-PARTY (a draft, never sent), CONTEXT,
  PLAN REVIEW, SKIPPED, and last FOR THE OWNER: how many questions checks settled, then only the
  OWNER items with a recommendation and the THIRD-PARTY items with a draft. The workspace agent
  shows you that block as is, and nothing else from the reply.
- **What it never does.** Push, MR, messages to people, `--reset-to-base`, scope changes and
  exceptions to your rules always stay yours; an advisor answer is never your consent. When your
  rules already say no to one of them ("the owner opens MRs"), it answers the agent with that rule
  instead of asking you. It writes nothing and never talks to you.
- **Where it lives.** User-level, written by `wsg install-skills`: `~/.claude/agents/wsg-advisor.md`
  for Claude Code, `~/.codex/agents/wsg-advisor.toml` for Codex — only when Codex is there
  (`CODEX_HOME` is set, `~/.codex` exists or `codex` is on PATH), otherwise it is reported as
  skipped. The Claude Code advisor has no write tools, and a hook in its agent file blocks any tool
  call that is not on its read-only list; the Codex one sets `sandbox_mode = "read-only"`, which is
  not verified to hold under a writable parent session. It
  works in existing workspaces;
  running `wsg install-skills` again upgrades it. `wsg new` and `wsg add` never install it.
- **The procedure** lives in [docs/advisor-guide.md](docs/advisor-guide.md) (`wsg guide advisor`);
  the agent files are thin: a new procedure arrives with an upgrade of wsg, without reinstalling them.
- **Which wsg it runs.** Both agent files name the CLI of the wsg that installed them by its
  absolute path, and the advisor runs wsg only as `node "<path>/bin/cli.js" …` — never `wsg` from
  PATH or `npx`, which could be another wsg. In Claude Code the guard lets no other wsg through.

**Codex.** Codex has custom agents, but it reliably spawns one only when that is the main thing it
is asked; told to by `AGENTS.md`, it often doesn't. So the rule lets the workspace agent follow
`wsg guide advisor` inline instead, and forbids it to claim the advisor ran when it did not. MCP
calls from a Codex subagent under `codex exec` can be blocked by the approval policy; the advisor
then reports the tracker as skipped. Any other agent that reads `AGENTS.md` follows the guide inline.

## Team

`wsg team fullstack` gives the workspace agent a team of roles for a feature. The setup dialogue
offers it once a repository is attached; it is optional.

```
team/<role>.md                    role cards: the portable source of truth, read by any agent
team/workflow.md                  stages 0–6 and who writes which file
AGENTS.md  <!-- wsg:team -->      three lines pointing to both
.claude/agents/wsg-<role>.md      Claude Code adapter: "read team/<role>.md and follow it"
.claude/skills/wsg-feature/       /wsg-feature runs the workflow (task workspaces; a process
                                  skill gets one pointer line instead)
```

| Role | What it does | Tools |
|---|---|---|
| `pm` | Requirements: scope, checkable acceptance criteria, open questions | read-only, hands back `requirements.md` |
| `designer` | Only with an agreed design: `design.md` (screens, states, copy, tokens, gaps), then a Design section of the review | read-only, hands back |
| `frontend` | UI: markup, styles, responsive layout, accessibility, loading, empty and error states | all but Agent |
| `backend` | Server side; agrees the API contract in `plan.md` before code | all but Agent |
| `devops` | Only infrastructure work `plan.md` lists; deploy, secrets, DNS, destructive operations only with your permission | all but Agent |
| `reviewer` | Findings for `review.md`; never fixes | read-only, hands back |

- **The lead.** The main session is the tech lead and the only one who talks to you. It hands out
  the stages, saves what the read-only roles return, and shows you each stage where the workflow
  asks for your "ok".
- **Handback.** `pm`, `designer` and `reviewer` have no Write, Edit or NotebookEdit: each returns
  its document as its final message, and the lead saves it verbatim to `requirements.md`,
  `design.md` or `review.md`.
- **Role memory and `/wsg-teach`.** Every adapter has `memory: user`: a role's memory is
  `~/.claude/agent-memory/wsg-<role>/` (under `$CLAUDE_CONFIG_DIR` when set), shared by all your
  workspaces. `/wsg-teach <role> <url|text>` (installed by `wsg install-skills`, follows
  `wsg guide teach`) writes a general practice there after your "ok"; repository rules and task
  facts go elsewhere. `wsg check` reports memory over the limit and index lines without a file.
- **Re-running.** `wsg team` only adds: a missing role's files are written, an existing file is
  kept as it is, never overwritten or removed; only the generated blocks (the roles list in
  `team/workflow.md`, the team block in `AGENTS.md`, and in a process workspace the pointer block
  of its skill) are rendered again. `--without` is not remembered: the next run without it adds
  the roles left out. Removing a role is by hand.
- **Codex** and other agents read the cards through `AGENTS.md` and play a role from its card;
  there are no Codex role agents yet.

## Settings

`~/.config/wsg/config`:

```bash
WS_ROOT="$HOME/workspaces"                               # where workspaces are created
WSG_AGENT="claude"                                       # the agent wsg new and ws launch
WSG_LANG="ru"                                            # messages of wsg and ws: en or ru
WSG_TRACKER_URL="https://tracker.example.com/browse/"    # prefix for the ticket number
WSG_GLOBAL_MEMORY="$HOME/.config/agent-rules.md"         # your personal rules
WSG_PARENT_CONTEXT="$HOME/CLAUDE.md"                     # count toward the always-on budget
```

All optional. Use a different settings file via the `WSG_CONFIG` environment variable.

**Agent.** `wsg new` starts `WSG_AGENT` in the new workspace — or `claude` when it is not set and
claude is on PATH — with the first message `/wsg-setup` (codex gets "Read SETUP.md and follow it";
any other command is printed for you to run). Only in a terminal: piped or in a script it prints
the next step, as with `--no-launch` or `WSG_NO_LAUNCH=1`.
If `WSG_AGENT` is not set, `ws <slug>` on first run offers the agents found in PATH
(by number) or a custom command, and saves the choice to the config. `ws --agent` asks again and
replaces it; so does editing the line by hand — `ws` rereads the config on every call. With `claude`, ws resumes the workspace's
last session with a message in it (`--resume <id>`: the newest `<uuid>.jsonl` under
`${CLAUDE_CONFIG_DIR:-~/.claude}/projects/`, so a session started through the Agent SDK, by an app
for example, counts too, which `claude --continue` would skip; a session file changed in the last
minute gets a warning that it may be open elsewhere, and a non-zero exit of claude is said, never
followed by a new session), `ws <slug> --new` starts a new one; with `codex`, it attaches symlinked directories via `--add-dir`. Any other command
(`gemini`, `cursor-agent`, `opencode`…) is run as-is; such an agent reads `AGENTS.md`,
while the `.claude/` files — path-scoped rules, the push ban, separate memory — only work in Claude Code.
To bypass the setting once: `ws <slug> --claude`, `ws <slug> --codex` or `ws <slug> --cd`.

**Language.** The messages of `wsg` itself and `ws` speak English or Russian: `WSG_LANG` in the
config, otherwise the locale (`ws` picks a change up in a new terminal). The `wsg check` report
stays English. Workspace files are always English — agents work best with it, and it costs fewer
tokens. In the setup dialogue you answer in any language; the agent translates into English and
shows you the text before writing it.

## Limitations

- **Platform.** Tested on macOS with zsh. The `ws` function requires zsh; Windows only via WSL:
  the generator creates symlinks and git worktrees.
- **Copy-on-write on macOS only.** Cloning `node_modules` uses `cp -Rc`. Node can't do it:
  `COPYFILE_FICLONE` exists, doesn't fail, and silently copies byte by byte —
  57 MB of data took 57 MB of disk versus 0 MB with `cp -c`.
- **Overlap with built-in tooling.** Claude Code has its own `--worktree`,
  `.worktreeinclude`, and auto-cleanup. `wsg` helps where those fall short: a task spanning several
  repositories, a task knowledge layer, and a limits validator.
- No command to delete a workspace — for now, three commands by hand.
- **Epics in Codex are only partly verified.** Epics were built and tried with Claude Code. A
  task carries what it needs from its epic in its own `AGENTS.md` — plain-text pointers and the
  epic's Owner rules, rendered — because Codex reads only the `AGENTS.md` of its directory: the
  workspace is no git repository, so the epic's `AGENTS.md` above is not in its chain (verified
  2026-11-15 with the prompt Codex builds, before any model call). How Codex answers in a task,
  and whether it reads `../knowledge.md` from one, is not verified. The epic's rules in a task are
  as of its last `wsg refresh` (or `wsg add`, `wsg remove`, `wsg team`), never pushed from the
  epic. `ws <epic>/<task> --codex` adds `--add-dir` for the task's linked sources, not for the
  epic directory.
- **A task session under an epic.** Observed with `claude -p`: a task's session loads the epic's
  `CLAUDE.md`, rules, skills and agents, but not its `.claude/settings.json` (the task's own
  apply) and not an `@` import that leaves the task directory — so the task's `AGENTS.md` points to
  `../knowledge.md` in plain text. An interactive session in a trusted folder was not checked: the
  epic's `CLAUDE.md` imports its `AGENTS.md` (`@AGENTS.md`), and if Claude Code asks to allow that
  external import and you agree, every task session also loads the epic's `AGENTS.md`. The task's
  always-on budget in `wsg check` counts the epic's `CLAUDE.md`, not that import.
- **An older wsg.** wsg 0.4.x refuses an epic: its state is version 3. A task inside an epic is
  version 2, and 0.4.x takes it for a plain task. wsg 0.7 and earlier do not know an epic's
  `taskOrder` (`wsg reorder`): their `wsg refresh` lists its tasks by name again. Use one wsg version for an epic and its tasks.
- **The advisor is not a sandbox.** In Claude Code it has no Write, Edit, NotebookEdit, Agent or
  Monitor tool, and a `PreToolUse` hook in its agent file runs `lib/advisor-guard.js` before every
  tool call: Read, Grep, Glob, WebFetch, WebSearch, ToolSearch and SubagentHandback (how a
  backgrounded advisor hands back its report) pass, a Bash command must be one
  plain read command from a list (no pipes, redirection, `#` or `$`; only a quoted `--verify` or
  `--note` of a dry-run `add` may hold `&& | ; ( ) # < >`), an MCP tool's name must say
  it reads (get, list, search…) and not that it writes; anything else — another tool, a name it
  cannot tell, a guard that cannot run — blocks the call. That is a list, not a sandbox: whatever a listed command
  or tool can reach, the advisor can read, and it has the MCP tools of the session that calls it.
  The hook and CLI paths are absolute: after the package moves, `wsg check` reports the agent as broken until
  `wsg install-skills` runs again (the Codex one as outdated). In Codex the advisor's agent file sets
  `sandbox_mode = "read-only"`; whether Codex applies it to a spawned agent under a writable parent
  session is not verified, so that it writes nothing, shell and MCP, is the rule in its prompt. Its answers can be wrong: each one has to cite its evidence, and irreversible steps
  stay with you. A project-level `.claude/agents/wsg-advisor.md` or `.codex/agents/wsg-advisor.toml`,
  in the workspace or a directory above it, would shadow the installed one — and Claude Code skips
  the hooks of a project-level agent in a folder it was not told to trust; `wsg check` warns about
  such a copy.
- **A repository's own git config.** The advisor's git commands only read, but the config of any
  repository git runs in can make it run a program: `core.fsmonitor` on `git status`,
  `diff.external` and textconv drivers on `git diff`, `core.sshCommand` on `git ls-remote`. The
  guard blocks `--ext-diff` and `--textconv`, and limits git to the workspace and its sources:
  `git -C` takes only the workspace, a source's path from `.claude/wsg.json` or a directory under
  one (after realpath, no bare repository committed inside), and `git ls-remote` only `.` or a
  remote the repository configures. What their config turns on by itself, it cannot override:
  the workspace and the repositories you attach are trusted, like any code you run. `git status`
  also refreshes `.git/index`, an internal write: accepted.
- **What the guard does not see.** It checks the command Claude Code is about to run, before the
  shell: another `PreToolUse` hook that rewrites the input (`updatedInput`) runs after it with a
  command it never saw, the aliases and functions of Claude Code's shell snapshot still apply to
  the words it allowed, and a hook that times out lets the call through. WebFetch and WebSearch
  pass: the advisor could send what it read out in a URL. Accepted; its rule is never to put the
  contents of a local file or a secret in a URL. An MCP tool that reads can still have a side
  effect its name does not show — a `get_file` that saves the file, a `read_thread` that marks it
  read — and passes.
- **What `wsg remove` doesn't see.** A tracked file marked `skip-worktree` or `assume-unchanged`
  and edited in the worktree looks clean to git: it is deleted with the worktree. If a removal
  fails after the worktree is gone, the rollback adds the worktree back on the same branch, but
  without the carried files and the ignored files you agreed to lose.
- **Workspace trust.** Until Claude Code's trust dialog has been accepted once in a workspace (an
  interactive session there), a `claude -p` run in it ignores `permissions.allow` from its
  `.claude/settings.json` — Claude Code says so on stderr. The first `wsg new` launch is
  interactive, so it shows the dialog.
- **Linked directories mid-session.** Whether a running session picks up a directory that
  `wsg add --link`/`--reference` adds to `additionalDirectories` is not verified; `wsg add` asks
  for a restart whenever it changes `settings.json`. `test/smoke-claude.sh` (manual, needs claude)
  checks this and the other behaviour wsg relies on against a real Claude Code; its header lists
  the steps.
- `paths` in rules are untested for a repository attached via a symlink pointing outside.
- **An epic's MCP servers.** Claude Code only; Codex is not supported yet (`--agent codex` is
  refused). A running session keeps its servers: restart it after `wsg mcp`. In a terminal, the
  epic's servers stay "Pending approval" in a task until that task's folder is trusted — trust is
  per task directory, a trusted epic does not carry over (observed with Claude Code 2.1.325,
  `test/smoke-claude.sh` step 8). Turning a global server off relies on `deniedMcpServers` in a
  project's `.claude/settings.json`, observed on 2.1.325 but documented by Claude Code for managed
  settings; a plugin's server is turned off by `plugin:<plugin>:<server>`, a claude.ai connector by
  name is not verified, and `wsg mcp list` shows neither. `.mcp.json` and `wsg mcp list --json`
  carry the commands, arguments and URLs as given: keep tokens in variables. A server that signs
  in with OAuth needs one authentication in a terminal session.
- **A team shares one working copy.** Roles work in the same worktree, with no per-role worktree:
  two roles editing one file overwrite each other. The file ownership table in `plan.md` is the
  only protection, so parallel work needs rows that do not overlap.
- **A team is prompts, not isolation.** The read-only roles have no file tools, but they keep
  Bash, so they can still write through it, and the MCP tools of the session (a design tool's
  write tools, say) — not writing is their card's rule. Symlinked sources and
  `additionalDirectories` are not read-only either.
- **Parallel stages can stall.** A background subagent's permission prompt waits for you, so a
  parallel stage stops until it is answered. Per the Claude Code docs, a subagent's
  `permissionMode` is ignored when the session runs in bypassPermissions, acceptEdits or auto mode.
- **Inherited agents and skills.** Claude Code also loads agents and skills from `.claude/` in
  directories above the workspace. The closest file of a name wins, so a role deleted here is
  taken from above when a directory there has one.
- **Role memory** is per user, shared by every workspace, and needs Claude Code's auto memory
  turned on.
- **New role agents and `/wsg-feature` need a new session.** A session that ran `wsg team` did
  not find the roles it had just written (observed with Claude Code in `-p` mode; the
  interactive live reload was not checked); `wsg team` says so after it adds them.
- **Code fences wsg reads.** Blockquotes are not parsed: a code fence inside `>` is treated as
  text. A fence left unclosed inside a list item stays open to the end of the file (CommonMark
  closes it with the item), so close fences explicitly.

## Documentation

- [docs/conventions.md](docs/conventions.md) — limits and rules: what is always loaded, what on demand
- [docs/workflow.md](docs/workflow.md) — workflow, troubleshooting common failures
- [docs/setup-guide.md](docs/setup-guide.md) — the setup dialogue the agent follows
- [docs/advisor-guide.md](docs/advisor-guide.md) — what the advisor checks, in what order, and how it answers
- [docs/epic-guide.md](docs/epic-guide.md) — starting, closing and syncing the tasks of an epic
- [docs/teach-guide.md](docs/teach-guide.md) — how `/wsg-teach` writes a practice into a role's memory
- [docs/json-contract.md](docs/json-contract.md) — what `--json` prints, for scripts and apps

Sources for the limits: [Claude Code memory](https://code.claude.com/docs/en/memory),
[worktrees](https://code.claude.com/docs/en/worktrees),
[AGENTS.md in Codex](https://developers.openai.com/codex/guides/agents-md).

## License

MIT
