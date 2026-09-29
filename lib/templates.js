'use strict';

// Workspace file templates. Carried over verbatim from the former bash core: the
// text holds accumulated knowledge, so "rewrite it from memory" is not an option.
// It was checked byte-for-byte against that core once, during the move, and later
// translated from Russian to English.

const path = require('node:path');

const today = () => new Date().toISOString().slice(0, 10);
const bullets = (lines) => lines.filter(Boolean).map((l) => `- ${l}`).join('\n');
// Text the user typed in the interview. Workspace files are kept in English (agents work best
// with it, and it costs fewer tokens); wsg can't translate, but it can tell that translation is
// needed and hand it to the agent as the first-session task. Cyrillic is the only case for now.
const FOREIGN = /[\u0400-\u04FF]/;
function hasForeignText(a) {
  const texts = [a.title, ...(a.problem || []), ...(a.dod || []), ...(a.invariants || []), ...(a.links || []),
    ...(a.varies || []), ...(a.fixed || []), ...(a.steps || []), ...(a.repos || []).map((r) => r.note || '')];
  return texts.some((x) => FOREIGN.test(x || ''));
}

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
// Path in a printed command: with an unquoted space it cannot be copied and run.
const sh = (s) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// Link format is "Name | URL", but people paste a bare URL too. Then the host
// becomes the label: repeating the whole address as the label is pointless.
function splitLink(line) {
  const i = line.indexOf('|');
  if (i >= 0) return { name: line.slice(0, i).trim(), url: line.slice(i + 1).trim() };
  const url = line.trim();
  try {
    return { name: new URL(url).host, url };
  } catch {
    return { name: url, url };
  }
}

function claudeMd(a, ctx) {
  const imports = ['@AGENTS.md'];
  for (const r of a.repos) {
    if (r.mode === 'worktree' && ctx.hasAgentsMd(r)) imports.push(`@${r.name}/AGENTS.md`);
  }
  return `# ${a.title}

${imports.join('\n')}

## Claude Code only

- Task memory lives in \`.claude-memory/\`. Your global rules file is not loaded here:
  the essentials are condensed into AGENTS.md. In doubt about a rule — open the original.
- Repositories attached via additionalDirectories do not serve their own CLAUDE.md/AGENTS.md
  automatically. Access files through the symlink inside the workspace — that is what triggers the rules.
- Planning — a separate subagent on a fast model; implementation and review — on a strong one.
  The reviewer runs in a fresh context, not as a fork: otherwise it defends its own decisions.
- Start sessions only from the root of this directory.
- Before "done" — update the "Current context" block in \`notes.md\` (after "ok").
`;
}

