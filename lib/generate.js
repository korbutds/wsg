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
const M = require('./mcp');
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
  'mr-target-branch.txt', 'repo', 'tasks.md', M.MCP_JSON];

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

// Before wsg 0.9.3 settings.json denied `git push`; now Claude Code asks (T.PUSH_RULES). Moves
// wsg's own entries found under permissions.deny to permissions.ask, in place; true when it
// changed something. Only those found: an owner who took them out of ask, or left only some of
// them, keeps that; the owner's own deny entries stay. An empty deny left behind is dropped.
function movePushRules(j) {
  const perms = j.permissions;
  if (!perms || typeof perms !== 'object' || !Array.isArray(perms.deny)) return false;
  const found = T.PUSH_RULES.filter((r) => perms.deny.includes(r));
  if (!found.length) return false;
  const deny = perms.deny.filter((r) => !T.PUSH_RULES.includes(r));
  if (deny.length) perms.deny = deny;
  else delete perms.deny;
  const ask = Array.isArray(perms.ask) ? perms.ask : [];
  perms.ask = [...ask, ...found.filter((r) => !ask.includes(r))];
  return true;
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
  let collision;
  owned(ws, j, rel, () => {
    try {
      putFile(p, body, st ? { mode: st.mode & 0o7777 } : { create: true });
    } catch (e) {
      if (st || e.code !== 'EEXIST') throw e;
      // Exclusive creation wrote nothing. A concurrent writer's file is not ours to undo.
      collision = e;
      return false;
    }
  });
  if (collision) throw collision;
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
  if (['AGENTS.md', 'CLAUDE.md', 'README.md', 'tasks.md', 'mr-target-branch.txt', 'repo', M.MCP_JSON].includes(rel)) return t('gen.keptChanged', { file: rel });
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
const THEMATIC_BREAK = /^ {0,3}([-*_])( *\1){2,} *$/;
// The column a list item's text starts at, or -1 for a line that is no list item.
function listItemText(line) {
  if (THEMATIC_BREAK.test(line)) return -1;
  const m = /^( *)([-*+]|\d{1,9}[.)])( *)(.?)/.exec(line);
  if (!m || (m[4] && !m[3])) return -1;
  const gap = m[3].length;
  return m[1].length + m[2].length + (gap >= 1 && gap <= 4 && m[4] ? gap : 1);
}

// An inline comment can span a paragraph, but it cannot absorb the next Markdown block.
function inlineCommentCloses(lines, start) {
  for (let index = start; index < lines.length; index++) {
    const line = expandTabs(lines[index].replace(/\r$/, ''));
    if (!line.trim() || /^ {0,3}(?:>|<!--|#{1,6}(?:[ \t]|$)|(?:=+|-+)[ \t]*$)/.test(line) ||
      THEMATIC_BREAK.test(line) || /^ {0,3}(?:[-*+]|1[.)]) +\S/.test(line) ||
      (fenceOpener(line)?.indent ?? 4) < 4) return false;
    if (line.includes('-->')) return true;
  }
  return false;
}

