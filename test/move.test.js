'use strict';

// wsg move: a task into an epic, between epics and out of one. Every command runs in a child process
// with its own HOME, WS_ROOT, config and CLAUDE_CONFIG_DIR; the repositories are real temporary git
// repositories, the worktrees real ones. Nothing here needs the network or a real agent.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

process.env.WSG_LANG = 'en';

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const W = require(path.join(ROOT, 'lib', 'workspace.js'));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-move-')));
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
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
  return dir;
}

// Every path under a directory with its type and bytes, worktrees included: "nothing touched".
function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d).sort()) {
      const p = path.join(d, e);
      const rel = path.relative(dir, p);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) {
        out[rel] = 'dir';
        walk(p);
      } else out[rel] = fs.readFileSync(p, 'base64');
    }
  };
  walk(dir);
  return out;
}
const readState = (ws) => JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'wsg.json'), 'utf8'));
const writeState = (ws, st) => fs.writeFileSync(path.join(ws, '.claude', 'wsg.json'), `${JSON.stringify(st, null, 2)}\n`);
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const checkItems = (c) => ((c.doc && c.doc.result && c.doc.result.sections) || []).flatMap((x) => x.items);
const settings = (ws) => JSON.parse(read(ws, '.claude', 'settings.json'));
// The worktree's two link files: what a move rewrites, and what another task's worktree keeps.
const links = (wt) => {
  const gitfile = read(wt, '.git');
  const admin = path.resolve(wt, gitfile.replace(/^gitdir: /, '').trim());
  return { gitfile, gitdir: read(admin, 'gitdir'), admin };
};
// A worktree git can use where it is: its own top level, listed by its repository, not prunable.
function usable(wt, repo) {
  assert.strictEqual(fs.realpathSync(git(wt, ['rev-parse', '--show-toplevel'])), fs.realpathSync(wt));
  const list = git(repo, ['worktree', 'list', '--porcelain']).split('\n\n');
  const entry = list.find((b) => b.split('\n')[0] === `worktree ${fs.realpathSync(wt)}`);
  assert.ok(entry, `${wt} not listed:\n${list.join('\n\n')}`);
  assert.doesNotMatch(entry, /^prunable/m);
  git(wt, ['status', '--porcelain']);
}

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

// A workspace made with wsg new, its sources attached with wsg add.
function make(slug, sources = [], extra = [], env = {}) {
  const r = wsg(['new', slug, '--no-launch', ...extra], { env });
  assert.strictEqual(r.code, 0, r.all);
  const root = env.WS_ROOT || wsRoot;
  const ws = extra.includes('--epic') ? path.join(root, extra[extra.indexOf('--epic') + 1], slug) : path.join(root, slug);
  for (const [repo, flags] of sources) {
    const a = wsg(['add', repo, '--ws', ws, ...flags], { env });
    assert.strictEqual(a.code, 0, a.all);
  }
  return ws;
}

