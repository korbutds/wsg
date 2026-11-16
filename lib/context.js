'use strict';

// `wsg context`: what an epic's tasks may read when they touch the topic — files copied into
// <epic>/context/, notes written to context/notes/<id>.md, links kept in the state only. The index
// is the epic's state.context (lib/workspace.js CONTEXT); every render of the epic and of its tasks
// turns it into the <!-- wsg:epic-context --> block of their AGENTS.md (templates.epicContextLines).
// Each command plans first — nothing touched, every refusal collected — then writes the epic in one
// transaction (generate.guarded), then the caller refreshes the epic's tasks
// (generate.refreshEpicTasks): a task that can't be refreshed is reported, the epic's change stays.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const W = require('./workspace');
const T = require('./templates');
const generate = require('./generate');
const { t } = require('./i18n');

const { CONTEXT } = W;
const DIR = 'context';
const NOTES = path.join(DIR, 'notes');

const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const realOf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// The task's block for these items: what every task of the epic pays on every request, markers
// included. The epic's own block is a few bytes shorter (no ../).
const blockBytes = (slug, items) => Buffer.byteLength(T.marked('epic-context', T.epicContextLines(slug, { kind: 'items', items }, 'task')));

// An item as --json gives it: every key always there, the path absolute, null where it does not apply.
function itemResult(epicWs, x) {
  if (!x) return null;
  return {
    id: x.id,
    type: x.type,
    title: x.title,
    description: x.description,
    url: x.type === 'link' ? x.url : null,
    path: x.type === 'link' ? null : path.join(epicWs, x.path),
    bytes: x.type === 'link' ? null : x.bytes,
    binary: x.type === 'file' ? x.binary : false,
    // Whether `wsg context remove` deletes its file: a file wsg copied in, or a note; not a file that
    // was in context/ already and was only listed.
    copied: x.type === 'note' || (x.type === 'file' && x.copied),
  };
}

