'use strict';

// Workspace creation and attaching sources. Every step records how to undo itself in a
// transaction; on any failure — or Ctrl+C — the steps are undone newest first: worktrees are
// detached, created branches are deleted if they have no commits outside their base, reset branches
// are restored from the backup, every file the run wrote goes back to its bytes before that write —
// unless it changed since the run wrote it (an edit made during a long git step): then it is kept,
// with a warning — and a workspace created by this run is removed. Files the run never wrote are
// not touched.

const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const T = require('./templates');
const g = require('./git');
const W = require('./workspace');
const S = require('./source');
const ui = require('./ui');
const lock = require('./lock');
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

// Ctrl+C and the other stop signals, and the error they become (lib/git.js).
const { STOP_SIGNALS, interruptedError } = g;

function interrupted(res) {
  if (STOP_SIGNALS.includes(res.signal)) throw interruptedError();
}

// Undo steps, run newest first: a worktree is removed before its branch is deleted, and files are
// put back before the workspace they live in is removed. A failing step doesn't stop the rest.
function transaction() {
  const steps = [];
  return {
    // The paths a rollback kept because they changed while the run went on (restore), and how many
    // undo steps or paths failed: then the workspace is not as it was, and nothing may say so.
    kept: [],
    // The same paths, absolute, one for one (null where a step gave only the relative one): a run
    // that writes in two directories (a task and its epic's tasks.md) can't be told apart by those.
    keptAbs: [],
    failed: 0,
    get size() { return steps.length; },
    add(fn) { steps.push(fn); },
    undo() {
      while (steps.length) {
        try {
          const r = steps.pop()();
          if (r && Array.isArray(r.kept)) {
            this.kept.push(...r.kept);
            this.keptAbs.push(...r.kept.map((k, i) => (Array.isArray(r.keptAbs) && r.keptAbs[i]) || null));
          }
          if (r && r.failed) this.failed += r.failed;
        } catch (e) {
          this.failed++;
          ui.err(t('gen.undoFailed', { msg: (e && e.message) || e }));
        }
      }
      // A path one step kept and a later step removed (the directory of a workspace being made) is
      // not kept: it is gone with the rest.
      const there = this.keptAbs.map((p) => !p || !!lstat(p));
      this.kept = this.kept.filter((_, i) => there[i]);
      this.keptAbs = this.keptAbs.filter((_, i) => there[i]);
    },
  };
}

// Runs a synchronous job that records its undo steps in a transaction, and rolls it back on a
// failure or a stop signal. Used by `new`, `add` and the composed run below alike.
async function guarded(job, header) {
  let hit = false;
  const onSignal = () => { hit = true; };
  for (const sig of STOP_SIGNALS) process.on(sig, onSignal);
  // The lock's handler would release it and exit at once; from here the signal is this one's.
  const takeBack = lock.handOver();
  // With the terminal gone, writing the rollback messages fails with EIO/EPIPE; that must not
  // crash the rollback itself.
  const ignore = () => {};
  process.stdout.on('error', ignore);
  process.stderr.on('error', ignore);
  const txn = transaction();
  // What the error says about the rollback (lib/json.js): "none" — nothing had been changed,
  // "done" — put back, "incomplete" — a step of it failed.
  const rollback = () => {
    if (!txn.size) return 'none';
    ui.err(`\n${header}`);
    txn.undo();
    if (txn.failed) ui.err(t('gen.rollbackIncomplete', { n: txn.failed }));
    else ui.err(txn.kept.length ? t('gen.rollbackDoneKept', { list: txn.kept.join(', ') }) : t('gen.rollbackDone'));
    return txn.failed ? 'incomplete' : 'done';
  };
  try {
    let value;
    try {
      value = job(txn);
    } catch (e) {
      const how = rollback();
      if (e && typeof e === 'object') Object.assign(e, { kept: txn.kept, keptAbs: txn.keptAbs, rollbackFailed: txn.failed, rollback: how });
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
      const how = rollback();
      throw Object.assign(interruptedError(), { kept: txn.kept, keptAbs: txn.keptAbs, rollbackFailed: txn.failed, rollback: how });
    }
    return value;
  } finally {
    for (const sig of STOP_SIGNALS) process.off(sig, onSignal);
    takeBack();
    process.stdout.off('error', ignore);
    process.stderr.off('error', ignore);
  }
}

// --- generator-owned files

// Everything a render may rewrite. `repo` is the pointer symlink; tasks.md exists in an epic only.
const RENDERED = ['AGENTS.md', 'CLAUDE.md', 'README.md', path.join('.claude', 'settings.json'), W.STATE_FILE,
  'mr-target-branch.txt', 'repo', 'tasks.md'];

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

// A path as it is on disk: null when there is none.
function entryOf(p) {
  const st = lstat(p);
  if (!st) return null;
  if (st.isSymbolicLink()) return { link: fs.readlinkSync(p) };
  if (st.isFile()) return { data: fs.readFileSync(p), mode: st.mode & 0o7777 };
  return { other: true }; // a directory is never ours to rewrite
}
const sameEntry = (a, b) => (a === null || b === null ? a === b
  : a.link !== undefined ? a.link === b.link
    : a.data !== undefined ? b.data !== undefined && a.data.equals(b.data)
      : !!b.other);

// --- writes a rollback can take back
//
// A run can take hours (git worktree add of a big repository), and the agent may edit the same files
// meanwhile. So a run keeps a journal of its own writes: each path as it was right before the run
// first wrote it (pre), and as the run last left it (wrote). Every write is one step on disk — a
// temporary file or link next to the target, renamed over it — so a write that fails half-way (a
// full disk) leaves what was there.

const journal = () => ({ pre: new Map(), wrote: new Map() });

// Runs a write of rel by the run that keeps j (none: nothing to take back). A write that returns
// false wrote nothing (an undo step that found the path not its own), and is not recorded.
function owned(ws, j, rel, write) {
  const p = path.join(ws, rel);
  if (j && !j.pre.has(rel)) j.pre.set(rel, entryOf(p));
  let wroteIt = true;
  try {
    const r = write(p);
    if (r === false) wroteIt = false;
    return r;
  } finally {
    if (j && wroteIt) j.wrote.set(rel, entryOf(p));
  }
}

