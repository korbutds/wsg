'use strict';

// `wsg archive` and `wsg unarchive`. Archiving frees what a finished task holds on disk — its
// worktrees, and the node_modules and builds inside them — and keeps all that can't be made again:
// the branches (never deleted), the workspace with its notes, memory, rules and knowledge, and the
// sources as they were attached, in the "archive" record of .claude/wsg.json (lib/workspace.js).
// Plan, then apply: everything is checked before the first change, and a worktree that holds anything
// that exists nowhere else — changes, untracked or ignored files, a detached commit — refuses the
// whole archive with nothing touched. git worktree remove runs without --force, and a link is only
// unlinked. An epic takes its tasks with it (the cascade): any task that refuses refuses all; each
// task is then its own transaction, the epic last, so a failure leaves the tasks done so far archived
// and a run again goes on from there. wsg unarchive attaches the sources again on the same branches;
// an epic brings back only the tasks its archive took.

const fs = require('node:fs');
const path = require('node:path');
const G = require('./generate');
const g = require('./git');
const T = require('./templates');
const W = require('./workspace');
const S = require('./source');
const { t } = require('./i18n');

// What goes with a directory: every entry under it, symlinks not followed (a link into a checkout is
// the link itself). { bytes, files }: the apparent size of its files and links, and their number. An
// entry that can't be read is not counted.
function sizeOf(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d); } catch { continue; }
    for (const name of entries) {
      const p = path.join(d, name);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isDirectory()) stack.push(p);
      else {
        bytes += st.size;
        files++;
      }
    }
  }
  return { bytes, files };
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

// Whether dest is a worktree of repo, as wsg made it: its own top level, a .git file, the same
// repository behind it. Anything else (a directory put there by hand, a checkout of its own) is not
// wsg's to remove.
function isWorktreeOf(dest, repo) {
  const st = G.lstat(path.join(dest, '.git'));
  if (!st || !st.isFile()) return false;
  const top = g.gitRun(dest, ['rev-parse', '--show-toplevel']);
  G.interrupted(top);
  if (!top.ok || real(top.stdout.trim()) !== real(dest)) return false;
  const common = (d) => {
    const r = g.gitRun(d, ['rev-parse', '--git-common-dir']);
    G.interrupted(r);
    return r.ok ? real(path.resolve(d, r.stdout.trim())) : null;
  };
  const mine = common(dest);
  return !!mine && mine === common(repo);
}

// One source of a workspace to archive: what goes, and what refuses it. Returns { remove, errors,
// warnings, dirty, ignored, detached }; remove: { name, mode, source, path, branch, sha, present,
// bytes, files, ignored, unpushed } — ignored relative to the worktree, as removeSource takes them.
function planSource(ws, s, opts) {
  const dest = path.join(ws, s.name);
  const remove = {
    name: s.name,
    mode: s.reference ? 'reference' : s.mode,
    source: s.path,
    path: dest,
    branch: s.mode === 'worktree' && s.branch ? s.branch : null,
    sha: null,
    present: false,
    bytes: 0,
    files: 0,
    ignored: [],
    stamp: null,
    unpushed: null,
  };
  const out = { remove, errors: [], warnings: [], dirty: null, ignored: null, detached: null };
  const st = G.lstat(dest);
  // Gone already (deleted by hand): only its entry goes, into the record.
  if (!st) return out;
  remove.present = true;
  if (s.mode !== 'worktree') {
    if (!st.isSymbolicLink()) out.errors.push(t('remove.notLink', { name: s.name }));
    return out;
  }
  if (!st.isDirectory() || !isWorktreeOf(dest, s.path)) {
    out.errors.push(t('archive.notWorktree', { name: s.name, repo: s.path }));
    return out;
  }
  const b = G.worktreeBlockers(dest, s, { deleteIgnored: opts.deleteIgnored });
  remove.branch = b.branch || null;
  remove.ignored = b.ignored;
  remove.stamp = G.ignoredStamp(dest, b.ignored);
  out.errors.push(...b.errors);
  out.warnings.push(...b.notes);
  if (b.dirty.length) out.dirty = b.dirty.map(G.shownChange);
  if (b.ignored.length && !opts.deleteIgnored) out.ignored = b.ignored;
  if (b.detached) out.detached = b.detached;
  const head = g.gitRun(dest, ['rev-parse', '--verify', '-q', 'HEAD']);
  G.interrupted(head);
  remove.sha = head.ok ? head.stdout.trim() : null;
  // Never a refusal: the branch keeps the commits whether they are pushed or not.
  const ahead = G.unpushedOf(dest, s.base);
  remove.unpushed = ahead ? ahead.n : null;
  if (!ahead) out.warnings.push(t('archive.unpushedUnknown', { name: s.name, branch: remove.branch || '?' }));
  else if (ahead.n) out.warnings.push(t('archive.unpushed', { name: s.name, n: ahead.n, ref: ahead.ref, branch: remove.branch || '?' }));
  Object.assign(remove, sizeOf(dest));
  return out;
}

