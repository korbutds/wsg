# Team workflow

The main session is the tech lead and the only one who talks to the owner. The roles below do
the work the lead hands them and report back to the lead; none of them asks the owner anything.

## Roles in this workspace

Each role reads its card in `team/<role>.md`; in Claude Code it is the `wsg-<role>` subagent.

<!-- wsg:roles -->
<!-- /wsg:roles -->

## Stages

| Stage | Who | What happens | The owner |
|---|---|---|---|
| 0. Scale check | lead | A small change, with nothing to agree on: the lead does it alone, then it goes to review (stage 5). | is told the stages are skipped |
| 1. Requirements | pm, designer | `pm` returns `requirements.md`; when the task has an agreed design, `designer` returns `design.md`. | confirms both |
| 2. Plan | lead, backend | `plan.md`: the steps, the API contract agreed with `backend`, and a file ownership table. Parallel work only for rows that do not overlap. | says "ok" |
| 3. Implementation | frontend, backend, devops | Each works in its own rows of the ownership table, in one shared working copy: no per-agent worktrees. `devops` only when `plan.md` lists infrastructure work. | — |
| 4. Integration | lead | The lead puts the parts together and runs the verification from `AGENTS.md`. | — |
| 5. Review | reviewer, designer | `reviewer` returns its findings; `designer` returns a `## Design` section on mismatches with `design.md`. Neither fixes anything. | — |
| 6. Final checks | lead | Findings fixed by their owners or agreed with the owner, verification green, `notes.md` updated, the result shown to the owner. | sees the result |

## Who writes which file

| File | Written by | Content from |
|---|---|---|
| `requirements.md` | lead | `pm` |
| `design.md` | lead | `designer` |
| `plan.md` | lead | lead; the API contract with `backend` |
| `review.md` | lead | `reviewer`, then the `## Design` section of `designer` |
| code and configuration | `frontend`, `backend`, `devops` | their rows of the ownership table in `plan.md` |

## Handback rule

`pm`, `designer` and `reviewer` have no file tools. Each returns its document as its final
message, and the lead saves it verbatim to the file in the table: no edits, no summary. For
`review.md` the lead writes the reviewer's findings first and appends the designer's `## Design`
section after them: one writer per file.

## If a role is not installed

Skip what that role does in its stages and tell the owner, in the report of that stage, what was
skipped. The lead does not play a missing role silently.

## Limits

- One shared working copy: two roles editing the same file overwrite each other. The ownership
  table is the only protection, so parallel work needs rows that do not overlap.
- A team is prompts, not isolation: the cards and this workflow are instructions a model
  follows, not permissions a tool enforces.
- `pm`, `designer` and `reviewer` keep Bash: "read-only" is a rule in their cards and the absence
  of file tools, not a sandbox.
