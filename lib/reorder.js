'use strict';

// `wsg reorder`: the order of an epic's tasks, in two groups that never mix. The workspace tasks — the
// directories wsg made in the epic — are ordered by the epic's state, "taskOrder" (W.byTaskOrder): the
// <!-- wsg:tasks --> block of tasks.md renders it, W.childrenOf and wsg list follow it. The tracker
// tasks are the list items under "## Other tasks" in tasks.md, which the epic agent writes from the
// tracker (docs/epic-guide.md → Syncing: one item per task, key first): reorder moves the items there,
// each with its indented sub-lines. Plans first with nothing touched, then writes the state and
// tasks.md in one transaction (generate.guarded); the caller holds the epic's lock.

const path = require('node:path');
const W = require('./workspace');
const { t } = require('./i18n');

// A tracker key at the start of an item's text: an uppercase project key with a number (ACME-12), or
// an issue number as GitHub and GitLab write it (#12). A checkbox, emphasis, a code span or a link may
// wrap it: `- [ ] **ACME-12** …`, `- [ACME-12](url) …`.
const KEY_RE = /^([A-Z][A-Z0-9]+-\d+|#\d+)(?![A-Za-z0-9-])/;
function keyOf(itemText) {
  const s = itemText.replace(/^\[[ xXхХ]\]\s+/, '').replace(/^[*_`[~]+/, '');
  const m = KEY_RE.exec(s);
  return m ? m[1] : null;
}
const sameKey = (a, b) => a.toUpperCase() === b.toUpperCase();

// The section's heading: "## Other tasks", in any case, with a "(synced …)" or a ":" after it.
const HEADING = /^##\s+other tasks(?=\s|\(|:|$)/i;
const BOUNDARY = /^#{1,2}\s/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const ITEM = /^(?:[-*+]|\d{1,9}[.)])\s+(\S.*)$/;

// A text as lines: { lines, ends, eol, final } — each line without its line end, the line end it had
// ('' for a last one without), the one the text uses most (\r\n or \n), and whether it ends with one.
// joinLines puts lines back by their indexes, each with its own line end: a line moved off the end
// gets the text's, the line that ends up last ends as the text did.
function splitLines(text) {
  const s = String(text);
  const parts = s.split(/(\r?\n)/);
  const lines = [];
  const ends = [];
  for (let i = 0; i < parts.length; i += 2) {
    lines.push(parts[i]);
    ends.push(parts[i + 1] || '');
  }
  const final = /\n$/.test(s);
  if (final) {
    lines.pop();
    ends.pop();
  }
  const crlf = ends.filter((e) => e === '\r\n').length;
  return { lines, ends, eol: crlf > ends.filter((e) => e === '\n').length ? '\r\n' : '\n', final };
}
function joinLines(sec, order) {
  return order.map((i, n) => {
    if (n < order.length - 1) return sec.lines[i] + (sec.ends[i] || sec.eol);
    return sec.lines[i] + (sec.final ? sec.ends[i] || sec.eol : '');
  }).join('');
}

// The "## Other tasks" section of a tasks.md text: { found, start, end, lines, eol, final, items,
// problems }. lines: the text split into lines (splitLines); start..end: the lines of the section after
// its heading, which runs to the next heading of level 1 or 2 outside a fence and a comment.
// items: [{ key, text, line, from, to }] in section order, key null for an item without one, from..to
// its lines (the item and its indented sub-lines, never a blank line at its end). problems: [{ kind,
// line }] — 'table', 'text' (a line at column 0 that is no list item, no blank line and no HTML
// comment: a fence there too), 'unclosed' (a comment or a fence still open where the section ends),
// 'keyless', 'duplicate' — each with its 1-based line in the file. A comment opens only outside a code
// span (W.visibleText). A comment or a fence an item's line or sub-line opens travels with the item; a
// fence of an item ends where a line at column 0 comes. One at column 0 stays where it is, and what is
// in it is no item.
function trackerSection(text) {
  const { lines, ends, eol, final } = splitLines(text);
  const out = { found: false, start: -1, end: -1, lines, ends, eol, final, items: [], problems: [] };
  let fence = null;
  let comment = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (fence) {
      if (closesFence(l, fence)) fence = null;
      continue;
    }
    if (comment) {
      comment = W.visibleText(l, true).comment;
      continue;
    }
    const f = FENCE.exec(l);
    if (f) {
      fence = f[1];
      continue;
    }
    if (W.visibleText(l, false).comment) {
      comment = true;
      continue;
    }
    if (HEADING.test(l)) {
      out.found = true;
      out.start = i + 1;
      break;
    }
  }
  if (!out.found) return out;
  fence = null;
  comment = false;
  // owner: the item whose fence or comment is open (-1: one at column 0); openedAt: its line;
  // current: the item an indented line goes with.
  let owner = -1;
  let openedAt = -1;
  let current = null;
  let i = out.start;
  for (; i < lines.length; i++) {
    const l = lines[i];
    const blank = l.trim() === '';
    // An item's fence ends where its indentation does: at a line at column 0.
    if (fence && owner >= 0 && !blank && !/^\s/.test(l)) fence = null;
    if (fence) {
      if (closesFence(l, fence)) fence = null;
      if (owner >= 0 && !blank) out.items[owner].to = i + 1;
      continue;
    }
    if (comment) {
      comment = W.visibleText(l, true).comment;
      if (owner >= 0 && !blank) out.items[owner].to = i + 1;
      continue;
    }
    if (BOUNDARY.test(l)) break;
    if (blank) continue;
    const indented = /^\s/.test(l);
    const m = indented ? null : ITEM.exec(l);
    const f = FENCE.exec(l);
    if (m) {
      current = { key: keyOf(m[1]), text: m[1].trim(), line: i + 1, from: i, to: i + 1 };
      out.items.push(current);
      owner = out.items.length - 1;
    } else if (indented && current) {
      // A sub-line; the blank lines before it go with the item too.
      current.to = i + 1;
      owner = out.items.indexOf(current);
    } else if (!indented && !f && /^<!--/.test(l)) {
      owner = -1;
      current = null;
    } else {
      out.problems.push({ kind: /^\s*\|/.test(l) ? 'table' : 'text', line: i + 1 });
      owner = -1;
      current = null;
      // A fence at column 0 is opened all the same: what is in it is no item.
      if (!f) continue;
    }
    if (f && !m) {
      fence = f[1];
      openedAt = i + 1;
    } else if (W.visibleText(l, false).comment) {
      comment = true;
      openedAt = i + 1;
    }
  }
  out.end = i;
  // The end of the file ends an item's fence too, as a line at column 0 would.
  if (fence && owner >= 0 && i === lines.length) fence = null;
  if (fence || comment) out.problems.push({ kind: 'unclosed', line: openedAt });
  const seen = new Map();
  for (const x of out.items) {
    if (!x.key) {
      out.problems.push({ kind: 'keyless', line: x.line });
      continue;
    }
    const k = x.key.toUpperCase();
    if (seen.has(k)) out.problems.push({ kind: 'duplicate', line: x.line, key: x.key });
    else seen.set(k, x);
  }
  return out;
}

const closesFence = (l, fence) => {
  const c = /^\s*(`{3,}|~{3,})\s*$/.exec(l);
  return !!c && c[1][0] === fence[0] && c[1].length >= fence.length;
};

// The tracker tasks as wsg list gives them: [{ id, text }] in section order, id the key or null. A
// tasks.md without the section, or one that can't be read, has none.
function trackerTasks(text) {
  if (typeof text !== 'string') return [];
  return trackerSection(text).items.map((x) => ({ id: x.key, text: x.text }));
}

// The text with the section's items in the order given (a permutation of sec.items): each item's
// lines go to the next slot, the lines between the items stay where they are; the line ends as the
// text had them.
function withItems(sec, order) {
  const range = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, k) => a + k);
  const out = range(0, sec.items[0].from);
  sec.items.forEach((slot, n) => {
    out.push(...range(order[n].from, order[n].to));
    out.push(...range(slot.to, n + 1 < sec.items.length ? sec.items[n + 1].from : sec.lines.length));
  });
  return joinLines(sec, out);
}

