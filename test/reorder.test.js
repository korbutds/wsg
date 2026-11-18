'use strict';

// wsg reorder: the order of an epic's tasks — its task directories, kept in the epic's state as
// taskOrder and rendered into the <!-- wsg:tasks --> block of tasks.md, and its tracker tasks, the
// list items under "## Other tasks". Every command runs in a child process with its own HOME,
// WS_ROOT and config. Nothing here needs the network or a real agent.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.WSG_LANG = 'en';

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const W = require(path.join(ROOT, 'lib', 'workspace.js'));
const R = require(path.join(ROOT, 'lib', 'reorder.js'));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-reorder-')));
const home = path.join(tmp, 'home');
const wsRoot = path.join(tmp, 'ws');
for (const d of [home, wsRoot]) fs.mkdirSync(d, { recursive: true });

const ENV = {
  PATH: process.env.PATH,
  HOME: home,
  WSG_LANG: 'en',
  WSG_CONFIG: path.join(tmp, 'no-config'),
  WS_ROOT: wsRoot,
  CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
  CODEX_HOME: path.join(tmp, 'codex-config'),
  WSG_NO_LAUNCH: '1',
  GIT_CONFIG_NOSYSTEM: '1',
};
const wsg = (args, { cwd = tmp, env = {} } = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...ENV, ...env }, maxBuffer: 1 << 28 });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
};
const json = (args, opts) => {
  const r = wsg([...args, '--json'], opts);
  let doc = null;
  try { doc = JSON.parse(r.out); } catch { /* the test says so */ }
  return { ...r, doc };
};
const readState = (ws) => JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'wsg.json'), 'utf8'));
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const write = (p, text) => fs.writeFileSync(p, text);
// The task lines of the <!-- wsg:tasks --> block, as slugs.
const block = (epic) => {
  const text = read(epic, 'tasks.md');
  const inner = text.slice(text.indexOf('<!-- wsg:tasks -->'), text.indexOf('<!-- /wsg:tasks -->'));
  return [...inner.matchAll(/^- `([^`/]+)\/`/gm)].map((m) => m[1]);
};
const listed = (slug) => json(['list']).doc.result.workspaces.find((w) => w.slug === slug);
const checkItems = (ws) => json(['check', ws]).doc.result.sections.flatMap((s) => s.items.map((i) => `${i.level} ${i.text}`));
const drift = (ws) => checkItems(ws).filter((l) => /lists other tasks|no <!-- wsg:tasks -->/.test(l));
// tasks.md with its "## Other tasks" section replaced by body.
const otherTasks = (epic, body) => {
  const p = path.join(epic, 'tasks.md');
  const text = read(p);
  write(p, `${text.slice(0, text.indexOf('## Other tasks'))}## Other tasks (synced 2026-11-18 via tracker)\n\n${body}`);
};

let failed = 0;
let passed = 0;
const it = (name, fn) => {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};
let finished = false;
process.on('exit', () => {
  if (!finished) { console.log('\nFAIL  the suite stopped before the end'); process.exitCode = 1; }
});

const epicWith = (slug, tasks) => {
  assert.strictEqual(wsg(['new', slug, '--kind', 'epic', '--no-launch']).code, 0);
  for (const t of tasks) assert.strictEqual(wsg(['new', t, '--epic', slug, '--no-code', '--no-launch']).code, 0);
  return path.join(wsRoot, slug);
};

