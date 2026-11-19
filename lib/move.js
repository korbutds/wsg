'use strict';

// `wsg move`: a task into an epic, into another epic, or out of its epic to WS_ROOT. The task's
// directory moves whole, in one rename — notes, memory, learnings and rules byte for byte, the
// worktrees with all they hold, branches untouched — and what names the old place is put right:
// each worktree's link with its repository (the two files git keeps, each in the form git wrote it,
// absolute or relative), autoMemoryDirectory in .claude/settings.json and the `wsg check` line of
// README.md when they are wsg's own text, the state (its epic, "moved"), the generated blocks, and
// the tasks.md of both epics. A process or an epic never moves; an archived task neither.
// Plan, then apply: everything is checked with nothing changed, and the apply is one transaction
// (generate.guarded) — a failure or a stop signal renames the directory back and puts every file
// as it was. wsg never touches ~/.claude: Claude Code keeps sessions by directory; the state lists
// the old directories ("moved").

const fs = require('node:fs');
const path = require('node:path');
const G = require('./generate');
const g = require('./git');
const T = require('./templates');
const W = require('./workspace');
const S = require('./source');
const ui = require('./ui');
const { t } = require('./i18n');

const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const same = (a, b) => {
  const x = real(a);
  return x !== null && x === real(b);
};

// The blocks a task gets into an epic, put in on purpose: no "restored" warning.
const EPIC_BLOCKS = ['epic', 'epic-rules', 'epic-context'];

// How a worktree is tied to its repository: <dest>/.git, "gitdir: <admin>", and <admin>/gitdir, the
// path of <dest>/.git — each absolute or relative, as git wrote it (worktree.useRelativePaths).
// null when either does not read as such. locked: git keeps the worktree locked (its reason, or '').
function worktreeLink(dest) {
  const gitfile = path.join(dest, '.git');
  const st = G.lstat(gitfile);
  if (!st || !st.isFile()) return null;
  let text;
  let back;
  try {
    text = fs.readFileSync(gitfile, 'utf8');
    const m = /^gitdir: (.+?)\r?\n?$/.exec(text);
    if (!m) return null;
    const admin = path.resolve(dest, m[1]);
    back = fs.readFileSync(path.join(admin, 'gitdir'), 'utf8');
    let locked = null;
    try { locked = fs.readFileSync(path.join(admin, 'locked'), 'utf8').trim(); } catch { /* not locked */ }
    return {
      admin,
      gitfileRelative: !path.isAbsolute(m[1]),
      backRelative: !path.isAbsolute(back.trim()),
      backPath: path.resolve(admin, back.trim()),
      locked,
    };
  } catch {
    return null;
  }
}

// The two files of a worktree once it is at newDest, in the form each had: a relative path computed
// from the real directories, as git computes it; an absolute .git file stays as it is (it names the
// repository, which does not move). { gitfile: body or null, gitdir: body }.
function linkBodies(link, newDest) {
  const admin = real(link.admin) || link.admin;
  return {
    gitfile: link.gitfileRelative ? `gitdir: ${path.relative(newDest, admin)}\n` : null,
    gitdir: `${link.backRelative ? path.relative(admin, path.join(newDest, '.git')) : path.join(newDest, '.git')}\n`,
  };
}

// settings.json with autoMemoryDirectory's value replaced in place, or null when it is not there
// exactly once as wsg wrote it.
function swapMemory(text, from, to) {
  const value = JSON.stringify(from).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`("autoMemoryDirectory"\\s*:\\s*)${value}`, 'g');
  const hits = text.match(re);
  if (!hits || hits.length !== 1) return null;
  return text.replace(re, (_, key) => `${key}${JSON.stringify(to)}`);
}

// notes.md with the "## For the epic" section a task of an epic is made with: before "## Notes",
// else at the end.
function withForEpic(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^## Notes\s*$/.test(l));
  if (at >= 0) {
    lines.splice(at, 0, ...T.forEpicLines());
    return lines.join('\n');
  }
  return `${text.replace(/\n*$/, '\n')}\n${T.forEpicLines().join('\n')}`;
}

