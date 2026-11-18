'use strict';

// What a task can be beyond a ticket with a branch: a task without code (wsg new --no-code), its
// checklist (checklist.md) and its spec stages (wsg new --spec), and the rules the epic guide gives
// for tracker tasks. Every command runs in a child process with its own HOME, WS_ROOT and config;
// the repositories are real temporary git repositories. Nothing here needs the network or a real agent.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

process.env.WSG_LANG = 'en';

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const W = require(path.join(ROOT, 'lib', 'workspace.js'));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-task-')));
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
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
  return dir;
}
const readState = (ws) => JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'wsg.json'), 'utf8'));
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const write = (p, text) => fs.writeFileSync(p, text);
// The check items of a workspace, as "level text" lines.
const checkItems = (ws) => {
  const r = json(['check', ws]);
  return r.doc.result.sections.flatMap((s) => s.items.map((i) => `${i.level} ${i.text}`));
};
// AGENTS.md with a section's FILL IN line replaced, as the setup does.
function fill(ws, heading, text) {
  const p = path.join(ws, 'AGENTS.md');
  const all = read(p);
  const at = all.indexOf(`## ${heading}\n`);
  assert.ok(at >= 0, heading);
  const start = at + heading.length + 4;
  const next = all.indexOf('\n## ', start);
  write(p, `${all.slice(0, start)}\n${text}\n${all.slice(next)}`);
}

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

