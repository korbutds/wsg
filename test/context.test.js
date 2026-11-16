'use strict';

// The epic's context (wsg 0.7): the `context` key of an epic's state, the <!-- wsg:epic-context -->
// index block it renders into the epic's and every task's AGENTS.md, and the refresh of every task
// of an epic after a change of it. Each command runs in a child process with its own HOME and
// WS_ROOT; nothing here needs the network or a real agent.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn, execFileSync } = require('node:child_process');

process.env.WSG_LANG = 'en';

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const W = require(path.join(ROOT, 'lib', 'workspace.js'));
const generate = require(path.join(ROOT, 'lib', 'generate.js'));
const T = require(path.join(ROOT, 'lib', 'templates.js'));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-context-')));
const home = path.join(tmp, 'home');
fs.mkdirSync(home);
const ENV = {
  PATH: process.env.PATH,
  HOME: home,
  WSG_LANG: 'en',
  WSG_CONFIG: path.join(tmp, 'no-config'),
  CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
  WSG_NO_LAUNCH: '1',
};
const wsg = (args, { cwd = tmp, env = {}, input = '' } = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', input, env: { ...ENV, ...env }, maxBuffer: 1 << 26 });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
};
const jsonOf = (r) => { try { return JSON.parse(r.out); } catch { return null; } };

let failed = 0;
const it = (name, fn) => {
  try { fn(); console.log(`  ok    ${name}`); } catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};
let finished = false;
process.on('exit', () => {
  if (!finished) { console.log('\nFAIL  the suite stopped before the end'); process.exitCode = 1; }
});

const read = (p) => fs.readFileSync(p, 'utf8');
// A file made read-only stops a write only for a user other than root: those rollback tests skip then.
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const blockOf = (text, name = 'epic-context') => {
  const m = new RegExp(`<!-- wsg:${name} -->\\n([\\s\\S]*?)<!-- /wsg:${name} -->\\n`).exec(text);
  return m ? m[1] : null;
};
// Every path under a directory with its bytes: "touches nothing" means this is unchanged.
function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d).sort()) {
      const p = path.join(d, e);
      const rel = path.relative(dir, p);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) { out[rel] = 'dir'; walk(p); } else out[rel] = fs.readFileSync(p).toString('base64');
    }
  };
  walk(dir);
  return out;
}
// A root of its own with an epic in it: { root, env, ep }.
function epicRoot(name, slug = 'shop') {
  const root = path.join(tmp, name);
  const env = { WS_ROOT: root };
  const r = wsg(['new', slug, '--kind', 'epic', '--no-launch'], { env });
  if (r.code !== 0) throw new Error(r.all);
  return { root, env, ep: path.join(root, slug) };
}
const stateFile = (ws) => path.join(ws, '.claude', 'wsg.json');
const setState = (ws, fn) => {
  const s = JSON.parse(read(stateFile(ws)));
  fs.writeFileSync(stateFile(ws), `${JSON.stringify(fn(s), null, 2)}\n`);
};
const ITEMS = [
  { id: 'api-spec', type: 'file', title: 'api.yaml', description: 'the public REST API', path: 'context/api.yaml', bytes: 12345, sha256: 'a'.repeat(64), binary: false, copied: true },
  { id: 'brief', type: 'file', title: 'Brief', description: '', path: 'context/brief.pdf', bytes: 2202010, sha256: 'b'.repeat(64), binary: true, copied: false },
  { id: 'deploy', type: 'note', title: 'Deploy', description: 'how the shop deploys', path: 'context/notes/deploy.md', bytes: 300, sha256: 'c'.repeat(64) },
  { id: 'mockups', type: 'link', title: 'Mockups', description: 'checkout screens', url: 'https://example.com/shop/checkout' },
];