// The tasks.md block of an epic with a task left out of it or added: { body, changed, warnings }, as
// generate.renderTasks gives it. Throws on a block it can't render.
function tasksWith(epicWs, epicState, { without = null, add = null } = {}) {
  const text = G.readOwned(epicWs, 'tasks.md');
  if (text === null) return { body: null, changed: false, warnings: [t('gen.fileMissing', { file: 'tasks.md' })] };
  const children = W.childrenOf(epicWs).filter((c) => path.basename(c.ws) !== without);
  if (add) children.push(add);
  const ordered = W.byTaskOrder(children, epicState.taskOrder, (c) => path.basename(c.ws));
  const r = G.replaceBlock(text, 'tasks.md', 'tasks', T.tasksLines(ordered, epicState.slug), /^# /);
  return { body: r.text, changed: r.text !== text, warnings: r.restored ? [t('gen.markerRestored', { file: 'tasks.md', name: 'tasks' })] : [] };
}

// An entry of the directory that names the same file as name does where names are compared without
// case (APFS, the default on macOS): null when there is none.
function takenIn(dir, name) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return null; }
  const hit = entries.find((e) => e.toLowerCase() === name.toLowerCase());
  return hit === undefined ? null : path.join(dir, hit);
}

// The state with the epic link put where `wsg new --epic` puts it: right after the title.
function withEpic(state, slug) {
  const out = {};
  for (const [k, v] of Object.entries(state)) {
    if (k === 'epic') continue;
    out[k] = v;
    if (k === 'title') out.epic = { slug };
  }
  if (!out.epic) out.epic = { slug };
  return out;
}

const sourceName = (s) => String((s && s.name) || '');
const under = (p, dir) => p.startsWith(dir + path.sep);

// Every directory under dir that holds a .git — a worktree or a submodule (a file), a repository of
// its own (a directory) — symlinks not followed, node_modules and .git directories not entered.
function gitFilesUnder(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name === '.git' && (e.isFile() || e.isDirectory())) out.push(d);
      else if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules') stack.push(path.join(d, e.name));
    }
  }
  return out;
}

// The repository a .git leads to: its common git directory (real), or null.
function commonOf(wt) {
  try {
    if (fs.lstatSync(path.join(wt, '.git')).isDirectory()) return real(path.join(wt, '.git'));
    const m = /^gitdir: (.+?)\r?\n?$/.exec(fs.readFileSync(path.join(wt, '.git'), 'utf8'));
    if (!m) return null;
    const admin = path.resolve(wt, m[1]);
    let common = admin;
    try { common = path.resolve(admin, fs.readFileSync(path.join(admin, 'commondir'), 'utf8').trim()); } catch { /* a git dir of its own */ }
    return real(common);
  } catch {
    return null;
  }
}

// `git worktree list --porcelain` of a repository: [{ path, prunable, main }], the main worktree first.
function worktreesOf(common) {
  const r = g.gitRun(common, ['worktree', 'list', '--porcelain']);
  G.interrupted(r);
  if (!r.ok) return null;
  return r.stdout.split('\n\n').filter((b) => b.trim()).map((b, i) => ({
    path: (/^worktree (.+)$/m.exec(b) || [])[1] || '',
    prunable: /^prunable\b/m.test(b),
    main: i === 0,
  }));
}

