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
// tasks.md, decisions.md, knowledge.md and context/ (`wsg context`) for an epic. A task of an epic
// is a directory in it, so its slug can't take these names either.
const RESERVED = ['CLAUDE.md', 'AGENTS.md', 'README.md', 'notes.md', 'SETUP.md', 'journal.md', 'runs',
  'mr-target-branch.txt', 'requirements.md', 'design.md', 'plan.md', 'review.md', 'team',
  'tasks.md', 'decisions.md', 'knowledge.md', 'context', '.claude', '.claude-memory', '.learnings', '.git'];
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
// A task or a process also keeps its status here: "open", "review" or "done", and "closed" with the
// date it became done — only while it is done. `wsg new` writes "open"; a state from an older wsg
// has no status, which reads as open (statusOf). An epic has no status: its tasks do. wsg 0.4 and
// 0.5 keep both keys, since every writer spreads the state it read, so the version stays. A value
// this wsg doesn't know (a status from a later version) never makes the state unreadable: it is a
// warning (statusProblem, shown by wsg check), and the task stays listed in its epic.
const STATE_FILE = path.join('.claude', 'wsg.json');
// An epic is version 3: wsg 0.4 refuses it instead of taking it for a task.
const STATE_VERSION = 2;
const EPIC_STATE_VERSION = 3;
const stateVersion = (kind) => (kind === 'epic' ? EPIC_STATE_VERSION : STATE_VERSION);

const STATUSES = ['open', 'review', 'done'];
// A task's or a process's status as stored, even one this wsg doesn't know; "open" when there is
// none (a state from before it); null for an epic.
const statusOf = (state) => {
  if (state.kind === 'epic') return null;
  return typeof state.status === 'string' && state.status ? state.status : 'open';
};
// How a status reads next to a task's name (wsg list, the epic's tasks.md): nothing for open,
// [review], [done YYYY-MM-DD] — [done] without a valid date. A status this wsg doesn't know shows as
// it is, [blocked], when it is a plain word; anything else (a hand edit with spaces or brackets)
// as [?], so a line of markdown can't be broken by it.
const statusMarker = (status, closed) => {
  if (status === null || status === undefined || status === 'open') return '';
  if (status === 'done') return isDate(closed) ? `[done ${closed}]` : '[done]';
  return typeof status === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(status) ? `[${status}]` : '[?]';
};
// YYYY-MM-DD and a real day: 2026-02-30 is not one.
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;

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
// A workspace of wsg 0.1, without the state file: ws-kind, or — older still — a CLAUDE.md in a
// directory that is not a repository. wsg add and the others refuse it; wsg list shows it.
const isLegacy = (dir) => !hasState(dir)
  && (hasKind(dir) || (fs.existsSync(path.join(dir, 'CLAUDE.md')) && !fs.existsSync(path.join(dir, '.git'))));

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

// An epic's context (`wsg context`): what its tasks may read when they touch the topic, listed in
// the <!-- wsg:epic-context --> block of the epic's and of every task's AGENTS.md. state.context is a
// list of items; the bodies live in <epic>/context/, their paths kept relative to the epic, so the
// epic's directory can move. A file: { id, type: "file", title, description, path: "context/<name>",
// bytes, sha256, binary, copied } — copied: wsg copied it in, so `wsg context remove` deletes it;
// false for one that was in context/ already and was only listed, which a removal only unlists. A
// note: { id, type: "note", title, description, path: "context/notes/<id>.md", bytes, sha256 }. A
// link: { id, type: "link", title, description, url }. bytes and sha256 as the body was written or
// listed: the index renders from the state alone, so an unchanged epic renders the same bytes, and a
// removal or a rewrite can tell a hand edit from what wsg wrote.
const CONTEXT = {
  // Every line of the index is paid on every request of every session of every task.
  textMax: 200,
  idMax: 64,
  fileWarn: 1024 * 1024,
  fileMax: 20 * 1024 * 1024,
  blockWarn: 2048,
  blockMax: 4096,
};
const CONTEXT_TYPES = ['file', 'note', 'link'];
// A title or a description: one line of at most CONTEXT.textMax characters, no control characters.
const oneLine = (s, empty = false) => typeof s === 'string' && (empty || s.trim() !== '') && s === s.trim()
  && [...s].length <= CONTEXT.textMax && !/[\x00-\x1f\x7f]/.test(s);
