'use strict';

// Workspace creation and attaching sources. Every step records how to undo itself in a
// transaction; on any failure — or Ctrl+C — the steps are undone newest first: worktrees are
// detached, created branches are deleted if they have no commits outside their base, reset branches
// are restored from the backup, re-rendered files get their previous bytes back, and a workspace
// created by this run is removed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const T = require('./templates');
const g = require('./git');
const W = require('./workspace');
const S = require('./source');
const ui = require('./ui');
const { t } = require('./i18n');

// Copy-on-write. Node doesn't have it: COPYFILE_FICLONE exists, doesn't fail,
// and silently copies byte by byte — 57 MB of data took 57 MB of disk vs 0 MB with `cp -c`.
// Hence the external cp, and only on macOS.
function cloneDir(src, dst) {
  if (os.platform() !== 'darwin') return { ok: false, reason: t('gen.cowApfsOnly') };
  const r = spawnSync('cp', ['-Rc', src, dst], { encoding: 'utf8' });
  return r.status === 0 ? { ok: true } : { ok: false, reason: t('gen.clonefileUnavailable'), signal: r.signal };
}

function freeKb(p) {
  const r = spawnSync('df', ['-k', p], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const last = String(r.stdout).trim().split('\n').pop().split(/\s+/);
  return parseInt(last[3], 10);
}

// Ctrl+C goes to the whole process group. Without a handler Node dies immediately and the
// rollback doesn't run: the directory, the registered worktree and the branch remain. With a
// handler the signal kills only the child git or cp — visible via signal, and rollback runs.
function interruptedError() {
  const e = new Error('interrupted');
  e.name = 'Interrupted';
  return e;
}

// Ctrl+C, a closed terminal window, kill: each must roll back, not leave a half-built workspace.
const STOP_SIGNALS = ['SIGINT', 'SIGHUP', 'SIGTERM'];

function interrupted(res) {
  if (STOP_SIGNALS.includes(res.signal)) throw interruptedError();
}

// Undo steps, run newest first: a worktree is removed before its branch is deleted, and files are
// put back before the workspace they live in is removed. A failing step doesn't stop the rest.
function transaction() {
  const steps = [];
  return {
    get size() { return steps.length; },
    add(fn) { steps.push(fn); },
    undo() {
      while (steps.length) {
        try {
          steps.pop()();
        } catch (e) {
          ui.err(t('gen.undoFailed', { msg: (e && e.message) || e }));
        }
      }
    },
  };
}

// Runs a synchronous job that records its undo steps in a transaction, and rolls it back on a
// failure or a stop signal. Used by `new`, `add` and the composed run below alike.
async function guarded(job, header) {
  let hit = false;
  const onSignal = () => { hit = true; };
  for (const sig of STOP_SIGNALS) process.on(sig, onSignal);
  // With the terminal gone, writing the rollback messages fails with EIO/EPIPE; that must not
  // crash the rollback itself.
  const ignore = () => {};
  process.stdout.on('error', ignore);
  process.stderr.on('error', ignore);
  const txn = transaction();
  const rollback = () => {
    if (!txn.size) return;
    ui.err(`\n${header}`);
    txn.undo();
    ui.err(t('gen.rollbackDone'));
  };
  try {
    let value;
    try {
      value = job(txn);
    } catch (e) {
      rollback();
      throw e;
    }
    // The job is synchronous, so the signal handler can't fire while it runs. A pending
    // Ctrl+C is read in the poll phase. A timer resumes us in the timers phase whatever
    // phase this was called from, and the setImmediate after it fires in the check phase
    // of the same turn — so a poll phase always lies in between.
    // The user asked to cancel — roll back even the finished job.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setImmediate(resolve));
    if (hit) {
      rollback();
      throw interruptedError();
    }
    return value;
  } finally {
    for (const sig of STOP_SIGNALS) process.off(sig, onSignal);
    process.stdout.off('error', ignore);
    process.stderr.off('error', ignore);
  }
}

// --- generator-owned files

// Everything a render may rewrite. `repo` is the pointer symlink.
const RENDERED = ['AGENTS.md', 'CLAUDE.md', 'README.md', path.join('.claude', 'settings.json'), W.STATE_FILE,
  'mr-target-branch.txt', 'repo'];

function lstat(p) {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// Every directory on the way from the workspace root, not only the file: a symlinked .claude or
// .claude/rules (a shared folder, a hand-made link) would carry the write outside just the same.
// The same walk as promote does before its first write.
function assertNoLinks(ws, rel) {
  const parts = rel.split(path.sep);
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join(path.sep);
    const st = lstat(path.join(ws, dir));
    if (st && st.isSymbolicLink()) throw new Error(t('gen.symlinkOnPath', { path: dir, file: rel, ws }));
  }
}

// The file as it is now, or null when there is none. Never through a symlink: one there (a source
// named like the file, a hand-made link) would carry a later write outside the workspace.
function readOwned(ws, rel) {
  assertNoLinks(ws, rel);
  const st = lstat(path.join(ws, rel));
  if (!st) return null;
  if (!st.isFile()) throw new Error(t('gen.notAFile', { path: rel, ws }));
  return fs.readFileSync(path.join(ws, rel), 'utf8');
}

function writeOwned(ws, rel, body) {
  assertNoLinks(ws, rel);
  const p = path.join(ws, rel);
  const st = lstat(p);
  if (st && !st.isFile()) throw new Error(t('gen.notAFile', { path: rel, ws }));
  // wx for a new file: never write through a path that appeared in between.
  fs.writeFileSync(p, body, st ? undefined : { flag: 'wx' });
}

// Byte-exact copies, so a failed add leaves the files as they were — owner's edits included.
function snapshot(ws, rels) {
  const snap = new Map();
  for (const rel of rels) {
    const p = path.join(ws, rel);
    const st = lstat(p);
    if (!st) snap.set(rel, null);
    else if (st.isSymbolicLink()) snap.set(rel, { link: fs.readlinkSync(p) });
    else if (st.isFile()) snap.set(rel, { data: fs.readFileSync(p) });
    else snap.set(rel, { other: true }); // a directory is never ours to rewrite
  }
  return snap;
}

function restore(ws, snap) {
  for (const [rel, was] of snap) {
    if (was && was.other) continue;
    const p = path.join(ws, rel);
    const st = lstat(p);
    // A worktree that could not be removed has been reported already; never delete a directory here.
    if (st && st.isDirectory()) continue;
    if (st) fs.unlinkSync(p);
    if (!was) continue;
    if (was.link !== undefined) fs.symlinkSync(was.link, p);
    else fs.writeFileSync(p, was.data);
  }
}

// Which lines sit inside a fenced code block (the fence lines included): a marker shown in an
// example there is text, not the block.
function fencedLines(lines) {
  let fence = null;
  return lines.map((raw) => {
    const line = raw.trim();
    const f = line.match(/^(```|~~~)/);
    if (f && !fence) fence = f[1];
    else if (f && line.startsWith(fence)) fence = null;
    else return fence !== null;
    return true;
  });
}

// Replaces what lies between the markers. Exactly one pair is accepted: two pairs, half a pair or
// a pair out of order is refused — there is no telling which text is generated, and guessing
// could overwrite the owner's. A pair deleted by hand is put back after its anchor (or at the end)
// with a warning: the generated part must not silently stop being updated.
function replaceBlock(text, file, name, lines, anchor) {
  const open = `<!-- wsg:${name} -->`;
  const close = `<!-- /wsg:${name} -->`;
  const block = T.marked(name, lines).split('\n');
  const all = text.split('\n');
  const fenced = fencedLines(all);
  // Only a line that is the marker and nothing else counts: one quoted in prose (`<!-- wsg:… -->`) is text.
  const at = (marker) => all.flatMap((l, i) => (!fenced[i] && l.trim() === marker ? [i] : []));
  const opens = at(open);
  const closes = at(close);
  if (opens.length === 1 && closes.length === 1 && opens[0] < closes[0]) {
    all.splice(opens[0], closes[0] - opens[0] + 1, ...block);
    return { text: all.join('\n'), restored: false };
  }
  if (opens.length || closes.length) {
    throw new Error(t('gen.markerBroken', { file, name, opens: opens.length, closes: closes.length }));
  }
  const after = all.findIndex((l, i) => !fenced[i] && anchor.test(l));
  if (after >= 0) {
    all.splice(after + 1, 0, ...block);
    return { text: all.join('\n'), restored: true };
  }
  return { text: `${text.trimEnd()}\n\n${block.join('\n')}\n`, restored: true };
}

// Whether a worktree source brings its own rules. In a dry run the worktree doesn't exist yet:
// the base it will be checked out from answers instead.
function renderCtx(ws, planned) {
  const own = (file) => (r) => {
    const dest = path.join(ws, r.name);
    if (fs.existsSync(dest)) return fs.existsSync(path.join(dest, file));
    return !!planned && planned.name === r.name && g.gitRun(r.path, ['cat-file', '-e', `${r.base}:${file}`]).ok;
  };
  return { ws, hasAgentsMd: own('AGENTS.md'), hasClaudeMd: own('CLAUDE.md') };
}

// Everything generated, computed from the state without writing: `wsg add --dry-run` lists what
// would change, and the real add writes exactly this. drop: directories of a removed source, taken
// out of additionalDirectories (anything else there may be the owner's and is kept).
function computeRender(ws, state, planned, drop = []) {
  const ctx = renderCtx(ws, planned);
  const files = [];
  const warnings = [];
  const edit = (rel, blocks) => {
    const text = readOwned(ws, rel);
    if (text === null) {
      warnings.push(t('gen.fileMissing', { file: rel }));
      return;
    }
    let next = text;
    for (const [name, lines, anchor] of blocks) {
      const r = replaceBlock(next, rel, name, lines, anchor);
      if (r.restored) warnings.push(t('gen.markerRestored', { file: rel, name }));
      next = r.text;
    }
    files.push({ rel, body: next, changed: next !== text });
  };
  edit('AGENTS.md', [
    ['layout', T.layoutLines(state, ctx), /^## Layout[ \t]*$/m],
    ['verification', T.verificationLines(state), /^## Verification[ \t]*$/m],
  ]);
  edit('CLAUDE.md', [['imports', T.importLines(state, ctx), /^@AGENTS\.md[ \t]*$/m]]);
  edit('README.md', [['sources', T.sourcesLines(state, ctx), /^## Sources[ \t]*$/m]]);

  // settings.json belongs to the owner too: only additionalDirectories is rendered, every other
  // key stays. Directories added by hand are kept after the linked sources.
  const settingsRel = path.join('.claude', 'settings.json');
  const settingsText = readOwned(ws, settingsRel);
  let settingsChanged = false;
  if (settingsText === null) warnings.push(t('gen.fileMissing', { file: settingsRel }));
  else {
    let j;
    try {
      j = JSON.parse(settingsText);
    } catch (e) {
      throw new Error(t('gen.settingsInvalid', { file: path.join(ws, settingsRel), msg: e.message }));
    }
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error(t('gen.settingsInvalid', { file: path.join(ws, settingsRel), msg: 'not an object' }));
    const perms = j.permissions && typeof j.permissions === 'object' ? j.permissions : {};
    const linked = state.sources.filter((r) => r.mode === 'link').map((r) => r.path);
    const { additionalDirectories: had, ...rest } = perms;
    const dirs = [...linked, ...(Array.isArray(had) ? had : []).filter((d) => !linked.includes(d) && !drop.includes(d))];
    const now = JSON.stringify(dirs);
    if (now !== JSON.stringify(Array.isArray(had) ? had : [])) {
      j.permissions = dirs.length ? { additionalDirectories: dirs, ...rest } : rest;
      files.push({ rel: settingsRel, body: `${JSON.stringify(j, null, 2)}\n`, changed: true });
      settingsChanged = true;
    }
  }

  const stateBody = W.stateJson(state);
  const stateText = readOwned(ws, W.STATE_FILE);
  files.push({ rel: W.STATE_FILE, body: stateBody, changed: stateText !== stateBody });

  // The pointer: a name to point `repo` at, null to remove it, undefined to leave it as it is.
  // Only our own pointer is ever replaced or removed — a relative link to a sibling; a source
  // named repo is an absolute one, or a directory.
  const main = T.mainSource(state);
  const st = lstat(path.join(ws, 'repo'));
  const current = st && st.isSymbolicLink() ? fs.readlinkSync(path.join(ws, 'repo')) : null;
  const ours = current !== null && !current.includes('/');
  const named = state.sources.some((r) => r.name.toLowerCase() === 'repo'); // Repo and repo are one file on APFS
  let pointer;
  if (main) {
    const target = `${main.target}\n`;
    files.push({ rel: 'mr-target-branch.txt', body: target, changed: readOwned(ws, 'mr-target-branch.txt') !== target });
    if (named) warnings.push(t('gen.repoNamed'));
    else if (!st || (ours && current !== main.name)) pointer = main.name;
  } else {
    // No git source left (a removed one): neither file has anything to refer to.
    if (readOwned(ws, 'mr-target-branch.txt') !== null) files.push({ rel: 'mr-target-branch.txt', remove: true, changed: true });
    if (ours && !named) pointer = null;
  }
  return { files, pointer, settingsChanged, warnings };
}

function changedFiles(r) {
  return [...r.files.filter((f) => f.changed).map((f) => f.rel), ...(r.pointer !== undefined ? ['repo'] : [])];
}

function applyRender(ws, r) {
  for (const w of r.warnings) ui.warn(w);
  for (const f of r.files) {
    if (!f.changed) continue;
    if (f.remove) fs.unlinkSync(path.join(ws, f.rel));
    else writeOwned(ws, f.rel, f.body);
  }
  if (r.pointer !== undefined) {
    const p = path.join(ws, 'repo');
    if (lstat(p)) fs.unlinkSync(p);
    if (r.pointer !== null) fs.symlinkSync(r.pointer, p);
  }
}

// --- steps

// The ctx the skeleton's templates need; `state` is the empty state the blocks are rendered from.
function skeletonCtx(ws, cfg, meta, state) {
  return {
    ws,
    wsRoot: cfg.WS_ROOT,
    globalMemory: meta.personalRules ? cfg.WSG_GLOBAL_MEMORY : '',
    state,
    hasAgentsMd: () => false,
    hasClaudeMd: () => false,
  };
}

// The workspace without sources: `wsg new` stops here and hands over to the agent.
// meta: { kind, slug, title, ticket, ticketUrl, skillName, personalRules } and, from generate.run,
// the answers already known (problem, dod, …) — then their sections are filled instead of FILL IN.
function createSkeleton(meta, cfg, txn) {
  const ws = W.wsPath(meta.slug, cfg);
  fs.mkdirSync(cfg.WS_ROOT, { recursive: true });
  ui.head(t('gen.creating', { ws }));
  // Not recursive: an existing directory is an error, never something to remove on rollback.
  fs.mkdirSync(ws);
  txn.add(() => fs.rmSync(ws, { recursive: true, force: true }));
  for (const d of ['.claude/rules', '.claude/agents', '.claude/skills/wsg-setup', '.claude-memory', '.learnings']) {
    // agents/ is created empty on purpose: Claude Code live-reloads only directories that existed
    // when the session started, so adapters written during setup are picked up without a restart.
    fs.mkdirSync(path.join(ws, d), { recursive: true });
  }
  if (meta.kind === 'process') {
    fs.mkdirSync(path.join(ws, '.claude', 'skills', meta.skillName), { recursive: true });
    fs.mkdirSync(path.join(ws, 'runs'), { recursive: true });
  }
  const state = {
    version: W.STATE_VERSION,
    kind: meta.kind,
    slug: meta.slug,
    title: meta.title,
    ...(meta.kind === 'process' ? { skillName: meta.skillName } : {}),
    personalRules: !!meta.personalRules,
    created: T.today(),
    sources: [],
  };
  const ctx = skeletonCtx(ws, cfg, meta, state);
  // wx: never write through an existing path — a symlink there would lead outside the workspace.
  const w = (rel, body) => fs.writeFileSync(path.join(ws, rel), body, { flag: 'wx' });
  w('.claude/ws-kind', `${meta.kind}\n`);
  w(W.STATE_FILE, W.stateJson(state));
  w('.claude/settings.json', T.settingsJson(meta, ctx));
  w('CLAUDE.md', T.claudeMd(meta, ctx));
  w('AGENTS.md', T.agentsMd(meta, ctx));
  w('README.md', T.readmeMd(meta, ctx));
  w('notes.md', T.notesMd(meta));
  w('SETUP.md', T.setupMd());
  w('.claude/skills/wsg-setup/SKILL.md', T.template('claude/wsg-setup/SKILL.md'));
  w('.learnings/LEARNINGS.md', T.learningsMd(meta));
  w('.learnings/ERRORS.md', T.errorsMd(meta));
  if (meta.kind === 'process') {
    w(path.join('.claude/skills', meta.skillName, 'SKILL.md'), T.skillMd(meta, null));
    w('journal.md', T.journalMd(meta));
  }
  return ws;
}

// The branch is deleted only if it has nothing beyond the base it was created from: anything not
// in the base was made afterwards. Comparing with the remote won't do — in a repo without a remote
// it counts the whole history.
function deleteCreatedBranch(repo, name, base) {
  // worktree add may have been interrupted before it created the branch.
  if (!g.branchExists(repo, name)) return;
  const unique = g.git(repo, ['rev-list', '--count', name, '--not', base]);
  if (unique !== '0') {
    ui.err(t('gen.branchKept', { name, base }));
    return;
  }
  const del = g.gitRun(repo, ['branch', '-D', name]);
  if (del.ok) ui.err(t('gen.branchDeleted', { name }));
  else ui.err(t('gen.branchDeleteFailed', { name, out: del.out.trim() }));
}

function restoreResetBranch(repo, name, backup, tracking) {
  const back = g.gitRun(repo, ['branch', '-f', name, backup]);
  if (!back.ok) {
    ui.err(t('gen.branchLeftAtBase', { name, backup, out: back.out.trim() }));
    return;
  }
  g.gitRun(repo, ['branch', '-D', backup]);
  // Safety net: worktree add runs with --no-track and should leave the tracking config alone
  const restored = Object.entries(tracking).every(([key, value]) =>
    value === null
      ? [0, 5].includes(g.gitRun(repo, ['config', '--unset', key]).status) // 5: was not set
      : g.gitRun(repo, ['config', key, value]).ok);
  if (restored) ui.err(t('gen.branchRestored', { name }));
  else ui.err(t('gen.branchRestoredNoUpstream', { name }));
}

function removeWorktree(r, dest) {
  if (fs.existsSync(dest)) {
    const rm = g.gitRun(r.path, ['worktree', 'remove', '--force', dest]);
    if (!rm.ok) {
      ui.err(t('gen.worktreeRemoveFailed', { name: r.name, out: rm.out.trim() }));
      // The directory is this run's own: without it, prune below drops the registration — otherwise
      // the next add hits "already registered" and the branch can't be deleted.
      fs.rmSync(dest, { recursive: true, force: true });
    }
  }
  g.gitRun(r.path, ['worktree', 'prune']);
}

function attachWorktree(r, dest, txn) {
  if (g.worktreeBranches(r.path).includes(r.branch)) {
    throw new Error(t('validate.branchBusy', { b: r.branch }));
  }
  // Not branchExists: a show-ref interrupted by Ctrl+C would look like "no branch",
  // and rollback would then delete someone else's branch as if created here.
  const exists = g.gitRun(r.path, ['show-ref', '--verify', '--quiet', `refs/heads/${r.branch}`]);
  interrupted(exists);
  // source.resolve decides how the branch starts; generate.run's answers predate that and keep
  // the interview's rule: an existing branch is reset to the base.
  const start = r.start || (exists.ok ? 'reset' : 'new');
  if ((start === 'attach' || start === 'reset') !== exists.ok) {
    throw new Error(t(exists.ok ? 'gen.branchAppeared' : 'gen.branchGone', { branch: r.branch }));
  }
  if (start === 'attach') {
    // As it is: no reset, nothing to back up. Undo only detaches the worktree.
    txn.add(() => removeWorktree(r, dest));
    const res = g.gitRun(r.path, ['worktree', 'add', dest, r.branch]);
    interrupted(res);
    if (!res.ok) throw new Error(`worktree add: ${res.out.trim()}`);
  } else if (start === 'continue') {
    // The local branch is new, made from origin/<branch> and tracking it, so pull and push work as
    // they do for the MR. Undo deletes it only if nothing was added on top of origin.
    txn.add(() => deleteCreatedBranch(r.path, r.branch, r.base));
    txn.add(() => removeWorktree(r, dest));
    const res = g.gitRun(r.path, ['worktree', 'add', '--track', '-b', r.branch, dest, r.base]);
    interrupted(res);
    if (!res.ok) throw new Error(`worktree add: ${res.out.trim()}`);
  } else if (start === 'reset') {
    // `-B` resets the existing branch to the base, so this path is forbidden without a
    // confirmed backup: silently losing commits is worse than refusing.
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const bk = `backup/${r.branch.replace(/\//g, '-')}-${stamp}`;
    // Raw config values, not the resolved @{upstream}: that fails when the remote-tracking
    // ref is missing (after fetch --prune), and restoring "no upstream" would wipe the setting.
    const tracking = {};
    for (const key of [`branch.${r.branch}.remote`, `branch.${r.branch}.merge`]) {
      const v = g.gitRun(r.path, ['config', '--get', key]);
      interrupted(v);
      if (v.status !== 0 && v.status !== 1) throw new Error(`git config --get ${key}: ${v.out.trim()}`);
      tracking[key] = v.status === 0 ? v.out.trim() : null; // 1: key not set
    }
    const bkRes = g.gitRun(r.path, ['branch', bk, r.branch]);
    // Killed by Ctrl+C is not "the backup failed": it is a cancel, and rolls back as one.
    interrupted(bkRes);
    if (!bkRes.ok) {
      throw new Error(t('gen.backupFailed', { branch: r.branch, bk, out: bkRes.out.trim() }));
    }
    ui.info(t('gen.backup', { bk }));
    txn.add(() => restoreResetBranch(r.path, r.branch, bk, tracking));
    // Registered before the call: an interrupted worktree add may leave a registration behind.
    txn.add(() => removeWorktree(r, dest));
    // --no-track: the branch keeps its own upstream (an MR branch tracks origin/<itself>).
    // With --track, git would point it at the base, and pull would merge the base into it.
    const res = g.gitRun(r.path, ['worktree', 'add', '--no-track', '-B', r.branch, dest, r.base]);
    interrupted(res);
    if (!res.ok) throw new Error(`worktree add: ${res.out.trim()}`);
  } else {
    const conflict = g.branchRefConflict(r.path, r.branch);
    if (conflict) throw new Error(t('gen.branchConflict', { branch: r.branch, conflict }));
    // Before the call: an interrupted worktree add may still have created the branch.
    txn.add(() => deleteCreatedBranch(r.path, r.branch, r.base));
    txn.add(() => removeWorktree(r, dest));
    const res = g.gitRun(r.path, ['worktree', 'add', '--no-track', '-b', r.branch, dest, r.base]);
    interrupted(res);
    if (!res.ok) throw new Error(`worktree add: ${res.out.trim()}`);
  }
  ui.info(t('gen.worktree', { name: r.name, branch: r.branch }));

  if (r.carry && r.carry.length) {
    const copied = [];
    for (const c of r.carry) {
      try {
        fs.mkdirSync(path.dirname(path.join(dest, c)), { recursive: true });
        // EXCL: a file ignored here may be tracked in the base — don't overwrite the checked-out one
        fs.copyFileSync(path.join(r.path, c), path.join(dest, c), fs.constants.COPYFILE_EXCL);
        copied.push(c);
      } catch (e) {
        // e.g. the file vanished between the dry run and the add
        ui.warn(t('gen.notCopied', { file: c, why: e.code || e.message }));
      }
    }
    ui.info(t('gen.copied', { n: copied.length, total: r.carry.length }));
    // The rule for this repository lists these files as copied: only what actually was.
    r.carry = copied;
  }

  if (r.cloneNm && fs.existsSync(path.join(dest, 'node_modules'))) {
    // node_modules is committed in this repository (GitHub Actions do that): the worktree
    // already has it, and cp -R would nest a copy inside.
    ui.dim(t('gen.nmTracked'));
    r.cloneNm = false;
  } else if (r.cloneNm && fs.existsSync(path.join(r.path, 'node_modules'))) {
    ui.info(t('gen.nmCloning'));
    const before = freeKb(dest);
    const res = cloneDir(path.join(r.path, 'node_modules'), path.join(dest, 'node_modules'));
    interrupted(res);
    if (res.ok) {
      const after = freeKb(dest);
      const mb = before != null && after != null ? Math.round((before - after) / 1024) : '?';
      ui.info(t('gen.nmCloned', { mb }));
      ui.dim(t('gen.nmVersions'));
    } else {
      // cp may have created part of the tree before failing (another volume, no APFS)
      fs.rmSync(path.join(dest, 'node_modules'), { recursive: true, force: true });
      ui.warn(t('gen.nmNotCopied', { reason: res.reason }));
      r.cloneNm = false;
    }
  } else {
    r.cloneNm = false;
  }
}

// One source into an existing workspace: the worktree or symlink, its rule, then everything
// rendered from the new state. The undo steps cover only this source and the files it re-rendered.
// spec: as source.resolve returns it. Returns { source, settingsChanged }.
function attachSource(ws, spec, cfg, txn) {
  const state = W.readState(ws);
  const r = { ...spec, carry: [...(spec.carry || [])] };
  const dest = path.join(ws, r.name);
  const ruleRel = path.join('.claude', 'rules', `${r.name}.md`);
  // Checked before the first change: the render throws on what it can't handle (a broken marker,
  // settings.json that doesn't parse), and that must refuse the add, not roll it back.
  computeRender(ws, { ...state, sources: [...state.sources, r] }, r);
  assertRuleFree(ws, ruleRel);

  const before = snapshot(ws, [...RENDERED, ruleRel]);
  txn.add(() => restore(ws, before));
  if (lstat(dest)) {
    // Only the repo pointer may stand where a source named repo goes: it is rendered again below.
    if (!S.isRepoPointer(ws, r.name)) throw new Error(t('add.taken', { name: r.name }));
    fs.unlinkSync(dest);
  }
  if (r.mode === 'worktree') {
    attachWorktree(r, dest, txn);
  } else {
    fs.symlinkSync(r.path, dest);
    txn.add(() => { const st = lstat(dest); if (st && st.isSymbolicLink()) fs.unlinkSync(dest); });
    ui.info(t('gen.symlink', { name: r.name, path: r.path }));
  }
  writeOwned(ws, ruleRel, T.ruleMd(r));

  const next = { ...state, sources: [...state.sources, r] };
  const rendered = computeRender(ws, next, null);
  applyRender(ws, rendered);
  return { source: r, settingsChanged: rendered.settingsChanged };
}

// What `wsg remove` checks before it touches anything. Returns { source, branch, errors, files,
// settingsChanged, warnings }: the worktree must be clean, since nothing of it can be brought back.
function planRemove(ws, name) {
  const state = W.readState(ws);
  const errors = [];
  const r = state.sources.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!r) {
    errors.push(t('remove.unknown', { name, list: state.sources.map((x) => x.name).join(', ') || '—' }));
    return { source: null, errors, files: [], settingsChanged: false, warnings: [] };
  }
  const dest = path.join(ws, r.name);
  let branch = '';
  if (r.mode === 'worktree' && fs.existsSync(dest)) {
    branch = g.git(dest, ['branch', '--show-current']) || r.branch;
    // Untracked files count: git worktree remove refuses them too, and they exist nowhere else.
    // Ignored ones (a carried .env, node_modules) are copies and don't.
    const dirty = g.git(dest, ['status', '--porcelain', '--untracked-files=all']);
    if (dirty) errors.push(t('remove.dirty', { name: r.name, list: dirty.split('\n').map((l) => `    ${l}`).join('\n') }));
  }
  const next = { ...state, sources: state.sources.filter((x) => x !== r) };
  let rendered = { files: [], pointer: undefined, settingsChanged: false, warnings: [] };
  try {
    readOwned(ws, path.join('.claude', 'rules', `${r.name}.md`));
    rendered = computeRender(ws, next, null, r.mode === 'link' ? [r.path] : []);
  } catch (e) {
    errors.push(e.message);
  }
  return {
    source: r,
    branch,
    errors,
    files: [r.name, path.join('.claude', 'rules', `${r.name}.md`), ...changedFiles(rendered)],
    settingsChanged: rendered.settingsChanged,
    warnings: rendered.warnings,
  };
}

// One source out of the workspace: the worktree (never forced, the branch is kept) or the symlink,
// its rule, its state entry, then everything rendered without it. Undo puts it all back.
function removeSource(ws, name, cfg, txn) {
  const state = W.readState(ws);
  const r = state.sources.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!r) throw new Error(t('remove.unknown', { name, list: state.sources.map((x) => x.name).join(', ') || '—' }));
  const dest = path.join(ws, r.name);
  const ruleRel = path.join('.claude', 'rules', `${r.name}.md`);
  const next = { ...state, sources: state.sources.filter((x) => x !== r) };
  const drop = r.mode === 'link' ? [r.path] : [];
  // Checked before the first change, as in attachSource.
  computeRender(ws, next, null, drop);

  const before = snapshot(ws, [...RENDERED, ruleRel]);
  txn.add(() => restore(ws, before));
  let branch = '';
  const st = lstat(dest);
  if (r.mode === 'worktree') {
    if (st) {
      branch = g.git(dest, ['branch', '--show-current']) || r.branch;
      // Without --force: git refuses a worktree with changes, a locked one, one with submodules.
      const res = g.gitRun(r.path, ['worktree', 'remove', dest]);
      interrupted(res);
      if (!res.ok) throw new Error(t('remove.worktreeFailed', { name: r.name, out: res.out.trim() }));
      // Back on the same branch; files copied in at creation (.env, node_modules) are not.
      txn.add(() => {
        const back = g.gitRun(r.path, ['worktree', 'add', dest, branch]);
        ui.err(back.ok ? t('gen.worktreeReadded', { name: r.name, branch }) : t('gen.worktreeRemoveFailed', { name: r.name, out: back.out.trim() }));
      });
      ui.info(t('remove.worktree', { name: r.name }));
    }
    g.gitRun(r.path, ['worktree', 'prune']);
  } else if (st) {
    if (!st.isSymbolicLink()) throw new Error(t('remove.notLink', { name: r.name }));
    fs.unlinkSync(dest);
    txn.add(() => { if (!lstat(dest)) fs.symlinkSync(r.path, dest); });
    ui.info(t('remove.symlink', { name: r.name }));
  }
  const rule = readOwned(ws, ruleRel);
  if (rule !== null && T.isOwnRule(rule)) fs.unlinkSync(path.join(ws, ruleRel));
  else if (rule !== null) ui.warn(t('remove.ruleKept', { file: ruleRel }));

  const rendered = computeRender(ws, next, null, drop);
  applyRender(ws, rendered);
  return { source: r, branch, settingsChanged: rendered.settingsChanged };
}

// Brings every generated part in line with the state, e.g. after the markers were edited by hand.
function renderGenerated(ws) {
  const rendered = computeRender(ws, W.readState(ws), null);
  applyRender(ws, rendered);
  return rendered;
}

// A rule file at the source's path that wsg didn't write is the owner's notes: never overwritten.
function assertRuleFree(ws, rel) {
  const text = readOwned(ws, rel);
  if (text !== null && !T.isOwnRule(text)) throw new Error(t('gen.ruleExists', { file: rel }));
}

// What `wsg add --dry-run` reports as files to write, for a spec that passed source.resolve.
function plannedFiles(ws, spec) {
  const state = W.readState(ws);
  assertRuleFree(ws, path.join('.claude', 'rules', `${spec.name}.md`));
  const rendered = computeRender(ws, { ...state, sources: [...state.sources, spec] }, spec);
  return {
    files: [spec.name, path.join('.claude', 'rules', `${spec.name}.md`), ...changedFiles(rendered)],
    settingsChanged: rendered.settingsChanged,
    warnings: rendered.warnings,
  };
}

// `wsg new`.
function create(meta, cfg) {
  W.assertSafe(meta, cfg);
  return guarded((txn) => createSkeleton(meta, cfg, txn), t('gen.rollingBack', { ws: W.wsPath(meta.slug, cfg) }));
}

// `wsg add`.
function add(ws, spec, cfg) {
  return guarded((txn) => attachSource(ws, spec, cfg, txn), t('gen.addRollingBack', { name: spec.name, ws }));
}

// `wsg remove`.
function remove(ws, name, cfg) {
  return guarded((txn) => removeSource(ws, name, cfg, txn), t('gen.removeRollingBack', { name, ws }));
}

// The old single-shot creation, kept as a composition of the steps: the skeleton, then each source.
// a: { kind, slug, title, ticket, ticketUrl, skillName, personalRules, problem, dod, …,
// repos: [{ name, path, mode, branch, base, target, verify, note, carry, cloneNm }] }.
async function run(a, cfg) {
  W.assertSafe(a, cfg);
  // Rejected before anything is made: a file, or a name the workspace uses itself, would end up
  // with a template written over it.
  const seen = new Set();
  for (const r of a.repos) {
    const problem = S.sourceProblem(r);
    if (problem) throw new Error(problem);
    if (seen.has(r.name.toLowerCase())) throw new Error(t('gen.twoSources', { name: r.name }));
    seen.add(r.name.toLowerCase());
  }
  return guarded((txn) => {
    const ws = createSkeleton(a, cfg, txn);
    for (const r of a.repos) {
      attachSource(ws, {
        path: r.path,
        name: r.name,
        mode: r.mode,
        // A link outside git is what `wsg add --reference` makes.
        reference: r.mode === 'link' && !g.isRepo(r.path),
        branch: r.branch || '',
        base: r.base || '',
        target: r.target || '—',
        verify: r.verify || '',
        note: r.note || '',
        carry: r.carry || [],
        cloneNm: !!r.cloneNm,
      }, cfg, txn);
    }
    return ws;
  }, t('gen.rollingBack', { ws: W.wsPath(a.slug, cfg) }));
}

module.exports = {
  run, create, add, remove, attachSource, removeSource, planRemove, createSkeleton, renderGenerated, computeRender, applyRender, plannedFiles, changedFiles,
  replaceBlock, guarded, transaction, cloneDir, RESERVED: W.RESERVED, sourceProblem: S.sourceProblem,
};