// The state a workspace has once archived. state: as it is on disk now (its sources removed one by
// one, or — in the plan — still there); p: its plan, for the sources as they were and the status
// before; cascade: the epic's tasks its archive took.
// keep: the sources still attached stay in "sources" (the record written before the first removal).
// Archived, the state is version 4 (W.ARCHIVED_STATE_VERSION): an older wsg refuses it.
function archivedState(state, p, cascade = [], keep = false) {
  const sources = p.record;
  const version = W.stateVersion(state.kind, true);
  const attached = keep ? state.sources : [];
  if (state.kind === 'epic') return { ...state, version, sources: attached, archive: { date: p.date, sources, cascade } };
  const { closed: _closed, ...rest } = state;
  return { ...rest, version, status: 'archived', sources: attached, archive: { date: p.date, previous: p.previous, sources, ...(p.byEpic ? { byEpic: true } : {}) } };
}

// The sources as the record keeps them: as they were attached, but a worktree's branch the one checked
// out now — the work is there, and wsg unarchive attaches that one. A detached HEAD keeps the branch
// it was attached on. An archive that stopped half-way keeps the record it wrote.
function recordOf(state, removes) {
  if (state.archive) return state.archive.sources;
  return state.sources.map((s) => {
    const r = removes.find((x) => x.name === s.name);
    return s.mode === 'worktree' && r && r.branch && r.branch !== s.branch ? { ...s, branch: r.branch } : s;
  });
}

// One workspace's own part of an archive: a task, or the epic itself without its tasks.
// opts: { deleteIgnored, byEpic, task } — task: the slug its errors are named by, in an epic's plan.
// already: archived before, nothing to do (an archive run again).
function planOne(ws, state, opts = {}) {
  const p = {
    ws,
    state,
    kind: state.kind,
    slug: path.basename(ws),
    epic: state.epic ? state.epic.slug : null,
    epicWs: state.kind === 'task' && state.epic ? W.epicOf(ws, state) : null,
    // A record with sources still attached is an archive that stopped half-way: it goes on.
    already: state.archive !== undefined && !state.sources.length,
    byEpic: !!opts.byEpic || !!(state.archive && state.archive.byEpic),
    date: W.archivedOn(state) || T.today(),
    previous: state.kind === 'epic' ? null
      : state.archive ? state.archive.previous : { status: W.statusOf(state), closed: W.isDate(state.closed) ? state.closed : null },
    removes: [],
    blockers: { dirty: [], ignored: [], detached: [] },
    errors: [],
    warnings: [],
    tasksMdUpdated: false,
  };
  p.record = state.archive ? state.archive.sources : state.sources;
  if (p.already) return p;
  const task = opts.task || null;
  const tag = (m) => (task ? `${task}: ${m}` : m);
  if (W.statusOf(state) === 'archived' && !state.archive) {
    p.errors.push(tag(t('archive.half')));
    return p;
  }
  state.sources.forEach((s, i) => {
    if (!W.isSource(s) || typeof s.name !== 'string' || !s.name || typeof s.path !== 'string' || !s.path) {
      p.errors.push(tag(t('list.badSource', { n: i + 1, value: JSON.stringify(s) })));
    }
  });
  if (p.errors.length) return p;
  for (const s of state.sources) {
    const r = planSource(ws, s, opts);
    p.removes.push(r.remove);
    p.errors.push(...r.errors.map(tag));
    p.warnings.push(...r.warnings.map(tag));
    const at = { task, source: s.name };
    if (r.dirty) p.blockers.dirty.push({ ...at, changes: r.dirty });
    if (r.ignored) p.blockers.ignored.push({ ...at, files: r.ignored.map((f) => path.join(ws, s.name, f)), stamp: r.remove.stamp });
    if (r.detached) p.blockers.detached.push({ ...at, commit: r.detached });
  }
  p.record = recordOf(state, p.removes);
  // What the render would refuse (a broken marker, a settings.json that does not read): refused here,
  // before anything changes, as add and remove refuse it.
  try {
    const next = archivedState(state, p);
    const drop = state.sources.filter((s) => s.mode === 'link').map((s) => s.path);
    const rendered = G.computeRender(ws, next, null, drop, { fresh: ['archive'] });
    if (p.kind === 'epic') p.tasksMdUpdated = G.changedFiles(rendered).includes('tasks.md');
    if (p.epicWs) p.tasksMdUpdated = G.renderTasks(p.epicWs, W.epicState(p.epicWs), { ws, state: next }).changed;
  } catch (e) {
    if (e && e.name === 'Interrupted') throw e;
    p.errors.push(tag(e.message));
  }
  return p;
}

