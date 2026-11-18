'use strict';

// wsg archive and wsg unarchive, and what an archived workspace is to the other commands: the state
// model, list, status, check, refresh. Every command runs in a child process with its own HOME,
// WS_ROOT and config; the repositories are real temporary git repositories. Nothing here needs the
// network or a real agent.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

process.env.WSG_LANG = 'en';

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const W = require(path.join(ROOT, 'lib', 'workspace.js'));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-archive-')));
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

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...ENV } }).trim();
let repoN = 0;
function makeRepo(name = `repo${++repoN}`) {
  const dir = path.join(tmp, 'repos', name);
  fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\nbuild/\n');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'pkg', 'index.ts'), 'export {};\n');
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=x\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
  return dir;
}

// Every path under a directory with its type and bytes, worktrees included: "nothing touched".
function tree(dir, { into = true } = {}) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d).sort()) {
      const p = path.join(d, e);
      const rel = path.relative(dir, p);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) {
        out[rel] = 'dir';
        if (into || !fs.existsSync(path.join(p, '.git'))) walk(p);
      } else out[rel] = fs.readFileSync(p, 'base64');
    }
  };
  walk(dir);
  return out;
}
// The refs of a repository with their tips: "branches kept" means this is unchanged.
const refs = (dir) => git(dir, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
const worktreeCount = (dir) => git(dir, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length;
const readState = (ws) => JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'wsg.json'), 'utf8'));
const writeState = (ws, st) => fs.writeFileSync(path.join(ws, '.claude', 'wsg.json'), `${JSON.stringify(st, null, 2)}\n`);
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

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

// A task made with wsg new, its sources attached with wsg add.
function task(slug, sources = [], extra = []) {
  const r = wsg(['new', slug, '--no-launch', ...extra]);
  assert.strictEqual(r.code, 0, r.all);
  const ws = extra.includes('--epic') ? path.join(wsRoot, extra[extra.indexOf('--epic') + 1], slug) : path.join(wsRoot, slug);
  for (const [repo, flags] of sources) {
    const a = wsg(['add', repo, '--ws', ws, ...flags]);
    assert.strictEqual(a.code, 0, a.all);
  }
  return ws;
}

