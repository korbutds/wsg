'use strict';

// What makes a directory a wsg workspace: where it may live, what it and its skill may be called,
// and the state file that says which parts of it the generator owns.

const fs = require('node:fs');
const path = require('node:path');
const { t } = require('./i18n');

// A slug becomes a directory under WS_ROOT and a `ws <slug>` argument; a skill name becomes a
// directory under .claude/skills and a /command. Neither may carry a path: `../x` would put the
// workspace — and its rollback's rm -rf — outside WS_ROOT.
const KEBAB = /^[a-z0-9][a-z0-9-]*$/;

// Names the generator creates at the workspace root. A source with one of these names would be a
// symlink there, and writing the template would go through it — over the user's own file
// outside the workspace. `repo` is allowed: the pointer is skipped when a source takes the name.
// `.git` too: a symlink to someone's .git would make the workspace itself a work tree of that repo.
// requirements.md, design.md, plan.md, review.md and team/ are kept free for the team workflow;
// tasks.md, decisions.md and knowledge.md for an epic. A task of an epic is a directory in it, so
// its slug can't take these names either.
const RESERVED = ['CLAUDE.md', 'AGENTS.md', 'README.md', 'notes.md', 'SETUP.md', 'journal.md', 'runs',
  'mr-target-branch.txt', 'requirements.md', 'design.md', 'plan.md', 'review.md', 'team',
  'tasks.md', 'decisions.md', 'knowledge.md', '.claude', '.claude-memory', '.learnings', '.git'];
const reserved = (name) => RESERVED.some((n) => n.toLowerCase() === name.toLowerCase());

// An epic holds the knowledge and the repositories of one tracker epic; its tasks are ordinary
// task workspaces inside its directory.
const KINDS = ['task', 'process', 'epic'];

// .claude/wsg.json is the single source of truth for the parts wsg generates: the sources and how
// each one is attached. Every `wsg add` re-renders from it the marked blocks of AGENTS.md, CLAUDE.md
// and README.md, the settings, the rules and the pointers. Text that people and agents write — why,
// done, scope, invariants, links — lives only in AGENTS.md, outside the markers: a copy here would
// drift from what the agent actually reads. The ticket too, with one exception: a task of an epic
// keeps the parsed key here, written once by `wsg new`, for the epic's branch templates.
const STATE_FILE = path.join('.claude', 'wsg.json');
// An epic is version 3: wsg 0.4 refuses it instead of taking it for a task.
const STATE_VERSION = 2;
const EPIC_STATE_VERSION = 3;
const stateVersion = (kind) => (kind === 'epic' ? EPIC_STATE_VERSION : STATE_VERSION);

function slugError(slug) {
  if (!slug) return t('validate.required');
  if (!KEBAB.test(slug)) return t('validate.kebab');
  return '';
}

// The wsg- prefix belongs to the generator's own skills (/wsg-setup), so a procedure can't shadow one.
function skillError(name) {
  if (!name) return t('validate.required');
  if (!KEBAB.test(name)) return t('validate.kebab');
  if (name.startsWith('wsg-')) return t('validate.skillPrefix');
  return '';
}

// The kebab rule already rules out separators; the resolved path is checked anyway, so the
// guarantee doesn't hang on a regular expression.
function childPath(dir, slug) {
  const root = path.resolve(dir);
  const ws = path.resolve(root, slug);
  if (path.dirname(ws) !== root) throw new Error(t('workspace.outside', { slug, root }));
  return ws;
}

const wsPath = (slug, cfg) => childPath(cfg.WS_ROOT, slug);

// lstat: a dangling symlink is an entry too.
const entryExists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

// Called by generate before anything is created: the answers may come from a test or a script,
// not only from the CLI, which validates the same things.
// a.epicWs: a task of that epic, placed in its directory — next to the epic's own files and the
// links to its sources, so the slug must not be one of their names.
function assertSafe(a, cfg) {
  if (!KINDS.includes(a.kind)) throw new Error(t('workspace.badKind', { kind: a.kind }));
  const bad = slugError(a.slug);
  if (bad) throw new Error(t('workspace.badSlug', { slug: a.slug, why: bad }));
  const ws = a.epicWs ? childPath(a.epicWs, a.slug) : wsPath(a.slug, cfg);
  if (a.kind === 'process') {
    const badSkill = skillError(a.skillName);
    if (badSkill) throw new Error(t('workspace.badSkill', { name: a.skillName, why: badSkill }));
  }
  if (a.epicWs) {
    if (a.kind !== 'task') throw new Error(t('workspace.epicTaskKind', { kind: a.kind }));
    if (reserved(a.slug)) throw new Error(t('workspace.childReserved', { slug: a.slug }));
    const epic = epicState(a.epicWs);
    if (epic.sources.some((s) => ((s && s.name) || '').toLowerCase() === a.slug.toLowerCase())) {
      throw new Error(t('workspace.childIsSource', { slug: a.slug }));
    }
    if (entryExists(ws)) throw new Error(t('validate.exists', { path: ws }));
    return ws;
  }
  if (fs.existsSync(ws)) throw new Error(t('validate.exists', { path: ws }));
  return ws;
}

const hasState = (dir) => fs.existsSync(path.join(dir, STATE_FILE));
// Workspaces made by wsg 0.1 have ws-kind but no state file.
const hasKind = (dir) => fs.existsSync(path.join(dir, '.claude', 'ws-kind'));