// Which lines sit inside a fenced code block (the fence lines included): a marker shown in an
// example there is text, not the block. HTML comments outside containers do not open
// fences. Track their continuation lines separately so a standalone wsg marker stays available as an anchor.
// open: the fence left unclosed at the end, if any, with the line that would close it.
function fencedLines(lines) {
  let fence = null;
  let openedAt = -1;
  let comment = false;
  const comments = new Set();
  let item = -1; // the column the current list item's text starts at; -1 outside a list
  const inside = lines.map((raw, i) => {
    if (comment) {
      comments.add(i);
      comment = !raw.includes('-->');
      return false;
    }
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
    if (raw.includes('<!--')) {
      const block = /^( {0,3})<!--/.exec(line);
      if (block && (item < 0 || block[1].length < item)) {
        comment = !line.includes('-->');
      } else if (item < 0 && /^ {0,3}\S/.test(line) && !/^ {0,3}(?:>|#{1,6}(?:[ \t]|$))/.test(line)) {
        comment = W.visibleText(raw.replace(/\\[\\<]/g, '  '), false).comment && inlineCommentCloses(lines, i + 1);
      }
    }
    return false;
  });
  return { inside, comments, open: fence ? { line: openedAt + 1, closer: fence.char.repeat(fence.len) } : null };
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
  const { inside: fenced, comments } = fencedLines(all);
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
  const after = all.findIndex((l, i) => i > front && !fenced[i] && !comments.has(i) && anchor.test(l));
  if (after >= 0) {
    let insert = after + 1;
    while (comments.has(insert)) insert++;
    all.splice(insert, 0, ...block);
    return { text: all.join('\n'), restored: true };
  }
  return { text: `${text.trimEnd()}\n\n${block.join('\n')}\n`, restored: true };
}

// The text without the block, which is taken out with its markers and nothing else: a block added
// by replaceBlock goes out leaving the text as it was before. No block, the text as it is; markers
// that don't pair are refused, as replaceBlock refuses them.
function dropBlock(text, file, name) {
  const problem = fenceProblem(text, file);
  if (problem) throw new Error(problem);
  const all = text.split('\n');
  const { opens, closes } = markersOf(all, fencedLines(all).inside, name);
  if (!opens.length && !closes.length) return text;
  if (opens.length !== 1 || closes.length !== 1 || opens[0] > closes[0]) {
    throw new Error(t('gen.markerBroken', { file, name, opens: opens.length, closes: closes.length }));
  }
  all.splice(opens[0], closes[0] - opens[0] + 1);
  return all.join('\n');
}

// The lines of the verification block. A placeholder (FILL IN) is left out when the section already
// lists commands of its own outside the block — a workspace written by hand, made an epic by wsg
// promote: its own commands are the verification, and FILL IN above them would say there is none.
function verificationBlock(state, text) {
  const lines = T.verificationLines(state);
  if (!lines.every((l) => /FILL IN/.test(l))) return lines;
  const all = text.split('\n');
  // A heading, a bullet or a marker inside a code block is none: `# run all` in a fence ends nothing.
  const fenced = fencedLines(all).inside;
  const at = all.findIndex((l, i) => !fenced[i] && /^## Verification[ \t]*$/.test(l));
  if (at < 0) return lines;
  let inBlock = false;
  for (let i = at + 1; i < all.length && (fenced[i] || !/^#{1,2} /.test(all[i])); i++) {
    if (fenced[i]) continue;
    const l = all[i].trimEnd();
    // Any block of wsg's, the fresh-base one after it included: its bullets are no commands of the owner's.
    if (/^<!-- wsg:[a-z-]+ -->$/.test(l)) inBlock = true;
    else if (/^<!-- \/wsg:[a-z-]+ -->$/.test(l)) inBlock = false;
    else if (!inBlock && /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(l) && !/FILL IN/.test(l)) return [];
  }
  return lines;
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
const NEW_BLOCKS = { advisor: '0.3.0', 'epic-rules': '0.6.1', 'epic-context': '0.7.0', 'epic-knowledge': '0.9.1', 'epic-problems': '0.9.1', description: '0.9.5',
  'fresh-base': '0.9.5' };
// The ones an epic made by an earlier wsg doesn't have yet either: the rest came before epics.
const NEW_IN_EPICS = ['epic-context', 'epic-knowledge', 'epic-problems'];

// Everything generated, computed from the state without writing: `wsg add --dry-run` lists what
// would change, and the real add writes exactly this. drop: directories of a removed source, taken
// out of additionalDirectories (anything else there may be the owner's and is kept).
// opts.fresh: names of blocks this run adds on purpose (`wsg team` its first time): no warning.
// opts.epicRules: the epic's Owner rules as epicRules read them already (createInEpic), with warned
// set once the reason they were refused has been shown; opts.epicContext: the same for the epic's
// context index (epicContext).
// opts.skipSettings: settings.json is neither read nor rendered (wsg promote keeps it as it is):
// what the last render put there stays what wsg has there.
// opts.at: the path the workspace is rendered for, when it is about to move there (wsg move plans
// at the old one): the launch line names it. Returns added: { file, name } of each block put in
// because it was missing.
function computeRender(ws, state, planned, drop = [], opts = {}) {
  const ctx = { ...renderCtx(ws, planned), ...(opts.at ? { ws: opts.at } : {}) };
  const files = [];
  const warnings = [];
  const added = [];
  // lines: the block's lines, or a function of the text as it is so far that returns them.
  const edit = (rel, blocks, create) => {
    const existing = readOwned(ws, rel);
    if (existing === null && !create) {
      warnings.push(t('gen.fileMissing', { file: rel }));
      return;
    }
    const text = existing ?? create();
    let next = text;
    for (const [name, lines, anchor] of blocks) {
      // null: a block that must not be there (the archive block of a workspace not archived).
      if (lines === null) {
        next = dropBlock(next, rel, name);
        continue;
      }
      const r = replaceBlock(next, rel, name, typeof lines === 'function' ? lines(next) : lines, anchor);
      if (r.restored) added.push({ file: rel, name });
      if (r.restored && existing !== null && !(opts.fresh || []).includes(name)) {
        // Epics came after the blocks in NEW_BLOCKS but those in NEW_IN_EPICS: a missing one was deleted by hand.
        warnings.push(NEW_BLOCKS[name] && (state.kind !== 'epic' || NEW_IN_EPICS.includes(name))
          ? t('gen.blockAdded', { file: rel, name, version: NEW_BLOCKS[name] })
          : t('gen.markerRestored', { file: rel, name }));
      }
      next = r.text;
    }
    files.push({ rel, body: next, changed: existing === null || next !== text, ...(existing === null ? { create: true } : {}) });
    return next;
  };
  const epic = state.kind === 'epic';
  // A task of an epic: the epic's Owner rules, read from ../AGENTS.md on every render (epicRulesBlock),
  // and its context index and MCP servers, from ../.claude/wsg.json (epicContext), read once here.
  const epicRead = state.epic ? opts.epicContext || epicContext(epicDirOf(ws), state.epic.slug) : null;
  let rules = null;
  const agents = edit('AGENTS.md', [
    // "process": the line of a 0.8 process workspace, which now reads as a task.
    ['advisor', T.advisorLines(), /^This is an? (task|process|epic) workspace/],
    // Only while archived (wsg archive): right after the advisor block, read before anything else.
    ['archive', state.archive ? T.archiveLines(ws, state) : null, /^<!-- \/wsg:advisor -->[ \t]*$/],
    // The epic's own index, from its own state: right after the advisor block, as the template has it.
    ...(epic ? [['epic-context', T.epicContextLines(state.slug, { kind: 'items', items: state.context || [] }, 'epic'), /^<!-- \/wsg:advisor -->[ \t]*$/]] : []),
    ...(epic ? [['epic-knowledge', T.epicKnowledgeLines(), /^<!-- \/wsg:epic-context -->[ \t]*$/]] : []),
    ...(epic ? [['epic-problems', T.epicProblemLines(), /^<!-- \/wsg:epic-knowledge -->[ \t]*$/]] : []),
    // A task of an epic: the pointers from its own state, so this block never needs the epic.
    ...(state.epic ? [['epic', T.epicLines(state), /^<!-- \/wsg:advisor -->[ \t]*$/]] : []),
    ...(state.epic ? [['epic-rules', (text) => {
      rules = epicRulesBlock(ws, state, text, opts.epicRules);
      if (rules.warning) warnings.push(rules.warning);
      return rules.lines;
    }, /^<!-- \/wsg:epic -->[ \t]*$/]] : []),
    ...(state.epic ? [['epic-context', (text) => {
      const c = epicContextBlock(ws, state, text, epicRead);
      if (c.warning) warnings.push(c.warning);
      return c.lines;
    }, /^<!-- \/wsg:epic-rules -->[ \t]*$/]] : []),
    // A task out of any epic (wsg move --out): the blocks of the epic it was in go, nothing else.
    ...(!epic && !state.epic ? [['epic', null], ['epic-rules', null], ['epic-context', null]] : []),
    // A task's description for the owner (wsg describe), where the template has it: after the epic's
    // blocks in a task of one, else after the advisor block. An epic has none (wsg promote drops it).
    ['description', epic ? null : T.descriptionLines(), state.epic ? /^<!-- \/wsg:epic-context -->[ \t]*$/ : /^<!-- \/wsg:advisor -->[ \t]*$/],
    // Right after the advisor block: both are rules for the whole session, read before the sections.
    ...(state.team ? [['team', T.teamLines(state), /^<!-- \/wsg:advisor -->[ \t]*$/]] : []),
    ['layout', T.layoutLines(state, ctx), /^## Layout[ \t]*$/m],
    ['verification', (text) => verificationBlock(state, text), /^## Verification[ \t]*$/m],
    // Only with a worktree: the last one removed takes it out, one added puts it back.
    ['fresh-base', T.freshBaseLines(state), /^<!-- \/wsg:verification -->[ \t]*$/],
  ], epic ? () => T.epicAgentsMd({ slug: state.slug, title: state.title || state.slug }, { ...ctx, state }) : null);
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
  // opts.children: the epic's tasks when the directory is no epic on disk yet (wsg promote plans one).
  if (epic) edit('tasks.md', [['tasks', T.tasksLines(W.byTaskOrder(opts.children || W.childrenOf(ws), state.taskOrder, (c) => path.basename(c.ws)), state.slug), /^# /]]);

  // The MCP servers for Claude Code (lib/mcp.js): an epic's own, or — in a task — its epic's. An
  // epic that can't be read leaves the task's MCP keys as the last render put them (its context
  // block says why). prev: what that render put there, so only wsg's entries are taken out.
  const prev = state.mcpRendered || null;
  const mcpFrom = epic ? state.mcp : epicRead && epicRead.kind !== 'refused' ? epicRead.mcp : undefined;
  const wanted = epicRead && epicRead.kind === 'refused'
    ? { servers: [], enabled: prev ? prev.enabled : [], denied: prev ? prev.denied : [] } : M.claudeWanted(mcpFrom);
  const rendered = { ...(epic ? { mcpJson: [] } : {}), enabled: [], denied: [] };
  // Only with servers to render there or wsg's entries to take out: an owner's own .mcp.json — a
  // symlink, JSON with comments — is never read otherwise, as it was not before wsg 0.7.
  if (epic && (wanted.servers.length || (prev && prev.mcpJson.length))) {
    const text = readOwned(ws, M.MCP_JSON);
    const r = M.renderMcpJson(text, wanted.servers, prev ? prev.mcpJson : [], path.join(ws, M.MCP_JSON));
    if (r.remove) files.push({ rel: M.MCP_JSON, remove: true, changed: true });
    else if (r.obj) files.push({ rel: M.MCP_JSON, body: `${JSON.stringify(r.obj, null, 2)}\n`, changed: r.changed });
    rendered.mcpJson = r.owned;
  }

  // settings.json belongs to the owner too: only additionalDirectories, the MCP keys and wsg's own
  // push entries (movePushRules) are rendered, every other key stays. Directories added by hand are
  // kept after the linked sources; the owner's own MCP entries after wsg's.
  const settingsRel = path.join('.claude', 'settings.json');
  const settingsText = opts.skipSettings ? null : readOwned(ws, settingsRel);
  let settingsChanged = false;
  if (settingsText === null) {
    if (!opts.skipSettings) warnings.push(t('gen.fileMissing', { file: settingsRel }));
    // Nothing rendered there: what the last render put there is still all wsg has there.
    if (prev) Object.assign(rendered, { enabled: prev.enabled, denied: prev.denied });
  } else {
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
      settingsChanged = true;
    }
    if (movePushRules(j)) settingsChanged = true;
    const m = M.mergeSettings(j, wanted, prev, path.join(ws, settingsRel));
    Object.assign(rendered, { enabled: m.enabled, denied: m.denied });
    if (m.changed) settingsChanged = true;
    if (settingsChanged) files.push({ rel: settingsRel, body: `${JSON.stringify(j, null, 2)}\n`, changed: true });
  }

  // What this render put there, kept in the state for the next one; no key while it is nothing.
  // A key that was there keeps its place in the file.
  const { mcpRendered: _was, ...stateRest } = state;
  const keep = Object.values(rendered).some((x) => x.length);
  state = keep ? { ...state, mcpRendered: epic ? { mcpJson: rendered.mcpJson, enabled: rendered.enabled, denied: rendered.denied } : rendered } : stateRest;

  const stateBody = W.stateJson(state);
  const stateText = readOwned(ws, W.STATE_FILE);
  files.push({ rel: W.STATE_FILE, body: stateBody, changed: stateText !== stateBody });

  // The pointer: a name to point `repo` at, null to remove it, undefined to leave it as it is.
  // Only our own pointer is ever replaced or removed — a relative link to a sibling; a source
  // named repo is an absolute one, or a directory.
  // An epic has neither: its repositories are shared checkouts, and the MR is a task's.
  if (epic) return { files, pointer: undefined, settingsChanged, warnings, added };
  // A task without code has no main repository: it changes none, and has no MR to target.
  const main = state.noCode ? null : T.mainSource(state);
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
    else writeOwned(ws, f.rel, f.body, snap, { create: f.create });
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
    ...(meta.epic ? { epic: meta.epic } : {}),
    ...(meta.epic && meta.ticketKey ? { ticket: meta.ticketKey } : {}),
    ...(meta.kind === 'epic' ? {} : { status: 'open' }),
    ...(meta.kind === 'task' && meta.noCode ? { noCode: true } : {}),
    ...(meta.kind === 'task' && meta.spec ? { spec: true } : {}),
    personalRules: !!meta.personalRules,
    created: T.today(),
    sources: [],
  };
}

// The workspace without sources: `wsg new` stops here and hands over to the agent.
// meta: { kind, slug, title, ticket, ticketUrl, personalRules } and, from generate.run,
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
  // A task's checklist; its spec and plan when it goes through the stages (wsg new --spec).
  if (meta.kind === 'task') w('checklist.md', T.checklistMd(meta));
  // Its description for the owner, when one was given (wsg new --description): normalized already.
  if (meta.kind === 'task' && meta.description) w(path.relative(ws, W.descriptionPath(ws)), `${meta.description}\n`);
  if (meta.kind === 'task' && meta.spec) {
    w('spec.md', T.specMd(meta));
    w('plan.md', T.planMd(meta));
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

// The fresh-base block comes with the first worktree: put in then, it is no news of a new wsg.
const firstWorktree = (state, r) => (r.mode === 'worktree' && !state.sources.some((x) => x.mode === 'worktree') ? ['fresh-base'] : []);

// One source into an existing workspace: the worktree or symlink, its rule, then everything
// rendered from the new state. The undo steps cover only this source and the files it re-rendered.
// spec: as source.resolve returns it; spec.adopt: the symlink is there already, pointing to the
// source (wsg add --link of a hand-made link): it is registered, never made or removed. Returns
// { source, settingsChanged }.
// opts.epicRules, opts.epicContext: as computeRender takes them; opts.adoptRule: a rule file already
// at the source's path is taken as it is, whoever wrote it (wsg unarchive: the archive kept it).
function attachSource(ws, spec, cfg, txn, opts = {}) {
  const state = W.readState(ws);
  const { adopt, ...given } = spec;
  const r = { ...given, carry: [...(given.carry || [])] };
  const dest = path.join(ws, r.name);
  const ruleRel = path.join('.claude', 'rules', `${r.name}.md`);
  // Checked before the first change: the render throws on what it can't handle (a broken marker,
  // settings.json that doesn't parse), and that must refuse the add, not roll it back.
  const fresh = firstWorktree(state, r);
  computeRender(ws, { ...state, sources: [...state.sources, r] }, r, [], { epicRules: opts.epicRules, epicContext: opts.epicContext, fresh });
  // A link taken as it is keeps the rule it may have: someone made the link, and maybe the rule too.
  const keptRule = opts.adoptRule || adopt ? readOwned(ws, ruleRel) : null;
  if (keptRule === null) assertRuleFree(ws, ruleRel);

  const before = journal();
  txn.add(() => restore(ws, before));
  // Checked again right before: the link taken as it is must still be there, leading to the source.
  if (adopt && !S.linksTo(dest, r.path)) throw new Error(t('add.taken', { name: r.name }));
  if (lstat(dest) && !adopt) {
    // Only the repo pointer may stand where a source named repo goes: it is rendered again below.
    if (!S.isRepoPointer(ws, r.name)) throw new Error(t('add.taken', { name: r.name }));
    owned(ws, before, r.name, (p) => fs.unlinkSync(p));
  }
  let backupBranch = null;
  if (adopt) {
    ui.info(t('gen.symlinkAdopted', { name: r.name, path: r.path }));
  } else if (r.mode === 'worktree') {
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
  if (keptRule === null) writeOwned(ws, ruleRel, T.ruleMd(r, { epic: state.kind === 'epic', noCode: !!state.noCode }), before);

  const next = { ...state, sources: [...state.sources, r] };
  const rendered = computeRender(ws, next, null, [], { epicRules: opts.epicRules, epicContext: opts.epicContext, fresh });
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

// What the ignored files of a worktree are now, in one hash: every listed path (relative to dest, a
// directory with a trailing /) and everything under it, each with its type, size, mtime, ctime and
// inode (a symlink with its target), read with lstat only (a symlink is never followed), sorted,
// sha256. A file made, changed, deleted or put in place under the same name gives another hash —
// restoring the mtime (touch -r, cp -p) or renaming a copy over it does not hide it: ctime and inode
// change. So a list agreed to as `build/` agrees to what build/ held then only. Something under a
// listed path that does not read gives `unreadable:` and a value never given twice: it can't be
// verified, so it never matches (UNREADABLE). files: as ignoredLeft gives them. null for no files.
const UNREADABLE = 'unreadable:';
function ignoredStamp(dest, files) {
  if (!files.length) return null;
  const lines = [];
  let unreadable = false;
  const walk = (rel) => {
    const abs = path.join(dest, rel);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch (e) {
      if (e && e.code === 'ENOENT') lines.push(`${rel}\0-`);
      else unreadable = true;
      return;
    }
    const type = st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : st.isFile() ? 'f' : 'o';
    let target = '';
    if (type === 'l') {
      try {
        target = fs.readlinkSync(abs);
      } catch {
        unreadable = true;
      }
    }
    lines.push(`${rel}\0${type}\0${st.size}\0${st.mtimeMs}\0${st.ctimeMs}\0${st.ino}\0${target}`);
    if (type !== 'd') return;
    let names;
    try {
      names = fs.readdirSync(abs);
    } catch {
      unreadable = true;
      return;
    }
    for (const n of names) walk(path.join(rel, n));
  };
  for (const f of [...new Set(files.map((x) => x.replace(/\/+$/, '')))]) walk(f);
  if (unreadable) return `${UNREADABLE}${crypto.randomUUID()}`;
  lines.sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

// Whether a stamp could not be made: something under the listed paths does not read.
const unverifiable = (stamp) => typeof stamp === 'string' && stamp.startsWith(UNREADABLE);

// A path as --expect-ignored compares it: NFC, so a name typed or stored decomposed is the same name.
const nfc = (p) => p.normalize('NFC');

// The text of an --expect-ignored file: a leading BOM dropped, then JSON. Throws an Error with a
// fixed message — the parser's own would quote the file.
function parseExpectJson(text) {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(t('expect.bad', { why: t('expect.notJson') }));
  }
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

// The commit HEAD of a worktree is on when it is detached and no local branch contains it: once the
// worktree goes, nothing keeps it (only the reflog, for a while). null on a branch, or on a commit
// some branch has — a detached HEAD at a branch's tip included. Throws when git can't tell.
function detachedCommit(dest) {
  const sym = g.gitRun(dest, ['symbolic-ref', '-q', 'HEAD']);
  interrupted(sym);
  if (sym.ok) return null;
  if (sym.status !== 1) throw new Error(`git symbolic-ref: ${sym.out.trim() || `exit ${sym.status}`}`);
  const head = g.gitRun(dest, ['rev-parse', '--verify', '-q', 'HEAD']);
  interrupted(head);
  if (!head.ok) throw new Error(`git rev-parse HEAD: ${head.out.trim() || 'no commit'}`);
  const sha = head.stdout.trim();
  return g.gitList(dest, ['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/heads']).trim() ? null : sha;
}

// Edits git status does not show: files marked skip-worktree (S) or assume-unchanged (a lowercase
// tag) whose bytes are not the index entry's. git worktree remove deletes them silently. As { xy,
// path } like changesOf, xy "S " or "h ". A file that is not there (a sparse checkout) is no edit; a
// changed executable bit is one, unless core.fileMode is false there: git itself ignores the bit then.
// The blob is hashed here as git hashes it with no filter: a file a clean filter or autocrlf would
// change reads as edited — a refusal, never a loss.
function hiddenChanges(dest) {
  const out = [];
  let fileMode = null;
  for (const entry of g.gitList(dest, ['ls-files', '-v', '-s', '-z']).split('\0')) {
    const m = /^(\S) (\d{6}) ([0-9a-f]{40,64}) \d\t([\s\S]*)$/.exec(entry);
    if (!m || !(m[1] === 'S' || /[a-z]/.test(m[1]))) continue;
    const [, tag, mode, sha, rel] = m;
    const p = path.join(dest, rel);
    const st = lstat(p);
    if (!st) continue;
    let data;
    if (mode === '120000') data = st.isSymbolicLink() ? Buffer.from(fs.readlinkSync(p)) : null;
    else data = st.isFile() ? fs.readFileSync(p) : null;
    // The executable bit as git records it: 100755 when the owner may run it.
    // Asked once, only when a hidden file is there: the worktree's own config, then the repository's.
    if (fileMode === null) fileMode = g.git(dest, ['config', '--bool', 'core.fileMode']) !== 'false';
    const modeSame = mode === '120000' || mode === '160000' || !fileMode || (st.mode & 0o100 ? '100755' : '100644') === mode;
    const algo = sha.length === 64 ? 'sha256' : 'sha1';
    const same = data !== null && modeSame && crypto.createHash(algo).update(`blob ${data.length}\0`).update(data).digest('hex') === sha;
    if (!same) out.push({ xy: tag === 'S' ? 'S ' : 'h ', path: rel });
  }
  return out;
}

// Commits the worktree's own HEAD reflog has that no local branch contains, but for HEAD itself
// (detachedCommit refuses that one): checked out once, then left. They become unreachable once the
// worktree goes — git gc may drop them. Said, never refused. Returns their shas, newest first.
function reflogOnly(dest) {
  // Listings of any size (gitList): a cut one would read as a stop. A warning only: anything git
  // can't tell is no warning.
  const list = (args) => {
    try {
      return g.gitList(dest, args);
    } catch (e) {
      if (e && e.name === 'Interrupted') throw e;
      return null;
    }
  };
  const shas = (text) => [...new Set((text || '').split('\n').map((x) => x.trim()).filter((x) => /^[0-9a-f]{40,64}$/.test(x)))];
  const head = list(['rev-parse', '--verify', '-q', 'HEAD']);
  const seen = shas(list(['reflog', 'show', '--format=%H', 'HEAD'])).filter((x) => x !== (head || '').trim());
  if (!seen.length) return [];
  // Commits no branch has (rev-list --not --branches) among those reachable from a list of them.
  const loose = (from) => {
    const r = spawnSync('git', ['-C', dest, 'rev-list', '--ignore-missing', '--stdin', '--not', '--branches'],
      { input: from.join('\n'), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (STOP_SIGNALS.includes(r.signal)) throw interruptedError();
    return r.status === 0 && !r.error ? new Set(r.stdout.split('\n').filter(Boolean)) : null;
  };
  const left = loose(seen);
  if (!left || !left.size) return [];
  // A branch's own reflog has the commits an amend or a rebase replaced: no loss to report there.
  const fromBranches = shas(list(['log', '-g', '--format=%H', '--branches']));
  const replaced = fromBranches.length ? loose(fromBranches) || new Set() : new Set();
  return seen.filter((x) => left.has(x) && !replaced.has(x));
}

// Whether git worktree remove would refuse the worktree for what it holds besides files: a lock
// (git worktree lock), or a submodule in it — a modules directory in its git directory, or a
// submodule checked out. Found in the plan, before anything goes: refused there, never half-way
// through an archive. Returns the refusals in words; throws when git can't list them.
function removalRefusals(dest, r) {
  const out = [];
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  let at = null;
  for (const line of g.gitList(r.path, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) at = real(line.slice(9));
    else if ((line === 'locked' || line.startsWith('locked ')) && at === real(dest)) {
      out.push(t('remove.locked', { name: r.name, why: line.slice(7).trim() || '-' }));
    }
  }
  const gd = g.gitRun(dest, ['rev-parse', '--git-dir']);
  interrupted(gd);
  const subs = [];
  if (gd.ok && fs.existsSync(path.join(path.resolve(dest, gd.stdout.trim()), 'modules'))) subs.push('.git/modules');
  // The whole index, up to gitList's cap: a repository of tens of thousands of files is many MiB.
  for (const entry of g.gitList(dest, ['ls-files', '-s', '-z']).split('\0')) {
    const m = /^160000 \S+ \d\t([\s\S]*)$/.exec(entry);
    if (m && lstat(path.join(dest, m[1], '.git'))) subs.push(m[1]);
  }
  if (subs.length) out.push(t('remove.submodules', { name: r.name, list: shownList(subs) }));
  return out;
}

// What stands in the way of removing a worktree that is there, read before anything is touched (wsg
// remove, wsg archive): { branch, dirty, ignored, detached, errors, notes }. Untracked files count as
// changes: git worktree remove refuses them too, and they exist nowhere else; so do edits hidden by
// skip-worktree or assume-unchanged (hiddenChanges). A lock or a submodule refuses it too. Ignored ones git
// deletes silently: refused too, unless they are copies wsg made, or opts.deleteIgnored — the owner
// agreed to lose them. A detached HEAD on a commit no branch has is refused: the branch is what is
// kept. errors: the refusals in words; notes: what is said, never refused.
function worktreeBlockers(dest, r, opts = {}) {
  const out = { branch: g.git(dest, ['branch', '--show-current']) || r.branch, dirty: [], ignored: [], detached: null, errors: [], notes: [] };
  try {
    const seen = changesOf(dest);
    const hidden = hiddenChanges(dest);
    out.dirty = [...seen, ...hidden];
    if (seen.length) out.errors.push(t('remove.dirty', { name: r.name, list: shownList(seen, shownChange) }));
    if (hidden.length) out.errors.push(t('remove.hidden', { name: r.name, list: shownList(hidden, shownChange) }));
  } catch (e) {
    out.errors.push(listRefusal(e, r.name, 'remove.statusFailed'));
  }
  try {
    out.ignored = ignoredLeft(dest, r);
  } catch (e) {
    out.errors.push(listRefusal(e, r.name, 'remove.listFailed'));
  }
  const nm = r.cloneNm ? t('remove.nmNotChecked', { name: r.name }) : '';
  if (nm) out.notes.push(nm);
  if (out.ignored.length && !opts.deleteIgnored) {
    out.errors.push(t('remove.ignored', { name: r.name, list: shownList(out.ignored) }) + (nm ? `\n  ${nm}` : ''));
  }
  try {
    out.detached = detachedCommit(dest);
    if (out.detached) out.errors.push(t('remove.detached', { name: r.name, sha: out.detached }));
  } catch (e) {
    out.errors.push(listRefusal(e, r.name, 'remove.headFailed'));
  }
  try {
    out.errors.push(...removalRefusals(dest, r));
  } catch (e) {
    out.errors.push(listRefusal(e, r.name, 'remove.refusalsFailed'));
  }
  const loose = reflogOnly(dest);
  if (loose.length) out.notes.push(t('remove.reflogOnly', { name: r.name, n: loose.length, list: shownList(loose) }));
  return out;
}

// What `wsg remove` checks before it touches anything. Returns { source, branch, ignored, errors,
// files, settingsChanged, warnings }: the worktree must be clean, since nothing of it can be brought
// back. opts.deleteIgnored: the owner agreed to lose the ignored files listed in `ignored`.
function planRemove(ws, name, opts = {}) {
  const state = W.readState(ws);
  const errors = [];
  const r = state.sources.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!r) {
    errors.push(t('remove.unknown', { name, list: state.sources.map((x) => x.name).join(', ') || '—' }));
    return { source: null, ignored: [], ignoredStamp: null, errors, files: [], settingsChanged: false, warnings: [] };
  }
  const dest = path.join(ws, r.name);
  let branch = '';
  let ignored = [];
  let stamp = null;
  const notes = [];
  const destSt = lstat(dest);
  // A symlink where the worktree goes: git would remove whatever it points to.
  if (r.mode === 'worktree' && destSt && destSt.isSymbolicLink()) errors.push(t('remove.worktreeIsLink', { name: r.name }));
  else if (r.mode === 'worktree' && destSt) {
    const b = worktreeBlockers(dest, r, opts);
    ({ branch, ignored } = b);
    stamp = ignoredStamp(dest, ignored);
    errors.push(...b.errors);
    notes.push(...b.notes);
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
    ignoredStamp: stamp,
    errors,
    files: [r.name, path.join('.claude', 'rules', `${r.name}.md`), ...changedFiles(rendered)],
    settingsChanged: rendered.settingsChanged,
    warnings: [...notes, ...rendered.warnings],
  };
}

// The text of `wsg remove --expect-ignored`: {ignored, ignoredStamp} from the result of an earlier
// `wsg remove --dry-run --json` (the whole result does too: other keys are not read) — ignored the
// absolute paths, ignoredStamp the hash of what they held (ignoredStamp()). Returns { files, stamp }:
// the paths NFC, each once, sorted. Throws an Error whose message says what is wrong.
function parseExpectFiles(text) {
  const doc = parseExpectJson(text);
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(t('expect.bad', { why: t('expect.notRemove') }));
  if (!Array.isArray(doc.ignored) || !(doc.ignoredStamp === null || typeof doc.ignoredStamp === 'string')) {
    throw new Error(t('expect.bad', { why: t('expect.notRemove') }));
  }
  const bad = doc.ignored.findIndex((f) => typeof f !== 'string' || f === '');
  if (bad >= 0) throw new Error(t('expect.bad', { why: t('expect.badFile', { n: bad + 1 }) }));
  return { files: [...new Set(doc.ignored.map(nfc))].sort(), stamp: doc.ignoredStamp };
}

// --expect-ignored for wsg remove: the plan's ignored files (plan.ignored, relative to the worktree)
// must be exactly the expected ones, and hold what they held (the stamps equal). A difference refuses
// the plan, ignoredChanged set, the message listing the files as they are now; equal, the removal
// agrees to those files, as they were, only (agreed, agreedStamp: removeSource checks both again).
function expectRemoveIgnored(ws, plan, expected) {
  if (!plan.source) return plan;
  const base = path.join(ws, plan.source.name);
  const abs = plan.ignored.map((f) => path.join(base, f));
  const seen = [...new Set(abs.map(nfc))].sort();
  if (unverifiable(plan.ignoredStamp)) {
    plan.errors.unshift(t('expect.unverifiable', { name: plan.source.name }));
    return plan;
  }
  if (JSON.stringify(seen) !== JSON.stringify(expected.files) || (plan.ignoredStamp || null) !== (expected.stamp || null)) {
    plan.ignoredChanged = true;
    plan.errors.unshift(t('expect.changed', { list: abs.length ? shownList(abs) : `    ${t('expect.none')}` }));
    return plan;
  }
  plan.agreed = [...plan.ignored];
  plan.agreedStamp = plan.ignoredStamp;
  return plan;
}

// The undo of a worktree's removal. Gone: added back on the same branch — the files copied in at
// creation (.env, node_modules) and the ignored files deleted with it are not. Still there, part of it
// deleted (a stop signal, a failure in the middle of git's removal): the tracked files deleted come
// back from its index — only the deleted ones, so nothing in it is overwritten; untracked files there
// were none (the plan refused them). Its .git file gone with them while git's own directory for it
// (<repo>/.git/worktrees/<id>) is still there: the file is written back first, then the same. Anything
// else is reported as left half-removed, and the rollback as incomplete.
function undoWorktreeRemove(r, dest, branch) {
  if (!lstat(dest)) {
    g.gitRun(r.path, ['worktree', 'prune']);
    const back = g.gitRun(r.path, ['worktree', 'add', dest, branch]);
    if (back.ok) {
      ui.err(t('gen.worktreeReadded', { name: r.name, branch }));
      return undefined;
    }
    ui.err(t('gen.worktreeReaddFailed', { name: r.name, branch, out: back.out.trim() }));
    return { failed: 1 };
  }
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  if (!lstat(path.join(dest, '.git'))) relinkWorktree(r, dest, real);
  const top = g.gitRun(dest, ['rev-parse', '--show-toplevel']);
  if (top.ok && real(top.stdout.trim()) === real(dest)) {
    let files = null;
    try { files = [...new Set(g.gitList(dest, ['ls-files', '-d', '-z']).split('\0').filter(Boolean))]; } catch { /* reported below */ }
    if (files && !files.length) return undefined;
    if (files) {
      // The paths on stdin: tens of thousands of them would not fit in an argument list.
      const back = spawnSync('git', ['-C', dest, 'checkout', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: files.join('\0'), encoding: 'utf8' });
      if (back.status === 0) {
        ui.err(t('gen.worktreeRestored', { name: r.name, n: files.length }));
        return undefined;
      }
    }
  }
  ui.err(t('gen.worktreePartial', { name: r.name, path: dest, branch }));
  return { failed: 1 };
}

// A worktree's .git file deleted while git's directory for it is still there: the directory whose
// gitdir file names <dest>/.git is found among the repository's worktrees and the .git file written
// back to point at it. Nothing found or anything failing: nothing written, the caller reports the rest.
function relinkWorktree(r, dest, real) {
  const common = g.gitRun(r.path, ['rev-parse', '--git-common-dir']);
  if (!common.ok) return;
  const root = path.join(path.resolve(r.path, common.stdout.trim()), 'worktrees');
  let ids = [];
  try { ids = fs.readdirSync(root); } catch { return; }
  const at = real(dest);
  for (const id of ids) {
    let named = '';
    try { named = fs.readFileSync(path.join(root, id, 'gitdir'), 'utf8').trim(); } catch { continue; }
    const target = path.isAbsolute(named) ? named : path.resolve(root, id, named);
    if (!named || path.basename(target) !== '.git' || real(path.dirname(target)) !== at) continue;
    try { fs.writeFileSync(path.join(dest, '.git'), `gitdir: ${path.join(root, id)}\n`, { flag: 'wx' }); } catch { /* reported by the caller */ }
    return;
  }
}

// One source out of the workspace: the worktree (never forced, the branch is kept) or the symlink,
// its rule, its state entry, then everything rendered without it. Undo puts it all back.
// opts: { deleteIgnored, ignored } from planRemove — the ignored files the owner agreed to lose;
// ignoredStamp (--expect-ignored): what they held when agreed to, ignoredStamp() of them;
// keepRule: the rule stays as it is (wsg archive: wsg unarchive takes it back).
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
  if (r.mode === 'worktree' && st && st.isSymbolicLink()) throw Object.assign(new Error(t('remove.worktreeIsLink', { name: r.name })), { invalid: true });
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
      throw Object.assign(new Error(t('remove.ignoredAppeared', { name: r.name, list: shownList(appeared) })), { invalid: true, ignoredChanged: true });
    }
    // --expect-ignored: the files agreed to must still hold what the owner was shown.
    if (opts.deleteIgnored && opts.ignoredStamp !== undefined && ignoredStamp(dest, opts.ignored || []) !== opts.ignoredStamp) {
      throw Object.assign(new Error(t('expect.stampChanged', { name: r.name, list: shownList(opts.ignored || []) })), { invalid: true, ignoredChanged: true });
    }
  }

  const before = journal();
  txn.add(() => restore(ws, before));
  let branch = '';
  if (r.mode === 'worktree') {
    if (st) {
      branch = g.git(dest, ['branch', '--show-current']) || r.branch;
      if (r.cloneNm) ui.warn(t('remove.nmNotChecked', { name: r.name }));
      // Registered before the call, as attachWorktree does: a stop signal or a failure in the middle of
      // git's removal leaves part of the worktree, and the undo deals with that too.
      txn.add(() => undoWorktreeRemove(r, dest, branch));
      // Without --force: git refuses a worktree with changes, a locked one, one with submodules.
      const res = g.gitRun(r.path, ['worktree', 'remove', dest]);
      interrupted(res);
      if (!res.ok) throw new Error(t('remove.worktreeFailed', { name: r.name, out: res.out.trim() }));
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
  const rule = opts.keepRule ? null : readOwned(ws, ruleRel);
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
  const { adopt, ...r } = spec;
  const ruleRel = path.join('.claude', 'rules', `${r.name}.md`);
  // A link taken as it is (attachSource): the link is not written, a rule there is kept.
  const keptRule = adopt && readOwned(ws, ruleRel) !== null;
  if (!keptRule) assertRuleFree(ws, ruleRel);
  const rendered = computeRender(ws, { ...state, sources: [...state.sources, r] }, r, [], { fresh: firstWorktree(state, r) });
  return {
    files: [...(adopt ? [] : [r.name]), ...(keptRule ? [] : [ruleRel]), ...changedFiles(rendered)],
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
  // In the order of the state given: wsg reorder renders the block from the state it will write.
  const children = W.byTaskOrder(W.childrenOf(epicWs), epicState.taskOrder, (c) => path.basename(c.ws)).map((c) => (override && path.basename(c.ws) === path.basename(override.ws)
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

// The context index of the epic at epicWs (`wsg context`), for the <!-- wsg:epic-context --> block of
// its tasks: { kind: 'items', items, mcp } — the epic's state.context, [] without one, and its
// state.mcp (`wsg mcp`), undefined without one, for the tasks' MCP keys; { kind: 'refused',
// why } — the epic can't be read (moved, not an epic, another slug, a state that doesn't read).
// Never throws, takes no lock: a task must render, and a new task be made, whatever the epic's state.
function epicContext(epicWs, slug) {
  const refused = (why) => ({ kind: 'refused', why });
  try {
    if (!W.hasState(epicWs)) return refused(t('gen.epicRulesWhy.notWorkspace', { dir: epicWs }));
    const epic = W.readState(epicWs);
    if (epic.kind !== 'epic') return refused(t('gen.epicRulesWhy.notEpic', { dir: epicWs, kind: epic.kind }));
    if (epic.slug !== slug) return refused(t('gen.epicRulesWhy.otherEpic', { dir: epicWs, found: epic.slug, slug }));
    return { kind: 'items', items: epic.context || [], mcp: epic.mcp };
  } catch (e) {
    return refused((e && e.message) || String(e));
  }
}

// The <!-- wsg:epic-context --> block of a task of an epic, from the epic as it is now: { lines,
// context, kept, warning }. text: the task's AGENTS.md as it is. An epic that can't be read keeps the
// block as it is on disk (render and disk agree, check does not call it stale), or — none there yet —
// gets a line pointing to ../context/, with a warning; never a refusal, as for the Owner rules.
// known: epicContext already read (createInEpic); known.warned: its warning was shown.
function epicContextBlock(ws, state, text, known) {
  const slug = state.epic.slug;
  const context = known || epicContext(epicDirOf(ws), slug);
  const lines = T.epicContextLines(slug, context, 'task');
  if (context.kind !== 'refused') return { lines, context, kept: false, warning: '' };
  const kept = blockLines(text, 'epic-context');
  const warning = known && known.warned ? '' : t(kept ? 'gen.epicContextKept' : 'gen.epicContextPlaceholder', { why: context.why });
  return { lines: kept || lines, context, kept: !!kept, warning };
}

// Every task of the epic rendered again, each under its own lock, after a change of the epic that its
// tasks render (`wsg context`; the caller holds the epic's lock, taken first, as add takes them).
// Each task is its own transaction: one that is busy, can't be rendered or fails is reported and
// keeps what it had — the epic's change stays, the task catches up at its next `wsg refresh`
// (`wsg check` in the epic names it). A task that is done or archived is left as it is; so is one
// whose state names another epic. opts.dryRun: nothing is locked or written, every other task listed with
// refreshed false and no reason. opts.stop(): true once the caller was asked to stop (a signal
// between two tasks): the tasks left are not refreshed.
// Returns [{ task, path, refreshed, code, reason }], one per task directory of the epic, by name (one
// whose state doesn't read included, as failed): code, to branch on, is null when refreshed (or
// in a dry run), else 'done', 'archived', 'other_epic', 'busy', 'interrupted' or 'failed'; reason is the same
// in words, for people. A task's warnings go out through ui, its name in front.
async function refreshEpicTasks(epicWs, opts = {}) {
  const out = [];
  let stopped = false;
  for (const c of W.childrenOf(epicWs)) {
    const task = path.basename(c.ws);
    const entry = (refreshed, code = null, reason = null) => out.push({ task, path: c.ws, refreshed, code, reason });
    if (c.mismatch) { entry(false, 'other_epic', t('fanout.otherEpic', { epic: c.state.epic.slug })); continue; }
    if (W.isArchived(c.state)) { entry(false, 'archived', t('fanout.archived')); continue; }
    if (W.statusOf(c.state) === 'done') { entry(false, 'done', t('fanout.done')); continue; }
    if (!stopped && opts.stop && opts.stop()) stopped = true;
    if (stopped) { entry(false, 'interrupted', t('fanout.interrupted')); continue; }
    if (opts.dryRun) { entry(false); continue; }
    let release = null;
    try {
      release = lock.acquire(c.ws, { signals: false });
      // Read again under its lock: it may have been closed in between.
      const state = W.readState(c.ws);
      if (W.isArchived(state)) { entry(false, 'archived', t('fanout.archived')); continue; }
      if (W.statusOf(state) === 'done') { entry(false, 'done', t('fanout.done')); continue; }
      const rendered = computeRender(c.ws, state, null);
      await guarded((txn) => {
        const j = journal();
        txn.add(() => restore(c.ws, j));
        applyRender(c.ws, { ...rendered, warnings: [] }, j);
      }, t('fanout.rollingBack', { task }));
      for (const w of rendered.warnings) ui.warn(`${task}: ${w}`);
      entry(true);
    } catch (e) {
      if (e && e.name === 'Interrupted') {
        stopped = true;
        entry(false, 'interrupted', t('fanout.interrupted'));
      } else entry(false, e && e.busy ? 'busy' : 'failed', (e && e.message) || String(e));
    } finally {
      if (release) release();
    }
  }
  // A task directory whose state doesn't read: W.childrenOf leaves it out, the report does not.
  for (const task of unreadableTasks(epicWs)) {
    let reason = '';
    try { W.readState(path.join(epicWs, task)); } catch (e) { reason = e.message; }
    out.push({ task, path: path.join(epicWs, task), refreshed: false, code: 'failed', reason });
  }
  return out.sort((x, y) => (x.task < y.task ? -1 : x.task > y.task ? 1 : 0));
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
  const context = epicContext(epicWs, epic.slug);
  let m;
  try {
    m = { ...meta, epicWs, epic: { slug: epic.slug }, ticketKey: key, epicRules: rules, epicContext: context };
    // Before anything is made: a tasks.md block that can't be rendered refuses the task, not rolls it back.
    renderTasks(epicWs, epic);
  } catch (e) {
    throw Object.assign(e, { invalid: true });
  }
  if (rules.kind === 'refused') ui.warn(epicRulesWarning(rules, false));
  if (context.kind === 'refused') ui.warn(t('gen.epicContextPlaceholder', { why: context.why }));
  return guarded((txn) => {
    createSkeleton(m, cfg, txn);
    // The rules and the context as read above: each source's render keeps the blocks the skeleton
    // wrote, silently.
    for (const spec of meta.sources || []) {
      attachSource(ws, spec, cfg, txn, { epicRules: { ...rules, warned: true }, epicContext: { ...context, warned: true } });
    }
    // The epic's MCP servers: enabled, and its disabled globals denied, in the task's settings.json
    // from the start. The rest of the render is what the skeleton and the sources wrote already.
    if (context.kind === 'items' && context.mcp) {
      const r = computeRender(ws, W.readState(ws), null, [], { epicRules: { ...rules, warned: true }, epicContext: { ...context, warned: true } });
      applyRender(ws, r);
    }
    const j = journal();
    txn.add(() => restore(epicWs, j));
    const r = renderTasks(epicWs, epic);
    for (const w of r.warnings) ui.warn(w);
    if (r.changed) writeOwned(epicWs, 'tasks.md', r.body, j);
    return ws;
  }, t('gen.rollingBack', { ws }));
}

// --- the status of a task (wsg status, wsg close)

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
// state: the task's, read under its locks for a change. Setting the status it has
// is a no-op (changed false) that writes nothing. Only the move to done asks git — whether each
// worktree has changes or commits that are not pushed — and only to warn: nothing is deleted.
// A task of an epic gets the epic's tasks.md block rendered as it would be, so a block that can't
// be rendered refuses the change before anything is written (createInEpic does the same).
// opts.cwd: where the command runs; done set for a task of an epic from inside the task's own
// workspace gets a warning — done is the epic session's or the owner's to set, the task's session
// sets review. A standalone task has no epic session: its owner closes it from anywhere.
// An archived one reads, but its status is not changed: wsg unarchive puts back the one it had.
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
  if (changed && state.archive !== undefined) {
    errors.push(t('status.archived', { task: path.basename(ws), date: W.archivedOn(state) || '?' }));
  }
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
  if (target === 'done' && status !== undefined && forEpicPending) warnings.push(t('status.forEpicPending', { task: path.basename(ws) }));
  // Unchecked items of checklist.md when the task goes to review or done: said, never refused.
  const read = W.checklistOf(ws, state);
  const list = read && !read.unreadable ? read : null;
  const checklist = list ? { done: list.done, total: list.total } : null;
  // A checklist still at its FILL IN line is wsg check's to say (after the setup), not the move's.
  if (changed && (target === 'review' || target === 'done') && list && list.done < list.total) {
    warnings.push(t('status.checklistUnchecked', { n: list.total - list.done, total: list.total }));
  }
  if (target === 'done' && status !== undefined && state.epic) {
    const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
    const here = real(opts.cwd || process.cwd());
    const home = real(ws);
    if (here === home || here.startsWith(home + path.sep)) warnings.push(t('status.doneFromTask', { ws }));
  }
  const epicWs = changed ? W.epicOf(ws, state) : null;
  // A done task of an epic reopened: the epic's changes it was left out of while done (its context
  // index, its MCP servers) are rendered into it with the new status, in the same transaction. A
  // render that can't be done never stops the reopening: a warning, and wsg refresh later.
  let rendered = null;
  if (changed && previous === 'done' && target !== 'done' && state.epic) {
    try {
      rendered = computeRender(ws, next, null);
      warnings.push(...rendered.warnings);
    } catch (e) {
      warnings.push(t('status.reopenNotRendered', { why: e.message }));
    }
  }
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
    checklist,
    sources,
    epicWs,
    epic,
    tasksMdUpdated,
    rendered,
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
    // A reopened task of an epic: its state with the rest of its render; its warnings were the plan's.
    if (plan.rendered) applyRender(ws, { ...plan.rendered, warnings: [] }, j);
    else writeOwned(ws, W.STATE_FILE, W.stateJson(plan.next), j);
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
// a: { kind, slug, title, ticket, ticketUrl, personalRules, problem, dod, …,
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
  changesOf, hiddenChanges, reflogOnly, removalRefusals, undoWorktreeRemove, ignoredLeft, shownList, shownChange, listRefusal, unpushedOf, detachedCommit, worktreeBlockers, unreadableTasks, interrupted, dropBlock,
  planStatus, applyStatus, run, create, createInEpic, skeletonState, ticketKey, epicRules, epicRulesBlock, epicContext, epicContextBlock, refreshEpicTasks, NEW_BLOCKS, epicRulesWarning, epicDirOf, ownerRulesSection, rulesOverlap, blockLines, renderTasks, add, remove, attachSource, removeSource, planRemove, parseExpectFiles, expectRemoveIgnored, ignoredStamp, unverifiable, parseExpectJson, nfc, createSkeleton, renderGenerated, computeRender, applyRender, plannedFiles, changedFiles,
  RENDERED, lstat, assertNoLinks, readOwned, writeOwned, owned, journal, restore, putFile, replaceBlock, openFence, fencedLines, guarded, transaction, cloneDir, RESERVED: W.RESERVED, sourceProblem: S.sourceProblem,
};