// Random as well as the pid: a temporary file left by a crashed run must never block a write.
const tmpOf = (p) => path.join(path.dirname(p), `.${path.basename(p)}.wsg-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);

// body at p in one step, through a temporary file next to it. create: p must not exist — never
// write through a path that appeared in between: hard-linked into place, which fails then; on a file
// system without hard links (exFAT, FAT32) an exclusive copy does the same. Otherwise the temporary
// file is renamed over p — which, like any rewrite this way, gives p a new inode: other hard links to
// it keep the old bytes, and extended attributes are not carried over. The temporary file is gone
// whatever happens.
function putFile(p, body, { create = false, mode } = {}) {
  const tmp = tmpOf(p);
  try {
    fs.writeFileSync(tmp, body, { flag: 'wx' });
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    if (!create) fs.renameSync(tmp, p);
    else {
      try {
        fs.linkSync(tmp, p);
      } catch (e) {
        if (e.code === 'EEXIST') throw e;
        fs.copyFileSync(tmp, p, fs.constants.COPYFILE_EXCL);
      }
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// A symlink at p in one step, whatever file or link stands there.
function putLink(target, p) {
  const tmp = tmpOf(p);
  try {
    fs.symlinkSync(target, tmp);
    fs.renameSync(tmp, p);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// j: the journal of the run that writes (see owned). opts.create: the file must be new.
function writeOwned(ws, rel, body, j, opts = {}) {
  assertNoLinks(ws, rel);
  const p = path.join(ws, rel);
  const st = lstat(p);
  if (st && !st.isFile()) throw new Error(t('gen.notAFile', { path: rel, ws }));
  if (st && opts.create) throw Object.assign(new Error(`EEXIST: file already exists, ${p}`), { code: 'EEXIST' });
  // A read-only file stays unwritable, as it was before writes went through a rename.
  if (st) fs.accessSync(p, fs.constants.W_OK);
  owned(ws, j, rel, () => putFile(p, body, st ? { mode: st.mode & 0o7777 } : { create: true }));
}

// What the run left at each path it wrote goes back to how it was before its first write there —
// only while it is still exactly what the run left. A path changed since then is someone's edit made
// during the run: kept, with a warning. Paths the run never wrote are not touched at all. Returns
// the paths kept.
function restore(ws, j) {
  const kept = [];
  let failed = 0;
  for (const [rel, last] of [...j.wrote].reverse()) {
    // One path that can't be put back must not stop the others.
    try {
      const was = j.pre.get(rel);
      if (was && was.other) continue;
      const p = path.join(ws, rel);
      const now = entryOf(p);
      // A worktree that could not be removed has been reported already; never delete a directory here.
      if (now && now.other) continue;
      if (sameEntry(now, was)) continue;
      if (!sameEntry(now, last)) {
        ui.err(keptMessage(rel));
        kept.push(rel);
        continue;
      }
      if (!was) fs.unlinkSync(p);
      else if (was.link !== undefined) putLink(was.link, p);
      else putFile(p, was.data, { mode: was.mode });
    } catch (e) {
      failed++;
      ui.err(t('gen.restoreFailed', { file: rel, msg: (e && e.message) || e }));
    }
  }
  return { kept, keptAbs: kept.map((rel) => path.join(ws, rel)), failed };
}

// What to do with a file kept as it was edited: the blocks of a rendered file are put right by wsg
// refresh; a rule, the settings and anything else only by hand.
function keptMessage(rel) {
  if (['AGENTS.md', 'CLAUDE.md', 'README.md', 'tasks.md', 'mr-target-branch.txt', 'repo'].includes(rel)) return t('gen.keptChanged', { file: rel });
  if (rel === path.join('.claude', 'settings.json')) return t('gen.keptChangedSettings', { file: rel });
  if (rel === W.STATE_FILE) return t('gen.keptChangedState', { file: rel });
  return t('gen.keptChangedByHand', { file: rel });
}

// Fences as CommonMark reads them, without tracking blocks other than list items. Indentation is
// counted in columns, a tab to the next multiple of 4. An opener: 3+ backticks or 3+ tildes, after
// backticks an info string with no backtick (```x``` is inline code). Indented up to 3 it opens
// anywhere. Indented 4 or more it is indented code (or a paragraph going on), unless it stands in a
// list item: after a list item line, with no unindented line between, and indented at most 3 past
// that item's text. A closer: the same character, at least as many, nothing after, indented at
// most 3 past the opener — so a fence shown inside a fence, indented, doesn't close the outer one,
// and a list item may close its fence less indented than it opened it. Blockquotes are not read: a
// fence after `>` is text, closed or not.
function expandTabs(line) {
  if (!line.includes('\t')) return line;
  let out = '';
  for (const c of line) out += c === '\t' ? ' '.repeat(4 - (out.length % 4)) : c;
  return out;
}
function fenceOpener(line) {
  const m = /^( *)(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m || (m[2][0] === '`' && m[3].includes('`'))) return null;
  return { char: m[2][0], len: m[2].length, indent: m[1].length };
}
function closesFence(line, fence) {
  const m = /^( *)(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!m && m[1].length <= fence.indent + 3 && m[2][0] === fence.char && m[2].length >= fence.len;
}
// The column a list item's text starts at, or -1 for a line that is no list item.
function listItemText(line) {
  if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line)) return -1; // a thematic break: * * *, - - -, ***
  const m = /^( *)([-*+]|\d{1,9}[.)])( *)(.?)/.exec(line);
  if (!m || (m[4] && !m[3])) return -1;
  const gap = m[3].length;
  return m[1].length + m[2].length + (gap >= 1 && gap <= 4 && m[4] ? gap : 1);
}

// Which lines sit inside a fenced code block (the fence lines included): a marker shown in an
// example there is text, not the block. open: the fence left unclosed at the end, if any, with
// the line that would close it.
function fencedLines(lines) {
  let fence = null;
  let openedAt = -1;
  let item = -1; // the column the current list item's text starts at; -1 outside a list
  const inside = lines.map((raw, i) => {
    const line = expandTabs(raw.replace(/\r$/, ''));
    // A line at column 0 ends the list item, a fence opening or closing there included.
    if (/^\S/.test(line)) item = -1;
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      return true;
    }
    const opener = fenceOpener(line);
    if (opener && (opener.indent < 4 || (item >= 0 && opener.indent <= item + 3))) {
      fence = opener;
      openedAt = i;
      return true;
    }
    const text = listItemText(line);
    if (text >= 0) {
      item = text;
      // A fence may open on the item's line itself: `- ```sh`.
      const own = fenceOpener(line.slice(text));
      if (own && own.indent === 0) {
        fence = { ...own, indent: text };
        openedAt = i;
        return true;
      }
    }
    return false;
  });
  return { inside, open: fence ? { line: openedAt + 1, closer: fence.char.repeat(fence.len) } : null };
}

// A fence never closed turns the rest of the file into code: the markers after it are not seen,
// and every add would append another pair. Refused, like a broken pair; check reports it too.
const openFence = (text) => fencedLines(text.split('\n')).open;
function fenceProblem(text, file) {
  const open = openFence(text);
  return open ? t('gen.fenceOpen', { file, line: open.line, fence: open.closer }) : '';
}

// Replaces what lies between the markers. Exactly one pair is accepted: two pairs, half a pair or
// a pair out of order is refused — there is no telling which text is generated, and guessing
// could overwrite the owner's. A pair deleted by hand is put back after its anchor (or at the end)
// with a warning: the generated part must not silently stop being updated.
// opts.frontmatter: the text may open with a YAML frontmatter (a SKILL.md); the anchor is looked
// for only after it — a `# comment` there is YAML, not a heading.
// Where a block's markers stand: the lines that are the marker and nothing else, outside fences.
// One quoted in prose (`<!-- wsg:… -->`) is text. wsg writes markers at column 0; an indented one is
// an example in a list item.
function markersOf(all, fenced, name) {
  const at = (marker) => all.flatMap((l, i) => (!fenced[i] && l.trimEnd() === marker ? [i] : []));
  return { opens: at(`<!-- wsg:${name} -->`), closes: at(`<!-- /wsg:${name} -->`) };
}