// The worktrees under the task that are not its sources, added to the plan to relink as those are:
// found by every repository behind a source or a .git file under the task. One that is broken
// already, or a repository kept inside the task that has worktrees (they would move with it, each
// tied to it by absolute paths), refuses the move.
function nestedWorktrees(p, ws, dest) {
  const repos = new Set();
  for (const w of p.worktrees) {
    const c = commonOf(w.from);
    if (c) repos.add(c);
  }
  // The sources' own, relinked or refused already.
  const known = new Set([...p.worktrees.map((w) => real(w.from)), ...p.blockers.worktrees.map((b) => real(b.path) || b.path)]);
  const broken = (at, repo) => {
    const name = path.relative(ws, at);
    p.blockers.worktrees.push({ name, path: at, repo });
    p.errors.push(t('move.worktreeBroken', { name, path: at, repo }));
  };
  for (const d of gitFilesUnder(ws)) {
    const c = commonOf(d);
    if (c) repos.add(c);
    // A worktree whose repository does not point back at it (moved or copied by hand): its repository
    // does not list it here, and nothing would relink it.
    const at = real(d) || d;
    if (c && !known.has(at) && fs.lstatSync(path.join(d, '.git')).isFile()) {
      const link = worktreeLink(d);
      if (link && fs.existsSync(path.join(link.admin, 'commondir')) && !same(link.backPath, path.join(d, '.git'))) {
        known.add(at);
        // A copy of a worktree another directory holds (its .git file the same): repairing would
        // take the worktree from that one.
        const other = path.dirname(link.backPath);
        const otherLink = G.lstat(link.backPath) ? worktreeLink(other) : null;
        if (otherLink && same(otherLink.admin, link.admin)) {
          const name = path.relative(ws, at);
          p.blockers.worktrees.push({ name, path: at, repo: c });
          p.errors.push(t('move.worktreeCopy', { name, path: at, other }));
        } else broken(at, c);
      }
    }
  }
  for (const common of [...repos].sort()) {
    const list = worktreesOf(common);
    if (!list) continue;
    const linkedOnes = list.filter((x) => !x.main);
    if (under(common, ws) && linkedOnes.length) {
      p.blockers.worktrees.push({ name: path.relative(ws, common), path: common, repo: common });
      p.errors.push(t('move.repoInside', { path: common }));
      continue;
    }
    for (const x of linkedOnes) {
      const at = real(x.path) || x.path;
      if (!under(at, ws) || known.has(at)) continue;
      known.add(at);
      const name = path.relative(ws, at);
      // Registered, its directory gone: nothing to move; git prunes the registration.
      if (x.prunable && !G.lstat(at)) {
        p.warnings.push(t('move.prunableGone', { name, repo: common }));
        continue;
      }
      const link = worktreeLink(at);
      if (x.prunable || !link || !same(link.backPath, path.join(at, '.git'))) {
        broken(at, common);
        continue;
      }
      if (link.locked !== null) p.warnings.push(t('move.worktreeLocked', { name, why: link.locked ? `: ${link.locked}` : '' }));
      const to = path.join(dest, name);
      p.worktrees.push({ name, repo: common, from: at, to, link, relative: link.gitfileRelative || link.backRelative, nested: true });
      p.paths.push({ from: at, to });
    }
  }
}

// The submodules checked out in a worktree: a .git file at a gitlink's path, which git keeps tied to
// the worktree by relative paths a move would break. Their paths, or []. A deinitialized one (its
// git directory left under <admin>/modules) is none: git sets its core.worktree again at the next
// `git submodule update --init`.
function submodulesOf(dest) {
  const out = [];
  for (const entry of g.gitList(dest, ['ls-files', '-s', '-z']).split('\0')) {
    const m = /^160000 \S+ \d\t([\s\S]*)$/.exec(entry);
    const st = m ? G.lstat(path.join(dest, m[1], '.git')) : null;
    if (st && st.isFile()) out.push(m[1]);
  }
  return out;
}