// The tasks of an epic an archive takes, and so locks: every task directory in it that names it.
const tasksOf = (epicWs) => W.childrenOf(epicWs).filter((c) => !c.mismatch);

// `wsg archive`, planned with nothing changed: the workspace, and for an epic each of its tasks not
// archived on its own before (those keep their record, and the epic's unarchive leaves them as they
// are). Everything that refuses is in errors: one task's refusal refuses the whole epic. opts:
// { deleteIgnored, expectIgnored } — expectIgnored: the normalized list parseExpectIgnored gives, the
// ignored files the owner was shown (expectIgnored()). The caller holds the locks for a real run.
function planArchive(ws, state, opts = {}) {
  const plan = planAll(ws, state, opts);
  return opts.expectIgnored ? expectIgnored(plan, opts.expectIgnored) : plan;
}

function planAll(ws, state, opts) {
  const plan = { ...planOne(ws, state, opts), tasks: [], ignoredChanged: false };
  if (state.kind !== 'epic') return plan;
  // An epic archived already: a task in it that is not (made by hand, by an older wsg) is archived
  // too, and joins the cascade; the ones archived are not listed again.
  for (const name of G.unreadableTasks(ws)) plan.errors.push(t('archive.taskUnreadable', { task: name }));
  for (const c of W.childrenOf(ws)) {
    const slug = path.basename(c.ws);
    if (c.mismatch) {
      plan.errors.push(t('archive.taskOtherEpic', { task: slug, epic: c.state.epic.slug }));
      continue;
    }
    const done = c.state.archive !== undefined && !c.state.sources.length;
    if (done && (!c.state.archive.byEpic || plan.already)) continue;
    const tp = planOne(c.ws, c.state, { ...opts, byEpic: !c.state.archive, task: slug });
    plan.tasks.push(tp);
    plan.errors.push(...tp.errors);
    plan.warnings.push(...tp.warnings);
    for (const k of Object.keys(plan.blockers)) plan.blockers[k].push(...tp.blockers[k]);
  }
  if (plan.tasks.some((tp) => !tp.already)) plan.tasksMdUpdated = true;
  return plan;
}

// The ignored files an archive would delete, in the shape of blockers.ignored whether or not
// --delete-ignored was given: [{task, source, files, stamp}], files absolute, stamp what they hold
// (G.ignoredStamp), a source with none left out; sorted as normalizeIgnored sorts.
function ignoredSeen(plan) {
  return normalizeIgnored([plan, ...plan.tasks].flatMap((p) => p.removes.filter((r) => r.ignored.length).map((r) => ({
    task: p === plan ? null : p.slug,
    source: r.name,
    files: r.ignored.map((f) => path.join(r.path, f)),
    stamp: r.stamp,
  }))));
}