function agentsMd(a, ctx) {
  const out = [`# ${a.title}`, ''];
  if (a.ticketUrl) out.push(`Ticket: ${a.ticketUrl}`);
  for (const l of a.links) {
    const { name, url } = splitLink(l);
    out.push(`${name}: ${url}`);
  }
  out.push('', `This is a task workspace, not a git repository. Repositories inside: ${a.repos.length}.`, '');
  if (hasForeignText(a)) {
    out.push('Knowledge files of this workspace (AGENTS.md, README.md, notes.md, rules, journal) are kept in English;',
      'text entered in another language is translated in the first session — see "Continue with" in `notes.md`.', '');
  }
  out.push('## Why', '', a.problem.join('\n'), '');
  out.push(`Starting state: ${a.stateLabel}.`, '');

  if (a.dod.length) {
    out.push(a.kind === 'process' ? '## Definition of done for a single run' : '## Definition of done');
    out.push('', a.dod.join('\n'), '');
  }

  if (a.kind === 'process') {
    out.push('## How it runs', '');
    out.push(`The procedure lives in \`.claude/skills/${a.skillName}/SKILL.md\` and is invoked manually:`);
    out.push(`\`/${a.skillName} <ticket or description>\`. It never fires on its own — it has side effects.`, '');
    out.push('Before a run, read `journal.md`: it records what broke in previous runs.');
    out.push('After a run, create `runs/<ticket>.md` and append a paragraph to the journal.', '');
    out.push('A process has no permanent branch. Repositories are attached as symlinks to shared checkouts:');
    out.push('the skill creates the branch and, if needed, a worktree for each run.', '');
  }

  out.push('## Layout', '');
  for (const r of a.repos) {
    if (r.mode === 'worktree') {
      out.push(`- \`${r.name}/\` — git worktree, branch \`${r.branch}\`, target \`${r.target}\`.`);
      if (ctx.hasAgentsMd(r)) out.push(`  Repository rules — \`${r.name}/AGENTS.md\`, read before the first edit.`);
      else if (ctx.hasClaudeMd(r)) out.push(`  Repository rules — \`${r.name}/CLAUDE.md\`, read before the first edit.`);
    } else if (ctx.isRepo(r)) {
      out.push(`- \`${r.name}\` — symlink to the shared checkout \`${r.path}\`, target \`${r.target}\`.`);
    } else {
      const note = r.note ? ` ${capitalize(r.note.trim().replace(/\.$/, ''))}.` : '';
      out.push(`- \`${r.name}\` — symlink to \`${r.path}\`, not under git.${note}`);
    }
  }
  out.push('- `notes.md` — current context, code map, open questions.');
  out.push('- `.learnings/` — lessons from this task.');
  if (ctx.globalMemory) out.push(`- Your personal rules — \`${ctx.globalMemory}\`. Codex does not load it on its own.`);
  out.push('');

  out.push('## Verification', '');
  out.push('A command the agent runs itself and gets pass/fail. Without it, "looks done" is');
  out.push('the only signal, and a human ends up acting as the validator.', '');
  const withVerify = a.repos.filter((r) => r.verify);
  if (withVerify.length) for (const r of withVerify) out.push(`- ${r.name}: \`${r.verify}\``);
  else out.push('- FILL IN: no command was set when the workspace was created.');
  out.push('');

  out.push('## Invariants are not findings', '');
  if (a.invariants.length) {
    out.push(bullets(a.invariants), '');
    out.push('Do not offer to "fix" anything listed. If a reviewer demands it, that is a question for the task owner.', '');
  } else {
    out.push('None recorded yet. As soon as a deliberate decision turns out to look like a violation');
    out.push('of the repository rules — write it down here, or the agent and the reviewer subagent will "fix" it.', '');
  }

  if (a.personalRules) {
    out.push('## Owner rules (override tool defaults)', '');
    out.push(`FILL IN with a digest of \`${ctx.globalMemory || 'your rules file'}\`. Required minimum:`, '');
    out.push('1. Change nothing — neither files nor git state — until an explicit "ok".');
    out.push('2. Never run `git push` and never create an MR.');
    out.push('3. No `Co-Authored-By` or "Generated with" trailers in commits.');
    out.push('4. Branch names follow the repository convention; agree on new ones in advance.');
    out.push('5. Cycle: plan → architect → implementation → self-review → independent review → show.');
    out.push('6. Nothing goes outside without showing the text and getting "ok".', '');
  }

  out.push('## Code map', '');
  out.push('Integration points are in `notes.md`, section "Code map". Verify against the code, not memory:');
  out.push('line numbers are correct as of the date they were recorded.');
  return out.join('\n') + '\n';
}