// Why the section can't be reordered, as one message, or ''.
function sectionProblem(sec, file) {
  if (!sec.found) return t('reorder.noSection', { file });
  const p = sec.problems[0];
  if (!p) return '';
  if (p.kind === 'duplicate') return t('reorder.duplicate', { file, line: p.line, key: p.key });
  return t(`reorder.${p.kind}`, { file, line: p.line });
}

// The move, worked out on a list of ids: { from, to, order } (1-based positions), or { error }.
function move(ids, item, where, same) {
  const from = ids.findIndex((x) => same(x, item));
  const rest = ids.filter((_, i) => i !== from);
  let at;
  if (where.to !== undefined) {
    const n = Number(where.to);
    if (!/^\d+$/.test(String(where.to)) || n < 1 || n > ids.length) return { error: t('reorder.badTo', { to: where.to, max: ids.length }) };
    at = n - 1;
  } else {
    const target = where.before !== undefined ? where.before : where.after;
    const j = rest.findIndex((x) => same(x, target));
    at = where.before !== undefined ? j : j + 1;
  }
  const order = [...rest.slice(0, at), ids[from], ...rest.slice(at)];
  return { from: from + 1, to: at + 1, order };
}

// The plan of `wsg reorder <item> (--before X | --after X | --to N)` in the epic: nothing touched.
// where: { before, after, to } — exactly one given (the CLI checks). Returns { group, item, from, to,
// order, changed, next, tasksMd, tasksMdUpdated, errors, warnings }: next the epic's state to write
// (null: unchanged), tasksMd the body of tasks.md to write (null: unchanged).
function planReorder(epicWs, state, item, where) {
  const G = require('./generate');
  const plan = { group: null, item, from: null, to: null, order: [], changed: false, next: null, tasksMd: null, tasksMdUpdated: false, errors: [], warnings: [] };
  const fail = (msg) => { plan.errors.push(msg); return plan; };
  if (W.isArchived(state)) return fail(t('reorder.archived', { epic: state.slug }));
  const target = where.before !== undefined ? where.before : where.after;
  // A directory renamed by hand to a name no slug has (Cart_old) can't be in taskOrder: it is left out of
  // the order, and said; it renders after the ones there.
  const names = W.childrenOf(epicWs).map((c) => path.basename(c.ws));
  const slugs = names.filter((n) => W.KEBAB.test(n));
  const odd = names.filter((n) => !W.KEBAB.test(n));
  if (odd.length) plan.warnings.push(t('reorder.badSlug', { list: odd.join(', ') }));
  const strip = (x) => (typeof x === 'string' ? x.replace(/\/+$/, '') : x);
  const isTask = (x) => slugs.includes(strip(x));
  let text = null;
  let sec = null;
  const section = () => {
    if (sec) return sec;
    try {
      text = G.readOwned(epicWs, 'tasks.md');
    } catch (e) {
      plan.errors.push(e.message);
      text = null;
    }
    sec = text === null ? { found: false, items: [], problems: [] } : trackerSection(text);
    return sec;
  };
  const isTracker = (x) => typeof x === 'string' && section().items.some((it) => it.key && sameKey(it.key, x));
  if (odd.includes(strip(item))) return fail(t('reorder.badSlugItem', { item: strip(item) }));
  if (isTask(item)) plan.group = 'task';
  else if (isTracker(item)) plan.group = 'tracker';
  else {
    if (plan.errors.length) return plan;
    // A key the section does not have: why it can't be read, when it can't — a table, say.
    const file = path.join(epicWs, 'tasks.md');
    const bad = sectionProblem(section(), file);
    if (KEY_RE.test(item) && bad) return fail(bad);
    return fail(KEY_RE.test(item) && !section().items.length
      ? t('reorder.noTracker', { item, file })
      : t('reorder.unknown', { item, epic: state.slug, tasks: slugs.join(', ') || '—' }));
  }
  plan.item = plan.group === 'task' ? strip(item) : section().items.find((it) => it.key && sameKey(it.key, item)).key;
  if (target !== undefined) {
    const there = plan.group === 'task' ? isTask(target) : isTracker(target);
    if (!there) {
      const other = plan.group === 'task' ? isTracker(target) : isTask(target);
      return fail(other ? t('reorder.crossGroup', { item: plan.item, target }) : t('reorder.unknown', { item: target, epic: state.slug, tasks: slugs.join(', ') || '—' }));
    }
    const same = plan.group === 'task' ? strip(target) === plan.item : sameKey(target, plan.item);
    if (same) return fail(t('reorder.self', { item: plan.item }));
  }
  if (plan.group === 'task') {
    const w = target === undefined ? where : where.before !== undefined ? { before: strip(target) } : { after: strip(target) };
    const r = move(slugs, plan.item, w, (a, b) => a === b);
    if (r.error) return fail(r.error);
    Object.assign(plan, { from: r.from, to: r.to, order: r.order, changed: r.order.some((x, i) => x !== slugs[i]) });
    if (!plan.changed) return plan;
    plan.next = { ...state, taskOrder: r.order };
    const bad = W.stateProblem(plan.next);
    if (bad) return fail(bad);
    let rendered;
    try {
      rendered = G.renderTasks(epicWs, plan.next);
    } catch (e) {
      return fail(e.message);
    }
    plan.warnings.push(...rendered.warnings);
    if (rendered.changed) {
      plan.tasksMd = rendered.body;
      plan.tasksMdUpdated = true;
    }
    return plan;
  }
  const bad = sectionProblem(sec, path.join(epicWs, 'tasks.md'));
  if (bad) return fail(bad);
  const keys = sec.items.map((x) => x.key);
  const r = move(keys, plan.item, where, sameKey);
  if (r.error) return fail(r.error);
  Object.assign(plan, { from: r.from, to: r.to, order: r.order, changed: r.order.some((x, i) => x !== keys[i]) });
  if (!plan.changed) return plan;
  plan.tasksMd = withItems(sec, r.order.map((k) => sec.items.find((x) => x.key === k)));
  plan.tasksMdUpdated = plan.tasksMd !== text;
  return plan;
}

// The plan written in one transaction: the state, then tasks.md. A failure or Ctrl+C puts both back
// (generate.restore). Returns { tasksMdUpdated }.
function applyReorder(epicWs, plan) {
  const G = require('./generate');
  return G.guarded((txn) => {
    const j = G.journal();
    txn.add(() => G.restore(epicWs, j));
    if (plan.next) G.writeOwned(epicWs, W.STATE_FILE, W.stateJson(plan.next), j);
    if (plan.tasksMd !== null) G.writeOwned(epicWs, 'tasks.md', plan.tasksMd, j);
    return { tasksMdUpdated: plan.tasksMd !== null };
  }, t('reorder.rollingBack', { ws: epicWs }));
}

module.exports = { trackerSection, trackerTasks, keyOf, planReorder, applyReorder, withItems, move, splitLines, joinLines, KEY_RE };