// The name a copied file keeps in context/: a plain file name, not hidden, not notes/ (the notes' own
// directory). '' when it may be used, else why not.
function contextNameProblem(name) {
  if (typeof name !== 'string' || !name || name.includes('/') || name === '.' || name === '..') return 'not a plain file name';
  if (name.startsWith('.')) return 'a hidden name';
  if (/[\x00-\x1f\x7f]/.test(name)) return 'a control character in the name';
  if (name.toLowerCase() === 'notes') return 'notes is the directory of the notes';
  // Claude Code may load a CLAUDE.md below the session's directory as instructions: a context file
  // is read on demand, never as rules.
  if (/^(claude|agents)(\.local|\.override)?\.md$/i.test(name)) return 'a name agents take for their instructions (CLAUDE.md, AGENTS.md, their .local and .override forms)';
  if (Buffer.byteLength(name) > 255) return 'a name longer than 255 bytes';
  return '';
}
const isUrl = (u) => typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u) && [...u].length <= 2048;
const contextIdOk = (id) => typeof id === 'string' && KEBAB.test(id) && id.length <= CONTEXT.idMax;

// Why an epic's context can't be used, or ''.
function contextProblem(items) {
  if (!Array.isArray(items)) return '"context" must be a list of items';
  const ids = new Set();
  const paths = new Set();
  for (const [i, x] of items.entries()) {
    const at = `context item ${x && typeof x === 'object' && typeof x.id === 'string' ? x.id : `#${i + 1}`}`;
    if (!x || typeof x !== 'object' || Array.isArray(x) || !CONTEXT_TYPES.includes(x.type)) return `${at}: "type" must be one of ${CONTEXT_TYPES.join(', ')}`;
    const keys = x.type === 'file' ? ['id', 'type', 'title', 'description', 'path', 'bytes', 'sha256', 'binary', 'copied']
      : x.type === 'note' ? ['id', 'type', 'title', 'description', 'path', 'bytes', 'sha256'] : ['id', 'type', 'title', 'description', 'url'];
    if (!shape(x, keys)) return `${at}: a ${x.type} has exactly ${keys.join(', ')}`;
    if (!contextIdOk(x.id)) return `${at}: "id" must be kebab-case, at most ${CONTEXT.idMax} characters`;
    if (ids.has(x.id)) return `${at}: the id is used twice`;
    ids.add(x.id);
    if (!oneLine(x.title)) return `${at}: "title" must be one line of at most ${CONTEXT.textMax} characters`;
    if (!oneLine(x.description, true)) return `${at}: "description" must be one line of at most ${CONTEXT.textMax} characters`;
    if (x.type === 'link') {
      if (!isUrl(x.url)) return `${at}: "url" must be an http or https URL`;
      continue;
    }
    if (!Number.isSafeInteger(x.bytes) || x.bytes < 0) return `${at}: "bytes" must be a whole number`;
    if (typeof x.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(x.sha256)) return `${at}: "sha256" must be 64 hex digits`;
    if (x.type === 'note' && x.path !== `context/notes/${x.id}.md`) return `${at}: a note's "path" is context/notes/${x.id}.md`;
    if (x.type === 'file') {
      if (typeof x.binary !== 'boolean') return `${at}: "binary" must be true or false`;
      if (typeof x.copied !== 'boolean') return `${at}: "copied" must be true or false`;
      if (typeof x.path !== 'string' || !x.path.startsWith('context/') || contextNameProblem(x.path.slice(8))) return `${at}: a file's "path" is context/<name>, a plain file name`;
    }
    if (paths.has(x.path.toLowerCase())) return `${at}: the path is used twice`;
    paths.add(x.path.toLowerCase());
  }
  return '';
}