// A blockers.ignored list in one order: by task, then source, each one's files sorted and each
// once; an entry without files left out. compare: every name NFC as well — two lists name the same
// files, holding the same, when their compared forms are equal.
function normalizeIgnored(list, compare = false) {
  const n = (x) => (compare ? G.nfc(x) : x);
  const key = (e) => `${e.task === null ? '' : n(e.task)}\0${n(e.source)}`;
  return list.filter((e) => e.files.length)
    .map((e) => ({ task: e.task === null ? null : n(e.task), source: n(e.source), files: [...new Set(e.files.map(n))].sort(), stamp: e.stamp }))
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

// The text of --expect-ignored: exactly the blockers.ignored array of an earlier
// `wsg archive --dry-run --json` without --delete-ignored — [{task, source, files, stamp}], task a
// string or null, files paths, stamp the hash wsg printed. A leading BOM is dropped, a path named
// twice counts once. Returns it normalized for comparing, or throws an Error saying what is wrong.
function parseExpectIgnored(text) {
  const list = G.parseExpectJson(text);
  const entry = (e) => e !== null && typeof e === 'object' && !Array.isArray(e)
    && Object.keys(e).every((k) => k === 'task' || k === 'source' || k === 'files' || k === 'stamp')
    && (e.task === null || (typeof e.task === 'string' && e.task !== ''))
    && typeof e.source === 'string' && e.source !== ''
    && Array.isArray(e.files) && e.files.every((f) => typeof f === 'string' && f !== '')
    && typeof e.stamp === 'string' && e.stamp !== '';
  if (!Array.isArray(list)) throw new Error(t('expect.bad', { why: t('expect.notArray') }));
  const bad = list.findIndex((e) => !entry(e));
  if (bad >= 0) throw new Error(t('expect.bad', { why: t('expect.badEntry', { n: bad + 1 }) }));
  return normalizeIgnored(list, true);
}

// --expect-ignored: the plan's own ignored files must be exactly those the owner was shown, holding
// what they held then (the stamps equal). An entry for a task this epic's archive took already (a
// run that stopped part of the way) is no difference: that task's files are gone with it. Any other
// difference refuses the plan: ignoredChanged, blockers.ignored the fresh list for the client to
// show and send back, the message listing the files. Equal: each source agrees to its files as they
// were, and the re-checks right before the removal (recheck, removeSource) hold it to that.
// expected: as parseExpectIgnored gives it.
function expectIgnored(plan, expected) {
  const gone = new Set(plan.tasks.filter((tp) => tp.already && tp.byEpic).map((tp) => G.nfc(tp.slug)));
  const want = expected.filter((e) => e.task === null || !gone.has(e.task));
  const seen = ignoredSeen(plan);
  // Something under a listed path that does not read: what it holds can't be checked, so nothing
  // is agreed to — refused, not ignoredChanged (the same list would be refused again).
  const blind = seen.filter((e) => G.unverifiable(e.stamp));
  if (blind.length) {
    for (const e of blind) plan.errors.unshift(t('expect.unverifiable', { name: e.task ? `${e.task}: ${e.source}` : e.source }));
    return plan;
  }
  if (JSON.stringify(normalizeIgnored(seen, true)) !== JSON.stringify(want)) {
    plan.ignoredChanged = true;
    plan.blockers.ignored = seen;
    plan.errors.unshift(changedMessage(seen));
    return plan;
  }
  for (const p of [plan, ...plan.tasks]) {
    for (const r of p.removes) {
      r.agreed = [...r.ignored];
      r.agreedStamp = r.stamp;
    }
  }
  return plan;
}

// The refusal of an --expect-ignored that does not match: the files as they are now.
function changedMessage(seen) {
  const files = seen.flatMap((e) => e.files);
  return t('expect.changed', { list: files.length ? G.shownList(files) : `    ${t('expect.none')}` });
}

// The ignored files as they are now, read again with nothing changed, for a refusal made after the
// plan (ignoredChanged): blockers.ignored to show and send back. null when they can't be read.
function freshIgnored(ws, state, opts = {}) {
  try {
    return ignoredSeen(planArchive(ws, state, { deleteIgnored: opts.deleteIgnored }));
  } catch {
    return null;
  }
}

// Whether a planned archive or unarchive changes anything.
const changes = (plan) => !plan.already || plan.tasks.some((tp) => !tp.already);

// Right before the first removal, each worktree once more: a file made since the plan, a change, a
// commit checked out detached refuses it here, with nothing changed. removeSource checks the ignored
// files of each again right before its own removal too.
function recheck(p, r, opts) {
  if (r.mode !== 'worktree' || !G.lstat(r.path)) return;
  const spec = p.state.sources.find((s) => s.name === r.name);
  const b = G.worktreeBlockers(r.path, spec, { deleteIgnored: true });
  const agreed = new Set(opts.deleteIgnored ? agreedOf(r) : []);
  const appeared = b.ignored.filter((f) => !agreed.has(f));
  const why = [...b.errors];
  if (appeared.length) why.push(t('remove.ignoredAppeared', { name: r.name, list: G.shownList(appeared) }));
  // --expect-ignored: the files agreed to still hold what the owner was shown.
  const changed = !appeared.length && opts.deleteIgnored && r.agreedStamp !== undefined && G.ignoredStamp(r.path, r.agreed) !== r.agreedStamp;
  if (changed) why.push(t('expect.stampChanged', { name: r.name, list: G.shownList(r.agreed) }));
  if (why.length) throw Object.assign(new Error(why.join('\n')), { invalid: true, ...(appeared.length || changed ? { ignoredChanged: true } : {}) });
}

// The ignored files of a source the owner agreed to lose: the --expect-ignored ones when given
// (expectIgnored), else the plan's.
const agreedOf = (r) => r.agreed || r.ignored;

// One workspace archived, in one transaction: its sources removed (worktrees without --force, links
// unlinked, the rules kept), the state with the record, the archive block, and — a task of an epic —
// the epic's tasks.md. A failure or a stop signal puts all of it back. Returns { tasksMdUpdated }.
function archiveOne(p, cfg, opts) {
  return G.guarded((txn) => {
    for (const r of p.removes) recheck(p, r, opts);
    // The record first, every source in it, before anything is removed: a run killed half-way leaves
    // a state that says what was there (W.archiveWarnings), and wsg archive or unarchive goes on from it.
    const j0 = G.journal();
    txn.add(() => G.restore(p.ws, j0));
    const first = G.computeRender(p.ws, archivedState(W.readState(p.ws), p, [], true), null, [], { fresh: ['archive'] });
    G.applyRender(p.ws, { ...first, warnings: [] }, j0);
    for (const r of p.removes) {
      G.removeSource(p.ws, r.name, cfg, txn, {
        deleteIgnored: !!opts.deleteIgnored, ignored: agreedOf(r), keepRule: true, ...(r.agreedStamp !== undefined ? { ignoredStamp: r.agreedStamp } : {}),
      });
    }
    const j = G.journal();
    txn.add(() => G.restore(p.ws, j));
    // A kept rule that names a branch the work is no longer on: rewritten with the branch the record
    // has, if it is wsg's own text as written; edited by hand, it stays (the archive block names it).
    for (const s of p.state.sources) {
      const rec = p.record.find((x) => x.name === s.name);
      if (s.mode !== 'worktree' || !rec || rec.branch === s.branch) continue;
      const rel = path.join('.claude', 'rules', `${s.name}.md`);
      if (G.readOwned(p.ws, rel) === T.ruleMd(s, { epic: p.kind === 'epic' })) G.writeOwned(p.ws, rel, T.ruleMd(rec, { epic: p.kind === 'epic' }), j);
    }
    const disk = W.readState(p.ws);
    const cascade = p.kind === 'epic'
      ? tasksOf(p.ws).filter((c) => c.state.archive && c.state.archive.byEpic).map((c) => path.basename(c.ws)) : [];
    const rendered = G.computeRender(p.ws, archivedState(disk, p, cascade), null, [], { fresh: ['archive'] });
    G.applyRender(p.ws, rendered, j);
    let tasksMdUpdated = p.kind === 'epic' && G.changedFiles(rendered).includes('tasks.md');
    if (p.epicWs) {
      const je = G.journal();
      txn.add(() => G.restore(p.epicWs, je));
      const r = G.renderTasks(p.epicWs, W.epicState(p.epicWs));
      if (r.changed) G.writeOwned(p.epicWs, 'tasks.md', r.body, je);
      tasksMdUpdated = r.changed;
    }
    return { tasksMdUpdated };
  }, t('archive.rollingBack', { ws: p.ws }));
}

// The planned archive, applied: an epic's tasks first, each in its own transaction, then the epic.
// opts: { deleteIgnored, stop() } — stop: true once a stop signal came, checked between two tasks.
// A failure in a task rolls back that task only and stops: the error carries failedTask and done,
// the tasks this run archived, which stay archived — a run again takes the rest. Returns
// { tasksMdUpdated, done }.
async function applyArchive(plan, cfg, opts = {}) {
  const done = [];
  let tasksMdUpdated = false;
  for (const tp of plan.tasks) {
    if (tp.already) continue;
    if (opts.stop && opts.stop()) throw Object.assign(g.interruptedError(), { rollback: 'none', done, partial: true });
    try {
      const r = await archiveOne(tp, cfg, opts);
      tasksMdUpdated = tasksMdUpdated || r.tasksMdUpdated;
    } catch (e) {
      throw Object.assign(e, { failedTask: tp.slug, done, partial: done.length > 0 });
    }
    done.push(tp.slug);
  }
  if (!plan.already || (plan.kind === 'epic' && done.length)) {
    if (opts.stop && opts.stop()) throw Object.assign(g.interruptedError(), { rollback: 'none', done, partial: done.length > 0 });
    try {
      const r = await (plan.already ? joinCascade(plan) : archiveOne(plan, cfg, opts));
      tasksMdUpdated = tasksMdUpdated || r.tasksMdUpdated;
    } catch (e) {
      throw Object.assign(e, { done, partial: done.length > 0 });
    }
  }
  return { tasksMdUpdated, done };
}

// An epic archived already, after tasks in it were archived now: they join its cascade, so its
// unarchive brings them back too. Its tasks.md is rendered with them.
function joinCascade(plan) {
  return G.guarded((txn) => {
    const j = G.journal();
    txn.add(() => G.restore(plan.ws, j));
    const disk = W.readState(plan.ws);
    const cascade = tasksOf(plan.ws).filter((c) => c.state.archive && c.state.archive.byEpic).map((c) => path.basename(c.ws));
    const rendered = G.computeRender(plan.ws, { ...disk, archive: { ...disk.archive, cascade } }, null);
    G.applyRender(plan.ws, rendered, j);
    return { tasksMdUpdated: G.changedFiles(rendered).includes('tasks.md') };
  }, t('archive.rollingBack', { ws: plan.ws }));
}

const there = (p) => (G.lstat(p) ? p : null);
const rulesIn = (ws) => {
  try {
    return fs.readdirSync(path.join(ws, '.claude', 'rules')).filter((f) => f.endsWith('.md')).sort().map((f) => path.join(ws, '.claude', 'rules', f));
  } catch {
    return [];
  }
};
const removesOut = (p) => p.removes.map((r) => ({
  name: r.name,
  mode: r.mode,
  source: r.source,
  path: r.path,
  branch: r.branch,
  sha: r.sha,
  bytes: r.bytes,
  files: r.files,
  ignored: r.ignored.map((f) => path.join(r.path, f)),
  unpushed: r.unpushed,
}));
// The branches a workspace keeps: those of its worktrees, as planned — or, archived before, as its
// record has them.
const branchesOf = (p, task) => (p.already
  ? p.state.archive.sources.filter((s) => s.mode === 'worktree' && s.branch).map((s) => ({ task, name: s.name, repo: s.path, branch: s.branch, sha: null }))
  : p.removes.filter((r) => r.mode === 'worktree' && r.branch).map((r) => ({ task, name: r.name, repo: r.source, branch: r.branch, sha: r.sha })));
const total = (p, k) => p.removes.reduce((n, r) => n + r[k], 0);

// The result --json gives, plan or done: every key always there, the paths absolute
// (docs/json-contract.md). done: what applyArchive returned.
function archiveResult(plan, o = {}) {
  const all = [plan, ...plan.tasks];
  return {
    workspace: plan.ws,
    kind: plan.kind,
    slug: plan.slug,
    epic: plan.epic,
    status: plan.kind === 'epic' ? null : 'archived',
    previous: plan.previous,
    archived: plan.date,
    changed: changes(plan),
    deleteIgnored: !!o.deleteIgnored,
    ignoredChanged: !!(plan.ignoredChanged || o.ignoredChanged),
    removes: removesOut(plan),
    keeps: {
      folder: plan.ws,
      notes: there(path.join(plan.ws, 'notes.md')),
      memory: there(path.join(plan.ws, '.claude-memory')),
      rules: rulesIn(plan.ws),
      context: plan.kind === 'epic' ? there(path.join(plan.ws, 'context')) : null,
      branches: all.flatMap((p) => branchesOf(p, p === plan ? null : p.slug)),
    },
    blockers: o.freshIgnored ? { ...plan.blockers, ignored: o.freshIgnored } : plan.blockers,
    tasks: plan.tasks.map((tp) => ({
      task: tp.slug,
      workspace: tp.ws,
      status: 'archived',
      previous: tp.previous,
      changed: !tp.already,
      removes: removesOut(tp),
      bytes: total(tp, 'bytes'),
      files: total(tp, 'files'),
    })),
    bytes: all.reduce((n, p) => n + total(p, 'bytes'), 0),
    files: all.reduce((n, p) => n + total(p, 'files'), 0),
    tasksMdUpdated: o.done ? o.done.tasksMdUpdated : plan.tasksMdUpdated,
  };
}


// --- wsg unarchive

// The state a workspace has back, once every source is attached again: the status and the closing
// date it had before, no record, the version of a state not archived.
function restoredState(state) {
  const { archive: a, ...rest } = state;
  const version = W.stateVersion(state.kind);
  if (state.kind === 'epic') return { ...rest, version };
  const { closed: _closed, ...open } = rest;
  return { ...open, version, status: a.previous.status, ...(a.previous.closed ? { closed: a.previous.closed } : {}) };
}

// Whether a source is in the workspace as wsg attaches it: its worktree of that repository, or its
// link to that path. A state that lists a source is not enough: a run killed half-way may have left
// it listed and gone, or there and not listed.
function isLive(ws, s) {
  const dest = path.join(ws, s.name);
  const st = G.lstat(dest);
  if (!st) return false;
  if (s.mode === 'worktree') return st.isDirectory() && isWorktreeOf(dest, s.path);
  return st.isSymbolicLink() && fs.readlinkSync(dest) === s.path;
}

// A source attached by a run killed before it wrote the state (git worktree add done, the state not
// yet): adopted as it is when it is the link, or the worktree on the branch the record names.
function isAdoptable(ws, s) {
  if (!isLive(ws, s)) return false;
  return s.mode !== 'worktree' || g.git(path.join(ws, s.name), ['branch', '--show-current']) === s.branch;
}

// One workspace's own part of an unarchive: each source of its record must come back as it was —
// the checkout still there, a worktree's branch still there and checked out nowhere else, the name
// free in the workspace — or nothing is changed. opts.task: the slug its errors are named by.
// already: not archived, nothing to do.
function planUnarchiveOne(ws, state, opts = {}) {
  const a = state.archive;
  const p = {
    ws,
    state,
    kind: state.kind,
    slug: path.basename(ws),
    epic: state.epic ? state.epic.slug : null,
    epicWs: state.kind === 'task' && state.epic ? W.epicOf(ws, state) : null,
    already: a === undefined,
    date: W.archivedOn(state),
    restores: [],
    errors: [],
    warnings: [],
    tasksMdUpdated: false,
  };
  const task = opts.task || null;
  const tag = (m) => (task ? `${task}: ${m}` : m);
  if (p.already) {
    if (W.statusOf(state) === 'archived') p.errors.push(tag(t('archive.half')));
    return p;
  }
  // An unarchive that stopped half-way: the sources still attached stay as they are; one the state
  // lists but the workspace no longer has is attached again; one there but not listed, adopted.
  const live = state.sources.filter((s) => W.isSource(s) && isLive(ws, s));
  const attached = new Set(live.map((s) => s.name));
  const stale = state.sources.filter((s) => W.isSource(s) && !attached.has(s.name)).map((s) => s.name);
  if (stale.length) p.warnings.push(tag(t('unarchive.stale', { list: stale.join(', ') })));
  for (const s of a.sources) {
    const dest = path.join(ws, s.name);
    p.restores.push({ name: s.name, mode: s.reference ? 'reference' : s.mode, source: s.path, path: dest, branch: s.mode === 'worktree' && s.branch ? s.branch : null });
    if (attached.has(s.name)) continue;
    if (isAdoptable(ws, s)) {
      attached.add(s.name);
      live.push(s);
      continue;
    }
    // Only the repo pointer may stand where a source named repo goes: attachSource replaces it.
    if (G.lstat(dest) && !S.isRepoPointer(ws, s.name)) p.errors.push(tag(t('unarchive.taken', { name: s.name, path: dest })));
    if (!fs.existsSync(s.path)) {
      p.errors.push(tag(t('unarchive.pathGone', { name: s.name, path: s.path })));
      continue;
    }
    if (s.mode !== 'worktree') continue;
    if (!g.isRepoRoot(s.path)) {
      p.errors.push(tag(t('unarchive.notRepo', { name: s.name, path: s.path })));
      continue;
    }
    const exists = s.branch ? g.gitRun(s.path, ['show-ref', '--verify', '--quiet', `refs/heads/${s.branch}`]) : { ok: false };
    if (exists.signal) G.interrupted(exists);
    if (!exists.ok) p.errors.push(tag(t('unarchive.branchGone', { name: s.name, branch: s.branch || '?', path: s.path })));
    else if (g.worktreeBranches(s.path).includes(s.branch)) p.errors.push(tag(t('unarchive.branchBusy', { name: s.name, branch: s.branch, path: s.path })));
  }
  try {
    for (const s of a.sources) G.readOwned(ws, path.join('.claude', 'rules', `${s.name}.md`));
    const next = { ...restoredState(state), sources: [...live, ...a.sources.filter((s) => !attached.has(s.name))] };
    G.computeRender(ws, next, null);
    if (p.epicWs) p.tasksMdUpdated = G.renderTasks(p.epicWs, W.epicState(p.epicWs), { ws, state: next }).changed;
  } catch (e) {
    if (e && e.name === 'Interrupted') throw e;
    p.errors.push(tag(e.message));
  }
  return p;
}

// `wsg unarchive`, planned with nothing changed: the workspace, and for an epic the tasks its archive
// took (archive.cascade) that are still archived by it — a task archived on its own, or brought back
// since, is left as it is. One that can't come back refuses all. The caller holds the locks.
function planUnarchive(ws, state) {
  const plan = { ...planUnarchiveOne(ws, state), tasks: [] };
  // A task of an archived epic comes back with its epic, never alone: its epic's links are gone.
  if (state.kind === 'task' && state.epic && !plan.already) {
    let epic = null;
    try { epic = W.epicState(W.epicOf(ws, state)); } catch { /* the render check says what is wrong */ }
    if (epic && epic.archive) plan.errors.unshift(t('unarchive.epicArchived', { epic: state.epic.slug }));
  }
  if (state.kind !== 'epic' || plan.already) return plan;
  for (const slug of state.archive.cascade) {
    const dir = path.join(ws, slug);
    let st;
    try {
      st = W.hasState(dir) ? W.readState(dir) : null;
    } catch (e) {
      plan.errors.push(`${slug}: ${e.message}`);
      continue;
    }
    if (!st) {
      plan.warnings.push(t('unarchive.cascadeGone', { task: slug }));
      continue;
    }
    if (!st.archive || !st.archive.byEpic) continue;
    const tp = planUnarchiveOne(dir, st, { task: slug });
    plan.tasks.push(tp);
    plan.errors.push(...tp.errors);
    plan.warnings.push(...tp.warnings);
  }
  if (plan.tasks.length) plan.tasksMdUpdated = true;
  return plan;
}

// One workspace brought back, in one transaction: each source attached again (a worktree on its
// branch as it is, a kept rule adopted as it is), then the state without the record, with the status
// it had, the archive block out, and — a task of an epic — the epic's tasks.md. A failure or a stop
// signal puts all of it back: the worktrees made are removed again, the branches stay.
function unarchiveOne(p, cfg) {
  return G.guarded((txn) => {
    const j = G.journal();
    txn.add(() => G.restore(p.ws, j));
    const disk = W.readState(p.ws);
    const tasksBefore = p.kind === 'epic' ? G.readOwned(p.ws, 'tasks.md') : null;
    // What a run killed half-way left: listed and gone — dropped, attached again below; there and not
    // listed — adopted, with its rule if the archive did not keep one.
    const live = disk.sources.filter((s) => W.isSource(s) && isLive(p.ws, s));
    const adopt = disk.archive.sources.filter((s) => !live.some((x) => x.name === s.name) && isAdoptable(p.ws, s));
    if (live.length !== disk.sources.length || adopt.length) {
      for (const s of adopt) {
        const rel = path.join('.claude', 'rules', `${s.name}.md`);
        if (G.readOwned(p.ws, rel) === null) G.writeOwned(p.ws, rel, T.ruleMd(s, { epic: p.kind === 'epic', noCode: !!disk.noCode }), j);
      }
      const fixed = G.computeRender(p.ws, { ...disk, sources: [...live, ...adopt] }, null);
      G.applyRender(p.ws, { ...fixed, warnings: [] }, j);
    }
    const attached = new Set([...live, ...adopt].map((s) => s.name));
    for (const s of disk.archive.sources) {
      if (attached.has(s.name)) continue;
      const spec = { ...s, carry: [...(s.carry || [])], ...(s.mode === 'worktree' ? { start: 'attach' } : {}) };
      G.attachSource(p.ws, spec, cfg, txn, { adoptRule: true });
    }
    // Every source back: only now the record goes, so a run killed half-way still has it.
    const rendered = G.computeRender(p.ws, restoredState(W.readState(p.ws)), null);
    G.applyRender(p.ws, rendered, j);
    let tasksMdUpdated = p.kind === 'epic' && G.readOwned(p.ws, 'tasks.md') !== tasksBefore;
    if (p.epicWs) {
      const je = G.journal();
      txn.add(() => G.restore(p.epicWs, je));
      const r = G.renderTasks(p.epicWs, W.epicState(p.epicWs));
      if (r.changed) G.writeOwned(p.epicWs, 'tasks.md', r.body, je);
      tasksMdUpdated = r.changed;
    }
    return { tasksMdUpdated };
  }, t('unarchive.rollingBack', { ws: p.ws }));
}

// The planned unarchive, applied: the epic's tasks first, each in its own transaction, then the epic,
// which keeps its record — the cascade — until the last task is back: a failure rolls back that task
// only and stops, the ones before it stay unarchived, and a run again goes on. opts.stop() as in
// applyArchive. Returns { tasksMdUpdated, done }.
async function applyUnarchive(plan, cfg, opts = {}) {
  const done = [];
  let tasksMdUpdated = false;
  for (const tp of plan.tasks) {
    if (opts.stop && opts.stop()) throw Object.assign(g.interruptedError(), { rollback: 'none', done, partial: done.length > 0 });
    try {
      const r = await unarchiveOne(tp, cfg);
      tasksMdUpdated = tasksMdUpdated || r.tasksMdUpdated;
    } catch (e) {
      throw Object.assign(e, { failedTask: tp.slug, done, partial: done.length > 0 });
    }
    done.push(tp.slug);
  }
  if (!plan.already) {
    if (opts.stop && opts.stop()) throw Object.assign(g.interruptedError(), { rollback: 'none', done, partial: done.length > 0 });
    try {
      const r = await unarchiveOne(plan, cfg);
      tasksMdUpdated = tasksMdUpdated || r.tasksMdUpdated;
    } catch (e) {
      throw Object.assign(e, { done, partial: done.length > 0 });
    }
  }
  return { tasksMdUpdated, done };
}

// The status a workspace has after the unarchive: the one it had before the archive, or — not
// archived — the one it has.
const statusAfter = (p) => (p.kind === 'epic' ? null : p.already ? W.statusOf(p.state) : p.state.archive.previous.status);
const closedAfter = (p) => {
  if (p.kind === 'epic') return null;
  const c = p.already ? p.state.closed : p.state.archive.previous.closed;
  return W.isDate(c) ? c : null;
};

// The result --json gives, plan or done: every key always there, the paths absolute.
function unarchiveResult(plan, o = {}) {
  return {
    workspace: plan.ws,
    kind: plan.kind,
    slug: plan.slug,
    epic: plan.epic,
    status: statusAfter(plan),
    closed: closedAfter(plan),
    archived: plan.date,
    changed: changes(plan),
    restores: plan.restores,
    tasks: plan.tasks.map((tp) => ({
      task: tp.slug, workspace: tp.ws, status: statusAfter(tp), closed: closedAfter(tp), changed: !tp.already, restores: tp.restores,
    })),
    tasksMdUpdated: o.done ? o.done.tasksMdUpdated : plan.tasksMdUpdated,
  };
}

module.exports = {
  sizeOf, isWorktreeOf, planArchive, applyArchive, archiveResult, archivedState, changes, tasksOf, parseExpectIgnored, freshIgnored,
  restoredState, planUnarchive, applyUnarchive, unarchiveResult,
};