(async () => {
  console.log('state model');
  {
    const base = { version: 2, kind: 'task', slug: 'x', title: 'x', status: 'open', personalRules: false, created: '2026-11-01', sources: [] };
    const m = { from: '/r/x', to: '/r/e/x', at: '2026-11-19' };
    it('a task with moved reads', () => assert.strictEqual(W.stateProblem({ ...base, moved: [m] }), ''));
    it('an empty moved list reads', () => assert.strictEqual(W.stateProblem({ ...base, moved: [] }), ''));
    for (const [what, st, re] of [
      ['moved on an epic', { version: 3, kind: 'epic', slug: 'e', title: 'e', created: '2026-11-01', sources: [], moved: [m] }, /"moved" belongs only to a task/],
      ['moved not a list', { ...base, moved: m }, /"moved" must be a list/],
      ['a relative path', { ...base, moved: [{ ...m, from: 'x' }] }, /"moved" must be a list/],
      ['a bad date', { ...base, moved: [{ ...m, at: '2026-02-30' }] }, /"moved" must be a list/],
      ['an unknown key', { ...base, moved: [{ ...m, why: 'x' }] }, /"moved" must be a list/],
    ]) it(`refused: ${what}`, () => assert.match(W.stateProblem(st), re));
  }

  console.log('\nflags');
  {
    make('flagged');
    for (const [args, re] of [
      [['move', 'flagged'], /say where the task goes/],
      [['move', 'flagged', '--epic', 'x', '--out'], /--epic and --out together/],
      [['move', 'flagged', '--out', '--title', 'T'], /--title is the title of a new epic/],
      [['move', 'flagged', '--epic', 'nowhere'], /nowhere/],
    ]) {
      const r = wsg(args);
      it(`${args.slice(2).join(' ')}: exit 2`, () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.match(r.err, re);
      });
    }
  }

  console.log('\na standalone task with a worktree into an epic');
  {
    const repo = makeRepo('shop-api');
    const ep = make('shop', [[repo, ['--branch-template', 'shop/{slug}']]], ['--kind', 'epic', '--title', 'Shop']);
    const ws = make('cart', [[repo, ['--branch', 'feat/cart']]]);
    fs.writeFileSync(path.join(ws, 'notes.md'), `${read(ws, 'notes.md')}\nmy note\n`);
    fs.writeFileSync(path.join(ws, '.claude-memory', 'MEMORY.md'), 'remembered\n');
    fs.writeFileSync(path.join(ws, 'shop-api', 'wip.ts'), 'dirty\n');
    const keep = { notes: read(ws, 'notes.md'), memory: read(ws, '.claude-memory', 'MEMORY.md'), learnings: read(ws, '.learnings', 'LEARNINGS.md') };
    const before = tree(tmp);
    const dry = json(['move', 'cart', '--epic', 'shop', '--dry-run']);
    const dest = path.join(ep, 'cart');
    it('--dry-run --json: the plan, nothing touched', () => {
      assert.strictEqual(dry.code, 0, dry.all);
      const r = dry.doc.result;
      assert.strictEqual(dry.doc.dryRun, true);
      assert.deepStrictEqual(r.from, { epic: null, path: ws });
      assert.deepStrictEqual(r.to, { epic: 'shop', path: dest });
      assert.strictEqual(r.changed, true);
      assert.strictEqual(r.newEpic, false);
      assert.deepStrictEqual(r.paths, [{ from: ws, to: dest }, { from: path.join(ws, 'shop-api'), to: path.join(dest, 'shop-api') }]);
      assert.deepStrictEqual(r.blockers, { worktrees: [] });
      assert.ok(r.regenerates.includes(path.join(dest, 'AGENTS.md')) && r.regenerates.includes(path.join(ep, 'tasks.md')), r.regenerates.join('\n'));
      assert.deepStrictEqual(r.tasksMdUpdated, { from: false, to: true });
      assert.deepStrictEqual(r.relinked, ['shop-api']);
      assert.strictEqual(r.notesForEpic, true);
      assert.deepStrictEqual(Object.keys(r), ['workspace', 'kind', 'slug', 'status', 'from', 'to', 'changed', 'newEpic', 'paths', 'blockers', 'regenerates', 'relinked', 'dropped', 'ticketDropped', 'notesForEpic', 'tasksMdUpdated']);
      assert.deepStrictEqual(tree(tmp), before);
    });
    const r = json(['move', 'cart', '--epic', 'shop']);
    it('exit 0, changed, the result names both places', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(r.doc.result.changed, true);
      assert.strictEqual(r.doc.result.to.path, dest);
      assert.match(r.doc.warnings.join('\n'), /claude --continue/);
    });
    it('the directory moved whole: notes, memory, learnings byte for byte, the old place gone', () => {
      assert.ok(!fs.existsSync(ws));
      const T = require(path.join(ROOT, 'lib', 'templates.js'));
      assert.strictEqual(read(dest, 'notes.md'), keep.notes.replace('## Notes\n', `${T.forEpicLines().join('\n')}\n## Notes\n`));
      assert.strictEqual(read(dest, '.claude-memory', 'MEMORY.md'), keep.memory);
      assert.strictEqual(read(dest, '.learnings', 'LEARNINGS.md'), keep.learnings);
      assert.strictEqual(read(dest, 'shop-api', 'wip.ts'), 'dirty\n');
    });
    it('the worktree is usable there, on its branch, its change kept', () => {
      usable(path.join(dest, 'shop-api'), repo);
      assert.strictEqual(git(path.join(dest, 'shop-api'), ['branch', '--show-current']), 'feat/cart');
      assert.match(git(path.join(dest, 'shop-api'), ['status', '--porcelain']), /wip\.ts/);
    });
    it('the state: the epic, the move recorded, the source taken from the epic as a task made there has it', () => {
      const st = readState(dest);
      assert.deepStrictEqual(st.epic, { slug: 'shop' });
      assert.deepStrictEqual(st.moved.map((x) => [x.from, x.to]), [[ws, dest]]);
      assert.ok(W.isDate(st.moved[0].at));
      assert.strictEqual(st.sources[0].from, 'epic');
      assert.match(read(dest, '.claude', 'rules', 'shop-api.md'), /Taken from the epic/);
      assert.strictEqual(W.stateProblem(st), '');
    });
    it('list --json: the move in the task\'s entry', () => {
      const l = json(['list']);
      const e = l.doc.result.workspaces.find((w) => w.slug === 'shop').tasks.find((x) => x.slug === 'cart');
      assert.deepStrictEqual(e.moved.map((x) => [x.from, x.to]), [[ws, dest]]);
      assert.deepStrictEqual(l.doc.result.workspaces.find((w) => w.slug === 'shop').moved, []);
    });
    it('settings: autoMemoryDirectory follows the task', () => assert.strictEqual(settings(dest).autoMemoryDirectory, path.join(dest, '.claude-memory')));
    it('README: the wsg check line and the kind line name the new place', () => {
      assert.match(read(dest, 'README.md'), new RegExp(`^wsg check ${dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
      assert.match(read(dest, 'README.md'), /^Workspace kind: \*\*task\*\* \(epic `shop`\)\.$/m);
    });
    it('AGENTS.md has the epic blocks', () => {
      const a = read(dest, 'AGENTS.md');
      for (const b of ['epic', 'epic-rules', 'epic-context']) assert.match(a, new RegExp(`^<!-- wsg:${b} -->$`, 'm'));
    });
    it('the epic\'s tasks.md lists it', () => assert.match(read(ep, 'tasks.md'), /^- `cart\/`$/m));
    it('no lock left behind, here or there', () => {
      assert.ok(!fs.existsSync(path.join(dest, '.claude', 'wsg.lock')));
      assert.ok(!fs.existsSync(path.join(ep, '.claude', 'wsg.lock')));
    });
    const c = json(['check', dest]);
    it('wsg check: no errors, autoMemoryDirectory is this task\'s, nothing stale', () => {
      assert.ok(c.doc, c.all);
      const items = checkItems(c);
      assert.deepStrictEqual(items.filter((x) => x.level === 'fail').map((x) => x.text), []);
      assert.ok(items.some((x) => x.level === 'ok' && /autoMemoryDirectory is set/.test(x.text)), JSON.stringify(items));
      assert.ok(!items.some((x) => /stale|wsg refresh/.test(x.text) && x.level !== 'ok'), JSON.stringify(items.filter((x) => x.level !== 'ok')));
    });
    const again = json(['move', 'shop/cart', '--epic', 'shop']);
    it('a run again: exit 0, changed false, nothing touched', () => {
      assert.strictEqual(again.code, 0, again.all);
      assert.strictEqual(again.doc.result.changed, false);
    });
  }

  console.log('\nrenders identical to a task made there');
  {
    // Two epics alike but for the name: a task moved into one renders as one made in the other.
    make('alpha', [], ['--kind', 'epic', '--title', 'Same']);
    make('omega', [], ['--kind', 'epic', '--title', 'Same']);
    const moved = make('lamp');
    const m = wsg(['move', 'lamp', '--epic', 'alpha']);
    const fresh = make('lamp', [], ['--epic', 'omega']);
    const dest = path.join(wsRoot, 'alpha', 'lamp');
    const as = (text) => text.replaceAll('omega', 'alpha');
    it('moved', () => assert.strictEqual(m.code, 0, m.all));
    for (const f of ['AGENTS.md', 'CLAUDE.md', 'README.md', 'notes.md', path.join('.claude', 'settings.json')]) {
      it(`${f} as a fresh task's of the epic`, () => assert.strictEqual(read(dest, f), as(read(fresh, f))));
    }
    it('the moved one\'s old directory is gone', () => assert.ok(!fs.existsSync(moved)));
    // And out again: as a fresh standalone task, made in a WS_ROOT of its own.
    const root2 = path.join(tmp, 'ws2');
    fs.mkdirSync(root2);
    const out = wsg(['move', 'alpha/lamp', '--out']);
    const alone = make('lamp', [], [], { WS_ROOT: root2 });
    it('out', () => assert.strictEqual(out.code, 0, out.all));
    for (const f of ['AGENTS.md', 'CLAUDE.md', 'README.md', path.join('.claude', 'settings.json')]) {
      it(`out: ${f} as a fresh standalone task's`, () => assert.strictEqual(read(wsRoot, 'lamp', f), read(alone, f).replaceAll(root2, wsRoot)));
    }
  }

  console.log('\nout of an epic: the ticket, the sources it took, the order');
  {
    const repo = makeRepo('mall-api');
    const ep = make('mall', [[repo, ['--branch-template', 'mall/{slug}']]], ['--kind', 'epic']);
    const ws = make('belt', [], ['--epic', 'mall', '--ticket', 'ACME-7']);
    make('shoe', [], ['--epic', 'mall']);
    assert.strictEqual(wsg(['reorder', 'shoe', '--to', '1', '--ws', 'mall']).code, 0);
    const st0 = readState(ws);
    const rule0 = read(ws, '.claude', 'rules', 'mall-api.md');
    it('setup: the task took the epic\'s source, has the ticket key, is in the order', () => {
      assert.strictEqual(st0.sources[0].from, 'epic');
      assert.strictEqual(st0.ticket, 'ACME-7');
      assert.deepStrictEqual(readState(ep).taskOrder, ['shoe', 'belt']);
      assert.match(rule0, /Taken from the epic/);
    });
    const dry = json(['move', 'mall/belt', '--out', '--dry-run']);
    it('--dry-run: dropped names the source, the ticket goes, both tasks.md', () => {
      assert.strictEqual(dry.code, 0, dry.all);
      assert.deepStrictEqual(dry.doc.result.dropped, ['mall-api']);
      assert.deepStrictEqual(dry.doc.result.relinked, []);
      assert.strictEqual(dry.doc.result.ticketDropped, true);
      assert.deepStrictEqual(dry.doc.result.tasksMdUpdated, { from: true, to: false });
      assert.ok(dry.doc.result.regenerates.includes(path.join(ep, '.claude', 'wsg.json')));
    });
    const r = wsg(['move', 'mall/belt', '--out']);
    const dest = path.join(wsRoot, 'belt');
    it('exit 0, says what happened to the source and the ticket', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.match(r.out, /Moved mall\/belt → belt/);
      assert.match(r.out, /no longer taken from an epic: mall-api/);
      assert.match(r.out, /ticket key/);
    });
    const st = readState(dest);
    it('the state: no epic, no ticket, the source its own', () => {
      assert.strictEqual(st.epic, undefined);
      assert.strictEqual(st.ticket, undefined);
      assert.strictEqual(st.sources[0].from, undefined);
      assert.strictEqual(W.stateProblem(st), '');
    });
    it('the rule as wsg writes it for a source of its own', () => {
      const T = require(path.join(ROOT, 'lib', 'templates.js'));
      assert.strictEqual(read(dest, '.claude', 'rules', 'mall-api.md'), T.ruleMd(st.sources[0], { noCode: false }));
      assert.doesNotMatch(read(dest, '.claude', 'rules', 'mall-api.md'), /Taken from the epic/);
    });
    it('AGENTS.md: the epic blocks gone', () => assert.doesNotMatch(read(dest, 'AGENTS.md'), /wsg:epic/));
    it('the worktree usable there, on the epic\'s branch', () => {
      usable(path.join(dest, 'mall-api'), repo);
      assert.strictEqual(git(path.join(dest, 'mall-api'), ['branch', '--show-current']), 'mall/belt');
    });
    it('the epic: out of its order and its tasks.md, the other task stays', () => {
      assert.ok(!readState(ep).taskOrder.includes('belt'));
      assert.doesNotMatch(read(ep, 'tasks.md'), /belt/);
      assert.match(read(ep, 'tasks.md'), /^- `shoe\/`$/m);
    });
    it('wsg check of the epic: no task of another epic, no fail', () => {
      const c = json(['check', ep]);
      assert.deepStrictEqual(checkItems(c).filter((x) => x.level === 'fail').map((x) => x.text), []);
    });
  }

  console.log('\nfrom one epic into another: relinked and dropped sources');
  {
    const api = makeRepo('kiosk-api');
    const web = makeRepo('kiosk-web');
    make('kiosk', [[api, ['--branch-template', 'kiosk/{slug}']], [web, ['--link']]], ['--kind', 'epic']);
    const plaza = make('plaza', [[api, ['--link']]], ['--kind', 'epic']);
    const ws = make('till', [], ['--epic', 'kiosk', '--sources', 'kiosk-api,kiosk-web']);
    const r = json(['move', 'kiosk/till', '--epic', 'plaza']);
    const dest = path.join(plaza, 'till');
    it('exit 0: kiosk-api relinked (plaza has it), kiosk-web dropped', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.deepStrictEqual(r.doc.result.relinked, ['kiosk-api']);
      assert.deepStrictEqual(r.doc.result.dropped, ['kiosk-web']);
      assert.deepStrictEqual(r.doc.result.tasksMdUpdated, { from: true, to: true });
    });
    it('the state: from epic kept for the one, gone for the other; the ticket kept', () => {
      const st = readState(dest);
      assert.deepStrictEqual(st.epic, { slug: 'plaza' });
      assert.strictEqual(st.sources.find((s) => s.name === 'kiosk-api').from, 'epic');
      assert.strictEqual(st.sources.find((s) => s.name === 'kiosk-web').from, undefined);
    });
    it('the worktree is usable, the link points where it did', () => {
      usable(path.join(dest, 'kiosk-api'), api);
      assert.strictEqual(fs.readlinkSync(path.join(dest, 'kiosk-web')), web);
      assert.ok(!fs.existsSync(ws));
    });
    it('the epic blocks name plaza', () => {
      const a = read(dest, 'AGENTS.md');
      assert.match(a, /part of epic `plaza`/);
      assert.doesNotMatch(a, /epic `kiosk`/);
    });
  }

  console.log('\na task without code, links and references');
  {
    const docs = path.join(tmp, 'docs-dir');
    fs.mkdirSync(docs);
    fs.writeFileSync(path.join(docs, 'spec.txt'), 'x\n');
    const repo = makeRepo('depot-api');
    make('depot', [], ['--kind', 'epic']);
    const ws = make('audit', [[repo, ['--link']], [docs, ['--reference']]], ['--no-code']);
    const r = wsg(['move', 'audit', '--epic', 'depot']);
    const dest = path.join(wsRoot, 'depot', 'audit');
    it('moved: the link and the reference point where they did, noCode kept', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(fs.readlinkSync(path.join(dest, 'depot-api')), repo);
      assert.strictEqual(fs.readlinkSync(path.join(dest, 'docs-dir')), docs);
      assert.strictEqual(readState(dest).noCode, true);
      assert.deepStrictEqual(settings(dest).permissions.additionalDirectories, [repo, docs]);
      assert.ok(!fs.existsSync(ws));
    });
  }

  console.log('\nrelative worktrees, and another task\'s worktree of the same repository');
  {
    const repo = makeRepo('arcade-api');
    make('arcade', [], ['--kind', 'epic']);
    const other = make('other', [[repo, ['--branch', 'feat/other']]]);
    git(repo, ['config', 'worktree.useRelativePaths', 'true']);
    const ws = make('prize', [[repo, ['--branch', 'feat/prize']]]);
    const wt = path.join(ws, 'arcade-api');
    const was = links(wt);
    const theirs = links(path.join(other, 'arcade-api'));
    it('setup: git wrote the new worktree relative, the other absolute', () => {
      assert.match(was.gitfile, /^gitdir: \.\.\//);
      assert.ok(!path.isAbsolute(was.gitdir.trim()));
      assert.ok(path.isAbsolute(theirs.gitdir.trim()));
    });
    const r = wsg(['move', 'prize', '--epic', 'arcade']);
    const dest = path.join(wsRoot, 'arcade', 'prize', 'arcade-api');
    const now = r.code === 0 ? links(dest) : null;
    it('moved, still relative both ways, usable', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.match(now.gitfile, /^gitdir: \.\.\//);
      assert.ok(!path.isAbsolute(now.gitdir.trim()));
      assert.strictEqual(path.resolve(now.admin, now.gitdir.trim()), path.join(dest, '.git'));
      usable(dest, repo);
    });
    it('the other task\'s worktree is untouched, byte for byte', () => assert.deepStrictEqual(links(path.join(other, 'arcade-api')), theirs));
    git(repo, ['config', '--unset', 'worktree.useRelativePaths']);
  }

  console.log('\nrefusals: nothing touched');
  {
    const repo = makeRepo('fair-api');
    const ep = make('fair', [[repo, ['--link']]], ['--kind', 'epic']);
    make('stall', [], ['--epic', 'fair']);
    make('proc', [], ['--kind', 'process']);
    const broken = make('broken', [[repo, ['--branch', 'feat/broken']]]);
    // Its repository's side names another place: git would not see it as linked both ways.
    const l = links(path.join(broken, 'fair-api'));
    fs.writeFileSync(path.join(l.admin, 'gitdir'), `${path.join(tmp, 'elsewhere', '.git')}\n`);
    const clash = make('clash', [[makeRepo('fair-api-2'), ['--link']]]);
    fs.renameSync(path.join(clash, 'fair-api-2'), path.join(clash, 'fair-api'));
    const cs = readState(clash);
    cs.sources[0].name = 'fair-api';
    writeState(clash, cs);
    fs.renameSync(path.join(clash, '.claude', 'rules', 'fair-api-2.md'), path.join(clash, '.claude', 'rules', 'fair-api.md'));
    const archivedWs = make('gone');
    writeState(archivedWs, { ...readState(archivedWs), version: 4, status: 'archived', archive: { date: '2026-11-02', previous: { status: 'open', closed: null }, sources: [] } });
    const before = tree(wsRoot);
    for (const [what, args, re] of [
      ['a process', ['move', 'proc', '--epic', 'fair'], /proc is a process: a process stays where it is/],
      ['an epic', ['move', 'fair', '--out'], /fair is an epic: an epic never moves/],
      ['an archived task', ['move', 'gone', '--epic', 'fair'], /archived: wsg unarchive gone first/],
      ['into a task, not an epic', ['move', 'proc', '--epic', 'broken'], /is not an epic|is a process/],
      ['a worktree git does not link both ways', ['move', 'broken', '--epic', 'fair'], /not a worktree of .* that git links both ways — run git -C .* worktree repair .*broken\/fair-api first/],
      ['a source named like one of the epic for another directory', ['move', 'clash', '--epic', 'fair'], /the epic fair has a source of that name for another directory/],
    ]) {
      const r = json(args);
      it(`${what}: exit 2, invalid_input`, () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.strictEqual(r.doc.error.code, 'invalid_input');
        assert.match(r.doc.error.message, re);
      });
    }
    it('a broken worktree is named in blockers', () => {
      const r = json(['move', 'broken', '--epic', 'fair', '--dry-run']);
      assert.deepStrictEqual(r.doc.result.blockers.worktrees.map((b) => b.name), ['fair-api']);
    });
    it('a name one of the epic\'s tasks has: refused', () => {
      const ws = make('stall');
      const r = json(['move', 'stall', '--epic', 'fair']);
      assert.strictEqual(r.code, 2, r.all);
      assert.match(r.doc.error.message, /is taken/);
      fs.rmSync(ws, { recursive: true });
    });
    it('a directory named like a task\'s slug in the epic, whatever the case', () => {
      fs.mkdirSync(path.join(ep, 'Lamp2'));
      make('lamp2');
      const r = json(['move', 'lamp2', '--epic', 'fair']);
      assert.strictEqual(r.code, 2, r.all);
      assert.match(r.doc.error.message, /is taken/);
      fs.rmdirSync(path.join(ep, 'Lamp2'));
      fs.rmSync(path.join(wsRoot, 'lamp2'), { recursive: true });
    });
    it('a slug the epic has a source by: refused', () => {
      const ws = make('fair-api');
      const r = json(['move', 'fair-api', '--epic', 'fair']);
      assert.strictEqual(r.code, 2, r.all);
      assert.match(r.doc.error.message, /fair-api/);
      fs.rmSync(ws, { recursive: true });
    });
    it('nothing touched by any of them', () => assert.deepStrictEqual(tree(wsRoot), before));
  }

  console.log('\nlocks');
  {
    make('booth', [], ['--kind', 'epic']);
    const ws = make('sign');
    fs.writeFileSync(path.join(ws, '.claude', 'wsg.lock'), JSON.stringify({ pid: process.pid, time: 'now' }));
    const r = json(['move', 'sign', '--epic', 'booth']);
    it('the task held by another command: exit 2, busy, nothing moved', () => {
      assert.strictEqual(r.code, 2, r.all);
      assert.strictEqual(r.doc.error.code, 'busy');
      assert.ok(fs.existsSync(ws));
    });
    it('a dry run takes no lock', () => assert.strictEqual(json(['move', 'sign', '--epic', 'booth', '--dry-run']).code, 0));
    fs.rmSync(path.join(ws, '.claude', 'wsg.lock'));
    fs.writeFileSync(path.join(wsRoot, 'booth', '.claude', 'wsg.lock'), JSON.stringify({ pid: process.pid, time: 'now' }));
    const e = json(['move', 'sign', '--epic', 'booth']);
    it('the epic held: exit 2, busy', () => {
      assert.strictEqual(e.code, 2, e.all);
      assert.strictEqual(e.doc.error.code, 'busy');
    });
    fs.rmSync(path.join(wsRoot, 'booth', '.claude', 'wsg.lock'));
  }

  console.log('\nwsg check: a directory moved by hand');
  {
    const ws = make('hand');
    const to = path.join(wsRoot, 'hand2');
    fs.renameSync(ws, to);
    const c = json(['check', to]);
    it('autoMemoryDirectory pointing at the old place is a warning', () => {
      const items = checkItems(c);
      assert.ok(items.some((x) => x.level === 'warn' && /autoMemoryDirectory is .*hand\/\.claude-memory.*not this workspace's/.test(x.text)), JSON.stringify(items));
    });
  }

  console.log('\nworktrees under the task that are not its sources');
  {
    for (const relative of [false, true]) {
      const repo = makeRepo(`nest-${relative ? 'rel' : 'abs'}`);
      if (relative) git(repo, ['config', 'worktree.useRelativePaths', 'true']);
      const ep = make(`nest-ep-${relative ? 'rel' : 'abs'}`, [], ['--kind', 'epic']);
      const ws = make(`nest-${relative ? 'rel' : 'abs'}`, [[repo, ['--branch', `feat/nest-${relative}`]]]);
      const src = path.join(ws, path.basename(repo));
      // A Claude Code --worktree inside the source's worktree, and one made by hand in the task.
      const cc = path.join(src, '.claude', 'worktrees', 'cc');
      git(src, ['worktree', 'add', '-q', '-b', `cc-${relative}`, cc]);
      const extra = path.join(ws, 'extra-wt');
      git(repo, ['worktree', 'add', '-q', '-b', `extra-${relative}`, extra]);
      fs.writeFileSync(path.join(extra, 'wip.txt'), 'kept\n');
      const dry = json(['move', path.basename(ws), '--epic', path.basename(ep), '--dry-run']);
      const dest = path.join(ep, path.basename(ws));
      it(`${relative ? 'relative' : 'absolute'}: the plan names both among the paths`, () => {
        assert.strictEqual(dry.code, 0, dry.all);
        const tos = dry.doc.result.paths.map((x) => x.to);
        assert.ok(tos.includes(path.join(dest, path.basename(repo), '.claude', 'worktrees', 'cc')), tos.join('\n'));
        assert.ok(tos.includes(path.join(dest, 'extra-wt')), tos.join('\n'));
      });
      const r = wsg(['move', path.basename(ws), '--epic', path.basename(ep)]);
      it(`${relative ? 'relative' : 'absolute'}: moved, all three usable, none prunable, a prune keeps them`, () => {
        assert.strictEqual(r.code, 0, r.all);
        git(repo, ['worktree', 'prune']);
        usable(path.join(dest, path.basename(repo)), repo);
        usable(path.join(dest, path.basename(repo), '.claude', 'worktrees', 'cc'), repo);
        usable(path.join(dest, 'extra-wt'), repo);
        assert.strictEqual(read(dest, 'extra-wt', 'wip.txt'), 'kept\n');
      });
      if (relative) {
        it('relative: they stay relative', () => {
          const l = links(path.join(dest, 'extra-wt'));
          assert.match(l.gitfile, /^gitdir: \.\.\//);
          assert.ok(!path.isAbsolute(l.gitdir.trim()));
        });
        git(repo, ['config', '--unset', 'worktree.useRelativePaths']);
      }
    }
    {
      // One of them broken already: refused, named in blockers, with the command that repairs it.
      const repo = makeRepo('nest-broken');
      const ep = make('nest-ep-broken', [], ['--kind', 'epic']);
      const ws = make('nest-broken', [[repo, ['--branch', 'feat/nest-broken']]]);
      const extra = path.join(ws, 'extra-wt');
      git(repo, ['worktree', 'add', '-q', '-b', 'extra-broken', extra]);
      fs.writeFileSync(path.join(links(extra).admin, 'gitdir'), `${path.join(tmp, 'nowhere', '.git')}\n`);
      const r = json(['move', 'nest-broken', '--epic', path.basename(ep)]);
      it('a broken one: refused, exit 2, in blockers, the repair command names it', () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.deepStrictEqual(r.doc.result.blockers.worktrees.map((b) => b.name), ['extra-wt']);
        assert.match(r.doc.error.message, new RegExp(`worktree repair ${extra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} first`));
        assert.ok(fs.existsSync(ws));
      });
    }
    {
      // A repository kept inside the task with a worktree of its own: refused.
      const ws = make('nest-repo');
      const inner = path.join(ws, 'vendor');
      fs.mkdirSync(inner);
      git(inner, ['init', '-q', '-b', 'main']);
      git(inner, ['-c', 'user.email=a@example.com', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'i']);
      git(inner, ['worktree', 'add', '-q', '-b', 'side', path.join(tmp, 'vendor-side')]);
      const r = json(['move', 'nest-repo', '--epic', 'shop']);
      it('a repository inside the task with worktrees: refused', () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.match(r.doc.error.message, /repository inside the task with worktrees/);
      });
    }
  }

  console.log('\na worktree with a submodule checked out');
  {
    const repo = makeRepo('subm-host');
    const sub = makeRepo('subm-sub');
    const ep = make('subm-ep', [], ['--kind', 'epic']);
    const ws = make('subm', [[repo, ['--branch', 'feat/subm']]]);
    const wt = path.join(ws, 'subm-host');
    const subGit = (...a) => execFileSync('git', ['-C', wt, '-c', 'protocol.file.allow=always', '-c', 'user.email=a@example.com', '-c', 'user.name=a', ...a], { stdio: 'ignore', env: { ...process.env, ...ENV } });
    subGit('submodule', 'add', '-q', sub, 'sub');
    subGit('commit', '-qm', 'sub');
    const before = tree(ws);
    const r = json(['move', 'subm', '--epic', path.basename(ep)]);
    it('refused, exit 2, in blockers, nothing touched', () => {
      assert.strictEqual(r.code, 2, r.all);
      assert.match(r.doc.error.message, /submodules checked out/);
      assert.deepStrictEqual(r.doc.result.blockers.worktrees.map((b) => b.name), ['subm-host']);
      assert.deepStrictEqual(tree(ws), before);
    });    it('the message lists the submodule, not git\'s own directory', () => {
      assert.match(r.doc.error.message, /^\s+sub$/m);
      assert.doesNotMatch(r.doc.error.message, /\.git\/modules/);
    });
    // As the refusal says: deinit, move, update --init.
    subGit('submodule', 'deinit', '-q', '--all');
    const m = wsg(['move', 'subm', '--epic', path.basename(ep)]);
    const moved = path.join(ep, 'subm', 'subm-host');
    it('deinitialized, it moves; submodule update --init works there', () => {
      assert.strictEqual(m.code, 0, m.all);
      usable(moved, repo);
      execFileSync('git', ['-C', moved, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init'], { stdio: 'ignore', env: { ...process.env, ...ENV } });
      assert.ok(fs.existsSync(path.join(moved, 'sub', 'a.ts')));
      assert.strictEqual(git(moved, ['status', '--porcelain']), '');
      git(path.join(moved, 'sub'), ['status', '--porcelain']);
    });
  }
  {
    // A registration whose directory is gone: nothing to move, a warning that names the prune.
    const repo = makeRepo('gone-reg');
    const ep = make('gone-reg-ep', [], ['--kind', 'epic']);
    const ws = make('gone-reg', [[repo, ['--branch', 'feat/gone-reg']]]);
    const extra = path.join(ws, 'old-wt');
    git(repo, ['worktree', 'add', '-q', '-b', 'old-wt', extra]);
    fs.rmSync(extra, { recursive: true });
    const r = json(['move', 'gone-reg', '--epic', path.basename(ep)]);
    it('a registered worktree gone from disk: moved, a warning with git worktree prune, no repair hint', () => {
      assert.strictEqual(r.code, 0, r.all);
      const w = r.doc.warnings.join('\n');
      assert.match(w, /old-wt: git still lists it, its directory gone .* worktree prune/);
      assert.doesNotMatch(w, /worktree repair/);
    });
  }
  {
    // A copy of a worktree inside the task: its .git file is the original's.
    const repo = makeRepo('copy-wt');
    const ep = make('copy-ep', [], ['--kind', 'epic']);
    const ws = make('copy-wt', [[repo, ['--branch', 'feat/copy-wt']]]);
    fs.cpSync(path.join(ws, 'copy-wt'), path.join(ws, 'copy-wt-2'), { recursive: true });
    const r = json(['move', 'copy-wt', '--epic', path.basename(ep)]);
    it('a copied worktree: refused, another directory holds it, no repair advice', () => {
      assert.strictEqual(r.code, 2, r.all);
      assert.match(r.doc.error.message, /copy-wt-2: another directory already holds this worktree/);
      assert.doesNotMatch(r.doc.error.message, /worktree repair/);
      assert.deepStrictEqual(r.doc.result.blockers.worktrees.map((b) => b.name), ['copy-wt-2']);
    });
  }
  {
    // A submodule that appears after the plan: the check after the relink fails, everything goes back.
    const M = require(path.join(ROOT, 'lib', 'move.js'));
    const cfg = { WS_ROOT: wsRoot, WSG_GLOBAL_MEMORY: '', WSG_PARENT_CONTEXT: '' };
    const repo = makeRepo('late-host');
    const sub = makeRepo('late-sub');
    const ep = make('late-ep', [], ['--kind', 'epic']);
    const ws = make('late', [[repo, ['--branch', 'feat/late']]]);
    const wt = path.join(ws, 'late-host');
    const plan = M.planMove(ws, W.readState(ws), { epicWs: ep }, cfg);
    execFileSync('git', ['-C', wt, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sub'], { stdio: 'ignore', env: { ...process.env, ...ENV } });
    const before = tree(ws);
    let err = null;
    const log = console.log;
    const ew = process.stderr.write;
    console.log = () => {};
    process.stderr.write = () => true;
    try { await M.applyMove(plan, cfg); } catch (e) { err = e; } finally { console.log = log; process.stderr.write = ew; }
    it('git status fails in the moved worktree: the error, rolled back, as it was', () => {
      assert.deepStrictEqual(plan.errors, []);
      assert.ok(err && /git does not see the worktree/.test(err.message), err && err.message);
      assert.strictEqual(err.rollback, 'done');
      assert.deepStrictEqual(tree(ws), before);
      git(wt, ['status', '--porcelain']);
    });
  }

  console.log('\ninto an epic: what a task made there has');
  {
    const api = makeRepo('kit-api');
    const web = makeRepo('kit-web');
    const ep = make('kit', [[api, ['--branch-template', 'kit/{slug}']], [web, ['--link']]], ['--kind', 'epic']);
    make('kit-two', [[web, ['--link']]], ['--kind', 'epic']);
    const ws = make('kit-task', [[web, ['--link']]]);
    // settings.json formatted by its owner: only the value changes.
    const set = path.join(ws, '.claude', 'settings.json');
    const j = JSON.parse(fs.readFileSync(set, 'utf8'));
    fs.writeFileSync(set, `{"autoMemoryDirectory":${JSON.stringify(j.autoMemoryDirectory)},  "permissions": ${JSON.stringify(j.permissions)}, "model": "x"}\n`);
    const own = fs.readFileSync(set, 'utf8');
    const r = json(['move', 'kit-task', '--epic', 'kit']);
    const dest = path.join(ep, 'kit-task');
    it('a warning names the epic\'s branched source it has not, with the command', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.match(r.doc.warnings.join('\n'), /the epic's source kit-api gives its tasks a worktree .* wsg add kit-api --ws kit\/kit-task/);
    });
    it('its own link of the epic\'s source is taken from the epic, as a fresh task\'s', () => {
      assert.deepStrictEqual(r.doc.result.relinked, ['kit-web']);
      const st = readState(dest);
      assert.strictEqual(st.sources[0].from, 'epic');
      const fresh = make('kit-fresh', [], ['--epic', 'kit', '--sources', 'kit-web']);
      assert.strictEqual(read(dest, '.claude', 'rules', 'kit-web.md'), read(fresh, '.claude', 'rules', 'kit-web.md'));
      assert.strictEqual(readState(fresh).sources[0].from, 'epic');
    });
    it('plain output: a source that was the task\'s own is "taken now", one taken from the old epic "as before"', () => {
      make('kit-own', [[web, ['--link']]]);
      const a = wsg(['move', 'kit-own', '--epic', 'kit']);
      assert.strictEqual(a.code, 0, a.all);
      assert.match(a.out, /taken from the epic kit now, as wsg add <name> takes it: kit-web/);
      assert.doesNotMatch(a.out, /as from the epic before/);
      const b = wsg(['move', 'kit/kit-own', '--epic', 'kit-two']);
      assert.strictEqual(b.code, 0, b.all);
      assert.match(b.out, /taken from the epic kit-two, as from the epic before: kit-web/);
    });
    it('settings.json: only the value of autoMemoryDirectory changed, the formatting kept', () => {
      assert.strictEqual(read(dest, '.claude', 'settings.json'), own.replace(JSON.stringify(j.autoMemoryDirectory), JSON.stringify(path.join(dest, '.claude-memory'))));
    });
  }

  console.log('\na move that stopped between the rename and the state');
  {
    make('half-ep', [], ['--kind', 'epic']);
    const ws = make('half');
    fs.renameSync(ws, path.join(wsRoot, 'half-ep', 'half'));
    const r = json(['move', 'half-ep/half', '--out']);
    it('the task in an epic\'s directory, its state naming none: said so, exit 2', () => {
      assert.strictEqual(r.code, 2, r.all);
      assert.match(r.doc.error.message, /in the directory of the epic half-ep, but its state names no epic: a move that stopped half-way/);
    });
    const e = make('half2', [], ['--epic', 'half-ep']);
    fs.renameSync(e, path.join(wsRoot, 'half2'));
    const r2 = json(['move', 'half2', '--epic', 'half-ep']);
    it('a task of an epic right in WS_ROOT: said so, exit 2', () => {
      assert.strictEqual(r2.code, 2, r2.all);
      assert.match(r2.doc.error.message, /right in WS_ROOT, but its state names the epic half-ep/);
    });
  }

  console.log('\n--new-epic');
  {
    const ws = make('lamp3');
    const r = json(['move', 'lamp3', '--epic', 'lights', '--new-epic', '--title', 'Lights']);
    const ep = path.join(wsRoot, 'lights');
    const dest = path.join(ep, 'lamp3');
    it('exit 0, newEpic, the task in it', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(r.doc.result.newEpic, true);
      assert.deepStrictEqual(r.doc.result.to, { epic: 'lights', path: dest });
      assert.ok(fs.existsSync(path.join(dest, 'AGENTS.md')) && !fs.existsSync(ws));
    });
    it('the epic is what wsg new --kind epic makes, its tasks.md listing the task', () => {
      const root2 = path.join(tmp, 'ws3');
      fs.mkdirSync(root2);
      const fresh = make('lights', [], ['--kind', 'epic', '--title', 'Lights'], { WS_ROOT: root2 });
      const st = readState(ep);
      assert.strictEqual(st.kind, 'epic');
      assert.strictEqual(st.title, 'Lights');
      assert.deepStrictEqual(st.sources, []);
      for (const f of ['AGENTS.md', 'CLAUDE.md', 'knowledge.md', 'decisions.md', path.join('.claude', 'wsg.json')]) {
        assert.strictEqual(read(ep, f), read(fresh, f).replaceAll(root2, wsRoot), f);
      }
      assert.match(read(ep, 'tasks.md'), /^- `lamp3\/`$/m);
    });
    it('the task renders the new epic: no Owner rules yet', () => assert.match(read(dest, 'AGENTS.md'), /Epic `lights` has no Owner rules filled in yet/));
    const taken = json(['move', 'lights/lamp3', '--epic', 'lights', '--new-epic']);
    it('an epic that exists: refused, exit 2', () => {
      assert.strictEqual(taken.code, 2, taken.all);
      assert.match(taken.doc.error.message, /exists already/);
    });
  }
  {
    // The new epic takes the task's own name: the task steps aside while the epic is made.
    const repo = makeRepo('cafe-api');
    const ws = make('cafe', [[repo, ['--branch', 'feat/cafe']]]);
    const dry = json(['move', 'cafe', '--epic', 'cafe', '--new-epic', '--dry-run']);
    it('--dry-run: cafe into cafe/cafe', () => {
      assert.strictEqual(dry.code, 0, dry.all);
      assert.strictEqual(dry.doc.result.to.path, path.join(ws, 'cafe'));
    });
    const r = wsg(['move', 'cafe', '--epic', 'cafe', '--new-epic']);
    const dest = path.join(wsRoot, 'cafe', 'cafe');
    it('exit 0: the epic cafe, the task cafe in it, its worktree usable', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(readState(path.join(wsRoot, 'cafe')).kind, 'epic');
      assert.deepStrictEqual(readState(dest).epic, { slug: 'cafe' });
      usable(path.join(dest, 'cafe-api'), repo);
    });
    it('nothing hidden left in WS_ROOT', () => assert.deepStrictEqual(fs.readdirSync(wsRoot).filter((e) => e.startsWith('.')), []));
  }

  console.log('\na done task, and entries for the epic not merged');
  {
    make('market', [], ['--kind', 'epic']);
    const ws = make('scale', [], ['--epic', 'market']);
    fs.writeFileSync(path.join(ws, 'notes.md'), read(ws, 'notes.md').replace('## For the epic\n', '## For the epic\n\n- 2026-11-19: the scale rounds down (a.ts:1)\n'));
    assert.strictEqual(wsg(['close', 'market/scale']).code, 0);
    const r = json(['move', 'market/scale', '--out']);
    it('moved with both warnings, still done', () => {
      assert.strictEqual(r.code, 0, r.all);
      const w = r.doc.warnings.join('\n');
      assert.match(w, /market\/scale is done: it moves as it is/);
      assert.match(w, /"## For the epic" that the epic market has not merged/);
      assert.strictEqual(readState(path.join(wsRoot, 'scale')).status, 'done');
    });
    const back = json(['move', 'scale', '--epic', 'market']);
    it('into an epic: its tasks.md shows it done', () => {
      assert.strictEqual(back.code, 0, back.all);
      assert.match(read(wsRoot, 'market', 'tasks.md'), /^- `scale\/` \[done \d{4}-\d{2}-\d{2}\]$/m);
    });
  }

  console.log('\na failure after the rename, and a stop signal: everything back');
  {
    const M = require(path.join(ROOT, 'lib', 'move.js'));
    const G = require(path.join(ROOT, 'lib', 'generate.js'));
    const cfg = { WS_ROOT: wsRoot, WSG_GLOBAL_MEMORY: '', WSG_PARENT_CONTEXT: '' };
    const quiet = async (fn) => {
      const log = console.log;
      const err = process.stderr.write;
      console.log = () => {};
      process.stderr.write = () => true;
      try { return await fn(); } finally { console.log = log; process.stderr.write = err; }
    };
    const abs = makeRepo('gym-abs');
    const rel = makeRepo('gym-rel');
    git(rel, ['config', 'worktree.useRelativePaths', 'true']);
    const ep = make('gym', [], ['--kind', 'epic']);
    make('mat', [], ['--epic', 'gym']);
    for (const [what, patch] of [
      ['a failure in the render there', (real) => ({ computeRender: (...a) => (a[0].includes(`${path.sep}gym${path.sep}`) ? (() => { throw new Error('injected failure'); })() : real.computeRender(...a)) })],
      ['a failure in the epic\'s tasks.md', (real) => ({ renderTasks: () => { throw new Error('injected failure'); } })],
      ['a stop signal during the move', (real) => ({ renderTasks: (...a) => { process.emit('SIGINT'); return real.renderTasks(...a); } })],
    ]) {
      const slug = `rope-${passed}`;
      const ws = make(slug, [[abs, ['--branch', `feat/${slug}`]], [rel, ['--branch', `feat/${slug}`]]]);
      const before = { task: tree(ws), epic: tree(ep), abs: links(path.join(ws, 'gym-abs')), rel: links(path.join(ws, 'gym-rel')) };
      const plan = M.planMove(ws, W.readState(ws), { epicWs: ep }, cfg);
      const real = { computeRender: G.computeRender, renderTasks: G.renderTasks };
      const swap = patch(real);
      Object.assign(G, swap);
      let err = null;
      try {
        await quiet(async () => { try { await M.applyMove(plan, cfg); } catch (e) { err = e; } });
      } finally {
        Object.assign(G, real);
      }
      it(`${what}: the error, rolled back done`, () => {
        assert.deepStrictEqual(plan.errors, []);
        assert.ok(err, 'no error');
        if (what.includes('signal')) assert.strictEqual(err.name, 'Interrupted');
        else assert.match(err.message, /injected failure/);
        assert.strictEqual(err.rollback, 'done');
      });
      it(`${what}: the task back where it was, byte for byte, the epic as it was`, () => {
        assert.ok(!fs.existsSync(path.join(ep, slug)));
        assert.deepStrictEqual(tree(ws), before.task);
        assert.deepStrictEqual(tree(ep), before.epic);
      });
      it(`${what}: both worktrees usable there, their links as git wrote them`, () => {
        usable(path.join(ws, 'gym-abs'), abs);
        usable(path.join(ws, 'gym-rel'), rel);
        assert.deepStrictEqual(links(path.join(ws, 'gym-abs')), before.abs);
        assert.deepStrictEqual(links(path.join(ws, 'gym-rel')), before.rel);
      });
    }
    {
      // A new epic of the task's own name, rolled back: the epic gone, the task back, nothing hidden left.
      const ws = make('bench', [[abs, ['--branch', 'feat/bench']]]);
      const before = tree(ws);
      const plan = M.planMove(ws, W.readState(ws), { epicWs: path.join(wsRoot, 'bench'), newEpic: true }, cfg);
      const real = G.renderTasks;
      G.renderTasks = () => { throw new Error('injected failure'); };
      let err = null;
      try {
        await quiet(async () => { try { await M.applyMove(plan, cfg); } catch (e) { err = e; } });
      } finally {
        G.renderTasks = real;
      }
      it('a new epic of its own name, rolled back: the task as it was, no epic, nothing hidden', () => {
        assert.ok(plan.staging);
        assert.strictEqual(err && err.rollback, 'done', err && err.message);
        assert.deepStrictEqual(tree(ws), before);
        assert.strictEqual(readState(ws).kind, 'task');
        assert.deepStrictEqual(fs.readdirSync(wsRoot).filter((e) => e.startsWith('.')), []);
        usable(path.join(ws, 'gym-abs'), abs);
      });
    }
    for (const [what, slug, epicSlug] of [['a new epic', 'stool', 'seats'], ['a new epic of the task\'s own name', 'chair', 'chair']]) {
      // The skeleton of the new epic fails half-way: nothing of it stays, the task is back.
      const ws = make(slug, [[abs, ['--branch', `feat/${slug}`]]]);
      const before = tree(ws);
      const plan = M.planMove(ws, W.readState(ws), { epicWs: path.join(wsRoot, epicSlug), newEpic: true }, cfg);
      const realWrite = fs.writeFileSync;
      fs.writeFileSync = function (p, ...a) {
        if (String(p).endsWith(`${path.sep}knowledge.md`)) throw Object.assign(new Error('injected failure'), { code: 'EIO' });
        return realWrite.call(fs, p, ...a);
      };
      let err = null;
      try {
        await quiet(async () => { try { await M.applyMove(plan, cfg); } catch (e) { err = e; } });
      } finally {
        fs.writeFileSync = realWrite;
      }
      it(`${what}, its skeleton failing half-way: rolled back, no epic, the task as it was`, () => {
        assert.strictEqual(err && err.rollback, 'done', err && err.message);
        assert.match(err.message, /injected failure/);
        assert.deepStrictEqual(tree(ws), before);
        assert.strictEqual(readState(ws).kind, 'task');
        if (slug !== epicSlug) assert.ok(!fs.existsSync(path.join(wsRoot, epicSlug)));
        assert.deepStrictEqual(fs.readdirSync(wsRoot).filter((e) => e.startsWith('.')), []);
        usable(path.join(ws, 'gym-abs'), abs);
      });
    }
    git(rel, ['config', '--unset', 'worktree.useRelativePaths']);
  }

  console.log('\nws: the session from before the move');
  {
    const ws = make('crate');
    const r = wsg(['move', 'crate', '--epic', 'market']);
    const dest = path.join(wsRoot, 'market', 'crate');
    const claudeDir = path.join(tmp, 'claude-sessions');
    const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
    const old = path.join(claudeDir, 'projects', enc(ws));
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'aaaaaaaa-0000-4000-8000-00000000000f.jsonl'), '{"type":"user","message":{"role":"user","content":"hi"}}\n');
    const fakeBin = path.join(tmp, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nprintf claude; for a; do printf \' [%s]\' "$a"; done; echo\n', { mode: 0o755 });
    const wsZsh = path.join(tmp, 'wsg.zsh');
    fs.writeFileSync(wsZsh, wsg(['shell-init', 'zsh']).out);
    const cfgFile = path.join(tmp, 'ws-config');
    fs.writeFileSync(cfgFile, 'WSG_AGENT=claude\n');
    const ws_ = (arg) => {
      const z = spawnSync('zsh', ['-f', '-c', `source ${JSON.stringify(wsZsh)}; ws ${arg}`],
        { encoding: 'utf8', input: '', env: { ...ENV, PATH: `${fakeBin}:${process.env.PATH}`, WSG_CONFIG: cfgFile, CLAUDE_CONFIG_DIR: claudeDir } });
      return z.stdout + z.stderr;
    };
    it('moved', () => assert.strictEqual(r.code, 0, r.all));
    it('ws resumes the session kept under the old directory', () => assert.match(ws_('market/crate'), /^claude \[--resume\] \[aaaaaaaa-0000-4000-8000-00000000000f\]$/m));
    const now = path.join(claudeDir, 'projects', enc(dest));
    fs.mkdirSync(now, { recursive: true });
    fs.writeFileSync(path.join(now, 'bbbbbbbb-0000-4000-8000-00000000000f.jsonl'), '{"type":"user","message":{"role":"user","content":"hi"}}\n');
    it('a session in the new directory comes first', () => assert.match(ws_('market/crate'), /^claude \[--resume\] \[bbbbbbbb-0000-4000-8000-00000000000f\]$/m));
    it('--new still starts a new one', () => assert.match(ws_('market/crate --new'), /^claude \[-n\] \[market\/crate\]$/m));
    it('wsg wrote nothing under the Claude Code config', () => assert.ok(!fs.existsSync(ENV.CLAUDE_CONFIG_DIR) || !fs.existsSync(path.join(ENV.CLAUDE_CONFIG_DIR, 'projects'))));
  }

  finished = true;
  console.log(failed === 0 ? `\n${passed} checks passed\n` : `\nfailed: ${failed}, ${passed} passed\n`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  console.log(`\nFAIL  ${e.stack || e}`);
  process.exitCode = 1;
});