// Why `<epic>/context` can't hold the context, or '': an epic made before wsg 0.7 may have a task or
// a source of that name (RESERVED keeps new ones from taking it), or a file or a link put there.
function takenProblem(epicWs, state) {
  const src = state.sources.find((s) => W.isSource(s) && typeof s.name === 'string' && s.name.toLowerCase() === DIR);
  if (src) return t('context.takenSource', { name: src.name, ws: epicWs });
  const p = path.join(epicWs, DIR);
  const st = lstat(p);
  if (!st) return '';
  if (st.isSymbolicLink()) return t('context.takenLink', { path: p });
  if (!st.isDirectory()) return t('context.takenFile', { path: p });
  if (W.hasState(p)) return t('context.takenTask', { path: p });
  return '';
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Whether the body of a file or note in the epic is still what wsg wrote or listed: false when its
// size or its sha256 differs (a hand edit), null when it can't be read.
function unchanged(epicWs, x) {
  try {
    const buf = fs.readFileSync(path.join(epicWs, x.path));
    return buf.length === x.bytes && sha256(buf) === x.sha256;
  } catch {
    return null;
  }
}

// A link whose URL may carry a secret: user info, or a key in the query or the fragment that is, or
// has a _ - . separated part that is, a secret's name (access_token, X-Amz-Signature; not author or
// keyword). Only warned about: the URL lands in every task's AGENTS.md.
const SECRET_WORDS = new Set(['token', 'key', 'apikey', 'secret', 'password', 'passwd', 'pass', 'auth', 'authorization', 'sig', 'signature', 'credential', 'credentials']);
function secretInUrl(u) {
  if (u.username || u.password) return true;
  const keys = [...u.searchParams.keys()];
  if (u.hash.includes('=')) keys.push(...new URLSearchParams(u.hash.slice(1)).keys());
  return keys.some((k) => {
    const lower = k.toLowerCase();
    return SECRET_WORDS.has(lower) || lower.split(/[_\-.]+/).some((part) => SECRET_WORDS.has(part));
  });
}

// Two sizes as a message shows them: in bytes when the rounded ones would read the same.
function sizesOf(a, b) {
  const [x, y] = [T.sizeOf(a), T.sizeOf(b)];
  return x === y ? [`${a} B`, `${b} B`] : [x, y];
}

// A kebab-case id from any text: lower case, every run of other characters one -, at most idMax.
function slugify(text) {
  return String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').slice(0, CONTEXT.idMax)
    .replace(/^-+|-+$/g, '');
}

// A title or a description as given: refused unless one line of at most textMax characters. The
// error text names the flag.
function textProblem(value, flag) {
  if (value === undefined) return '';
  return W.oneLine(value.trim(), flag !== '--title') ? '' : t('context.badText', { flag, max: CONTEXT.textMax });
}

// What the body of a file or a note is: { binary } — binary when it holds a NUL byte or is not UTF-8.
function isBinary(buf) {
  if (buf.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return false;
  } catch {
    return true;
  }
}

// The limits of a body: refused above fileMax, a warning above fileWarn. Pushes into plan.
function sizeCheck(plan, bytes, what) {
  if (bytes > CONTEXT.fileMax) {
    const [size, max] = sizesOf(bytes, CONTEXT.fileMax);
    plan.errors.push(t('context.tooLarge', { what, size, max }));
  } else if (bytes > CONTEXT.fileWarn) {
    const [size, warn] = sizesOf(bytes, CONTEXT.fileWarn);
    plan.warnings.push(t('context.large', { what, size, warn }));
  }
}

// A new plan: what a write command will do, worked out with nothing touched.
// next: the epic's state after it; item: the item added, replaced or removed (null while unknown);
// dirs: directories to make; writes: [{ rel, body, create }]; removes: [rel]; files: the paths
// written or removed, relative to the epic, the rendered ones included.
const newPlan = (state) => ({ state, next: null, item: null, dirs: [], writes: [], removes: [], files: [], errors: [], warnings: [], blockChanged: false });

// The rest every write plan needs once its item is known: the index within its ceiling, and the
// epic rendered from the new state — a broken marker refuses here, not half-way through the writes.
function finish(epicWs, plan) {
  if (plan.errors.length) return plan;
  const { state, next } = plan;
  const after = blockBytes(state.slug, next.context);
  if (after > CONTEXT.blockMax) plan.errors.push(t('context.blockTooLarge', { bytes: after, max: CONTEXT.blockMax }));
  else if (after > CONTEXT.blockWarn) plan.warnings.push(t('context.blockLarge', { bytes: after, warn: CONTEXT.blockWarn }));
  plan.blockChanged = T.epicContextLines(state.slug, { kind: 'items', items: state.context || [] }, 'task').join('\n')
    !== T.epicContextLines(state.slug, { kind: 'items', items: next.context }, 'task').join('\n');
  if (plan.errors.length) return plan;
  try {
    for (const w of plan.writes) generate.assertNoLinks(epicWs, w.rel);
    const rendered = generate.computeRender(epicWs, next, null);
    plan.warnings.push(...rendered.warnings);
    plan.files = [...new Set([...plan.writes.map((w) => w.rel), ...plan.removes, ...generate.changedFiles(rendered)])];
  } catch (e) {
    plan.errors.push(e.message);
  }
  return plan;
}

const withItem = (state, item, replace = null) => {
  const items = state.context || [];
  return { ...state, context: replace ? items.map((x) => (x.id === replace ? item : x)) : [...items, item] };
};

// `wsg context add <url|path>`: a URL becomes a link, a file is copied into context/ (one already
// there is listed as it is), a directory is refused — it is a reference source (`wsg add --reference`).
// o: { id, title, desc, cwd }.
function planAdd(epicWs, state, given, o = {}) {
  const plan = newPlan(state);
  const items = state.context || [];
  const taken = takenProblem(epicWs, state);
  if (taken) plan.errors.push(taken);
  for (const [v, f] of [[o.title, '--title'], [o.desc, '--desc']]) {
    const bad = textProblem(v, f);
    if (bad) plan.errors.push(bad);
  }
  if (o.id !== undefined && !W.contextIdOk(o.id)) plan.errors.push(t('context.badId', { id: o.id, max: CONTEXT.idMax }));
  const desc = (o.desc || '').trim();
  let item = null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(given)) {
    if (!W.isUrl(given)) {
      plan.errors.push(t('context.badUrl', { url: given }));
      return plan;
    }
    const u = new URL(given);
    const where = `${u.host}${u.pathname}`.replace(/\/+$/, '');
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    const title = (o.title || '').trim() || [...where].slice(0, CONTEXT.textMax).join('');
    item = { id: o.id || slugify(`${u.host.replace(/^www\./, '').split('.')[0]} ${last}`) || `link-${sha256(given).slice(0, 8)}`, type: 'link', title, description: desc, url: given };
    if (secretInUrl(u)) plan.warnings.push(t('context.urlSecret', { url: given }));
  } else {
    const file = path.resolve(o.cwd || process.cwd(), given.replace(/^~(?=\/|$)/, require('node:os').homedir()));
    let st = null;
    try { st = fs.statSync(file); } catch { /* below */ }
    if (!st) {
      plan.errors.push(t('context.noFile', { path: file }));
      return plan;
    }
    if (st.isDirectory()) {
      plan.errors.push(t('context.isDir', { path: file }));
      return plan;
    }
    if (!st.isFile()) {
      plan.errors.push(t('context.notFile', { path: file }));
      return plan;
    }
    const name = path.basename(file);
    const ctxDir = path.join(epicWs, DIR);
    // A file already in context/ (put there by hand, or named by wsg check as unlisted): listed in place.
    const inPlace = !taken && fs.existsSync(ctxDir) && realOf(path.dirname(file)) === realOf(ctxDir);
    // Not a note's file: listed as a file, it would be a second copy of the note's body. A note left
    // there by hand is moved out and written with `wsg context note <id> --from <file>`.
    if (!taken && fs.existsSync(path.join(epicWs, NOTES)) && realOf(path.dirname(file)) === realOf(path.join(epicWs, NOTES))) {
      plan.errors.push(t('context.inNotes', { path: file }));
      return plan;
    }
    // A symlink listed in place would point the index outside the epic. Copying from one is fine: the
    // copy is its target's bytes.
    const own = lstat(file);
    if (inPlace && own && own.isSymbolicLink()) {
      plan.errors.push(t('context.inPlaceLink', { path: file }));
      return plan;
    }
    const rel = `${DIR}/${name}`;
    const badName = W.contextNameProblem(name);
    if (badName) plan.errors.push(t('context.badName', { name, why: badName }));
    const listed = items.find((x) => x.type !== 'link' && x.path.toLowerCase() === rel.toLowerCase());
    if (listed) plan.errors.push(t('context.listedAlready', { path: rel, id: listed.id }));
    else if (!inPlace && lstat(path.join(epicWs, rel))) plan.errors.push(t('context.fileExists', { path: path.join(epicWs, rel) }));
    sizeCheck(plan, st.size, name);
    if (plan.errors.length) return plan;
    const body = fs.readFileSync(file);
    item = {
      // A name with no ASCII letter or digit (кириллица.md) still gets an id of its own.
      id: o.id || slugify(name.replace(/\.[^.]+$/, '')) || `file-${sha256(name).slice(0, 8)}`,
      type: 'file',
      title: (o.title || '').trim() || [...name].slice(0, CONTEXT.textMax).join(''),
      description: desc,
      path: rel,
      bytes: body.length,
      sha256: sha256(body),
      binary: isBinary(body),
      copied: !inPlace,
    };
    if (!inPlace) {
      if (!lstat(ctxDir)) plan.dirs.push(DIR);
      plan.writes.push({ rel, body, create: true });
    }
  }
  plan.item = item;
  const clash = items.find((x) => x.id === item.id);
  if (clash) plan.errors.push(t(o.id ? 'context.idTaken' : 'context.idTakenDerived', { id: item.id, type: clash.type }));
  plan.next = withItem(state, item);
  return finish(epicWs, plan);
}

