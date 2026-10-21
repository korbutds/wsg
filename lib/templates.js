'use strict';

// Workspace file templates. Carried over verbatim from the former bash core: the
// text holds accumulated knowledge, so "rewrite it from memory" is not an option.
// It was checked byte-for-byte against that core once, during the move, and later
// translated from Russian to English.
//
// Two kinds of text live in these files. Prose — why, done, scope, invariants — is written once:
// by `wsg new` as FILL IN headings for the agent to fill, or from given answers. Generated blocks
// sit between <!-- wsg:name --> markers and are rendered from .claude/wsg.json on every `wsg add`
// (see generate.render); text outside the markers is never touched again.

const fs = require('node:fs');
const path = require('node:path');

const today = () => new Date().toISOString().slice(0, 10);
const bullets = (lines) => lines.filter(Boolean).map((l) => `- ${l}`).join('\n');
// Text typed in another language. Workspace files are kept in English (agents work best with it,
// and it costs fewer tokens); wsg can't translate, but it can tell that translation is needed and
// hand it to the agent as the first-session task. Cyrillic is the only case for now.
const FOREIGN = /[Ѐ-ӿ]/;
function hasForeignText(a) {
  const texts = [a.title, ...(a.problem || []), ...(a.trigger || []), ...(a.outOfScope || []), ...(a.dod || []),
    ...(a.invariants || []), ...(a.links || []),
    ...(a.varies || []), ...(a.fixed || []), ...(a.steps || []), ...(a.repos || []).map((r) => r.note || '')];
  return texts.some((x) => FOREIGN.test(x || ''));
}

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
// Path in a printed command: with an unquoted space it cannot be copied and run.
const sh = (s) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
// An answer that wasn't given yet: `wsg new` leaves the heading with FILL IN for the setup dialogue.
const given = (lines) => Array.isArray(lines) && lines.length > 0;
const noteOf = (r) => (r.note ? ` ${capitalize(r.note.trim().replace(/\.$/, ''))}.` : '');

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

// --- generated blocks: rendered from the state, never edited by hand

const marked = (name, lines) => [`<!-- wsg:${name} -->`, ...lines, `<!-- /wsg:${name} -->`].join('\n');

// The repository that `repo` and mr-target-branch.txt refer to: tools use it to determine the
// project and the MR target branch, so it must be a repository, not just the first source.
const mainSource = (state) => state.sources.find((r) => r.mode === 'worktree' && !r.reference)
  || state.sources.find((r) => !r.reference);

// ctx: { ws, hasAgentsMd(r), hasClaudeMd(r) }
function importLines(state, ctx) {
  return state.sources.filter((r) => r.mode === 'worktree' && ctx.hasAgentsMd(r)).map((r) => `@${r.name}/AGENTS.md`);
}

function layoutLines(state, ctx) {
  const out = [];
  for (const r of state.sources) {
    if (r.mode === 'worktree') {
      out.push(`- \`${r.name}/\` — git worktree, branch \`${r.branch}\`, target \`${r.target}\`.`);
      if (ctx.hasAgentsMd(r)) out.push(`  Repository rules — \`${r.name}/AGENTS.md\`, read before the first edit.`);
      else if (ctx.hasClaudeMd(r)) out.push(`  Repository rules — \`${r.name}/CLAUDE.md\`, read before the first edit.`);
    } else if (!r.reference) {
      out.push(`- \`${r.name}\` — symlink to the shared checkout \`${r.path}\`, target \`${r.target}\`.`);
    } else {
      out.push(`- \`${r.name}\` — reference directory \`${r.path}\`, not under git.${noteOf(r)}`);
    }
  }
  return out;
}

function verificationLines(state) {
  const withVerify = state.sources.filter((r) => r.verify);
  if (withVerify.length) return withVerify.map((r) => `- ${r.name}: \`${r.verify}\``);
  if (!state.sources.length) return ['- FILL IN: no repository attached yet — `wsg add <path> --verify "<command>"` sets it.'];
  return ['- FILL IN: no command was set when the sources were attached.'];
}

function sourcesLines(state, ctx) {
  const out = [];
  if (state.sources.length) {
    out.push('| Source | Mode | Branch | Target |', '|---|---|---|---|');
    for (const r of state.sources) {
      if (!r.reference) out.push(`| \`${r.name}\` | ${r.mode} | \`${r.branch || '—'}\` | \`${r.target}\` |`);
      else out.push(`| \`${r.name}\` | reference | — | ${r.note || '—'} |`);
    }
  } else {
    out.push('None yet: attach a git repository with `wsg add <path>`.');
  }
  out.push('');
  const main = mainSource(state);
  if (main) out.push(`Push and MR creation are done manually by the owner. \`mr-target-branch.txt\` refers to \`repo\` (${main.name}).`, '');
  const addDirs = state.sources.filter((r) => r.mode === 'link').map((r) => `--add-dir ${sh(r.path)}`).join(' ');
  out.push('## Launch', '', '```bash', `cd ${sh(ctx.ws)} && claude`, `codex${addDirs ? ' ' + addDirs : ''}`, '```', '');
  out.push('Only from the workspace root: from a nested repo neither settings, rules, nor memory will load.');
  return out;
}

