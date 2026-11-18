'use strict';

// `wsg list`: every workspace under WS_ROOT, an epic's tasks nested in it. Read-only and without
// git: one state file and, for a task of an epic, its notes.md per workspace, so it stays fast over
// hundreds of them. What a workspace is matches the rest of wsg: a directory right in WS_ROOT (not a
// symlink, not hidden) with .claude/wsg.json, or a 0.1 one (W.isLegacy), as `ws` lists them; a task
// of an epic is a real directory in it with the state file and no .git (a checkout has one), as
// `ws` lists an epic's tasks. A state that doesn't read is listed too, with its problem: a list that
// silently drops a workspace would hide the one that needs attention.

const fs = require('node:fs');
const path = require('node:path');
const W = require('./workspace');
const { sourceResult } = require('./json');
const { t } = require('./i18n');

// The real directories right in dir, by name; hidden ones and symlinks (an epic's links to its
// sources) are not workspaces.
function dirsIn(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
    .map((name) => path.join(dir, name));
}

// What a 0.1 workspace says its kind is: its ws-kind, else a task (as wsg check reads it).
function legacyKind(ws) {
  let kind = 'task';
  try { kind = fs.readFileSync(path.join(ws, '.claude', 'ws-kind'), 'utf8').trim(); } catch { /* the oldest: a task */ }
  return W.KINDS.includes(kind) ? kind : null;
}

const checklistResult = (c) => (c && !c.unreadable ? { done: c.done, total: c.total } : null);

// One workspace, every key always there. epicSlug: the epic it was found in, for a task of one.
function entry(ws, epicSlug = null) {
  const out = {
    slug: path.basename(ws),
    kind: null,
    path: ws,
    title: null,
    ticket: null,
    status: null,
    closed: null,
    archived: null,
    noCode: null,
    spec: null,
    checklist: null,
    forEpicPending: null,
    created: null,
    epic: null,
    legacy: false,
    problems: [],
    extraDirs: [],
    sources: [],
    archivedSources: [],
    tasks: [],
    trackerTasks: [],
  };
  if (!W.hasState(ws)) return { ...out, kind: legacyKind(ws), legacy: true };
  let state;
  try {
    state = W.readState(ws);
  } catch (e) {
    out.problems.push(e.message);
    return out;
  }
  const status = W.statusOf(state);
  const checklist = W.checklistOf(ws, state);
  Object.assign(out, {
    kind: state.kind,
    title: typeof state.title === 'string' && state.title ? state.title : null,
    ticket: state.ticket || null,
    status,
    closed: status === 'done' && W.isDate(state.closed) ? state.closed : null,
    // The date wsg archive took it (an epic too); its sources are then in archivedSources, as they
    // were attached, and sources is empty.
    archived: W.archivedOn(state),
    // A task made with wsg new --no-code: true; false for any other readable workspace.
    noCode: state.noCode === true,
    // A task made with wsg new --spec (spec.md, plan.md, the Stages section): true; else false.
    spec: state.spec === true,
    // A task's checklist.md as counted: { done, total }; null without one (made before wsg 0.8) or
    // for anything but a task.
    checklist: checklistResult(checklist),
    forEpicPending: W.forEpicPending(ws, state),
    created: typeof state.created === 'string' && state.created ? state.created : null,
    epic: state.epic ? state.epic.slug : null,
    // The epic's directory first for a task of one found in an epic: the session reads it as well
    // as its links. A task that names an epic but sits at the top has none to read.
    extraDirs: [...(state.epic && epicSlug !== null ? [W.epicOf(ws, state)] : []), ...W.extraDirs(state)],
    // An entry that is not a source object is left out, and said: one broken entry, not the list.
    sources: state.sources.filter(W.isSource).map((s) => sourceResult(ws, s)),
    archivedSources: state.archive ? state.archive.sources.map((s) => sourceResult(ws, s)) : [],
  });
  const problem = W.statusProblem(state);
  if (problem) out.problems.push(problem);
  if (checklist && checklist.unreadable) out.problems.push(t('list.checklistUnreadable', { why: checklist.unreadable }));
  state.sources.forEach((s, i) => { if (!W.isSource(s)) out.problems.push(t('list.badSource', { n: i + 1, value: JSON.stringify(s) })); });
  if (epicSlug !== null) {
    if (!state.epic) out.problems.push(t('list.notEpicTask', { epic: epicSlug }));
    else if (state.epic.slug !== epicSlug) out.problems.push(t('list.otherEpic', { epic: state.epic.slug }));
  } else if (state.epic) out.problems.push(t('list.orphanTask', { epic: state.epic.slug }));
  if (state.kind === 'epic' && epicSlug === null) {
    // In the epic's order (wsg reorder), as its tasks.md block lists them.
    const dirs = dirsIn(ws).filter((d) => W.hasState(d) && !fs.existsSync(path.join(d, '.git')));
    out.tasks = W.byTaskOrder(dirs, state.taskOrder, (d) => path.basename(d)).map((d) => entry(d, out.slug));
    out.trackerTasks = trackerTasksOf(ws);
  }
  return out;
}

// The tracker tasks of an epic: the list items under "## Other tasks" in its tasks.md, in their order
// (lib/reorder.js). A tasks.md that is missing, can't be read or is a link has none.
function trackerTasksOf(ws) {
  const p = path.join(ws, 'tasks.md');
  try {
    if (!fs.lstatSync(p).isFile()) return [];
    return require('./reorder').trackerTasks(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

// Every workspace in wsRoot: the roots — epics, tasks and processes — each epic with its tasks.
// A WS_ROOT that doesn't exist yet has none.
function collect(wsRoot) {
  return dirsIn(wsRoot).filter((d) => W.hasState(d) || W.isLegacy(d)).map((d) => entry(d));
}

// The plain tree: a line per workspace, an epic's tasks indented under it, each problem under its
// workspace. Returns the text.
function render(workspaces, wsRoot) {
  if (!workspaces.length) return `${t('list.empty', { root: wsRoot })}\n`;
  const out = [];
  const line = (w, indent) => {
    const parts = [w.slug];
    if (w.legacy) parts.push(t('list.legacy'));
    else if (w.kind === null) parts.push(t('list.unreadable'));
    else {
      if (w.kind !== 'task') parts.push(`(${w.kind})`);
      const marker = w.archived ? W.statusMarker('archived', w.archived) : W.statusMarker(w.status, w.closed);
      if (marker) parts.push(marker);
      if (w.ticket) parts.push(w.ticket);
      if (w.title && w.title !== w.slug) parts.push(`— ${w.title}`);
      if (w.status === 'done' && w.forEpicPending) parts.push(t('list.forEpicPending'));
    }
    out.push(`${indent}${parts.join(' ')}`);
    for (const p of w.problems) out.push(`${indent}  ! ${p}`);
    for (const c of w.tasks) line(c, `${indent}  `);
  };
  for (const w of workspaces) line(w, '');
  return `${out.join('\n')}\n`;
}

module.exports = { collect, render, entry };