// The lines between a block's markers as they are on disk, found as replaceBlock finds them (exactly
// one pair, in order, at column 0, outside fences), or null when there is no such pair. Fed back as
// the block's lines, they render it unchanged.
function blockLines(text, name) {
  if (text === null || openFence(text)) return null;
  const all = text.split('\n');
  const { opens, closes } = markersOf(all, fencedLines(all).inside, name);
  return opens.length === 1 && closes.length === 1 && opens[0] < closes[0] ? all.slice(opens[0] + 1, closes[0]) : null;
}

function replaceBlock(text, file, name, lines, anchor, opts = {}) {
  const open = `<!-- wsg:${name} -->`;
  const close = `<!-- /wsg:${name} -->`;
  const block = T.marked(name, lines).split('\n');
  const all = text.split('\n');
  const problem = fenceProblem(text, file);
  if (problem) throw new Error(problem);
  const fenced = fencedLines(all).inside;
  const { opens, closes } = markersOf(all, fenced, name);
  if (opens.length === 1 && closes.length === 1 && opens[0] < closes[0]) {
    all.splice(opens[0], closes[0] - opens[0] + 1, ...block);
    return { text: all.join('\n'), restored: false };
  }
  if (opens.length || closes.length) {
    throw new Error(t('gen.markerBroken', { file, name, opens: opens.length, closes: closes.length }));
  }
  // No pair at column 0, but a marker indented: the real pair moved by a hand edit or a formatter.
  // Taken for an example, it would get a second block added next to it.
  const moved = all.findIndex((l, i) => !fenced[i] && (l.trim() === open || l.trim() === close));
  if (moved >= 0) throw new Error(t('gen.markerIndented', { file, name, line: moved + 1 }));
  const front = opts.frontmatter && all[0].trimEnd() === '---' ? all.findIndex((l, i) => i > 0 && l.trimEnd() === '---') : -1;
  const after = all.findIndex((l, i) => i > front && !fenced[i] && anchor.test(l));
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

// Blocks a workspace made by an earlier wsg doesn't have yet, with the version that brought them:
// adding one is news, not a repair of markers deleted by hand. advisor: in AGENTS.md and CLAUDE.md.
// Not team: it is rendered only once `wsg team` has added it, so a missing one was deleted by hand.
const NEW_BLOCKS = { advisor: '0.3.0', 'epic-rules': '0.6.1' };

// Everything generated, computed from the state without writing: `wsg add --dry-run` lists what
// would change, and the real add writes exactly this. drop: directories of a removed source, taken
// out of additionalDirectories (anything else there may be the owner's and is kept).
// opts.fresh: names of blocks this run adds on purpose (`wsg team` its first time): no warning.
// opts.epicRules: the epic's Owner rules as epicRules read them already (createInEpic), with warned
// set once the reason they were refused has been shown.
// Returns added: { file, name } of each block put in because it was missing.
function computeRender(ws, state, planned, drop = [], opts = {}) {
  const ctx = renderCtx(ws, planned);
  const files = [];
  const warnings = [];
  const added = [];
  // lines: the block's lines, or a function of the text as it is so far that returns them.
  const edit = (rel, blocks) => {
    const text = readOwned(ws, rel);
    if (text === null) {
      warnings.push(t('gen.fileMissing', { file: rel }));
      return;
    }
    let next = text;
    for (const [name, lines, anchor] of blocks) {
      const r = replaceBlock(next, rel, name, typeof lines === 'function' ? lines(next) : lines, anchor);
      if (r.restored) added.push({ file: rel, name });
      if (r.restored && !(opts.fresh || []).includes(name)) {
        // Epics came after every block in NEW_BLOCKS: a missing one was deleted by hand.
        warnings.push(NEW_BLOCKS[name] && state.kind !== 'epic'
          ? t('gen.blockAdded', { file: rel, name, version: NEW_BLOCKS[name] })
          : t('gen.markerRestored', { file: rel, name }));
      }
      next = r.text;
    }
    files.push({ rel, body: next, changed: next !== text });
    return next;
  };
  const epic = state.kind === 'epic';
  // A task of an epic: the epic's Owner rules, read from ../AGENTS.md on every render (epicRulesBlock).
  let rules = null;
  const agents = edit('AGENTS.md', [
    ['advisor', T.advisorLines(), /^This is an? (task|process|epic) workspace/],
    // A task of an epic: the pointers from its own state, so this block never needs the epic.
    ...(state.epic ? [['epic', T.epicLines(state), /^<!-- \/wsg:advisor -->[ \t]*$/]] : []),
    ...(state.epic ? [['epic-rules', (text) => {
      rules = epicRulesBlock(ws, state, text, opts.epicRules);
      if (rules.warning) warnings.push(rules.warning);
      return rules.lines;
    }, /^<!-- \/wsg:epic -->[ \t]*$/]] : []),
    // Right after the advisor block: both are rules for the whole session, read before the sections.
    ...(state.team ? [['team', T.teamLines(state), /^<!-- \/wsg:advisor -->[ \t]*$/]] : []),
    ['layout', T.layoutLines(state, ctx), /^## Layout[ \t]*$/m],
    ['verification', T.verificationLines(state), /^## Verification[ \t]*$/m],
  ]);
  // The block came in just now (a task made by an earlier wsg, its first render): its own Owner rules
  // section may be the copy `wsg new --epic` made of the epic's. Said once, here; never edited.
  if (rules && agents !== undefined && added.some((a) => a.file === 'AGENTS.md' && a.name === 'epic-rules')) {
    const copy = rulesOverlap(agents, rules.rules);
    if (copy) warnings.push(copy.n === copy.m ? t('gen.epicRulesCopy') : t('gen.epicRulesOverlap', copy));
  }
  // An epic's sources are links, never worktrees: it has no repository rules to import.
  edit('CLAUDE.md', [
    ...(epic ? [] : [['imports', T.importLines(state, ctx), /^@AGENTS\.md[ \t]*$/m]]),
    ['advisor', T.claudeAdvisorLines(), /^## Claude Code only[ \t]*$/m],
  ]);
  edit('README.md', [['sources', T.sourcesLines(state, ctx), /^## Sources[ \t]*$/m]]);
  if (epic) edit('tasks.md', [['tasks', T.tasksLines(W.childrenOf(ws), state.slug), /^# /]]);

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
    const linked = W.extraDirs(state);
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
  // An epic has neither: its repositories are shared checkouts, and the MR is a task's.
  if (epic) return { files, pointer: undefined, settingsChanged, warnings, added };
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
  return { files, pointer, settingsChanged, warnings, added };
}

function changedFiles(r) {
  return [...r.files.filter((f) => f.changed).map((f) => f.rel), ...(r.pointer !== undefined ? ['repo'] : [])];
}

// snap: the run's journal, as writeOwned takes it.
function applyRender(ws, r, snap) {
  for (const w of r.warnings) ui.warn(w);
  for (const f of r.files) {
    if (!f.changed) continue;
    if (f.remove) owned(ws, snap, f.rel, (p) => fs.unlinkSync(p));
    else writeOwned(ws, f.rel, f.body, snap);
  }
  if (r.pointer !== undefined) {
    owned(ws, snap, 'repo', (p) => {
      if (r.pointer !== null) putLink(r.pointer, p);
      else if (lstat(p)) fs.unlinkSync(p);
    });
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

// The state a new workspace starts with; `wsg new --dry-run` prints it.
function skeletonState(meta) {
  return {
    version: W.stateVersion(meta.kind),
    kind: meta.kind,
    slug: meta.slug,
    title: meta.title,
    ...(meta.kind === 'process' ? { skillName: meta.skillName } : {}),
    ...(meta.epic ? { epic: meta.epic } : {}),
    ...(meta.epic && meta.ticketKey ? { ticket: meta.ticketKey } : {}),
    ...(meta.kind === 'epic' ? {} : { status: 'open' }),
    personalRules: !!meta.personalRules,
    created: T.today(),
    sources: [],
  };
}

// The workspace without sources: `wsg new` stops here and hands over to the agent.
// meta: { kind, slug, title, ticket, ticketUrl, skillName, personalRules } and, from generate.run,
// the answers already known (problem, dod, …) — then their sections are filled instead of FILL IN.
// meta.epicWs: a task of that epic, made in its directory; meta.epic and meta.ticketKey then go into
// the state (createInEpic).
function createSkeleton(meta, cfg, txn) {
  const ws = meta.epicWs ? W.childPath(meta.epicWs, meta.slug) : W.wsPath(meta.slug, cfg);
  // WS_ROOT made here is this run's too: the rollback takes the directories it made back off, while
  // they are empty, so a failure leaves nothing behind and is reported as rolled back.
  const madeRoot = fs.mkdirSync(cfg.WS_ROOT, { recursive: true });
  if (madeRoot) {
    txn.add(() => {
      for (let d = path.resolve(cfg.WS_ROOT); ; d = path.dirname(d)) {
        try { fs.rmdirSync(d); } catch { break; } // not empty, or gone: the rest stays
        if (d === path.resolve(madeRoot)) break;
      }
    });
  }
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
  const epic = meta.kind === 'epic';
  if (epic) for (const name of T.EPIC_SKILLS) fs.mkdirSync(path.join(ws, '.claude', 'skills', name));
  const state = skeletonState(meta);
  const ctx = skeletonCtx(ws, cfg, meta, state);
  // wx: never write through an existing path — a symlink there would lead outside the workspace.
  const w = (rel, body) => fs.writeFileSync(path.join(ws, rel), body, { flag: 'wx' });
  w('.claude/ws-kind', `${meta.kind}\n`);
  w(W.STATE_FILE, W.stateJson(state));
  w('.claude/settings.json', T.settingsJson(meta, ctx));
  w('CLAUDE.md', epic ? T.epicClaudeMd(meta) : T.claudeMd(meta, ctx));
  w('AGENTS.md', epic ? T.epicAgentsMd(meta, ctx) : T.agentsMd(meta, ctx));
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
  if (epic) {
    w('knowledge.md', T.knowledgeMd(meta));
    w('tasks.md', T.tasksMd(meta, []));
    w('decisions.md', T.decisionsMd(meta));
    w(path.join('.claude/rules', T.EPIC_RULE), T.epicKnowledgeRule());
    for (const name of T.EPIC_SKILLS) w(path.join('.claude/skills', name, 'SKILL.md'), T.template(`claude/${name}/SKILL.md`));
  }
  return ws;
}

// The undo steps of a worktree: each returns { failed: 1 } when it could not put things back, so
// the rollback is reported incomplete (lib/json.js "rollback"), not done.

// The branch is deleted only if it has nothing beyond the base it was created from: anything not
// in the base was made afterwards. Comparing with the remote won't do — in a repo without a remote
// it counts the whole history. A branch kept for its commits is on purpose, not a failure.
function deleteCreatedBranch(repo, name, base) {
  // worktree add may have been interrupted before it created the branch.
  if (!g.branchExists(repo, name)) return undefined;
  const unique = g.git(repo, ['rev-list', '--count', name, '--not', base]);
  if (unique !== '0') {
    ui.err(t('gen.branchKept', { name, base }));
    return undefined;
  }
  const del = g.gitRun(repo, ['branch', '-D', name]);
  if (del.ok) {
    ui.err(t('gen.branchDeleted', { name }));
    return undefined;
  }
  ui.err(t('gen.branchDeleteFailed', { name, out: del.out.trim() }));
  return { failed: 1 };
}

function restoreResetBranch(repo, name, backup, tracking) {
  const back = g.gitRun(repo, ['branch', '-f', name, backup]);
  if (!back.ok) {
    ui.err(t('gen.branchLeftAtBase', { name, backup, out: back.out.trim() }));
    return { failed: 1 };
  }
  g.gitRun(repo, ['branch', '-D', backup]);
  // Safety net: worktree add runs with --no-track and should leave the tracking config alone
  const restored = Object.entries(tracking).every(([key, value]) =>
    value === null
      ? [0, 5].includes(g.gitRun(repo, ['config', '--unset', key]).status) // 5: was not set
      : g.gitRun(repo, ['config', key, value]).ok);
  if (restored) {
    ui.err(t('gen.branchRestored', { name }));
    return undefined;
  }
  ui.err(t('gen.branchRestoredNoUpstream', { name }));
  return { failed: 1 };
}

function removeWorktree(r, dest) {
  if (fs.existsSync(dest)) {
    const rm = g.gitRun(r.path, ['worktree', 'remove', '--force', dest]);
    if (!rm.ok) {
      ui.err(t('gen.worktreeRemoveFailed', { name: r.name, out: rm.out.trim() }));
      // The directory is this run's own: without it, prune below drops the registration — otherwise
      // the next add hits "already registered" and the branch can't be deleted. Once it is gone the
      // worktree is undone after all; a directory still there is a failed step.
      fs.rmSync(dest, { recursive: true, force: true });
    }
  }
  g.gitRun(r.path, ['worktree', 'prune']);
  return fs.existsSync(dest) ? { failed: 1 } : undefined;
}

// Returns { backupBranch }: the backup/… branch --reset-to-base made, or null.
function attachWorktree(r, dest, txn) {
  let backupBranch = null;
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
    backupBranch = bk;
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
  return { backupBranch };
}

// One source into an existing workspace: the worktree or symlink, its rule, then everything
// rendered from the new state. The undo steps cover only this source and the files it re-rendered.
// spec: as source.resolve returns it. Returns { source, settingsChanged }.
// opts.epicRules: as computeRender takes it.
function attachSource(ws, spec, cfg, txn, opts = {}) {
  const state = W.readState(ws);
  const r = { ...spec, carry: [...(spec.carry || [])] };
  const dest = path.join(ws, r.name);
  const ruleRel = path.join('.claude', 'rules', `${r.name}.md`);
  // Checked before the first change: the render throws on what it can't handle (a broken marker,
  // settings.json that doesn't parse), and that must refuse the add, not roll it back.
  computeRender(ws, { ...state, sources: [...state.sources, r] }, r, [], { epicRules: opts.epicRules });
  assertRuleFree(ws, ruleRel);

  const before = journal();
  txn.add(() => restore(ws, before));
  if (lstat(dest)) {
    // Only the repo pointer may stand where a source named repo goes: it is rendered again below.
    if (!S.isRepoPointer(ws, r.name)) throw new Error(t('add.taken', { name: r.name }));
    owned(ws, before, r.name, (p) => fs.unlinkSync(p));
  }
  let backupBranch = null;
  if (r.mode === 'worktree') {
    ({ backupBranch } = attachWorktree(r, dest, txn));
  } else {
    owned(ws, before, r.name, (p) => fs.symlinkSync(r.path, p));
    txn.add(() => owned(ws, before, r.name, (p) => {
      const st = lstat(p);
      if (!st || !st.isSymbolicLink() || fs.readlinkSync(p) !== r.path) return false;
      fs.unlinkSync(p);
      return true;
    }));
    ui.info(t('gen.symlink', { name: r.name, path: r.path }));
  }
  writeOwned(ws, ruleRel, T.ruleMd(r, { epic: state.kind === 'epic' }), before);

  const next = { ...state, sources: [...state.sources, r] };
  const rendered = computeRender(ws, next, null, [], { epicRules: opts.epicRules });
  applyRender(ws, rendered, before);
  return { source: r, settingsChanged: rendered.settingsChanged, backupBranch };
}

// Whether two paths hold the same bytes. Anything unreadable is not the same.
function sameBytes(a, b) {
  try {
    if (fs.statSync(a).size !== fs.statSync(b).size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

// Ignored files in a worktree that exist nowhere else: a .env the agent made, a build, an
// installed node_modules, a carried file edited since. git worktree remove deletes them without
// asking. A carried file still equal to the main checkout's is a copy and doesn't count. A
// node_modules wsg cloned doesn't count either, and is not compared: changes made inside it are
// not protected (remove says so). Directories that hold nothing but ignored files come as one
// entry, `dir/`; one that holds a carried file is listed file by file, without the copies.
function ignoredLeft(dest, r) {
  const carried = new Set(r.carry || []);
  // Throws when git can't list them: an empty list would let the removal delete them unseen.
  const list = (args) => g.gitList(dest, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', ...args])
    .split('\0')
    .filter(Boolean);
  const copy = (f) => carried.has(f) && sameBytes(path.join(dest, f), path.join(r.path, f));
  const out = [];
  const found = list(['--directory']);
  const dirs = found.filter((f) => f.endsWith('/'));
  for (const f of found) {
    if (r.cloneNm && f === 'node_modules/') continue;
    // git may name a file inside a directory it reports too (a pattern that ignores the files,
    // not the directory): the directory entry stands for it.
    if (dirs.some((d) => d !== f && f.startsWith(d))) continue;
    if (!f.endsWith('/')) {
      if (!copy(f)) out.push(f);
      continue;
    }
    if (![...carried].some((c) => c.startsWith(f))) {
      out.push(f);
      continue;
    }
    out.push(...list(['--', f]).filter((x) => !copy(x)));
  }
  return out;
}

// A name as a refusal shows it. One with whitespace at an end, nothing but spaces, a line break,
// another control character or " -> " is quoted: otherwise it reads as a blank line, another name
// or two, or a rename.
const shownName = (f) => (/^\s|\s$|[\x00-\x1f\x7f]| -> /.test(f) ? JSON.stringify(f) : f);

// The list as a refusal shows it: the first 20 entries. show: how one entry reads.
function shownList(files, show = shownName) {
  const shown = files.slice(0, 20).map((f) => `    ${show(f)}`);
  if (files.length > 20) shown.push(`    ${t('remove.more', { n: files.length - 20 })}`);
  return shown.join('\n');
}

// What git status says is changed in a worktree, as { xy, path, from } — from: the old name of a
// renamed or copied file. Read with -z: a name may hold a line break or " -> ".
function changesOf(dest) {
  const fields = g.gitList(dest, ['status', '--porcelain', '-z', '--untracked-files=all']).split('\0');
  const out = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    const xy = f.slice(0, 2);
    out.push({ xy, path: f.slice(3), ...(/[RC]/.test(xy) ? { from: fields[++i] } : {}) });
  }
  return out;
}
const shownChange = (c) => `${c.xy} ${c.from !== undefined ? `${shownName(c.from)} -> ` : ''}${shownName(c.path)}`;

// A listing wsg remove relies on that git couldn't give, as the refusal. Ctrl+C is no failure: it
// stops the command.
function listRefusal(e, name, key) {
  if (e && e.name === 'Interrupted') throw e;
  if (e && e.code === 'ENOBUFS') return t('remove.listTooLarge', { name });
  return t(key, { name, why: e.message });
}

// In an epic, the tasks that have a source of that name: they keep their worktrees and branches, a
// removal from the epic only stops new tasks from getting it.
function epicTasksUsing(ws, state, name) {
  if (state.kind !== 'epic') return [];
  const out = [];
  for (const c of W.childrenOf(ws)) {
    const s = c.state.sources.find((x) => x && typeof x.name === 'string' && x.name.toLowerCase() === name.toLowerCase());
    // Each as it has it: a worktree of its own, or a link — wherever it came from.
    if (s) out.push(`${path.basename(c.ws)} (${t(s.mode === 'worktree' ? 'remove.asWorktree' : 'remove.asLink')})`);
  }
  return out;
}
const usingWarning = (name, tasks) => t('remove.epicTasksKeep', { name, list: tasks.join(', ') });

// What `wsg remove` checks before it touches anything. Returns { source, branch, ignored, errors,
// files, settingsChanged, warnings }: the worktree must be clean, since nothing of it can be brought
// back. opts.deleteIgnored: the owner agreed to lose the ignored files listed in `ignored`.
function planRemove(ws, name, opts = {}) {
  const state = W.readState(ws);
  const errors = [];
  const r = state.sources.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!r) {
    errors.push(t('remove.unknown', { name, list: state.sources.map((x) => x.name).join(', ') || '—' }));
    return { source: null, ignored: [], errors, files: [], settingsChanged: false, warnings: [] };
  }
  const dest = path.join(ws, r.name);
  let branch = '';
  let ignored = [];
  const notes = [];
  if (r.mode === 'worktree' && fs.existsSync(dest)) {
    branch = g.git(dest, ['branch', '--show-current']) || r.branch;
    // Untracked files count: git worktree remove refuses them too, and they exist nowhere else.
    // Ignored ones git deletes silently: refused too, unless they are copies wsg made.
    try {
      const dirty = changesOf(dest);
      if (dirty.length) errors.push(t('remove.dirty', { name: r.name, list: shownList(dirty, shownChange) }));
    } catch (e) {
      errors.push(listRefusal(e, r.name, 'remove.statusFailed'));
    }
    try {
      ignored = ignoredLeft(dest, r);
    } catch (e) {
      errors.push(listRefusal(e, r.name, 'remove.listFailed'));
    }
    const nm = r.cloneNm ? t('remove.nmNotChecked', { name: r.name }) : '';
    if (nm) notes.push(nm);
    if (ignored.length && !opts.deleteIgnored) {
      errors.push(t('remove.ignored', { name: r.name, list: shownList(ignored) }) + (nm ? `\n  ${nm}` : ''));
    }
  }
  const using = epicTasksUsing(ws, state, r.name);
  if (using.length) notes.push(usingWarning(r.name, using));
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
    ignored,
    errors,
    files: [r.name, path.join('.claude', 'rules', `${r.name}.md`), ...changedFiles(rendered)],
    settingsChanged: rendered.settingsChanged,
    warnings: [...notes, ...rendered.warnings],
  };
}

// One source out of the workspace: the worktree (never forced, the branch is kept) or the symlink,
// its rule, its state entry, then everything rendered without it. Undo puts it all back.
// opts: { deleteIgnored, ignored } from planRemove — the ignored files the owner agreed to lose.
function removeSource(ws, name, cfg, txn, opts = {}) {
  const state = W.readState(ws);
  const r = state.sources.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!r) throw new Error(t('remove.unknown', { name, list: state.sources.map((x) => x.name).join(', ') || '—' }));
  const dest = path.join(ws, r.name);
  const ruleRel = path.join('.claude', 'rules', `${r.name}.md`);
  const next = { ...state, sources: state.sources.filter((x) => x !== r) };
  const drop = r.mode === 'link' ? [r.path] : [];
  // Checked before the first change, as in attachSource.
  computeRender(ws, next, null, drop);
  const st = lstat(dest);
  if (r.mode === 'worktree' && st) {
    // Again, right before the removal: a file made since the plan was checked would go unasked.
    const agreed = new Set(opts.deleteIgnored ? opts.ignored || [] : []);
    let left;
    try {
      left = ignoredLeft(dest, r);
    } catch (e) {
      throw Object.assign(new Error(listRefusal(e, r.name, 'remove.listFailed')), { invalid: true });
    }
    const appeared = left.filter((f) => !agreed.has(f));
    if (appeared.length) {
      throw Object.assign(new Error(t('remove.ignoredAppeared', { name: r.name, list: shownList(appeared) })), { invalid: true });
    }
  }

  const before = journal();
  txn.add(() => restore(ws, before));
  let branch = '';
  if (r.mode === 'worktree') {
    if (st) {
      branch = g.git(dest, ['branch', '--show-current']) || r.branch;
      if (r.cloneNm) ui.warn(t('remove.nmNotChecked', { name: r.name }));
      // Without --force: git refuses a worktree with changes, a locked one, one with submodules.
      const res = g.gitRun(r.path, ['worktree', 'remove', dest]);
      interrupted(res);
      if (!res.ok) throw new Error(t('remove.worktreeFailed', { name: r.name, out: res.out.trim() }));
      // Back on the same branch; files copied in at creation (.env, node_modules) are not.
      txn.add(() => {
        const back = g.gitRun(r.path, ['worktree', 'add', dest, branch]);
        if (back.ok) {
          ui.err(t('gen.worktreeReadded', { name: r.name, branch }));
          return undefined;
        }
        ui.err(t('gen.worktreeReaddFailed', { name: r.name, branch, out: back.out.trim() }));
        return { failed: 1 };
      });
      ui.info(t('remove.worktree', { name: r.name }));
    }
    g.gitRun(r.path, ['worktree', 'prune']);
  } else if (st) {
    if (!st.isSymbolicLink()) throw new Error(t('remove.notLink', { name: r.name }));
    owned(ws, before, r.name, (p) => fs.unlinkSync(p));
    txn.add(() => owned(ws, before, r.name, (p) => {
      if (lstat(p)) return false;
      fs.symlinkSync(r.path, p);
      return true;
    }));
    ui.info(t('remove.symlink', { name: r.name }));
  }
  const using = epicTasksUsing(ws, state, r.name);
  if (using.length) ui.warn(usingWarning(r.name, using));
  const rule = readOwned(ws, ruleRel);
  if (rule !== null && T.isOwnRule(rule)) owned(ws, before, ruleRel, (p) => fs.unlinkSync(p));
  else if (rule !== null) ui.warn(t('remove.ruleKept', { file: ruleRel }));

  const rendered = computeRender(ws, next, null, drop);
  applyRender(ws, rendered, before);
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
  if (meta.epicWs) return createInEpic(meta, cfg);
  W.assertSafe(meta, cfg);
  return guarded((txn) => createSkeleton(meta, cfg, txn), t('gen.rollingBack', { ws: W.wsPath(meta.slug, cfg) }));
}

// The epic's tasks.md with its block listing the tasks in the directory now: { body, changed,
// warnings }; an epic without tasks.md gets only the warning. Throws on a block it can't render, as
// computeRender does.
// override: { ws, state } — that task as it will be, not as it is on disk (wsg status renders the
// block before it writes the state, to refuse what it couldn't render).
function renderTasks(epicWs, epicState, override = null) {
  const text = readOwned(epicWs, 'tasks.md');
  if (text === null) return { body: null, changed: false, warnings: [t('gen.fileMissing', { file: 'tasks.md' })] };
  const children = W.childrenOf(epicWs).map((c) => (override && path.basename(c.ws) === path.basename(override.ws)
    ? { ...c, state: override.state, mismatch: !override.state.epic || override.state.epic.slug !== epicState.slug } : c));
  const r = replaceBlock(text, 'tasks.md', 'tasks', T.tasksLines(children, epicState.slug), /^# /);
  return { body: r.text, changed: r.text !== text, warnings: r.restored ? [t('gen.markerRestored', { file: 'tasks.md', name: 'tasks' })] : [] };
}

// The `## Owner rules` section of an AGENTS.md: its lines from the heading to the next heading of the
// same level or above, CR stripped, blank lines at the end dropped; null when there is none.
const OWNER_RULES = /^## Owner rules\b/;
function ownerRulesSection(text) {
  const lines = text.split('\n');
  const fenced = fencedLines(lines).inside;
  const start = lines.findIndex((l, i) => !fenced[i] && OWNER_RULES.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && !fenced[i] && /^#{1,2}\s/.test(l));
  if (end < 0) end = lines.length;
  const section = lines.slice(start, end).map((l) => l.replace(/\r$/, ''));
  while (section.length && !section[section.length - 1].trim()) section.pop();
  return section;
}

// The Owner rules of the epic at epicWs, for the <!-- wsg:epic-rules --> block of its tasks:
// { kind: 'rules', body } — the section's lines without its heading, blank lines at the edges trimmed;
// { kind: 'none' } — the section still holds FILL IN, or is empty (only this section is judged: an
// epic without a ticket has FILL IN elsewhere); missing: true — there is no section at all (deleted,
// or its heading renamed), and a task keeps the rules its block has (epicRulesBlock);
// { kind: 'refused', why } — the epic can't be read (moved, not an epic, another slug, no AGENTS.md,
// a file that doesn't read), or the section can't be pasted as text: a generated marker in it would make a
// second block in the task, a fence left open would swallow the rest of the file.
// Never throws: a task must render, and a new task be made, whatever the epic's state. No lock.
function epicRules(epicWs, slug) {
  const refused = (why) => ({ kind: 'refused', why });
  let text;
  try {
    if (!W.hasState(epicWs)) return refused(t('gen.epicRulesWhy.notWorkspace', { dir: epicWs }));
    const epic = W.readState(epicWs);
    if (epic.kind !== 'epic') return refused(t('gen.epicRulesWhy.notEpic', { dir: epicWs, kind: epic.kind }));
    if (epic.slug !== slug) return refused(t('gen.epicRulesWhy.otherEpic', { dir: epicWs, found: epic.slug, slug }));
    text = readOwned(epicWs, 'AGENTS.md');
  } catch (e) {
    return refused((e && e.message) || String(e));
  }
  if (text === null) return refused(t('gen.epicRulesWhy.noAgentsMd', { dir: epicWs }));
  const section = ownerRulesSection(text);
  if (!section) return { kind: 'none', missing: true };
  if (section.length < 2) return { kind: 'none' };
  const all = section.join('\n');
  if (/FILL IN|ЗАПОЛНИТЬ/.test(all)) return { kind: 'none' };
  if (/<!-- \/?wsg:/.test(all)) return refused(t('gen.ownerRulesWhy.marker'));
  if (openFence(all)) return refused(t('gen.ownerRulesWhy.fence'));
  const body = section.slice(1);
  while (body.length && !body[0].trim()) body.shift();
  return body.length ? { kind: 'rules', body } : { kind: 'none' };
}

// The epic of a task as Claude Code walks to it: the real directory above.
function epicDirOf(ws) {
  try {
    return path.dirname(fs.realpathSync(ws));
  } catch {
    return path.dirname(path.resolve(ws));
  }
}

// What the epic's Owner rules not rendered is reported with: the block kept as it is on disk, or, with
// none there yet, a line pointing to ../AGENTS.md.
const epicRulesWarning = (r, kept) => t(kept ? 'gen.epicRulesKept' : 'gen.epicRulesPlaceholder', { why: r.why });

// The <!-- wsg:epic-rules --> block of a task of an epic, from the epic as it is now: { lines, rules,
// warning, kept }. text: the task's AGENTS.md as it is. An epic that can't be read keeps the block as
// it is on disk (so render and disk agree, and check does not call it stale), with a warning; never a
// refusal. So does an epic whose AGENTS.md has no Owner rules section at all, while the block holds
// rules: a deleted or renamed heading is not taken for "no rules" (FILL IN in the section is).
// known: epicRules already read (createInEpic); known.warned: its warning was shown.
function epicRulesBlock(ws, state, text, known) {
  const slug = state.epic.slug;
  const rules = known || epicRules(epicDirOf(ws), slug);
  const lines = T.epicRulesLines(slug, rules);
  const kept = rules.kind === 'refused' || rules.missing ? blockLines(text, 'epic-rules') : null;
  if (rules.kind === 'refused') {
    return { lines: kept || lines, rules, kept: !!kept, warning: known && known.warned ? '' : epicRulesWarning(rules, !!kept) };
  }
  const placeholder = (k) => T.epicRulesLines(slug, { kind: k }).join('\n');
  if (kept && ![placeholder('none'), placeholder('refused')].includes(kept.join('\n'))) {
    return { lines: kept, rules, kept: true, warning: t('gen.epicRulesNoSection') };
  }
  return { lines, rules, kept: false, warning: '' };
}

// How much of a task's own Owner rules section the epic's rules already say: the section's non-blank
// lines (list numbers stripped) that are also lines of the block. { n, m }: n of its m lines; null
// for none, or no section, or no rules.
function rulesOverlap(text, rules) {
  if (!rules || rules.kind !== 'rules') return null;
  const section = ownerRulesSection(text);
  if (!section) return null;
  const norm = (l) => l.trim().replace(/^\d{1,9}[.)]\s+/, '').trim();
  const own = section.slice(1).map(norm).filter(Boolean);
  const epic = new Set(rules.body.map(norm).filter(Boolean));
  const n = own.filter((l) => epic.has(l)).length;
  return n ? { n, m: own.length } : null;
}

// The parsed key a task of an epic keeps in its state, for the epic's branch templates.
const ticketKey = (meta) => (meta.ticket ? S.parseTicket(meta.ticket) : '');

// `wsg new --epic`: a task inside the epic, the sources it takes from the epic, and the epic's
// tasks.md listing it, in one transaction — a failure removes the worktrees and the branches it
// made, the task, and puts tasks.md back. The caller holds the epic's lock.
// meta: as for create, plus epicWs and sources: specs as S.fromEpic resolved them, checked before
// the call; the epic link, the ticket key and the epic's Owner rules come from here. Rules that
// can't be read give the block a pointer to ../AGENTS.md and a warning, never a refused task.
function createInEpic(meta, cfg) {
  const ws = W.assertSafe(meta, cfg);
  const epicWs = path.resolve(meta.epicWs);
  const epic = W.readState(epicWs);
  const key = ticketKey(meta);
  const rules = epicRules(epicWs, epic.slug);
  let m;
  try {
    m = { ...meta, epicWs, epic: { slug: epic.slug }, ticketKey: key, epicRules: rules };
    // Before anything is made: a tasks.md block that can't be rendered refuses the task, not rolls it back.
    renderTasks(epicWs, epic);
  } catch (e) {
    throw Object.assign(e, { invalid: true });
  }
  if (rules.kind === 'refused') ui.warn(epicRulesWarning(rules, false));
  return guarded((txn) => {
    createSkeleton(m, cfg, txn);
    // The rules as read above: each source's render keeps the block the skeleton wrote, silently.
    for (const spec of meta.sources || []) attachSource(ws, spec, cfg, txn, { epicRules: { ...rules, warned: true } });
    const j = journal();
    txn.add(() => restore(epicWs, j));
    const r = renderTasks(epicWs, epic);
    for (const w of r.warnings) ui.warn(w);
    if (r.changed) writeOwned(epicWs, 'tasks.md', r.body, j);
    return ws;
  }, t('gen.rollingBack', { ws }));
}

// --- the status of a task or a process (wsg status, wsg close)

// How many commits of the worktree's branch are not on its upstream, or — without one — not on the
// base it was made from: { n, ref }, or null when neither can be asked. A heuristic for a warning,
// never a refusal: a branch merged by squash still counts as ahead of its base. A base that starts
// with - (a hand edit) would be read by git as an option: not asked, unknown.
function unpushedOf(dest, base) {
  const ask = (ref) => {
    const r = g.gitRun(dest, ['rev-list', '--count', `${ref}..HEAD`]);
    interrupted(r);
    const out = r.stdout.trim();
    return r.ok && /^\d+$/.test(out) ? Number(out) : null;
  };
  const up = g.gitRun(dest, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  interrupted(up);
  const upstream = up.stdout.trim();
  if (up.ok && upstream) {
    const n = ask('@{u}');
    if (n !== null) return { n, ref: upstream };
  }
  if (typeof base === 'string' && base && !base.startsWith('-')) {
    const n = ask(base);
    if (n !== null) return { n, ref: base };
  }
  return null;
}

// The state a status leaves: closed, today's date as `created` has it (T.today), only with done;
// leaving done drops it.
function withStatus(state, status) {
  const { closed, ...rest } = state;
  return status === 'done' ? { ...rest, status, closed: T.today() } : { ...rest, status };
}

// What `wsg status <task> [<status>]` would do, with nothing written: status undefined only reads.
// state: the task's or the process's, read under its locks for a change. Setting the status it has
// is a no-op (changed false) that writes nothing. Only the move to done asks git — whether each
// worktree has changes or commits that are not pushed — and only to warn: nothing is deleted.
// A task of an epic gets the epic's tasks.md block rendered as it would be, so a block that can't
// be rendered refuses the change before anything is written (createInEpic does the same).
// opts.cwd: where the command runs; done set for a task of an epic from inside the task's own
// workspace gets a warning — done is the epic session's or the owner's to set, the task's session
// sets review. A standalone task or a process has no epic session: its owner closes it from anywhere.
// A sibling task whose state doesn't read has no line in the re-rendered tasks block (childrenOf
// leaves it out): said in a warning, not dropped silently.
// Returns { next, previous, status, closed, changed, forEpicPending, sources, epicWs, epic,
// tasksMdUpdated, errors, warnings }.
function planStatus(ws, state, status, opts = {}) {
  const previous = W.statusOf(state);
  const target = status === undefined ? previous : status;
  const changed = target !== previous;
  const next = changed ? withStatus(state, target) : state;
  const errors = [];
  const warnings = [];
  const problem = W.statusProblem(state);
  if (problem && !changed) warnings.push(problem);
  const toDone = changed && target === 'done';
  // An entry that is not a source object (a hand edit) is left out, and said; it stays in the state.
  state.sources.forEach((s, i) => { if (!W.isSource(s)) warnings.push(t('list.badSource', { n: i + 1, value: JSON.stringify(s) })); });
  const sources = state.sources.filter(W.isSource).map((s) => {
    const str = (v) => (typeof v === 'string' && v ? v : null);
    const out = { name: str(s.name), mode: s.reference ? 'reference' : str(s.mode), branch: str(s.branch), dirty: null, unpushed: null };
    if (!toDone || s.mode !== 'worktree' || !out.name) return out;
    const dest = path.join(ws, s.name);
    if (!fs.existsSync(dest)) {
      warnings.push(t('status.worktreeMissing', { name: s.name }));
      return out;
    }
    try {
      const dirty = changesOf(dest);
      out.dirty = dirty.map(shownChange);
      if (dirty.length) warnings.push(t('status.dirty', { name: s.name, n: dirty.length, list: shownList(dirty, shownChange) }));
    } catch (e) {
      if (e && e.name === 'Interrupted') throw e;
      warnings.push(t('status.dirtyUnknown', { name: s.name, why: e.message }));
    }
    const ahead = unpushedOf(dest, s.base);
    out.unpushed = ahead ? ahead.n : null;
    if (!ahead) warnings.push(t('status.unpushedUnknown', { name: s.name }));
    else if (ahead.n) warnings.push(t('status.unpushed', { name: s.name, n: ahead.n, ref: ahead.ref }));
    return out;
  });
  const forEpicPending = W.forEpicPending(ws, state);
  if (target === 'done' && status !== undefined && forEpicPending) warnings.push(t('status.forEpicPending'));
  if (target === 'done' && status !== undefined && state.epic) {
    const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
    const here = real(opts.cwd || process.cwd());
    const home = real(ws);
    if (here === home || here.startsWith(home + path.sep)) warnings.push(t('status.doneFromTask', { ws }));
  }
  const epicWs = changed ? W.epicOf(ws, state) : null;
  let epic = null;
  let tasksMdUpdated = false;
  if (epicWs) {
    try {
      epic = W.epicState(epicWs);
      const r = renderTasks(epicWs, epic, { ws, state: next });
      tasksMdUpdated = r.changed;
      warnings.push(...r.warnings);
      for (const name of unreadableTasks(epicWs)) warnings.push(t('status.siblingUnreadable', { task: name }));
    } catch (e) {
      errors.push(e.message);
    }
  }
  return {
    next,
    previous,
    status: target,
    closed: target === 'done' && W.isDate(next.closed) ? next.closed : null,
    changed,
    forEpicPending,
    sources,
    epicWs,
    epic,
    tasksMdUpdated,
    errors,
    warnings,
  };
}

// The tasks of the epic whose state doesn't read, by directory name: the directories W.childrenOf
// looks at and leaves out.
function unreadableTasks(epicWs) {
  let entries;
  try { entries = fs.readdirSync(epicWs, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
    .filter((name) => {
      const dir = path.join(epicWs, name);
      if (!W.hasState(dir)) return false;
      try { W.readState(dir); return false; } catch { return true; }
    });
}

// The status planStatus planned, written: the state first, then the epic's tasks.md block, rendered
// from the states on disk — so the state has to be there first. One transaction: a failure or a
// stop signal puts both back. Nothing else is touched: no knowledge, notes or decisions, no
// AGENTS.md, CLAUDE.md or README.md, no git. The caller holds the epic's lock, then the task's.
// Returns { tasksMdUpdated }.
function applyStatus(ws, plan) {
  return guarded((txn) => {
    const j = journal();
    txn.add(() => restore(ws, j));
    writeOwned(ws, W.STATE_FILE, W.stateJson(plan.next), j);
    if (!plan.epicWs) return { tasksMdUpdated: false };
    const je = journal();
    txn.add(() => restore(plan.epicWs, je));
    // Its warnings were the plan's.
    const r = renderTasks(plan.epicWs, plan.epic);
    if (r.changed) writeOwned(plan.epicWs, 'tasks.md', r.body, je);
    return { tasksMdUpdated: r.changed };
  }, t('gen.statusRollingBack', { ws }));
}

// `wsg add`.
function add(ws, spec, cfg) {
  return guarded((txn) => attachSource(ws, spec, cfg, txn), t('gen.addRollingBack', { name: spec.name, ws }));
}

// `wsg remove`. opts: as removeSource takes them.
function remove(ws, name, cfg, opts = {}) {
  return guarded((txn) => removeSource(ws, name, cfg, txn, opts), t('gen.removeRollingBack', { name, ws }));
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
  planStatus, applyStatus, run, create, createInEpic, skeletonState, ticketKey, epicRules, epicRulesBlock, epicRulesWarning, epicDirOf, ownerRulesSection, rulesOverlap, blockLines, renderTasks, add, remove, attachSource, removeSource, planRemove, createSkeleton, renderGenerated, computeRender, applyRender, plannedFiles, changedFiles,
  RENDERED, lstat, assertNoLinks, readOwned, writeOwned, journal, restore, putFile, replaceBlock, openFence, fencedLines, guarded, transaction, cloneDir, RESERVED: W.RESERVED, sourceProblem: S.sourceProblem,
};