(async () => {
  console.log('wsg new --no-code');
  {
    const r = json(['new', 'spec-a', '--no-code', '--no-launch']);
    const ws = path.join(wsRoot, 'spec-a');
    it('made: exit 0, noCode true in --json and in the state', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(r.doc.result.noCode, true);
      assert.strictEqual(readState(ws).noCode, true);
      assert.strictEqual(W.stateProblem(readState(ws)), '');
    });
    it('AGENTS.md: no repository by design, Verification is None, the DoD asks what the owner checks', () => {
      const a = read(ws, 'AGENTS.md');
      assert.match(a, /task workspace without code \(`wsg new --no-code`\)/);
      assert.match(a, /<!-- wsg:verification -->\n- None: no code in this task; done is what the owner can check - see Definition of done\.\n<!-- \/wsg:verification -->/);
      assert.match(a, /## Definition of done\n\nFILL IN: what the owner can check/);
    });
    it('README: no sources by design', () => assert.match(read(ws, 'README.md'), /None: no code in this task/));
    const plain = json(['new', 'plain-a', '--no-launch']);
    it('an ordinary task: noCode false, no key in the state', () => {
      assert.strictEqual(plain.doc.result.noCode, false);
      assert.strictEqual(readState(path.join(wsRoot, 'plain-a')).noCode, undefined);
    });
    const dry = wsg(['new', 'spec-dry', '--no-code', '--dry-run']);
    it('--dry-run: the planned state has noCode', () => {
      assert.strictEqual(dry.code, 0, dry.all);
      assert.strictEqual(JSON.parse(dry.out).state.noCode, true);
      assert.ok(!fs.existsSync(path.join(wsRoot, 'spec-dry')));
    });
    for (const kind of ['epic', 'process']) {
      const x = wsg(['new', `nc-${kind}`, '--no-code', '--kind', kind, '--no-launch']);
      it(`refused for --kind ${kind}: exit 2, nothing made`, () => {
        assert.strictEqual(x.code, 2, x.all);
        assert.match(x.err, /--no-code is only for a task/);
        assert.ok(!fs.existsSync(path.join(wsRoot, `nc-${kind}`)));
      });
    }

    console.log('\ncheck of a task without code');
    const fresh = checkItems(ws);
    it('fresh: no "no git repository attached", no verification FILL IN warning', () => {
      assert.ok(!fresh.some((l) => /no git repository attached/.test(l)), fresh.join('\n'));
      assert.ok(!fresh.some((l) => /verification section has no command/.test(l)), fresh.join('\n'));
    });
    it('fresh: warns while the Definition of done says FILL IN', () => {
      assert.ok(fresh.some((l) => /^warn no-code task: the Definition of done is not filled in/.test(l)), fresh.join('\n'));
      assert.ok(fresh.some((l) => /^warn setup not finished: "Why" is not filled in/.test(l)), fresh.join('\n'));
    });
    fill(ws, 'Why', 'Write the checkout spec for the shop.');
    fill(ws, 'Definition of done', 'The owner approves the spec.');
    const set = checkItems(ws);
    it('filled in: setup finished, the DoD is what the owner checks', () => {
      assert.ok(set.some((l) => l === 'ok setup finished: a task without code'), set.join('\n'));
      assert.ok(set.some((l) => /^ok no-code task: no verification command/.test(l)), set.join('\n'));
      assert.ok(!set.some((l) => /Definition of done is not filled in|setup not finished/.test(l)), set.join('\n'));
    });

    console.log('\nwsg add in a task without code');
    const repo = makeRepo();
    const wt = wsg(['add', repo, '--worktree', '--ws', ws]);
    it('--worktree refused: "no-code task: no branches", exit 2, nothing attached', () => {
      assert.strictEqual(wt.code, 2, wt.all);
      assert.match(wt.err, /no-code task: no branches/);
      assert.deepStrictEqual(readState(ws).sources, []);
    });
    const br = wsg(['add', repo, '--branch', 'feat/x', '--ws', ws]);
    it('--branch refused: a link has none', () => assert.strictEqual(br.code, 2, br.all));
    const ln = json(['add', repo, '--ws', ws]);
    it('no mode: attached as a link, said so', () => {
      assert.strictEqual(ln.code, 0, ln.all);
      assert.strictEqual(ln.doc.result.source.mode, 'link');
      assert.ok(ln.doc.warnings.some((w) => /no-code task: attached as a link/.test(w)), ln.doc.warnings.join('\n'));
      assert.ok(fs.lstatSync(path.join(ws, path.basename(repo))).isSymbolicLink());
    });
    const docs = path.join(tmp, 'material');
    fs.mkdirSync(docs);
    fs.writeFileSync(path.join(docs, 'brief.md'), 'brief\n');
    const rf = json(['add', docs, '--reference', '--note', 'briefs', '--ws', ws]);
    it('--reference: attached, without the "no git repository yet" warning', () => {
      assert.strictEqual(rf.code, 0, rf.all);
      assert.ok(!rf.doc.warnings.some((w) => /no git repository is attached yet/.test(w)), rf.doc.warnings.join('\n'));
    });
    it('Verification stays None with a link attached', () => assert.match(read(ws, 'AGENTS.md'), /- None: no code in this task/));
    it('the linked repository gets a read-only rule, wsg\'s own', () => {
      const rule = read(ws, '.claude', 'rules', `${path.basename(repo)}.md`);
      assert.match(rule, /read only: this task changes no code\./);
      assert.match(rule, /A change here is a question to the owner, never made on your own\./);
      assert.doesNotMatch(rule, /Before editing/);
      assert.strictEqual(rule.split('\n')[1], '# generated by wsg: written by wsg add, removed by wsg remove');
    });
    it('no repo pointer, no mr-target-branch.txt, no MR line in README', () => {
      assert.ok(!fs.existsSync(path.join(ws, 'repo')) && !fs.existsSync(path.join(ws, 'mr-target-branch.txt')));
      assert.doesNotMatch(read(ws, 'README.md'), /Push and MR creation/);
    });
    const rm = wsg(['remove', path.basename(repo), '--ws', ws]);
    it('wsg remove takes the read-only rule with the link', () => {
      assert.strictEqual(rm.code, 0, rm.all);
      assert.ok(!fs.existsSync(path.join(ws, '.claude', 'rules', `${path.basename(repo)}.md`)));
    });
    assert.strictEqual(wsg(['add', repo, '--link', '--ws', ws]).code, 0);
    const l = json(['list']);
    it('list --json: noCode true for it, false for an ordinary task', () => {
      const by = Object.fromEntries(l.doc.result.workspaces.map((w) => [w.slug, w]));
      assert.strictEqual(by['spec-a'].noCode, true);
      assert.strictEqual(by['plain-a'].noCode, false);
    });
    // A worktree there by hand: said, never refused.
    const st = readState(ws);
    st.sources.push({ ...st.sources[0], name: 'hand', mode: 'worktree', branch: 'b' });
    write(path.join(ws, '.claude', 'wsg.json'), W.stateJson(st));
    it('check: a worktree in a task without code is a warning', () => {
      assert.ok(checkItems(ws).some((l) => /^warn a task without code \(noCode\) has a worktree: hand/.test(l)));
    });
  }

  console.log('\nwsg promote of a task without code');
  {
    assert.strictEqual(wsg(['new', 'nc-promo', '--no-code', '--no-launch']).code, 0);
    const ws = path.join(wsRoot, 'nc-promo');
    const p = wsg(['promote', 'nc-promo', '--skill', 'shop-digest']);
    it('promoted: exit 0, said that noCode goes', () => {
      assert.strictEqual(p.code, 0, p.all);
      assert.match(p.all, /the task was without code \(noCode\): a process has no such mark/);
    });
    it('the state is a process without noCode, and it reads', () => {
      const st = readState(ws);
      assert.deepStrictEqual([st.kind, st.noCode], ['process', undefined]);
      assert.strictEqual(W.stateProblem(st), '');
      assert.strictEqual(wsg(['list']).code, 0);
      assert.strictEqual(wsg(['refresh', '--ws', ws]).code, 0);
    });
  }

  console.log('\nthe state');
  {
    const base = { version: 2, kind: 'task', slug: 'x', title: 'x', status: 'open', personalRules: false, created: '2026-11-01', sources: [] };
    it('noCode true reads', () => assert.strictEqual(W.stateProblem({ ...base, noCode: true }), ''));
    it('noCode false refused', () => assert.match(W.stateProblem({ ...base, noCode: false }), /"noCode" belongs only to a task, as true/));
    it('noCode on a process refused', () => assert.match(W.stateProblem({ ...base, kind: 'process', skillName: 'x', noCode: true }), /noCode/));
    it('noCode on an epic refused', () => assert.match(W.stateProblem({ version: 3, kind: 'epic', slug: 'e', title: 'e', created: '2026-11-01', sources: [], noCode: true }), /noCode/));
  }

  console.log('\na task without code in an epic');
  {
    const repo = makeRepo('shop-api');
    assert.strictEqual(wsg(['new', 'shop', '--kind', 'epic', '--no-launch']).code, 0);
    const ep = path.join(wsRoot, 'shop');
    const a = wsg(['add', repo, '--ws', ep, '--branch-template', 'feat/{slug}']);
    assert.strictEqual(a.code, 0, a.all);
    const r = json(['new', 'cart-spec', '--epic', 'shop', '--no-code', '--no-launch']);
    const ws = path.join(ep, 'cart-spec');
    it('the epic\'s templated source is not taken: no sources, no branch', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.deepStrictEqual(r.doc.result.sources, []);
      assert.deepStrictEqual(readState(ws).sources, []);
      assert.ok(!git(repo, ['branch', '--list', 'feat/cart-spec']));
    });
    it('the epic\'s tasks.md lists it', () => assert.match(read(ep, 'tasks.md'), /`cart-spec\/`/));
    const listed = wsg(['new', 'cart-x', '--epic', 'shop', '--no-code', '--sources', 'shop-api', '--no-launch']);
    it('--sources with a list: refused, exit 2', () => {
      assert.strictEqual(listed.code, 2, listed.all);
      assert.match(listed.err, /--no-code takes no source of the epic/);
    });
    const none = json(['new', 'cart-y', '--epic', 'shop', '--no-code', '--sources', 'none', '--no-launch']);
    it('--sources none: allowed', () => assert.strictEqual(none.code, 0, none.all));
    const add = json(['add', 'shop-api', '--ws', ws]);
    it('wsg add <epic source>: a link, not a worktree on the template', () => {
      assert.strictEqual(add.code, 0, add.all);
      assert.strictEqual(add.doc.result.source.mode, 'link');
      assert.strictEqual(add.doc.result.source.from, 'epic');
      assert.ok(!git(repo, ['branch', '--list', 'feat/cart-spec']));
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
