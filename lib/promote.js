'use strict';

// `wsg promote`: a task becomes an epic in place. The directory and its path stay, and with them
// everything the owner and the agents wrote — the text of AGENTS.md, CLAUDE.md and notes.md outside
// the markers, .claude-memory, .learnings, settings.json, the rules, the sources and their links.
// What changes is what wsg owns: .claude/ws-kind and the state say epic (the keys only a task has
// go, each one said), the README kind line and the AGENTS.md intro line when they are wsg's own text,
// the generated blocks rendered for an epic, and the files an epic has that a task has not —
// tasks.md, decisions.md, knowledge.md, the epic-knowledge rule and the wsg-epic-* skills — made
// only where nothing is (wx). A task-only file (checklist.md, spec.md, plan.md, mr-target-branch.txt)
// stays as a plain file and is named. A workspace of wsg 0.1 (no state) gets a fresh epic state; each
// top-level symlink to the root of a git repository becomes a link source of it, taken as it is
// (`wsg add --link` of an existing link, lib/source.js). Plan, then apply, as wsg move: everything is
// checked with nothing changed, and the apply is one transaction (generate.guarded) — a failure or a
// stop signal puts every file back. A task with a worktree is refused: an epic's sources are links,
// its tasks get the worktrees (wsg move <task> --epic <name> --new-epic nests it in a new epic).
// There is no way back.

const fs = require('node:fs');
const path = require('node:path');
const G = require('./generate');
const g = require('./git');
const T = require('./templates');
const W = require('./workspace');
const S = require('./source');
const { t } = require('./i18n');

// native: the names as they are on disk, as the CLI resolves the workspace (macOS compares without case).
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };

// The keys only a task has: dropped from the state, each one said.
const TASK_KEYS = ['status', 'closed', 'noCode', 'spec', 'moved', 'ticket'];
// The files only a task has: they stay as plain files, named.
const TASK_FILES = ['checklist.md', 'spec.md', 'plan.md', 'mr-target-branch.txt'];
// The lines wsg wrote that name the kind, swapped when they are exactly as written.
const TASK_INTROS = [
  'This is a task workspace, not a git repository: the repositories it works on are listed in Layout.',
  'This is a task workspace without code (`wsg new --no-code`): no repository, no branch; done is what the owner can check (Definition of done), and what it reads is listed in Layout.',
];
const EPIC_INTRO = 'This is an epic workspace, not a git repository: this directory holds one tracker epic — what its tasks need to know, its repositories, and its tasks, each an ordinary task workspace in a directory below with its own AGENTS.md.';
const README_TASK = 'Workspace kind: **task**.';
const README_EPIC = 'Workspace kind: **epic**.';
// Blocks a 0.1 workspace has none of: put in on purpose, no "restored" warning.
const ALL_BLOCKS = ['advisor', 'epic-context', 'layout', 'verification', 'sources', 'tasks', 'imports'];
const NEW_BLOCKS = ['epic-context', 'tasks'];
// A link name taken as a source's: a plain file name, as a source made by wsg add would have.
const LINK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SETTINGS = path.join('.claude', 'settings.json');

// The files an epic has that a task has not, made where nothing is: { rel: body }.
function epicFiles(meta) {
  const out = {
    'tasks.md': T.tasksMd(meta, []),
    'decisions.md': T.decisionsMd(meta),
    'knowledge.md': T.knowledgeMd(meta),
    [path.join('.claude', 'rules', T.EPIC_RULE)]: T.epicKnowledgeRule(),
  };
  for (const name of T.EPIC_SKILLS) out[path.join('.claude', 'skills', name, 'SKILL.md')] = T.template(`claude/${name}/SKILL.md`);
  return out;
}

// What .claude/ws-kind says ("process" read as task), '' when there is none.
function kindFile(ws) {
  try { return W.kindOf(fs.readFileSync(path.join(ws, '.claude', 'ws-kind'), 'utf8').trim()); } catch { return ''; }
}