(async () => {
  console.log('\nthe context key of an epic\'s state');
  {
    const base = { version: 3, kind: 'epic', slug: 'shop', title: 'Shop', sources: [] };
    const problem = (context, extra = {}) => W.stateProblem({ ...base, ...extra, ...(context === undefined ? {} : { context }) });
    it('no context: fine, as before', () => assert.strictEqual(problem(undefined), ''));
    it('an empty list and every type: fine', () => {
      assert.strictEqual(problem([]), '');
      assert.strictEqual(problem(ITEMS), '');
    });
    it('a name that only starts like the instructions files is fine: claude-api-notes.md, agents-of-change.md', () => {
      assert.strictEqual(problem([{ ...ITEMS[0], path: 'context/claude-api-notes.md' }]), '');
      assert.strictEqual(problem([{ ...ITEMS[0], path: 'context/agents-of-change.md' }]), '');
    });
    it('unknown top-level keys are still tolerated', () => assert.strictEqual(problem(ITEMS, { later: { x: 1 } }), ''));
    it('only an epic has it', () => {
      assert.match(W.stateProblem({ version: 2, kind: 'task', slug: 'x', sources: [], context: [] }), /"context" belongs only to an epic/);
    });
    const bad = [
      ['not a list', {}, /must be a list/],
      ['an unknown type', [{ ...ITEMS[0], type: 'dir' }], /"type" must be one of file, note, link/],
      ['a missing key', [(({ binary, ...x }) => x)(ITEMS[0])], /a file has exactly id, type, title, description, path, bytes, sha256, binary, copied/],
      ['a sha256 that is no hex digest', [{ ...ITEMS[2], sha256: 'xyz' }], /"sha256" must be 64 hex digits/],
      ['a file named like agents\' instructions', [{ ...ITEMS[0], path: 'context/Claude.local.md' }], /context\/<name>/],
      ['AGENTS.override.md', [{ ...ITEMS[0], path: 'context/AGENTS.override.md' }], /context\/<name>/],
      ['copied that is no boolean', [{ ...ITEMS[0], copied: 'yes' }], /"copied" must be true or false/],
      ['an extra key', [{ ...ITEMS[3], path: 'x' }], /a link has exactly/],
      ['an id that is not kebab-case', [{ ...ITEMS[3], id: 'Mock ups' }], /"id" must be kebab-case/],
      ['the same id twice', [ITEMS[3], { ...ITEMS[0], id: 'mockups' }], /the id is used twice/],
      ['a title of two lines', [{ ...ITEMS[3], title: 'a\nb' }], /"title" must be one line/],
      ['an empty title', [{ ...ITEMS[3], title: '' }], /"title" must be one line/],
      ['a description over 200 characters', [{ ...ITEMS[3], description: 'x'.repeat(201) }], /"description" must be one line of at most 200/],
      ['a URL that is no http one', [{ ...ITEMS[3], url: 'file:///etc/passwd' }], /http or https URL/],
      ['a file outside context/', [{ ...ITEMS[0], path: '../secret' }], /context\/<name>/],
      ['a file in a subdirectory', [{ ...ITEMS[0], path: 'context/a/b.md' }], /context\/<name>/],
      ['a hidden file', [{ ...ITEMS[0], path: 'context/.env' }], /context\/<name>/],
      ['a note elsewhere', [{ ...ITEMS[2], path: 'context/deploy.md' }], /a note's "path" is context\/notes\/deploy\.md/],
      ['bytes that are no number', [{ ...ITEMS[0], bytes: '12' }], /"bytes" must be a whole number/],
      ['the same path twice', [ITEMS[0], { ...ITEMS[0], id: 'other' }], /the path is used twice/],
    ];
    for (const [name, context, re] of bad) it(`refused: ${name}`, () => assert.match(problem(context), re));
    it('RESERVED has context: an epic\'s task can\'t take the name', () => {
      assert.ok(W.RESERVED.includes('context'));
      const { ep } = epicRoot('reserved-root');
      assert.throws(() => W.assertSafe({ kind: 'task', slug: 'context', epicWs: ep }, { WS_ROOT: path.dirname(ep) }), /reserved|name/i);
    });
  }

  console.log('\nthe index block: rendered from the epic\'s state');
  {
    const { env, ep } = epicRoot('render-root');
    const created = read(path.join(ep, 'AGENTS.md'));
    it('a new epic has an empty block right after the advisor block', () => {
      assert.match(created, /<!-- \/wsg:advisor -->\n<!-- wsg:epic-context -->\n<!-- \/wsg:epic-context -->\n/);
    });
    const n = wsg(['new', 'cart', '--epic', 'shop', '--no-launch'], { env });
    const task = path.join(ep, 'cart');
    it('a new task of it: an empty block right after the epic\'s Owner rules, no warning', () => {
      assert.strictEqual(n.code, 0, n.all);
      assert.match(read(path.join(task, 'AGENTS.md')), /<!-- \/wsg:epic-rules -->\n<!-- wsg:epic-context -->\n<!-- \/wsg:epic-context -->\n/);
      assert.doesNotMatch(n.all, /WARN|warn/);
    });
    it('and a refresh of either changes nothing', () => {
      for (const ws of [ep, task]) assert.deepStrictEqual(JSON.parse(wsg(['refresh', '--dry-run', '--ws', ws], { env }).out).files, []);
    });

    setState(ep, (s) => ({ ...s, context: ITEMS }));
    const r1 = wsg(['refresh', '--ws', ep], { env });
    const epicBlock = blockOf(read(path.join(ep, 'AGENTS.md')));
    it('the epic\'s refresh renders its index, paths from the epic', () => {
      assert.strictEqual(r1.code, 0, r1.all);
      assert.strictEqual(epicBlock, [
        'Context of this epic, attached by the owner; its tasks get this list too: open an item only when the work touches its topic; do not read them all. A binary file (PDF, image) is read by Claude Code; other agents may not read it.',
        '- [file] api.yaml — the public REST API: `context/api.yaml` (12 KiB)',
        '- [file] Brief: `context/brief.pdf` (2.1 MiB, binary)',
        '- [note] Deploy — how the shop deploys: `context/notes/deploy.md` (300 B)',
        '- [link] Mockups — checkout screens: https://example.com/shop/checkout',
        '',
      ].join('\n'));
    });
    it('the epic\'s own refresh does not write into its tasks', () => assert.strictEqual(blockOf(read(path.join(task, 'AGENTS.md'))), ''));
    const r2 = wsg(['refresh', '--ws', task], { env });
    const taskBlock = blockOf(read(path.join(task, 'AGENTS.md')));
    it('the task\'s refresh renders the same items, paths from the task', () => {
      assert.strictEqual(r2.code, 0, r2.all);
      assert.strictEqual(taskBlock.split('\n')[0], 'Context of epic `shop`, attached by the owner: open an item only when the task touches its topic; do not read them all. A binary file (PDF, image) is read by Claude Code; other agents may not read it.');
      assert.ok(taskBlock.includes('- [file] api.yaml — the public REST API: `../context/api.yaml` (12 KiB)\n'));
      assert.ok(taskBlock.includes('- [note] Deploy — how the shop deploys: `../context/notes/deploy.md` (300 B)\n'));
      assert.ok(taskBlock.includes('- [link] Mockups — checkout screens: https://example.com/shop/checkout\n'));
    });
    it('right after the epic-rules block', () => assert.match(read(path.join(task, 'AGENTS.md')), /<!-- \/wsg:epic-rules -->\n<!-- wsg:epic-context -->\nContext of epic/));
    it('an unchanged epic renders the same bytes: a second refresh changes nothing', () => {
      for (const ws of [ep, task]) assert.deepStrictEqual(JSON.parse(wsg(['refresh', '--dry-run', '--ws', ws], { env }).out).files, []);
    });
    it('the template and the render agree on the block', () => {
      const lines = T.epicContextLines('shop', { kind: 'items', items: ITEMS }, 'task');
      assert.strictEqual(`${lines.join('\n')}\n`, taskBlock);
    });

    const n2 = wsg(['new', 'checkout', '--epic', 'shop', '--no-launch'], { env });
    const later = path.join(ep, 'checkout');
    it('a task made after the context exists gets the index at wsg new --epic, no warning', () => {
      assert.strictEqual(n2.code, 0, n2.all);
      assert.doesNotMatch(n2.all, /WARN|warn/);
      assert.strictEqual(blockOf(read(path.join(later, 'AGENTS.md'))), taskBlock);
    });
    it('and its refresh right after changes nothing', () => assert.deepStrictEqual(JSON.parse(wsg(['refresh', '--dry-run', '--ws', later], { env }).out).files, []));

    // An epic that can't be read: the task keeps its block, with a warning, and the refresh goes on.
    const good = read(stateFile(ep));
    fs.writeFileSync(stateFile(ep), '{ broken');
    const before = read(path.join(task, 'AGENTS.md'));
    const r3 = wsg(['refresh', '--ws', task], { env });
    it('an epic that can\'t be read: the refresh exits 0', () => assert.strictEqual(r3.code, 0, r3.all));
    it('the block is kept as it was', () => assert.strictEqual(read(path.join(task, 'AGENTS.md')), before));
    it('with a warning saying why', () => assert.match(r3.all, /the epic's context index was not rendered: .*wsg\.json.*kept as it was/));
    fs.writeFileSync(stateFile(ep), good);

    // A task made before 0.7: no block. Its refresh adds it, said once as news.
    const t = path.join(task, 'AGENTS.md');
    fs.writeFileSync(t, read(t).replace(/<!-- wsg:epic-context -->\n[\s\S]*?<!-- \/wsg:epic-context -->\n/, ''));
    const r4 = wsg(['refresh', '--ws', task], { env });
    it('a 0.6 task gets the block on refresh, after its epic-rules block', () => {
      assert.strictEqual(r4.code, 0, r4.all);
      assert.strictEqual(blockOf(read(t)), taskBlock);
      assert.match(read(t), /<!-- \/wsg:epic-rules -->\n<!-- wsg:epic-context -->/);
    });
    it('reported as new in wsg 0.7.0', () => assert.match(r4.all, /added the <!-- wsg:epic-context --> block \(new in wsg 0\.7\.0\)/));
    const e = path.join(ep, 'AGENTS.md');
    fs.writeFileSync(e, read(e).replace(/<!-- wsg:epic-context -->\n[\s\S]*?<!-- \/wsg:epic-context -->\n/, ''));
    const r5 = wsg(['refresh', '--ws', ep], { env });
    it('so does a 0.6 epic, after its advisor block', () => {
      assert.strictEqual(r5.code, 0, r5.all);
      assert.strictEqual(blockOf(read(e)), epicBlock);
      assert.match(read(e), /<!-- \/wsg:advisor -->\n<!-- wsg:epic-context -->/);
      assert.match(r5.all, /added the <!-- wsg:epic-context --> block \(new in wsg 0\.7\.0\)/);
    });
    it('a plain task gets no block', () => {
      wsg(['new', 'plain', '--no-launch'], { env });
      assert.strictEqual(blockOf(read(path.join(path.dirname(ep), 'plain', 'AGENTS.md'))), null);
    });

    // Paths are kept relative: the epic's directory moved, every path still holds.
    const moved = path.join(tmp, 'moved-root');
    fs.mkdirSync(moved);
    fs.renameSync(ep, path.join(moved, 'shop'));
    const r6 = wsg(['refresh', '--ws', path.join(moved, 'shop', 'cart')], { env: { WS_ROOT: moved } });
    it('the epic\'s directory moved: the task\'s block is still the same, the paths relative', () => {
      assert.strictEqual(r6.code, 0, r6.all);
      assert.strictEqual(blockOf(read(path.join(moved, 'shop', 'cart', 'AGENTS.md'))), taskBlock);
      assert.deepStrictEqual(JSON.parse(read(stateFile(path.join(moved, 'shop')))).context, ITEMS);
    });
  }

  console.log('\nrefreshing every task of an epic');
  {
    const { env, ep } = epicRoot('fanout-root');
    for (const slug of ['alpha', 'busy', 'closed', 'delta']) wsg(['new', slug, '--epic', 'shop', '--no-launch'], { env });
    wsg(['close', 'shop/closed'], { env });
    setState(ep, (s) => ({ ...s, context: [ITEMS[3]] }));
    wsg(['refresh', '--ws', ep], { env });
    // Another wsg command holds busy: a lock file naming a live process (this one).
    const lockFile = path.join(ep, 'busy', '.claude', 'wsg.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
    const closedBefore = read(path.join(ep, 'closed', 'AGENTS.md'));
    const busyBefore = read(path.join(ep, 'busy', 'AGENTS.md'));
    const quiet = async (fn) => {
      const log = console.log;
      const err = process.stderr.write;
      console.log = () => {};
      process.stderr.write = () => true;
      try { return await fn(); } finally { console.log = log; process.stderr.write = err; }
    };
    const dry = await quiet(() => generate.refreshEpicTasks(ep, { dryRun: true }));
    it('a dry run lists the tasks, refreshes none, touches nothing', () => {
      assert.deepStrictEqual(dry.map((x) => [x.task, x.refreshed, x.code, x.reason === null]), [['alpha', false, null, true], ['busy', false, null, true], ['closed', false, 'done', false], ['delta', false, null, true]]);
      assert.doesNotMatch(read(path.join(ep, 'alpha', 'AGENTS.md')), /\[link\] Mockups/);
    });
    const res = await quiet(() => generate.refreshEpicTasks(ep));
    const by = Object.fromEntries(res.map((x) => [x.task, x]));
    it('every task listed, by its directory', () => {
      assert.deepStrictEqual(res.map((x) => x.task), ['alpha', 'busy', 'closed', 'delta']);
      assert.strictEqual(by.alpha.path, path.join(ep, 'alpha'));
    });
    it('the free ones refreshed: the index is there', () => {
      for (const slug of ['alpha', 'delta']) {
        assert.strictEqual(by[slug].refreshed, true);
        assert.strictEqual(by[slug].reason, null);
        assert.strictEqual(by[slug].code, null);
        assert.match(read(path.join(ep, slug, 'AGENTS.md')), /- \[link\] Mockups — checkout screens: https:\/\/example\.com\/shop\/checkout/);
      }
    });
    it('a busy one reported, not refreshed, left as it was', () => {
      assert.strictEqual(by.busy.refreshed, false);
      assert.strictEqual(by.busy.code, 'busy');
      assert.match(by.busy.reason, /another wsg command is running/);
      assert.strictEqual(read(path.join(ep, 'busy', 'AGENTS.md')), busyBefore);
      assert.ok(fs.existsSync(lockFile), 'the other command\'s lock stays');
    });
    it('a done one skipped', () => {
      assert.strictEqual(by.closed.refreshed, false);
      assert.strictEqual(by.closed.code, 'done');
      assert.match(by.closed.reason, /done/);
      assert.strictEqual(read(path.join(ep, 'closed', 'AGENTS.md')), closedBefore);
    });
    it('no lock is left behind in the tasks it refreshed', () => {
      for (const slug of ['alpha', 'delta']) assert.ok(!fs.existsSync(path.join(ep, slug, '.claude', 'wsg.lock')));
    });
    fs.rmSync(lockFile);
    // A task whose state doesn't read: reported as failed, not left out.
    fs.mkdirSync(path.join(ep, 'broken', '.claude'), { recursive: true });
    fs.writeFileSync(path.join(ep, 'broken', '.claude', 'wsg.json'), '{ nope');
    const withBroken = await quiet(() => generate.refreshEpicTasks(ep, { dryRun: true }));
    it('a task directory whose state does not read: listed, code failed, with why', () => {
      const b = withBroken.find((x) => x.task === 'broken');
      assert.deepStrictEqual([b.refreshed, b.code, b.path], [false, 'failed', path.join(ep, 'broken')]);
      assert.match(b.reason, /wsg\.json/);
      assert.deepStrictEqual(withBroken.map((x) => x.task), ['alpha', 'broken', 'busy', 'closed', 'delta']);
    });
    fs.rmSync(path.join(ep, 'broken'), { recursive: true });
    // Asked to stop after the first task (a signal between two): the rest are not refreshed.
    setState(ep, (s) => ({ ...s, context: [ITEMS[2]] }));
    let asked = 0;
    const stopped = await quiet(() => generate.refreshEpicTasks(ep, { stop: () => ++asked > 1 }));
    it('stopped after the first task: the ones left are reported as interrupted, not touched', () => {
      assert.deepStrictEqual(stopped.map((x) => [x.task, x.refreshed, x.code]), [['alpha', true, null], ['busy', false, 'interrupted'], ['closed', false, 'done'], ['delta', false, 'interrupted']]);
      assert.match(stopped[1].reason, /cancelled before this task was refreshed/);
      assert.match(read(path.join(ep, 'alpha', 'AGENTS.md')), /\[note\] Deploy/);
      assert.doesNotMatch(read(path.join(ep, 'delta', 'AGENTS.md')), /\[note\] Deploy/);
    });
  }

  console.log('\nwsg context: add, note, remove, list');
  {
    const { root, env, ep } = epicRoot('cmd-root');
    for (const slug of ['cart', 'closed']) wsg(['new', slug, '--epic', 'shop', '--no-launch'], { env });
    wsg(['close', 'shop/closed'], { env });
    const cart = path.join(ep, 'cart');
    const files = path.join(tmp, 'cmd-files');
    fs.mkdirSync(files);
    fs.writeFileSync(path.join(files, 'API Spec.yaml'), 'openapi: 3.0.0\n');
    fs.writeFileSync(path.join(files, 'brief.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x01]));
    fs.mkdirSync(path.join(files, 'designs'));
    const ctx = (args, opts = {}) => wsg(['context', ...args], { env, ...opts });

    const before = tree(ep);
    const dry = ctx(['add', path.join(files, 'API Spec.yaml'), '--ws', 'shop', '--desc', 'the public REST API', '--dry-run', '--json']);
    const dj = jsonOf(dry);
    it('a dry run: exit 0, the envelope names both words and says dryRun', () => {
      assert.strictEqual(dry.code, 0, dry.all);
      assert.strictEqual(dj.command, 'context add');
      assert.strictEqual(dj.dryRun, true);
      assert.strictEqual(dj.ok, true);
    });
    it('the plan: the item, the files it would write, every task with refreshed false', () => {
      assert.deepStrictEqual(Object.keys(dj.result), ['workspace', 'item', 'files', 'restartNeeded', 'tasks']);
      assert.strictEqual(dj.result.workspace, ep);
      assert.deepStrictEqual(dj.result.item, { id: 'api-spec', type: 'file', title: 'API Spec.yaml', description: 'the public REST API', url: null, path: path.join(ep, 'context', 'API Spec.yaml'), bytes: 15, binary: false, copied: true });
      assert.deepStrictEqual(dj.result.files, [path.join(ep, 'context', 'API Spec.yaml'), path.join(ep, 'AGENTS.md'), path.join(ep, '.claude', 'wsg.json')]);
      assert.strictEqual(dj.result.restartNeeded, true);
      assert.deepStrictEqual(dj.result.tasks.map((x) => [x.task, x.refreshed, x.code, x.reason === null]), [['cart', false, null, true], ['closed', false, 'done', false]]);
    });
    it('and touches nothing', () => assert.deepStrictEqual(tree(ep), before));
    const plainDry = ctx(['add', path.join(files, 'API Spec.yaml'), '--ws', 'shop', '--dry-run']);
    it('a plain dry run prints the same plan as JSON, with errors and warnings', () => {
      assert.strictEqual(plainDry.code, 0, plainDry.all);
      const p = JSON.parse(plainDry.out);
      assert.deepStrictEqual(p.errors, []);
      assert.strictEqual(p.item.id, 'api-spec');
    });

    const add = ctx(['add', path.join(files, 'API Spec.yaml'), '--ws', 'shop', '--desc', 'the public REST API', '--json']);
    const aj = jsonOf(add);
    it('add a file: exit 0, copied into context/ under its name', () => {
      assert.strictEqual(add.code, 0, add.all);
      assert.strictEqual(read(path.join(ep, 'context', 'API Spec.yaml')), 'openapi: 3.0.0\n');
    });
    it('the state keeps the path relative to the epic', () => {
      const sha = require('node:crypto').createHash('sha256').update('openapi: 3.0.0\n').digest('hex');
      assert.deepStrictEqual(JSON.parse(read(stateFile(ep))).context, [{ id: 'api-spec', type: 'file', title: 'API Spec.yaml', description: 'the public REST API', path: 'context/API Spec.yaml', bytes: 15, sha256: sha, binary: false, copied: true }]);
    });
    it('the epic\'s index and the open task\'s have it; the done task is left as it was', () => {
      assert.match(read(path.join(ep, 'AGENTS.md')), /- \[file\] API Spec\.yaml — the public REST API: `context\/API Spec\.yaml` \(15 B\)/);
      assert.match(read(path.join(cart, 'AGENTS.md')), /- \[file\] API Spec\.yaml — the public REST API: `\.\.\/context\/API Spec\.yaml` \(15 B\)/);
      assert.doesNotMatch(read(path.join(ep, 'closed', 'AGENTS.md')), /API Spec/);
    });
    it('the result: the tasks as refreshed, the done one with its reason', () => {
      assert.strictEqual(aj.dryRun, false);
      assert.deepStrictEqual(aj.result.tasks, [
        { task: 'cart', path: cart, refreshed: true, code: null, reason: null },
        { task: 'closed', path: path.join(ep, 'closed'), refreshed: false, code: 'done', reason: 'done: not refreshed' },
      ]);
      assert.deepStrictEqual(aj.warnings, []);
    });
    it('no lock is left in the epic or its tasks', () => {
      for (const ws of [ep, cart]) assert.ok(!fs.existsSync(path.join(ws, '.claude', 'wsg.lock')));
    });

    const link = ctx(['add', 'https://www.example.com/shop/checkout', '--ws', ep, '--title', 'Mockups', '--desc', 'checkout screens']);
    it('add a URL: a link, kept only in the state', () => {
      assert.strictEqual(link.code, 0, link.all);
      assert.match(link.out, /Added link example-checkout to the context of shop/);
      assert.match(link.out, /Tasks refreshed: cart/);
      assert.match(read(path.join(cart, 'AGENTS.md')), /- \[link\] Mockups — checkout screens: https:\/\/www\.example\.com\/shop\/checkout/);
    });
    const bin = ctx(['add', path.join(files, 'brief.pdf'), '--ws', 'shop']);
    it('a binary file is copied as it is and marked', () => {
      assert.strictEqual(bin.code, 0, bin.all);
      assert.ok(fs.readFileSync(path.join(ep, 'context', 'brief.pdf')).equals(fs.readFileSync(path.join(files, 'brief.pdf'))));
      assert.match(read(path.join(cart, 'AGENTS.md')), /- \[file\] brief\.pdf: `\.\.\/context\/brief\.pdf` \(7 B, binary\)/);
      assert.match(read(path.join(cart, 'AGENTS.md')), /A binary file \(PDF, image\) is read by Claude Code; other agents may not read it\./);
    });

    const note = ctx(['note', 'deploy', '--text', 'Deploy by hand on Fridays', '--title', 'Deploy', '--desc', 'how the shop deploys', '--ws', 'shop', '--json']);
    it('a note from --text: written to context/notes/<id>.md with a final newline', () => {
      assert.strictEqual(note.code, 0, note.all);
      assert.strictEqual(jsonOf(note).command, 'context note');
      assert.strictEqual(read(path.join(ep, 'context', 'notes', 'deploy.md')), 'Deploy by hand on Fridays\n');
      assert.deepStrictEqual(jsonOf(note).result.item, { id: 'deploy', type: 'note', title: 'Deploy', description: 'how the shop deploys', url: null, path: path.join(ep, 'context', 'notes', 'deploy.md'), bytes: 26, binary: false, copied: true });
    });
    const again = ctx(['note', 'deploy', '--text', 'x', '--ws', 'shop', '--json']);
    it('the same id again without --replace: refused, nothing changed', () => {
      assert.strictEqual(again.code, 2, again.all);
      assert.strictEqual(jsonOf(again).error.code, 'invalid_input');
      assert.match(jsonOf(again).error.message, /note deploy exists: --replace rewrites it/);
      assert.strictEqual(read(path.join(ep, 'context', 'notes', 'deploy.md')), 'Deploy by hand on Fridays\n');
    });
    const stdin = ctx(['note', 'deploy', '--from', '-', '--replace', '--ws', 'shop'], { input: 'Deploy with the pipeline\n' });
    it('--replace from stdin: the body rewritten, the title and description kept', () => {
      assert.strictEqual(stdin.code, 0, stdin.all);
      assert.match(stdin.out, /Rewrote note deploy/);
      assert.strictEqual(read(path.join(ep, 'context', 'notes', 'deploy.md')), 'Deploy with the pipeline\n');
      const item = JSON.parse(read(stateFile(ep))).context.find((x) => x.id === 'deploy');
      assert.deepStrictEqual([item.title, item.description, item.bytes], ['Deploy', 'how the shop deploys', 25]);
    });
    fs.writeFileSync(path.join(files, 'runbook.md'), '# Runbook\n');
    const fromFile = ctx(['note', 'runbook', '--from', path.join(files, 'runbook.md'), '--ws', 'shop']);
    it('a note from a file', () => {
      assert.strictEqual(fromFile.code, 0, fromFile.all);
      assert.strictEqual(read(path.join(ep, 'context', 'notes', 'runbook.md')), '# Runbook\n');
    });
    const refusals = [
      ['--replace of a note that is not there', ['note', 'nope', '--text', 'x', '--replace'], /no note nope to replace/],
      ['--replace of a file', ['note', 'api-spec', '--text', 'x', '--replace'], /api-spec is a file, not a note/],
      ['a note without text', ['note', 'empty', '--text', '  '], /the note is empty/],
      ['a note with both --text and --from', ['note', 'two', '--text', 'x', '--from', '-'], /exactly one of --text T, --from FILE or --from -/],
      ['a note without either', ['note', 'none'], /exactly one of/],
      ['a note id that is not kebab-case', ['note', 'Deploy_Notes', '--text', 'x'], /not kebab-case/],
      ['the same file name again', ['add', path.join(files, 'API Spec.yaml'), '--id', 'other'], /context\/API Spec\.yaml is listed already, as api-spec/],
      ['an explicit id that is taken', ['add', 'https://example.com/a', '--id', 'deploy'], /the id deploy is taken by a note: give another with --id/],
      ['a derived id that is taken', ['add', 'https://www.example.com/x/checkout'], /the id example-checkout, made from the name, is taken by a link/],
      ['a directory', ['add', path.join(files, 'designs')], /is a directory: a directory is attached as a reference source — wsg add <path> --reference/],
      ['a file that is not there', ['add', path.join(files, 'nope.md')], /no such file/],
      ['a scheme other than http(s)', ['add', 'ftp://example.com/x'], /only an http or https link/],
      ['a description of two lines', ['add', 'https://example.com/b', '--desc', 'a\nb'], /--desc must be one line of at most 200 characters/],
      ['a description over 200 characters', ['add', 'https://example.com/b', '--desc', 'x'.repeat(201)], /--desc must be one line/],
      ['a title of two lines', ['add', 'https://example.com/b', '--title', 'a\nb'], /--title must be one line/],
      ['an unknown item to remove', ['remove', 'nope'], /no item nope in the context \(items: api-spec, example-checkout, brief, deploy, runbook\)/],
    ];
    for (const [name, args, re] of refusals) {
      const snap = tree(ep);
      const r = ctx([...args, '--ws', 'shop', '--json']);
      it(`refused: ${name} — exit 2, invalid_input, nothing changed`, () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.strictEqual(jsonOf(r).error.code, 'invalid_input');
        assert.match(jsonOf(r).error.message, re);
        assert.strictEqual(jsonOf(r).error.rollback, 'none');
        assert.deepStrictEqual(tree(ep), snap);
      });
    }

    const list = ctx(['list', '--ws', 'shop', '--json']);
    const lj = jsonOf(list);
    it('list: every item, in order, the paths absolute', () => {
      assert.strictEqual(list.code, 0, list.all);
      assert.strictEqual(lj.command, 'context list');
      assert.strictEqual(lj.dryRun, false);
      assert.deepStrictEqual(Object.keys(lj.result), ['workspace', 'items', 'blockBytes']);
      assert.deepStrictEqual(lj.result.items.map((x) => [x.id, x.type]), [['api-spec', 'file'], ['example-checkout', 'link'], ['brief', 'file'], ['deploy', 'note'], ['runbook', 'note']]);
      assert.deepStrictEqual(lj.result.items[1], { id: 'example-checkout', type: 'link', title: 'Mockups', description: 'checkout screens', url: 'https://www.example.com/shop/checkout', path: null, bytes: null, binary: false, copied: false });
    });
    it('blockBytes: the task\'s block as it is on disk, markers included', () => {
      const t = read(path.join(cart, 'AGENTS.md'));
      const block = t.slice(t.indexOf('<!-- wsg:epic-context -->'), t.indexOf('<!-- /wsg:epic-context -->') + '<!-- /wsg:epic-context -->'.length);
      assert.strictEqual(lj.result.blockBytes, Buffer.byteLength(block));
    });
    const plainList = ctx(['list', '--ws', 'shop']);
    it('the plain list: a line per item and the size of the block', () => {
      assert.strictEqual(plainList.code, 0, plainList.all);
      assert.match(plainList.out, /^api-spec +\[file\] API Spec\.yaml — the public REST API {2}\(context\/API Spec\.yaml, 15 B\)$/m);
      assert.match(plainList.out, /^example-checkout +\[link\] Mockups — checkout screens {2}\(https:\/\/www\.example\.com\/shop\/checkout\)$/m);
      assert.match(plainList.all, /the index block every task carries: \d+ B/);
    });
    it('list takes no --dry-run', () => assert.strictEqual(ctx(['list', '--ws', 'shop', '--dry-run']).code, 2));

    // A file put into context/ by hand (wsg check names it unlisted): listed where it is, not copied.
    fs.writeFileSync(path.join(ep, 'context', 'glossary.md'), 'terms\n');
    const inPlace = ctx(['add', path.join(ep, 'context', 'glossary.md'), '--ws', 'shop', '--json']);
    it('a file already in context/ is listed as it is', () => {
      assert.strictEqual(inPlace.code, 0, inPlace.all);
      assert.deepStrictEqual(jsonOf(inPlace).result.files, [path.join(ep, 'AGENTS.md'), path.join(ep, '.claude', 'wsg.json')]);
      assert.strictEqual(read(path.join(ep, 'context', 'glossary.md')), 'terms\n');
      assert.strictEqual(jsonOf(inPlace).result.item.copied, false);
      assert.strictEqual(JSON.parse(read(stateFile(ep))).context.find((x) => x.id === 'glossary').copied, false);
    });
    fs.writeFileSync(path.join(files, 'glossary.md'), 'other\n');
    it('a file of the same name from elsewhere is refused while the listed one is there', () => {
      const r = ctx(['add', path.join(files, 'glossary.md'), '--ws', 'shop', '--id', 'gloss2']);
      assert.strictEqual(r.code, 2, r.all);
      assert.match(r.err, /context\/glossary\.md is listed already, as glossary/);
    });

    const rm = ctx(['remove', 'api-spec', '--ws', 'shop', '--json']);
    it('remove a file: out of the index and out of context/', () => {
      assert.strictEqual(rm.code, 0, rm.all);
      assert.strictEqual(jsonOf(rm).command, 'context remove');
      assert.ok(!fs.existsSync(path.join(ep, 'context', 'API Spec.yaml')));
      assert.ok(jsonOf(rm).result.files.includes(path.join(ep, 'context', 'API Spec.yaml')));
      assert.strictEqual(jsonOf(rm).result.item.id, 'api-spec');
      assert.doesNotMatch(read(path.join(cart, 'AGENTS.md')), /API Spec/);
    });
    const rmKept = ctx(['remove', 'glossary', '--ws', 'shop', '--json']);
    it('remove a file that was in context/ before it was listed: only unlisted, the file stays', () => {
      assert.strictEqual(rmKept.code, 0, rmKept.all);
      assert.strictEqual(read(path.join(ep, 'context', 'glossary.md')), 'terms\n');
      assert.ok(!jsonOf(rmKept).result.files.includes(path.join(ep, 'context', 'glossary.md')));
      assert.ok(jsonOf(rmKept).warnings.some((w) => /context\/glossary\.md was in context\/ before it was listed: it is only unlisted/.test(w)));
      assert.ok(!JSON.parse(read(stateFile(ep))).context.some((x) => x.id === 'glossary'));
    });
    const rmNote = ctx(['remove', 'runbook', '--ws', 'shop']);
    it('remove a note: its file is deleted', () => {
      assert.strictEqual(rmNote.code, 0, rmNote.all);
      assert.ok(!fs.existsSync(path.join(ep, 'context', 'notes', 'runbook.md')));
    });
    const rmLink = ctx(['remove', 'example-checkout', '--ws', 'shop']);
    it('remove a link: only the state and the blocks', () => {
      assert.strictEqual(rmLink.code, 0, rmLink.all);
      assert.match(rmLink.out, /Removed link example-checkout from the context of shop/);
      assert.doesNotMatch(read(path.join(cart, 'AGENTS.md')), /Mockups/);
    });

    it('a task is refused: epics only', () => {
      const r = ctx(['add', 'https://example.com/c', '--ws', 'shop/cart', '--json']);
      assert.strictEqual(r.code, 2, r.all);
      assert.strictEqual(jsonOf(r).error.code, 'invalid_input');
      assert.match(jsonOf(r).error.message, /cart is a task workspace: wsg context works on an epic in this version/);
    });
    it('so is a process, and context list too', () => {
      wsg(['new', 'release', '--kind', 'process', '--no-launch'], { env });
      const r = ctx(['list', '--ws', 'release']);
      assert.strictEqual(r.code, 2, r.all);
      assert.match(r.err, /release is a process workspace/);
    });
    it('the epic found from inside it', () => {
      const r = ctx(['list', '--json'], { cwd: ep });
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(jsonOf(r).result.workspace, ep);
    });
    it('no word, or one it does not have: exit 2, an envelope with command null', () => {
      for (const args of [[], ['bogus']]) {
        const r = ctx([...args, '--json']);
        assert.strictEqual(r.code, 2, r.all);
        assert.strictEqual(jsonOf(r).command, null);
        assert.strictEqual(jsonOf(r).error.code, 'invalid_input');
      }
      assert.match(ctx(['bogus']).err, /unknown command: context bogus/);
    });
    it('an unknown flag is refused in the envelope, named by both words', () => {
      const r = ctx(['add', 'x', '--bogus', '--json']);
      assert.strictEqual(r.code, 2);
      assert.strictEqual(jsonOf(r).command, 'context add');
      assert.match(jsonOf(r).error.message, /unknown argument: --bogus/);
    });
    void root;
  }

  console.log('\nwsg context: limits');
  {
    const { env, ep } = epicRoot('limits-root');
    const files = path.join(tmp, 'limit-files');
    fs.mkdirSync(files);
    const huge = path.join(files, 'huge.bin');
    fs.writeFileSync(huge, '');
    fs.truncateSync(huge, 20 * 1024 * 1024 + 1);
    const big = path.join(files, 'big.txt');
    fs.writeFileSync(big, 'x'.repeat(1024 * 1024 + 10));
    const ctx = (args) => wsg(['context', ...args, '--ws', 'shop', '--json'], { env });
    const r1 = ctx(['add', huge]);
    it('a file above 20 MiB is refused', () => {
      assert.strictEqual(r1.code, 2, r1.all);
      assert.match(jsonOf(r1).error.message, /huge\.bin is 20971521 B, the ceiling is 20971520 B/);
      assert.ok(!fs.existsSync(path.join(ep, 'context')));
    });
    const r2 = ctx(['add', big]);
    it('a file above 1 MiB is a warning, and added', () => {
      assert.strictEqual(r2.code, 0, r2.all);
      assert.ok(jsonOf(r2).warnings.some((w) => /big\.txt is 1048586 B, above 1048576 B/.test(w)));
    });
    it('a note above 20 MiB is refused too', () => {
      const r = wsg(['context', 'note', 'huge', '--from', huge, '--ws', 'shop', '--json'], { env });
      assert.strictEqual(r.code, 2, r.all);
      assert.match(jsonOf(r).error.message, /huge\.bin is 20971521 B, the ceiling is 20971520 B/);
    });
    // Long descriptions: the index grows past 2 KiB (a warning), then past 4 KiB (refused).
    let warned = null;
    let refused = null;
    for (let i = 0; i < 40 && !refused; i++) {
      const r = ctx(['add', `https://example.com/page-${i}`, '--desc', `${i} ${'d'.repeat(190)}`]);
      if (r.code !== 0) refused = r;
      else if (!warned && jsonOf(r).warnings.some((w) => /the index block is \d+ B, above 2048/.test(w))) warned = r;
    }
    it('an index block above 2 KiB is a warning', () => assert.ok(warned, 'no warning seen'));
    it('one that would pass 4 KiB is refused, nothing changed', () => {
      assert.ok(refused, 'never refused');
      assert.strictEqual(refused.code, 2, refused.all);
      assert.match(jsonOf(refused).error.message, /the index block would be \d+ B, the ceiling is 4096/);
      const items = JSON.parse(read(stateFile(ep))).context;
      const bytes = jsonOf(wsg(['context', 'list', '--ws', 'shop', '--json'], { env })).result.blockBytes;
      assert.ok(bytes <= 4096 && items.length > 10, `${bytes} B, ${items.length} items`);
    });
  }

  console.log('\nwsg context: <epic>/context taken by something else');
  {
    const { env, ep } = epicRoot('taken-root');
    const add = () => wsg(['context', 'add', 'https://example.com/x', '--ws', 'shop', '--json'], { env });
    fs.symlinkSync(tmp, path.join(ep, 'context'));
    const r1 = add();
    it('a symlink named context: refused, named', () => {
      assert.strictEqual(r1.code, 2, r1.all);
      assert.match(jsonOf(r1).error.message, /context is a symlink/);
    });
    fs.unlinkSync(path.join(ep, 'context'));
    fs.mkdirSync(path.join(ep, 'context', '.claude'), { recursive: true });
    fs.writeFileSync(path.join(ep, 'context', '.claude', 'wsg.json'), JSON.stringify({ version: 2, kind: 'task', slug: 'context', epic: { slug: 'shop' }, sources: [] }));
    const r2 = add();
    it('a task named context (made before 0.7): refused, named', () => {
      assert.strictEqual(r2.code, 2, r2.all);
      assert.match(jsonOf(r2).error.message, /context is a task workspace: the epic keeps its context in context\//);
    });
    fs.rmSync(path.join(ep, 'context'), { recursive: true });
    setState(ep, (s) => ({ ...s, sources: [{ name: 'context', path: tmp, mode: 'link', reference: true, note: '' }] }));
    const r3 = add();
    it('a source named context: refused, named', () => {
      assert.strictEqual(r3.code, 2, r3.all);
      assert.match(jsonOf(r3).error.message, /context in .* is the source context/);
    });
    it('a note is refused the same way', () => {
      const r = wsg(['context', 'note', 'n', '--text', 'x', '--ws', 'shop'], { env });
      assert.strictEqual(r.code, 2, r.all);
      assert.match(r.err, /is the source context/);
    });
  }

  console.log('\nwsg context: a busy task, a failed write');
  {
    const { env, ep } = epicRoot('busy-root');
    for (const slug of ['free', 'held']) wsg(['new', slug, '--epic', 'shop', '--no-launch'], { env });
    const lockFile = path.join(ep, 'held', '.claude', 'wsg.lock');
    // Another wsg command holds the task: a lock naming a live process, this test's own.
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
    const heldBefore = read(path.join(ep, 'held', 'AGENTS.md'));
    const r = wsg(['context', 'add', 'https://example.com/spec', '--ws', 'shop', '--json'], { env });
    const j = jsonOf(r);
    it('a busy task: the command still succeeds, exit 0', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(j.ok, true);
    });
    it('the epic\'s change is kept', () => {
      assert.deepStrictEqual(JSON.parse(read(stateFile(ep))).context.map((x) => x.id), ['example-spec']);
      assert.match(read(path.join(ep, 'AGENTS.md')), /\[link\] example\.com\/spec/);
    });
    it('the free task refreshed, the busy one reported and left as it was', () => {
      const by = Object.fromEntries(j.result.tasks.map((x) => [x.task, x]));
      assert.strictEqual(by.free.refreshed, true);
      assert.strictEqual(by.held.refreshed, false);
      assert.match(by.held.reason, /another wsg command is running in this workspace/);
      assert.strictEqual(read(path.join(ep, 'held', 'AGENTS.md')), heldBefore);
    });
    it('and a warning names it', () => assert.ok(j.warnings.some((w) => /task held was not refreshed: [\s\S]* run wsg refresh in it later/.test(w)), j.warnings.join('\n')));
    fs.rmSync(lockFile);
    const later = wsg(['refresh', '--ws', path.join(ep, 'held')], { env });
    it('its next refresh catches up', () => {
      assert.strictEqual(later.code, 0, later.all);
      assert.match(read(path.join(ep, 'held', 'AGENTS.md')), /\[link\] example\.com\/spec/);
    });

    if (asRoot) console.log('  skip  the read-only rollback tests: running as root');
    else {
      // A failure after the copy (the epic's AGENTS.md can't be written): everything put back.
      const src = path.join(tmp, 'rollback-spec.md');
      fs.writeFileSync(src, 'spec\n');
      const snap = tree(ep);
      fs.chmodSync(path.join(ep, 'AGENTS.md'), 0o444);
      const f1 = wsg(['context', 'add', src, '--ws', 'shop', '--json'], { env });
      fs.chmodSync(path.join(ep, 'AGENTS.md'), 0o644);
      it('a write that fails after the copy: exit 1, step_failed, rolled back', () => {
        assert.strictEqual(f1.code, 1, f1.all);
        assert.strictEqual(jsonOf(f1).error.code, 'step_failed');
        assert.strictEqual(jsonOf(f1).error.rollback, 'done');
      });
      it('the copied file, the directory made for it and the state are as before', () => {
        assert.ok(!fs.existsSync(path.join(ep, 'context')));
        assert.deepStrictEqual(tree(ep), snap);
      });
      it('the tasks were not touched', () => assert.doesNotMatch(read(path.join(ep, 'free', 'AGENTS.md')), /rollback-spec/));
      // The copy itself fails: context/ can't be written.
      fs.mkdirSync(path.join(ep, 'context'));
      fs.chmodSync(path.join(ep, 'context'), 0o555);
      const snap2 = tree(ep);
      const f2 = wsg(['context', 'add', src, '--ws', 'shop', '--json'], { env });
      fs.chmodSync(path.join(ep, 'context'), 0o755);
      it('a copy that fails: exit 1, step_failed, nothing left', () => {
        assert.strictEqual(f2.code, 1, f2.all);
        assert.strictEqual(jsonOf(f2).error.code, 'step_failed');
        assert.notStrictEqual(jsonOf(f2).error.rollback, 'incomplete');
        assert.deepStrictEqual(tree(ep), snap2);
      });
    }
  }

  console.log('\nwsg context: links, hand edits, names, large notes');
  {
    const { env, ep } = epicRoot('edge-root');
    wsg(['new', 'cart', '--epic', 'shop', '--no-launch'], { env });
    const cart = path.join(ep, 'cart');
    const files = path.join(tmp, 'edge-files');
    fs.mkdirSync(files);
    const ctx = (args, opts = {}) => wsg(['context', ...args, '--ws', 'shop', '--json'], { env, ...opts });
    fs.writeFileSync(path.join(files, 'spec.md'), 'spec\n');
    ctx(['add', path.join(files, 'spec.md')]);
    ctx(['note', 'deploy', '--text', 'deploy notes']);

    // Nothing is deleted through a link: context/ moved elsewhere and linked back.
    const outside = path.join(tmp, 'edge-outside');
    fs.renameSync(path.join(ep, 'context'), outside);
    fs.symlinkSync(outside, path.join(ep, 'context'));
    const r1 = ctx(['remove', 'spec']);
    it('remove with context/ a symlink: refused, the file behind it kept', () => {
      assert.strictEqual(r1.code, 2, r1.all);
      assert.match(jsonOf(r1).error.message, /context is a symlink/);
      assert.strictEqual(read(path.join(outside, 'spec.md')), 'spec\n');
    });
    fs.unlinkSync(path.join(ep, 'context'));
    fs.renameSync(outside, path.join(ep, 'context'));
    const notesOut = path.join(tmp, 'edge-notes');
    fs.renameSync(path.join(ep, 'context', 'notes'), notesOut);
    fs.symlinkSync(notesOut, path.join(ep, 'context', 'notes'));
    const r2 = ctx(['remove', 'deploy']);
    it('remove of a note with context/notes/ a symlink: refused, the note behind it kept', () => {
      assert.strictEqual(r2.code, 2, r2.all);
      assert.match(jsonOf(r2).error.message, /symlink/);
      assert.strictEqual(read(path.join(notesOut, 'deploy.md')), 'deploy notes\n');
    });
    fs.unlinkSync(path.join(ep, 'context', 'notes'));
    fs.renameSync(notesOut, path.join(ep, 'context', 'notes'));

    // A symlink inside context/ is not listed in place; a symlink elsewhere is copied from.
    fs.writeFileSync(path.join(files, 'target.md'), 'target\n');
    fs.symlinkSync(path.join(files, 'target.md'), path.join(ep, 'context', 'linked.md'));
    const r3 = ctx(['add', path.join(ep, 'context', 'linked.md')]);
    it('a symlink in context/ listed in place: refused', () => {
      assert.strictEqual(r3.code, 2, r3.all);
      assert.match(jsonOf(r3).error.message, /is a symlink in context\/: listed as it is, the index would point outside the epic/);
    });
    fs.unlinkSync(path.join(ep, 'context', 'linked.md'));
    fs.symlinkSync(path.join(files, 'target.md'), path.join(files, 'via-link.md'));
    const r4 = ctx(['add', path.join(files, 'via-link.md')]);
    it('a symlink elsewhere: its target is copied', () => {
      assert.strictEqual(r4.code, 0, r4.all);
      const st = fs.lstatSync(path.join(ep, 'context', 'via-link.md'));
      assert.ok(st.isFile() && !st.isSymbolicLink());
      assert.strictEqual(read(path.join(ep, 'context', 'via-link.md')), 'target\n');
    });

    // Hand edits: remove and note --replace refuse them without --discard-edits.
    fs.writeFileSync(path.join(ep, 'context', 'spec.md'), 'spec, edited by hand\n');
    const r5 = ctx(['remove', 'spec']);
    it('remove of a file edited since wsg copied it: refused, the edit kept', () => {
      assert.strictEqual(r5.code, 2, r5.all);
      assert.match(jsonOf(r5).error.message, /context\/spec\.md changed since wsg wrote it: --discard-edits/);
      assert.strictEqual(read(path.join(ep, 'context', 'spec.md')), 'spec, edited by hand\n');
    });
    const r6 = ctx(['remove', 'spec', '--discard-edits']);
    it('with --discard-edits: removed', () => {
      assert.strictEqual(r6.code, 0, r6.all);
      assert.ok(!fs.existsSync(path.join(ep, 'context', 'spec.md')));
    });
    fs.appendFileSync(path.join(ep, 'context', 'notes', 'deploy.md'), 'a line by hand\n');
    const r7 = ctx(['note', 'deploy', '--text', 'new', '--replace']);
    it('note --replace of a note edited by hand: refused, the edit kept', () => {
      assert.strictEqual(r7.code, 2, r7.all);
      assert.match(jsonOf(r7).error.message, /changed since wsg wrote it/);
      assert.match(read(path.join(ep, 'context', 'notes', 'deploy.md')), /a line by hand/);
    });
    const r8 = ctx(['note', 'deploy', '--text', 'new', '--replace', '--discard-edits']);
    it('with --discard-edits: rewritten, its new sha256 kept', () => {
      assert.strictEqual(r8.code, 0, r8.all);
      assert.strictEqual(read(path.join(ep, 'context', 'notes', 'deploy.md')), 'new\n');
      const item = JSON.parse(read(stateFile(ep))).context.find((x) => x.id === 'deploy');
      assert.strictEqual(item.sha256, require('node:crypto').createHash('sha256').update('new\n').digest('hex'));
    });

    // A secret in a link's URL: added, with a warning.
    for (const url of ['https://example.com/doc?access_token=abc', 'https://user:pw@example.com/doc', 'https://example.com/x?X-Amz-Signature=1']) {
      const r = ctx(['add', url, '--id', `secret-${url.length}`]);
      it(`a link that may carry a secret is added with a warning: ${url}`, () => {
        assert.strictEqual(r.code, 0, r.all);
        assert.ok(jsonOf(r).warnings.some((w) => /may carry a secret/.test(w)), jsonOf(r).warnings.join('\n'));
      });
    }
    it('a plain link: no such warning', () => {
      const r = ctx(['add', 'https://example.com/docs?page=2']);
      assert.ok(!jsonOf(r).warnings.some((w) => /secret/.test(w)));
    });
    const r14 = ctx(['add', 'https://example.com/cb#access_token=abc', '--id', 'in-fragment']);
    it('a secret in the fragment warns too', () => assert.ok(jsonOf(r14).warnings.some((w) => /may carry a secret/.test(w))));
    const r15 = ctx(['add', 'https://example.com/post?author=ann&keyword=shop&design=2&monkey=1', '--id', 'no-secret']);
    it('author, keyword, design, monkey: no warning — only whole names or their _ - parts count', () => {
      assert.strictEqual(r15.code, 0, r15.all);
      assert.ok(!jsonOf(r15).warnings.some((w) => /secret/.test(w)), jsonOf(r15).warnings.join('\n'));
    });

    // Names.
    for (const name of ['CLAUDE.md', 'agents.override.md', 'Claude.local.md']) {
      fs.writeFileSync(path.join(files, name), 'x\n');
      const r = ctx(['add', path.join(files, name)]);
      it(`a file named ${name} is refused: agents may take it for instructions`, () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.match(jsonOf(r).error.message, /CLAUDE\.md, AGENTS\.md, their \.local and \.override forms/);
      });
    }
    fs.writeFileSync(path.join(files, 'claude-api-notes.md'), 'notes on the API\n');
    const r16 = ctx(['add', path.join(files, 'claude-api-notes.md')]);
    it('claude-api-notes.md is added: only the instructions files themselves are refused', () => assert.strictEqual(r16.code, 0, r16.all));
    fs.writeFileSync(path.join(files, 'заметки.md'), 'x\n');
    const r9 = ctx(['add', path.join(files, 'заметки.md')]);
    it('a name with no ASCII letter gets an id file-<hash>, not a bare file', () => {
      assert.strictEqual(r9.code, 0, r9.all);
      assert.match(jsonOf(r9).result.item.id, /^file-[0-9a-f]{8}$/);
    });

    // A note larger than the ceiling is refused before it is read: a sparse file, and stdin.
    const sparse = path.join(files, 'sparse.md');
    fs.writeFileSync(sparse, '');
    fs.truncateSync(sparse, 20 * 1024 * 1024 + 1);
    const r10 = ctx(['note', 'big', '--from', sparse]);
    it('note --from a file above 20 MiB: refused by its size', () => {
      assert.strictEqual(r10.code, 2, r10.all);
      assert.match(jsonOf(r10).error.message, /sparse\.md is 20971521 B, the ceiling is 20971520 B/);
    });
    const r11 = ctx(['note', 'big', '--from', '-'], { input: 'x'.repeat(20 * 1024 * 1024 + 2) });
    it('note --from - with more than 20 MiB on stdin: refused', () => {
      assert.strictEqual(r11.code, 2, r11.all);
      assert.match(jsonOf(r11).error.message, /stdin is more than 20\.0 MiB/);
    });

    // Anything but a regular file is read only up to the ceiling: /dev/zero never ends.
    const r17 = ctx(['note', 'zero', '--from', '/dev/zero']);
    it('note --from /dev/zero: refused once past 20 MiB, not read forever', () => {
      assert.strictEqual(r17.code, 2, r17.all);
      assert.match(jsonOf(r17).error.message, /\/dev\/zero is more than 20\.0 MiB/);
    });
    const fifo = path.join(files, 'note.fifo');
    let fifoMade = true;
    try { execFileSync('mkfifo', [fifo]); } catch { fifoMade = false; }
    if (fifoMade) {
      const writer = spawn('sh', ['-c', `printf 'from a fifo\\n' > "${fifo}"`]);
      const r18 = ctx(['note', 'fifo', '--from', fifo]);
      writer.kill();
      it('note --from a FIFO: read through the capped loop', () => {
        assert.strictEqual(r18.code, 0, r18.all);
        assert.strictEqual(read(path.join(ep, 'context', 'notes', 'fifo.md')), 'from a fifo\n');
      });
    } else console.log('  skip  no mkfifo here');
    if (!asRoot) {
      const nf = path.join(ep, 'context', 'notes', 'deploy.md');
      fs.chmodSync(nf, 0o000);
      const r19 = ctx(['remove', 'deploy']);
      const r20 = ctx(['note', 'deploy', '--text', 'x', '--replace']);
      fs.chmodSync(nf, 0o644);
      it('a note that can\'t be read: remove and --replace refuse, it may hold edits', () => {
        for (const r of [r19, r20]) {
          assert.strictEqual(r.code, 2, r.all);
          assert.match(jsonOf(r).error.message, /can't be read to tell whether it was edited/);
        }
        assert.strictEqual(read(nf), 'new\n');
      });
    }

    // A task's own render warnings reach the envelope: a task made before 0.7 gets the block.
    const ta = path.join(cart, 'AGENTS.md');
    fs.writeFileSync(ta, read(ta).replace(/<!-- wsg:epic-context -->\n[\s\S]*?<!-- \/wsg:epic-context -->\n/, ''));
    const r12 = ctx(['add', 'https://example.com/more']);
    it('a refreshed task\'s warnings are in the envelope, its name in front', () => {
      assert.strictEqual(r12.code, 0, r12.all);
      assert.ok(jsonOf(r12).warnings.some((w) => /^cart: AGENTS\.md: added the <!-- wsg:epic-context --> block \(new in wsg 0\.7\.0\)/.test(w)), jsonOf(r12).warnings.join('\n'));
    });
    fs.mkdirSync(path.join(ep, 'broken', '.claude'), { recursive: true });
    fs.writeFileSync(path.join(ep, 'broken', '.claude', 'wsg.json'), '{ nope');
    const r13 = ctx(['add', 'https://example.com/even-more']);
    it('a task whose state does not read is in tasks, code failed', () => {
      assert.strictEqual(r13.code, 0, r13.all);
      const b = jsonOf(r13).result.tasks.find((x) => x.task === 'broken');
      assert.deepStrictEqual([b.refreshed, b.code], [false, 'failed']);
    });
    fs.rmSync(path.join(ep, 'broken'), { recursive: true });

    // Rollback of remove and of note --replace: the epic's AGENTS.md can't be written.
    if (asRoot) console.log('  skip  the read-only rollback tests: running as root');
    else {
      const snap = tree(ep);
      fs.chmodSync(path.join(ep, 'AGENTS.md'), 0o444);
      const f1 = ctx(['remove', 'via-link']);
      const f2 = ctx(['note', 'deploy', '--text', 'again', '--replace']);
      fs.chmodSync(path.join(ep, 'AGENTS.md'), 0o644);
      it('a remove that fails: step_failed, rolled back, the file back', () => {
        assert.strictEqual(f1.code, 1, f1.all);
        assert.strictEqual(jsonOf(f1).error.rollback, 'done');
        assert.strictEqual(read(path.join(ep, 'context', 'via-link.md')), 'target\n');
      });
      it('a note --replace that fails: step_failed, rolled back, the old body back', () => {
        assert.strictEqual(f2.code, 1, f2.all);
        assert.strictEqual(jsonOf(f2).error.rollback, 'done');
        assert.strictEqual(read(path.join(ep, 'context', 'notes', 'deploy.md')), 'new\n');
      });
      it('the epic is as it was', () => assert.deepStrictEqual(tree(ep), snap));
    }
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed === 0 ? '\nall checks passed\n' : `\nfailed: ${failed}\n`);
  finished = true;
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.log(`\nFAIL  ${e.stack || e}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  finished = true;
  process.exit(1);
});