(async () => {
  console.log('state model');
  {
    const base = { version: 4, kind: 'task', slug: 'x', title: 'x', status: 'archived', personalRules: false, created: '2026-11-01', sources: [] };
    const src = { path: '/tmp/r', name: 'r', mode: 'worktree', reference: false, branch: 'b', base: 'main', target: 'main', verify: '', note: '', carry: [], cloneNm: false };
    const rec = { date: '2026-11-02', previous: { status: 'review', closed: null }, sources: [src] };
    const good = { ...base, archive: rec };
    it('an archived task reads', () => assert.strictEqual(W.stateProblem(good), ''));
    it('byEpic: true reads', () => assert.strictEqual(W.stateProblem({ ...good, archive: { ...rec, byEpic: true } }), ''));
    for (const [name, st, re] of [
      ['a record without previous', { ...good, archive: { date: rec.date, sources: [] } }, /"archive" of a task has exactly/],
      ['an unknown key', { ...good, archive: { ...rec, extra: 1 } }, /exactly/],
      ['a bad date', { ...good, archive: { ...rec, date: '2026-02-30' } }, /archive\.date/],
      ['a source without a path', { ...good, archive: { ...rec, sources: [{ name: 'r' }] } }, /archive\.sources/],
      ['previous archived', { ...good, archive: { ...rec, previous: { status: 'archived', closed: null } } }, /archive\.previous/],
      ['previous closed not a date', { ...good, archive: { ...rec, previous: { status: 'done', closed: 'yesterday' } } }, /archive\.previous/],
      ['byEpic false', { ...good, archive: { ...rec, byEpic: false } }, /byEpic/],
      ['an archived state of version 2, which wsg 0.7 would read', { ...good, version: 2 }, /expected version 4/],
      ['an epic record with previous', { version: 4, kind: 'epic', slug: 'e', title: 'e', created: '2026-11-01', sources: [], archive: rec }, /"archive" of an epic has exactly date, sources, cascade/],
      ['a cascade with a slug twice', { version: 4, kind: 'epic', slug: 'e', title: 'e', created: '2026-11-01', sources: [], archive: { date: rec.date, sources: [], cascade: ['a', 'a'] } }, /archive\.cascade/],
    ]) it(`refused: ${name}`, () => assert.match(W.stateProblem(st), re));
    it('an archived epic reads', () => assert.strictEqual(W.stateProblem({ version: 4, kind: 'epic', slug: 'e', title: 'e', created: '2026-11-01', sources: [], archive: { date: rec.date, sources: [src], cascade: ['t1'] } }), ''));
    // wsg 0.7 reads a state only at version 2 (a task, a process) or 3 (an epic): it refuses an archived
    // one instead of changing it.
    const reads07 = (st) => st.version === (st.kind === 'epic' ? 3 : 2);
    it('an archived state is version 4: wsg 0.7 refuses it, a task and an epic alike', () => {
      assert.strictEqual(W.stateVersion('task', true), 4);
      assert.strictEqual(W.stateVersion('epic', true), 4);
      assert.ok(!reads07(good));
      assert.ok(!reads07({ kind: 'epic', version: W.stateVersion('epic', true) }));
      assert.ok(reads07({ kind: 'task', version: W.stateVersion('task') }));
    });
    it('a state of version 4 without a record is refused', () => assert.match(W.stateProblem({ ...base, status: 'open' }), /expected version 2/));
    it('sources left in an archived state: it reads, with a warning', () => {
      assert.strictEqual(W.stateProblem({ ...good, sources: [src] }), '');
      assert.match(W.archiveWarnings({ ...good, sources: [src] }).join('\n'), /"sources" is not empty/);
    });
    it('a record with status open: it reads, with a warning', () => {
      assert.strictEqual(W.stateProblem({ ...good, status: 'open' }), '');
      assert.match(W.archiveWarnings({ ...good, status: 'open' }).join('\n'), /goes only with "status": "archived"/);
    });
    it('a clean archived state has no warnings', () => assert.deepStrictEqual(W.archiveWarnings(good), []));
    it('archived is a known status', () => assert.strictEqual(W.statusProblem(good), null));
    it('archived without a record is a half archive', () => assert.match(W.statusProblem({ ...base }), /half archive/));
    it('closed with archived is a warning', () => assert.match(W.statusProblem({ ...good, closed: '2026-11-01' }), /"closed" goes only with/));
    it('wsg status does not set archived', () => assert.ok(!W.STATUSES.includes('archived') && W.KNOWN_STATUSES.includes('archived')));
    it('statusMarker: [archived date], [archived] without a valid one', () => {
      assert.strictEqual(W.statusMarker('archived', '2026-11-02'), '[archived 2026-11-02]');
      assert.strictEqual(W.statusMarker('archived', 'x'), '[archived]');
    });
    it('markerOf: an archived epic reads [archived date], a done task [done date]', () => {
      assert.strictEqual(W.markerOf({ kind: 'epic', archive: { date: '2026-11-03' } }), '[archived 2026-11-03]');
      assert.strictEqual(W.markerOf({ kind: 'task', status: 'done', closed: '2026-11-04' }), '[done 2026-11-04]');
      assert.strictEqual(W.markerOf({ kind: 'task', status: 'open' }), '');
    });
    it('isFrozen: done and archived, not open or review', () => {
      assert.deepStrictEqual(['open', 'review', 'done', 'archived'].map((s) => W.isFrozen({ kind: 'task', status: s })), [false, false, true, true]);
      assert.strictEqual(W.isFrozen({ kind: 'epic' }), false);
      assert.strictEqual(W.isFrozen({ kind: 'epic', archive: {} }), true);
    });
    it('checklist.md is reserved', () => assert.ok(W.RESERVED.includes('checklist.md')));
  }

  console.log('\nan archived task to list, status, check and refresh (state written by hand)');
  {
    const repo = makeRepo();
    const ep = task('shop', [], ['--kind', 'epic', '--title', 'Shop']);
    const ws = task('cart', [], ['--epic', 'shop']);
    const other = task('promo', [], ['--epic', 'shop']);
    const st = readState(ws);
    const src = { path: repo, name: 'api', mode: 'worktree', reference: false, branch: 'feat/cart', base: 'main', target: 'main', verify: '', note: '', carry: [], cloneNm: false };
    const archived = { ...st, version: 4, status: 'archived', archive: { date: '2026-11-02', previous: { status: 'review', closed: null }, sources: [src] } };
    writeState(ws, archived);
    const l = json(['list']);
    const entry = l.doc && l.doc.result.workspaces.find((w) => w.slug === 'shop').tasks.find((x) => x.slug === 'cart');
    it('list --json: status archived, the date, the sources it had, none attached', () => {
      assert.strictEqual(l.code, 0, l.all);
      assert.strictEqual(entry.status, 'archived');
      assert.strictEqual(entry.archived, '2026-11-02');
      assert.strictEqual(entry.closed, null);
      assert.deepStrictEqual(entry.sources, []);
      assert.strictEqual(entry.archivedSources.length, 1);
      assert.strictEqual(entry.archivedSources[0].name, 'api');
      assert.strictEqual(entry.archivedSources[0].branch, 'feat/cart');
      assert.deepStrictEqual(entry.problems, []);
    });
    it('list --json: archived null and archivedSources [] for the rest', () => {
      const p = l.doc.result.workspaces.find((w) => w.slug === 'shop').tasks.find((x) => x.slug === 'promo');
      assert.strictEqual(p.archived, null);
      assert.deepStrictEqual(p.archivedSources, []);
    });
    it('the plain list marks it [archived date]', () => assert.match(wsg(['list']).out, /^ {2}cart \[archived 2026-11-02\]/m));
    const s = json(['status', 'shop/cart']);
    it('status reads archived with the date', () => {
      assert.strictEqual(s.code, 0, s.all);
      assert.strictEqual(s.doc.result.status, 'archived');
      assert.strictEqual(s.doc.result.archived, '2026-11-02');
      assert.strictEqual(s.doc.result.changed, false);
    });
    it('status of an open task has archived null', () => assert.strictEqual(json(['status', 'shop/promo']).doc.result.archived, null));
    const before = tree(ws);
    const tasksBefore = read(ep, 'tasks.md');
    for (const args of [['status', 'shop/cart', 'open'], ['status', 'shop/cart', 'done'], ['close', 'shop/cart'], ['status', 'shop/cart', 'open', '--dry-run']]) {
      const r = wsg(args);
      it(`wsg ${args.join(' ')}: refused, exit 2, nothing changed`, () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.match(r.all, /archived since 2026-11-02.*wsg unarchive/s);
        assert.deepStrictEqual(tree(ws), before);
        assert.strictEqual(read(ep, 'tasks.md'), tasksBefore);
      });
    }
    const sj = json(['status', 'shop/cart', 'review']);
    it('status --json: refused as invalid_input with the result', () => {
      assert.strictEqual(sj.code, 2);
      assert.strictEqual(sj.doc.error.code, 'invalid_input');
      assert.strictEqual(sj.doc.result.archived, '2026-11-02');
    });
    const sa = wsg(['status', 'shop/promo', 'archived']);
    it('wsg status <task> archived: refused, names wsg archive', () => {
      assert.strictEqual(sa.code, 2, sa.all);
      assert.match(sa.err, /wsg archive <task> sets it/);
    });
    const r = json(['refresh', '--tasks', '--ws', ep]);
    it('refresh --tasks: the archived task is left as it is, code archived', () => {
      assert.strictEqual(r.code, 0, r.all);
      const c = r.doc.result.tasks.find((x) => x.task === 'cart');
      assert.strictEqual(c.refreshed, false);
      assert.strictEqual(c.code, 'archived');
      assert.strictEqual(r.doc.result.tasks.find((x) => x.task === 'promo').refreshed, true);
    });
    it('the epic\'s tasks.md marks it [archived date]', () => assert.match(read(ep, 'tasks.md'), /^- `cart\/` .*\[archived 2026-11-02\]$/m));
    const plain = wsg(['refresh', '--tasks', '--ws', ep]);
    it('the plain refresh --tasks names it as left', () => assert.match(plain.all, /Archived tasks left as they are: cart/));
    const c = json(['check', ws]);
    const items = c.doc ? c.doc.result.sections.flatMap((x) => x.items) : [];
    it('check of an archived task: no repository or verification warnings, the info line, no fail', () => {
      assert.ok(c.doc, c.all);
      assert.ok(!items.some((x) => /no git repository attached|verification section has no command/.test(x.text)), JSON.stringify(items));
      assert.ok(items.some((x) => x.level === 'info' && /^archived 2026-11-02; branches kept: api \(feat\/cart\)$/.test(x.text)), JSON.stringify(items));
      assert.ok(!items.some((x) => x.level === 'fail'), JSON.stringify(items.filter((x) => x.level === 'fail')));
    });
    const ce = json(['check', ep]);
    it('check of the epic does not call the archived task stale', () => {
      const all = ce.doc.result.sections.flatMap((x) => x.items).map((x) => x.text).join('\n');
      assert.doesNotMatch(all, /tasks without the epic's .*cart/);
    });
    // A half archive: the record lists a source that is still in the workspace.
    fs.mkdirSync(path.join(ws, 'api'));
    const half = json(['check', ws]);
    it('check fails on a half archive: a recorded source still in the workspace', () => {
      assert.strictEqual(half.code, 1, half.all);
      assert.ok(half.doc.error.details.some((x) => /api is still in the workspace — a half archive/.test(x)), JSON.stringify(half.doc.error.details));
    });
    fs.rmdirSync(path.join(ws, 'api'));
    // Sources left in the state while archived (a run that stopped half-way): a warning, not a fail.
    writeState(ws, { ...archived, sources: [src] });
    fs.mkdirSync(path.join(ws, 'api'));
    const leftover = json(['check', ws]);
    it('check of an archived state with a source still attached: a warning, no fail for it', () => {
      const items = leftover.doc.result.sections.flatMap((x) => x.items);
      assert.ok(items.some((x) => x.level === 'warn' && /"sources" is not empty/.test(x.text)), JSON.stringify(items));
      assert.ok(!items.some((x) => x.level === 'fail' && /api/.test(x.text)), JSON.stringify(items.filter((x) => x.level === 'fail')));
    });
    fs.rmdirSync(path.join(ws, 'api'));
    writeState(ws, archived);
    const { archive: _a, ...noRecord } = { ...archived, version: 2 };
    writeState(ws, noRecord);
    const half2 = json(['check', ws]);
    it('check fails on a status archived without its record', () => {
      assert.strictEqual(half2.code, 1, half2.all);
      assert.ok(half2.doc.error.details.some((x) => /half archive/.test(x)));
    });
    it('a half archive takes a status again (the repair)', () => {
      const r2 = wsg(['status', 'shop/cart', 'open']);
      assert.strictEqual(r2.code, 0, r2.all);
      assert.strictEqual(readState(ws).status, 'open');
    });
    void other;
  }

  // STEP2

  // STEP3

  finished = true;
  console.log(failed ? `\n${failed} failed, ${passed} passed` : `\nall ${passed} checks passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  console.log(`\nFAIL  ${e.stack || e}`);
  process.exitCode = 1;
});
