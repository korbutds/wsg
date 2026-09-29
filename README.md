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
npx wsgen
```

Install globally:

```bash
npm i -g wsgen
wsg --help
```

The package is called `wsgen`; the command is `wsg`.

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

<details>
<summary>Without npm — from the repository</summary>

```bash
git clone https://github.com/korbutds/wsg.git
cd wsg
./install.sh
```

`install.sh` installs dependencies, symlinks `wsg` into `~/.local/bin`, and hooks `ws` into `~/.zshrc`.
</details>

**Requirements:** Node 20.19+ (or 22.13+) and git — for both installation methods. The `ws` function is for zsh.

**Windows is not supported yet:** it needs git worktrees and POSIX-style symlinks. Works under WSL.

## Quick start

```bash
wsg                    # interview: kind of work, why, sources, invariants
ws                     # list workspaces with checkout state
ws <slug>              # go there and launch the agent (asks which one on first run)
wsg --check <path>     # check a workspace against the conventions
```

What you get:

```
$WS_ROOT/oauth-refresh/
├── CLAUDE.md          entry point for Claude: imports + specifics
├── AGENTS.md          task rules; the only source for Codex
├── README.md          task card: problem, sources, links, how to launch
├── notes.md           current state, code map, open questions
├── mr-target-branch.txt  target branch of the main repository
├── repo -> api        pointer to the main repository
├── api/               git worktree on the task branch
├── web                symlink to a shared checkout
├── .claude/
│   ├── settings.json  own auto-memory, permissions, push ban
│   └── rules/<repo>.md rules loaded when working with the repo's files
├── .claude-memory/    memory for this task only
└── .learnings/        lessons and failures of this task
```

## Two kinds of workspace

| | **task** | **process** |
|---|---|---|
| lives | until merge | permanently |
| bound to | ticket and branch | nothing: the ticket is a run argument |
| main artifact | plan, spec, review | `.claude/skills/<name>/SKILL.md` |
| log | `notes.md` → "Current context" | `journal.md` + `runs/<ticket>.md` |
| memory | context of one task | accumulates across runs |

A **task** is regular ticket work. A **process** is something that repeats: a release, a regular
export, a routine change. A process keeps its procedure in a skill that is invoked manually
(`/release <ticket>`), and its run log accumulates what broke last time.

A task that turns out to be repeatable is turned into a process: `wsg --promote <slug>`.

## What the interview does

It asks not only for paths and branches, but also for what the agent is useless without:

- **why** — what problem we're solving; an empty answer is not accepted, since this field defines the scope;
- **definition of done** — the acceptance criterion;
- **invariants** — deliberate decisions that look like violations of the repo's rules. Without them
  the agent and the reviewer subagent will "fix" them.

Anything left unfilled is marked `FILL IN`, and at the end the script lists those places.

## Sources

| Type | Attached as |
|---|---|
| git repository you edit | `git worktree` inside the workspace, own branch |
| git repository you read | symlink + `additionalDirectories` |
| document directory, no git | symlink + `additionalDirectories` |

When creating a worktree, the generator carries over what git doesn't — `.env`, certificates,
local configs — and populates `node_modules` with a clone instead of an install. On APFS this is
copy-on-write: a directory that `du` reports as 2 GB takes about 70 MB and a couple dozen
seconds instead of a full install.

## Validator

`wsg --check` checks a workspace against the limits documented by the vendors:

| File | Target | Ceiling |
|---|---|---|
| `CLAUDE.md` | ≤ 100 lines | 200 lines |
| `AGENTS.md` | ≤ 16 KiB | 32 KiB for the whole chain in Codex |
| auto-memory index | — | 200 lines or 25 KB |

Plus: imports resolve and don't point outside the workspace, rules have `paths` set, `settings.json`
is valid, there is a section with a verification command, `.learnings/` isn't at the root of a git checkout.

Run it periodically, not just after creation: files grow.

## Settings

`~/.config/wsg/config`:

```bash
WS_ROOT="$HOME/workspaces"                               # where workspaces are created
WSG_AGENT="claude"                                       # what ws launches as the agent
WSG_LANG="ru"                                            # interview and messages: en or ru
WSG_TRACKER_URL="https://tracker.example.com/browse/"    # prefix for the ticket number
WSG_GLOBAL_MEMORY="$HOME/.config/agent-rules.md"         # your personal rules
WSG_PARENT_CONTEXT="$HOME/CLAUDE.md"                     # count toward the always-on budget
```

All optional. Use a different settings file via the `WSG_CONFIG` environment variable.

**Agent.** If `WSG_AGENT` is not set, `ws <slug>` on first run offers the agents found in PATH
or a custom command, and saves the choice to the config. With `claude`, ws resumes the workspace's
previous session; with `codex`, it attaches symlinked directories via `--add-dir`. Any other command
(`gemini`, `cursor-agent`, `opencode`…) is run as-is; such an agent reads `AGENTS.md`,
while the `.claude/` files — path-scoped rules, the push ban, separate memory — only work in Claude Code.
To bypass the setting once: `ws <slug> --codex` or `ws <slug> --cd`.

**Language.** The interview, the messages of `wsg` itself and `ws` speak English or Russian:
`WSG_LANG`, otherwise the locale. The `wsg --check` report stays English. Workspace files are always
English — agents work best with it, and it costs fewer tokens. If you answer the interview in
Russian, the workspace gets a first-session task for the agent: translate what you typed into
English and show you the diff. Other languages aren't detected yet.

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
- `paths` in rules are untested for a repository attached via a symlink pointing outside.

## Documentation

- [docs/conventions.md](docs/conventions.md) — limits and rules: what is always loaded, what on demand
- [docs/workflow.md](docs/workflow.md) — workflow, troubleshooting common failures

Sources for the limits: [Claude Code memory](https://code.claude.com/docs/en/memory),
[worktrees](https://code.claude.com/docs/en/worktrees),
[AGENTS.md in Codex](https://developers.openai.com/codex/guides/agents-md).

## License

MIT