(async () => {
  console.log('the order of the task directories');
  {
    const ep = epicWith('shop', ['auth', 'cart', 'pay']);
    it('without a taskOrder: by name, no key in the state', () => {
      assert.deepStrictEqual(block(ep), ['auth', 'cart', 'pay']);
      assert.strictEqual(readState(ep).taskOrder, undefined);
    });
    const dry = json(['reorder', 'pay', '--to', '1', '--ws', 'shop', '--dry-run']);
    it('--dry-run: the plan, nothing written, no lock left', () => {
      assert.strictEqual(dry.code, 0, dry.all);
      assert.strictEqual(dry.doc.dryRun, true);
      assert.deepStrictEqual(dry.doc.result, { workspace: ep, item: 'pay', group: 'task', from: 3, to: 1, order: ['pay', 'auth', 'cart'], changed: true, tasksMdUpdated: true });
      assert.strictEqual(readState(ep).taskOrder, undefined);
      assert.deepStrictEqual(block(ep), ['auth', 'cart', 'pay']);
      assert.ok(!fs.existsSync(path.join(ep, '.claude', 'wsg.lock')));
    });
    const plainDry = wsg(['reorder', 'pay', '--to', '1', '--ws', 'shop', '--dry-run']);
    it('--dry-run without --json: the same plan as JSON on stdout', () => {
      assert.strictEqual(plainDry.code, 0, plainDry.all);
      assert.deepStrictEqual(JSON.parse(plainDry.out).order, ['pay', 'auth', 'cart']);
    });
    const r = json(['reorder', 'pay', '--to', '1', '--ws', 'shop']);
    it('--to 1: the state and the tasks block in the new order', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.deepStrictEqual(r.doc.result, { workspace: ep, item: 'pay', group: 'task', from: 3, to: 1, order: ['pay', 'auth', 'cart'], changed: true, tasksMdUpdated: true });
      assert.deepStrictEqual(readState(ep).taskOrder, ['pay', 'auth', 'cart']);
      assert.deepStrictEqual(block(ep), ['pay', 'auth', 'cart']);
      assert.strictEqual(W.stateProblem(readState(ep)), '');
    });
    it('W.childrenOf and wsg list follow it', () => {
      assert.deepStrictEqual(W.childrenOf(ep).map((c) => path.basename(c.ws)), ['pay', 'auth', 'cart']);
      assert.deepStrictEqual(listed('shop').tasks.map((x) => x.slug), ['pay', 'auth', 'cart']);
      assert.match(wsg(['list']).out, /shop \(epic\)\n {2}pay\n {2}auth\n {2}cart\n/);
    });
    it('wsg check sees no drift', () => assert.deepStrictEqual(drift(ep), []));
    const before = { state: read(ep, '.claude', 'wsg.json'), tasks: read(ep, 'tasks.md') };
    const same = json(['reorder', 'pay', '--to', '1', '--ws', 'shop']);
    it('the same move again: changed false, nothing written', () => {
      assert.strictEqual(same.code, 0, same.all);
      assert.strictEqual(same.doc.result.changed, false);
      assert.strictEqual(same.doc.result.tasksMdUpdated, false);
      assert.strictEqual(same.doc.result.from, 1);
      assert.strictEqual(same.doc.result.to, 1);
      assert.strictEqual(read(ep, '.claude', 'wsg.json'), before.state);
      assert.strictEqual(read(ep, 'tasks.md'), before.tasks);
    });
    it('the plain run of it says so', () => assert.match(wsg(['reorder', 'pay', '--to', '1', '--ws', 'shop']).out, /pay is at 1 already: nothing to do/));
    const after = wsg(['reorder', 'pay', '--after', 'cart', '--ws', 'shop']);
    it('--after: the plain run says the move and the order', () => {
      assert.strictEqual(after.code, 0, after.all);
      assert.match(after.out, /Moved pay: 1 → 3 of 3/);
      assert.match(after.out, /order: auth, cart, pay/);
      assert.deepStrictEqual(block(ep), ['auth', 'cart', 'pay']);
    });
    const fromTask = json(['reorder', 'cart', '--before', 'auth'], { cwd: path.join(ep, 'cart') });
    it('from inside a task of the epic: the epic is the one it acts on', () => {
      assert.strictEqual(fromTask.code, 0, fromTask.all);
      assert.strictEqual(fromTask.doc.result.workspace, ep);
      assert.deepStrictEqual(readState(ep).taskOrder, ['cart', 'auth', 'pay']);
    });
    it('--ws <epic>/<task> acts on its epic too', () => {
      const x = json(['reorder', 'cart', '--to', '1', '--ws', 'shop/auth', '--dry-run']);
      assert.strictEqual(x.code, 0, x.all);
      assert.strictEqual(x.doc.result.workspace, ep);
    });
    it('a trailing slash on a task is the task', () => {
      const x = json(['reorder', 'pay/', '--before', 'cart/', '--ws', 'shop', '--dry-run']);
      assert.strictEqual(x.code, 0, x.all);
      assert.deepStrictEqual(x.doc.result.order, ['pay', 'cart', 'auth']);
    });

    assert.strictEqual(wsg(['new', 'aaa', '--epic', 'shop', '--no-code', '--no-launch']).code, 0);
    it('a new task goes to the end, whatever its name', () => {
      assert.deepStrictEqual(block(ep), ['cart', 'auth', 'pay', 'aaa']);
      assert.deepStrictEqual(listed('shop').tasks.map((x) => x.slug), ['cart', 'auth', 'pay', 'aaa']);
      assert.deepStrictEqual(drift(ep), []);
    });

    // A status change, a refresh, a context change and the archive of a task rewrite the epic's
    // state or its tasks block: the order stays.
    assert.strictEqual(wsg(['status', 'shop/pay', 'review']).code, 0);
    it('a status change keeps the order', () => {
      assert.deepStrictEqual(block(ep), ['cart', 'auth', 'pay', 'aaa']);
      assert.match(read(ep, 'tasks.md'), /^- `pay\/` \[review\]$/m);
    });
    assert.strictEqual(wsg(['refresh', '--tasks', '--ws', 'shop']).code, 0);
    it('wsg refresh --tasks keeps it', () => {
      assert.deepStrictEqual(block(ep), ['cart', 'auth', 'pay', 'aaa']);
      assert.deepStrictEqual(readState(ep).taskOrder, ['cart', 'auth', 'pay']);
    });
    const note = path.join(tmp, 'note.md');
    write(note, 'a note\n');
    assert.strictEqual(wsg(['context', 'add', note, '--ws', 'shop']).code, 0);
    it('wsg context add keeps it in the state', () => assert.deepStrictEqual(readState(ep).taskOrder, ['cart', 'auth', 'pay']));
    const arc = wsg(['archive', 'shop/auth']);
    it('the archive of a task keeps its place, with its marker', () => {
      assert.strictEqual(arc.code, 0, arc.all);
      assert.deepStrictEqual(block(ep), ['cart', 'auth', 'pay', 'aaa']);
      assert.match(read(ep, 'tasks.md'), /^- `auth\/` \[archived \d{4}-\d{2}-\d{2}\]$/m);
    });
    it('an archived task is moved like any other', () => {
      const x = json(['reorder', 'auth', '--to', '4', '--ws', 'shop']);
      assert.strictEqual(x.code, 0, x.all);
      assert.deepStrictEqual(block(ep), ['cart', 'pay', 'aaa', 'auth']);
    });
    assert.strictEqual(wsg(['unarchive', 'shop/auth']).code, 0);
    it('its unarchive keeps the order', () => {
      assert.deepStrictEqual(block(ep), ['cart', 'pay', 'aaa', 'auth']);
      assert.deepStrictEqual(drift(ep), []);
    });
    const epicArc = wsg(['archive', 'shop']);
    it('the archive of the epic keeps it, and refuses a reorder until unarchived', () => {
      assert.strictEqual(epicArc.code, 0, epicArc.all);
      assert.deepStrictEqual(readState(ep).taskOrder, ['cart', 'pay', 'aaa', 'auth']);
      assert.deepStrictEqual(block(ep), ['cart', 'pay', 'aaa', 'auth']);
      const x = json(['reorder', 'auth', '--to', '1', '--ws', 'shop']);
      assert.strictEqual(x.code, 2, x.all);
      assert.match(x.doc.error.message, /the epic shop is archived: wsg unarchive shop first/);
    });
    assert.strictEqual(wsg(['unarchive', 'shop']).code, 0);
    it('the unarchive of the epic keeps it', () => {
      assert.deepStrictEqual(readState(ep).taskOrder, ['cart', 'pay', 'aaa', 'auth']);
      assert.deepStrictEqual(block(ep), ['cart', 'pay', 'aaa', 'auth']);
      assert.deepStrictEqual(drift(ep), []);
    });

    // A task directory removed by hand: its slug stays in taskOrder, ignored; the next reorder drops it.
    fs.rmSync(path.join(ep, 'pay'), { recursive: true, force: true });
    assert.strictEqual(wsg(['refresh', '--ws', 'shop']).code, 0);
    it('a slug no task has any more is ignored', () => {
      assert.deepStrictEqual(block(ep), ['cart', 'aaa', 'auth']);
      assert.deepStrictEqual(listed('shop').tasks.map((x) => x.slug), ['cart', 'aaa', 'auth']);
      assert.deepStrictEqual(listed('shop').problems, []);
    });
    it('the next reorder writes only the tasks there are', () => {
      const x = json(['reorder', 'auth', '--before', 'aaa', '--ws', 'shop']);
      assert.strictEqual(x.code, 0, x.all);
      assert.deepStrictEqual(readState(ep).taskOrder, ['cart', 'auth', 'aaa']);
    });
  }

  console.log('\nthe order of the tracker tasks');
  {
    const ep = epicWith('mall', ['web']);
    otherTasks(ep, [
      '<!-- the agent writes these from the tracker -->',
      '',
      '- ACME-1 first — open, ann',
      '  - a note under the first',
      '  more of it',
      '- [ ] **ACME-2** second — review',
      '',
      '- ACME-3 third',
      '  ```',
      '  - ACME-9 inside a fence, no item',
      '  ```',
      '- #44 an issue number',
      '',
    ].join('\n'));
    const listedMall = listed('mall');
    it('wsg list --json: trackerTasks in section order, the key as id', () => {
      assert.deepStrictEqual(listedMall.trackerTasks, [
        { id: 'ACME-1', text: 'ACME-1 first — open, ann' },
        { id: 'ACME-2', text: '[ ] **ACME-2** second — review' },
        { id: 'ACME-3', text: 'ACME-3 third' },
        { id: '#44', text: '#44 an issue number' },
      ]);
    });
    it('trackerTasks is [] for anything but an epic', () => assert.deepStrictEqual(listedMall.tasks[0].trackerTasks, []));
    const stateBefore = read(ep, '.claude', 'wsg.json');
    const r = json(['reorder', 'ACME-1', '--after', 'ACME-3', '--ws', 'mall']);
    it('a tracker task moves with its indented lines; the state is not touched', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.deepStrictEqual(r.doc.result, { workspace: ep, item: 'ACME-1', group: 'tracker', from: 1, to: 3, order: ['ACME-2', 'ACME-3', 'ACME-1', '#44'], changed: true, tasksMdUpdated: true });
      assert.strictEqual(read(ep, '.claude', 'wsg.json'), stateBefore);
      const text = read(ep, 'tasks.md');
      assert.ok(text.endsWith([
        '<!-- the agent writes these from the tracker -->',
        '',
        '- [ ] **ACME-2** second — review',
        '- ACME-3 third',
        '  ```',
        '  - ACME-9 inside a fence, no item',
        '  ```',
        '',
        '- ACME-1 first — open, ann',
        '  - a note under the first',
        '  more of it',
        '- #44 an issue number',
        '',
      ].join('\n')), text);
      assert.deepStrictEqual(block(ep), ['web']);
      assert.deepStrictEqual(drift(ep), []);
    });
    it('a key in any case, and an issue number, are found', () => {
      const x = json(['reorder', '#44', '--before', 'acme-2', '--ws', 'mall', '--dry-run']);
      assert.strictEqual(x.code, 0, x.all);
      assert.deepStrictEqual(x.doc.result.order, ['#44', 'ACME-2', 'ACME-3', 'ACME-1']);
    });
    it('the plain run names the section it changed', () => {
      const x = wsg(['reorder', 'ACME-1', '--to', '1', '--ws', 'mall']);
      assert.strictEqual(x.code, 0, x.all);
      assert.match(x.out, /Updated "## Other tasks" in .*tasks\.md/);
      assert.deepStrictEqual(listed('mall').trackerTasks.map((x2) => x2.id), ['ACME-1', 'ACME-2', 'ACME-3', '#44']);
    });
    it('the same place again: changed false', () => {
      const text = read(ep, 'tasks.md');
      const x = json(['reorder', 'ACME-1', '--before', 'ACME-2', '--ws', 'mall']);
      assert.strictEqual(x.doc.result.changed, false);
      assert.strictEqual(read(ep, 'tasks.md'), text);
    });
    const refused = (args, re) => {
      const x = json([...args, '--ws', 'mall']);
      assert.strictEqual(x.code, 2, x.all);
      assert.strictEqual(x.doc.error.code, 'invalid_input');
      assert.match(x.doc.error.message, re);
      return x;
    };
    it('across the groups: refused, both ways', () => {
      refused(['reorder', 'ACME-1', '--before', 'web'], /ACME-1 and web are in different groups/);
      refused(['reorder', 'web', '--after', 'ACME-2'], /web and ACME-2 are in different groups/);
    });
    it('an item nothing has: refused, the tasks named', () => refused(['reorder', 'nope', '--to', '1'], /nope is neither a task of the epic mall nor a tracker key .* \(its tasks: web\)/));
    it('a target nothing has: refused', () => refused(['reorder', 'ACME-1', '--before', 'ACME-77'], /ACME-77 is neither/));
    it('relative to itself: refused', () => refused(['reorder', 'ACME-1', '--before', 'acme-1'], /moved relative to itself/));
    it('--to out of range: refused', () => {
      refused(['reorder', 'ACME-1', '--to', '5'], /--to 5: a position from 1 to 4/);
      refused(['reorder', 'ACME-1', '--to', '0'], /--to 0: a position from 1 to 4/);
      refused(['reorder', 'ACME-1', '--to', 'x'], /--to x: a position/);
    });
    it('no place, or two: refused', () => {
      refused(['reorder', 'ACME-1'], /exactly one of --before X, --after X, --to N/);
      refused(['reorder', 'ACME-1', '--to', '1', '--before', 'ACME-2'], /exactly one of/);
    });
    it('no item: refused', () => refused(['reorder', '--to', '1'], /name the task to move/));
    it('a refused plan with --dry-run is the same document', () => {
      const x = wsg(['reorder', 'ACME-1', '--before', 'web', '--ws', 'mall', '--dry-run']);
      assert.strictEqual(x.code, 2);
      assert.match(JSON.parse(x.out).errors[0], /different groups/);
    });

    const good = read(ep, 'tasks.md');
    const withSection = (body) => otherTasks(ep, body);
    withSection('- ACME-1 one\n- just a line without a key\n- ACME-2 two\n');
    it('an item without a key: refused with its line, the tracker tasks not moved', () => {
      const x = refused(['reorder', 'ACME-2', '--to', '1'], /tasks\.md, line \d+: an item under "## Other tasks" without a tracker key at its start/);
      assert.ok(x.doc.result && x.doc.result.changed === false);
    });
    it('wsg list gives it with id null', () => assert.deepStrictEqual(listed('mall').trackerTasks[1], { id: null, text: 'just a line without a key' }));
    withSection('- ACME-1 one\n- ACME-2 two\n- ACME-1 again\n');
    it('the same key twice: refused', () => refused(['reorder', 'ACME-2', '--to', '1'], /line \d+: ACME-1 is listed twice under "## Other tasks"/));
    withSection('| Key | Summary |\n|---|---|\n| ACME-1 | one |\n');
    it('a table: a key refused, saying so; the task directories still move', () => {
      refused(['reorder', 'ACME-1', '--to', '1'], /"## Other tasks" holds a table/);
      assert.strictEqual(json(['reorder', 'web', '--to', '1', '--ws', 'mall', '--dry-run']).code, 0);
      assert.deepStrictEqual(listed('mall').trackerTasks, []);
    });
    withSection('- ACME-1 one\n| a | table |\n- ACME-2 two\n');
    it('a table between the items: refused', () => refused(['reorder', 'ACME-2', '--to', '1'], /"## Other tasks" holds a table/));
    withSection('- ACME-1 one\nSome words.\n- ACME-2 two\n');
    it('other text at column 0: refused', () => refused(['reorder', 'ACME-2', '--to', '1'], /holds text that is no list item/));
    withSection('- ACME-1 one\n\n### More\n- ACME-2 two\n');
    it('a heading of level 3 inside: refused as text', () => refused(['reorder', 'ACME-1', '--to', '1'], /holds text that is no list item/));
    withSection('- ACME-1 one\n- ACME-2 two\n\n## Later\n\n- ACME-3 not in the section\n');
    it('the section ends at the next heading of level 2', () => {
      assert.deepStrictEqual(listed('mall').trackerTasks.map((x) => x.id), ['ACME-1', 'ACME-2']);
      const x = json(['reorder', 'ACME-2', '--to', '1', '--ws', 'mall']);
      assert.strictEqual(x.code, 0, x.all);
      assert.match(read(ep, 'tasks.md'), /- ACME-2 two\n- ACME-1 one\n\n## Later\n\n- ACME-3 not in the section\n$/);
    });
    withSection('- ACME-1 one <!-- a comment\n  that goes on -->\n- ACME-2 two\r\n');
    it('a comment an item opens travels with it; CRLF lines are kept', () => {
      const x = json(['reorder', 'ACME-2', '--to', '1', '--ws', 'mall']);
      assert.strictEqual(x.code, 0, x.all);
      assert.match(read(ep, 'tasks.md'), /- ACME-2 two\r\n- ACME-1 one <!-- a comment\n {2}that goes on -->\n$/);
    });
    const text = read(ep, 'tasks.md');
    write(path.join(ep, 'tasks.md'), text.replace(/## Other tasks[^\n]*\n/, '## Others\n'));
    it('no "## Other tasks" section: a key is refused, saying so; wsg list gives none', () => {
      refused(['reorder', 'ACME-1', '--to', '1'], /has no "## Other tasks" section: there are no tracker tasks to move/);
      assert.deepStrictEqual(listed('mall').trackerTasks, []);
    });
    write(path.join(ep, 'tasks.md'), good);
  }

  console.log('\nthe tracker section: comments, fences, line ends');
  {
    const ep = epicWith('arcade', ['game']);
    const tasksMd = path.join(ep, 'tasks.md');
    const head = read(ep, 'tasks.md').slice(0, read(ep, 'tasks.md').indexOf('## Other tasks'));
    const set = (body) => write(tasksMd, `${head}${body}`);
    const tail = '## Decisions\n\nkept as it is\n';
    set(`## Other tasks\n\n- ACME-1 one\n- ACME-2 fix \`<!--\` parsing\n- ACME-3 three\n\n${tail}`);
    it('a <!-- in a code span opens no comment: the items stay in the section', () => {
      const x = json(['reorder', 'ACME-2', '--to', '1', '--ws', 'arcade']);
      assert.strictEqual(x.code, 0, x.all);
      assert.strictEqual(read(tasksMd), `${head}## Other tasks\n\n- ACME-2 fix \`<!--\` parsing\n- ACME-1 one\n- ACME-3 three\n\n${tail}`);
    });
    set(`## Other tasks\n\n- ACME-1 one\n  \`\`\`\n  code, never closed\n- ACME-2 two\n- ACME-3 three\n\n${tail}`);
    it('a fence a sub-line opens ends at the next line at column 0', () => {
      assert.deepStrictEqual(listed('arcade').trackerTasks.map((x) => x.id), ['ACME-1', 'ACME-2', 'ACME-3']);
      const x = json(['reorder', 'ACME-1', '--to', '3', '--ws', 'arcade']);
      assert.strictEqual(x.code, 0, x.all);
      assert.strictEqual(read(tasksMd), `${head}## Other tasks\n\n- ACME-2 two\n- ACME-3 three\n- ACME-1 one\n  \`\`\`\n  code, never closed\n\n${tail}`);
    });
    set('## Other tasks\n\n- ACME-1 one\n  ```\n  code\n- ACME-2 two\n');
    it('an item\'s fence left open at the end of the file: moved there and back again', () => {
      const x = json(['reorder', 'ACME-1', '--to', '2', '--ws', 'arcade']);
      assert.strictEqual(x.code, 0, x.all);
      assert.ok(read(tasksMd).endsWith('- ACME-2 two\n- ACME-1 one\n  ```\n  code\n'), read(tasksMd));
      const y = json(['reorder', 'ACME-1', '--to', '1', '--ws', 'arcade']);
      assert.strictEqual(y.code, 0, y.all);
      assert.ok(read(tasksMd).endsWith('## Other tasks\n\n- ACME-1 one\n  ```\n  code\n- ACME-2 two\n'), read(tasksMd));
    });
    set(`## Other tasks\n\n- ACME-1 one <!-- never closed\n- ACME-2 two\n\n${tail}`);
    it('a comment still open where the section ends: refused, nothing written', () => {
      const before = read(tasksMd);
      const x = json(['reorder', 'ACME-1', '--to', '2', '--ws', 'arcade']);
      assert.strictEqual(x.code, 2, x.all);
      assert.match(x.doc.error.message, /line \d+: a comment or a fenced block opened under "## Other tasks" is not closed/);
      assert.strictEqual(read(tasksMd), before);
    });
    set('## Other tasks\n\n```\n- ACME-5 in a fenced block\n```\n- ACME-1 one\n- ACME-2 two\n');
    it('a fenced block at column 0: nothing in it is an item; reorder refuses it as text', () => {
      assert.deepStrictEqual(listed('arcade').trackerTasks.map((x) => x.id), ['ACME-1', 'ACME-2']);
      const x = json(['reorder', 'ACME-2', '--to', '1', '--ws', 'arcade']);
      assert.strictEqual(x.code, 2, x.all);
      assert.match(x.doc.error.message, /holds text that is no list item/);
    });
    set('## other tasks:\n\n- ACME-1 one\n- ACME-2 two\n');
    it('the heading in another case, with a colon, is the section', () => {
      assert.deepStrictEqual(listed('arcade').trackerTasks.map((x) => x.id), ['ACME-1', 'ACME-2']);
      assert.strictEqual(json(['reorder', 'ACME-2', '--to', '1', '--ws', 'arcade']).code, 0);
    });
    write(tasksMd, `${head}## Other tasks\n\n- ACME-1 one\n- ACME-2 two\n- ACME-3 three`.replace(/\n/g, '\r\n'));
    it('CRLF without a final line end: CRLF throughout after the move, still no final line end', () => {
      const x = json(['reorder', 'ACME-3', '--to', '1', '--ws', 'arcade']);
      assert.strictEqual(x.code, 0, x.all);
      const text = read(tasksMd);
      assert.ok(!/[^\r]\n/.test(text), JSON.stringify(text.slice(-60)));
      assert.ok(text.endsWith('- ACME-3 three\r\n- ACME-1 one\r\n- ACME-2 two'), JSON.stringify(text.slice(-60)));
    });
    write(tasksMd, `${head}## Other tasks\n\n- ACME-1 one\n- ACME-2 two`);
    it('LF without a final line end: the item moved off the end gets one, the new last has none', () => {
      assert.strictEqual(json(['reorder', 'ACME-2', '--to', '1', '--ws', 'arcade']).code, 0);
      assert.ok(read(tasksMd).endsWith('\n- ACME-2 two\n- ACME-1 one'));
    });

    // Every move of every item of these sections keeps the lines (as a multiset), keeps every item in
    // the section in the order asked for, and leaves what is before and after the section as it was.
    const corpus = [
      '# T\n\n## Other tasks\n\n<!-- hint -->\n\n- ACME-1 a\n  - sub\n  more\n- [ ] **ACME-2** b\n\n- ACME-3 c\n  ```\n  - not an item\n  ```\n- #4 d\n',
      '# T\n\n## Other tasks\n\n- ACME-1 one\n- ACME-2 fix `<!--` parsing\n- ACME-3 three\n\n## Decisions\n\n- ACME-9 not here\n',
      '## Other tasks\n- ACME-1 x <!-- a\n  b -->\n- ACME-2 y\n  ```\n  open\n- ACME-3 z\n\n\n## Next\n',
      '## Other tasks (synced 2026-11-18 via tracker)\r\n\r\n- ACME-1 a\r\n- ACME-2 b\r\n  c\r\n- ACME-3 d',
      '## Other tasks\n\n- ACME-1 one\n  ```\n  code\n- ACME-2 two\n',
      '## Other tasks\n\n- ACME-1 a\n\n  after a blank\n\n- ACME-2 b\n<!-- between -->\n- ACME-3 c\n\n',
    ];
    const lines = (text) => text.split(/\r?\n/);
    for (const [n, text] of corpus.entries()) {
      it(`every move keeps the lines and the items in the section (sample ${n + 1})`, () => {
        const sec = R.trackerSection(text);
        assert.deepStrictEqual(sec.problems, []);
        const keys = sec.items.map((x) => x.key);
        const before = lines(text);
        for (const key of keys) {
          for (let to = 1; to <= keys.length; to++) {
            const r = R.move(keys, key, { to: String(to) }, (a, b) => a === b);
            const out = R.withItems(sec, r.order.map((k) => sec.items.find((x) => x.key === k)));
            const after = lines(out);
            assert.deepStrictEqual([...after].sort(), [...before].sort(), `${key} to ${to}: the lines`);
            const again = R.trackerSection(out);
            assert.deepStrictEqual(again.problems, [], `${key} to ${to}: problems`);
            assert.deepStrictEqual(again.items.map((x) => x.key), r.order, `${key} to ${to}: the order`);
            assert.deepStrictEqual(after.slice(0, sec.start), before.slice(0, sec.start), `${key} to ${to}: before the section`);
            assert.deepStrictEqual(after.slice(again.end), before.slice(sec.end), `${key} to ${to}: after the section`);
          }
        }
      });
    }
  }

  console.log('\na task directory renamed by hand');
  {
    const ep = epicWith('deli', ['bread', 'cake', 'soup']);
    fs.renameSync(path.join(ep, 'soup'), path.join(ep, 'Soup_Old'));
    const x = json(['reorder', 'bread', '--to', '2', '--ws', 'deli']);
    it('left out of the order, with a warning; the state written still reads', () => {
      assert.strictEqual(x.code, 0, x.all);
      assert.deepStrictEqual(x.doc.result.order, ['cake', 'bread']);
      assert.deepStrictEqual(readState(ep).taskOrder, ['cake', 'bread']);
      assert.ok(x.doc.warnings.some((w) => /directory names are no slugs.*Soup_Old/.test(w)), JSON.stringify(x.doc.warnings));
      assert.strictEqual(W.stateProblem(readState(ep)), '');
      assert.strictEqual(wsg(['list']).code, 0);
    });
    it('moving it is refused, saying why', () => {
      const y = json(['reorder', 'Soup_Old', '--to', '1', '--ws', 'deli']);
      assert.strictEqual(y.code, 2, y.all);
      assert.match(y.doc.error.message, /Soup_Old: its directory name is no slug/);
    });
  }

  console.log('\nrefusals, locks, rollback');
  {
    const ep = epicWith('cafe', ['one', 'two']);
    assert.strictEqual(wsg(['new', 'solo', '--no-launch']).code, 0);
    it('a task outside an epic: refused', () => {
      const x = json(['reorder', 'one', '--to', '1', '--ws', 'solo']);
      assert.strictEqual(x.code, 2, x.all);
      assert.match(x.doc.error.message, /outside an epic: wsg reorder orders the tasks of an epic/);
    });
    it('in Russian', () => {
      const x = json(['reorder', 'one', '--to', '1', '--ws', 'solo'], { env: { WSG_LANG: 'ru' } });
      assert.match(x.doc.error.message, /вне эпика: wsg reorder упорядочивает задачи эпика/);
    });
    const lockFile = path.join(ep, '.claude', 'wsg.lock');
    write(lockFile, JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
    const busy = json(['reorder', 'two', '--to', '1', '--ws', 'cafe']);
    it('an epic another command holds: exit 2, busy, nothing changed', () => {
      assert.strictEqual(busy.code, 2, busy.all);
      assert.strictEqual(busy.doc.error.code, 'busy');
      assert.strictEqual(readState(ep).taskOrder, undefined);
    });
    it('a dry run takes no lock', () => assert.strictEqual(json(['reorder', 'two', '--to', '1', '--ws', 'cafe', '--dry-run']).code, 0));
    fs.unlinkSync(lockFile);
    const stateBefore = read(ep, '.claude', 'wsg.json');
    fs.chmodSync(path.join(ep, 'tasks.md'), 0o444);
    const fail = json(['reorder', 'two', '--to', '1', '--ws', 'cafe']);
    fs.chmodSync(path.join(ep, 'tasks.md'), 0o644);
    it('tasks.md that can\'t be written: step_failed, the state put back', () => {
      if (process.getuid && process.getuid() === 0) return;
      assert.strictEqual(fail.code, 1, fail.all);
      assert.strictEqual(fail.doc.error.code, 'step_failed');
      assert.strictEqual(read(ep, '.claude', 'wsg.json'), stateBefore);
      assert.deepStrictEqual(block(ep), ['one', 'two']);
    });
  }

  console.log('\nthe taskOrder in the state');
  {
    const base = { kind: 'epic', version: W.EPIC_STATE_VERSION, slug: 'x', sources: [] };
    it('a list of slugs, each once: valid', () => assert.strictEqual(W.stateProblem({ ...base, taskOrder: ['a', 'b-2'] }), ''));
    it('only on an epic', () => assert.match(W.stateProblem({ kind: 'task', version: W.STATE_VERSION, sources: [], taskOrder: [] }), /"taskOrder" belongs only to an epic/));
    for (const [what, v] of [['a slug twice', ['a', 'a']], ['no kebab-case', ['A b']], ['not a list', 'a'], ['a number', [1]]]) {
      it(`${what}: the state does not read`, () => assert.match(W.stateProblem({ ...base, taskOrder: v }), /"taskOrder" must be a list of task slugs, each once/));
    }
    it('byTaskOrder: named first as named, the rest by name, unknown slugs ignored', () =>
      assert.deepStrictEqual(W.byTaskOrder(['d', 'b', 'a', 'c'], ['c', 'gone', 'a']), ['c', 'a', 'b', 'd']));
    it('keyOf: a key behind a checkbox, emphasis, a link or a code span; none in the middle', () => {
      assert.strictEqual(R.keyOf('[x] **ACME-7** done'), 'ACME-7');
      assert.strictEqual(R.keyOf('[ACME-8](https://tracker.example/ACME-8) linked'), 'ACME-8');
      assert.strictEqual(R.keyOf('`ACME-9` code'), 'ACME-9');
      assert.strictEqual(R.keyOf('#12 issue'), '#12');
      assert.strictEqual(R.keyOf('see ACME-1'), null);
      assert.strictEqual(R.keyOf('ACME-1x not a key'), null);
    });
  }

  finished = true;
  console.log(failed === 0 ? `\n${passed} checks passed, 0 blocks skipped\n` : `\nfailed: ${failed}, ${passed} passed, 0 blocks skipped\n`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  console.log(`\nFAIL  ${e.stack || e}`);
  process.exitCode = 1;
});