// --- files written once, when the workspace is created

// a: the workspace meta (kind, slug, title, ticket, skillName, personalRules) plus the answers that
// are already known; ctx.state: the state the blocks are rendered from (no sources for `wsg new`).
function claudeMd(a, ctx) {
  return `# ${a.title}

@AGENTS.md
${marked('imports', importLines(ctx.state, ctx))}

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

// How a run is named. Not a ticket: many procedures (a weekly dependency upgrade) have no
// tracker, and "<ticket>" left the agent asking for one. A ticket, where there is one, goes into the name.
const RUN_NAME = '`runs/<date>-<short-name>.md` (e.g. `runs/2026-09-30-release-2.4.md`; add the ticket ID to the name if the run has one)';

// "How it runs" for AGENTS.md — shared with promote, so the two never describe it differently.
function howItRuns(skillName) {
  return [
    `The procedure lives in \`.claude/skills/${skillName}/SKILL.md\` and is invoked manually:`,
    `\`/${skillName}\` or \`/${skillName} <what this run is about>\`. It never fires on its own — it has side effects.`,
    'Without an argument, look at what is new in the sources, or ask the owner.',
    '',
    'Before a run, read `journal.md`: it records what broke in previous runs.',
    `After a run, write ${RUN_NAME} and append a paragraph to the journal.`,
  ];
}