// Whether settings.json, which promote never writes, lacks the directories of the epic's links (a
// warning: wsg refresh adds them). One that does not read, is no JSON object or is a symlink: said
// too; one that is not there: said apart, since wsg refresh never makes it.
function settingsWarning(ws, next) {
  const linked = W.extraDirs(next);
  let j;
  try {
    const text = G.readOwned(ws, SETTINGS);
    if (text === null) return { missing: true, text: t('promote.settingsMissing', { file: SETTINGS }) };
    j = JSON.parse(text);
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not a JSON object');
  } catch (e) {
    return t('promote.settingsUnreadable', { file: SETTINGS, why: (e && e.message) || String(e) });
  }
  const had = j && j.permissions && Array.isArray(j.permissions.additionalDirectories) ? j.permissions.additionalDirectories : [];
  return linked.every((d) => had.includes(d)) ? null : t('promote.settingsKept', { file: SETTINGS });
}

// The title a workspace of wsg 0.1 gives itself: the first `# ` heading of its AGENTS.md, or ''.
function headingOf(ws) {
  try {
    const m = /^# +(.+?)\s*$/m.exec(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8'));
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

// The first symlink on the way from ws to rel, the file itself included: its path relative to ws, or null.
function linkOnPath(ws, rel) {
  const parts = rel.split(path.sep);
  for (let i = 1; i <= parts.length; i++) {
    const p = path.join(ws, ...parts.slice(0, i));
    const st = G.lstat(p);
    if (st && st.isSymbolicLink()) return path.relative(ws, p);
    if (!st) return null;
  }
  return null;
}

// Top-level directories that hold a .git, not through a link: a worktree or a repository of its own.
function checkoutsIn(ws) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(ws, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '.git') continue;
    if (G.lstat(path.join(ws, e.name, '.git'))) out.push(e.name);
  }
  return out.sort();
}