// Why the state can't be used, or ''.
function stateProblem(state) {
  if (!state || typeof state !== 'object' || !KINDS.includes(state.kind)) return `"kind" must be one of ${KINDS.join(', ')}`;
  const version = stateVersion(state.kind);
  if (state.version !== version || !Array.isArray(state.sources)) return `expected version ${version} with a sources list`;
  if (state.epic !== undefined && (state.kind !== 'task' || !epicLinkOk(state.epic))) {
    return '"epic" belongs only to a task, as { "slug": <kebab-case> }';
  }
  if (state.context !== undefined) {
    if (state.kind !== 'epic') return '"context" belongs only to an epic';
    const bad = contextProblem(state.context);
    if (bad) return bad;
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
  // A source a task took from its epic's (S.fromEpic).
  const j = state.sources.findIndex((s) => s && s.from !== undefined && (state.epic === undefined || s.from !== 'epic'));
  if (j !== -1) return `source ${state.sources[j].name || `#${j + 1}`}: "from" belongs only to a source of a task of an epic, as "epic"`;
  return '';
}

// What is wrong with the status of a state that reads, as a warning, or null. Never a reason to
// refuse the state (see STATE_FILE).
function statusProblem(state) {
  if (state.kind === 'epic') {
    return state.status !== undefined || state.closed !== undefined
      ? '"status" and "closed" belong only to a task or a process, not to an epic: ignored' : null;
  }
  if (state.status !== undefined && !STATUSES.includes(state.status)) {
    return `"status" ${JSON.stringify(state.status)} is not one of ${STATUSES.join(', ')}: this wsg doesn't know it`;
  }
  if (state.closed !== undefined && (state.status !== 'done' || !isDate(state.closed))) {
    return '"closed" goes only with "status": "done", as a date YYYY-MM-DD';
  }
  return null;
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

// The directories a session in the workspace reads besides its own: the linked sources, references
// included, in their order. settings.json lists them as additionalDirectories (generate.computeRender,
// templates.settingsJson), so the two can't drift. A task's epic directory is not here: it is the
// parent of the workspace, see epicOf. An entry that is not a source object (a hand edit: null, a
// string) is skipped, so one broken entry can't take wsg list down; wsg list reports it.
const isSource = (s) => !!s && typeof s === 'object' && !Array.isArray(s);
const extraDirs = (state) => state.sources.filter((s) => isSource(s) && s.mode === 'link' && typeof s.path === 'string').map((s) => s.path);

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

// The `## For the epic` section of a task's notes.md holds what the task stages for its epic; the
// epic's closing moves the merged entries out of it into `## Notes`. So entries still in it mean
// "not merged yet". An entry is any non-blank line of the section outside an HTML comment (the
// template's own hint is one). The section runs to the next heading of level 1 or 2; a ### inside
// it counts as an entry. text: the notes as read; true when it has entries.
function forEpicEntries(text) {
  const lines = String(text).replace(/<!--[\s\S]*?(-->|$)/g, (c) => c.replace(/[^\n]/g, '')).split(/\r?\n/);
  const start = lines.findIndex((l) => /^## For the epic\s*$/.test(l.trimEnd()));
  if (start < 0) return false;
  for (let i = start + 1; i < lines.length && !/^#{1,2}\s/.test(lines[i]); i++) {
    if (lines[i].trim()) return true;
  }
  return false;
}

// Whether a task of an epic has entries in `## For the epic` that its epic has not merged: true or
// false; null for anything else (a task outside an epic, a process, an epic). A notes.md that is
// missing or can't be read has none. One file read, no git: wsg list calls it for every task.
function forEpicPending(ws, state) {
  if (!state || state.kind !== 'task' || !state.epic) return null;
  let text;
  try { text = fs.readFileSync(path.join(ws, 'notes.md'), 'utf8'); } catch { return false; }
  return forEpicEntries(text);
}

module.exports = {
  CONTEXT, CONTEXT_TYPES, contextNameProblem, contextIdOk, isUrl, oneLine,
  isDate, isSource, statusMarker, forEpicEntries, forEpicPending,
  KEBAB, RESERVED, KINDS, STATE_FILE, STATE_VERSION, EPIC_STATE_VERSION, stateVersion, STATUSES, statusOf, statusProblem,
  slugError, skillError, wsPath, childPath, assertSafe, find, hasState, isLegacy, stateProblem, readState, stateJson, epicState, epicOf, extraDirs, childrenOf,
};
