# wsg — Workspace Generation

Task workspaces for coding agents: Claude Code, Codex, and anything else that reads `AGENTS.md`.
One directory per task — with its own session history, its own agent memory, rules that load
on demand, and the repositories inside as `git worktree`s.

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
ws --agent             # choose the agent again
wsg check              # check the workspace you are in against the conventions
```

The commands the agent (or you) call:

| Command | What it does |
|---|---|
| `wsg new <slug> [--title T] [--kind task\|process] [--skill NAME] [--ticket X] [--no-launch]` | Creates the skeleton and starts the agent; `--no-launch` prints the next step instead. |
| `wsg add <path> [--worktree\|--link\|--reference] [--branch B] [--base REF] [--reset-to-base] [--target T] [--verify CMD] [--carry all\|none\|a,b] [--[no-]clone-node-modules] [--note TEXT] [--dry-run] [--ws SLUG\|PATH]` | Attaches one source to the workspace you are in. An existing branch is attached as it is, one only on origin is continued; `--reset-to-base` starts it over (with a `backup/…`). Every check happens before anything is touched; a failure rolls back only this source. `--dry-run` prints the plan as JSON. |
| `wsg remove <name> [--delete-ignored] [--dry-run] [--ws SLUG\|PATH]` | Detaches a source: a clean worktree (its branch is kept) or the symlink, its rule, and its generated parts. Ignored files that exist nowhere else (made in the worktree, or carried in and changed since) are deleted with the worktree only after `--delete-ignored`; a `node_modules` wsg cloned is not checked, so changes inside it are not protected. The way to fix a source attached with the wrong flags: remove, then add again. |
| `wsg refresh [--dry-run] [--ws SLUG\|PATH]` | Brings the generated parts up to date with this wsg — e.g. adds the advisor block to a workspace made by 0.2 — and touches nothing else. `--dry-run` prints the files it would change as JSON. |
| `wsg check [path\|slug]` | Checks a workspace against the conventions. |
| `wsg promote [slug\|path] --skill NAME` | Turns a task into a process. |
| `wsg guide [setup\|advisor]` | Prints a guide an agent follows: the setup dialogue, or the advisor's procedure. |
| `wsg install-skills [--uninstall]` | Installs the `wsg-new` skill into `~/.claude/skills` and the `wsg-advisor` agent into `~/.claude/agents` (or under `$CLAUDE_CONFIG_DIR`) and, when Codex is there, `~/.codex/agents` (or `$CODEX_HOME/agents`). Overwrites only files it wrote — they carry a marker — and refuses others with exit 1. `--uninstall` removes only its own files. |

Exit codes: `0` ok, `1` the check found errors or a step failed and was rolled back, `2` invalid
input — nothing was changed, `130` cancelled with Ctrl+C (or a closed terminal, `kill`) and rolled
back. `--check` and `--promote` still work as aliases. `--help`, `--version`, `--where`,
`shell-init`, `guide` and `install-skills` work even when the settings file can't be read.

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

## Two kinds of workspace

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
Create one with `wsg new <slug> --kind process --skill <name>`.

A task that turns out to be repeatable is turned into a process: `wsg promote <slug> --skill <name>`.

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
setup is not finished.

## Sources

A workspace is for code: it needs at least one git repository.

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
pointer and `mr-target-branch.txt`. Text outside the markers — what the agent and you write — is
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
  advisor first, and the owner sees only its OWNER and THIRD-PARTY items and one summary line.
  `CLAUDE.md` has a block of the same name telling Claude Code to call the subagent with a
  self-contained brief, and the agent's description starts with "MUST BE USED before…". The setup
  guide does the same at each step. `wsg refresh` adds the blocks to a workspace made by an earlier
  wsg; `wsg check` warns when one is missing.
- **What it does.** It looks for evidence in a fixed order — the code and CI, your rules
  (`AGENTS.md`, `notes.md`, `.claude/wsg.json`), facts about wsg, sibling workspaces under
  `WS_ROOT`, git history, the tracker if a read tool for it is configured — and replies in a fixed
  contract: ANSWERED (each with its evidence), OWNER, THIRD-PARTY (a draft, never sent), CONTEXT,
  PLAN REVIEW, SKIPPED. The workspace agent shows you only the OWNER and THIRD-PARTY items and one
  summary line.
- **What it never does.** Push, MR, messages to people, `--reset-to-base`, scope changes and
  exceptions to your rules always stay yours; an advisor answer is never your consent. When your
  rules already say no to one of them ("the owner opens MRs"), it answers the agent with that rule
  instead of asking you. It writes nothing and never talks to you.
- **Where it lives.** User-level, written by `wsg install-skills`: `~/.claude/agents/wsg-advisor.md`
  for Claude Code, `~/.codex/agents/wsg-advisor.toml` for Codex — only when Codex is there
  (`CODEX_HOME` is set, `~/.codex` exists or `codex` is on PATH), otherwise it is reported as
  skipped. The Claude Code advisor has no write tools, and a hook in its agent file blocks any tool
  call that is not on its read-only list; the Codex one runs in a read-only sandbox. It
  works in existing workspaces;
  running `wsg install-skills` again upgrades it. `wsg new` and `wsg add` never install it.
- **The procedure** lives in [docs/advisor-guide.md](docs/advisor-guide.md) (`wsg guide advisor`);
  the agent files are thin: a new procedure arrives with an upgrade of wsg, without reinstalling them.

**Codex.** Codex has custom agents, but it reliably spawns one only when that is the main thing it
is asked; told to by `AGENTS.md`, it often doesn't. So the rule lets the workspace agent follow
`wsg guide advisor` inline instead, and forbids it to claim the advisor ran when it did not. MCP
calls from a Codex subagent under `codex exec` can be blocked by the approval policy; the advisor
then reports the tracker as skipped. Any other agent that reads `AGENTS.md` follows the guide inline.

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
previous session; with `codex`, it attaches symlinked directories via `--add-dir`. Any other command
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
- **The advisor is not a sandbox.** In Claude Code it has no Write, Edit, NotebookEdit, Agent or
  Monitor tool, and a `PreToolUse` hook in its agent file runs `lib/advisor-guard.js` before every
  tool call: Read, Grep, Glob, WebFetch, WebSearch and ToolSearch pass, a Bash command must be one
  plain read command from a list (no pipes, redirection, `#` or `$`), an MCP tool's name must say
  it reads (get, list, search…) and not that it writes; anything else — another tool, a name it
  cannot tell, a guard that cannot run — blocks the call. That is a list, not a sandbox: whatever a listed command
  or tool can reach, the advisor can read, and it has the MCP tools of the session that calls it.
  The hook path is absolute: after the package moves, `wsg check` reports the agent as broken until
  `wsg install-skills` runs again. In Codex the advisor agent runs in a read-only sandbox
  (`sandbox_mode = "read-only"`), so its shell cannot write; its MCP tools only read by the rule in
  its prompt. Its answers can be wrong: each one has to cite its evidence, and irreversible steps
  stay with you. A project-level `.claude/agents/wsg-advisor.md` or `.codex/agents/wsg-advisor.toml`,
  in the workspace or a directory above it, would shadow the installed one — and Claude Code skips
  the hooks of a project-level agent in a folder it was not told to trust; `wsg check` warns about
  such a copy.
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
  checks this and the setup launch against a real Claude Code.
- `paths` in rules are untested for a repository attached via a symlink pointing outside.
- **Code fences wsg reads.** Blockquotes are not parsed: a code fence inside `>` is treated as
  text. A fence left unclosed inside a list item stays open to the end of the file (CommonMark
  closes it with the item), so close fences explicitly.

## Documentation

- [docs/conventions.md](docs/conventions.md) — limits and rules: what is always loaded, what on demand
- [docs/workflow.md](docs/workflow.md) — workflow, troubleshooting common failures
- [docs/setup-guide.md](docs/setup-guide.md) — the setup dialogue the agent follows
- [docs/advisor-guide.md](docs/advisor-guide.md) — what the advisor checks, in what order, and how it answers

Sources for the limits: [Claude Code memory](https://code.claude.com/docs/en/memory),
[worktrees](https://code.claude.com/docs/en/worktrees),
[AGENTS.md in Codex](https://developers.openai.com/codex/guides/agents-md).

## License

MIT
