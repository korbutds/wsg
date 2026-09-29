# Working with task workspaces

The workflow after switching to workspaces: one task, one directory, with repositories inside
as git worktrees. Limits on the workspace files themselves are in
[conventions.md](conventions.md).

## Model

**A task is a directory, not a repository.** Claude Code ties session history to the working
directory and auto-memory to the git repository. While work was done from the repo root, a task
spanning two repos got split in half and mixed with everything else ever done in those repos.
A workspace makes the task the working directory, so history, memory, rules and notes belong to it.

```
$WS_ROOT/<slug>/
├── CLAUDE.md          Claude entry point: imports + Claude specifics
├── AGENTS.md          task rules; the only source for Codex
├── README.md          task card: problem, sources, links, how to launch
├── notes.md           current context, code map, open questions
├── mr-target-branch.txt
├── repo -> <main repository: the first worktree, else the first git source>
├── <repo>/            git worktree on the task branch
├── .claude/{settings.json, rules/<repo>.md}
├── .claude-memory/    auto-memory for this task only
└── .learnings/        lessons and failures of this task
```

The main checkouts stop being working copies: keep them on the target branch and
branch worktrees off them. All work happens in workspaces.

## Starting a task

```bash
wsg
```

The interview asks about the work first, then about each source. Give substantive answers to two
questions; the rest is mechanics:

- **Why** — what problem we're solving. An empty answer is rejected: this field defines what's in scope.
- **Invariants** — deliberate decisions that look like violations of the repo's rules. Without them
  the agent and the reviewer subagent will "fix" them. Can be filled in later.

For each repository: `worktree` or `link`, target branch, task branch, base, verification
command. The script offers to copy untracked files (`.env`, certificates) and to clone
`node_modules` via APFS copy-on-write.

`link` mode is for heavy repos that don't need their own branch: attached via a symlink to the
shared checkout and added to `additionalDirectories`.

Unfilled places are marked `FILL IN`; the script lists them at the end.

## Day to day

```bash
ws                 list workspaces: sessions, branches, state
ws dpop-auth       go there and open a session (resumes the previous one)
ws dpop            an unambiguous prefix is enough
ws dpop --cd       just go there
ws dpop --new      start a new session
ws dpop --codex    launch codex with the right --add-dir
```

The list shows what's easy to miss:

```
  dpop-auth          task    · sessions: 1
      api: alice/task/oauth-refresh/PROJ-412
      web: main * (shared checkout)
      web-wt: detached HEAD @ 3f9c1ab
```

`*` means uncommitted changes. Shown in red: `detached HEAD` and `REBASE IN PROGRESS`.
`(shared checkout)` means the branch doesn't belong to this task; switching it is risky for neighbors.

**Launch sessions only from the workspace root.** From a nested repo, the worktree becomes the project:
the task's settings, rules and memory won't load, and history goes to the repository's store.

## Task work cycle

1. **Reconnaissance** — no edits. Ticket, spec, code map. Result goes into `notes.md`.
2. **Plan** — by a separate planning subagent, in `<ticket>-plan.md`.
   One or two architect passes over the plan.
3. **Implementation** — with a strong model, edit → commit on top, with an "ok" for each step.
4. **Self-review**, then **independent review** by a subagent in a fresh context, not a fork.
5. **Presentation** — once no findings remain, the history is rebuilt once.

The plan is written twice: before implementation and before review. Between unrelated tasks, `/clear`.
Research that reads many files goes through subagents so it doesn't clog the main context.

## Git

Branches and commits follow the repository's conventions; agree on new names in advance.

Each repository may have its own: branch naming, commit message format, target branch, where the
MR/PR template lives. Write them into that repository's rule, `.claude/rules/<repo>.md` — it is
loaded when the agent works with the repo's files, so two repositories with different conventions
don't clash in one file for the whole workspace.

Common ground: the commit body says why, not what. No `Co-Authored-By` or "Generated with" trailers.
Push and MR creation are manual; the agent stops at local commits and the description text.

The same repository can be kept in several worktrees on different branches — that's the whole point.
You just can't check out the same branch in two worktrees at once.

## Verification

Every task's `AGENTS.md` must have a "Verification" section with a command that yields pass/fail.
Without it, "looks done" is the only signal, and you end up being the validator.

Capture the baseline check on a clean branch **before** the first edit and record it in `notes.md`:
otherwise you can't tell what the rebase broke from what was already red.

```bash
# pnpm monorepo
pnpm -C <repo> --filter <package> typecheck
pnpm -C <repo> test -- --testPathPattern "<Area>"

# repository with its own build wrapper: only through its commands, not raw tsc/eslint/jest,
# and the full log to a file, otherwise the pipe masks the exit code
<build-tool> typecheck <project> > .cache/logs/typecheck.log 2>&1
```

If a repository has its own build wrapper, raw `tsc`/`eslint`/`jest` bypass its environment settings
and caches — use its commands. Output to a file: a pipe masks the exit code and truncates errors.

## When something fails

| Symptom | Cause | Fix |
|---|---|---|
| Push hook complains about the branch name even though it's correct | detached HEAD: the hook reads `git rev-parse --abbrev-ref HEAD` and gets `HEAD` | `git checkout <branch>`; the branch and HEAD are usually on the same commit, nothing is lost |
| A git hook fails on commit or push in a worktree | the hook runs the package manager, and the worktree has no `node_modules` | install in the worktree, or clone `node_modules` from the main checkout (`cp -Rc` on APFS) |
| Dev server or e2e won't start in a worktree | `.env` and certificates are in `.gitignore`, git doesn't carry them over | `cp -p <main checkout>/{.env,*.pem} .` |
| `node_modules` seems to eat the disk | on APFS `du` overstates: it doesn't see copy-on-write | measure by the `df -k` difference; 2 GB per `du` actually cost 74 MB |
| Rule `.claude/rules/<repo>.md` doesn't fire | globs are resolved against the cwd; the repo is attached via a symlink pointing outside | access it through `./<repo>/…` or drop `paths:` from the frontmatter |

General rule: a worktree inherits the repository's hooks and config, but not the working environment.
When debugging a failure, first check which ignored files are missing there.

## Maintenance

```bash
wsg --check $WS_ROOT/<slug>   # file limits, imports, symlinks, budget
```

Run it periodically, not just after creation: files grow, and the check will catch when
`CLAUDE.md` exceeds 200 lines or `AGENTS.md` approaches 32 KiB — the Codex chain ceiling.

Delete a workspace only through git, otherwise admin entries are left behind:

```bash
git -C <main checkout> worktree remove $WS_ROOT/<slug>/<repo>
git -C <main checkout> worktree prune     # if you did delete it by hand
rm -rf $WS_ROOT/<slug>
```

**Stash is shared across all worktrees.** A bare `git stash` in one and `pop` in another pulls out someone else's work.
Prefer a temporary WIP commit; if you do stash, use `git stash push -m "<tag>"` and `apply` a specific entry.

Watch free disk space: on APFS, once usage nears 97%, copy-on-write stops helping and
each new worktree gets more expensive. Clean up package manager caches (`pnpm store prune`,
`yarn cache clean`) and build output in old worktrees.

## Where things live

| | |
|---|---|
| generator and validator | `wsg` |
| navigation and list | `shell/wsg.zsh`, `ws` function |
| file limits | `docs/conventions.md` |
| lessons across tasks | your personal log outside the workspaces |
| lessons of a single task | `<workspace>/.learnings/` |
