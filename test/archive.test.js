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
let skipped = 0;
// A block that can't run here (as root, a checkout without the tags, a file system without copy-on-write): said, and counted in the last line.
const skip = (why) => { skipped++; console.log(`  skip  ${why}`); };
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

  const A = require(path.join(ROOT, 'lib', 'archive.js'));
  const generate = require(path.join(ROOT, 'lib', 'generate.js'));
  const quiet = async (fn) => {
    const log = console.log;
    const err = process.stderr.write;
    console.log = () => {};
    process.stderr.write = () => true;
    try { return await fn(); } finally { console.log = log; process.stderr.write = err; }
  };
  // What archive must leave byte for byte: the workspace's own files, worktrees and links aside.
  const kept = (ws) => {
    const out = {};
    for (const rel of ['notes.md', '.claude-memory', '.learnings', path.join('.claude', 'rules'), 'knowledge.md', 'decisions.md', 'context', 'SETUP.md']) {
      const p = path.join(ws, rel);
      if (!fs.existsSync(p)) continue;
      if (fs.statSync(p).isDirectory()) out[rel] = tree(p);
      else out[rel] = fs.readFileSync(p, 'base64');
    }
    return out;
  };
  const RESULT_KEYS = ['workspace', 'kind', 'slug', 'epic', 'status', 'previous', 'archived', 'changed', 'deleteIgnored', 'ignoredChanged',
    'removes', 'keeps', 'blockers', 'tasks', 'bytes', 'files', 'tasksMdUpdated'];
  const REMOVE_KEYS = ['name', 'mode', 'source', 'path', 'branch', 'sha', 'bytes', 'files', 'ignored', 'unpushed'];
  const ENVELOPE_KEYS = ['schemaVersion', 'wsgVersion', 'ok', 'command', 'dryRun', 'result', 'error', 'warnings'];

  console.log('\nwsg archive: a clean task');
  {
    const api = makeRepo();
    const web = makeRepo();
    const docs = path.join(tmp, 'docs-shop');
    fs.mkdirSync(docs);
    fs.writeFileSync(path.join(docs, 'brief.md'), 'brief\n');
    const ws = task('cart', [[api, ['--branch', 'feat/cart']], [web, ['--branch', 'feat/cart-web']], [docs, ['--reference']]]);
    // The owner's notes, memory and an edited rule: byte for byte after the archive.
    fs.appendFileSync(path.join(ws, 'notes.md'), '\nA note of the owner.\n');
    fs.writeFileSync(path.join(ws, '.claude-memory', 'MEMORY.md'), '- remembered\n');
    fs.writeFileSync(path.join(ws, '.learnings', 'LEARNINGS.md'), '# lesson\n');
    fs.appendFileSync(path.join(ws, '.claude', 'rules', `${path.basename(web)}.md`), '\nThe owner\'s line.\n');
    const before = { api: refs(api), web: refs(web), kept: kept(ws), docs: tree(docs), apiWt: worktreeCount(api) };
    const status0 = readState(ws).status;
    const dry = json(['archive', 'cart', '--dry-run']);
    it('--dry-run --json: the plan, dryRun true, every key', () => {
      assert.strictEqual(dry.code, 0, dry.all);
      assert.deepStrictEqual(Object.keys(dry.doc), ENVELOPE_KEYS);
      assert.strictEqual(dry.doc.dryRun, true);
      assert.strictEqual(dry.doc.command, 'archive');
      assert.deepStrictEqual(Object.keys(dry.doc.result), RESULT_KEYS);
      for (const r of dry.doc.result.removes) assert.deepStrictEqual(Object.keys(r), REMOVE_KEYS);
      assert.deepStrictEqual(Object.keys(dry.doc.result.keeps), ['folder', 'notes', 'memory', 'rules', 'context', 'branches']);
      assert.deepStrictEqual(Object.keys(dry.doc.result.blockers), ['dirty', 'ignored', 'detached']);
    });
    it('--dry-run: what goes — two worktrees with their size and tip, the reference link', () => {
      const r = dry.doc.result;
      assert.deepStrictEqual(r.removes.map((x) => [x.name, x.mode]), [[path.basename(api), 'worktree'], [path.basename(web), 'worktree'], ['docs-shop', 'reference']]);
      assert.strictEqual(r.removes[0].branch, 'feat/cart');
      assert.strictEqual(r.removes[0].sha, git(api, ['rev-parse', 'feat/cart']));
      assert.ok(r.removes[0].bytes > 0 && r.removes[0].files > 0);
      assert.strictEqual(r.removes[2].bytes, 0);
      assert.strictEqual(r.bytes, r.removes.reduce((n, x) => n + x.bytes, 0));
      assert.strictEqual(r.status, 'archived');
      assert.deepStrictEqual(r.previous, { status: 'open', closed: null });
      assert.strictEqual(r.changed, true);
      assert.deepStrictEqual(r.keeps.branches.map((b) => b.branch), ['feat/cart', 'feat/cart-web']);
      assert.strictEqual(r.keeps.notes, path.join(ws, 'notes.md'));
    });
    it('--dry-run changed nothing and took no lock', () => {
      assert.deepStrictEqual(kept(ws), before.kept);
      assert.strictEqual(readState(ws).status, status0);
      assert.ok(fs.existsSync(path.join(ws, path.basename(api), 'a.ts')));
      assert.ok(!fs.existsSync(path.join(ws, '.claude', 'wsg.lock')));
    });
    const plainDry = wsg(['archive', 'cart', '--dry-run']);
    it('the plain --dry-run prints the plan as JSON with errors and warnings', () => {
      assert.strictEqual(plainDry.code, 0, plainDry.all);
      const p = JSON.parse(plainDry.out);
      assert.deepStrictEqual(Object.keys(p), [...RESULT_KEYS, 'errors', 'warnings']);
    });
    const r = json(['archive', 'cart']);
    it('archive --json: ok, the same result, dryRun false', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(r.doc.ok, true);
      assert.strictEqual(r.doc.dryRun, false);
      assert.deepStrictEqual(Object.keys(r.doc.result), RESULT_KEYS);
      assert.deepStrictEqual(r.doc.result.removes.map((x) => x.name), dry.doc.result.removes.map((x) => x.name));
    });
    it('the branches are kept: the same refs, the same tips', () => {
      assert.strictEqual(refs(api), before.api);
      assert.strictEqual(refs(web), before.web);
    });
    it('the worktrees are gone, git knows them no more', () => {
      assert.ok(!fs.existsSync(path.join(ws, path.basename(api))));
      assert.ok(!fs.existsSync(path.join(ws, path.basename(web))));
      assert.strictEqual(worktreeCount(api), before.apiWt - 1);
    });
    it('the reference link is unlinked, its target intact', () => {
      assert.ok(!fs.existsSync(path.join(ws, 'docs-shop')));
      assert.deepStrictEqual(tree(docs), before.docs);
    });
    it('notes, memory, .learnings and rules are byte-identical, an edited rule included', () => assert.deepStrictEqual(kept(ws), before.kept));
    it('the state: archived, the record with the sources as they were, none attached', () => {
      const st = readState(ws);
      assert.strictEqual(st.status, 'archived');
      assert.deepStrictEqual(st.sources, []);
      assert.deepStrictEqual(st.archive.previous, { status: 'open', closed: null });
      assert.deepStrictEqual(st.archive.sources.map((x) => x.name), [path.basename(api), path.basename(web), 'docs-shop']);
      assert.strictEqual(st.archive.sources[0].branch, 'feat/cart');
      assert.strictEqual(W.stateProblem(st), '');
    });
    it('AGENTS.md has the archive block, right after the advisor\'s', () => {
      const text = read(ws, 'AGENTS.md');
      assert.match(text, /<!-- \/wsg:advisor -->\n<!-- wsg:archive -->\nThis task is archived since \d{4}-\d{2}-\d{2} \(`wsg archive`\): worktrees removed, their branches kept: `repo\d+` on `feat\/cart`, `repo\d+` on `feat\/cart-web`; links removed: `docs-shop`\.\n/);
      assert.match(text, /`wsg unarchive cart` attaches the sources again/);
    });
    it('README lists no sources, the repo pointer and mr-target-branch.txt are gone', () => {
      assert.match(read(ws, 'README.md'), /None yet/);
      assert.ok(!fs.existsSync(path.join(ws, 'repo')) && !fs.existsSync(path.join(ws, 'mr-target-branch.txt')));
    });
    const c = json(['check', ws]);
    it('check of the archived task: no fail', () => {
      const items = c.doc.result.sections.flatMap((x) => x.items);
      assert.ok(!items.some((x) => x.level === 'fail'), JSON.stringify(items.filter((x) => x.level === 'fail')));
      assert.ok(items.some((x) => /^archived .*branches kept: repo\d+ \(feat\/cart\), repo\d+ \(feat\/cart-web\)$/.test(x.text)));
    });
    const snap = tree(ws);
    const again = json(['archive', 'cart']);
    it('archive again: exit 0, changed false, nothing written', () => {
      assert.strictEqual(again.code, 0, again.all);
      assert.strictEqual(again.doc.result.changed, false);
      assert.deepStrictEqual(again.doc.result.removes, []);
      assert.deepStrictEqual(again.doc.result.keeps.branches.map((b) => b.branch), ['feat/cart', 'feat/cart-web']);
      assert.deepStrictEqual(tree(ws), snap);
    });
    it('the plain archive again says so', () => assert.match(wsg(['archive', 'cart']).out, /archived already, since/));
    for (const args of [['add', api, '--ws', ws, '--branch', 'x'], ['remove', path.basename(api), '--ws', ws]]) {
      const a = wsg(args);
      it(`wsg ${args[0]} in an archived workspace: refused, unarchive first`, () => {
        assert.strictEqual(a.code, 2, a.all);
        assert.match(a.err, /is archived: .*wsg unarchive cart first/);
        assert.deepStrictEqual(tree(ws), snap);
      });
    }
  }

  console.log('\nwsg archive: what refuses it, with nothing touched');
  {
    const cases = [
      ['a changed tracked file', (wt) => fs.appendFileSync(path.join(wt, 'a.ts'), '// edit\n'), 'dirty'],
      ['a staged file', (wt) => { fs.writeFileSync(path.join(wt, 'new.ts'), 'x\n'); git(wt, ['add', 'new.ts']); }, 'dirty'],
      ['an untracked file', (wt) => fs.writeFileSync(path.join(wt, 'scratch.txt'), 'x\n'), 'dirty'],
      ['an ignored file', (wt) => { fs.mkdirSync(path.join(wt, 'build')); fs.writeFileSync(path.join(wt, 'build', 'out.js'), 'x\n'); }, 'ignored'],
      ['a detached HEAD on a commit no branch has', (wt) => {
        git(wt, ['checkout', '-q', '--detach']);
        fs.writeFileSync(path.join(wt, 'b.ts'), 'b\n');
        git(wt, ['add', 'b.ts']);
        git(wt, ['commit', '-qm', 'lost']);
      }, 'detached'],
    ];
    for (const [what, spoil, kind] of cases) {
      const repo = makeRepo();
      const slug = `refuse-${kind}-${repoN}`;
      const ws = task(slug, [[repo, ['--branch', `feat/${slug}`]]]);
      const wt = path.join(ws, path.basename(repo));
      spoil(wt);
      const before = { tree: tree(ws), refs: refs(repo), wt: worktreeCount(repo) };
      const r = json(['archive', slug]);
      it(`${what}: refused, exit 2, invalid_input with the plan`, () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.strictEqual(r.doc.error.code, 'invalid_input');
        assert.strictEqual(r.doc.error.rollback, 'none');
        assert.deepStrictEqual(Object.keys(r.doc.result), RESULT_KEYS);
        assert.strictEqual(r.doc.result.blockers[kind].length, 1, JSON.stringify(r.doc.result.blockers));
        assert.strictEqual(r.doc.result.blockers[kind][0].source, path.basename(repo));
      });
      it(`${what}: nothing touched — the workspace, the worktree, the refs`, () => {
        assert.deepStrictEqual(tree(ws), before.tree);
        assert.strictEqual(refs(repo), before.refs);
        assert.strictEqual(worktreeCount(repo), before.wt);
      });
      const d = json(['archive', slug, '--dry-run']);
      it(`${what}: the dry run is refused the same way`, () => {
        assert.strictEqual(d.code, 2, d.all);
        assert.strictEqual(d.doc.dryRun, true);
        assert.deepStrictEqual(d.doc.result.blockers, r.doc.result.blockers);
      });
      if (kind === 'detached') {
        it('the plain refusal names the commit and the way out', () => assert.match(wsg(['archive', slug]).err, /detached HEAD, commit [0-9a-f]{40}, which no branch has/));
      }
      if (kind === 'ignored') {
        it('the ignored blocker lists the file, absolute', () => assert.deepStrictEqual(r.doc.result.blockers.ignored[0].files, [path.join(wt, 'build/')]));
        const checkout = () => Object.fromEntries(Object.entries(tree(repo, { into: false })).filter(([k]) => k !== '.git' && !k.startsWith('.git/')));
        const main = checkout();
        const del = json(['archive', slug, '--delete-ignored']);
        it('--delete-ignored: archived, the listed files gone with the worktree', () => {
          assert.strictEqual(del.code, 0, del.all);
          assert.strictEqual(del.doc.result.deleteIgnored, true);
          assert.deepStrictEqual(del.doc.result.removes[0].ignored, [path.join(wt, 'build/')]);
          assert.ok(!fs.existsSync(wt));
        });
        it('--delete-ignored: the main checkout and its own ignored files untouched, the refs equal', () => {
          assert.deepStrictEqual(checkout(), main);
          assert.ok(fs.existsSync(path.join(repo, '.env')));
          assert.strictEqual(refs(repo), before.refs);
        });
      }
    }
    // A detached HEAD at a branch's tip loses nothing.
    {
      const repo = makeRepo();
      const ws = task('tip', [[repo, ['--branch', 'feat/tip']]]);
      git(path.join(ws, path.basename(repo)), ['checkout', '-q', '--detach']);
      const before = refs(repo);
      const r = json(['archive', 'tip']);
      it('a detached HEAD at a branch\'s tip: archived, the refs equal', () => {
        assert.strictEqual(r.code, 0, r.all);
        assert.strictEqual(refs(repo), before);
      });
    }
    // Unpushed commits: a warning, never a refusal; the branch keeps them.
    {
      const repo = makeRepo();
      const ws = task('ahead', [[repo, ['--branch', 'feat/ahead']]]);
      const wt = path.join(ws, path.basename(repo));
      fs.writeFileSync(path.join(wt, 'c.ts'), 'c\n');
      git(wt, ['add', 'c.ts']);
      git(wt, ['commit', '-qm', 'work']);
      const tip = git(wt, ['rev-parse', 'HEAD']);
      const r = json(['archive', 'ahead']);
      it('unpushed commits: archived, a warning naming them, unpushed 1', () => {
        assert.strictEqual(r.code, 0, r.all);
        assert.ok(r.doc.warnings.some((w) => /1 commit of feat\/ahead is not on main — the branch keeps it/.test(w)), JSON.stringify(r.doc.warnings));
        assert.strictEqual(r.doc.result.removes[0].unpushed, 1);
      });
      it('the branch keeps the unpushed commit', () => assert.strictEqual(git(repo, ['rev-parse', 'feat/ahead']), tip));
    }
    // Two sources, the second dirty: the first is not touched either.
    {
      const one = makeRepo();
      const two = makeRepo();
      const ws = task('pair', [[one, ['--branch', 'feat/pair']], [two, ['--branch', 'feat/pair2']]]);
      fs.appendFileSync(path.join(ws, path.basename(two), 'a.ts'), '// edit\n');
      const before = { tree: tree(ws), one: refs(one), oneWt: worktreeCount(one) };
      const r = wsg(['archive', 'pair']);
      it('two sources, the second dirty: refused, exit 2', () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.match(r.err, /has changes that exist nowhere else/);
      });
      it('the first source is untouched: its worktree, its files, the refs', () => {
        assert.deepStrictEqual(tree(ws), before.tree);
        assert.strictEqual(worktreeCount(one), before.oneWt);
        assert.strictEqual(refs(one), before.one);
      });
    }
    // A directory where a worktree should be, not made by wsg: never removed.
    {
      const repo = makeRepo();
      const ws = task('fake', [[repo, ['--branch', 'feat/fake']]]);
      const wt = path.join(ws, path.basename(repo));
      git(repo, ['worktree', 'remove', wt]);
      fs.mkdirSync(wt);
      fs.writeFileSync(path.join(wt, 'mine.txt'), 'mine\n');
      const before = tree(ws);
      const r = wsg(['archive', 'fake']);
      it('a plain directory in place of the worktree: refused, kept', () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.match(r.err, /is not a worktree of/);
        assert.deepStrictEqual(tree(ws), before);
      });
    }
    // A worktree already gone: only its entry goes, into the record.
    {
      const repo = makeRepo();
      const ws = task('gone', [[repo, ['--branch', 'feat/gone']]]);
      git(repo, ['worktree', 'remove', path.join(ws, path.basename(repo))]);
      const r = json(['archive', 'gone']);
      it('a worktree deleted already: archived, recorded, the branch kept', () => {
        assert.strictEqual(r.code, 0, r.all);
        assert.strictEqual(readState(ws).archive.sources[0].branch, 'feat/gone');
        assert.ok(git(repo, ['rev-parse', 'feat/gone']));
      });
    }
  }

  console.log('\nwsg archive: what changes between the plan and the removal');
  {
    // An ignored file that appears after the plan: refused, though --delete-ignored was given.
    const repo = makeRepo();
    const ws = task('late', [[repo, ['--branch', 'feat/late']]]);
    const wt = path.join(ws, path.basename(repo));
    fs.writeFileSync(path.join(wt, '.env'), 'MINE=1\n');
    const plan = await quiet(() => A.planArchive(ws, W.readState(ws), { deleteIgnored: true }));
    it('the plan lists the ignored file, no error with --delete-ignored', () => {
      assert.deepStrictEqual(plan.errors, []);
      assert.deepStrictEqual(plan.removes[0].ignored, ['.env']);
    });
    fs.mkdirSync(path.join(wt, 'build'));
    fs.writeFileSync(path.join(wt, 'build', 'new.js'), 'x\n');
    const before = { tree: tree(ws), refs: refs(repo) };
    let err = null;
    await quiet(async () => { try { await A.applyArchive(plan, {}, { deleteIgnored: true }); } catch (e) { err = e; } });
    it('a new ignored file after the plan: refused, invalid, nothing rolled back because nothing changed', () => {
      assert.ok(err, 'no error');
      assert.strictEqual(err.invalid, true);
      assert.strictEqual(err.rollback, 'none');
      assert.match(err.message, /ignored files appeared after the check/);
      assert.match(err.message, /build\//);
    });
    it('the workspace and its worktree as they were, both ignored files there', () => {
      assert.deepStrictEqual(tree(ws), before.tree);
      assert.strictEqual(refs(repo), before.refs);
      assert.ok(fs.existsSync(path.join(wt, '.env')) && fs.existsSync(path.join(wt, 'build', 'new.js')));
    });
  }
  {
    // A failure after the first removal: the first worktree comes back, every file as it was.
    const one = makeRepo();
    const two = makeRepo();
    const ws = task('boom', [[one, ['--branch', 'feat/boom']], [two, ['--branch', 'feat/boom2']]]);
    const before = { tree: tree(ws, { into: false }), one: refs(one), two: refs(two), kept: kept(ws), state: read(ws, '.claude', 'wsg.json'), agents: read(ws, 'AGENTS.md') };
    const plan = await quiet(() => A.planArchive(ws, W.readState(ws), {}));
    const real = generate.removeSource;
    let calls = 0;
    generate.removeSource = (...args) => {
      if (++calls === 2) throw new Error('injected failure');
      return real(...args);
    };
    let err = null;
    try {
      await quiet(async () => { try { await A.applyArchive(plan, {}, {}); } catch (e) { err = e; } });
    } finally {
      generate.removeSource = real;
    }
    it('a failure after the first removal: the error, rolled back', () => {
      assert.ok(err && /injected failure/.test(err.message), err && err.message);
      assert.strictEqual(err.rollback, 'done');
      assert.strictEqual(calls, 2);
    });
    it('the first worktree is back on its branch, its files there', () => {
      const wt = path.join(ws, path.basename(one));
      assert.strictEqual(git(wt, ['branch', '--show-current']), 'feat/boom');
      assert.ok(fs.existsSync(path.join(wt, 'a.ts')));
      assert.strictEqual(git(wt, ['status', '--porcelain']), '');
    });
    it('the state, AGENTS.md and every file of the workspace as they were, the refs equal', () => {
      assert.strictEqual(read(ws, '.claude', 'wsg.json'), before.state);
      assert.strictEqual(read(ws, 'AGENTS.md'), before.agents);
      assert.deepStrictEqual(tree(ws, { into: false }), before.tree);
      assert.deepStrictEqual(kept(ws), before.kept);
      assert.strictEqual(refs(one), before.one);
      assert.strictEqual(refs(two), before.two);
    });
  }

  console.log('\nwsg archive --expect-ignored: the ignored files the owner was shown');
  {
    let fileN = 0;
    // FILE as a client writes it: the list, as JSON (raw: the text as it is).
    const seenFile = (list, raw = null) => {
      const f = path.join(tmp, `expect-${++fileN}.json`);
      fs.writeFileSync(f, raw !== null ? raw : JSON.stringify(list));
      return f;
    };
    const HEX = /^[0-9a-f]{64}$/;
    const noStamp = (list) => list.map(({ stamp, ...e }) => e);
    const spoil = (wt) => fs.writeFileSync(path.join(wt, '.env'), 'MINE=1\n');
    const exclude = (repo, pattern) => fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), `${pattern}\n`);
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    let fakeN = 0;
    // A git that runs body (sh) before the real one: what changes in the middle of a run.
    const fakeGit = (body) => {
      const dir = path.join(tmp, `fake-git-${++fakeN}`);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\n${body}\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
      return { PATH: `${dir}:${ENV.PATH}` };
    };
    // The nth `git ls-files … --directory` (the listing of ignored files) makes file first.
    const onNthListing = (n, file) => {
      const cnt = path.join(tmp, `fake-count-${fakeN + 1}`);
      return fakeGit(`case " $* " in *" ls-files "*"--directory"*) c=$(cat ${JSON.stringify(cnt)} 2>/dev/null || echo 0); c=$((c+1)); echo $c > ${JSON.stringify(cnt)}; [ "$c" = ${n} ] && echo late > ${JSON.stringify(file)};; esac`);
    };

    // The list equals the plan's: archived, the listed file gone with the worktree, nothing else.
    {
      const repo = makeRepo();
      const ws = task('exp-same', [[repo, ['--branch', 'feat/exp-same']]]);
      const wt = path.join(ws, path.basename(repo));
      spoil(wt);
      const dry = json(['archive', 'exp-same', '--dry-run']);
      it('the dry run without --delete-ignored lists the ignored file in blockers.ignored, with its stamp', () => {
        assert.strictEqual(dry.code, 2, dry.all);
        assert.deepStrictEqual(noStamp(dry.doc.result.blockers.ignored), [{ task: null, source: path.basename(repo), files: [path.join(wt, '.env')] }]);
        assert.match(dry.doc.result.blockers.ignored[0].stamp, HEX);
        assert.strictEqual(dry.doc.result.ignoredChanged, false);
      });
      const f = seenFile(dry.doc.result.blockers.ignored);
      const d = json(['archive', 'exp-same', '--delete-ignored', '--expect-ignored', f, '--dry-run']);
      it('a dry run with the matching list: exit 0', () => assert.strictEqual(d.code, 0, d.all));
      const r = json(['archive', 'exp-same', '--delete-ignored', '--expect-ignored', f]);
      it('expected equals the plan: archived, ignoredChanged false, the worktree gone', () => {
        assert.strictEqual(r.code, 0, r.all);
        assert.deepStrictEqual(Object.keys(r.doc.result), RESULT_KEYS);
        assert.strictEqual(r.doc.result.ignoredChanged, false);
        assert.deepStrictEqual(r.doc.result.removes[0].ignored, [path.join(wt, '.env')]);
        assert.ok(!fs.existsSync(wt));
        assert.strictEqual(readState(ws).status, 'archived');
      });
      it('the main checkout keeps its own .env', () => assert.strictEqual(read(repo, '.env'), 'TOKEN=x\n'));
    }

    // A file made after the dry run the owner saw: refused, nothing changed, the new list in result.
    {
      const repo = makeRepo();
      const ws = task('exp-new', [[repo, ['--branch', 'feat/exp-new']]]);
      const wt = path.join(ws, path.basename(repo));
      spoil(wt);
      const dry = json(['archive', 'exp-new', '--dry-run']);
      const f = seenFile(dry.doc.result.blockers.ignored);
      fs.mkdirSync(path.join(wt, 'build'));
      fs.writeFileSync(path.join(wt, 'build', 'late.js'), 'x\n');
      const before = { tree: tree(ws), refs: refs(repo), wt: worktreeCount(repo), state: read(ws, '.claude', 'wsg.json') };
      const r = json(['archive', 'exp-new', '--delete-ignored', '--expect-ignored', f]);
      const fresh = [{ task: null, source: path.basename(repo), files: [path.join(wt, '.env'), path.join(wt, 'build/')] }];
      it('a new ignored file: refused, exit 2, invalid_input, rollback none, the message lists the files now', () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.strictEqual(r.doc.error.code, 'invalid_input');
        assert.strictEqual(r.doc.error.rollback, 'none');
        assert.match(r.doc.error.message, /the ignored files changed since you saw them/);
        assert.ok(r.doc.error.message.includes(path.join(wt, 'build/')), r.doc.error.message);
      });
      it('the refusal carries the fresh plan: ignoredChanged true, blockers.ignored the new list with a new stamp', () => {
        assert.deepStrictEqual(Object.keys(r.doc.result), RESULT_KEYS);
        assert.strictEqual(r.doc.result.ignoredChanged, true);
        assert.deepStrictEqual(noStamp(r.doc.result.blockers.ignored), fresh);
        assert.match(r.doc.result.blockers.ignored[0].stamp, HEX);
      });
      it('nothing deleted: the workspace, both ignored files, the worktree, the refs, the state', () => {
        assert.deepStrictEqual(tree(ws), before.tree);
        assert.strictEqual(refs(repo), before.refs);
        assert.strictEqual(worktreeCount(repo), before.wt);
        assert.strictEqual(read(ws, '.claude', 'wsg.json'), before.state);
      });
      const d = json(['archive', 'exp-new', '--delete-ignored', '--expect-ignored', f, '--dry-run']);
      it('the dry run is refused the same way', () => {
        assert.strictEqual(d.code, 2, d.all);
        assert.strictEqual(d.doc.dryRun, true);
        assert.strictEqual(d.doc.result.ignoredChanged, true);
        assert.deepStrictEqual(d.doc.result.blockers.ignored, r.doc.result.blockers.ignored);
      });
      const more = json(['archive', 'exp-new', '--delete-ignored', '--dry-run', '--expect-ignored',
        seenFile([...r.doc.result.blockers.ignored, { task: null, source: 'other', files: ['/x'], stamp: 'a' }])]);
      it('a list that names more than there is: refused too', () => {
        assert.strictEqual(more.code, 2, more.all);
        assert.strictEqual(more.doc.result.ignoredChanged, true);
      });
      const plain = wsg(['archive', 'exp-new', '--delete-ignored', '--expect-ignored', f]);
      it('without --json: exit 2, the message and the files as they are now on stderr', () => {
        assert.strictEqual(plain.code, 2, plain.all);
        assert.match(plain.err, /the ignored files changed since you saw them/);
        assert.ok(plain.err.includes(path.join(wt, 'build/')) && plain.err.includes(path.join(wt, '.env')), plain.err);
      });
      // The list in the refusal, sent back in another order: the same files, archived.
      const back = r.doc.result.blockers.ignored.map((e) => ({ ...e, files: [...e.files].reverse() }));
      const again = json(['archive', 'exp-new', '--delete-ignored', '--expect-ignored', seenFile(back)]);
      it('the fresh list sent back (any order): archived', () => {
        assert.strictEqual(again.code, 0, again.all);
        assert.ok(!fs.existsSync(wt));
      });
    }

    // What a listed path holds is part of the agreement: a directory listed as build/, a file
    // listed by its name, a directory git shows whole because it holds only ignored files.
    {
      const repo = makeRepo();
      exclude(repo, '*.log');
      const ws = task('exp-deep', [[repo, ['--branch', 'feat/exp-deep']]]);
      const wt = path.join(ws, path.basename(repo));
      spoil(wt);
      fs.mkdirSync(path.join(wt, 'build'));
      fs.writeFileSync(path.join(wt, 'build', 'out.js'), 'x\n');
      fs.mkdirSync(path.join(wt, 'logs'));
      fs.writeFileSync(path.join(wt, 'logs', 'a.log'), 'a\n');
      const dry = json(['archive', 'exp-deep', '--dry-run']);
      it('build/ and logs/ are one entry each', () => assert.deepStrictEqual(dry.doc.result.blockers.ignored[0].files,
        [path.join(wt, '.env'), path.join(wt, 'build/'), path.join(wt, 'logs/')]));
      const f = seenFile(dry.doc.result.blockers.ignored);
      const refused = (what, change, undo) => {
        change();
        const before = tree(ws);
        const r = json(['archive', 'exp-deep', '--delete-ignored', '--expect-ignored', f]);
        it(`${what}: refused, the same files listed, ignoredChanged true, nothing touched`, () => {
          assert.strictEqual(r.code, 2, r.all);
          assert.strictEqual(r.doc.result.ignoredChanged, true);
          assert.deepStrictEqual(r.doc.result.blockers.ignored[0].files, dry.doc.result.blockers.ignored[0].files);
          assert.notStrictEqual(r.doc.result.blockers.ignored[0].stamp, dry.doc.result.blockers.ignored[0].stamp);
          assert.deepStrictEqual(tree(ws), before);
        });
        undo();
      };
      const keys = path.join(wt, 'build', 'deep', 'keys.pem');
      refused('build/deep/keys.pem added inside the listed build/', () => { fs.mkdirSync(path.dirname(keys)); fs.writeFileSync(keys, 'KEY\n'); }, () => {});
      const f2 = seenFile(json(['archive', 'exp-deep', '--dry-run']).doc.result.blockers.ignored);
      refused('logs/b.log added to a directory of ignored files only', () => fs.writeFileSync(path.join(wt, 'logs', 'b.log'), 'b\n'), () => {});
      void f2;
      // The listed .env rewritten with other content under the same name.
      const f3 = seenFile(json(['archive', 'exp-deep', '--dry-run']).doc.result.blockers.ignored);
      fs.writeFileSync(path.join(wt, '.env'), 'MINE=2, and longer\n');
      const r3 = json(['archive', 'exp-deep', '--delete-ignored', '--expect-ignored', f3]);
      it('a listed file rewritten with new content: refused', () => {
        assert.strictEqual(r3.code, 2, r3.all);
        assert.strictEqual(r3.doc.result.ignoredChanged, true);
        assert.strictEqual(read(wt, '.env'), 'MINE=2, and longer\n');
      });
      // Untouched since its dry run: archived, the directories with it.
      const last = json(['archive', 'exp-deep', '--dry-run']);
      const ok = json(['archive', 'exp-deep', '--delete-ignored', '--expect-ignored', seenFile(last.doc.result.blockers.ignored)]);
      it('untouched since the dry run: archived', () => {
        assert.strictEqual(ok.code, 0, ok.all);
        assert.ok(!fs.existsSync(wt));
      });
    }

    // A stamp that can't be forged: a same-size rewrite with the mtime put back, a copy renamed over
    // the file, a symlink pointed elsewhere; something that does not read can't be agreed to.
    {
      const repo = makeRepo();
      const ws = task('exp-forge', [[repo, ['--branch', 'feat/exp-forge']]]);
      const wt = path.join(ws, path.basename(repo));
      const env = path.join(wt, '.env');
      spoil(wt);
      fs.mkdirSync(path.join(wt, 'build'));
      fs.writeFileSync(path.join(wt, 'build', 'out.js'), 'x\n');
      fs.symlinkSync('aaaa', path.join(wt, 'build', 'link'));
      // A whole-second mtime, so putting it back gives the very same mtimeMs: only ctime and inode tell.
      const ROUND = 1700000000;
      fs.utimesSync(env, ROUND, ROUND);
      const dryList = () => json(['archive', 'exp-forge', '--dry-run']).doc.result.blockers.ignored;
      const refused = (what, change) => {
        const list = dryList();
        const f = seenFile(list);
        change();
        const before = tree(ws);
        const r = json(['archive', 'exp-forge', '--delete-ignored', '--expect-ignored', f]);
        it(`${what}: refused, ignoredChanged true, the same files, another stamp, nothing touched`, () => {
          assert.strictEqual(r.code, 2, r.all);
          assert.strictEqual(r.doc.result.ignoredChanged, true);
          assert.deepStrictEqual(r.doc.result.blockers.ignored[0].files, list[0].files);
          assert.notStrictEqual(r.doc.result.blockers.ignored[0].stamp, list[0].stamp);
          assert.deepStrictEqual(tree(ws), before);
        });
      };
      refused('.env rewritten, same size, its mtime put back (touch -r)', () => {
        const st = fs.statSync(env);
        fs.writeFileSync(env, 'MINE=9\n');
        fs.utimesSync(env, ROUND, ROUND);
        assert.strictEqual(fs.statSync(env).mtimeMs, st.mtimeMs);
        assert.strictEqual(fs.statSync(env).size, st.size);
      });
      refused('a copy with the same size and mtime renamed over .env', () => {
        const st = fs.statSync(env);
        const copy = path.join(tmp, 'forge.env');
        fs.writeFileSync(copy, 'MINE=8\n');
        fs.utimesSync(copy, ROUND, ROUND);
        fs.renameSync(copy, env);
        assert.strictEqual(fs.statSync(env).mtimeMs, st.mtimeMs);
      });
      refused('a symlink in build/ pointed elsewhere, same length', () => {
        fs.unlinkSync(path.join(wt, 'build', 'link'));
        fs.symlinkSync('bbbb', path.join(wt, 'build', 'link'));
      });
      if (process.getuid && process.getuid() === 0) skip('as root every directory reads');
      else {
        const locked = path.join(wt, 'build', 'locked');
        fs.mkdirSync(locked);
        fs.writeFileSync(path.join(locked, 'k'), 'k\n');
        fs.chmodSync(locked, 0o000);
        let one;
        let two;
        let r;
        try {
          one = dryList();
          two = dryList();
          r = json(['archive', 'exp-forge', '--delete-ignored', '--expect-ignored', seenFile(one)]);
        } finally {
          fs.chmodSync(locked, 0o755);
        }
        it('a directory under build/ that does not read: the stamp is unreadable:…, never the same twice', () => {
          assert.match(one[0].stamp, /^unreadable:/);
          assert.notStrictEqual(one[0].stamp, two[0].stamp);
        });
        it('a directory that does not read: refused, cannot verify, ignoredChanged false, the worktree there', () => {
          assert.strictEqual(r.code, 2, r.all);
          assert.strictEqual(r.doc.error.code, 'invalid_input');
          assert.match(r.doc.error.message, /does not read, so wsg cannot check/);
          assert.strictEqual(r.doc.result.ignoredChanged, false);
          assert.ok(fs.existsSync(path.join(locked, 'k')));
        });
      }
      const ok = json(['archive', 'exp-forge', '--delete-ignored', '--expect-ignored', seenFile(dryList())]);
      it('untouched since its dry run, a symlink in it: archived', () => {
        assert.strictEqual(ok.code, 0, ok.all);
        assert.ok(!fs.existsSync(wt));
      });
    }

    // A file made between the plan and the removal: the re-check compares against the expected list.
    {
      const repo = makeRepo();
      const ws = task('exp-mid', [[repo, ['--branch', 'feat/exp-mid']]]);
      const wt = path.join(ws, path.basename(repo));
      spoil(wt);
      const list = json(['archive', 'exp-mid', '--dry-run']).doc.result.blockers.ignored;
      const planned = async () => quiet(() => A.planArchive(ws, W.readState(ws), { deleteIgnored: true, expectIgnored: A.parseExpectIgnored(JSON.stringify(list)) }));
      const plan = await planned();
      it('the plan agrees with the expected list', () => {
        assert.deepStrictEqual(plan.errors, []);
        assert.strictEqual(plan.ignoredChanged, false);
        assert.deepStrictEqual(plan.removes[0].agreed, ['.env']);
        assert.strictEqual(plan.removes[0].agreedStamp, list[0].stamp);
      });
      fs.mkdirSync(path.join(wt, 'build'));
      fs.writeFileSync(path.join(wt, 'build', 'late.js'), 'x\n');
      const before = { tree: tree(ws), refs: refs(repo) };
      let err = null;
      await quiet(async () => { try { await A.applyArchive(plan, {}, { deleteIgnored: true }); } catch (e) { err = e; } });
      it('a file after the plan: refused before the first change, ignoredChanged on the error', () => {
        assert.ok(err, 'no error');
        assert.strictEqual(err.invalid, true);
        assert.strictEqual(err.ignoredChanged, true);
        assert.strictEqual(err.rollback, 'none');
        assert.match(err.message, /build\//);
      });
      it('nothing changed', () => {
        assert.deepStrictEqual(tree(ws), before.tree);
        assert.strictEqual(refs(repo), before.refs);
      });
      fs.rmSync(path.join(wt, 'build'), { recursive: true });
      const plan2 = await planned();
      fs.writeFileSync(path.join(wt, '.env'), 'MINE=3, other\n');
      let err2 = null;
      await quiet(async () => { try { await A.applyArchive(plan2, {}, { deleteIgnored: true }); } catch (e) { err2 = e; } });
      it('the agreed file edited after the plan: refused by the stamp, before the first change', () => {
        assert.ok(err2, 'no error');
        assert.strictEqual(err2.ignoredChanged, true);
        assert.strictEqual(err2.rollback, 'none');
        assert.match(err2.message, /the ignored files you agreed to changed after the check/);
      });
    }
    {
      // Between the last re-check and the source's own removal (removeSource checks again).
      const repo = makeRepo();
      const ws = task('exp-late', [[repo, ['--branch', 'feat/exp-late']]]);
      const wt = path.join(ws, path.basename(repo));
      spoil(wt);
      const list = json(['archive', 'exp-late', '--dry-run']).doc.result.blockers.ignored;
      const plan = await quiet(() => A.planArchive(ws, W.readState(ws), { deleteIgnored: true, expectIgnored: A.parseExpectIgnored(JSON.stringify(list)) }));
      const before = { state: read(ws, '.claude', 'wsg.json'), refs: refs(repo) };
      const real = generate.removeSource;
      let seen = null;
      generate.removeSource = (...args) => {
        seen = args[4];
        fs.writeFileSync(path.join(wt, '.env'), 'MINE=4, edited late\n');
        return real(...args);
      };
      let err = null;
      try {
        await quiet(async () => { try { await A.applyArchive(plan, {}, { deleteIgnored: true }); } catch (e) { err = e; } });
      } finally {
        generate.removeSource = real;
      }
      it('removeSource is given the agreed files and their stamp', () => {
        assert.deepStrictEqual(seen.ignored, ['.env']);
        assert.strictEqual(seen.ignoredStamp, list[0].stamp);
      });
      it('the file edited right before the removal: refused, rolled back, ignoredChanged on the error', () => {
        assert.ok(err, 'no error');
        assert.strictEqual(err.invalid, true);
        assert.strictEqual(err.ignoredChanged, true);
        assert.strictEqual(err.rollback, 'done');
      });
      it('the worktree, the edited file and the state as they were', () => {
        assert.strictEqual(read(wt, '.env'), 'MINE=4, edited late\n');
        assert.strictEqual(read(ws, '.claude', 'wsg.json'), before.state);
        assert.strictEqual(refs(repo), before.refs);
      });
    }

    // The CLI, a file made between its own plan and its re-check: the refusal has the list read again.
    {
      const repo = makeRepo();
      exclude(repo, '*.log');
      const ws = task('exp-cli-late', [[repo, ['--branch', 'feat/exp-cli-late']]]);
      const wt = path.join(ws, path.basename(repo));
      spoil(wt);
      const f = seenFile(json(['archive', 'exp-cli-late', '--dry-run']).doc.result.blockers.ignored);
      const r = json(['archive', 'exp-cli-late', '--delete-ignored', '--expect-ignored', f], { env: onNthListing(2, path.join(wt, 'late.log')) });
      it('late: invalid_input, rollback none, ignoredChanged true', () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.strictEqual(r.doc.error.code, 'invalid_input');
        assert.strictEqual(r.doc.error.rollback, 'none');
        assert.strictEqual(r.doc.result.ignoredChanged, true);
        assert.match(r.doc.error.message, /ignored files appeared after the check/);
      });
      it('late: blockers.ignored is the list read again, the new file in it, with its stamp', () => {
        assert.deepStrictEqual(noStamp(r.doc.result.blockers.ignored), [{ task: null, source: path.basename(repo), files: [path.join(wt, '.env'), path.join(wt, 'late.log')] }]);
        assert.match(r.doc.result.blockers.ignored[0].stamp, HEX);
        assert.ok(fs.existsSync(wt) && fs.existsSync(path.join(wt, 'late.log')));
      });
      const back = json(['archive', 'exp-cli-late', '--delete-ignored', '--expect-ignored', seenFile(r.doc.result.blockers.ignored)]);
      it('late: that list sent back, archived', () => assert.strictEqual(back.code, 0, back.all));
    }

    // FILE as a client may write it: a BOM, a path twice, names decomposed (NFD).
    {
      const repo = makeRepo();
      exclude(repo, '*.log');
      const ws = task('exp-form', [[repo, ['--branch', 'feat/exp-form']]]);
      const wt = path.join(ws, path.basename(repo));
      spoil(wt);
      fs.writeFileSync(path.join(wt, 'café.log'), 'x\n');
      const list = json(['archive', 'exp-form', '--dry-run']).doc.result.blockers.ignored;
      const dryWith = (f) => json(['archive', 'exp-form', '--delete-ignored', '--expect-ignored', f, '--dry-run']);
      const bom = dryWith(seenFile(null, `﻿${JSON.stringify(list)}`));
      it('a leading BOM: accepted', () => assert.strictEqual(bom.code, 0, bom.all));
      const twice = dryWith(seenFile(list.map((e) => ({ ...e, files: [...e.files, e.files[0]] }))));
      it('a path named twice: accepted', () => assert.strictEqual(twice.code, 0, twice.all));
      const nfd = list.map((e) => ({ ...e, files: e.files.map((x) => x.normalize('NFD')) }));
      it('the NFD list differs byte for byte', () => assert.notDeepStrictEqual(nfd, list));
      const dec = dryWith(seenFile(nfd));
      it('names decomposed (NFD): accepted', () => assert.strictEqual(dec.code, 0, dec.all));
      const real = json(['archive', 'exp-form', '--delete-ignored', '--expect-ignored', seenFile(nfd)]);
      it('names decomposed (NFD): archived', () => assert.strictEqual(real.code, 0, real.all));
    }

    // What --expect-ignored refuses as input: exit 2, invalid_input, nothing touched.
    {
      const repo = makeRepo();
      const ws = task('exp-bad', [[repo, ['--branch', 'feat/exp-bad']]]);
      spoil(path.join(ws, path.basename(repo)));
      const good = seenFile([]);
      const before = tree(ws);
      for (const [what, args, re] of [
        ['without --delete-ignored', ['--expect-ignored', good], /only goes with --delete-ignored/],
        ['without --delete-ignored, a dry run', ['--expect-ignored', good, '--dry-run'], /only goes with --delete-ignored/],
        ['a file that does not exist', ['--delete-ignored', '--expect-ignored', path.join(tmp, 'nope.json')], /does not read \(ENOENT\)/],
        ['a directory', ['--delete-ignored', '--expect-ignored', tmp], /does not read/],
        ['malformed JSON', ['--delete-ignored', '--expect-ignored', seenFile(null, '[{"task": null, "secret-token-xyz')], /not the list --expect-ignored takes \(not JSON\)$/],
        ['an object, not an array', ['--delete-ignored', '--expect-ignored', seenFile({ task: null })], /not a JSON array/],
        ['the dirty blockers instead', ['--delete-ignored', '--expect-ignored', seenFile([{ task: null, source: 'r', changes: [] }])], /entry 1 is not \{task, source, files, stamp\}/],
        ['an entry without its stamp', ['--delete-ignored', '--expect-ignored', seenFile([{ task: null, source: 'r', files: ['/a'] }])], /entry 1 is not/],
        ['files not strings', ['--delete-ignored', '--expect-ignored', seenFile([{ task: null, source: 'r', files: [1], stamp: 'a' }])], /entry 1 is not/],
      ]) {
        const r = json(['archive', 'exp-bad', ...args]);
        it(`--expect-ignored, ${what}: exit 2, invalid_input`, () => {
          assert.strictEqual(r.code, 2, r.all);
          assert.strictEqual(r.doc.error.code, 'invalid_input');
          assert.strictEqual(r.doc.error.rollback, 'none');
          assert.match(r.doc.error.message, re);
          assert.ok(!r.doc.error.message.includes('secret-token'), 'the file content is not quoted');
        });
      }
      it('nothing touched by any of them', () => assert.deepStrictEqual(tree(ws), before));
    }

    // An epic: the entries are named by task; a run that stops part of the way; the same FILE again.
    {
      const repo = makeRepo();
      exclude(repo, '*.log');
      const ep = task('expmall', [], ['--kind', 'epic', '--title', 'Exp mall']);
      assert.strictEqual(wsg(['add', repo, '--ws', ep, '--branch-template', 'expmall/{slug}']).code, 0);
      const e1 = task('e1', [], ['--epic', 'expmall']);
      const e2 = task('e2', [], ['--epic', 'expmall']);
      const wt1 = path.join(e1, path.basename(repo));
      const wt2 = path.join(e2, path.basename(repo));
      spoil(wt1);
      spoil(wt2);
      const dry = json(['archive', 'expmall', '--dry-run']);
      it('epic: the dry run names each entry by its task', () => {
        assert.deepStrictEqual(dry.doc.result.blockers.ignored.map((e) => [e.task, e.source, e.files]),
          [['e1', path.basename(repo), [path.join(wt1, '.env')]], ['e2', path.basename(repo), [path.join(wt2, '.env')]]]);
      });
      const f = seenFile(dry.doc.result.blockers.ignored);
      // A file in e2 made once e1's worktree is removed: e2's re-check refuses, e1 stays archived.
      const late = path.join(wt2, 'late.log');
      const env = fakeGit(`case " $* " in *" worktree remove ${wt1} "*) echo late > ${JSON.stringify(late)};; esac`);
      const half = json(['archive', 'expmall', '--delete-ignored', '--expect-ignored', f], { env });
      it('epic, a later task\'s re-check refuses: step_failed, done e1, failedTask e2, ignoredChanged true', () => {
        assert.strictEqual(half.code, 1, half.all);
        assert.strictEqual(half.doc.error.code, 'step_failed');
        assert.deepStrictEqual(half.doc.result.done, ['e1']);
        assert.strictEqual(half.doc.result.failedTask, 'e2');
        assert.strictEqual(half.doc.result.ignoredChanged, true);
        assert.ok(!fs.existsSync(wt1) && fs.existsSync(path.join(wt2, '.env')) && fs.existsSync(late));
      });
      fs.rmSync(late);
      const again = json(['archive', 'expmall', '--delete-ignored', '--expect-ignored', f]);
      it('epic: the same FILE again, e1 archived already by the cascade: accepted, all archived', () => {
        assert.strictEqual(again.code, 0, again.all);
        assert.ok(!fs.existsSync(wt2));
        assert.strictEqual(readState(e2).status, 'archived');
        assert.ok(readState(ep).archive);
      });
    }

    // wsg remove takes it too: {ignored, ignoredStamp} of its own dry run.
    {
      const repo = makeRepo();
      exclude(repo, '*.log');
      const ws = task('exp-rm', [[repo, ['--branch', 'feat/exp-rm']]]);
      const name = path.basename(repo);
      const wt = path.join(ws, name);
      spoil(wt);
      const dry = json(['remove', name, '--ws', ws, '--dry-run']);
      it('remove: the dry run lists the ignored file and its stamp, ignoredChanged false', () => {
        assert.strictEqual(dry.code, 2, dry.all);
        assert.deepStrictEqual(dry.doc.result.ignored, [path.join(wt, '.env')]);
        assert.match(dry.doc.result.ignoredStamp, HEX);
        assert.strictEqual(dry.doc.result.ignoredChanged, false);
      });
      const pick = (res) => seenFile({ ignored: res.ignored, ignoredStamp: res.ignoredStamp });
      const f = pick(dry.doc.result);
      fs.mkdirSync(path.join(wt, 'build'));
      fs.writeFileSync(path.join(wt, 'build', 'late.js'), 'x\n');
      const before = tree(ws);
      const r = json(['remove', name, '--ws', ws, '--delete-ignored', '--expect-ignored', f]);
      it('remove: a new ignored file refuses, exit 2, the fresh list in result.ignored', () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.strictEqual(r.doc.error.code, 'invalid_input');
        assert.match(r.doc.error.message, /the ignored files changed since you saw them/);
        assert.strictEqual(r.doc.result.ignoredChanged, true);
        assert.deepStrictEqual(r.doc.result.ignored, [path.join(wt, '.env'), path.join(wt, 'build/')]);
        assert.deepStrictEqual(tree(ws), before);
      });
      const f2 = pick(r.doc.result);
      fs.writeFileSync(path.join(wt, 'build', 'deep.js'), 'y\n');
      const deep = json(['remove', name, '--ws', ws, '--delete-ignored', '--expect-ignored', f2]);
      it('remove: a file added inside the listed build/: refused by the stamp', () => {
        assert.strictEqual(deep.code, 2, deep.all);
        assert.strictEqual(deep.doc.result.ignoredChanged, true);
        assert.notStrictEqual(deep.doc.result.ignoredStamp, r.doc.result.ignoredStamp);
      });
      const alone = json(['remove', name, '--ws', ws, '--expect-ignored', f]);
      it('remove: --expect-ignored without --delete-ignored, exit 2', () => {
        assert.strictEqual(alone.code, 2, alone.all);
        assert.match(alone.doc.error.message, /only goes with --delete-ignored/);
      });
      const bad = json(['remove', name, '--ws', ws, '--delete-ignored', '--expect-ignored', seenFile([path.join(wt, '.env')])]);
      it('remove: a bare array (no stamp), exit 2', () => {
        assert.strictEqual(bad.code, 2, bad.all);
        assert.match(bad.doc.error.message, /not \{ignored, ignoredStamp\}/);
      });
      // Late: a file made between the plan and the removal; the refusal reads the list again.
      const f3 = pick(json(['remove', name, '--ws', ws, '--dry-run']).doc.result);
      const late = json(['remove', name, '--ws', ws, '--delete-ignored', '--expect-ignored', f3], { env: onNthListing(2, path.join(wt, 'late.log')) });
      it('remove, late: invalid_input, ignoredChanged true, result.ignored read again with the new file', () => {
        assert.strictEqual(late.code, 2, late.all);
        assert.strictEqual(late.doc.result.ignoredChanged, true);
        assert.ok(late.doc.result.ignored.includes(path.join(wt, 'late.log')), JSON.stringify(late.doc.result.ignored));
        assert.ok(fs.existsSync(wt));
      });
      // The whole result of the refusal as FILE: removed.
      const ok = json(['remove', name, '--ws', ws, '--delete-ignored', '--expect-ignored', seenFile(late.doc.result)]);
      it('remove: the whole fresh result sent back, removed', () => {
        assert.strictEqual(ok.code, 0, ok.all);
        assert.strictEqual(ok.doc.result.ignoredChanged, false);
        assert.ok(!fs.existsSync(wt));
      });
    }
  }

  console.log('\nwsg archive: locks');
  {
    const repo = makeRepo();
    const ws = task('locked', [[repo, ['--branch', 'feat/locked']]]);
    const lockFile = path.join(ws, '.claude', 'wsg.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
    const before = tree(ws);
    const r = json(['archive', 'locked']);
    it('a workspace another command holds: exit 2, busy, nothing changed', () => {
      assert.strictEqual(r.code, 2, r.all);
      assert.strictEqual(r.doc.error.code, 'busy');
      assert.deepStrictEqual(tree(ws), before);
    });
    const held = fs.readFileSync(lockFile, 'utf8');
    const d = json(['archive', 'locked', '--dry-run']);
    it('a dry run takes no lock: it plans while another command holds it', () => {
      assert.strictEqual(d.code, 0, d.all);
      assert.strictEqual(d.doc.result.changed, true);
      assert.strictEqual(read(ws, '.claude', 'wsg.lock'), held);
    });
    fs.unlinkSync(lockFile);
    const dry2 = wsg(['archive', 'locked', '--dry-run']);
    it('and leaves no lock file behind', () => {
      assert.strictEqual(dry2.code, 0, dry2.all);
      assert.ok(!fs.existsSync(lockFile));
    });
    fs.writeFileSync(lockFile, held);
    fs.unlinkSync(lockFile);
  }

  console.log('\nwsg archive: an epic and its tasks');
  {
    const repo = makeRepo();
    const ep = task('mall', [], ['--kind', 'epic', '--title', 'Mall']);
    const add = wsg(['add', repo, '--ws', ep, '--branch-template', 'mall/{slug}']);
    assert.strictEqual(add.code, 0, add.all);
    fs.mkdirSync(path.join(ep, 'context'), { recursive: true });
    const ctx = wsg(['context', 'note', 'deploy', '--text', 'Deploy on Fridays.', '--title', 'Deploy', '--ws', ep]);
    assert.strictEqual(ctx.code, 0, ctx.all);
    const t1 = task('t1', [], ['--epic', 'mall']);
    const t2 = task('t2', [], ['--epic', 'mall']);
    const t3 = task('t3', [], ['--epic', 'mall']);
    // t3 archived on its own before: it keeps its own record, the cascade does not take it.
    const solo = json(['archive', 'mall/t3']);
    assert.strictEqual(solo.code, 0, solo.all);
    const keptAll = () => ({ ep: kept(ep), t1: kept(t1), t2: kept(t2) });
    fs.appendFileSync(path.join(t2, path.basename(repo), 'a.ts'), '// edit\n');
    const before = { tree: tree(ep), refs: refs(repo), wt: worktreeCount(repo) };
    const r = json(['archive', 'mall']);
    it('one dirty task refuses the whole epic: exit 2, the blocker named by its task', () => {
      assert.strictEqual(r.code, 2, r.all);
      assert.deepStrictEqual(r.doc.result.blockers.dirty.map((b) => [b.task, b.source]), [['t2', path.basename(repo)]]);
      assert.ok(r.doc.error.details.some((x) => /^t2: worktree/.test(x)));
    });
    it('nothing of the epic or any task touched', () => {
      assert.deepStrictEqual(tree(ep), before.tree);
      assert.strictEqual(refs(repo), before.refs);
      assert.strictEqual(worktreeCount(repo), before.wt);
    });
    git(path.join(t2, path.basename(repo)), ['checkout', '--', 'a.ts']);
    const k0 = keptAll();
    // A task whose archive fails half-way: README.md that can't be written.
    fs.chmodSync(path.join(t2, 'README.md'), 0o444);
    const half = json(['archive', 'mall']);
    fs.chmodSync(path.join(t2, 'README.md'), 0o644);
    it('a task that fails: step_failed naming it, the tasks done so far kept, a run again goes on', () => {
      assert.strictEqual(half.code, 1, half.all);
      assert.strictEqual(half.doc.error.code, 'step_failed');
      assert.match(half.doc.error.message, /task t2 could not be archived/);
      assert.match(half.doc.error.message, /Archived by this run, and kept so: t1/);
      assert.deepStrictEqual(half.doc.result.done, ['t1']);
      assert.strictEqual(half.doc.result.failedTask, 't2');
      assert.match(half.doc.result.reason, /EACCES|permission/i);
    });
    it('after it: t1 archived by the epic, t2 rolled back with its worktree, the epic not archived', () => {
      assert.strictEqual(readState(t1).archive.byEpic, true);
      assert.strictEqual(readState(t2).status, 'open');
      assert.ok(fs.existsSync(path.join(t2, path.basename(repo), 'a.ts')));
      assert.strictEqual(readState(ep).archive, undefined);
      assert.ok(fs.lstatSync(path.join(ep, path.basename(repo))).isSymbolicLink());
    });
    const dry = json(['archive', 'mall', '--dry-run']);
    it('the dry run of the rest: t1 changed false, t2 to go, t3 not taken', () => {
      assert.strictEqual(dry.code, 0, dry.all);
      assert.deepStrictEqual(dry.doc.result.tasks.map((x) => [x.task, x.changed]), [['t1', false], ['t2', true]]);
      assert.strictEqual(dry.doc.result.status, null);
      assert.strictEqual(dry.doc.result.previous, null);
      assert.strictEqual(dry.doc.result.keeps.context, path.join(ep, 'context'));
    });
    const done = json(['archive', 'mall']);
    it('run again: the epic archived, ok', () => {
      assert.strictEqual(done.code, 0, done.all);
      assert.strictEqual(done.doc.result.changed, true);
    });
    it('the epic\'s record: its link, the cascade t1 and t2, not t3', () => {
      const st = readState(ep);
      assert.deepStrictEqual(st.archive.cascade, ['t1', 't2']);
      assert.deepStrictEqual(st.archive.sources.map((s) => s.name), [path.basename(repo)]);
      assert.deepStrictEqual(st.sources, []);
      assert.strictEqual(st.status, undefined);
      assert.strictEqual(readState(t3).archive.byEpic, undefined);
      assert.strictEqual(readState(t2).archive.byEpic, true);
    });
    it('the link unlinked, the checkout intact, the branches kept, no worktree left', () => {
      assert.ok(!fs.existsSync(path.join(ep, path.basename(repo))));
      assert.ok(fs.existsSync(path.join(repo, 'a.ts')));
      assert.strictEqual(refs(repo), before.refs);
      assert.strictEqual(worktreeCount(repo), 1);
    });
    it('knowledge, decisions, context, notes, memory and rules byte-identical, the epic\'s and its tasks\'', () => assert.deepStrictEqual(keptAll(), k0));
    it('tasks.md marks every task [archived date]; AGENTS.md of the epic has the block', () => {
      const tasks = read(ep, 'tasks.md');
      for (const s of ['t1', 't2', 't3']) assert.match(tasks, new RegExp(`^- \`${s}/\` \\[archived \\d{4}-\\d{2}-\\d{2}\\]$`, 'm'));
      assert.match(read(ep, 'AGENTS.md'), /This epic is archived since .*, with its tasks: links removed: `repo\d+`\./);
    });
    const l = json(['list']);
    it('list: the epic archived with its link in archivedSources', () => {
      const e = l.doc.result.workspaces.find((w) => w.slug === 'mall');
      assert.ok(e.archived);
      assert.deepStrictEqual(e.archivedSources.map((s) => s.name), [path.basename(repo)]);
      assert.deepStrictEqual(e.tasks.map((x) => x.status), ['archived', 'archived', 'archived']);
    });
    const ce = json(['check', ep]);
    it('check of the archived epic: no fail', () => {
      const items = ce.doc.result.sections.flatMap((x) => x.items);
      assert.ok(!items.some((x) => x.level === 'fail'), JSON.stringify(items.filter((x) => x.level === 'fail')));
    });
    const nw = wsg(['new', 't4', '--epic', 'mall', '--no-launch']);
    it('an archived epic takes no new task', () => {
      assert.strictEqual(nw.code, 2, nw.all);
      assert.match(nw.err, /is archived/);
      assert.ok(!fs.existsSync(path.join(ep, 't4')));
    });
    // A busy task refuses the epic's archive: a second epic, so the first stays as it is.
    const repo2 = makeRepo();
    const ep2 = task('plaza', [], ['--kind', 'epic']);
    assert.strictEqual(wsg(['add', repo2, '--ws', ep2, '--branch-template', 'plaza/{slug}']).code, 0);
    const p1 = task('p1', [], ['--epic', 'plaza']);
    fs.writeFileSync(path.join(p1, '.claude', 'wsg.lock'), JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
    const b2 = tree(ep2);
    const busy = json(['archive', 'plaza']);
    it('a task of the epic another command holds: exit 2, busy, nothing changed', () => {
      assert.strictEqual(busy.code, 2, busy.all);
      assert.strictEqual(busy.doc.error.code, 'busy');
      assert.deepStrictEqual(tree(ep2), b2);
    });
    fs.unlinkSync(path.join(p1, '.claude', 'wsg.lock'));
  }

  console.log('\nwsg archive: a workspace made by an earlier wsg');
  {
    // The state as wsg before 0.5 wrote it: no status. Archived as open.
    const repo = makeRepo();
    const ws = task('older', [[repo, ['--branch', 'feat/older']]]);
    const st = readState(ws);
    delete st.status;
    writeState(ws, st);
    const before = refs(repo);
    const r = json(['archive', 'older']);
    it('a state without a status: archived, previous open, the branch kept', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.deepStrictEqual(readState(ws).archive.previous, { status: 'open', closed: null });
      assert.strictEqual(refs(repo), before);
    });
    // A done task keeps its closing date in the record.
    const ws2 = task('closed-one');
    assert.strictEqual(wsg(['close', 'closed-one']).code, 0);
    const closed = readState(ws2).closed;
    const r2 = json(['archive', 'closed-one']);
    it('a done task: the date it was closed goes into the record, "closed" leaves the state', () => {
      assert.strictEqual(r2.code, 0, r2.all);
      assert.deepStrictEqual(readState(ws2).archive.previous, { status: 'done', closed });
      assert.strictEqual(readState(ws2).closed, undefined);
    });
  }

  console.log('\nwsg archive: the CLI');
  {
    const r = wsg(['archive', 'a', '--ws', 'b']);
    it('a workspace named twice: exit 2', () => assert.strictEqual(r.code, 2, r.all));
    const n = wsg(['archive'], { cwd: tmp });
    it('outside a workspace, none named: exit 2', () => assert.strictEqual(n.code, 2, n.all));
    const G = require(path.join(ROOT, 'lib', 'advisor-guard.js'));
    it('the advisor guard: archive only with --dry-run', () => {
      assert.strictEqual(G.bashAllowed(`node "${CLI}" archive shop/cart --dry-run`), true);
      assert.strictEqual(G.bashAllowed(`node "${CLI}" archive shop/cart --dry-run --json`), true);
      assert.strictEqual(G.bashAllowed(`node "${CLI}" archive shop/cart`), false);
      assert.strictEqual(G.bashAllowed(`node "${CLI}" archive shop/cart --delete-ignored`), false);
      assert.strictEqual(G.bashAllowed(`node "${CLI}" archive shop/cart --delete-ignored --expect-ignored seen.json`), false);
      // --dry-run as the value of --expect-ignored is no dry run.
      assert.strictEqual(G.bashAllowed(`node "${CLI}" archive shop/cart --delete-ignored --expect-ignored --dry-run`), false);
      assert.strictEqual(G.bashAllowed(`node "${CLI}" archive shop/cart --delete-ignored --expect-ignored seen.json --dry-run --json`), true);
      assert.strictEqual(G.bashAllowed(`node "${CLI}" remove repo --delete-ignored --expect-ignored seen.json`), false);
    });
  }

  console.log('\nwsg remove: a detached HEAD');
  {
    const repo = makeRepo();
    const ws = task('detach', [[repo, ['--branch', 'feat/detach']]]);
    const wt = path.join(ws, path.basename(repo));
    git(wt, ['checkout', '-q', '--detach']);
    fs.writeFileSync(path.join(wt, 'd.ts'), 'd\n');
    git(wt, ['add', 'd.ts']);
    git(wt, ['commit', '-qm', 'only here']);
    const before = tree(ws);
    const r = wsg(['remove', path.basename(repo), '--ws', ws]);
    it('remove of a worktree on a commit no branch has: refused, exit 2, nothing changed', () => {
      assert.strictEqual(r.code, 2, r.all);
      assert.match(r.err, /detached HEAD, commit [0-9a-f]{40}, which no branch has/);
      assert.deepStrictEqual(tree(ws), before);
    });
    git(wt, ['switch', '-q', '-c', 'feat/kept']);
    const ok = wsg(['remove', path.basename(repo), '--ws', ws]);
    it('once the commit is on a branch: removed, the branch kept', () => {
      assert.strictEqual(ok.code, 0, ok.all);
      assert.ok(git(repo, ['rev-parse', 'feat/kept']));
    });
  }

  console.log('\nwsg archive and remove: what git status does not show');
  {
    for (const [flag, tag] of [['--skip-worktree', 'S'], ['--assume-unchanged', 'h']]) {
      const repo = makeRepo();
      const slug = `hidden-${tag.toLowerCase()}-${repoN}`;
      const ws = task(slug, [[repo, ['--branch', `feat/${slug}`]]]);
      const wt = path.join(ws, path.basename(repo));
      git(wt, ['update-index', flag, 'a.ts']);
      // Flagged but not edited: nothing to lose, no refusal.
      const clean = json(['archive', slug, '--dry-run']);
      it(`${flag}, not edited: no refusal`, () => assert.strictEqual(clean.code, 0, clean.all));
      fs.writeFileSync(path.join(wt, 'a.ts'), 'export const a = 2; // only here\n');
      it(`${flag}, edited: git status does not show it`, () => assert.strictEqual(git(wt, ['status', '--porcelain']), ''));
      const before = { tree: tree(ws), refs: refs(repo) };
      const r = json(['archive', slug]);
      it(`${flag}, edited: archive refused, exit 2, the file listed as a dirty blocker`, () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.ok(r.doc.error.details.some((x) => /edits git status does not show/.test(x) && x.includes(`${tag}  a.ts`)), JSON.stringify(r.doc.error.details));
        assert.deepStrictEqual(r.doc.result.blockers.dirty[0].changes, [`${tag}  a.ts`]);
      });
      const rm = wsg(['remove', path.basename(repo), '--ws', ws]);
      it(`${flag}, edited: remove refused, exit 2`, () => {
        assert.strictEqual(rm.code, 2, rm.all);
        assert.match(rm.err, /skip-worktree \(S\) or assume-unchanged \(h\)/);
      });
      it(`${flag}, edited: nothing touched, the edit there`, () => {
        assert.deepStrictEqual(tree(ws), before.tree);
        assert.strictEqual(refs(repo), before.refs);
        assert.match(read(wt, 'a.ts'), /only here/);
      });
    }
  }

  console.log('\nwsg archive: commits only the worktree\'s reflog has');
  {
    const repo = makeRepo();
    const ws = task('reflog', [[repo, ['--branch', 'feat/reflog']]]);
    const wt = path.join(ws, path.basename(repo));
    git(wt, ['checkout', '-q', '--detach']);
    fs.writeFileSync(path.join(wt, 'r.ts'), 'r\n');
    git(wt, ['add', 'r.ts']);
    git(wt, ['commit', '-qm', 'left behind']);
    const lost = git(wt, ['rev-parse', 'HEAD']);
    git(wt, ['checkout', '-q', 'feat/reflog']);
    const d = json(['archive', 'reflog', '--dry-run']);
    it('the plan warns, naming the commit; no refusal', () => {
      assert.strictEqual(d.code, 0, d.all);
      assert.ok(d.doc.warnings.some((w) => /1 commit only the worktree's HEAD reflog has/.test(w) && w.includes(lost)), JSON.stringify(d.doc.warnings));
    });
    const r = json(['archive', 'reflog']);
    it('the archive warns the same and goes on', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.ok(r.doc.warnings.some((w) => w.includes(lost)));
    });
  }

  console.log('\nwsg archive: what git worktree remove would refuse late, refused in the plan');
  {
    const one = makeRepo();
    const two = makeRepo();
    const ws = task('lockd', [[one, ['--branch', 'feat/lockd']], [two, ['--branch', 'feat/lockd2']]]);
    const wt1 = path.join(ws, path.basename(one));
    fs.writeFileSync(path.join(wt1, '.env'), 'ONLY_HERE=1\n');
    git(two, ['worktree', 'lock', '--reason', 'on a stick', path.join(ws, path.basename(two))]);
    const before = tree(ws);
    const r = json(['archive', 'lockd', '--delete-ignored']);
    it('a locked worktree: refused in the plan, exit 2', () => {
      assert.strictEqual(r.code, 2, r.all);
      assert.ok(r.doc.error.details.some((x) => /is locked \(git worktree lock: on a stick\)/.test(x)), JSON.stringify(r.doc.error.details));
    });
    it('with --delete-ignored, the first source\'s ignored file is not lost', () => {
      assert.deepStrictEqual(tree(ws), before);
      assert.strictEqual(read(wt1, '.env'), 'ONLY_HERE=1\n');
    });
    const rm = wsg(['remove', path.basename(two), '--ws', ws]);
    it('remove of the locked worktree: refused in the plan too', () => {
      assert.strictEqual(rm.code, 2, rm.all);
      assert.match(rm.err, /is locked/);
    });
  }
  {
    const sub = makeRepo();
    const main = makeRepo();
    git(main, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub']);
    git(main, ['commit', '-qm', 'submodule']);
    const ws = task('subm', [[main, ['--branch', 'feat/subm']]]);
    const wt = path.join(ws, path.basename(main));
    git(wt, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init']);
    const before = { tree: tree(ws, { into: false }), refs: refs(main) };
    const r = json(['archive', 'subm', '--delete-ignored']);
    it('a submodule checked out in the worktree: refused in the plan, exit 2', () => {
      assert.strictEqual(r.code, 2, r.all);
      assert.ok(r.doc.error.details.some((x) => /has submodules checked out/.test(x)), JSON.stringify(r.doc.error.details));
    });
    it('nothing touched, the submodule there', () => {
      assert.deepStrictEqual(tree(ws, { into: false }), before.tree);
      assert.ok(fs.existsSync(path.join(wt, 'vendor', 'sub', 'a.ts')));
      assert.strictEqual(refs(main), before.refs);
    });
  }

  console.log('\nwsg archive: the record keeps the branch the work is on');
  {
    // The branch attached deleted, the work on another one.
    const repo = makeRepo();
    const ws = task('moved', [[repo, ['--branch', 'feat/moved']]]);
    const wt = path.join(ws, path.basename(repo));
    git(wt, ['switch', '-q', '-c', 'feat/moved-2']);
    git(repo, ['branch', '-D', 'feat/moved']);
    const r = json(['archive', 'moved']);
    it('the attached branch deleted, work on another: archived, the record names the one checked out', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(readState(ws).archive.sources[0].branch, 'feat/moved-2');
      assert.match(read(ws, 'AGENTS.md'), /on `feat\/moved-2`/);
      assert.deepStrictEqual(r.doc.result.keeps.branches.map((b) => b.branch), ['feat/moved-2']);
    });
    // The branch attached still there, the work on another one.
    const repo2 = makeRepo();
    const ws2 = task('moved2', [[repo2, ['--branch', 'feat/first']]]);
    git(path.join(ws2, path.basename(repo2)), ['switch', '-q', '-c', 'feat/second']);
    const r2 = json(['archive', 'moved2']);
    it('the attached branch there, work on another: the record names the one checked out', () => {
      assert.strictEqual(r2.code, 0, r2.all);
      assert.strictEqual(readState(ws2).archive.sources[0].branch, 'feat/second');
      assert.ok(git(repo2, ['rev-parse', 'feat/first']));
    });
  }

  console.log('\nwsg archive: what an older wsg can read');
  {
    const ws = task('v4');
    assert.strictEqual(wsg(['archive', 'v4']).code, 0);
    it('an archived state is written as version 4, which wsg 0.7 refuses', () => assert.strictEqual(readState(ws).version, 4));
  }

  console.log('\nwsg archive: the record before the first removal');
  {
    const one = makeRepo();
    const two = makeRepo();
    const ws = task('record', [[one, ['--branch', 'feat/record']], [two, ['--branch', 'feat/record2']]]);
    const plan = await quiet(() => A.planArchive(ws, W.readState(ws), {}));
    const real = generate.removeSource;
    let calls = 0;
    let seen = null;
    generate.removeSource = (...args) => {
      if (++calls === 2) {
        // A hard kill here: what is on disk now is what is left.
        seen = read(ws, '.claude', 'wsg.json');
        throw new Error('killed');
      }
      return real(...args);
    };
    try {
      await quiet(async () => { try { await A.applyArchive(plan, {}, {}); } catch { /* rolled back */ } });
    } finally {
      generate.removeSource = real;
    }
    const mid = JSON.parse(seen);
    it('after the first removal the state holds the full record, both sources in it', () => {
      assert.strictEqual(mid.status, 'archived');
      assert.deepStrictEqual(mid.archive.sources.map((s) => s.name), [path.basename(one), path.basename(two)]);
      assert.deepStrictEqual(mid.sources.map((s) => s.name), [path.basename(two)]);
      assert.strictEqual(W.stateProblem(mid), '');
    });
    // What a kill would have left: that state, the first worktree gone.
    git(one, ['worktree', 'remove', path.join(ws, path.basename(one))]);
    writeState(ws, mid);
    const l = json(['list']);
    it('the half state reads: list shows it archived, with a problem said by check', () => {
      assert.strictEqual(l.doc.result.workspaces.find((w) => w.slug === 'record').status, 'archived');
    });
    const again = json(['archive', 'record']);
    it('wsg archive again goes on from it: the second worktree goes, the record keeps both', () => {
      assert.strictEqual(again.code, 0, again.all);
      assert.strictEqual(again.doc.result.changed, true);
      const st = readState(ws);
      assert.deepStrictEqual(st.sources, []);
      assert.deepStrictEqual(st.archive.sources.map((s) => s.name), [path.basename(one), path.basename(two)]);
      assert.ok(!fs.existsSync(path.join(ws, path.basename(two))));
    });
  }

  console.log('\nwsg archive: a stop in the middle of git\'s removal');
  {
    const gitLib = require(path.join(ROOT, 'lib', 'git.js'));
    for (const [what, alsoGit, rollback] of [
      ['tracked files deleted', false, 'done'],
      ['its .git file deleted too', 'file', 'done'],
      ['its .git file and git\'s directory for it deleted', 'admin', 'incomplete'],
    ]) {
      const repo = makeRepo();
      const slug = `stop-${repoN}`;
      const ws = task(slug, [[repo, ['--branch', `feat/${slug}`]]]);
      const wt = path.join(ws, path.basename(repo));
      const plan = await quiet(() => A.planArchive(ws, W.readState(ws), {}));
      const stateBefore = read(ws, '.claude', 'wsg.json');
      const realRun = gitLib.gitRun;
      gitLib.gitRun = (dir, args) => {
        if (args[0] === 'worktree' && args[1] === 'remove') {
          // git was half-way through deleting the worktree when Ctrl+C came.
          fs.rmSync(path.join(wt, 'a.ts'));
          fs.rmSync(path.join(wt, 'pkg'), { recursive: true });
          if (alsoGit) {
            const admin = fs.readFileSync(path.join(wt, '.git'), 'utf8').replace(/^gitdir: /, '').trim();
            fs.rmSync(path.join(wt, '.git'));
            if (alsoGit === 'admin') fs.rmSync(admin, { recursive: true });
          }
          return { ok: false, out: '', stdout: '', status: null, signal: 'SIGINT' };
        }
        return realRun(dir, args);
      };
      let err = null;
      try {
        await quiet(async () => { try { await A.applyArchive(plan, {}, {}); } catch (e) { err = e; } });
      } finally {
        gitLib.gitRun = realRun;
      }
      it(`a stop with ${what}: interrupted, rollback ${rollback}`, () => {
        assert.ok(err && err.name === 'Interrupted', err && err.message);
        assert.strictEqual(err.rollback, rollback);
      });
      it(`a stop with ${what}: the state as it was`, () => assert.strictEqual(read(ws, '.claude', 'wsg.json'), stateBefore));
      if (rollback === 'done') {
        it(`a stop with ${what}: the deleted tracked files are back, the worktree clean`, () => {
          assert.ok(fs.existsSync(path.join(wt, 'a.ts')) && fs.existsSync(path.join(wt, 'pkg', 'index.ts')));
          assert.strictEqual(git(wt, ['status', '--porcelain']), '');
          assert.strictEqual(git(wt, ['branch', '--show-current']), `feat/${slug}`);
        });
      }
      if (alsoGit === 'file') {
        it('the .git file points at git\'s directory again: git lists the worktree, prune keeps it', () => {
          git(repo, ['worktree', 'prune']);
          assert.strictEqual(worktreeCount(repo), 2);
          assert.strictEqual(fs.realpathSync(git(wt, ['rev-parse', '--show-toplevel'])), fs.realpathSync(wt));
        });
      }
    }
  }

  console.log('\nwsg archive: an archived epic with a task that is not');
  {
    const repo = makeRepo();
    const ep = task('kiosk', [], ['--kind', 'epic']);
    assert.strictEqual(wsg(['add', repo, '--ws', ep, '--branch-template', 'kiosk/{slug}']).code, 0);
    const k1 = task('k1', [], ['--epic', 'kiosk']);
    const k2 = task('k2', [], ['--epic', 'kiosk']);
    const k2State = readState(k2);
    assert.strictEqual(wsg(['archive', 'kiosk']).code, 0);
    // k2 live again by hand (an older wsg, an edit), its worktree back.
    git(repo, ['worktree', 'add', '-q', path.join(k2, path.basename(repo)), 'kiosk/k2']);
    writeState(k2, k2State);
    const r = json(['archive', 'kiosk']);
    it('archive of the archived epic: the live task archived, ok', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(r.doc.result.changed, true);
      assert.deepStrictEqual(r.doc.result.tasks.map((x) => [x.task, x.changed]), [['k2', true]]);
    });
    it('the task archived by the epic, the cascade with it, no worktree left', () => {
      assert.strictEqual(readState(k2).archive.byEpic, true);
      assert.deepStrictEqual(readState(ep).archive.cascade, ['k1', 'k2']);
      assert.strictEqual(worktreeCount(repo), 1);
    });
    void k1;
  }

  console.log('\nwsg remove: a symlink where the worktree goes');
  {
    const repo = makeRepo();
    const ws = task('linkwt', [[repo, ['--branch', 'feat/linkwt']]]);
    const wt = path.join(ws, path.basename(repo));
    const elsewhere = path.join(tmp, 'elsewhere-linkwt');
    fs.renameSync(wt, elsewhere);
    git(repo, ['worktree', 'repair', elsewhere]);
    fs.symlinkSync(elsewhere, wt);
    const before = tree(elsewhere);
    const rm = wsg(['remove', path.basename(repo), '--ws', ws]);
    it('remove refuses it, exit 2, what it points to intact', () => {
      assert.strictEqual(rm.code, 2, rm.all);
      assert.match(rm.err, /is a symlink, not the worktree wsg made/);
      assert.deepStrictEqual(tree(elsewhere), before);
      assert.ok(fs.lstatSync(wt).isSymbolicLink());
    });
    const ar = wsg(['archive', 'linkwt']);
    it('archive refuses it too', () => {
      assert.strictEqual(ar.code, 2, ar.all);
      assert.deepStrictEqual(tree(elsewhere), before);
    });
  }

  console.log('\nwsg archive and remove: a big repository');
  {
    // Over 1 MiB of index listing: the listings must not be cut (a cut one reads as Ctrl+C).
    const big = makeRepo();
    for (let d = 0; d < 300; d++) {
      const dir = path.join(big, 'gen', `d${String(d).padStart(3, '0')}`);
      fs.mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 100; f++) fs.writeFileSync(path.join(dir, `file-with-a-longish-name-${f}.txt`), `${d}-${f}\n`);
    }
    git(big, ['add', '-A']);
    git(big, ['commit', '-qm', 'many files']);
    it('the index lists over 1 MiB', () => assert.ok(execFileSync('git', ['-C', big, 'ls-files', '-s', '-z'], { maxBuffer: 1 << 28 }).length > 1024 * 1024));
    const ws = task('bigrepo', [[big, ['--branch', 'feat/bigrepo']]]);
    const d = json(['archive', 'bigrepo', '--dry-run']);
    it('archive --dry-run of a worktree with 30000 files: a plan, not "Cancelled"', () => {
      assert.strictEqual(d.code, 0, d.all);
      assert.ok(d.doc.result.removes[0].files >= 30000);
    });
    const rmDry = json(['remove', path.basename(big), '--ws', ws, '--dry-run']);
    it('remove --dry-run of it: a plan', () => assert.strictEqual(rmDry.code, 0, rmDry.all));
    const r = json(['archive', 'bigrepo']);
    it('archive of it: done, the branch kept', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.ok(!fs.existsSync(path.join(ws, path.basename(big))));
      assert.ok(git(big, ['rev-parse', 'feat/bigrepo']));
    });
    const ws2 = task('bigrm', [[big, ['--branch', 'feat/bigrm']]]);
    const rm = json(['remove', path.basename(big), '--ws', ws2]);
    it('remove of a worktree with 30000 files: done', () => {
      assert.strictEqual(rm.code, 0, rm.all);
      assert.ok(!fs.existsSync(path.join(ws2, path.basename(big))));
    });
  }

  console.log('\nwsg archive: an amend is no lost commit; an executable bit is an edit');
  {
    const repo = makeRepo();
    const ws = task('amend', [[repo, ['--branch', 'feat/amend']]]);
    const wt = path.join(ws, path.basename(repo));
    fs.writeFileSync(path.join(wt, 'm.ts'), 'm\n');
    git(wt, ['add', 'm.ts']);
    git(wt, ['commit', '-qm', 'first']);
    git(wt, ['commit', '-q', '--amend', '-m', 'amended']);
    const d = json(['archive', 'amend', '--dry-run']);
    it('a commit replaced by an amend: no reflog warning', () => {
      assert.strictEqual(d.code, 0, d.all);
      assert.ok(!d.doc.warnings.some((w) => /reflog/.test(w)), JSON.stringify(d.doc.warnings));
    });
    git(wt, ['update-index', '--skip-worktree', 'a.ts']);
    fs.chmodSync(path.join(wt, 'a.ts'), 0o755);
    const x = json(['archive', 'amend', '--dry-run']);
    it('a skip-worktree file made executable: refused, the bit is an edit', () => {
      assert.strictEqual(x.code, 2, x.all);
      assert.deepStrictEqual(x.doc.result.blockers.dirty[0].changes, ['S  a.ts']);
    });
    // git itself ignores the executable bit with core.fileMode false (a FAT or a shared volume).
    git(wt, ['config', 'core.fileMode', 'false']);
    const fm = json(['archive', 'amend', '--dry-run']);
    it('core.fileMode false: the bit alone is no edit, the plan goes', () => {
      assert.strictEqual(fm.code, 0, fm.all);
      assert.deepStrictEqual(fm.doc.result.blockers.dirty, []);
    });
    fs.appendFileSync(path.join(wt, 'a.ts'), 'edited\n');
    const fe = json(['archive', 'amend', '--dry-run']);
    it('core.fileMode false: changed bytes are still an edit', () => {
      assert.strictEqual(fe.code, 2, fe.all);
      assert.deepStrictEqual(fe.doc.result.blockers.dirty[0].changes, ['S  a.ts']);
    });
  }

  console.log('\nwsg archive: the kept rule names the branch the work is on');
  {
    const repo = makeRepo();
    const ws = task('rulebr', [[repo, ['--branch', 'feat/rule-a']]]);
    const rule = path.join(ws, '.claude', 'rules', `${path.basename(repo)}.md`);
    git(path.join(ws, path.basename(repo)), ['switch', '-q', '-c', 'feat/rule-b']);
    assert.strictEqual(wsg(['archive', 'rulebr']).code, 0);
    it('wsg\'s own rule text: rewritten with the branch checked out', () => {
      assert.match(read(rule), /Task branch: `feat\/rule-b`/);
      assert.doesNotMatch(read(rule), /feat\/rule-a/);
    });
    const repo2 = makeRepo();
    const ws2 = task('rulebr2', [[repo2, ['--branch', 'feat/rule-c']]]);
    const rule2 = path.join(ws2, '.claude', 'rules', `${path.basename(repo2)}.md`);
    fs.appendFileSync(rule2, '\nThe owner\'s line.\n');
    const edited = read(rule2);
    git(path.join(ws2, path.basename(repo2)), ['switch', '-q', '-c', 'feat/rule-d']);
    assert.strictEqual(wsg(['archive', 'rulebr2']).code, 0);
    it('an edited rule stays byte for byte; the archive block names the real branch', () => {
      assert.strictEqual(read(rule2), edited);
      assert.match(read(ws2, 'AGENTS.md'), /on `feat\/rule-d`/);
    });
  }

  console.log('\nwsg add into a task of an archived epic');
  {
    const repo = makeRepo();
    const ep = task('depot', [], ['--kind', 'epic']);
    const d1 = task('d1', [], ['--epic', 'depot']);
    const d2 = task('d2', [], ['--epic', 'depot']);
    assert.strictEqual(wsg(['archive', 'depot']).code, 0);
    // d2 live again by hand (an older wsg): its epic is archived all the same.
    const st = readState(d2);
    const { archive: _a, ...live } = st;
    writeState(d2, { ...live, version: 2, status: 'open' });
    const before = tree(d2);
    const a = wsg(['add', repo, '--ws', d2, '--branch', 'feat/d2']);
    it('refused, exit 2, names the epic, nothing changed', () => {
      assert.strictEqual(a.code, 2, a.all);
      assert.match(a.err, /the epic depot of this task is archived/);
      assert.deepStrictEqual(tree(d2), before);
    });
    void ep; void d1;
  }

  console.log('\nwsg archive: Ctrl+C while the plan asks git');
  {
    const repo = makeRepo();
    task('stopplan', [[repo, ['--branch', 'feat/stopplan']]]);
    const fake = path.join(tmp, 'int-git-plan');
    fs.mkdirSync(fake);
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(fake, 'git'), `#!/bin/sh\ncase " $* " in *" --ignored "*) kill -INT $$; sleep 2;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
    const env = { PATH: `${fake}:${ENV.PATH}` };
    const plain = wsg(['archive', 'stopplan'], { env });
    it('plain: exit 130, "Cancelled, nothing changed."', () => {
      assert.strictEqual(plain.code, 130, plain.all);
      assert.match(plain.err, /Cancelled, nothing changed\./);
      assert.doesNotMatch(plain.err, /nothing created/);
    });
    const j = json(['archive', 'stopplan', '--dry-run'], { env });
    it('--json: interrupted, rollback none, the same words', () => {
      assert.strictEqual(j.code, 130, j.all);
      assert.strictEqual(j.doc.error.code, 'interrupted');
      assert.strictEqual(j.doc.error.rollback, 'none');
      assert.strictEqual(j.doc.error.message, 'Cancelled, nothing changed.');
    });
  }

  const UNRESULT_KEYS = ['workspace', 'kind', 'slug', 'epic', 'status', 'closed', 'archived', 'changed', 'restores', 'tasks', 'tasksMdUpdated'];
  // The rendered files a round trip must give back byte for byte.
  const rendered = (ws) => Object.fromEntries(['AGENTS.md', 'CLAUDE.md', 'README.md', path.join('.claude', 'settings.json'), 'mr-target-branch.txt']
    .filter((f) => fs.existsSync(path.join(ws, f))).map((f) => [f, read(ws, f)]));
  // The state's sources without how the branch started: unarchive attaches an existing branch as it is.
  const sourcesOf = (st) => st.sources.map(({ start: _s, ...rest }) => rest);

  console.log('\nwsg unarchive: a task back as it was');
  {
    const api = makeRepo();
    const docs = path.join(tmp, 'docs-back');
    fs.mkdirSync(docs);
    fs.writeFileSync(path.join(docs, 'brief.md'), 'brief\n');
    const ws = task('back', [[api, ['--branch', 'feat/back']], [docs, ['--reference']]]);
    const wt = path.join(ws, path.basename(api));
    fs.writeFileSync(path.join(wt, 'c.ts'), 'c\n');
    git(wt, ['add', 'c.ts']);
    git(wt, ['commit', '-qm', 'work']);
    assert.strictEqual(wsg(['status', 'back', 'review']).code, 0);
    fs.appendFileSync(path.join(ws, '.claude', 'rules', `${path.basename(api)}.md`), '\nThe owner\'s line.\n');
    fs.writeFileSync(path.join(ws, '.claude-memory', 'MEMORY.md'), '- remembered\n');
    const before = { rendered: rendered(ws), state: readState(ws), refs: refs(api), kept: kept(ws), tip: git(wt, ['rev-parse', 'HEAD']) };
    assert.strictEqual(wsg(['archive', 'back']).code, 0);
    const dry = json(['unarchive', 'back', '--dry-run']);
    it('--dry-run --json: the plan, every key, nothing changed, no lock', () => {
      assert.strictEqual(dry.code, 0, dry.all);
      assert.deepStrictEqual(Object.keys(dry.doc.result), UNRESULT_KEYS);
      assert.strictEqual(dry.doc.result.status, 'review');
      assert.strictEqual(dry.doc.result.changed, true);
      assert.deepStrictEqual(dry.doc.result.restores.map((r) => [r.name, r.mode, r.branch]), [[path.basename(api), 'worktree', 'feat/back'], ['docs-back', 'reference', null]]);
      assert.strictEqual(readState(ws).status, 'archived');
      assert.ok(!fs.existsSync(path.join(ws, '.claude', 'wsg.lock')));
    });
    const r = json(['unarchive', 'back']);
    it('unarchive --json: ok, status review, changed', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.deepStrictEqual(Object.keys(r.doc.result), UNRESULT_KEYS);
      assert.strictEqual(r.doc.result.status, 'review');
      assert.strictEqual(r.doc.result.changed, true);
    });
    it('the worktree is back on the same branch, at the same commit, clean', () => {
      assert.strictEqual(git(wt, ['branch', '--show-current']), 'feat/back');
      assert.strictEqual(git(wt, ['rev-parse', 'HEAD']), before.tip);
      assert.strictEqual(git(wt, ['status', '--porcelain']), '');
      assert.strictEqual(refs(api), before.refs);
    });
    it('the reference link is back', () => assert.strictEqual(fs.readlinkSync(path.join(ws, 'docs-back')), docs));
    it('the state: the status it had, no record, the sources as they were', () => {
      const st = readState(ws);
      assert.strictEqual(st.status, 'review');
      assert.strictEqual(st.archive, undefined);
      assert.deepStrictEqual(sourcesOf(st), sourcesOf(before.state));
      assert.strictEqual(st.sources[0].start, 'attach');
    });
    it('AGENTS.md, CLAUDE.md, README.md, settings.json and mr-target-branch.txt byte-identical to before the archive', () => assert.deepStrictEqual(rendered(ws), before.rendered));
    it('the kept rule adopted as it was, memory and notes byte-identical', () => assert.deepStrictEqual(kept(ws), before.kept));
    const snap = tree(ws, { into: false });
    const again = json(['unarchive', 'back']);
    it('unarchive again: exit 0, changed false, nothing written', () => {
      assert.strictEqual(again.code, 0, again.all);
      assert.strictEqual(again.doc.result.changed, false);
      assert.deepStrictEqual(tree(ws, { into: false }), snap);
    });
    it('the plain unarchive of a workspace not archived says so', () => assert.match(wsg(['unarchive', 'back']).out, /is not archived: nothing to do/));
    // done, archived, unarchived: done again with its date.
    assert.strictEqual(wsg(['close', 'back']).code, 0);
    const closed = readState(ws).closed;
    assert.strictEqual(wsg(['archive', 'back']).code, 0);
    assert.strictEqual(wsg(['unarchive', 'back']).code, 0);
    it('a done task comes back done, with the date it was closed', () => {
      assert.strictEqual(readState(ws).status, 'done');
      assert.strictEqual(readState(ws).closed, closed);
    });
  }

  console.log('\nwsg unarchive: what refuses it, with nothing touched');
  {
    const make = (slug) => {
      const repo = makeRepo();
      const ws = task(slug, [[repo, ['--branch', `feat/${slug}`]]]);
      assert.strictEqual(wsg(['archive', slug]).code, 0);
      return { repo, ws };
    };
    const cases = [
      ['the branch is gone', (x) => git(x.repo, ['branch', '-D', `feat/${x.slug}`]), /branch feat\/\S+ is gone/],
      ['the branch is checked out in another worktree', (x) => git(x.repo, ['worktree', 'add', '-q', path.join(tmp, `other-${x.slug}`), `feat/${x.slug}`]), /checked out in another worktree/],
      ['the checkout is gone', (x) => fs.renameSync(x.repo, `${x.repo}-moved`), /is not there any more/],
      ['the name is taken in the workspace', (x) => fs.mkdirSync(path.join(x.ws, path.basename(x.repo))), /is taken in the workspace/],
    ];
    for (const [what, spoil, re] of cases) {
      const slug = `un-${repoN + 1}`;
      const x = { ...make(slug), slug };
      spoil(x);
      const before = tree(x.ws);
      const r = json(['unarchive', slug]);
      it(`${what}: refused, exit 2, invalid_input, nothing changed`, () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.strictEqual(r.doc.error.code, 'invalid_input');
        assert.match(r.doc.error.message, re);
        assert.deepStrictEqual(Object.keys(r.doc.result), UNRESULT_KEYS);
        assert.deepStrictEqual(tree(x.ws), before);
        assert.strictEqual(readState(x.ws).status, 'archived');
      });
    }
    // An owner's rule kept by the archive does not block it.
    const x = make('ownrule');
    const rule = path.join(x.ws, '.claude', 'rules', `${path.basename(x.repo)}.md`);
    fs.writeFileSync(rule, '# my own notes on this repo\n');
    const r = wsg(['unarchive', 'ownrule']);
    it('a rule file of the owner\'s, kept by the archive: adopted as it is, not refused', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(fs.readFileSync(rule, 'utf8'), '# my own notes on this repo\n');
    });
    // A busy workspace.
    const y = make('unbusy');
    fs.writeFileSync(path.join(y.ws, '.claude', 'wsg.lock'), JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
    const b = tree(y.ws);
    const busy = json(['unarchive', 'unbusy']);
    it('a workspace another command holds: exit 2, busy, nothing changed', () => {
      assert.strictEqual(busy.code, 2, busy.all);
      assert.strictEqual(busy.doc.error.code, 'busy');
      assert.deepStrictEqual(tree(y.ws), b);
    });
    it('the advisor guard: unarchive only with --dry-run', () => {
      const G = require(path.join(ROOT, 'lib', 'advisor-guard.js'));
      assert.strictEqual(G.bashAllowed(`node "${CLI}" unarchive shop/cart --dry-run`), true);
      assert.strictEqual(G.bashAllowed(`node "${CLI}" unarchive shop/cart`), false);
    });
  }

  console.log('\nwsg unarchive: an epic brings back only the tasks its archive took');
  {
    const repo = makeRepo();
    const ep = task('arcade', [], ['--kind', 'epic', '--title', 'Arcade']);
    assert.strictEqual(wsg(['add', repo, '--ws', ep, '--branch-template', 'arcade/{slug}']).code, 0);
    const a1 = task('a1', [], ['--epic', 'arcade']);
    const a2 = task('a2', [], ['--epic', 'arcade']);
    const a3 = task('a3', [], ['--epic', 'arcade']);
    assert.strictEqual(wsg(['status', 'arcade/a2', 'review']).code, 0);
    assert.strictEqual(wsg(['archive', 'arcade/a3']).code, 0);
    const before = { ep: rendered(ep), a1: rendered(a1), a2: rendered(a2), tasks: read(ep, 'tasks.md'), refs: refs(repo) };
    const keptAll = () => ({ ep: kept(ep), a1: kept(a1), a2: kept(a2), a3: kept(a3) });
    const k0 = keptAll();
    assert.strictEqual(wsg(['archive', 'arcade']).code, 0);
    assert.deepStrictEqual(readState(ep).archive.cascade, ['a1', 'a2']);
    // A task of the cascade whose unarchive fails half-way: README.md that can't be written.
    fs.chmodSync(path.join(a2, 'README.md'), 0o444);
    const half = json(['unarchive', 'arcade']);
    fs.chmodSync(path.join(a2, 'README.md'), 0o644);
    it('a task that fails: step_failed naming it, the tasks before it kept unarchived', () => {
      assert.strictEqual(half.code, 1, half.all);
      assert.match(half.doc.error.message, /task a2 could not be unarchived/);
      assert.match(half.doc.error.message, /a1/);
      assert.deepStrictEqual(half.doc.result.done, ['a1']);
      assert.strictEqual(half.doc.result.failedTask, 'a2');
      assert.strictEqual(readState(a1).status, 'open');
      assert.strictEqual(readState(a2).status, 'archived');
      assert.ok(readState(ep).archive, 'the epic keeps its record until the last task is back');
      assert.ok(!fs.existsSync(path.join(a2, path.basename(repo))));
    });
    const r = json(['unarchive', 'arcade']);
    it('run again: the rest back, ok', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.deepStrictEqual(r.doc.result.tasks.map((x) => [x.task, x.status]), [['a2', 'review']]);
      assert.strictEqual(r.doc.result.status, null);
    });
    it('the cascade back: a1 open, a2 review, each on its worktree; a3, archived on its own, stays archived', () => {
      assert.strictEqual(readState(a1).status, 'open');
      assert.strictEqual(readState(a2).status, 'review');
      assert.strictEqual(git(path.join(a1, path.basename(repo)), ['branch', '--show-current']), 'arcade/a1');
      assert.strictEqual(git(path.join(a2, path.basename(repo)), ['branch', '--show-current']), 'arcade/a2');
      assert.strictEqual(readState(a3).status, 'archived');
    });
    it('the epic: no record, its link back, the branches the same', () => {
      assert.strictEqual(readState(ep).archive, undefined);
      assert.strictEqual(fs.readlinkSync(path.join(ep, path.basename(repo))), repo);
      assert.strictEqual(refs(repo), before.refs);
    });
    it('the generated files of the epic and of the tasks byte-identical to before; tasks.md too', () => {
      assert.deepStrictEqual(rendered(ep), before.ep);
      assert.deepStrictEqual(rendered(a1), before.a1);
      assert.deepStrictEqual(rendered(a2), before.a2);
      assert.strictEqual(read(ep, 'tasks.md'), before.tasks);
    });
    it('knowledge, notes, memory, rules byte-identical through the round trip', () => assert.deepStrictEqual(keptAll(), k0));
  }


  console.log('\nwsg unarchive: the branch the work was on');
  {
    const repo = makeRepo();
    const ws = task('umoved', [[repo, ['--branch', 'feat/umoved']]]);
    const wt = path.join(ws, path.basename(repo));
    git(wt, ['switch', '-q', '-c', 'feat/umoved-2']);
    fs.writeFileSync(path.join(wt, 'w.ts'), 'w\n');
    git(wt, ['add', 'w.ts']);
    git(wt, ['commit', '-qm', 'work']);
    const tip = git(wt, ['rev-parse', 'HEAD']);
    git(repo, ['branch', '-D', 'feat/umoved']);
    assert.strictEqual(wsg(['archive', 'umoved']).code, 0);
    const r = json(['unarchive', 'umoved']);
    it('the attached branch deleted, work on another: back on the one checked out at the archive', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(git(wt, ['branch', '--show-current']), 'feat/umoved-2');
      assert.strictEqual(git(wt, ['rev-parse', 'HEAD']), tip);
      assert.strictEqual(readState(ws).sources[0].branch, 'feat/umoved-2');
      assert.strictEqual(readState(ws).version, 2);
    });
    const repo2 = makeRepo();
    const ws2 = task('umoved2', [[repo2, ['--branch', 'feat/one']]]);
    const wt2 = path.join(ws2, path.basename(repo2));
    git(wt2, ['switch', '-q', '-c', 'feat/two']);
    const before = refs(repo2);
    assert.strictEqual(wsg(['archive', 'umoved2']).code, 0);
    const r2 = json(['unarchive', 'umoved2']);
    it('the attached branch there, work on another: back on the other, both branches as they were', () => {
      assert.strictEqual(r2.code, 0, r2.all);
      assert.strictEqual(git(wt2, ['branch', '--show-current']), 'feat/two');
      assert.strictEqual(refs(repo2), before);
    });
  }

  console.log('\nwsg unarchive: a record that is off, a run that stopped');
  {
    // A record whose status was edited by hand: a warning, and unarchive still works.
    const repo = makeRepo();
    const ws = task('edited', [[repo, ['--branch', 'feat/edited']]]);
    assert.strictEqual(wsg(['archive', 'edited']).code, 0);
    const st = readState(ws);
    writeState(ws, { ...st, status: 'open' });
    const r = json(['unarchive', 'edited']);
    it('status edited away from archived: unarchive brings it back all the same', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(readState(ws).status, 'open');
      assert.strictEqual(readState(ws).archive, undefined);
      assert.ok(fs.existsSync(path.join(ws, path.basename(repo), 'a.ts')));
    });
  }
  {
    // A kill between two attaches: the record is still there; a run again attaches the rest.
    const one = makeRepo();
    const two = makeRepo();
    const ws = task('ukill', [[one, ['--branch', 'feat/ukill']], [two, ['--branch', 'feat/ukill2']]]);
    const before = rendered(ws);
    assert.strictEqual(wsg(['archive', 'ukill']).code, 0);
    const plan = await quiet(() => A.planUnarchive(ws, W.readState(ws)));
    const realAttach = generate.attachSource;
    let calls = 0;
    let seen = null;
    generate.attachSource = (...args) => {
      if (++calls === 2) {
        seen = read(ws, '.claude', 'wsg.json');
        throw new Error('killed');
      }
      return realAttach(...args);
    };
    try {
      await quiet(async () => { try { await A.applyUnarchive(plan, {}); } catch { /* rolled back */ } });
    } finally {
      generate.attachSource = realAttach;
    }
    const mid = JSON.parse(seen);
    it('after the first attach the state still holds the record, both sources in it', () => {
      assert.deepStrictEqual(mid.archive.sources.map((s) => s.name), [path.basename(one), path.basename(two)]);
      assert.deepStrictEqual(mid.sources.map((s) => s.name), [path.basename(one)]);
      assert.strictEqual(W.stateProblem(mid), '');
    });
    // What a kill would have left: that state, the first worktree attached.
    git(one, ['worktree', 'add', '-q', path.join(ws, path.basename(one)), 'feat/ukill']);
    writeState(ws, mid);
    const again = json(['unarchive', 'ukill']);
    it('wsg unarchive again: the second attached, the first left as it is, the record gone', () => {
      assert.strictEqual(again.code, 0, again.all);
      const st = readState(ws);
      assert.strictEqual(st.archive, undefined);
      assert.deepStrictEqual(st.sources.map((s) => s.name), [path.basename(one), path.basename(two)]);
      assert.strictEqual(git(path.join(ws, path.basename(two)), ['branch', '--show-current']), 'feat/ukill2');
      assert.deepStrictEqual(rendered(ws), before);
    });
  }

  console.log('\nwsg unarchive: a task of an archived epic');
  {
    const repo = makeRepo();
    const ep = task('bazaar', [], ['--kind', 'epic']);
    assert.strictEqual(wsg(['add', repo, '--ws', ep, '--branch-template', 'bazaar/{slug}']).code, 0);
    const b1 = task('b1', [], ['--epic', 'bazaar']);
    assert.strictEqual(wsg(['archive', 'bazaar']).code, 0);
    const before = tree(b1);
    const r = json(['unarchive', 'bazaar/b1']);
    it('alone: refused, exit 2, names the epic, nothing changed', () => {
      assert.strictEqual(r.code, 2, r.all);
      assert.match(r.doc.error.message, /its epic bazaar is archived: .*wsg unarchive bazaar/);
      assert.deepStrictEqual(tree(b1), before);
    });
    const e = json(['unarchive', 'bazaar']);
    it('with its epic: back', () => {
      assert.strictEqual(e.code, 0, e.all);
      assert.strictEqual(readState(b1).status, 'open');
    });
  }

  console.log('\nwsg unarchive: what a killed run left');
  {
    // Listed as attached, but gone from the workspace.
    const one = makeRepo();
    const two = makeRepo();
    const ws = task('ugone', [[one, ['--branch', 'feat/ugone']], [two, ['--branch', 'feat/ugone2']]]);
    const before = rendered(ws);
    assert.strictEqual(wsg(['archive', 'ugone']).code, 0);
    const st = readState(ws);
    writeState(ws, { ...st, sources: [st.archive.sources[0]] });
    const r = json(['unarchive', 'ugone']);
    it('a source listed but gone: attached again, with a warning', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.ok(r.doc.warnings.some((w) => /listed as attached, but not in the workspace/.test(w)), JSON.stringify(r.doc.warnings));
      assert.strictEqual(git(path.join(ws, path.basename(one)), ['branch', '--show-current']), 'feat/ugone');
      assert.strictEqual(git(path.join(ws, path.basename(two)), ['branch', '--show-current']), 'feat/ugone2');
      assert.deepStrictEqual(readState(ws).sources.map((s) => s.name), [path.basename(one), path.basename(two)]);
      assert.deepStrictEqual(rendered(ws), before);
    });
    // There, but not listed: a kill right after git worktree add.
    const repo = makeRepo();
    const ws2 = task('uadopt', [[repo, ['--branch', 'feat/uadopt']]]);
    const before2 = rendered(ws2);
    assert.strictEqual(wsg(['archive', 'uadopt']).code, 0);
    git(repo, ['worktree', 'add', '-q', path.join(ws2, path.basename(repo)), 'feat/uadopt']);
    fs.writeFileSync(path.join(ws2, path.basename(repo), 'scratch.txt'), 'kept\n');
    const r2 = json(['unarchive', 'uadopt']);
    it('a worktree there on the recorded branch, not listed: adopted as it is, not refused', () => {
      assert.strictEqual(r2.code, 0, r2.all);
      assert.strictEqual(read(ws2, path.basename(repo), 'scratch.txt'), 'kept\n');
      assert.deepStrictEqual(readState(ws2).sources.map((s) => s.name), [path.basename(repo)]);
      assert.strictEqual(readState(ws2).archive, undefined);
      assert.deepStrictEqual(rendered(ws2), before2);
    });
    // There, but on another branch: not adopted, refused as taken.
    const repo3 = makeRepo();
    const ws3 = task('unot', [[repo3, ['--branch', 'feat/unot']]]);
    assert.strictEqual(wsg(['archive', 'unot']).code, 0);
    git(repo3, ['worktree', 'add', '-q', '-b', 'feat/other', path.join(ws3, path.basename(repo3))]);
    const r3 = json(['unarchive', 'unot']);
    it('a worktree there on another branch: refused as taken', () => {
      assert.strictEqual(r3.code, 2, r3.all);
      assert.match(r3.doc.error.message, /is taken in the workspace/);
    });
  }

  console.log('\nwsg unarchive: Ctrl+C while the plan asks git');
  {
    const repo = makeRepo();
    task('ustop', [[repo, ['--branch', 'feat/ustop']]]);
    assert.strictEqual(wsg(['archive', 'ustop']).code, 0);
    const fake = path.join(tmp, 'int-git-unplan');
    fs.mkdirSync(fake);
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(fake, 'git'), `#!/bin/sh\ncase " $* " in *" show-ref "*) kill -INT $$; sleep 2;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
    const plain = wsg(['unarchive', 'ustop'], { env: { PATH: `${fake}:${ENV.PATH}` } });
    it('exit 130, "Cancelled, nothing changed.", still archived', () => {
      assert.strictEqual(plain.code, 130, plain.all);
      assert.match(plain.err, /Cancelled, nothing changed\./);
      assert.strictEqual(readState(path.join(wsRoot, 'ustop')).status, 'archived');
    });
  }

  finished = true;
  console.log(failed === 0 ? `\n${passed} checks passed, ${skipped} blocks skipped\n` : `\nfailed: ${failed}, ${passed} passed, ${skipped} blocks skipped\n`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  console.log(`\nFAIL  ${e.stack || e}`);
  process.exitCode = 1;
});