// `wsg promote`, planned with nothing changed. ws: the task as it is on disk (a real path); state: its
// state, read under its lock for a real run, or null for a workspace of wsg 0.1. want: { title } —
// the epic's title (default: the task's). cfg: WS_ROOT. Returns the plan: what refuses it in errors.
function planPromote(ws, state, want, cfg) {
  const rootCfg = path.resolve(cfg.WS_ROOT);
  const root = real(rootCfg) || rootCfg;
  const slug = path.basename(ws);
  const legacy = !state;
  const kind = legacy ? kindFile(ws) || 'task' : state.kind;
  const given = (want.title || '').trim();
  const p = {
    ws,
    slug,
    legacy,
    state,
    kind,
    title: given || (state && typeof state.title === 'string' && state.title) || (legacy && headingOf(ws)) || slug,
    next: null,
    files: {},
    dirs: [],
    rewrites: [],
    creates: [],
    dropped: [],
    adopted: [],
    leftAlone: [],
    taskFiles: [],
    rules: [],
    readmeLine: false,
    introLine: false,
    kindFile: false,
    fresh: legacy ? ALL_BLOCKS : NEW_BLOCKS,
    blockers: { worktrees: [] },
    errors: [],
    warnings: [],
  };
  const err = (m) => p.errors.push(m);
  if (!W.KINDS.includes(kind)) {
    err(t('promote.unknownKind', { ws, kind }));
    return p;
  }
  if (kind === 'epic') {
    err(t('promote.isEpic', { ws }));
    return p;
  }
  if (state && state.epic) {
    err(t('promote.epicTask', { name: `${state.epic.slug}/${slug}` }));
    return p;
  }
  if (state && W.isArchived(state)) {
    err(t('promote.archived', { name: slug }));
    return p;
  }
  if (path.dirname(ws) !== root) err(t('promote.outsideRoot', { ws, root }));
  const bad = W.slugError(slug);
  if (bad) err(t('workspace.badSlug', { slug, why: bad }));
  if (state && state.team) err(t('promote.team', { name: slug, preset: state.team.preset }));
  const sources = state ? state.sources : [];
  sources.forEach((s, i) => {
    if (!W.isSource(s) || typeof s.name !== 'string' || !s.name || typeof s.path !== 'string' || !s.path) {
      err(t('list.badSource', { n: i + 1, value: JSON.stringify(s) }));
    }
  });
  // An epic's sources are links: a worktree stays a task's, in a task of the epic.
  const worktrees = [...new Set([...sources.filter((s) => W.isSource(s) && s.mode === 'worktree').map((s) => s.name), ...checkoutsIn(ws)])].sort();
  if (worktrees.length) {
    p.blockers.worktrees = worktrees.map((name) => ({ name, path: path.join(ws, name) }));
    // A workspace without a state is no task wsg move takes: no hint that leads to a refusal.
    err(t(legacy ? 'promote.worktreesLegacy' : 'promote.worktrees', { list: worktrees.join(', '), task: slug }));
  }
  if (p.errors.length) return p;

  // The state it will have.
  const meta = { slug, title: p.title };
  let next;
  if (legacy) {
    next = { version: W.EPIC_STATE_VERSION, kind: 'epic', slug, title: p.title, personalRules: false, created: T.today(), sources: [] };
  } else {
    const { mcpRendered, ...rest } = state;
    for (const k of TASK_KEYS) {
      if (rest[k] !== undefined) p.dropped.push(k);
      delete rest[k];
    }
    next = { ...rest, version: W.EPIC_STATE_VERSION, kind: 'epic', slug, title: p.title };
    // An epic's record of what its render put there has its .mcp.json too.
    if (mcpRendered) next.mcpRendered = { mcpJson: [], enabled: mcpRendered.enabled || [], denied: mcpRendered.denied || [] };
    if (W.statusOf(state) === 'done') p.warnings.push(t('promote.doneDropped', { name: slug }));
  }

  try {
    // A workspace of wsg 0.1: every top-level symlink to the root of a git repository is a source,
    // by the link's name, taken as it is; the repo pointer is a task's, and anything else stays.
    if (legacy) {
      // Two links to one repository: the one named like its folder goes first, the other is left alone.
      const links = fs.readdirSync(ws).filter((name) => G.lstat(path.join(ws, name)).isSymbolicLink())
        .map((name) => ({ name, target: fs.readlinkSync(path.join(ws, name)), to: real(path.join(ws, name)) }))
        .sort((a, b) => (a.to && path.basename(a.to) === a.name ? 0 : 1) - (b.to && path.basename(b.to) === b.name ? 0 : 1)
          || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const { name, target, to } of links) {
        if (S.isRepoPointer(ws, name) || !LINK_NAME.test(name) || !to || !g.isRepoRoot(to)) {
          p.leftAlone.push({ name, target });
          continue;
        }
        const r = S.resolve(to, { mode: 'link', name }, { ws, state: next });
        if (!r.spec) {
          p.leftAlone.push({ name, target });
          p.warnings.push(t('promote.notAdopted', { name, why: r.errors.join('; ') }));
          continue;
        }
        const { adopt: _adopt, ...spec } = r.spec;
        next = { ...next, sources: [...next.sources, spec] };
        p.adopted.push({ name, path: spec.path });
      }
      p.adopted.sort((a, b) => (a.name < b.name ? -1 : 1));
      p.leftAlone.sort((a, b) => (a.name < b.name ? -1 : 1));
    }
    p.next = next;

    // Files made where nothing is; one that is there already is kept as it is, and said.
    const made = epicFiles(meta);
    // An adopted source's rule, where it has none; one there is the owner's, kept without a word.
    const adoptedRules = new Set();
    for (const s of next.sources.filter((x) => p.adopted.some((a) => a.name === x.name))) {
      const rel = path.join('.claude', 'rules', `${s.name}.md`);
      made[rel] = T.ruleMd(s, { epic: true });
      adoptedRules.add(rel);
    }
    for (const [rel, body] of Object.entries(made)) {
      const at = linkOnPath(ws, rel);
      if (at) {
        err(t('promote.symlink', { path: at, ws }));
        continue;
      }
      if (G.lstat(path.join(ws, rel))) {
        // tasks.md gets its block rendered in; anything else is the owner's.
        if (rel !== 'tasks.md' && !adoptedRules.has(rel)) p.warnings.push(t('promote.fileKept', { file: rel }));
        continue;
      }
      p.files[rel] = body;
      for (let d = path.dirname(rel); d !== '.'; d = path.dirname(d)) {
        if (!G.lstat(path.join(ws, d)) && !p.dirs.includes(d)) p.dirs.push(d);
      }
    }
    // The oldest workspaces have no .claude: ws-kind and the state go there.
    if (!G.lstat(path.join(ws, '.claude')) && !p.dirs.includes('.claude')) p.dirs.push('.claude');
    p.dirs.sort((a, b) => a.length - b.length);
    for (const rel of ['AGENTS.md', 'CLAUDE.md', 'README.md', path.join('.claude', 'ws-kind'), W.STATE_FILE]) {
      const at = linkOnPath(ws, rel);
      if (at) err(t('promote.symlink', { path: at, ws }));
    }

    // A rule of a task without code says its repository is read only: wsg's own, unedited, becomes
    // the rule an epic's link has; an edited one is the owner's, kept, and named.
    if (state && state.noCode) {
      for (const s of state.sources.filter((x) => x.mode === 'link' && !x.reference)) {
        const rel = path.join('.claude', 'rules', `${s.name}.md`);
        const at = linkOnPath(ws, rel);
        if (at) {
          err(t('promote.symlink', { path: at, ws }));
          continue;
        }
        const text = G.readOwned(ws, rel);
        if (text === null) continue;
        if (text === T.ruleMd(s, { noCode: true })) p.rules.push({ rel, body: T.ruleMd(s, { epic: true }) });
        else if (text !== T.ruleMd(s)) p.warnings.push(t('promote.ruleEdited', { file: rel }));
      }
    }
    if (p.errors.length) return p;

    // The lines wsg wrote that name the kind.
    const readme = G.readOwned(ws, 'README.md');
    p.readmeLine = readme !== null && readme.split('\n').includes(README_TASK);
    const agents = G.readOwned(ws, 'AGENTS.md');
    p.introLine = agents !== null && agents.split('\n').some((l) => TASK_INTROS.includes(l));
    if (!p.introLine && agents !== null && agents.split('\n').some((l) => l.startsWith('This is a task workspace'))) p.warnings.push(t('promote.introKept'));
    p.kindFile = kindFile(ws) !== 'epic';

    // The render it will get, with no task of its own yet: the directory is no epic on disk until
    // the apply writes its state. tasks.md is made by the apply first.
    // settings.json is the owner's: not read by the render, never written.
    const rendered = G.computeRender(ws, next, null, [], { fresh: p.fresh, children: [], skipSettings: true });
    p.warnings.push(...rendered.warnings.filter((w) => w !== t('gen.fileMissing', { file: 'tasks.md' })));
    const sw = settingsWarning(ws, next);
    // wsg refresh in the next step only where it can do it: a settings.json that is there.
    p.settingsKept = typeof sw === 'string' && sw === t('promote.settingsKept', { file: SETTINGS });
    if (sw) p.warnings.push(typeof sw === 'string' ? sw : sw.text);
    const rewrites = new Set(G.changedFiles(rendered).filter((f) => !(f in p.files)));
    rewrites.add(W.STATE_FILE);
    if (p.kindFile && G.lstat(path.join(ws, '.claude', 'ws-kind'))) rewrites.add(path.join('.claude', 'ws-kind'));
    if (p.readmeLine) rewrites.add('README.md');
    if (p.introLine) rewrites.add('AGENTS.md');
    for (const r of p.rules) rewrites.add(r.rel);
    p.rewrites = [...rewrites].sort().map((f) => path.join(ws, f));
    const creates = Object.keys(p.files);
    if (p.kindFile && !G.lstat(path.join(ws, '.claude', 'ws-kind'))) creates.push(path.join('.claude', 'ws-kind'));
    p.creates = creates.sort().map((f) => path.join(ws, f));
  } catch (e) {
    if (e && e.name === 'Interrupted') throw e;
    err(e.message);
    return p;
  }

  // Said, never refused.
  p.taskFiles = [...TASK_FILES.filter((f) => G.lstat(path.join(ws, f))), ...(!legacy && S.isRepoPointer(ws, 'repo') ? ['repo'] : [])]
    .map((f) => path.join(ws, f));
  if (p.taskFiles.length) p.warnings.push(t('promote.taskFiles', { list: p.taskFiles.map((f) => path.basename(f)).join(', ') }));
  if (p.leftAlone.length) p.warnings.push(t('promote.leftAlone', { list: p.leftAlone.map((x) => x.name).join(', ') }));
  // The epic's tasks are its directories: one named like a source or a file of the epic can't be one.
  for (const e of fs.readdirSync(ws, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const clash = W.reserved(e.name) ? 'reserved' : next.sources.some((s) => s.name.toLowerCase() === e.name.toLowerCase()) ? 'source' : null;
    if (clash) p.warnings.push(t(clash === 'reserved' ? 'promote.childReserved' : 'promote.childIsSource', { name: e.name }));
  }
  const cwd = real(process.cwd());
  if (cwd && (cwd === ws || cwd.startsWith(ws + path.sep))) p.warnings.push(t('promote.cwdInside'));
  p.warnings.push(t('promote.sessions'));
  return p;
}

// The planned promote, applied in one transaction: the directories and files the epic has made, the
// state and ws-kind, the lines that name the kind, the rules, then the render of the epic. A failure
// or a stop signal puts all of it back. The caller holds the lock.
function applyPromote(plan) {
  return G.guarded((txn) => {
    const { ws } = plan;
    // Made first, so their undo runs after the files in them are gone.
    for (const d of plan.dirs) {
      fs.mkdirSync(path.join(ws, d));
      txn.add(() => { try { fs.rmdirSync(path.join(ws, d)); } catch { /* not empty: something of someone else's */ } });
    }
    const j = G.journal();
    txn.add(() => G.restore(ws, j));
    for (const [rel, body] of Object.entries(plan.files)) G.writeOwned(ws, rel, body, j, { create: true });
    if (plan.kindFile) G.writeOwned(ws, path.join('.claude', 'ws-kind'), 'epic\n', j);
    G.writeOwned(ws, W.STATE_FILE, W.stateJson(plan.next), j);
    for (const r of plan.rules) G.writeOwned(ws, r.rel, r.body, j);
    const swap = (rel, from, to) => {
      const text = G.readOwned(ws, rel);
      if (text === null) return;
      const lines = text.split('\n');
      const i = lines.findIndex((l) => from.includes(l));
      if (i < 0) return;
      lines[i] = to;
      G.writeOwned(ws, rel, lines.join('\n'), j);
    };
    if (plan.readmeLine) swap('README.md', [README_TASK], README_EPIC);
    if (plan.introLine) swap('AGENTS.md', TASK_INTROS, EPIC_INTRO);
    // As planned: no task of its own yet, settings.json the owner's.
    const rendered = G.computeRender(ws, plan.next, null, [], { fresh: plan.fresh, children: [], skipSettings: true });
    G.applyRender(ws, { ...rendered, warnings: [] }, j);
    return {};
  }, t('promote.rollingBack', { ws: plan.ws }));
}

// The result --json gives, plan or done: every key always there, the paths absolute
// (docs/json-contract.md).
function promoteResult(plan) {
  return {
    workspace: plan.ws,
    slug: plan.slug,
    kind: plan.kind,
    legacy: plan.legacy,
    title: plan.title,
    changed: !plan.errors.length,
    rewrites: plan.rewrites,
    creates: plan.creates,
    dropped: plan.dropped,
    adopted: plan.adopted,
    leftAlone: plan.leftAlone,
    taskFiles: plan.taskFiles,
    blockers: plan.blockers,
  };
}

module.exports = { planPromote, applyPromote, promoteResult, EPIC_INTRO, TASK_INTROS };
