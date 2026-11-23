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
const W = require('./workspace');

const today = () => new Date().toISOString().slice(0, 10);
const bullets = (lines) => lines.filter(Boolean).map((l) => `- ${l}`).join('\n');
// Text typed in another language. Workspace files are kept in English (agents work best with it,
// and it costs fewer tokens); wsg can't translate, but it can tell that translation is needed and
// hand it to the agent as the first-session task. Cyrillic is the only case for now.
const FOREIGN = /[Ѐ-ӿ]/;
function hasForeignText(a) {
  const texts = [a.title, ...(a.problem || []), ...(a.trigger || []), ...(a.outOfScope || []), ...(a.dod || []),
    ...(a.invariants || []), ...(a.links || []),
    ...(a.fixed || []), ...(a.repos || []).map((r) => r.note || '')];
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

// How a task of the epic gets this repository: its own worktree on the template's branch, or the
// link as is.
function taskDefaultsLine(r) {
  if (!r.task) return 'Tasks: linked as is.';
  const from = r.task.base ? ` from \`${r.task.base}\`` : '';
  const carry = r.task.carry.length ? `, carry ${r.task.carry.map((c) => `\`${c}\``).join(', ')}` : '';
  return `Tasks: a worktree on \`${r.task.branch}\`${from}${carry}${r.task.cloneNm ? ', node_modules cloned' : ''}.`;
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
      if (state.kind === 'epic') out.push(`  ${taskDefaultsLine(r)}`);
    } else {
      out.push(`- \`${r.name}\` — reference directory \`${r.path}\`, not under git.${noteOf(r)}`);
    }
  }
  return out;
}

// The workspace rule that questions reach the owner through the advisor (docs/advisor-guide.md).
// One line, read in every session; no @, so nothing is imported. Generated, so that `wsg add` or
// `wsg refresh` brings it to workspaces made before it existed.
function advisorLines() {
  return ['Before you show the owner questions, decisions or a plan with open points, and before you run `wsg add`/`wsg remove`, send them to the wsg-advisor subagent; if your tool has none or it does not start, run `wsg guide advisor` and follow it yourself. Show the owner the advisor\'s FOR THE OWNER block as is, and nothing else from its reply, and never say the advisor ran when it did not.'];
}

// The same rule where Claude Code decides to delegate, in its own words: CLAUDE.md, a block of its
// own so that `wsg add` or `wsg refresh` brings it to older workspaces.
function claudeAdvisorLines() {
  return ['Before you show the owner questions or decisions, call the wsg-advisor subagent (Agent tool) with a self-contained brief; show the owner its FOR THE OWNER block as is, and nothing else from its reply.'];
}

// The team `wsg team` installed (lib/team.js): a pointer to its cards and workflow, in words every
// agent reads. Only rendered once state.team is set.
function teamLines(state) {
  const roles = state.team.roles.map((r) => `\`${r}\``).join(', ');
  const run = '`/wsg-feature` runs the workflow';
  return [
    `Team roles: ${roles}. Each role's card is \`team/<role>.md\`; the stages and who writes which file are in \`team/workflow.md\`.`,
    `In Claude Code each role is the \`wsg-<role>\` subagent and ${run}; elsewhere, play a role by reading its card.`,
    'The main session is the tech lead and the only one who talks to the owner. A team is prompts, not isolation.',
  ];
}

// A task of an epic: where the epic's knowledge and its other tasks are, where to stage what the
// next task should know, and that its session sets only review — done is the epic's closing.
// Plain text, no @: Codex reads only this AGENTS.md, and the pointers must hold without the epic's
// own files loaded. From the task's state only, so a render never needs the parent.
function epicLines(state) {
  return [
    `This task is part of epic \`${state.epic.slug}\`, the directory above (\`..\`).`,
    'Before the first edit, read `../knowledge.md`: what every task of the epic must know (Claude Code also gets this pointer from the epic\'s rules).',
    'Other tasks of the epic: `../tasks.md`.',
    'What the next task should know goes under `## For the epic` in `notes.md`, dated, with evidence; the epic merges it at close.',
    `Work finished: show the owner unchecked \`checklist.md\` items, then \`wsg status ${state.epic.slug}/${state.slug || '<task>'} review\`. \`done\` is the epic session's or the owner's.`,
  ];
}