// The nearest directory at or above `start` that is a workspace. A session or a shell is often
// inside one of its worktrees, so the current directory alone is not enough.
// Returns { ws, legacy } or null; legacy: a 0.1 workspace, without the state file.
function find(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (hasState(dir)) return { ws: dir, legacy: false };
    if (hasKind(dir)) return { ws: dir, legacy: true };
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// { preset, roles, pointer? }: roles kebab-case names; pointer: the process skill got its line.
const teamOk = (team) => !!team && typeof team === 'object' && !Array.isArray(team)
  && typeof team.preset === 'string' && KEBAB.test(team.preset)
  && Array.isArray(team.roles) && team.roles.every((r) => typeof r === 'string' && KEBAB.test(r))
  && (team.pointer === undefined || team.pointer === true);

// Exactly these keys: a misspelt one would otherwise pass and be silently ignored.
const shape = (o, keys) => !!o && typeof o === 'object' && !Array.isArray(o)
  && Object.keys(o).sort().join() === [...keys].sort().join();
// A task's link to its epic, which is always the directory above it.
const epicLinkOk = (epic) => shape(epic, ['slug']) && typeof epic.slug === 'string' && KEBAB.test(epic.slug);
// What a task of the epic gets from a source: its branch template, base, carry list, clone flag.
const taskDefaultsOk = (d) => shape(d, ['branch', 'base', 'carry', 'cloneNm'])
  && typeof d.branch === 'string' && typeof d.base === 'string'
  && Array.isArray(d.carry) && d.carry.every((c) => typeof c === 'string')
  && typeof d.cloneNm === 'boolean';

// Why the state can't be used, or ''.
function stateProblem(state) {
  if (!state || typeof state !== 'object' || !KINDS.includes(state.kind)) return `"kind" must be one of ${KINDS.join(', ')}`;
  const version = stateVersion(state.kind);
  if (state.version !== version || !Array.isArray(state.sources)) return `expected version ${version} with a sources list`;
  if (state.epic !== undefined && (state.kind !== 'task' || !epicLinkOk(state.epic))) {
    return '"epic" belongs only to a task, as { "slug": <kebab-case> }';
  }
  if (state.ticket !== undefined && (state.epic === undefined || typeof state.ticket !== 'string' || !state.ticket.trim())) {
    return '"ticket" belongs only to a task of an epic, as a non-empty string';
  }
  // A reference is read, never changed: a task gets no branch of it.
  const i = state.sources.findIndex((s) => s && s.task !== undefined
    && (state.kind !== 'epic' || s.reference === true || !taskDefaultsOk(s.task)));
  if (i !== -1) {
    const name = state.sources[i].name || `#${i + 1}`;
    return `source ${name}: "task" belongs only to an epic source that is not a reference, as { branch, base, carry, cloneNm }`;
  }
  return '';
}

function readState(ws) {
  const file = path.join(ws, STATE_FILE);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(t('workspace.stateInvalid', { file, msg: e.message }));
  }
  const problem = stateProblem(state);
  if (problem) throw new Error(t('workspace.stateInvalid', { file, msg: problem }));
  // `wsg team` writes it, and every render pastes its roles into AGENTS.md and team/workflow.md:
  // a hand edit that breaks it refuses every command, not only `wsg team`.
  if (state.team !== undefined && !teamOk(state.team)) throw new Error(t('team.stateInvalid', { file }));
  return state;
}

const stateJson = (state) => `${JSON.stringify(state, null, 2)}\n`;

// The state of the directory given as an epic; anything else — no state, another kind — is
// refused with one message. A state that doesn't read keeps its own error.
function epicState(epicWs) {
  if (!hasState(epicWs)) throw new Error(t('workspace.notEpic', { ws: epicWs }));
  const state = readState(epicWs);
  if (state.kind !== 'epic') throw new Error(t('workspace.notEpic', { ws: epicWs }));
  return state;
}

// The epic a task belongs to: the directory above it, or null for a task outside an epic.
const epicOf = (ws, state) => (state && state.epic ? path.dirname(path.resolve(ws)) : null);

// The epic's tasks: directories right inside it whose state links them to an epic. Symlinked
// directories are skipped on purpose: those are the links to the epic's sources. A task whose
// state doesn't read is left out — one broken task must not break the epic's commands.
// Returns [{ ws, state, mismatch }] sorted by directory name; mismatch: the task names another
// epic (moved or copied by hand), for check to warn about.
function childrenOf(epicWs) {
  const { slug } = epicState(epicWs);
  const out = [];
  const entries = fs.readdirSync(epicWs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  for (const e of entries) {
    const ws = path.join(epicWs, e.name);
    if (!hasState(ws)) continue;
    let state;
    try { state = readState(ws); } catch { continue; }
    if (state.epic) out.push({ ws, state, mismatch: state.epic.slug !== slug });
  }
  return out;
}

module.exports = {
  KEBAB, RESERVED, KINDS, STATE_FILE, STATE_VERSION, EPIC_STATE_VERSION, stateVersion,
  slugError, skillError, wsPath, childPath, assertSafe, find, hasState, stateProblem, readState, stateJson, epicState, epicOf, childrenOf,
};
