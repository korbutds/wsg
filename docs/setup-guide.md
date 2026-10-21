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

## 1. The task

Go through these in order. Each answer goes into its section of `AGENTS.md`, replacing `FILL IN`.

1. **What and why** (required) — the problem, for whom, and why now. Without it the agent can't
   decide what is in scope. Example: "Users are logged out every hour: the refresh token is not
   renewed. ~20 support tickets a day." → section `## Why`.
2. **Ticket** — a key or a URL. A bare key with a known tracker prefix becomes a link
   (`WSG_TRACKER_URL` in the wsg config). Goes on the `Ticket:` line under the title.
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
   - `wsg add <repo> --dry-run` — the mode wsg picks, the files outside git it can copy
     (`carryCandidates`), whether `node_modules` can be cloned, and every file it would write.
2. **Propose**, in one short message:
   - **mode** — `worktree` (its own branch inside the workspace; the default for a repository root)
     or `--link` (a symlink to the shared checkout: for a repository the task only reads, or a heavy
     one that doesn't need its own branch; a subdirectory of a repository is always a link);
   - **branch** — named by the repository's existing convention, with the ticket if there is one.
     Never invent a different scheme. An existing branch (an open MR) needs `--reuse-branch`: wsg
     saves its head in `backup/…` and resets it to the base — say so;
   - **base** — `origin/<target>` unless the owner wants another;
   - **target** — the MR target branch;
   - **verify** — the command that gives pass/fail;
   - **carry** — which ignored files to copy (`.env`, certificates): `all`, `none` or a list;
   - **node_modules** — clone (APFS copy-on-write, macOS) or install later.
3. **Wait for "ok"**, then run it, e.g.:

   ```bash
   wsg add ~/projects/api --branch alice/task/auth/PROJ-412 --verify "npm test" --carry .env
   wsg add ~/projects/web --link --verify "npm run typecheck"
   ```

   Exit code 2 means the input was rejected and nothing was changed: read the message, fix the
   flag, try again. Exit code 1 means a step failed and was rolled back.

**Reference directories** — material the task works from that is not under git (specs, exports,
designs): `wsg add <dir> --reference --note "<one line: what is in it>"`. They sit next to the
repositories, never instead of them. Edits there have no history, so change files there only when
the owner asks.

## 3. Editing AGENTS.md and the other files

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

## 4. Finishing

1. Run `wsg check`. Fix every FAIL; a WARN you can't fix, explain to the owner.
   "setup not finished" disappears once a git repository is attached and `## Why` is filled in.
2. Update `notes.md` → "Current context": remove "Setup not finished", write one line on where the
   work stands and what the first session should do (usually: reconnaissance, no edits).
3. Show the owner a short summary: the task in one line, the sources with their branches, the
   verification command, anything left open.
4. Tell them whether to restart the session. It is needed when `wsg add` printed
   "settings.json changed: restart…" — linked directories become readable only in a new session.
   Worktrees are inside the workspace and need no restart. To restart: `ws <slug>` (if the `ws`
   function is set up) or `cd <workspace> && claude`.
5. Say how to start the work: in this workspace, from its root, beginning with the reconnaissance
   step from `notes.md`.

## Running setup again

`/wsg-setup` (or this guide) can be run again at any time. Then don't start over: read the files,
fill only what is still `FILL IN`, attach the sources the owner adds, and finish with section 4.
