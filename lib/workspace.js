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
// requirements.md, design.md, plan.md, review.md and team/ are kept free for the team workflow.
const RESERVED = ['CLAUDE.md', 'AGENTS.md', 'README.md', 'notes.md', 'SETUP.md', 'journal.md', 'runs',
  'mr-target-branch.txt', 'requirements.md', 'design.md', 'plan.md', 'review.md', 'team',
  '.claude', '.claude-memory', '.learnings', '.git'];

// .claude/wsg.json is the single source of truth for the parts wsg generates: the sources and how
// each one is attached. Every `wsg add` re-renders from it the marked blocks of AGENTS.md, CLAUDE.md
// and README.md, the settings, the rules and the pointers. Text that people and agents write — why,
// done, scope, invariants, links, the ticket — lives only in AGENTS.md, outside the markers: a copy
// here would drift from what the agent actually reads.
const STATE_FILE = path.join('.claude', 'wsg.json');
const STATE_VERSION = 2;

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
function wsPath(slug, cfg) {
  const root = path.resolve(cfg.WS_ROOT);
  const ws = path.resolve(root, slug);
  if (path.dirname(ws) !== root) throw new Error(t('workspace.outside', { slug, root }));
  return ws;
}

// Called by generate before anything is created: the answers may come from a test or a script,
// not only from the CLI, which validates the same things.
function assertSafe(a, cfg) {
  const bad = slugError(a.slug);
  if (bad) throw new Error(t('workspace.badSlug', { slug: a.slug, why: bad }));
  const ws = wsPath(a.slug, cfg);
  if (a.kind === 'process') {
    const badSkill = skillError(a.skillName);
    if (badSkill) throw new Error(t('workspace.badSkill', { name: a.skillName, why: badSkill }));
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

function readState(ws) {
  const file = path.join(ws, STATE_FILE);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(t('workspace.stateInvalid', { file, msg: e.message }));
  }
  if (!state || state.version !== STATE_VERSION || !Array.isArray(state.sources)) {
    throw new Error(t('workspace.stateInvalid', { file, msg: `expected version ${STATE_VERSION} with a sources list` }));
  }
  // `wsg team` writes it, and every render pastes its roles into AGENTS.md and team/workflow.md:
  // a hand edit that breaks it refuses every command, not only `wsg team`.
  if (state.team !== undefined && !teamOk(state.team)) throw new Error(t('team.stateInvalid', { file }));
  return state;
}

const stateJson = (state) => `${JSON.stringify(state, null, 2)}\n`;

module.exports = {
  KEBAB, RESERVED, STATE_FILE, STATE_VERSION,
  slugError, skillError, wsPath, assertSafe, find, hasState, readState, stateJson,
};