function agentsMd(a, ctx) {
  const proc = a.kind === 'process';
  const out = [`# ${a.title}`, ''];
  const ticket = a.ticketUrl || a.ticket;
  if (ticket) out.push(`Ticket: ${ticket}`);
  for (const l of a.links || []) {
    const { name, url } = splitLink(l);
    out.push(`${name}: ${url}`);
  }
  if (out.length > 2) out.push('');
  out.push(`This is a ${proc ? 'process' : 'task'} workspace, not a git repository: the repositories it works on are listed in Layout.`, '');
  if (hasForeignText(a)) {
    out.push('Knowledge files of this workspace (AGENTS.md, README.md, notes.md, rules, journal) are kept in English;',
      'text entered in another language is translated in the first session — see "Continue with" in `notes.md`.', '');
  }
  out.push('## Why', '');
  out.push(given(a.problem) ? a.problem.join('\n')
    : proc ? 'FILL IN: what the procedure does and what it gives — 1–3 lines.'
      : 'FILL IN: what problem this task solves, for whom, and why now — 1–3 lines.', '');
  out.push(`Starting state: ${a.stateLabel || (proc ? 'repeatable process; each run gets its own input'
    : 'FILL IN — new feature / updating existing work / understanding legacy code')}.`, '');
  if (proc) {
    out.push('## When it runs', '', given(a.trigger) ? bullets(a.trigger)
      : 'FILL IN: what prompts a run — e.g. a release is scheduled, a dependency has a new major version.', '');
  } else if (given(a.trigger)) out.push('## When it runs', '', bullets(a.trigger), '');

  out.push(proc ? '## Definition of done for a single run' : '## Definition of done');
  out.push('', given(a.dod) ? a.dod.join('\n') : 'FILL IN: what can be checked to call it done.', '');

  // Boundaries are always-on context: the skill is loaded only when invoked.
  // A process has "Rules and boundaries" instead, so it gets this section only when it was given.
  if (given(a.outOfScope) || (!proc && a.outOfScope === undefined)) {
    out.push('## Out of scope', '', given(a.outOfScope) ? bullets(a.outOfScope)
      : 'FILL IN: nearby things not to touch — or remove this section.', '');
    out.push('Do not work on these. If the task seems to need it, ask the owner first.', '');
  }
  if (given(a.fixed)) out.push('## Rules and boundaries', '', bullets(a.fixed), '');
  else if (proc) out.push('## Rules and boundaries', '', 'FILL IN: what holds on every run, and what not to do.', '');

  if (proc) {
    out.push('## How it runs', '');
    out.push(...howItRuns(a.skillName), '');
    out.push('A process has no permanent branch. Repositories are attached as symlinks to shared checkouts:');
    out.push('the skill creates the branch and, if needed, a worktree for each run.', '');
  }

  out.push('## Layout', '', marked('layout', layoutLines(ctx.state, ctx)));
  out.push('- `notes.md` — current context, code map, open questions.');
  out.push('- `.learnings/` — lessons from this task.');
  if (ctx.globalMemory) out.push(`- Your personal rules — \`${ctx.globalMemory}\`. Codex does not load it on its own.`);
  out.push('');

  out.push('## Verification', '');
  out.push('A command the agent runs itself and gets pass/fail. Without it, "looks done" is');
  out.push('the only signal, and a human ends up acting as the validator.', '');
  out.push(marked('verification', verificationLines(ctx.state)), '');

  // A process has "Rules and boundaries" instead, and gets this section only with invariants given:
  // an empty section about repository rules and reviewers is context paid for on every turn.
  if (given(a.invariants)) {
    out.push('## Invariants are not findings', '', bullets(a.invariants), '');
    out.push('Do not offer to "fix" anything listed. If a reviewer demands it, that is a question for the task owner.', '');
  } else if (!proc) {
    out.push('## Invariants are not findings', '');
    if (a.invariants === undefined) {
      out.push('FILL IN: deliberate decisions that look like violations of the repository rules — or replace this');
      out.push('line with "None recorded yet." Without them the agent and the reviewer subagent will "fix" them.', '');
    } else {
      out.push('None recorded yet. As soon as a deliberate decision turns out to look like a violation');
      out.push('of the repository rules — write it down here, or the agent and the reviewer subagent will "fix" it.', '');
    }
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
  const out = [`# ${a.slug} — ${a.title}`, '', given(a.problem) ? a.problem.join('\n') : 'Why and what "done" means: see `AGENTS.md`.', ''];
  out.push(`Workspace kind: **${a.kind === 'process' ? 'process' : 'task'}**.`, '');
  out.push('## Sources', '', marked('sources', sourcesLines(ctx.state, ctx)), '');
  if (given(a.links)) {
    out.push('## Links', '');
    for (const l of a.links) {
      const { name, url } = splitLink(l);
      out.push(`- [${name}](${url})`);
    }
    out.push('');
  }
  out.push('## Convention check', '', '```bash', `wsg check ${sh(ctx.ws)}`, '```');
  return out.join('\n') + '\n';
}

function notesMd(a) {
  const d = today();
  const out = [`# Notes: ${a.title}`, '', `## Current context (${d})`, ''];
  if (!given(a.problem)) {
    // The skeleton of `wsg new`: check warns until the setup dialogue is done, and this says how to do it.
    out.push('Setup not finished — run /wsg-setup (or follow SETUP.md).', '');
  } else if (hasForeignText(a)) {
    out.push('Workspace created, work not started.', '');
    out.push('Continue with: first session — translate the workspace files into English (below), then');
    out.push('reconnaissance, no code edits.', '');
    // Not a list of sections: the title alone lands in most files, and a list would miss some.
    out.push('First-session task — translate into English: the answers were entered in another');
    out.push('language and were copied into this workspace\'s files as is. Find every piece of text in another');
    out.push('language in CLAUDE.md, AGENTS.md, README.md, notes.md, journal.md, .claude/rules/,');
    out.push('.claude/skills/ (the description in the frontmatter too) and .learnings/ — the title is repeated');
    out.push('in most of them — and translate it without changing the meaning. Show the diff to the owner and');
    out.push('apply it only after "ok".', '');
  } else {
    out.push('Workspace created, work not started.', '', 'Continue with: first session — reconnaissance, no edits.', '');
  }
  out.push('## Code map', '', '<!-- integration points; give the file, line, and date checked -->', '');
  out.push('FILL IN during the first session.', '');
  out.push('## Open questions', '', '<!-- only about the contract and behavior; internals of other systems do not go here -->', '');
  out.push('## Notes', '', '<!-- add new notes at the top, with a date -->', '');
  out.push(`### ${d} — workspace created`, '', 'Assembled by the `wsg` generator. No code was touched.');
  return out.join('\n') + '\n';
}

// For agents without slash skills: the same entry point as /wsg-setup, in a file they can be told to read.
const setupMd = () => `# Setup

This workspace was created by wsg and is not set up yet: the task, its sources and the
verification command are still missing.

Run \`wsg guide setup\` and follow it (without wsg on PATH: \`npx @korbutds/wsg guide setup\`).
In Claude Code the same is \`/wsg-setup\`. Re-running it later fills gaps or attaches more sources.
`;

// A rule is generator-owned: written when its source is attached.
function ruleMd(r) {
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
  } else if (!r.reference) {
    out.push(`- The checkout is shared. Before editing — \`git -C ${r.name} status --short\` and \`git -C ${r.name} branch --show-current\`.`);
    out.push('  Someone else\'s branch or someone else\'s changes — stop and ask.');
    out.push(`- Target branch \`${r.target}\`.`);
    out.push(`- The rule fires only when files are accessed via \`./${r.name}/…\`; verify in the first session`);
    out.push('  with `/context`. If it did not fire — remove `paths:` from the frontmatter.');
  } else {
    out.push(`- Reference directory outside git: \`${r.path}\`.${noteOf(r)}`);
    out.push('- Material the task works from, not the code it changes. Nothing here has history:');
    out.push('  an edit can\'t be reverted, so change files only when the owner asks.');
    out.push(`- The rule fires only when files are accessed via \`./${r.name}/…\`; verify in the first session`);
    out.push('  with `/context`. If it did not fire — remove `paths:` from the frontmatter.');
  }
  if (r.verify) out.push(`- Verification: \`${r.verify}\``);
  out.push('');
  // A reference directory has no commits or AGENTS.md: what's worth recording there is how it's laid out.
  out.push(!r.reference
    ? 'FILL IN as you go: repository pitfalls, commit conventions, whatever its own AGENTS.md is missing.'
    : 'FILL IN as you go: how the files here are organized, naming conventions, what not to change.');
  return out.join('\n') + '\n';
}