function readmeMd(a, ctx) {
  const out = [`# ${a.slug} — ${a.title}`, '', a.problem.join('\n'), ''];
  out.push(`Workspace kind: **${a.kind === 'process' ? 'process' : 'task'}**.`, '');
  out.push('## Sources', '', '| Repository | Mode | Branch | Target |', '|---|---|---|---|');
  for (const r of a.repos) {
    if (ctx.isRepo(r)) out.push(`| \`${r.name}\` | ${r.mode} | \`${r.branch || '—'}\` | \`${r.target}\` |`);
    else out.push(`| \`${r.name}\` | directory | — | ${r.note || '—'} |`);
  }
  out.push('');
  const main = a.repos.find((r) => r.mode === 'worktree' && ctx.isRepo(r)) || a.repos.find((r) => ctx.isRepo(r));
  if (main) out.push(`Push and MR creation are done manually by the owner. \`mr-target-branch.txt\` refers to \`repo\` (${main.name}).`, '');
  else out.push('No git sources: this workspace will have no branches, MRs, or `repo` pointer.', '');
  if (a.links.length) {
    out.push('## Links', '');
    for (const l of a.links) {
      const { name, url } = splitLink(l);
      out.push(`- [${name}](${url})`);
    }
    out.push('');
  }
  const addDirs = a.repos.filter((r) => r.mode === 'link').map((r) => `--add-dir ${sh(r.path)}`).join(' ');
  out.push('## Launch', '', '```bash', `cd ${sh(ctx.ws)} && claude`, `codex${addDirs ? ' ' + addDirs : ''}`, '```', '');
  out.push('Only from the workspace root: from a nested repo neither settings, rules, nor memory will load.', '');
  out.push('## Convention check', '', '```bash', `wsg --check ${sh(ctx.ws)}`, '```');
  return out.join('\n') + '\n';
}

function notesMd(a, ctx) {
  const d = today();
  const out = [`# Notes: ${a.title}`, '', `## Current context (${d})`, '', 'Workspace created, work not started.', ''];
  for (const r of a.repos) {
    if (r.mode === 'worktree') {
      out.push(`- **${r.name}** — worktree on \`${r.branch}\`, head \`${ctx.head(r) || '?'}\`.`);
    } else if (ctx.isRepo(r)) {
      out.push(`- **${r.name}** — shared checkout \`${r.path}\`, not switched to the task branch.`);
    } else {
      out.push(`- **${r.name}** — directory \`${r.path}\`, not under git.`);
    }
  }
  if (hasForeignText(a)) {
    out.push('', 'Continue with: first session — translate the workspace files into English (below), then');
    out.push('reconnaissance, no code edits.', '');
    // Not a list of sections: the title alone lands in most files, and a list would miss some.
    out.push('First-session task — translate into English: the interview answers were entered in another');
    out.push('language and were copied into this workspace\'s files as is. Find every piece of text in another');
    out.push('language in CLAUDE.md, AGENTS.md, README.md, notes.md, journal.md, .claude/rules/,');
    out.push('.claude/skills/ (the description in the frontmatter too) and .learnings/ — the title is repeated');
    out.push('in most of them — and translate it without changing the meaning. Show the diff to the owner and');
    out.push('apply it only after "ok".', '');
  } else {
    out.push('', 'Continue with: first session — reconnaissance, no edits.', '');
  }
  out.push('## Code map', '', '<!-- integration points; give the file, line, and date checked -->', '');
  out.push('FILL IN during the first session.', '');
  out.push('## Open questions', '', '<!-- only about the contract and behavior; internals of other systems do not go here -->', '');
  out.push('## Notes', '', '<!-- add new notes at the top, with a date -->', '');
  out.push(`### ${d} — workspace created`, '', 'Assembled by the `wsg` generator. No code was touched.');
  return out.join('\n') + '\n';
}