// `wsg context note <id>`: a note written to context/notes/<id>.md. o: { text, body (a Buffer read
// from --from), title, desc, replace, discard }. --replace rewrites the body of a note that exists, and
// its title and description where they are given; without it an id that exists is refused. A note
// edited by hand since wsg wrote it is not rewritten unless discard (--discard-edits) says so.
function planNote(epicWs, state, id, o = {}) {
  const plan = newPlan(state);
  const items = state.context || [];
  const taken = takenProblem(epicWs, state);
  if (taken) plan.errors.push(taken);
  for (const [v, f] of [[o.title, '--title'], [o.desc, '--desc']]) {
    const bad = textProblem(v, f);
    if (bad) plan.errors.push(bad);
  }
  if (!W.contextIdOk(id)) plan.errors.push(t('context.badId', { id, max: CONTEXT.idMax }));
  let body = o.body !== undefined ? o.body : Buffer.from(o.text === undefined ? '' : o.text);
  if (!String(body).trim()) plan.errors.push(t('context.noteEmpty'));
  else if (isBinary(body)) plan.errors.push(t('context.noteBinary'));
  else if (body[body.length - 1] !== 0x0a) body = Buffer.concat([body, Buffer.from('\n')]);
  sizeCheck(plan, body.length, id);
  const had = items.find((x) => x.id === id);
  if (had && !o.replace) plan.errors.push(t(had.type === 'note' ? 'context.noteExists' : 'context.idTaken', { id, type: had.type }));
  if (o.replace && !had) plan.errors.push(t('context.noNote', { id }));
  if (o.replace && had && had.type !== 'note') plan.errors.push(t('context.replaceNotNote', { id, type: had.type }));
  if (o.replace && had && had.type === 'note' && lstat(path.join(epicWs, had.path))) {
    const same = unchanged(epicWs, had);
    if (same === null) plan.errors.push(t('context.unreadable', { path: had.path }));
    else if (!same && !o.discard) plan.errors.push(t('context.edited', { path: had.path }));
  }
  if (plan.errors.length) return plan;
  const rel = `${DIR}/notes/${id}.md`;
  const item = {
    id,
    type: 'note',
    title: o.title !== undefined ? o.title.trim() : had ? had.title : id,
    description: o.desc !== undefined ? o.desc.trim() : had ? had.description : '',
    path: rel,
    bytes: body.length,
    sha256: sha256(body),
  };
  // A file at the note's path that no item lists (left by hand): never overwritten.
  if (!had && lstat(path.join(epicWs, rel))) {
    plan.errors.push(t('context.fileExists', { path: path.join(epicWs, rel) }));
    return plan;
  }
  if (!lstat(path.join(epicWs, DIR))) plan.dirs.push(DIR);
  if (!lstat(path.join(epicWs, NOTES))) plan.dirs.push(NOTES);
  plan.writes.push({ rel, body, create: !had || !lstat(path.join(epicWs, rel)) });
  plan.item = item;
  plan.next = withItem(state, item, had ? id : null);
  return finish(epicWs, plan);
}