// ctx.isRepo is given by promote, which looks at what a task workspace already holds; a new process
// is code-only, so it always gets the push line.
function skillMd(a, ctx) {
  const out = ['---', `name: ${a.skillName}`, `description: ${JSON.stringify(a.title)}`, 'disable-model-invocation: true', '---', ''];
  out.push(`# ${a.title}`, '');
  out.push('A run of the procedure. Input: $ARGUMENTS — what this run is about. It may be empty: then look at', 'what is new in the sources, or ask the owner.', '');
  if (given(a.varies)) out.push('## Input of each run', '', bullets(a.varies), '');
  if (given(a.fixed)) out.push('Rules and boundaries of every run are in AGENTS.md.', '');
  out.push('## Steps', '');
  out.push('0. Read `journal.md` — what broke in previous runs.');
  let n = 1;
  const steps = (a.steps || []).filter(Boolean);
  if (steps.length) for (const s of steps) out.push(`${n++}. ${s}`);
  else out.push(`${n++}. FILL IN the steps: on the first run, work them out with the owner and write them here.`);
  out.push(`${n++}. Run the checks from AGENTS.md → "Verification".`);
  out.push(`${n++}. Write ${RUN_NAME}: what was done, how it was verified, what went wrong.`);
  out.push(`${n}. Append a paragraph to \`journal.md\` and show the result to the owner.`, '');
  const code = ctx && ctx.isRepo ? (a.repos || []).some((r) => ctx.isRepo(r)) : true;
  if (code) out.push('Do not push or create an MR: that is the owner\'s step.');
  return out.join('\n') + '\n';
}

const journalMd = (a) => `# Run journal: ${a.title}

One paragraph per run, newest first. Details go in \`runs/<date>-<short-name>.md\`.
Only what will be useful next time: what broke, what was decided, what not to do.

<!-- ## <date> <short-name> · one-line outcome / what went wrong / takeaway -->
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

// The directories of linked sources go first, ahead of anything the user added: a source attached
// later is rendered the same way (generate.render).
function settingsJson(a, ctx) {
  const addDirs = ctx.state.sources.filter((r) => r.mode === 'link').map((r) => r.path);
  const perms = {};
  if (addDirs.length) perms.additionalDirectories = addDirs;
  perms.deny = ['Bash(git push*)', 'Bash(git -C * push*)', 'Bash(* git push*)'];
  perms.allow = [`Read(/${ctx.wsRoot}/**)`];
  return JSON.stringify({ autoMemoryDirectory: path.join(ctx.ws, '.claude-memory'), permissions: perms }, null, 2) + '\n';
}

// Files shipped in the package's templates/ directory: the skills are kept as markdown so they read
// as what they are, not as strings in code.
const TEMPLATES = path.join(__dirname, '..', 'templates');
const template = (rel) => fs.readFileSync(path.join(TEMPLATES, rel), 'utf8');

module.exports = {
  claudeMd, agentsMd, readmeMd, notesMd, setupMd, ruleMd,
  skillMd, howItRuns, journalMd, learningsMd, errorsMd, settingsJson, today, sh, hasForeignText,
  marked, mainSource, importLines, layoutLines, verificationLines, sourcesLines, template, TEMPLATES,
};