// `wsg move`, planned with nothing changed. ws: the task as it is on disk (a real path); state: its
// state, read under the locks for a real run. want: { out } — out of its epic, to WS_ROOT; or
// { epicWs } — into the epic at epicWs, right in WS_ROOT (a real path, the name as it is on disk).
// cfg: WS_ROOT. Returns the plan: what refuses it in errors, already when the task is where it would
// go (a run again).
function planMove(ws, state, want, cfg) {
  const rootCfg = path.resolve(cfg.WS_ROOT);
  const root = real(rootCfg) || rootCfg;
  const slug = path.basename(ws);
  const name = state.epic ? `${state.epic.slug}/${slug}` : slug;
  const p = {
    ws,
    state,
    kind: state.kind,
    slug,
    name,
    root,
    rootCfg,
    from: { epic: state.epic ? state.epic.slug : null, path: ws },
    to: { epic: null, path: null },
    fromEpicWs: null,
    toEpicWs: null,
    toEpic: null,
    newEpic: false,
    already: false,
    next: null,
    paths: [],
    worktrees: [],
    blockers: { worktrees: [] },
    regenerates: [],
    dropped: [],
    relinked: [],
    ticketDropped: false,
    memory: null,
    readmeLines: [],
    notes: null,
    rules: [],
    tasksMdUpdated: { from: false, to: false },
    errors: [],
    warnings: [],
  };
  const err = (m) => p.errors.push(m);
  if (state.kind !== 'task') {
    err(t(state.kind === 'epic' ? 'move.isEpic' : 'move.isProcess', { ws }));
    return p;
  }
  if (W.isArchived(state)) {
    err(t('move.archived', { name }));
    return p;
  }
  // Where it is: right in WS_ROOT, or in an epic right in it that is the one its state names.
  const parent = path.dirname(ws);
  // A move stopped between the rename and the state (a kill, a power cut): the directory is at the
  // new place, its state says the old one.
  const isEpicDir = (d) => { try { return W.epicState(d).slug === path.basename(d); } catch { return false; } };
  if (!state.epic && path.dirname(parent) === root && isEpicDir(parent)) {
    err(t('move.halfIn', { ws, epic: path.basename(parent) }));
    return p;
  }
  if (state.epic && parent === root) {
    err(t('move.halfOut', { ws, epic: state.epic.slug }));
    return p;
  }
  if (state.epic) {
    let epic = null;
    try {
      epic = W.epicState(parent);
    } catch (e) {
      err(e.message);
      return p;
    }
    if (path.dirname(parent) !== root) {
      err(t('move.outsideRoot', { ws, root }));
      return p;
    }
    if (epic.slug !== state.epic.slug || path.basename(parent) !== state.epic.slug) {
      err(t('move.epicMismatch', { ws, epic: state.epic.slug, dir: parent }));
      return p;
    }
    if (W.isArchived(epic)) {
      err(t('move.epicArchived', { epic: epic.slug }));
      return p;
    }
    p.fromEpicWs = parent;
    p.fromEpic = epic;
  } else if (parent !== root) {
    err(t('move.outsideRoot', { ws, root }));
    return p;
  }

  // Where it goes.
  let dest;
  if (want.out) {
    if (!state.epic) {
      p.already = true;
      p.to = { epic: null, path: ws };
      return p;
    }
    dest = path.join(root, slug);
  } else {
    const epicWs = want.epicWs;
    const epicSlug = path.basename(epicWs);
    const bad = W.slugError(epicSlug);
    if (bad) {
      err(t('workspace.badSlug', { slug: epicSlug, why: bad }));
      return p;
    }
    p.toEpicWs = epicWs;
    p.to.epic = epicSlug;
    let epic;
    try {
      epic = W.epicState(epicWs);
    } catch (e) {
      err(e.message);
      return p;
    }
    if (epic.slug !== epicSlug) {
      err(t('move.epicSlugMismatch', { ws: epicWs, slug: epic.slug }));
      return p;
    }
    if (W.isArchived(epic)) {
      err(t('move.epicArchived', { epic: epic.slug }));
      return p;
    }
    p.toEpic = epic;
    if (p.fromEpicWs && same(p.fromEpicWs, epicWs)) {
      p.already = true;
      p.to.path = ws;
      return p;
    }
    dest = path.join(epicWs, slug);
    // Next to the epic's own files and the links to its sources: none of their names.
    if (W.reserved(slug)) err(t('workspace.childReserved', { slug }));
    if (p.toEpic && p.toEpic.sources.some((s) => sourceName(s).toLowerCase() === slug.toLowerCase())) err(t('workspace.childIsSource', { slug }));
  }
  p.to.path = dest;
  const destParent = path.dirname(dest);
  const taken = G.lstat(dest) ? dest : takenIn(destParent, slug);
  if (taken) err(t('move.taken', { path: taken }));
  // One rename: the same file system, or nothing moves.
  try {
    const here = fs.statSync(ws).dev;
    const there = fs.statSync(fs.existsSync(destParent) ? destParent : root).dev;
    if (here !== there) err(t('move.crossDevice', { from: ws, to: dest }));
  } catch (e) {
    err(e.message);
  }

  // The sources: each worktree relinked at its new place, each taken from the epic kept so or made
  // the task's own.
  const target = p.toEpic;
  state.sources.forEach((s, i) => {
    if (!W.isSource(s) || typeof s.name !== 'string' || !s.name || typeof s.path !== 'string' || !s.path) {
      err(t('list.badSource', { n: i + 1, value: JSON.stringify(s) }));
    }
  });
  if (p.errors.length) return p;
  const archive = require('./archive');
  p.paths.push({ from: ws, to: dest });
  for (const s of state.sources) {
    const at = path.join(ws, s.name);
    const st = G.lstat(at);
    if (s.mode === 'worktree') {
      if (!st) {
        p.warnings.push(t('move.worktreeMissing', { name: s.name, path: at }));
      } else {
        const link = st.isDirectory() ? worktreeLink(at) : null;
        const ok = !!link && same(link.backPath, path.join(at, '.git')) && archive.isWorktreeOf(at, s.path);
        if (!ok) {
          p.blockers.worktrees.push({ name: s.name, path: at, repo: s.path });
          err(t('move.worktreeBroken', { name: s.name, path: at, repo: s.path }));
        } else {
          if (link.locked !== null) p.warnings.push(t('move.worktreeLocked', { name: s.name, why: link.locked ? `: ${link.locked}` : '' }));
          const to = path.join(dest, s.name);
          p.worktrees.push({ name: s.name, repo: s.path, from: at, to, link, relative: link.gitfileRelative || link.backRelative });
          p.paths.push({ from: at, to });
        }
      }
    } else if (st && st.isSymbolicLink() && !path.isAbsolute(fs.readlinkSync(at))) {
      p.warnings.push(t('move.relativeLink', { name: s.name, target: fs.readlinkSync(at) }));
    }
    // A name the target epic has for another directory: its rule would load for this task's.
    const theirs = target ? S.epicSource(target, s.name) : null;
    if (theirs && !same(theirs.path, s.path)) err(t('move.sourceClash', { name: s.name, epic: target.slug, path: theirs.path }));
    // Taken from the epic, as a task made there would have it, when the epic has it; else its own.
    if (theirs && same(theirs.path, s.path)) p.relinked.push(s.name);
    else if (s.from === 'epic') p.dropped.push(s.name);
  }
  // Every other worktree under the task (a Claude Code --worktree inside a source's, one made by
  // hand): git would call it prunable after the rename, and a prune would drop it.
  nestedWorktrees(p, ws, dest);
  // A worktree with a submodule checked out: git keeps the submodule's own links (its .git file,
  // core.worktree) relative to where it is; wsg does not rewrite those.
  for (const w of p.worktrees) {
    const subs = submodulesOf(w.from);
    if (subs.length) {
      p.blockers.worktrees.push({ name: w.name, path: w.from, repo: w.repo });
      err(t('move.submodules', { name: w.name, list: G.shownList(subs) }));
    }
  }
  if (p.errors.length) return p;

  // The state it will have.
  const sources = state.sources.map((s) => {
    if (p.relinked.includes(s.name) && s.from !== 'epic') return { ...s, from: 'epic' };
    if (!p.dropped.includes(s.name)) return s;
    const { from: _from, ...own } = s;
    return own;
  });
  const moved = [...(Array.isArray(state.moved) ? state.moved : []), { from: ws, to: dest, at: T.today() }];
  if (want.out) {
    const { epic: _epic, ticket, ...rest } = state;
    p.ticketDropped = ticket !== undefined;
    p.next = { ...rest, sources, moved };
  } else {
    p.next = { ...withEpic(state, p.to.epic), sources, moved };
  }

  // What names the old place, rewritten only where it is wsg's own text.
  const oldCfg = path.join(rootCfg, path.relative(root, ws));
  const newCfg = path.join(rootCfg, path.relative(root, dest));
  p.cfgPaths = { from: oldCfg, to: newCfg };
  const settingsRel = path.join('.claude', 'settings.json');
  try {
    const text = G.readOwned(ws, settingsRel);
    if (text !== null) {
      let j = null;
      try { j = JSON.parse(text); } catch { /* the render refuses it below */ }
      const was = j && typeof j === 'object' && !Array.isArray(j) ? j.autoMemoryDirectory : undefined;
      const ours = [path.join(oldCfg, '.claude-memory'), path.join(ws, '.claude-memory')];
      // Only the value changes, in place: the rest of the file stays as the owner formatted it.
      const to = path.join(newCfg, '.claude-memory');
      const body = typeof was === 'string' && ours.includes(was) ? swapMemory(text, was, to) : null;
      if (body !== null) p.memory = { from: was, to };
      else if (was !== undefined) p.warnings.push(t('move.memoryKept', { dir: JSON.stringify(was) }));
    }
    const readme = G.readOwned(ws, 'README.md');
    if (readme !== null) {
      const lines = readme.split('\n');
      const swap = (olds, now) => {
        const i = lines.findIndex((l) => olds.includes(l));
        if (i >= 0 && lines[i] !== now) p.readmeLines.push({ from: lines[i], to: now });
      };
      swap([`wsg check ${T.sh(oldCfg)}`, `wsg check ${T.sh(ws)}`], `wsg check ${T.sh(newCfg)}`);
      const kindLine = (epic) => `Workspace kind: **task**${epic ? ` (epic \`${epic}\`)` : ''}.`;
      swap([kindLine(p.from.epic)], kindLine(p.to.epic));
    }
    // Into an epic: notes.md gets the section a task made there has, where it has it.
    if (p.to.epic) {
      const notes = G.readOwned(ws, 'notes.md');
      if (notes !== null && !notes.split(/\r?\n/).some((l) => /^## For the epic\s*$/.test(l))) p.notes = withForEpic(notes);
    }
    // A rule that says whether its source is taken from the epic, when that changes: rewritten if it
    // is as wsg wrote it.
    for (const s of state.sources.filter((x) => p.dropped.includes(x.name) || (p.relinked.includes(x.name) && x.from !== 'epic'))) {
      const rel = path.join('.claude', 'rules', `${s.name}.md`);
      const text = G.readOwned(ws, rel);
      if (text === null) continue;
      const own = sources.find((x) => x.name === s.name);
      if (text === T.ruleMd(s, { noCode: !!state.noCode })) p.rules.push({ rel, body: T.ruleMd(own, { noCode: !!state.noCode }) });
      else p.warnings.push(t(s.from === 'epic' ? 'move.ruleKept' : 'move.ruleKeptOwn', { name: s.name }));
    }

    // The render it will get there, with the epic as it is.
    const known = p.toEpic ? { rules: G.epicRules(p.toEpicWs, p.to.epic), context: G.epicContext(p.toEpicWs, p.to.epic) } : null;
    const rendered = G.computeRender(ws, p.next, null, [], {
      fresh: EPIC_BLOCKS, at: dest, ...(known ? { epicRules: known.rules, epicContext: known.context } : {}),
    });
    p.warnings.push(...rendered.warnings);
    const files = new Set(G.changedFiles(rendered));
    if (p.memory) files.add(settingsRel);
    if (p.notes !== null) files.add('notes.md');
    if (p.readmeLines.length) files.add('README.md');
    for (const r of p.rules) files.add(r.rel);
    p.regenerates.push(...[...files].sort().map((f) => path.join(dest, f)));
    // Both epics' tasks.md.
    if (p.fromEpicWs) {
      const r = tasksWith(p.fromEpicWs, p.fromEpic, { without: slug });
      p.tasksMdUpdated.from = r.changed;
      p.warnings.push(...r.warnings);
      if (r.changed) p.regenerates.push(path.join(p.fromEpicWs, 'tasks.md'));
      if (Array.isArray(p.fromEpic.taskOrder) && p.fromEpic.taskOrder.includes(slug)) p.regenerates.push(path.join(p.fromEpicWs, W.STATE_FILE));
    }
    if (p.toEpic) {
      const r = tasksWith(p.toEpicWs, p.toEpic, { add: { ws: dest, state: p.next, mismatch: false } });
      p.tasksMdUpdated.to = r.changed;
      p.warnings.push(...r.warnings);
      if (r.changed) p.regenerates.push(path.join(p.toEpicWs, 'tasks.md'));
    }
  } catch (e) {
    if (e && e.name === 'Interrupted') throw e;
    err(e.message);
  }

  // Said, never refused.
  if (p.toEpic && !state.noCode) {
    const have = new Set(state.sources.map((x) => sourceName(x).toLowerCase()));
    for (const s of p.toEpic.sources.filter((x) => x && x.task && !have.has(sourceName(x).toLowerCase()))) {
      p.warnings.push(t('move.epicSourceMissing', { name: s.name, task: `${p.to.epic}/${slug}` }));
    }
  }
  const cwd = real(process.cwd());
  if (cwd && (cwd === ws || cwd.startsWith(ws + path.sep))) p.warnings.push(t('move.cwdInside', { path: dest }));
  p.warnings.push(t('move.sessions'));
  return p;
}

// Whether a planned move changes anything.
const changes = (plan) => !plan.already;

// A rename an undo step makes back: never over something that is there.
function renameBack(from, to) {
  if (G.lstat(to)) {
    ui.err(t('move.undoTaken', { from, to }));
    return { failed: 1 };
  }
  if (!G.lstat(from)) {
    ui.err(t('move.undoGone', { path: from }));
    return { failed: 1 };
  }
  fs.renameSync(from, to);
  return undefined;
}

// Whether git sees the worktree at dest as its own and in its repository's list, not prunable.
function linked(w) {
  const top = g.gitRun(w.to, ['rev-parse', '--show-toplevel']);
  G.interrupted(top);
  if (!top.ok || !same(top.stdout.trim(), w.to)) return (top.out || top.stdout || '').trim() || 'rev-parse --show-toplevel';
  const list = g.gitRun(w.repo, ['worktree', 'list', '--porcelain']);
  G.interrupted(list);
  if (!list.ok) return (list.out || '').trim();
  const entry = list.stdout.split('\n\n').find((b) => {
    const m = /^worktree (.+)$/m.exec(b);
    return m && same(m[1], w.to);
  });
  if (!entry) return t('move.notListed', { repo: w.repo });
  if (/^prunable\b/m.test(entry)) return t('move.prunable', { repo: w.repo });
  // What it holds reads too: a submodule left behind would fail here.
  const status = g.gitRun(w.to, ['status', '--porcelain']);
  G.interrupted(status);
  if (!status.ok) return status.out.trim() || 'git status';
  return '';
}

// The planned move, applied in one transaction: the directory renamed, each worktree relinked and
// checked with git, the task's files and state, then both epics' state and
// tasks.md. A failure or a stop signal puts all of it back, the directory renamed back last. The
// caller holds the locks: the epics', then the task's. Returns { tasksMdUpdated: { from, to } }.
async function applyMove(plan) {
  const done = await G.guarded((txn) => {
    const { ws } = plan;
    const dest = plan.to.path;
    // Checked again right before: something made there since the plan is never renamed over.
    if (G.lstat(dest) || takenIn(path.dirname(dest), plan.slug)) throw new Error(t('move.taken', { path: dest }));
    fs.renameSync(ws, dest);
    txn.add(() => renameBack(dest, ws));

    // Each worktree tied to its repository again, both files in the form they had.
    for (const w of plan.worktrees) {
      const bodies = linkBodies(w.link, real(w.to) || w.to);
      if (bodies.gitfile !== null) {
        const jw = G.journal();
        txn.add(() => G.restore(w.to, jw));
        G.writeOwned(w.to, '.git', bodies.gitfile, jw);
      }
      const ja = G.journal();
      txn.add(() => G.restore(w.link.admin, ja));
      G.writeOwned(w.link.admin, 'gitdir', bodies.gitdir, ja);
    }
    // Checked once every one is tied again: a worktree inside another reads only then.
    for (const w of plan.worktrees) {
      const why = linked(w);
      if (why) throw new Error(t('move.relinkFailed', { name: w.name, path: w.to, why }));
    }

    // The task's own files, then its render there.
    const j = G.journal();
    txn.add(() => G.restore(dest, j));
    for (const r of plan.rules) G.writeOwned(dest, r.rel, r.body, j);
    if (plan.memory) {
      const rel = path.join('.claude', 'settings.json');
      const body = swapMemory(G.readOwned(dest, rel), plan.memory.from, plan.memory.to);
      if (body !== null) G.writeOwned(dest, rel, body, j);
    }
    if (plan.notes !== null) G.writeOwned(dest, 'notes.md', plan.notes, j);
    if (plan.readmeLines.length) {
      const lines = G.readOwned(dest, 'README.md').split('\n');
      for (const r of plan.readmeLines) {
        const i = lines.indexOf(r.from);
        if (i >= 0) lines[i] = r.to;
      }
      G.writeOwned(dest, 'README.md', lines.join('\n'), j);
    }
    const rendered = G.computeRender(dest, plan.next, null, [], { fresh: EPIC_BLOCKS });
    G.applyRender(dest, { ...rendered, warnings: [] }, j);

    // The epic it left: out of its order, out of its tasks.md.
    const tasksMdUpdated = { from: false, to: false };
    if (plan.fromEpicWs) {
      const je = G.journal();
      txn.add(() => G.restore(plan.fromEpicWs, je));
      let epic = W.epicState(plan.fromEpicWs);
      if (Array.isArray(epic.taskOrder) && epic.taskOrder.includes(plan.slug)) {
        epic = { ...epic, taskOrder: epic.taskOrder.filter((x) => x !== plan.slug) };
        G.writeOwned(plan.fromEpicWs, W.STATE_FILE, W.stateJson(epic), je);
      }
      const r = G.renderTasks(plan.fromEpicWs, epic);
      if (r.changed) G.writeOwned(plan.fromEpicWs, 'tasks.md', r.body, je);
      tasksMdUpdated.from = r.changed;
    }
    // The epic it joined.
    if (plan.toEpicWs) {
      const je = G.journal();
      txn.add(() => G.restore(plan.toEpicWs, je));
      const r = G.renderTasks(plan.toEpicWs, W.epicState(plan.toEpicWs));
      if (r.changed) G.writeOwned(plan.toEpicWs, 'tasks.md', r.body, je);
      tasksMdUpdated.to = r.changed;
    }
    return { tasksMdUpdated };
  }, t('move.rollingBack', { ws: plan.ws }));
  dropStrayLock(plan.to.path);
  return done;
}

// The task's lock moved with its directory: lib/lock.js releases it at the old path, where there is
// none now. This process's own lock at the new path goes; anyone else's stays.
function dropStrayLock(ws) {
  const file = path.join(ws, '.claude', 'wsg.lock');
  try {
    const holder = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (holder && holder.pid === process.pid) fs.unlinkSync(file);
  } catch { /* none, or not ours */ }
}

// The result --json gives, plan or done: every key always there, the paths absolute
// (docs/json-contract.md). done: what applyMove returned.
function moveResult(plan, done = null) {
  return {
    workspace: plan.ws,
    kind: plan.kind,
    slug: plan.slug,
    status: plan.kind === 'task' ? W.statusOf(plan.state) : null,
    from: plan.from,
    to: plan.to,
    changed: changes(plan) && !plan.errors.length,
    newEpic: plan.newEpic && !plan.already,
    paths: plan.paths,
    blockers: plan.blockers,
    regenerates: plan.regenerates,
    relinked: plan.relinked,
    dropped: plan.dropped,
    ticketDropped: plan.ticketDropped,
    notesForEpic: plan.notes !== null,
    tasksMdUpdated: done ? done.tasksMdUpdated : plan.tasksMdUpdated,
  };
}

module.exports = { planMove, applyMove, moveResult, changes, worktreeLink, linkBodies };
