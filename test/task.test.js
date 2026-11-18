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

  console.log('\nW.checklistCounts');
  {
    const c = (text) => W.checklistCounts(text);
    for (const [name, text, want] of [
      ['empty text', '', [0, 0]],
      ['the template: only the FILL IN line', '# Checklist: x\n\n<!-- One `- [ ]` line per item -->\n\n- [ ] FILL IN: items from the Definition of done\n', [0, 0]],
      ['- items, open and done', '- [ ] a\n- [x] b\n', [1, 2]],
      ['* and + bullets', '* [ ] a\n+ [x] b\n', [1, 2]],
      ['numbered 1. and 1)', '1. [x] a\n2) [ ] b\n10. [X] c\n', [2, 3]],
      ['upper-case X is done', '- [X] a\n', [1, 1]],
      ['any indent, nested items', '- [ ] a\n  - [x] b\n\t- [x] c\n        * [ ] d\n', [2, 4]],
      ['an item with nothing after the box', '- [ ]\n- [x]\n', [1, 2]],
      ['CRLF line ends', '- [x] a\r\n- [ ] b\r\n', [1, 2]],
      ['not a box: no space after the bullet, [] empty, text glued to the box', '-[ ] a\n- [] b\n- [x]c\n- [y] d\n', [0, 0]],
      ['not a box: prose and a heading', 'Tick [x] when done\n# [ ] heading\n', [0, 0]],
      ['an HTML comment on one line', '<!-- - [ ] hidden -->\n- [ ] seen\n', [0, 1]],
      ['an HTML comment over lines', '<!--\n- [x] hidden\n- [ ] hidden\n-->\n- [x] seen\n', [1, 1]],
      ['text after a comment closes on the same line is read', '<!-- a\nb --> x\n- [ ] seen\n', [0, 1]],
      ['a box with a trailing comment counts', '- [x] seen <!-- why -->\n', [1, 1]],
      ['a fenced block with backticks', '```\n- [ ] in code\n```\n- [ ] seen\n', [0, 1]],
      ['a fenced block with tildes and a language', '~~~md\n- [x] in code\n~~~\n- [x] seen\n', [1, 1]],
      ['a fence closed only by its own kind and length', '````\n```\n- [ ] in code\n````\n- [ ] seen\n', [0, 1]],
      ['an unclosed fence hides the rest', '```\n- [ ] a\n- [x] b\n', [0, 0]],
      ['FILL IN lines are excluded, done or not', '- [ ] FILL IN: a\n- [x] FILL IN b\n- [ ] real\n', [0, 1]],
      ['FILL IN later in the text is an item', '- [ ] do not FILL IN the form by hand\n- [x] see FILL IN rules\n', [1, 2]],
      ['an inline code span hides <!--: no comment opens', '- [ ] the `<!--` marker is escaped\n- [x] next\n', [1, 2]],
      ['an inline code span with a fence inside is no fence', '- [ ] run `\u0060\u0060\u0060 x`\n- [ ] next\n', [0, 2]],
      ['an indented fence, any indent', '    ```\n- [ ] in code\n      ```\n- [ ] seen\n', [0, 1]],
      ['a fence inside a list item', '- [ ] see:\n  ```sh\n  - [x] in code\n  ```\n', [0, 1]],
      ['Cyrillic х and Х are done', '- [х] ru lower\n- [Х] ru upper\n- [ ] open\n', [2, 3]],
    ]) {
      it(name, () => {
        const got = c(text);
        assert.deepStrictEqual([got.done, got.total], want);
        assert.deepStrictEqual(Object.keys(got), ['done', 'total']);
      });
    }
    it('checklistScan says when a FILL IN line is there', () => {
      assert.strictEqual(W.checklistScan('- [ ] FILL IN: x\n').fillIn, true);
      assert.strictEqual(W.checklistScan('- [ ] x\n').fillIn, false);
      assert.strictEqual(W.checklistScan('<!-- - [ ] FILL IN -->\n').fillIn, false);
      assert.strictEqual(W.checklistScan('- [ ] not FILL IN here\n').fillIn, false);
    });
    it('spec.md, plan.md and checklist.md are reserved names', () => {
      for (const n of ['spec.md', 'plan.md', 'checklist.md']) assert.ok(W.RESERVED.includes(n), n);
    });
  }

  console.log('\nchecklist.md');
  {
    const r = json(['new', 'chk', '--title', 'Cart totals', '--no-launch']);
    const ws = path.join(wsRoot, 'chk');
    it('a new task gets checklist.md: the heading, the comment, one FILL IN line', () => {
      assert.strictEqual(r.code, 0, r.all);
      const text = read(ws, 'checklist.md');
      assert.match(text, /^# Checklist: Cart totals\n\n<!-- One `- \[ \]` line per verifiable item of the Definition of done/);
      assert.match(text, /Tick an item `- \[x\]` only with evidence/);
      assert.match(text, /-->\n\n- \[ \] FILL IN: items from the Definition of done\n$/);
      assert.strictEqual(text.match(/- \[ \]/g).length, 2);
    });
    it('AGENTS.md: Layout names checklist.md, the DoD says how it is ticked; no Stages, no spec.md', () => {
      const a = read(ws, 'AGENTS.md');
      assert.match(a, /- `checklist\.md` — the Definition of done as checkboxes/);
      assert.match(a, /Each item is a line of `checklist\.md`, ticked only with evidence/);
      assert.doesNotMatch(a, /## Stages/);
      assert.ok(!fs.existsSync(path.join(ws, 'spec.md')) && !fs.existsSync(path.join(ws, 'plan.md')));
      assert.strictEqual(readState(ws).spec, undefined);
    });
    assert.strictEqual(wsg(['new', 'chk-proc', '--kind', 'process', '--no-launch']).code, 0);
    assert.strictEqual(wsg(['new', 'chk-epic', '--kind', 'epic', '--no-launch']).code, 0);
    it('a process and an epic get none', () => {
      assert.ok(!fs.existsSync(path.join(wsRoot, 'chk-proc', 'checklist.md')));
      assert.ok(!fs.existsSync(path.join(wsRoot, 'chk-epic', 'checklist.md')));
    });
    const old = path.join(wsRoot, 'chk-old');
    assert.strictEqual(wsg(['new', 'chk-old', '--no-launch']).code, 0);
    fs.rmSync(path.join(old, 'checklist.md'));
    const l = json(['list']);
    const by = Object.fromEntries(l.doc.result.workspaces.map((w) => [w.slug, w]));
    it('list --json: checklist {done, total} for a task, null for a process, an epic, a task without the file', () => {
      assert.deepStrictEqual(by.chk.checklist, { done: 0, total: 0 });
      assert.strictEqual(by['chk-proc'].checklist, null);
      assert.strictEqual(by['chk-epic'].checklist, null);
      assert.strictEqual(by['chk-old'].checklist, null);
      assert.strictEqual(by.chk.spec, false);
    });
    // A checklist.md that is there but can't be read: said, never taken for a missing one.
    if (!(process.getuid && process.getuid() === 0)) {
      const locked = path.join(wsRoot, 'chk-locked');
      assert.strictEqual(wsg(['new', 'chk-locked', '--no-launch']).code, 0);
      fs.chmodSync(path.join(locked, 'checklist.md'), 0o000);
      const items = checkItems(locked);
      const entry = json(['list']).doc.result.workspaces.find((w) => w.slug === 'chk-locked');
      fs.chmodSync(path.join(locked, 'checklist.md'), 0o644);
      it('an unreadable checklist.md: check warns it can\'t be read, list says so in problems, checklist null', () => {
        assert.ok(items.some((x) => /^warn checklist\.md is there but can't be read \(EACCES\)/.test(x)), items.join('\n'));
        assert.ok(!items.some((x) => /no checklist\.md: a task made before/.test(x)));
        assert.strictEqual(entry.checklist, null);
        assert.ok(entry.problems.some((p) => /checklist\.md is there but can't be read/.test(p)), entry.problems.join('\n'));
      });
    } else skip('an unreadable checklist.md: running as root');
    const oldCheck = checkItems(old);
    it('check: a task without checklist.md is a note, never a warning', () => {
      assert.ok(oldCheck.some((x) => /^info\s+no checklist\.md: a task made before wsg 0\.8/.test(x)), oldCheck.join('\n'));
      assert.ok(!oldCheck.some((x) => /^warn.*checklist/.test(x)), oldCheck.join('\n'));
    });
    const before = checkItems(ws);
    it('check: FILL IN while the setup is not finished is no separate warning', () => {
      assert.ok(!before.some((x) => /checklist\.md still says FILL IN/.test(x)), before.join('\n'));
    });
    // The setup done: Why, and a repository.
    fill(ws, 'Why', 'Cart totals are wrong for the shop.');
    const repo = makeRepo();
    assert.strictEqual(wsg(['add', repo, '--branch', 'feat/chk', '--ws', ws]).code, 0);
    const after = checkItems(ws);
    it('check: FILL IN left after the setup is a warning', () => {
      assert.ok(after.some((x) => /^warn checklist\.md still says FILL IN/.test(x)), after.join('\n'));
    });
    const empty = json(['status', 'chk', 'review']);
    it('review with only the FILL IN line: no checklist warning (wsg check says it), set', () => {
      assert.strictEqual(empty.code, 0, empty.all);
      assert.ok(!empty.doc.warnings.some((w) => /checklist/.test(w)), empty.doc.warnings.join('\n'));
      assert.deepStrictEqual(empty.doc.result.checklist, { done: 0, total: 0 });
    });
    assert.strictEqual(wsg(['status', 'chk', 'open']).code, 0);
    write(path.join(ws, 'checklist.md'), '# Checklist: Cart totals\n\n- [x] totals match the invoice\n- [ ] tests cover rounding\n  - [ ] a nested item\n');
    const rv = json(['status', 'chk', 'review']);
    it('review with unchecked items: "2 of 3 checklist items unchecked", exit 0, set', () => {
      assert.strictEqual(rv.code, 0, rv.all);
      assert.ok(rv.doc.warnings.some((w) => /^2 of 3 checklist items unchecked/.test(w)), rv.doc.warnings.join('\n'));
      assert.strictEqual(readState(ws).status, 'review');
      assert.deepStrictEqual(rv.doc.result.checklist, { done: 1, total: 3 });
    });
    const plainDone = wsg(['close', 'chk', '--dry-run']);
    it('close --dry-run says it too', () => assert.match(plainDone.out, /2 of 3 checklist items unchecked/));
    const read1 = json(['status', 'chk']);
    it('status (read) gives checklist, no warning', () => {
      assert.deepStrictEqual(read1.doc.result.checklist, { done: 1, total: 3 });
      assert.ok(!read1.doc.warnings.some((w) => /checklist/.test(w)));
    });
    const dn = wsg(['close', 'chk']);
    it('close with unchecked items: done all the same, the warning said', () => {
      assert.strictEqual(dn.code, 0, dn.all);
      assert.match(dn.all, /2 of 3 checklist items unchecked/);
      assert.strictEqual(readState(ws).status, 'done');
    });
    const doneCheck = checkItems(ws);
    it('check: a done task with unchecked items is a warning', () => {
      assert.ok(doneCheck.some((x) => /^warn the task is done, but 2 of 3 checklist items are unchecked/.test(x)), doneCheck.join('\n'));
    });
    write(path.join(ws, 'checklist.md'), '- [x] a\n- [X] b\n');
    const allCheck = checkItems(ws);
    it('check: all checked is ok', () => assert.ok(allCheck.some((x) => x === 'ok checklist.md — 2 of 2 checked'), allCheck.join('\n')));
    assert.strictEqual(wsg(['status', 'chk', 'open']).code, 0);
    const clean = json(['status', 'chk', 'review']);
    it('review with every item checked: no checklist warning', () => {
      assert.ok(!clean.doc.warnings.some((w) => /checklist/.test(w)), clean.doc.warnings.join('\n'));
    });
  }

  console.log('\nwsg new --spec');
  {
    const r = json(['new', 'refunds', '--spec', '--title', 'Shop refunds', '--no-launch']);
    const ws = path.join(wsRoot, 'refunds');
    it('made: spec true in --json and in the state', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(r.doc.result.spec, true);
      assert.strictEqual(readState(ws).spec, true);
      assert.strictEqual(W.stateProblem(readState(ws)), '');
    });
    it('spec.md and plan.md templates, and checklist.md built from the spec', () => {
      assert.match(read(ws, 'spec.md'), /^# Spec: Shop refunds\n/);
      assert.match(read(ws, 'spec.md'), /## Acceptance criteria/);
      assert.match(read(ws, 'plan.md'), /^# Plan: Shop refunds\n/);
      assert.match(read(ws, 'checklist.md'), /the acceptance criteria in spec\.md, written once the owner approves the spec/);
      assert.match(read(ws, 'checklist.md'), /- \[ \] FILL IN: items from the acceptance criteria of spec\.md\n$/);
      assert.match(read(ws, 'plan.md'), /## Files[\s\S]*## Tests/);
    });
    it('AGENTS.md: the Stages section, each stage after the owner\'s ok; Layout names spec.md and plan.md', () => {
      const a = read(ws, 'AGENTS.md');
      assert.match(a, /## Stages\n\nThis task goes spec first\. Each next stage starts only after the owner's "ok" on the one before:/);
      assert.match(a, /1\. Spec: fill in `spec\.md`[^\n]*After the "ok", build `checklist\.md` from its acceptance criteria\./);
      assert.match(a, /2\. Plan: from the approved spec, fill in `plan\.md`/);
      assert.match(a, /3\. Implementation: follow the approved plan/);
      assert.match(a, /4\. Checklist review: tick each item of `checklist\.md` with evidence, show the owner what is unchecked\./);
      assert.match(a, /- `spec\.md`, `plan\.md` — the spec and the plan/);
    });
    const l = json(['list']);
    it('list --json: spec true', () => assert.strictEqual(l.doc.result.workspaces.find((w) => w.slug === 'refunds').spec, true));
    for (const kind of ['epic', 'process']) {
      const x = wsg(['new', `spec-${kind}`, '--spec', '--kind', kind, '--no-launch']);
      it(`refused for --kind ${kind}: exit 2, nothing made`, () => {
        assert.strictEqual(x.code, 2, x.all);
        assert.match(x.err, /--spec is only for a task/);
        assert.ok(!fs.existsSync(path.join(wsRoot, `spec-${kind}`)));
      });
    }
    const both = json(['new', 'spec-nc', '--spec', '--no-code', '--no-launch']);
    it('--spec with --no-code: both', () => {
      assert.strictEqual(both.code, 0, both.all);
      assert.deepStrictEqual([both.doc.result.spec, both.doc.result.noCode], [true, true]);
    });
    it('--spec with --no-code: plan.md has no files or tests, no code starts; stage 3 is the work', () => {
      const plan = read(wsRoot, 'spec-nc', 'plan.md');
      assert.doesNotMatch(plan, /## Files|## Tests|code starts/);
      assert.match(plan, /## Evidence/);
      assert.match(plan, /the work starts after "ok"/);
      assert.match(read(wsRoot, 'spec-nc', 'AGENTS.md'), /3\. Work: follow the approved plan/);
    });
    // The setup done: the checklist waits for the spec, and check says so in those words.
    const refunds = path.join(wsRoot, 'refunds');
    fill(refunds, 'Why', 'Refunds for the shop.');
    assert.strictEqual(wsg(['add', makeRepo(), '--branch', 'feat/refunds', '--ws', refunds]).code, 0);
    it('check: the FILL IN of a spec task\'s checklist points to the end of stage 1', () => {
      assert.ok(checkItems(refunds).some((x) => /^warn checklist\.md still says FILL IN: it is built from the acceptance criteria of spec\.md once the owner approves the spec/.test(x)));
    });
    const pr = wsg(['promote', 'spec-nc', '--skill', 'shop-review']);
    it('wsg promote of a --spec --no-code task: a process that reads, both marks gone and said, the files kept', () => {
      assert.strictEqual(pr.code, 0, pr.all);
      assert.match(pr.all, /a process has none — spec\.md, plan\.md and checklist\.md stay as plain files/);
      assert.match(pr.all, /the task was without code \(noCode\)/);
      const st = readState(path.join(wsRoot, 'spec-nc'));
      assert.deepStrictEqual([st.kind, st.spec, st.noCode], ['process', undefined, undefined]);
      assert.strictEqual(W.stateProblem(st), '');
      for (const f of ['spec.md', 'plan.md', 'checklist.md']) assert.ok(fs.existsSync(path.join(wsRoot, 'spec-nc', f)), f);
      assert.strictEqual(wsg(['list']).code, 0);
    });
    const base = { version: 2, kind: 'task', slug: 'x', title: 'x', status: 'open', personalRules: false, created: '2026-11-01', sources: [] };
    it('the state: spec false refused, spec on a process refused', () => {
      assert.match(W.stateProblem({ ...base, spec: false }), /"spec" belongs only to a task, as true/);
      assert.match(W.stateProblem({ ...base, kind: 'process', skillName: 'x', spec: true }), /"spec"/);
    });
  }

  console.log('\nthe close of a task of an epic reads checklist.md');
  {
    assert.strictEqual(wsg(['new', 'kiosk', '--kind', 'epic', '--no-launch']).code, 0);
    assert.strictEqual(wsg(['new', 'k1', '--epic', 'kiosk', '--no-launch']).code, 0);
    const a = read(wsRoot, 'kiosk', 'k1', 'AGENTS.md');
    it('the epic block: go through checklist.md and show the unchecked items before review', () => {
      assert.match(a, /Work finished: show the owner unchecked `checklist\.md` items, then `wsg status kiosk\/k1 review`/);
    });
    it('a task of an epic gets checklist.md too', () => assert.ok(fs.existsSync(path.join(wsRoot, 'kiosk', 'k1', 'checklist.md'))));
    const guide = wsg(['guide', 'epic']).out;
    it('the epic guide: Working and Closing read checklist.md and show the unchecked items', () => {
      assert.match(guide, /When the work is finished, read `checklist\.md` and show the owner the items still unchecked/);
      assert.match(guide, /Read its `checklist\.md` and show the owner the items still unchecked/);
    });
    const setup = wsg(['guide', 'setup']).out;
    it('the setup guide fills checklist.md from the Definition of done', () => {
      assert.match(setup, /Then write `checklist\.md` from it \(a task\s+with spec stages builds it later, from the spec — see below\): one\s+`- \[ \]` line per verifiable item/);
      assert.match(setup.replace(/\s+/g, ' '), /it is built at the end of stage 1, from the spec's acceptance criteria, after the owner's "ok" on the spec; stage 4 is the checklist review/);
      assert.match(setup.replace(/\s+/g, ' '), /With `wsg team`, the team workflow writes the sections of `plan\.md` it owns/);
    });
  }

  console.log('\nthe epic guide and the skills: no tracker task skipped silently');
  {
    const guide = wsg(['guide', 'epic']).out;
    const flat = (x) => x.replace(/\s+/g, ' ');
    const g = flat(guide);
    const section = (name) => flat(guide.slice(guide.indexOf(`## ${name}\n`), guide.indexOf('\n## ', guide.indexOf(`## ${name}\n`) + 3)));
    it('the rule up front: never skip a tracker task silently; a task without a repository is a question with three answers', () => {
      assert.ok(g.includes('Never skip a tracker task silently.'));
      assert.ok(g.includes('is never left out or set aside by you on your own: it becomes a question to the owner when it is to be started, with three answers — create it without code (`wsg new <slug> --epic <epic> --no-code`), attach a repository (`--sources <name>`, or `wsg add` in the task later), or do not start it.'));
    });
    it('Starting a task: a ticket without code is asked about, never skipped; --no-code and --spec in the command', () => {
      const p = section('Starting a task');
      assert.ok(p.includes('do not skip it and do not pick for the owner — ask, through the advisor: create it with `--no-code`, attach a repository (`wsg add <path>` in the epic first, then `--sources <name>`), or do not start it.'), p);
      assert.ok(p.includes('[--sources a,b|none] [--no-code] [--spec]'), p);
    });
    it('Syncing: every child issue listed under Other tasks, one item each starting with its key, order kept, new ones appended', () => {
      const p = section('Syncing');
      assert.ok(p.includes('Every child issue the tracker has whose key is not on a line of the `<!-- wsg:tasks -->` block is listed there — none is left out'), p);
      assert.ok(p.includes('one list item per task, starting with its key (`- KEY-12 summary — status, assignee`). Keep the order the items already have, update them in place, and append new ones at the end; no table, no other bullets in the section.'), p);
    });
    it('Syncing: SKIPPED tracker only without a tracker tool; with one nothing is skipped', () => {
      const p = section('Syncing');
      assert.ok(p.includes('Only when there is no tracker tool at all: report `SKIPPED tracker: no tool available` and change nothing. With a tool, nothing is skipped'), p);
      assert.ok(!/^\d\. No tracker tool: report/m.test(guide));
    });
    it('the guide says old epics keep their skill files and get the rules through it', () => {
      assert.ok(g.includes('an epic made by an older wsg keeps its skill files as they were, and gets these rules through this guide.'));
    });
    assert.strictEqual(wsg(['new', 'old-epic-probe', '--kind', 'epic', '--no-launch']).code, 0);
    const desc = (name) => /^description: (.+)$/m.exec(fs.readFileSync(path.join(ROOT, 'templates', 'claude', name, 'SKILL.md'), 'utf8'))[1];
    it('wsg-epic-task: a ticket without a repository is never skipped, it is a question', () => assert.match(desc('wsg-epic-task'), /a ticket without a repository is never skipped, it is a question to the owner \(--no-code, a repository, or not now\)/));
    it('wsg-epic-sync: every child issue listed, none skipped silently', () => assert.match(desc('wsg-epic-sync'), /every child issue listed by its key, none skipped silently/));
    it('wsg-epic-close: the unchecked checklist items first', () => assert.match(desc('wsg-epic-close'), /show the owner what its checklist\.md leaves unchecked/));
    it('the skills are still one-line wrappers over the guide', () => {
      for (const [name, sct] of [['wsg-epic-task', 'Starting a task'], ['wsg-epic-sync', 'Syncing'], ['wsg-epic-close', 'Closing']]) {
        assert.ok(fs.readFileSync(path.join(ROOT, 'templates', 'claude', name, 'SKILL.md'), 'utf8').includes(`Run \`wsg guide epic\`, section "${sct}", for: $ARGUMENTS`), name);
      }
    });
    it('tasks.md and the epic\'s Layout: every tracker child issue without a task directory, one item per task, key first', () => {
      const tm = read(wsRoot, 'old-epic-probe', 'tasks.md');
      assert.match(tm, /<!-- every tracker child issue without a task directory here, one item per task, key first: `wsg guide epic` → Syncing/);
      assert.doesNotMatch(tm, /other participants/);
      assert.match(read(wsRoot, 'old-epic-probe', 'AGENTS.md'), /- `tasks\.md` — the epic's tasks: the ones in this directory, and every tracker child issue without a task directory here\./);
    });
    const newSkill = fs.readFileSync(path.join(ROOT, 'templates', 'claude', 'wsg-new', 'SKILL.md'), 'utf8');
    it('wsg-new names --no-code and --spec', () => {
      assert.match(newSkill, /`--no-code`: no repository, no branch/);
      assert.match(newSkill, /Add `--spec` only when the person wants the spec and the\s+plan approved before any code/);
    });
    const conv = flat(fs.readFileSync(path.join(ROOT, 'docs', 'conventions.md'), 'utf8'));
    it('conventions: wsg never rewrites an existing epic\'s skill files; the guide reaches old epics', () => {
      assert.ok(conv.includes('wsg never rewrites the skill files of an existing epic'));
      assert.ok(conv.includes('reaches old epics through the guide'));
    });
    // An epic made now gets the new skill text; nothing rewrites an older one's.
    assert.strictEqual(wsg(['new', 'old-epic', '--kind', 'epic', '--no-launch']).code, 0);
    const own = path.join(wsRoot, 'old-epic', '.claude', 'skills', 'wsg-epic-sync', 'SKILL.md');
    it('a new epic gets the template', () => assert.strictEqual(read(own), fs.readFileSync(path.join(ROOT, 'templates', 'claude', 'wsg-epic-sync', 'SKILL.md'), 'utf8')));
    write(own, 'an older skill text\n');
    assert.strictEqual(wsg(['refresh', '--ws', path.join(wsRoot, 'old-epic')]).code, 0);
    it('wsg refresh leaves an older epic\'s skill file as it is', () => assert.strictEqual(read(own), 'an older skill text\n'));
  }

  finished = true;
  console.log(failed === 0 ? `\n${passed} checks passed, ${skipped} blocks skipped\n` : `\nfailed: ${failed}, ${passed} passed, ${skipped} blocks skipped\n`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  console.log(`\nFAIL  ${e.stack || e}`);
  process.exitCode = 1;
});
