# wsg teach guide

Followed by the main session when the owner runs `/wsg-teach <role> <url|text>` (or asks to teach a
role a practice). It writes one practice into a role's memory, so the role applies it in every
workspace from then on. The main session writes it; the role never writes its own memory.

## What a practice is, and where it is kept

A practice is a short, general way of working for one role: how `reviewer` reads a migration,
how `pm` words an acceptance criterion. Claude Code injects the role's `MEMORY.md` index into the
role's prompt; each index line points to a practice file the role reads when the line applies.

Where the memory lives depends on the role adapter, `.claude/agents/wsg-<role>.md`, line `memory:`:

| `memory:` | Directory |
|---|---|
| `user` (what `wsg team` writes) | `~/.claude/agent-memory/wsg-<role>/`; with `$CLAUDE_CONFIG_DIR` set, `$CLAUDE_CONFIG_DIR/agent-memory/wsg-<role>/` (as documented) |
| `project` (as documented) | `.claude/agent-memory/wsg-<role>/` in the workspace |
| `local` (as documented) | `.claude/agent-memory-local/wsg-<role>/` in the workspace |

Only `user` in `~/.claude` was checked against Claude Code; the other rows follow its documentation.

No `memory:` line, or `memory: none`: the role has no memory. Say so and stop. Role memory needs
Claude Code's auto memory turned on.

## Is it a practice at all

Only general practices go to role memory: they hold in any repository and any task.

- A rule of one repository (its commit style, its test layout) goes to `.claude/rules/<repo>.md`
  or that repository's `AGENTS.md`.
- A fact of this task (a decision, an endpoint name, a deadline) goes to `notes.md`.

When the input is not a general practice, say where it belongs, and stop: write nothing here.

## Arguments

`<role> <url|text>`. The role is one of `pm`, `designer`, `frontend`, `backend`, `devops`,
`reviewer`. Any other role, or none: list these six and stop. The rest is a URL to read, or the
practice in the owner's words.

## Steps

1. Read the source: fetch the URL, or take the text as given. A source you cannot read: say so
   and stop.
2. Draft the practice in your own words, 5–10 lines. Never paste an article, or more than a phrase
   of it.

   ```markdown
   # <Practice name>

   When it applies: <the situation, concretely>.
   When it does not: <the nearest situation where it would be wrong>.

   <What to do, 2–5 lines.>

   Example: <one short example>.

   Source: <URL, or "the owner">, <YYYY-MM-DD>.
   ```

3. Pick a slug: kebab-case, lowercase Latin letters, digits and hyphens, e.g. `api-acceptance-criteria`.
4. Read the role's `MEMORY.md` and `practices/`. Look for a practice that says the same, or the
   opposite. A duplicate: propose updating that file instead. A contradiction: show both to the
   owner and ask which one stays.
5. Show the owner the draft, the file it goes to, and the index line. Wait for "ok".
6. After "ok", write `practices/<slug>.md`, then append one line to `MEMORY.md`:

   ```markdown
   - Writing acceptance criteria for an API change → practices/api-acceptance-criteria.md
   ```

   The part before `→` says when it applies, in a few words: it is what the role reads to decide
   whether to open the file. The link is always `practices/<slug>.md`, so `wsg check` can match it.
7. Run `wsg check`: it warns about an index line whose file is missing and an index over the
   limit.

When the directory or `MEMORY.md` does not exist yet, create them after the owner's "ok" in step
5, and start `MEMORY.md` with this, `<role>` replaced:

```markdown
# wsg-<role> practices

One line per practice, written by /wsg-teach: `- <when it applies> → practices/<slug>.md`.
```

## The index limit

Claude Code injects only the first 200 lines or 25 KB of `MEMORY.md` into the role's prompt. At 180 index lines, do not
append: propose to the owner merging practices that overlap, and show the merged index first.

## Never

- Change a role card (`team/<role>.md`): practices go to memory, the card stays as `wsg team`
  wrote it or the owner edited it.
- Delete or rewrite a practice without the owner's "ok".
- Store a secret, a credential, a customer's data, or anything internal to one company: role
  memory is shared by every workspace on this machine.