// The epic's Owner rules in a task of it, rendered from `## Owner rules` in the epic's AGENTS.md on
// every render of the task (generate.epicRules: r), so a rule the epic adds later reaches the task at
// its next refresh: Codex reads only the task's own AGENTS.md. No date in the lead line, so an
// unchanged epic renders the same bytes. r.kind: rules (the section's body as is), none (no section,
// or FILL IN), refused (the epic can't be read: a pointer to read it there).
function epicRulesLines(slug, r) {
  if (r.kind === 'rules') {
    return [`Owner rules of epic \`${slug}\` (override tool defaults), from \`../AGENTS.md\` as of the task's last render (\`wsg refresh\`, \`add\`, \`remove\`, \`team\`); this task's own \`## Owner rules\` section, if it has one, adds to these and wins.`, '', ...r.body];
  }
  if (r.kind === 'none') return [`Epic \`${slug}\` has no Owner rules filled in yet (\`## Owner rules\` in \`../AGENTS.md\`); \`wsg refresh\` brings them here once it has.`];
  return [`The Owner rules of epic \`${slug}\` could not be rendered here (\`wsg check\` says why): read \`## Owner rules\` in \`../AGENTS.md\`.`];
}

// A size as the context index shows it: 512 B, 12 KiB, 2.1 MiB.
function sizeOf(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

// The epic's context index (`wsg context`), in the epic's own AGENTS.md (where: 'epic') and in every
// task's after the epic's Owner rules (where: 'task'): a lead line, then one line per item — its
// type, title, description, where it is (`../context/<file>` from a task) or its URL, and its size.
// Only the index: a body is kilobytes, paid on every request; the lead tells the agent to open an
// item only when its work touches the topic. From the epic's state alone (generate.epicContext: r),
// so an unchanged epic renders the same bytes. No items: an empty block. r.kind: items, or refused
// (the epic can't be read from the task: a pointer to the directory instead).
function epicContextLines(slug, r, where) {
  const up = where === 'task' ? '../' : '';
  if (r.kind === 'refused') {
    return [`The context index of epic \`${slug}\` could not be rendered here (\`wsg check\` says why): its files are in \`${up}context/\`.`];
  }
  if (!r.items.length) return [];
  const binary = r.items.some((x) => x.type === 'file' && x.binary);
  const lead = where === 'task'
    ? `Context of epic \`${slug}\`, attached by the owner: open an item only when the task touches its topic; do not read them all.`
    : 'Context of this epic, attached by the owner; its tasks get this list too: open an item only when the work touches its topic; do not read them all.';
  const out = [`${lead}${binary ? ' A binary file (PDF, image) is read by Claude Code; other agents may not read it.' : ''}`];
  for (const x of r.items) {
    const text = `${x.title}${x.description ? ` — ${x.description}` : ''}`;
    if (x.type === 'link') out.push(`- [link] ${text}: ${x.url}`);
    else out.push(`- [${x.type}] ${text}: \`${up}${x.path}\` (${sizeOf(x.bytes)}${x.binary ? ', binary' : ''})`);
  }
  return out;
}

// The epic's own tasks, the directories wsg made inside it (W.childrenOf): one line each, with the
// ticket and title when the task has them, and its status: nothing while open, [review], [done
// <date>], [archived <date>] (W.markerOf) — rendered from the status in its state, the source of truth; the
// free-text `## Status` section below is the agent's summary in words. So an epic whose tasks are
// all open renders as before. Every tracker child issue without a task directory here is below the
// block, one item per task, key first, written by the agent
// from the tracker.
function tasksLines(children, epicSlug) {
  if (!children.length) return [`No tasks in this directory yet: \`wsg new <slug> --epic ${epicSlug}\` creates one.`];
  return children.map(({ ws, state, mismatch }) => {
    const slug = path.basename(ws);
    const parts = [`- \`${slug}/\``];
    if (state.ticket) parts.push(state.ticket);
    if (state.title && state.title !== slug) parts.push(`— ${state.title}`);
    const marker = W.markerOf(state);
    if (marker) parts.push(marker);
    if (mismatch) parts.push(`(its state names epic \`${state.epic.slug}\`: see \`wsg check\`)`);
    return parts.join(' ');
  });
}

// The <!-- wsg:archive --> block, in AGENTS.md only while the workspace is archived (wsg archive):
// that it is, since when, what was detached and what is kept, and how to get it back. From the state
// alone: an unchanged archive renders the same bytes. ws: the workspace, for the name to give
// `wsg unarchive`.
function archiveLines(ws, state) {
  const a = state.archive;
  const name = state.epic ? `${state.epic.slug}/${path.basename(ws)}` : path.basename(ws);
  const kept = a.sources.filter((r) => r.mode === 'worktree' && r.branch).map((r) => `\`${r.name}\` on \`${r.branch}\``);
  const links = a.sources.filter((r) => r.mode !== 'worktree').map((r) => `\`${r.name}\``);
  const what = [
    kept.length ? `worktrees removed, their branches kept: ${kept.join(', ')}` : '',
    links.length ? `links removed: ${links.join(', ')}` : '',
  ].filter(Boolean).join('; ');
  return [
    `This ${state.kind} is archived since ${a.date} (\`wsg archive\`)${state.kind === 'epic' ? ', with its tasks' : ''}: ${what || 'it had no sources attached'}.`,
    'Its notes, memory, rules and knowledge are as they were. Read it, but start no work here.',
    `\`wsg unarchive ${name}\` attaches the sources again on the same branches.`,
  ];
}

// A task without code (`wsg new --no-code`) has no command to run: done is what the owner checks.
const NO_CODE_VERIFICATION = '- None: no code in this task; done is what the owner can check — see Definition of done.';

function verificationLines(state) {
  const withVerify = state.sources.filter((r) => r.verify);
  if (withVerify.length) return withVerify.map((r) => `- ${r.name}: \`${r.verify}\``);
  if (state.noCode) return [NO_CODE_VERIFICATION];
  if (!state.sources.length) return ['- FILL IN: no repository attached yet — `wsg add <path> --verify "<command>"` sets it.'];
  return ['- FILL IN: no command was set when the sources were attached.'];
}

function sourcesLines(state, ctx) {
  const out = [];
  if (state.sources.length) {
    out.push('| Source | Mode | Branch | Target |', '|---|---|---|---|');
    for (const r of state.sources) {
      if (!r.reference) out.push(`| \`${r.name}\` | ${r.mode} | \`${r.branch || '—'}\` | \`${r.target}\` |`);
      else out.push(`| \`${r.name}\` | reference | — | ${(r.note || '—').replace(/\|/g, '\\|')} |`);
    }
  } else if (state.noCode) {
    out.push('None: no code in this task. Material to read is attached with `wsg add <path> --link` or `--reference`.');
  } else {
    out.push('None yet: attach a git repository with `wsg add <path>`.');
  }
  out.push('');
  // An epic has no mr-target-branch.txt: the MR is its tasks'. Nor has a task without code: it
  // changes nothing in its repositories.
  const main = state.kind === 'epic' || state.noCode ? null : mainSource(state);
  if (main) out.push(`Push and MR creation are done manually by the owner. \`mr-target-branch.txt\` refers to \`repo\` (${main.name}).`, '');
  const addDirs = W.extraDirs(state).map((p) => `--add-dir ${sh(p)}`).join(' ');
  out.push('## Launch', '', '```bash', `cd ${sh(ctx.ws)} && claude`, `codex${addDirs ? ' ' + addDirs : ''}`, '```', '');
  out.push('Only from the workspace root: from a nested repo neither settings, rules, nor memory will load.');
  return out;
}

// --- files written once, when the workspace is created

// a: the workspace meta (kind, slug, title, ticket, personalRules) plus the answers that
// are already known; ctx.state: the state the blocks are rendered from (no sources for `wsg new`).
function claudeMd(a, ctx) {
  return `# ${a.title}

@AGENTS.md
${marked('imports', importLines(ctx.state, ctx))}

## Claude Code only

${marked('advisor', claudeAdvisorLines())}

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

// An epic's CLAUDE.md loads in every session of the epic and of each task inside it (Claude Code
// reads the CLAUDE.md files above the cwd), so it holds only what all of them need. Its @AGENTS.md
// was not followed from a task, the import leaving the task directory — observed with -p only,
// unverified in an interactive session where the owner may approve the import (probe P3).
function epicClaudeMd(a) {
  return `# ${a.title}

@AGENTS.md

## Claude Code only

${marked('advisor', claudeAdvisorLines())}

In a task directory below, that task's own AGENTS.md governs: this file only adds the rule above.
`;
}

// The epic's AGENTS.md: read in the epic's own sessions only. A task carries what it needs from
// the epic in its own AGENTS.md (Codex reads no file above the cwd here).
function epicAgentsMd(a, ctx) {
  const out = [`# ${a.title}`, ''];
  const ticket = a.ticketUrl || a.ticket;
  out.push(`Ticket: ${ticket || 'FILL IN — the epic\'s key or URL in the tracker.'}`);
  for (const l of a.links || []) {
    const { name, url } = splitLink(l);
    out.push(`${name}: ${url}`);
  }
  out.push('');
  // One line: the advisor block is put back after it, so a wrapped sentence would be split.
  out.push('This is an epic workspace, not a git repository: this directory holds one tracker epic — what its tasks need to know, its repositories, and its tasks, each an ordinary task workspace in a directory below with its own AGENTS.md.');
  out.push(marked('advisor', advisorLines()), marked('epic-context', epicContextLines(a.slug, { kind: 'items', items: ctx.state.context || [] }, 'epic')),
    marked('epic-knowledge', epicKnowledgeLines()), '');
  out.push('When the owner asks — in this directory, not in a task below — to start work on a ticket, run `wsg guide epic` → Starting a task.', '');
  if (hasForeignText(a)) {
    out.push('Knowledge files of this workspace (AGENTS.md, README.md, notes.md, knowledge.md, rules) are kept in English;',
      'text entered in another language is translated in the first session — see "Continue with" in `notes.md`.', '');
  }
  out.push('## Why', '');
  out.push(given(a.problem) ? a.problem.join('\n') : 'FILL IN: what the epic delivers, for whom, and why now — 1–3 lines.', '');

  out.push('## Layout', '', marked('layout', layoutLines(ctx.state, ctx)));
  out.push('- `knowledge.md` — what every task of the epic must know: decisions, repositories, pitfalls.');
  out.push('- `tasks.md` — the epic\'s tasks: the ones in this directory, and every tracker child issue without a task directory here.');
  out.push('- `decisions.md` — the rationale behind the one-line decisions in `knowledge.md`.');
  out.push('- `<task>/` — a task of the epic: an ordinary task workspace with its own AGENTS.md.');
  out.push('- `notes.md` — current context, open questions.');
  out.push('- `.learnings/` — lessons from this epic.');
  if (ctx.globalMemory) out.push(`- Your personal rules — \`${ctx.globalMemory}\`. Codex does not load it on its own.`);
  out.push('');

  out.push('## Verification', '');
  out.push('A command the agent runs itself and gets pass/fail. Without it, "looks done" is');
  out.push('the only signal, and a human ends up acting as the validator.', '');
  out.push(marked('verification', verificationLines(ctx.state)), '');

  if (a.personalRules) out.push(...ownerRules(ctx));
  return out.join('\n').trimEnd() + '\n';
}

function ownerRules(ctx) {
  return [
    '## Owner rules (override tool defaults)', '',
    `FILL IN with a digest of \`${ctx.globalMemory || 'your rules file'}\`. Required minimum:`, '',
    '1. Change nothing — neither files nor git state — until an explicit "ok".',
    '2. Never run `git push` and never create an MR.',
    '3. No `Co-Authored-By` or "Generated with" trailers in commits.',
    '4. Branch names follow the repository convention; agree on new ones in advance.',
    '5. Cycle: plan → architect → implementation → self-review → independent review → show.',
    '6. Nothing goes outside without showing the text and getting "ok".', '',
  ];
}

const KNOWLEDGE_TARGET = 4096;
const KNOWLEDGE_MAX = 8192;

const knowledgeMd = (a) => `# Knowledge: ${a.title}

The single source of truth for this epic: what every task must know before its first edit. Target
≤ 4 KiB, ceiling 8 KiB (\`wsg check\`): rewrite it rather than append. Rationale goes to \`decisions.md\`,
facts of one repository to \`.claude/rules/<repo>.md\`.

## Decisions

<!-- one line each: what was decided; the rationale is under the same words in decisions.md -->

## Repositories

<!-- one line each: the repository and what it is for in this epic -->

## Pitfalls

<!-- what went wrong in a task, and how the next one avoids it -->
`;

// A pointer, not a copy (knowledge.md is the source of truth): it loads in every session of the
// epic and of its tasks, so it carries no paths: and stays a few lines.
const epicKnowledgeRule = () => `# Epic knowledge

Before the first edit, read the epic's \`knowledge.md\`: \`knowledge.md\` in the epic directory,
\`../knowledge.md\` from a task directory of the epic.
`;
const EPIC_RULE = 'epic-knowledge.md';
const epicKnowledgeLines = () => [
  "Before the first edit in the project directory, read `knowledge.md` for the project's shared decisions, repositories, and pitfalls.",
];

function tasksMd(a, children) {
  return [`# Tasks: ${a.title}`, '',
    marked('tasks', tasksLines(children, a.slug)), '',
    '## Status', '',
    '<!-- one line per task above once it is closed: `<slug>/` — date, outcome; written at close -->', '',
    '## Other tasks', '',
    '<!-- every tracker child issue without a task directory here, one item per task, key first: `wsg guide epic` → Syncing',
    'rewrites this section, its heading becoming "## Other tasks (synced <date> via <tool>)" -->', ''].join('\n');
}

const decisionsMd = (a) => `# Decisions: ${a.title}

Why the epic decided what \`knowledge.md\` → Decisions states in one line. Newest first, one heading
per decision, in the same words as its line there.

<!-- ## <date> <decision> → Context / Options / Why this one / Evidence -->
`;

// The epic's manual skills: thin wrappers over a section of `wsg guide epic`.
const EPIC_SKILLS = ['wsg-epic-task', 'wsg-epic-close', 'wsg-epic-sync'];

// How a run is named. Not a ticket: many procedures (a weekly dependency upgrade) have no
// tracker, and "<ticket>" left the agent asking for one. A ticket, where there is one, goes into the name.
function agentsMd(a, ctx) {
  const out = [`# ${a.title}`, ''];
  const ticket = a.ticketUrl || a.ticket;
  if (ticket) out.push(`Ticket: ${ticket}`);
  for (const l of a.links || []) {
    const { name, url } = splitLink(l);
    out.push(`${name}: ${url}`);
  }
  if (out.length > 2) out.push('');
  out.push(a.noCode
    ? 'This is a task workspace without code (`wsg new --no-code`): no repository, no branch; done is what the owner can check (Definition of done), and what it reads is listed in Layout.'
    : 'This is a task workspace, not a git repository: the repositories it works on are listed in Layout.');
  out.push(marked('advisor', advisorLines()));
  if (ctx.state.epic) {
    out.push(marked('epic', epicLines(ctx.state)), marked('epic-rules', epicRulesLines(ctx.state.epic.slug, a.epicRules || { kind: 'none' })),
      marked('epic-context', epicContextLines(ctx.state.epic.slug, a.epicContext || { kind: 'items', items: [] }, 'task')));
  }
  out.push('');
  if (hasForeignText(a)) {
    out.push('Knowledge files of this workspace (AGENTS.md, README.md, notes.md, rules) are kept in English;',
      'text entered in another language is translated in the first session — see "Continue with" in `notes.md`.', '');
  }
  out.push('## Why', '');
  out.push(given(a.problem) ? a.problem.join('\n')
    : 'FILL IN: what problem this task solves, for whom, and why now — 1–3 lines.', '');
  out.push(`Starting state: ${a.stateLabel || 'FILL IN — new feature / updating existing work / understanding legacy code'}.`, '');
  if (given(a.trigger)) out.push('## When it runs', '', bullets(a.trigger), '');

  out.push('## Definition of done');
  out.push('', given(a.dod) ? a.dod.join('\n')
    : a.noCode ? 'FILL IN: what the owner can check to call it done — a document approved, a decision recorded, a question answered.'
      : 'FILL IN: what can be checked to call it done.', '');
  out.push('Each item is a line of `checklist.md`, ticked only with evidence: before review or done, show the owner what is unchecked.', '');
  if (a.spec) out.push(...stagesLines(a));

  // Boundaries are always-on context.
  if (given(a.outOfScope) || a.outOfScope === undefined) {
    out.push('## Out of scope', '', given(a.outOfScope) ? bullets(a.outOfScope)
      : 'FILL IN: nearby things not to touch — or remove this section.', '');
    out.push('Do not work on these. If the task seems to need it, ask the owner first.', '');
  }
  if (given(a.fixed)) out.push('## Rules and boundaries', '', bullets(a.fixed), '');

  out.push('## Layout', '', marked('layout', layoutLines(ctx.state, ctx)));
  out.push('- `notes.md` — current context, code map, open questions.');
  out.push('- `checklist.md` — the Definition of done as checkboxes, ticked with evidence.');
  if (a.spec) out.push('- `spec.md`, `plan.md` — the spec and the plan, each approved by the owner (Stages).');
  out.push('- `.learnings/` — lessons from this task.');
  if (ctx.globalMemory) out.push(`- Your personal rules — \`${ctx.globalMemory}\`. Codex does not load it on its own.`);
  out.push('');

  out.push('## Verification', '');
  out.push('A command the agent runs itself and gets pass/fail. Without it, "looks done" is');
  out.push('the only signal, and a human ends up acting as the validator.', '');
  out.push(marked('verification', verificationLines(ctx.state)), '');

  if (given(a.invariants)) {
    out.push('## Invariants are not findings', '', bullets(a.invariants), '');
    out.push('Do not offer to "fix" anything listed. If a reviewer demands it, that is a question for the task owner.', '');
  } else {
    out.push('## Invariants are not findings', '');
    if (a.invariants === undefined) {
      out.push('FILL IN: deliberate decisions that look like violations of the repository rules — or replace this');
      out.push('line with "None recorded yet." Without them the agent and the reviewer subagent will "fix" them.', '');
    } else {
      out.push('None recorded yet. As soon as a deliberate decision turns out to look like a violation');
      out.push('of the repository rules — write it down here, or the agent and the reviewer subagent will "fix" it.', '');
    }
  }

  // A task of an epic with Owner rules gets them in the epic-rules block, and no section of its own
  // until it has a rule of its own to add.
  if (a.personalRules && !(a.epicRules && a.epicRules.kind === 'rules')) out.push(...ownerRules(ctx));

  out.push('## Code map', '');
  out.push('Integration points are in `notes.md`, section "Code map". Verify against the code, not memory:');
  out.push('line numbers are correct as of the date they were recorded.');
  return out.join('\n') + '\n';
}

// The stages of a task made with `wsg new --spec`, in its AGENTS.md: spec (and the checklist built
// from it), plan, the work, the checklist review — each next one only after the owner's ok. Written
// once, as prose: the agent and the owner own it. a.noCode: the work is no code.
function stagesLines(a) {
  return [
    '## Stages', '',
    'This task goes spec first. Each next stage starts only after the owner\'s "ok" on the one before:', '',
    '1. Spec: fill in `spec.md` — the problem, the behavior, the edge cases, acceptance criteria — and show it to the owner. After the "ok", build `checklist.md` from its acceptance criteria.',
    `2. Plan: from the approved spec, fill in \`plan.md\` — ${a.noCode ? 'steps, evidence, risks' : 'steps, files, tests, risks'} — and show it to the owner.`,
    `3. ${a.noCode ? 'Work' : 'Implementation'}: follow the approved plan; a change to the spec or the plan goes back to the owner first.`,
    '4. Checklist review: tick each item of `checklist.md` with evidence, show the owner what is unchecked.', '',
  ];
}

// A new task's checklist.md: the Definition of done as checkboxes, filled in by the setup (for a task
// with spec stages, from the spec's acceptance criteria once the owner approves it); wsg counts them
// (W.checklistCounts) for list and status, and warns about unchecked ones at review and done.
const checklistMd = (a) => `# Checklist: ${a.title}

<!-- One \`- [ ]\` line per verifiable item of ${a.spec ? 'the acceptance criteria in spec.md, written once the owner approves the spec (AGENTS.md → Stages)' : 'the Definition of done in AGENTS.md'}.
Tick an item \`- [x]\` only with evidence: a command and its result, a file and line, a link.
wsg counts the boxes (wsg list, wsg status) and warns about unchecked ones when the task goes to review or done. -->

- [ ] FILL IN: ${a.spec ? 'items from the acceptance criteria of spec.md' : 'items from the Definition of done'}
`;

// The spec stage of a task made with `wsg new --spec`: approved by the owner before plan.md.
const specMd = (a) => `# Spec: ${a.title}

<!-- Stage 1 (AGENTS.md → Stages): written first, shown to the owner; after "ok", checklist.md is built from the acceptance criteria and plan.md starts. -->

## Problem

FILL IN: what is wrong or missing, for whom, and why now.

## Behavior

FILL IN: what is true once it is done, from the side of whoever uses the result.

## Edge cases

FILL IN: errors, empty and large inputs, what must not change.

## Acceptance criteria

<!-- one checkable item each: checklist.md is built from these -->

FILL IN

## Out of scope

FILL IN: what this task does not do.
`;

// The plan stage: from the approved spec, approved by the owner before the work starts. A task
// without code has no files or tests to plan: what shows each criterion is met instead.
const planMd = (a) => (a.noCode ? `# Plan: ${a.title}

<!-- Stage 2 (AGENTS.md → Stages): written from the approved spec.md, shown to the owner; the work starts after "ok". -->

## Steps

FILL IN: the steps, in order, each small enough for the owner to review.

## Evidence

FILL IN: what shows each acceptance criterion of spec.md is met.

## Risks

FILL IN: what can go wrong, and how it is noticed.
` : `# Plan: ${a.title}

<!-- Stage 2 (AGENTS.md → Stages): written from the approved spec.md, shown to the owner; code starts after "ok". -->

## Steps

FILL IN: the steps, in order, each small enough to review.

## Files

FILL IN: the files each step touches.

## Tests

FILL IN: what proves each acceptance criterion of spec.md.

## Risks

FILL IN: what can break, and how it is checked.
`);

function readmeMd(a, ctx) {
  const out = [`# ${a.slug} — ${a.title}`, '', given(a.problem) ? a.problem.join('\n') : 'Why and what "done" means: see `AGENTS.md`.', ''];
  const kind = a.kind === 'epic' ? a.kind : 'task';
  out.push(`Workspace kind: **${kind}**${a.epic ? ` (epic \`${a.epic.slug}\`)` : ''}.`, '');
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

// The section of a task of an epic's notes.md where it stages what the epic should learn from it;
// wsg move adds it to a task moved into an epic.
const forEpicLines = () => ['## For the epic', '', '<!-- what the next task of the epic should know — a decision, a repository fact, a pitfall:',
  'one entry each, dated, with evidence (a file and line, a commit, a link); merged into the epic at close -->', ''];

function notesMd(a) {
  const d = today();
  const out = [`# Notes: ${a.title}`, '', `## Current context (${d})`, ''];
  const foreign = hasForeignText(a);
  if (!given(a.problem)) {
    // The skeleton of `wsg new`: check warns until the setup dialogue is done, and this says how to do it.
    out.push('Setup not finished — run /wsg-setup (or follow SETUP.md).', '');
    // AGENTS.md points here whenever the text isn't English: a title given in another language too.
    if (foreign) out.push('Continue with: as part of the setup, translate the workspace files into English (below).', '');
  } else if (foreign) {
    out.push('Workspace created, work not started.', '');
    out.push('Continue with: first session — translate the workspace files into English (below), then');
    out.push('reconnaissance, no code edits.', '');
  }
  if (foreign) {
    // Not a list of sections: the title alone lands in most files, and a list would miss some.
    out.push('First-session task — translate into English: the answers were entered in another');
    out.push('language and were copied into this workspace\'s files as is. Find every piece of text in another');
    const files = a.kind === 'epic' ? 'notes.md, knowledge.md, tasks.md, decisions.md' : 'notes.md';
    out.push(`language in CLAUDE.md, AGENTS.md, README.md, ${files}, .claude/rules/,`);
    out.push('.claude/skills/ (the description in the frontmatter too) and .learnings/ — the title is repeated');
    out.push('in most of them — and translate it without changing the meaning. Show the diff to the owner and');
    out.push('apply it only after "ok".', '');
  } else if (given(a.problem)) {
    out.push('Workspace created, work not started.', '', 'Continue with: first session — reconnaissance, no edits.', '');
  }
  // An epic keeps what its tasks need in knowledge.md: a code map here would be a second copy.
  if (a.kind !== 'epic') {
    out.push('## Code map', '', '<!-- integration points; give the file, line, and date checked -->', '');
    out.push('FILL IN during the first session.', '');
  }
  out.push('## Open questions', '', '<!-- only about the contract and behavior; internals of other systems do not go here -->', '');
  // A task of an epic stages here what the epic should learn from it; merged at close, from the epic.
  if (a.epic) {
    out.push(...forEpicLines());
  }
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

// A rule is generator-owned: written when its source is attached, removed with it. The mark is the
// first line inside the frontmatter — before it, Claude Code would no longer read the frontmatter —
// and it is how add and remove tell this file from notes the owner keeps under the same name.
const RULE_MARK = '# generated by wsg: written by wsg add, removed by wsg remove';
const isOwnRule = (text) => text.split(/\r?\n/)[1] === RULE_MARK; // an editor may have saved it with CRLF

// opts.noCode: a repository linked into a task without code (wsg new --no-code): read only.
// opts.epic: the rule of an epic's repository. It loads in the epic, where the repository is a link,
// and in each task of the epic once the task reads its own worktree of it (probe P1): so it says
// only what holds in both, and leaves the branch to the task's own rule.
function ruleMd(r, opts = {}) {
  const out = ['---', RULE_MARK, 'paths:', `  - "${r.name}/**"`, '---', '', `# Working in ${r.name}`, ''];
  if (opts.epic && !r.reference) {
    out.push(`- In the epic, \`${r.name}\` is a symlink to the shared checkout \`${r.path}\`: before editing there,`);
    out.push(`  \`git -C ${r.name} status --short\` and \`git -C ${r.name} branch --show-current\`. Someone else's branch or changes — stop and ask.`);
    out.push(`- In a task of the epic, \`${r.name}/\` is ${r.task ? 'the task\'s own worktree: its branch is in the task\'s rule' : 'the same link'}.`);
    out.push(`- Target branch \`${r.target}\`.`);
    if (r.verify) out.push(`- Verification: \`${r.verify}\``);
    out.push('', 'FILL IN as you go: facts of this repository every task of the epic needs — pitfalls, conventions.');
    return out.join('\n') + '\n';
  }
  if (opts.noCode && !r.reference) {
    out.push(`- \`${r.name}\` is a symlink to the shared checkout \`${r.path}\`, read only: this task changes no code.`);
    out.push('  A change here is a question to the owner, never made on your own.');
    out.push(`- The rule fires only when files are accessed via \`./${r.name}/…\`; verify in the first session`);
    out.push('  with `/context`. If it did not fire — remove `paths:` from the frontmatter.', '');
    out.push('FILL IN as you go: where the material this task needs is in the repository.');
    return out.join('\n') + '\n';
  }
  if (r.mode === 'worktree') {
    out.push(`- The worktree shares \`.git\` with \`${r.path}\` — do not switch branches there while work is going on here.`);
    out.push(`- Task branch: \`${r.branch}\`, target \`${r.target}\`.`);
    // The epic's rule for the repository loads here too: it holds what every task needs, this one the task's own.
    if (r.from === 'epic') out.push(`- Taken from the epic: its rule \`../.claude/rules/${r.name}.md\` holds the facts every task needs; this one is this task's.`);
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
  // A source taken from the epic: what every task needs is merged into the epic at close.
  if (r.from === 'epic') out.push('FILL IN as you go: what holds for this task only. A fact every task of the epic needs goes under `## For the epic` in `notes.md`.');
  else {
    out.push(!r.reference
      ? 'FILL IN as you go: repository pitfalls, commit conventions, whatever its own AGENTS.md is missing.'
      : 'FILL IN as you go: how the files here are organized, naming conventions, what not to change.');
  }
  return out.join('\n') + '\n';
}

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
  const addDirs = W.extraDirs(ctx.state);
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
  claudeMd, agentsMd, readmeMd, notesMd, forEpicLines, setupMd, ruleMd, checklistMd, specMd, planMd, stagesLines,
  epicClaudeMd, epicAgentsMd, knowledgeMd, epicKnowledgeRule, epicKnowledgeLines, tasksMd, tasksLines, decisionsMd,
  EPIC_RULE, EPIC_SKILLS, KNOWLEDGE_TARGET, KNOWLEDGE_MAX,
  learningsMd, errorsMd, settingsJson, today, sh, hasForeignText,
  RULE_MARK, isOwnRule, marked, mainSource, importLines, layoutLines, archiveLines, epicRulesLines, epicContextLines, sizeOf, advisorLines, claudeAdvisorLines, teamLines, epicLines, verificationLines, NO_CODE_VERIFICATION, sourcesLines, template, TEMPLATES,
};
