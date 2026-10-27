# Conventions for agent task workspaces

The canonical source of limits for directories of the form `$WS_ROOT/<slug>/` that serve as
the working directory of a Claude Code or Codex session. The `wsg` generator
creates files according to these rules and also checks them (`wsg check`).

Basis: [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices),
[How Claude remembers your project](https://code.claude.com/docs/en/memory),
[Custom instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md).

## Principle

Everything comes down to one constraint: context fills up fast, and quality drops as it
fills. Hence the selection rule for every line of an always-on file: **if you remove it, will the
agent start making mistakes?** If not, cut it or move it to a file that loads on demand.

The second rule: **don't duplicate what's already in the repository.** If the repo has its own
`AGENTS.md` or `CLAUDE.md`, the workspace links to it or imports it, but doesn't rewrite it.

## Two kinds of workspace

The kind is recorded in `.claude/ws-kind` (`task` or `process`) and determines what `wsg check` checks.

| | **task** | **process** |
|---|---|---|
| lives | until the MR is merged | permanently |
| bound to | ticket and branch | nothing: the ticket is a run argument |
| main artifact | plan, spec, review materials | `.claude/skills/<name>/SKILL.md` |
| log | `notes.md` → "Current context" | `journal.md` + `runs/<date>-<short-name>.md` |
| branch | pinned at creation | new for each run, created by the skill |
| memory | context of one task | accumulates across runs |
| "done" | the task's acceptance criterion | the criterion of a single run |

In a process, git sources are attached via **symlink**, not worktree: a process has no permanent
branch, and a worktree would have to be kept in detached HEAD. The branch and, if needed, a
per-run worktree are created by the skill.

The procedure skill must have `disable-model-invocation: true`: a run has side effects, so it
is launched only on the owner's command, not whenever the agent decides the moment is right.

A process is a repeatable engineering procedure — a release, a dependency upgrade, a routine
migration.

A task that turns out to be repeatable is turned into a process: `wsg promote <slug> --skill <name>`. Sources,
rules and memory stay; a skill stub and a log with the first run are added. There is no reverse
conversion — there's no use case for it.

## Sources

A source is what the task works with, attached by `wsg add`. A workspace needs at least one git
repository: until it has one, `wsg check` warns that setup is not finished.

| Type | Attached as |
|---|---|
| git repository you edit | worktree inside the workspace, own branch |
| git repository you read | `--link`: symlink + `additionalDirectories` |
| reference directory, no git | `--reference`: symlink + `additionalDirectories`, described in the layout |

A reference directory is material the task works from, not code it changes. The rule for it asks
the agent to change files there only when the owner asks — a prompt, not a permission: nothing
makes it read-only.

## Generated parts

`.claude/wsg.json` is the single source of truth for what the generator owns: the sources and how
each one is attached (`path`, `name`, `mode`, `branch`, `base`, `target`, `verify`, `note`, `carry`,
`cloneNm`, `reference`), plus the kind, slug and title. Every `wsg add` re-renders from it:

| Where | What |
|---|---|
| `AGENTS.md` | `<!-- wsg:advisor -->` — the one-line rule that questions for the owner go through the advisor first; `<!-- wsg:team -->` — three lines pointing to the team, only after `wsg team`; `<!-- wsg:layout -->` — the source lines of Layout; `<!-- wsg:verification -->` — the Verification bullets |
| `CLAUDE.md` | `<!-- wsg:imports -->` — the `@<repo>/AGENTS.md` imports (`@AGENTS.md` itself stays outside) |
| `README.md` | `<!-- wsg:sources -->` — the sources table and the launch commands |
| `.claude/skills/<skill>/SKILL.md` | in a process workspace with a team: `<!-- wsg:team -->` — one pointer line to `team/workflow.md`, written by `wsg team` after the first `# ` heading |
| `.claude/settings.json` | `permissions.additionalDirectories` only; every other key stays |
| whole files | `.claude/rules/<name>.md` (written when its source is attached), `mr-target-branch.txt`, the `repo` pointer |

Text that people and agents write — why, definition of done, out of scope, invariants, links, the
ticket — lives only in `AGENTS.md`, outside the markers, and never in `wsg.json`: a copy there would
drift from what the agent reads. Text outside the markers is never modified. A marker pair deleted
by hand is put back with a warning (a block new in this wsg version is added with a note that it is new); half a pair, or a `settings.json` that doesn't parse, makes
`wsg add` refuse before it changes anything.

Workspaces created by wsg 0.1 have no `wsg.json`: `wsg check` reports on them as before, and
`wsg add` refuses them.

## Reserved names

A source can't take a name the workspace uses itself — the template would be written through its
symlink, over a file outside the workspace: `CLAUDE.md`, `AGENTS.md`, `README.md`, `notes.md`,
`SETUP.md`, `journal.md`, `runs`, `mr-target-branch.txt`, `requirements.md`, `design.md`, `plan.md`,
`review.md`, `team`, `.claude`, `.claude-memory`, `.learnings`, `.git` (compared case-insensitively).
`repo` is allowed: the pointer is not created then. Workspace slugs and skill names are kebab-case;
the `wsg-` prefix is reserved for the skills wsg writes itself.

## Team

`wsg team` writes, and afterwards only adds to:

| Path | What | Owner |
|---|---|---|
| `team/<role>.md` | the role's card: when it works, inputs, what it does, output, limits | yours once written |
| `team/workflow.md` | the stages and who writes which file; `<!-- wsg:roles -->` lists the installed roles | yours, except the block |
| `.claude/agents/wsg-<role>.md` | the Claude Code adapter that reads the card | yours once written |
| `.claude/skills/wsg-feature/SKILL.md` | `/wsg-feature`, task workspaces only; a process skill gets a `<!-- wsg:team -->` pointer line | yours once written |
| `requirements.md`, `design.md`, `plan.md`, `review.md` | written by the lead during the workflow | the task's |

The `wsg-` prefix of the adapters is frozen: `wsg-<role>` is the key of the role's memory, so a
role is never renamed — a new one is added instead. Agents and skills without the prefix are yours,
and `wsg check` does not judge them. `.claude/wsg.json` records the team as `team: { preset, roles }`, with `pointer: true` once a
process skill has its pointer line.

## What goes where

| Knowledge | Location | When loaded |
|---|---|---|
| Task rules shared by all tools | workspace `AGENTS.md` | every session |
| Claude Code specifics (models, subagents, memory) | workspace `CLAUDE.md` | every session |
| Rules of a specific repository | its own `AGENTS.md`, via import | every session |
| Specifics of working with the repo in this task | `.claude/rules/<repo>.md` with `paths:` | when reading the repo's files |
| State, code map, open questions | `notes.md` | on demand |
| Multi-step procedures | `.claude/skills/<name>/SKILL.md` | on demand |
| Lessons and failures | `.learnings/` | on demand |

## Limits

| File | Target | Ceiling | Source |
|---|---|---|---|
| `CLAUDE.md` | ≤ 100 lines | 200 lines | Anthropic: "target under 200 lines per CLAUDE.md file" |
| `AGENTS.md` | ≤ 16 KiB | 32 KiB for the whole chain | Codex `project_doc_max_bytes`, default 32768 |
| `.claude/rules/*.md` | ≤ 80 lines | — | loaded by `paths`, but eats context when matched |
| `.claude-memory/MEMORY.md` | — | 200 lines or 25 KB | only loaded up to this limit, the rest is dropped |
| `@`-import chain | — | 4 hops | Claude Code |

Keep the workspace's total always-on budget (parent CLAUDE.md files + its own files + imports)
within ~20 KiB. Checked by `wsg check`.

## Hard rules

1. **Imports only inside the workspace.** An `@`-path that resolves outside triggers a one-time
   approval dialog; declining disables external imports for the whole project. Don't import through
   a symlink to someone else's repo — use a plain-text reference and `additionalDirectories` instead.
2. **Don't copy repository rules.** Import `@<repo>/AGENTS.md` if the repo is inside the cwd;
   otherwise add the line "repo rules: `<path>`, read before the first edit".
3. **`paths:` in the rules' frontmatter.** Without it the rule is always loaded. Globs are resolved
   against the cwd, so for a repository attached via `additionalDirectories` the match only fires
   when accessed through the symlink inside the workspace — verify this in the first session.
4. **`.learnings/` only at the workspace root**, not at the root of a git checkout: the task log must
   not end up in the repository history or get in the way of other branches.
5. **Verifiability.** `AGENTS.md` must have a section with a command the agent can run
   itself and get pass/fail: tests, type check, build. Without it, "looks done" is the only
   signal, and a human ends up acting as the validator.
6. **Invariants are written down explicitly.** Deliberate decisions that look like violations of the
   repo's rules (code in the legacy layer, a disabled check, an odd placement) go into the
   "Invariants are not findings" section. Otherwise the agent and the reviewer subagent will "fix" them.
7. **Launch only from the workspace root.** From a nested repo, neither the settings, nor the rules,
   nor the task memory will load.

## Untracked files in a worktree

`git worktree` carries over only tracked files. Everything in `.gitignore` — `.env`, dev-server
certificates, local configs — is missing from a new worktree. The build and unit tests will survive
that, but the dev server and e2e won't: they read variables from `.env`.

When creating a worktree, `wsg add` copies such files from the main checkout (`--carry`; the
candidates are listed by `--dry-run`). Selection rule: a file, not a directory, no deeper than three levels, outside `node_modules`,
no larger than 1 MB. What was copied is recorded in `.claude/rules/<repo>.md`, because git doesn't
sync these files: if you change one in the main checkout, update it in the worktree too.

The `.claude/` directory is intentionally not copied into the worktree: sessions are launched from the
workspace root, not from the repo, and a separate `.claude/` there only gets in the way.

## Codex

The chain is assembled once per launch: `~/.codex/AGENTS.md` → git repository root → down to the cwd,
closer to the cwd = higher priority. The workspace isn't a git repository, so Codex reads **only**
the workspace's `AGENTS.md` — neither your personal rules nor the repositories' rules will be in the
chain. Everything Codex must know has to be in this file or in explicit pointers like "open X before
working with Y".

## Memory

Claude Code's auto-memory is tied to the git repository, not the directory: all worktrees of one repo
share one memory. To give a task its own, `autoMemoryDirectory` is set in `.claude/settings.json`.
The trade-off: if a global path is already set in user settings, the override removes the global
`MEMORY.md` from the startup context — so key personal rules need to be duplicated in condensed form
in the workspace's `AGENTS.md`, with a pointer to the original.
