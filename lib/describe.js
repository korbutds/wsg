'use strict';

// `wsg describe`: a task's description for the owner — a few plain sentences in its description.md
// (W.descriptionPath), the one file the command writes. A plan reads it and changes nothing; apply
// writes or removes it in one transaction (guarded() in lib/generate.js), so a failure puts it back.

const fs = require('node:fs');
const path = require('node:path');
const W = require('./workspace');
const generate = require('./generate');
const { t } = require('./i18n');

// What describe would do in ws. op: { text } — the new text as given, not yet normalized —,
// { clear: true }, or {} to read. Returns { file, rel, previous, description, changed, exists,
// errors, warnings }: previous and description the text before and after (null: none); changed
// whether description.md is written or removed — setting the text it has already, in any spelling
// that reads the same, writes nothing. An entry there that is no file of its own, or can't be read,
// refuses every write: it is never taken for a missing one, nor written through.
function plan(ws, op = {}) {
  const file = W.descriptionPath(ws);
  const rel = path.relative(ws, file);
  const errors = [];
  const now = W.readDescription(ws);
  const unreadable = !!now && typeof now === 'object';
  const previous = unreadable ? null : now;
  let exists = false;
  try { exists = !!fs.lstatSync(file); } catch { /* none */ }
  const writing = !!op.clear || op.text !== undefined;
  if (unreadable && writing) errors.push(t('describe.unreadable', { file: rel, why: now.unreadable }));
  let description = previous;
  if (op.clear) description = null;
  else if (op.text !== undefined) {
    const d = W.descriptionOf(op.text);
    if (d.error) errors.push(d.error);
    else if (!d.text) errors.push(t('describe.empty'));
    else description = d.text;
  }
  // A file with only whitespace reads as none: --clear removes it all the same.
  const changed = !errors.length && writing && (op.clear ? exists : description !== previous);
  const warnings = unreadable && !writing ? [t('describe.unreadable', { file: rel, why: now.unreadable })] : [];
  return { file, rel, previous, description, changed, exists, errors, warnings };
}

// The plan written: description.md replaced through a temporary file, or removed. Never through a
// symlink (writeOwned, assertNoLinks). The caller holds the locks, the epic's first.
function apply(ws, p) {
  return generate.guarded((txn) => {
    const j = generate.journal();
    txn.add(() => generate.restore(ws, j));
    if (p.description !== null) {
      generate.writeOwned(ws, p.rel, `${p.description}\n`, j);
      return;
    }
    // Again right before the unlink: a directory on the way made a link since the plan.
    generate.assertNoLinks(ws, p.rel);
    const st = generate.lstat(p.file);
    if (!st) return;
    if (!st.isFile()) throw new Error(t('gen.notAFile', { path: p.rel, ws }));
    generate.owned(ws, j, p.rel, (f) => fs.unlinkSync(f));
  }, t('gen.describeRollingBack', { ws }));
}

module.exports = { plan, apply };