function ruleMd(a, r, ctx) {
  const out = ['---', 'paths:', `  - "${r.name}/**"`, '---', '', `# Working in ${r.name}`, ''];
  if (r.mode === 'worktree') {
    out.push(`- The worktree shares \`.git\` with \`${r.path}\` — do not switch branches there while work is going on here.`);
    out.push(`- Task branch: \`${r.branch}\`, target \`${r.target}\`.`);
    out.push('- The worktree has its own `node_modules` — install separately.');
    out.push(`- Create nothing but code in \`${r.name}/\`: no \`CLAUDE.md\`, no \`.claude/\`, no \`.learnings/\`.`);
    if (r.carry && r.carry.length) {
      out.push(`- Untracked files were copied from \`${r.path}\` when the workspace was created:`);
      for (const c of r.carry) out.push(`  \`${c}\``);
      out.push('  If they change in the main checkout — update them here too, git does not sync them.');
    }
    if (r.cloneNm) {
      out.push('- `node_modules` was cloned from the main checkout at creation (APFS copy-on-write),');
      out.push('  so the versions match its branch, not this one. Run install before building and testing.');
    }
  } else if (ctx.isRepo(r)) {
    out.push(`- The checkout is shared. Before editing — \`git -C ${r.name} status --short\` and \`git -C ${r.name} branch --show-current\`.`);
    out.push('  Someone else\'s branch or someone else\'s changes — stop and ask.');
    out.push(`- Target branch \`${r.target}\`.`);
    out.push(`- The rule fires only when files are accessed via \`./${r.name}/…\`; verify in the first session`);
    out.push('  with `/context`. If it did not fire — remove `paths:` from the frontmatter.');
  } else {
    out.push(`- Directory outside git: \`${r.path}\`${r.note ? `. ${capitalize(r.note.trim().replace(/\.$/, ''))}.` : '.'}`);
    out.push('- There are no branches or commits here. Edit files as usual, but they will have no history.');
    out.push(`- The rule fires only when files are accessed via \`./${r.name}/…\`; verify in the first session`);
    out.push('  with `/context`. If it did not fire — remove `paths:` from the frontmatter.');
  }
  if (r.verify) out.push(`- Verification: \`${r.verify}\``);
  out.push('');
  out.push('FILL IN as you go: repository pitfalls, commit conventions, whatever its own AGENTS.md is missing.');
  return out.join('\n') + '\n';
}

function skillMd(a) {
  const out = ['---', `name: ${a.skillName}`, `description: ${JSON.stringify(a.title)}`, 'disable-model-invocation: true', '---', ''];
  out.push(`# ${a.title}`, '');
  out.push('A run of the procedure. Input: $ARGUMENTS — a ticket or a description of what is being shipped.', '');
  if (a.varies && a.varies.length) out.push('## What changes from run to run', '', bullets(a.varies), '');
  if (a.fixed && a.fixed.length) out.push('## What stays the same', '', bullets(a.fixed), '');
  out.push('## Steps', '');
  out.push('0. Read `journal.md` — what broke in previous runs.');
  let n = 1;
  const steps = (a.steps || []).filter(Boolean);
  if (steps.length) for (const s of steps) out.push(`${n++}. ${s}`);
  else out.push(`${n++}. FILL IN the steps: the procedure was not described when the workspace was created.`);
  out.push(`${n++}. Run the checks from AGENTS.md → "Verification".`);
  out.push(`${n++}. Create \`runs/<ticket>.md\`: what was done, how it was verified, what went wrong.`);
  out.push(`${n}. Append a paragraph to \`journal.md\` and show the result to the owner.`, '');
  out.push('Do not push or create an MR: that is the owner\'s step.');
  return out.join('\n') + '\n';
}

const journalMd = (a) => `# Run journal: ${a.title}

One paragraph per run, newest first. Details go in \`runs/<ticket>.md\`.
Only what will be useful next time: what broke, what was decided, what not to do.

<!-- ## <ticket> — <date> · one-line outcome / what went wrong / takeaway -->
`;

const learningsMd = (a) => `# LEARNINGS — ${a.title}

Lessons from this task. Anything repository-wide goes next to the repository itself.
Append only, do not rewrite.

<!-- ## Topic (date) → Context / What we found / How to apply -->
`;

const errorsMd = (a) => `# ERRORS — ${a.title}

Failures and their analysis. Append only, do not rewrite.

<!-- ## Symptom (date) → Cause / Diagnosis / Fix / Rule for the future -->
`;

function settingsJson(a, ctx) {
  const addDirs = a.repos.filter((r) => r.mode === 'link').map((r) => r.path);
  const perms = {};
  if (addDirs.length) perms.additionalDirectories = addDirs;
  perms.deny = ['Bash(git push*)', 'Bash(git -C * push*)', 'Bash(* git push*)'];
  perms.allow = [`Read(/${ctx.wsRoot}/**)`];
  return JSON.stringify({ autoMemoryDirectory: path.join(ctx.ws, '.claude-memory'), permissions: perms }, null, 2) + '\n';
}

module.exports = {
  claudeMd, agentsMd, readmeMd, notesMd, ruleMd,
  skillMd, journalMd, learningsMd, errorsMd, settingsJson, today, sh, hasForeignText,
};