// `wsg context remove <id>`: the item out of the index, and out of context/ what wsg wrote there — a
// file it copied in, a note. A file that was in context/ already and was only listed is only
// unlisted, never deleted: it may be the owner's only copy. A link is only in the state. A listed
// file that is gone already is a warning. A file or note edited by hand since wsg wrote it is not
// deleted unless o.discard (--discard-edits) says so, as `wsg remove` keeps a worktree with changes.
// Nothing is deleted through a link: context/ or context/notes/ that is one refuses the removal.
function planRemove(epicWs, state, id, o = {}) {
  const plan = newPlan(state);
  const items = state.context || [];
  const had = items.find((x) => x.id === id);
  if (!had) {
    plan.errors.push(t('context.unknown', { id, list: items.map((x) => x.id).join(', ') || '—' }));
    return plan;
  }
  plan.item = had;
  if (had.type === 'file' && !had.copied) plan.warnings.push(t('context.fileKept', { path: had.path }));
  else if (had.type !== 'link') {
    const taken = takenProblem(epicWs, state);
    let linked = '';
    try { generate.assertNoLinks(epicWs, had.path); } catch (e) { linked = e.message; }
    const st = lstat(path.join(epicWs, had.path));
    if (taken) plan.errors.push(taken);
    else if (linked) plan.errors.push(linked);
    else if (!st) plan.warnings.push(t('context.fileGone', { path: had.path }));
    else if (!st.isFile()) plan.errors.push(t('context.notFile', { path: path.join(epicWs, had.path) }));
    else if (unchanged(epicWs, had) === null) plan.errors.push(t('context.unreadable', { path: had.path }));
    else if (unchanged(epicWs, had) === false && !o.discard) plan.errors.push(t('context.edited', { path: had.path }));
    else plan.removes.push(had.path);
  }
  plan.next = { ...state, context: items.filter((x) => x !== had) };
  return finish(epicWs, plan);
}

// The plan written in one transaction: the directories, the bodies, the removals, then the epic's
// files rendered from the new state, its state among them. A failure or Ctrl+C puts back every path
// it wrote (generate.restore) and takes the directories it made off again. The caller holds the
// epic's lock. Returns { rendered }.
function apply(epicWs, plan) {
  return generate.guarded((txn) => {
    // The directories first, so their undo runs after the files in them are put back.
    for (const rel of plan.dirs) {
      const p = path.join(epicWs, rel);
      generate.assertNoLinks(epicWs, path.join(rel, 'x'));
      fs.mkdirSync(p);
      txn.add(() => { try { fs.rmdirSync(p); } catch { /* not empty: someone else's file, kept */ } });
    }
    const j = generate.journal();
    txn.add(() => generate.restore(epicWs, j));
    for (const w of plan.writes) generate.writeOwned(epicWs, w.rel, w.body, j, { create: w.create });
    for (const rel of plan.removes) {
      // Again right before the unlink: a directory on the way made a link since the plan.
      generate.assertNoLinks(epicWs, rel);
      generate.owned(epicWs, j, rel, (p) => {
        if (!lstat(p) || !lstat(p).isFile()) throw new Error(t('context.notFile', { path: p }));
        fs.unlinkSync(p);
      });
    }
    const rendered = generate.computeRender(epicWs, plan.next, null);
    // Its warnings were the plan's.
    generate.applyRender(epicWs, { ...rendered, warnings: [] }, j);
    return { rendered };
  }, t('context.rollingBack', { ws: epicWs }));
}

module.exports = { blockBytes, itemResult, takenProblem, planAdd, planNote, planRemove, apply, slugify, isBinary, unchanged, sha256, sizesOf, secretInUrl, DIR };
