# wsg setup guide

You are setting up a wsg workspace together with its owner. `wsg new` has created the skeleton:
headings marked `FILL IN`, no repositories yet. Your job is to turn it into a workspace an agent
can work in: what the task is and why, how to tell it is done, which repositories it touches and
how to verify the work. You do the talking and the writing; `wsg` does everything risky — git
worktrees, branch backups, copying files outside git, settings — and checks the result.

## Ground rules

- Talk to the owner in their language. Write workspace files in English: translate their answers
  faithfully, keep the meaning, and show the translated text for approval before writing it.
- Ask only what is missing: read `AGENTS.md`, `notes.md` and `.claude/wsg.json` first. Keep each
  answer to 1–3 lines — `AGENTS.md` is read in every session, and every line costs context.
- Look before you ask: whatever the repositories can tell you, find out yourself and propose it.
- During setup never edit anything inside a repository, never commit, never push.
- Run `wsg` from the workspace root. If `wsg` is not on PATH, use `npx @korbutds/wsg`.
- Before you show the owner any list of questions or decisions, run it through the `wsg-advisor`
  subagent — or, if your tool has none or it does not start, through `wsg guide advisor` followed
  inline. Show the owner the advisor's FOR THE OWNER block as is, and nothing else from its reply.
  Never say the advisor ran when it did not.

## 1. The task

Start with context: if the owner gave a ticket or a spec, send them to the advisor first (stage
setup) — it reads the ticket, its comments and links, and the sibling workspaces that met the same
ticket. Propose what that context answers; check your draft with the advisor before you show it.

Go through these in order. Each answer goes into its section of `AGENTS.md`, replacing `FILL IN`.

1. **What and why** (required) — the problem, for whom, and why now. Without it the agent can't
   decide what is in scope. Example: "Users are logged out every hour: the refresh token is not
   renewed. ~20 support tickets a day." → section `## Why`.
2. **Ticket** — a key or a URL. `wsg new --ticket` writes it at creation; given later, write the
   `Ticket:` line under the title of `AGENTS.md` yourself: a URL as given; for a bare key, the
   tracker prefix `WSG_TRACKER_URL` from `~/.config/wsg/config` (if it is set there) followed by
   the key, else the key alone.
3. **Definition of done** — something checkable: "a session survives 24 h, renewal is covered by
   tests, the MR is open" → `## Definition of done`.
4. **Out of scope** — nearby things not to touch. None — remove the section.
5. **Starting state** — one of: new feature; updating existing work (an open MR, a branch);
   understanding legacy code before changing it. Replace the `Starting state: FILL IN …` line.
6. **Sources** — the repositories, see section 2.
7. **Invariants** — deliberate decisions that look like violations of the repository rules: "code
   stays in the legacy layer on purpose", "retries are not added — the caller decides". Without
   them the agent and a reviewer will "fix" them. None — replace the text with "None recorded yet."
8. **Links** — spec, designs, related MRs: one `Name: URL` line each, under the title.
9. **Owner rules** — only if `AGENTS.md` has an "Owner rules" section: read the file it names, and
   condense the rules that matter for this task into a short numbered list there. Keep the six
   required lines.

If the title is just the slug or not in English, propose a better one and update the `# ` heading
of every file that repeats it.

**A process workspace** (`.claude/ws-kind` says `process`) is a repeatable engineering procedure:
a release, a dependency upgrade, a routine migration. Ask instead: what the procedure does and gives
(`## Why`), when it runs, the input of each run, the rules and boundaries of every run, and how to
tell a single run is finished. Its steps are not asked now — they are worked out with the owner on
the first run and written into its skill. Its repositories are attached as links.

## 2. Sources

At least one git repository is required; setup is not finished without one. For each repository
the owner names:

1. **Inspect it first:**
   - `git -C <repo> for-each-ref --sort=-committerdate --format='%(refname:short)' refs/heads | head -20`
     — the branch naming convention (e.g. `<user>/task/<area>/<TICKET>`, `feature/<TICKET>-<slug>`);
   - `git -C <repo> symbolic-ref --short refs/remotes/origin/HEAD` — the default branch, the usual
     MR target;
   - `package.json` scripts, `Makefile`, the CI config (`.github/workflows/`, `.gitlab-ci.yml`) —
     the verification command: what CI runs for tests, types, lint;
   - `wsg add <repo> --branch <name> --dry-run` — the plan as JSON, touching nothing. Give it the
     flags you mean to use: for a worktree that includes `--branch`. Without it the plan still
     lists the files outside git it can copy (`carryCandidates`) and `nodeModules`, but reports the
     missing branch as an error (exit 2). With it you also get the mode, `start` (how the branch
     starts), `base`, `target` and every file it would write.
2. **Propose**, in one short message:
   - **mode** — `--worktree` (its own branch inside the workspace; the default for a repository
     root) or `--link` (a symlink to the shared checkout: for a repository the task only reads, or
     a heavy one that doesn't need its own branch; a subdirectory of a repository is always a link);
   - **branch** — named by the repository's existing convention, with the ticket if there is one.
     Never invent a different scheme. For "updating existing work" or an open MR, give the
     existing branch: a local one is attached as it is, with its commits; one only on origin is
     continued from `origin/<branch>` and tracks it. `--dry-run` shows which (`start`) and warns
     when the local branch and origin differ — nothing is merged. Add `--reset-to-base` only after
     the owner explicitly says to start the branch over: its current head is saved in `backup/…`
     and the branch is reset to the base, so its commits leave the branch;
   - **base** — for a new branch, `origin/<target>` unless the owner wants another (`--base`);
   - **target** — the MR target branch, `origin/HEAD` by default (`--target`);
   - **verify** — the command that gives pass/fail (`--verify`): one line, no backticks;
   - **carry** — which ignored files to copy (`.env`, certificates): `--carry all`, `none` or a
     comma-separated list (`all` by default);
   - **node_modules** — clone it from the main checkout (APFS copy-on-write, macOS; the default
     when it has one) or install later: `--clone-node-modules` / `--no-clone-node-modules`.

   Before you show it, send the planned `wsg add` commands to the advisor for a plan review — and,
   when a source is being fixed, its `wsg remove <name> --dry-run` too. Fix what it flags; what it
   leaves to the owner goes into the proposal.
3. **Wait for "ok"**, then run it, e.g.:

   ```bash
   wsg add ~/projects/api --branch alice/task/auth/PROJ-412 --verify "npm test" --carry .env
   wsg add ~/projects/web --link --verify "npm run typecheck"
   ```

   Exit code 2 means the input was rejected and nothing was changed: read the message, fix the
   flag, try again. Exit code 1 means a step failed and was rolled back. From outside the workspace,
   name it with `--ws <slug|path>`.

   A source attached with the wrong settings is fixed by `wsg remove <name>`, then `wsg add` with
   the right flags. `remove` takes only a clean worktree — it lists what would be lost otherwise —
   and keeps the branch; `wsg remove <name> --dry-run` shows what it would do. Ignored files that
   exist nowhere else (a `.env` made later or a carried one edited since, an installed
   `node_modules`) are listed too: move out what is needed, then `wsg remove <name> --delete-ignored`.
   A `node_modules` wsg cloned is not checked: changes made inside it are deleted with the worktree.
   Not seen either: a tracked file marked `skip-worktree` or `assume-unchanged` and edited in the
   worktree — it is deleted with it. If a removal fails after the worktree is gone, the rollback
   adds the worktree back on the same branch, without the carried files and the agreed ignored
   files.

**Reference directories** — material the task works from that is not under git (specs, exports,
designs): `wsg add <dir> --reference --note "<one line: what is in it>"`; the note is one line. They sit next to the
repositories, never instead of them. Edits there have no history, so change files there only when
the owner asks.

## 3. Team (optional)

Offer it only once at least one git source is attached, and only as an option: most tasks need no
team. `wsg team fullstack` adds six roles — `pm`, `designer`, `frontend`, `backend`, `devops`,
`reviewer` — as cards in `team/`, a workflow in `team/workflow.md`, a Claude Code subagent per role
and, in a task workspace, `/wsg-feature` to run the workflow. The cost is context in every session: with
all six roles, 1274 B (about 300 tokens) as `wsg check` counts it — the adapters' descriptions and
the team block of `AGENTS.md` — plus the one-line description of `/wsg-feature`.

1. **Propose** the roles that make sense for this task, leaving the rest out with `--without`:
   `--without devops,designer` for a backend-only change; `designer` only when the task has an
   agreed design; `devops` only when the work touches infrastructure.
2. **Dry run:** run `wsg team fullstack --without <roles> --dry-run` yourself: it prints what it
   would create, keep and update as JSON, touching nothing. Before you show the proposal, send it
   to the advisor for a plan review together with that JSON — the advisor reviews it, it cannot
   run `wsg team` itself. Fix what it flags; what it leaves to the owner goes into the proposal.
3. **Wait for "ok"**, then run it without `--dry-run`. It only adds: an existing file is kept as it
   is. If it prints a restart hint, `.claude/agents/` or `.claude/skills/` is new and the roles are
   seen only in a new session.

Roles left out are not remembered: a later `wsg team fullstack` without `--without` adds them.
`/wsg-setup` can run this step again at any time.

## 4. Editing AGENTS.md and the other files

- Replace every `FILL IN` in the sections you covered. Don't leave empty headings: remove a
  section the owner said doesn't apply (except Why, Definition of done and Verification).
- Text between `<!-- wsg:… -->` and `<!-- /wsg:… -->` is generated from `.claude/wsg.json` and is
  rewritten by every `wsg add`. Never edit inside the markers, and never edit `.claude/wsg.json`,
  `repo` or `mr-target-branch.txt` by hand: a source is changed by attaching it with the right flags.
- `.claude/rules/<name>.md` is written once, when its source is attached. Its "FILL IN as you go"
  is for later sessions: leave it.
- Everything outside the markers is yours: wsg never touches it again.
- `.claude/settings.json` may get your own keys; `wsg add` keeps them and only manages
  `permissions.additionalDirectories`.

## 5. Finishing

1. Run `wsg check`. Fix every FAIL; a WARN you can't fix, explain to the owner.
   "setup not finished" disappears once a git repository is attached and `## Why` is filled in.
2. Update `notes.md` → "Current context": remove "Setup not finished", write one line on where the
   work stands and what the first session should do (usually: reconnaissance, no edits).
3. Show the owner a short summary: the task in one line, the sources with their branches, the
   verification command, the team if one was added (its roles, and that `/wsg-feature` runs it),
   anything left open — including the OWNER items the advisor left unresolved.
4. Tell them whether to restart the session. It is needed when `wsg add` printed
   "settings.json changed: restart…" — linked directories become readable only in a new session —
   or `wsg team` printed its restart hint.
   Worktrees are inside the workspace and need no restart. To restart: `ws <slug>` (if the `ws`
   function is set up) or `cd <workspace> && claude`.
5. Say how to start the work: in this workspace, from its root, beginning with the reconnaissance
   step from `notes.md`.

## Running setup again

`/wsg-setup` (or this guide) can be run again at any time. Then don't start over: read the files,
fill only what is still `FILL IN`, attach the sources the owner adds, and finish with section 5.

A workspace made by an earlier wsg may lack a generated part this version writes (`wsg check`
says so): `wsg refresh --dry-run` lists the files it would change, `wsg refresh` updates only the
generated parts and leaves everything else as it is.
