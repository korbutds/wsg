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
