'use strict';

// wsg promote: a task becomes an epic in place, and wsg add --link takes a symlink that is there
// already. Every command runs in a child process with its own HOME, WS_ROOT, config and
// CLAUDE_CONFIG_DIR; the repositories are real temporary git repositories. Nothing here needs the
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
const T = require(path.join(ROOT, 'lib', 'templates.js'));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-promote-')));
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

// Every path under a directory with its type and bytes: "nothing touched".
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
const checkOf = (ws) => json(['check', ws]);
const fails = (c) => ((c.doc && c.doc.result && c.doc.result.sections) || []).flatMap((x) => x.items).filter((i) => i.level === 'fail');

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
function make(slug, sources = [], extra = []) {
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
  console.log('a task with a link becomes an epic');
  {
    const api = makeRepo('shop-api');
    const ws = make('shop', [[api, ['--link']]], ['--title', 'Shop']);
    const notes = `${read(ws, 'notes.md')}\nOwner note that stays.\n`;
    fs.writeFileSync(path.join(ws, 'notes.md'), notes);
    fs.mkdirSync(path.join(ws, '.claude-memory'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.claude-memory', 'MEMORY.md'), '- a memory\n');
    const settingsBefore = read(ws, '.claude', 'settings.json');
    const ruleBefore = read(ws, '.claude', 'rules', 'shop-api.md');
    const before = tree(ws);
    const dry = json(['promote', 'shop', '--dry-run']);
    it('--dry-run: exit 0, nothing touched, no lock', () => {
      assert.strictEqual(dry.code, 0, dry.all);
      assert.strictEqual(dry.doc.dryRun, true);
      assert.deepStrictEqual(tree(ws), before);
    });
    const run = json(['promote', 'shop']);
    it('promoted: exit 0, the same document as the dry run', () => {
      assert.strictEqual(run.code, 0, run.all);
      assert.deepStrictEqual(run.doc.result, dry.doc.result);
      assert.deepStrictEqual(run.doc.warnings, dry.doc.warnings);
    });
    it('the result: the task it was, what is rewritten, made, dropped, the task files kept', () => {
      const r = run.doc.result;
      assert.deepStrictEqual([r.workspace, r.slug, r.kind, r.legacy, r.title, r.changed], [ws, 'shop', 'task', false, 'Shop', true]);
      assert.deepStrictEqual(r.rewrites, ['.claude/ws-kind', '.claude/wsg.json', 'AGENTS.md', 'README.md'].map((f) => path.join(ws, f)));
      assert.ok(r.creates.includes(path.join(ws, 'knowledge.md')) && r.creates.includes(path.join(ws, 'tasks.md')));
      assert.deepStrictEqual(r.dropped, ['status']);
      assert.deepStrictEqual(r.taskFiles, ['checklist.md', 'mr-target-branch.txt', 'repo'].map((f) => path.join(ws, f)));
      assert.deepStrictEqual([r.adopted, r.leftAlone, r.blockers], [[], [], { worktrees: [] }]);
    });
    it('the state: an epic, version 3, no status, the sources as they were', () => {
      const st = readState(ws);
      assert.deepStrictEqual([st.version, st.kind, st.slug, st.title, st.status], [3, 'epic', 'shop', 'Shop', undefined]);
      assert.strictEqual(st.sources.length, 1);
      assert.strictEqual(st.sources[0].name, 'shop-api');
      assert.strictEqual(read(ws, '.claude', 'ws-kind'), 'epic\n');
    });
    it('the owner\'s text, memory, settings and rules stay byte for byte', () => {
      assert.strictEqual(read(ws, 'notes.md'), notes);
      assert.strictEqual(read(ws, '.claude-memory', 'MEMORY.md'), '- a memory\n');
      assert.strictEqual(read(ws, '.claude', 'settings.json'), settingsBefore);
      assert.strictEqual(read(ws, '.claude', 'rules', 'shop-api.md'), ruleBefore);
      assert.strictEqual(fs.readlinkSync(path.join(ws, 'shop-api')), api);
    });
    it('the epic files are made, the README and AGENTS.md lines say epic', () => {
      for (const f of ['tasks.md', 'decisions.md', 'knowledge.md', '.claude/rules/epic-knowledge.md', ...T.EPIC_SKILLS.map((n) => `.claude/skills/${n}/SKILL.md`)]) assert.ok(fs.existsSync(path.join(ws, f)), f);
      assert.match(read(ws, 'README.md'), /^Workspace kind: \*\*epic\*\*\.$/m);
      const agents = read(ws, 'AGENTS.md');
      assert.match(agents, /^This is an epic workspace, not a git repository/m);
      assert.match(agents, /<!-- wsg:epic-context -->/);
    });
    it('the intro line is the one a new epic gets', () => {
      const P = require(path.join(ROOT, 'lib', 'promote.js'));
      const fresh = make('fresh-epic', [], ['--kind', 'epic']);
      assert.ok(read(fresh, 'AGENTS.md').split('\n').includes(P.EPIC_INTRO));
    });
    const c = checkOf(ws);
    it('wsg check: no FAIL, the epic section', () => {
      assert.deepStrictEqual(fails(c), []);
      assert.strictEqual(c.code, 0, c.all);
    });
    it('a task can be made in it, and it is listed as an epic', () => {
      const n = wsg(['new', 'pay', '--epic', 'shop', '--no-launch']);
      assert.strictEqual(n.code, 0, n.all);
      assert.match(read(ws, 'tasks.md'), /pay/);
      const l = json(['list']).doc.result.workspaces.find((x) => x.slug === 'shop');
      assert.deepStrictEqual([l.kind, l.tasks.map((x) => x.slug)], ['epic', ['pay']]);
    });
    const again = json(['promote', 'shop']);
    it('again: refused, it is an epic already', () => {
      assert.strictEqual(again.code, 2, again.all);
      assert.match(again.doc.error.message, /is an epic already/);
    });
  }

  console.log('\na task without code, a spec task, --title');
  {
    const docs = makeRepo('shop-docs');
    const ws = make('digest', [[docs, ['--link']]], ['--no-code', '--spec']);
    const ruleRel = path.join('.claude', 'rules', 'shop-docs.md');
    const st0 = readState(ws);
    it('the read-only rule is wsg\'s own before', () => assert.strictEqual(read(ws, ruleRel), T.ruleMd(st0.sources[0], { noCode: true })));
    const agentsFile = path.join(ws, 'AGENTS.md');
    fs.writeFileSync(agentsFile, read(ws, 'AGENTS.md').replace(/^(This is a task workspace[^\n]*)$/m, '$1\r'));
    const r = json(['promote', 'digest', '--title', 'Shop digest']);
    it('the generated no-code intro with CRLF becomes the standard epic intro', () => {
      const { EPIC_INTRO } = require(path.join(ROOT, 'lib', 'promote.js'));
      assert.ok(read(ws, 'AGENTS.md').split('\n').includes(EPIC_INTRO + '\r'));
    });
    it('promoted: noCode and spec dropped and said, --title taken', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.deepStrictEqual(r.doc.result.dropped, ['status', 'noCode', 'spec']);
      const st = readState(ws);
      assert.deepStrictEqual([st.kind, st.noCode, st.spec, st.title], ['epic', undefined, undefined, 'Shop digest']);
    });
    it('wsg\'s own read-only rule becomes the epic\'s link rule, listed as rewritten', () => {
      assert.strictEqual(read(ws, ruleRel), T.ruleMd(readState(ws).sources[0], { epic: true }));
      assert.ok(r.doc.result.rewrites.includes(path.join(ws, ruleRel)));
    });
    it('spec.md, plan.md and checklist.md stay, named', () => {
      for (const f of ['spec.md', 'plan.md', 'checklist.md']) assert.ok(r.doc.result.taskFiles.includes(path.join(ws, f)), f);
      assert.ok(r.doc.warnings.some((w) => /files only a task has stay as plain files: checklist\.md, spec\.md, plan\.md/.test(w)));
    });
    it('wsg check: no FAIL', () => assert.deepStrictEqual(fails(checkOf(ws)), []));

    const ws2 = make('digest-2', [[docs, ['--link']]], ['--no-code']);
    fs.appendFileSync(path.join(ws2, ruleRel), '- my own note\n');
    const edited = read(ws2, ruleRel);
    const r2 = json(['promote', 'digest-2']);
    it('an edited read-only rule is kept as it is, and named', () => {
      assert.strictEqual(r2.code, 0, r2.all);
      assert.strictEqual(read(ws2, ruleRel), edited);
      assert.ok(r2.doc.warnings.some((w) => /shop-docs\.md was edited and may still say the repository is read only/.test(w)));
    });
    const ws3 = make('closed-one');
    assert.strictEqual(wsg(['close', 'closed-one']).code, 0);
    const r3 = json(['promote', 'closed-one', '--dry-run']);
    it('a done task: status and closed dropped, a warning', () => {
      assert.strictEqual(r3.code, 0, r3.all);
      assert.deepStrictEqual(r3.doc.result.dropped, ['status', 'closed']);
      assert.ok(r3.doc.warnings.some((w) => /closed-one is done: an epic has no status/.test(w)));
      assert.strictEqual(readState(ws3).status, 'done');
    });
  }

  console.log('\na workspace of wsg 0.1 shaped like a hand-made task workspace');
  {
    const web = makeRepo('acme-web');
    const app = makeRepo('acme-app');
    const docs = path.join(tmp, 'acme-docs');
    fs.mkdirSync(docs);
    const ws = path.join(wsRoot, 'acme');
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.learnings'));
    fs.writeFileSync(path.join(ws, '.claude', 'ws-kind'), 'task\n');
    fs.symlinkSync(web, path.join(ws, 'web'));
    fs.symlinkSync(app, path.join(ws, 'acme-app'));
    fs.symlinkSync('web', path.join(ws, 'repo'));
    fs.symlinkSync(docs, path.join(ws, 'docs'));
    const settings = '{\n  "permissions": {\n    "deny": ["Bash(git push*)"]\n  }\n}\n';
    fs.writeFileSync(path.join(ws, '.claude', 'settings.json'), settings);
    const agents = ['# acme — shop workspace', '', '<!-- Owner context --> ## Why', '',
      'This is a task workspace, not a git repository. Repositories inside: 2.', '',
      '## Why', '', 'Build the shop.', '', '## Layout', '', '- `web` — symlink to the checkout.', '',
      '## Verification', '', '- web: `npm test`', '', '## Owner rules (override tool defaults)', '', '1. Ask first.', ''].join('\n');
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), agents);
    fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# acme\n\n@AGENTS.md\n\n## Claude Code only\n\n- Task memory lives in `.claude-memory/`.\n');
    fs.writeFileSync(path.join(ws, 'README.md'), '# acme\n\nHand-written.\n');
    fs.writeFileSync(path.join(ws, 'notes.md'), '# Notes\n\n## Current context\n\nWork in progress.\n');
    const before = tree(ws);
    const dry = json(['promote', 'acme', '--dry-run']);
    it('--dry-run: nothing touched, every file it rewrites listed', () => {
      assert.strictEqual(dry.code, 0, dry.all);
      assert.deepStrictEqual(tree(ws), before);
      assert.deepStrictEqual(dry.doc.result.rewrites, ['.claude/ws-kind', '.claude/wsg.json', 'AGENTS.md', 'CLAUDE.md', 'README.md'].map((f) => path.join(ws, f)));
    });
    const run = json(['promote', 'acme']);
    it('promoted: exit 0, the same document as the dry run', () => {
      assert.strictEqual(run.code, 0, run.all);
      assert.deepStrictEqual(run.doc.result, dry.doc.result);
      assert.strictEqual(run.doc.result.legacy, true);
    });
    it('a fresh epic state, its title from AGENTS.md, slug the folder name', () => {
      const st = readState(ws);
      assert.deepStrictEqual([st.version, st.kind, st.slug, st.title], [3, 'epic', 'acme', 'acme — shop workspace']);
      assert.strictEqual(read(ws, '.claude', 'ws-kind'), 'epic\n');
    });
    it('the repository symlinks become link sources by their own names, taken as they are', () => {
      const st = readState(ws);
      assert.deepStrictEqual(st.sources.map((s) => [s.name, s.path, s.mode, s.reference]), [['acme-app', app, 'link', false], ['web', web, 'link', false]]);
      assert.deepStrictEqual(run.doc.result.adopted, [{ name: 'acme-app', path: app }, { name: 'web', path: web }]);
      assert.strictEqual(fs.readlinkSync(path.join(ws, 'web')), web);
      assert.ok(fs.existsSync(path.join(ws, '.claude', 'rules', 'web.md')));
    });
    it('the repo pointer and a symlink outside git stay as they are, listed', () => {
      assert.strictEqual(fs.readlinkSync(path.join(ws, 'repo')), 'web');
      assert.strictEqual(fs.readlinkSync(path.join(ws, 'docs')), docs);
      assert.deepStrictEqual(run.doc.result.leftAlone, [{ name: 'docs', target: docs }, { name: 'repo', target: 'web' }]);
    });
    it('the hand-written settings.json is untouched, and said', () => {
      assert.strictEqual(read(ws, '.claude', 'settings.json'), settings);
      assert.ok(run.doc.warnings.some((w) => /settings\.json is yours and stays as it is/.test(w)));
    });
    it('the blocks go in at the anchors, the owner\'s text around them stays', () => {
      const now = read(ws, 'AGENTS.md');
      assert.match(now, /^<!-- Owner context --> ## Why\n\nThis is an epic workspace, not a git repository\. Repositories inside: 2\.\n<!-- wsg:advisor -->/m);
      assert.match(now, /^## Layout\n<!-- wsg:layout -->/m);
      assert.match(now, /## Owner rules \(override tool defaults\)\n\n1\. Ask first\.\n/);
      assert.match(read(ws, 'CLAUDE.md'), /^## Claude Code only\n<!-- wsg:advisor -->/m);
      assert.match(read(ws, 'notes.md'), /Work in progress\./);
    });
    it('wsg check: no FAIL, and no FILL IN warning over the hand-written commands', () => {
      const c = checkOf(ws);
      assert.deepStrictEqual(fails(c), []);
      const items = c.doc.result.sections.flatMap((x) => x.items);
      assert.ok(!items.some((i) => /FILL IN/.test(i.text)), JSON.stringify(items));
      assert.ok(items.some((i) => i.level === 'ok' && /verification command/.test(i.text)));
      assert.doesNotMatch(read(ws, 'AGENTS.md'), /FILL IN/);
    });
    it('wsg refresh keeps the verification block empty under the owner\'s commands', () => {
      const r = wsg(['refresh', '--ws', ws]);
      assert.strictEqual(r.code, 0, r.all);
      assert.doesNotMatch(read(ws, 'AGENTS.md'), /FILL IN/);
    });
    it('a task of it gets the epic\'s Owner rules', () => {
      const n = wsg(['new', 'cart', '--epic', 'acme', '--no-launch']);
      assert.strictEqual(n.code, 0, n.all);
      assert.match(read(ws, 'cart', 'AGENTS.md'), /1\. Ask first\./);
    });
  }

  console.log('\nthe workspace declaration in edited AGENTS.md');
  {
    const ws = make('edited-heading');
    const agents = read(ws, 'AGENTS.md');
    const { EPIC_INTRO, TASK_INTROS } = require(path.join(ROOT, 'lib', 'promote.js'));
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), agents.replace(TASK_INTROS[0], '## Workspace\n\n' + TASK_INTROS[0]));
    const run = json(['promote', 'edited-heading']);
    it('the generated declaration still becomes the epic intro after an owner heading', () => {
      assert.strictEqual(run.code, 0, run.all);
      assert.ok(read(ws, 'AGENTS.md').includes('## Workspace\n\n' + EPIC_INTRO + '\n'));
    });
  }
  {
    const slug = 'edited-comment';
    const ws = path.join(wsRoot, slug);
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.claude', 'settings.json'), '{}\n');
    const example = ['```md', '<!--', 'This is a task workspace in a fenced example.', '```'].join('\n');
    const comment = ['<!--', 'This is a task workspace in a comment.', '~~~', '-->'].join('\n');
    const inlineComment = ['Owner note <!--', '2. An example', 'This is a task workspace in an inline comment.', '-->'].join('\n');
    const intro = 'This is a task workspace, not a git repository. Repositories inside: 2.';
    const body = '## Why\n\nThis is a task workspace in body text.';
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), ['# Shop', example, comment, inlineComment, intro, body, ''].join('\n\n'));
    fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# Shop\n\n@AGENTS.md\n');
    const run = json(['promote', slug]);
    it('ignores examples and places the advisor block after the visible legacy declaration', () => {
      assert.strictEqual(run.code, 0, run.all);
      const now = read(ws, 'AGENTS.md');
      assert.ok(now.includes([example, comment, inlineComment, intro.replace('a task workspace', 'an epic workspace')].join('\n\n')));
      assert.ok(now.includes('Repositories inside: 2.\n<!-- wsg:advisor -->'));
      assert.ok(now.includes(body));
      assert.deepStrictEqual(fails(checkOf(ws)), []);
    });
  }

  {
    const { fencedLines, replaceBlock } = require(path.join(ROOT, 'lib', 'generate.js'));
    it('literal or container-scoped comment openers do not hide a real unclosed fence', () => {
      const examples = [['    <!--'], [String.raw`\<!--`], ['> <!--'], ['## Shop <!--'], ['- Example', '  <!--'], ['Owner note <!--']];
      const declaration = 'This is a task workspace, not a git repository. Repositories inside: 2.';
      for (const example of examples) {
        const lines = ['# Shop', '', ...example, '', declaration, '', '~~~'];
        const scan = fencedLines(lines);
        assert.strictEqual(scan.comments.has(lines.indexOf(declaration)), false, example.join('\n'));
        assert.deepStrictEqual(scan.open, { line: lines.length, closer: '~~~' }, example.join('\n'));
      }
    });
    it('a thematic break ends the paragraph before an inline comment can continue', () => {
      const scan = fencedLines(['Owner note <!--', '***', 'This is a task workspace.', 'End -->']);
      assert.strictEqual(scan.comments.size, 0);
    });
    it('restoring an advisor block preserves the inline comment and trailing whitespace', () => {
      const intro = 'This is an epic workspace. <!-- Owner note\nKeep this comment together.\n-->  \n\n';
      const restored = replaceBlock(intro, 'AGENTS.md', 'advisor', ['Ask the advisor.'], /^This is an epic workspace/);
      assert.ok(restored.restored);
      const block = '<!-- wsg:advisor -->\nAsk the advisor.\n<!-- /wsg:advisor -->\n';
      assert.strictEqual(restored.text.replace(block, ''), intro);
      assert.ok(restored.text.includes('-->  \n' + block));
    });
  }

  console.log('\nlegacy: links, settings, an unknown kind, no .claude');
  {
    const shop = makeRepo('shopfront');
    const ws = path.join(wsRoot, 'hand');
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# hand\n\n@AGENTS.md\n');
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# hand\n\n## Why\n\nBy hand.\n');
    // Two links to one repository: the one named like its folder is taken. A name no source may have stays.
    fs.symlinkSync(shop, path.join(ws, 'alias'));
    fs.symlinkSync(shop, path.join(ws, 'shopfront'));
    fs.symlinkSync(makeRepo('odd'), path.join(ws, 'odd name'));
    const before = tree(ws);
    const dry = json(['promote', 'hand', '--dry-run']);
    it('no .claude yet: planned, ws-kind and the state made in a new .claude', () => {
      assert.strictEqual(dry.code, 0, dry.all);
      assert.ok(dry.doc.result.creates.includes(path.join(ws, '.claude', 'ws-kind')));
      assert.deepStrictEqual(tree(ws), before);
    });
    it('the link named like the repository is taken, the alias and the odd name stay', () => {
      assert.deepStrictEqual(dry.doc.result.adopted, [{ name: 'shopfront', path: shop }]);
      assert.deepStrictEqual(dry.doc.result.leftAlone.map((x) => x.name), ['alias', 'odd name']);
    });
    {
      const P = require(path.join(ROOT, 'lib', 'promote.js'));
      const G = require(path.join(ROOT, 'lib', 'generate.js'));
      const plan = P.planPromote(fs.realpathSync.native(ws), null, {}, { WS_ROOT: wsRoot });
      const realRender = G.computeRender;
      G.computeRender = () => { throw new Error('injected failure'); };
      let err = null;
      const log = console.log;
      const write = process.stderr.write;
      console.log = () => {};
      process.stderr.write = () => true;
      try { await P.applyPromote(plan).catch((e) => { err = e; }); } finally { G.computeRender = realRender; console.log = log; process.stderr.write = write; }
      it('a failure after .claude, the epic files and the adopted rule are made: all of it gone', () => {
        assert.ok(plan.dirs.includes('.claude') && Object.keys(plan.files).includes(path.join('.claude', 'rules', 'shopfront.md')));
        assert.strictEqual(err && err.rollback, 'done', err && err.message);
        assert.deepStrictEqual(tree(ws), before);
      });
    }
    const run = json(['promote', 'hand']);
    it('then promoted: the state and ws-kind in .claude, the source registered', () => {
      assert.strictEqual(run.code, 0, run.all);
      assert.deepStrictEqual(readState(ws).sources.map((x) => x.name), ['shopfront']);
      assert.strictEqual(read(ws, '.claude', 'ws-kind'), 'epic\n');
      assert.ok(run.doc.warnings.some((w) => /^no \.claude\/settings\.json: create it \(see wsg check\), then run wsg refresh/.test(w)), JSON.stringify(run.doc.warnings));
      assert.ok(!run.doc.warnings.some((w) => /settings\.json is yours/.test(w)));
      assert.ok(!fs.existsSync(path.join(ws, '.claude', 'settings.json')));
    });

    const odd = path.join(wsRoot, 'odd-kind');
    fs.mkdirSync(path.join(odd, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(odd, '.claude', 'ws-kind'), 'story\n');
    fs.writeFileSync(path.join(odd, 'CLAUDE.md'), '# odd\n');
    const k = json(['promote', 'odd-kind']);
    it('an unknown ws-kind: refused', () => {
      assert.strictEqual(k.code, 2, k.all);
      assert.match(k.doc.error.message, /ws-kind says story/);
    });

    const co = path.join(wsRoot, 'hand-co');
    fs.mkdirSync(path.join(co, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(co, '.claude', 'ws-kind'), 'task\n');
    git(tmp, ['clone', '-q', shop, path.join(co, 'checkout')]);
    const c = json(['promote', 'hand-co']);
    it('a checkout in a legacy folder: refused without the wsg move hint', () => {
      assert.strictEqual(c.code, 2, c.all);
      assert.match(c.doc.error.message, /hand-co has checkouts \(checkout\)/);
      assert.doesNotMatch(c.doc.error.message, /wsg move/);
    });

    for (const [what, write] of [
      ['settings.json that is no JSON', (dir) => fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{ not json')],
      ['settings.json that is a JSON list', (dir) => fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '[]\n')],
      ['a symlinked settings.json', (dir) => {
        const theirs = path.join(tmp, `theirs-${path.basename(dir)}.json`);
        fs.writeFileSync(theirs, '{}\n');
        fs.rmSync(path.join(dir, '.claude', 'settings.json'));
        fs.symlinkSync(theirs, path.join(dir, '.claude', 'settings.json'));
      }],
    ]) {
      const slug = `set-${passed}`;
      const w = make(slug);
      write(w);
      const settingsBefore = fs.lstatSync(path.join(w, '.claude', 'settings.json')).isSymbolicLink()
        ? fs.readlinkSync(path.join(w, '.claude', 'settings.json')) : read(w, '.claude', 'settings.json');
      const r = json(['promote', slug]);
      it(`${what}: promoted all the same, a warning, the file as it was`, () => {
        assert.strictEqual(r.code, 0, r.all);
        assert.ok(r.doc.warnings.some((x) => /settings\.json can't be read/.test(x)), JSON.stringify(r.doc.warnings));
        const now = fs.lstatSync(path.join(w, '.claude', 'settings.json')).isSymbolicLink()
          ? fs.readlinkSync(path.join(w, '.claude', 'settings.json')) : read(w, '.claude', 'settings.json');
        assert.strictEqual(now, settingsBefore);
        assert.strictEqual(readState(w).kind, 'epic');
      });
    }
  }

  console.log('\nthe verification block under the owner\'s own commands');
  {
    const G = require(path.join(ROOT, 'lib', 'generate.js'));
    const st = { version: 2, kind: 'task', sources: [{ name: 'api', path: '/x', mode: 'link', reference: false, target: 'main', verify: '' }] };
    const body = (section) => `# T\n\n## Verification\n\n${section}\n## Next\n`;
    const rendered = (section) => {
      const dir = fs.mkdtempSync(path.join(tmp, 'vb-'));
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), body(section));
      const r = G.computeRender(dir, st, null, [], { skipSettings: true });
      return (r.files.find((f) => f.rel === 'AGENTS.md') || {}).body || '';
    };
    it('a fenced "# run all" before the owner\'s bullets does not bring FILL IN back', () =>
      assert.doesNotMatch(rendered('```bash\n# run all\nnpm test\n```\n\n- api: `npm test`\n'), /FILL IN/));
    it('a bullet only inside a fence is no command of the owner\'s: FILL IN stays', () =>
      assert.match(rendered('```\n- api: npm test\n```\n'), /FILL IN/));
    it('without bullets of its own: FILL IN stays', () => assert.match(rendered('Run the tests.\n'), /FILL IN/));
  }

  console.log('\nrefusals: exit 2, nothing touched');
  {
    const repo = makeRepo('fair-api');
    make('fair', [], ['--kind', 'epic']);
    make('stall', [], ['--epic', 'fair']);
    make('wt', [[repo, ['--branch', 'feat/wt']]]);
    const teamWs = make('crew');
    assert.strictEqual(wsg(['team', 'fullstack', '--ws', teamWs]).code, 0);
    const gone = make('gone');
    writeState(gone, { ...readState(gone), version: 4, status: 'archived', archive: { date: '2026-11-02', previous: { status: 'open', closed: null }, sources: [] } });
    const linked = make('linked');
    const outside = path.join(tmp, 'outside-knowledge.md');
    fs.writeFileSync(outside, 'theirs\n');
    fs.symlinkSync(outside, path.join(linked, 'knowledge.md'));
    const linked2 = make('linked-rules');
    const shared = path.join(tmp, 'shared-rules');
    fs.mkdirSync(shared);
    fs.renameSync(path.join(linked2, '.claude', 'rules'), path.join(shared, 'rules'));
    fs.symlinkSync(path.join(shared, 'rules'), path.join(linked2, '.claude', 'rules'));
    const bad = path.join(wsRoot, 'Bad_Name');
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, 'CLAUDE.md'), '# bad\n');
    // <task>/<source> looks like <epic>/<task>: a folder of notes linked into a task is no workspace in WS_ROOT.
    const target = path.join(tmp, 'promote-target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'CLAUDE.md'), '# notes\n');
    make('host', [[target, ['--reference']]]);
    const before = { root: tree(wsRoot), target: tree(target), shared: tree(shared) };
    for (const [what, args, re] of [
      ['an epic', ['promote', 'fair'], /fair is an epic already/],
      ['a task of an epic', ['promote', 'fair/stall'], /fair\/stall is a task of an epic: .*wsg move fair\/stall --out/],
      ['a task with a worktree', ['promote', 'wt'], /wt has worktrees \(fair-api\): .*wsg move wt --epic <name> --new-epic/],
      ['a task with a team', ['promote', 'crew'], /crew has a team \(fullstack\)/],
      ['an archived task', ['promote', 'gone'], /gone is archived: wsg unarchive gone first/],
      ['a symlink where it would make a file', ['promote', 'linked'], /knowledge\.md in .* is a symlink/],
      ['a symlinked directory on the way', ['promote', 'linked-rules'], /\.claude\/rules in .* is a symlink/],
      ['a folder name that is no slug', ['promote', bad], /slug Bad_Name/],
      ['a folder not right in WS_ROOT', ['promote', path.join(wsRoot, 'host', 'promote-target')], /is not right in WS_ROOT/],
    ]) {
      const r = json(args);
      it(`${what}: exit 2, invalid_input`, () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.strictEqual(r.doc.error.code, 'invalid_input');
        assert.match(r.doc.error.message, re);
      });
    }
    it('the same refusal with --dry-run, and plain on stderr', () => {
      const d = json(['promote', 'wt', '--dry-run']);
      assert.strictEqual(d.code, 2, d.all);
      assert.deepStrictEqual(d.doc.result.blockers.worktrees, [{ name: 'fair-api', path: path.join(wsRoot, 'wt', 'fair-api') }]);
      const p = wsg(['promote', 'wt']);
      assert.strictEqual(p.code, 2, p.all);
      assert.match(p.err, /^wsg: wt has worktrees/m);
    });
    it('nothing touched anywhere, the source behind the link neither', () => {
      assert.deepStrictEqual(tree(wsRoot), before.root);
      assert.deepStrictEqual(tree(target), before.target);
      assert.deepStrictEqual(tree(shared), before.shared);
    });
    const busy = make('busy');
    fs.writeFileSync(path.join(busy, '.claude', 'wsg.lock'), JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
    const b = wsg(['promote', 'busy']);
    it('another wsg command holds the lock: exit 2, nothing changed', () => {
      assert.strictEqual(b.code, 2, b.all);
      assert.match(b.err, /another wsg command is running/);
      assert.strictEqual(readState(busy).kind, 'task');
    });
    fs.rmSync(path.join(busy, '.claude', 'wsg.lock'));
    it('--title without a value, a second task, an unknown flag: exit 2', () => {
      for (const args of [['promote', 'busy', '--title'], ['promote', 'busy', 'other'], ['promote', 'busy', '--skill', 'x']]) assert.strictEqual(wsg(args).code, 2, args.join(' '));
    });
    it('from inside the task, without a name', () => {
      const r = json(['promote', '--dry-run'], { cwd: path.join(busy, '.claude') });
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(r.doc.result.workspace, busy);
    });
  }

  console.log('\na failure or a stop signal during the apply: everything put back');
  {
    const P = require(path.join(ROOT, 'lib', 'promote.js'));
    const G = require(path.join(ROOT, 'lib', 'generate.js'));
    const cfg = { WS_ROOT: wsRoot, WSG_GLOBAL_MEMORY: '', WSG_PARENT_CONTEXT: '' };
    const quiet = async (fn) => {
      const log = console.log;
      const err = process.stderr.write;
      console.log = () => {};
      process.stderr.write = () => true;
      try { return await fn(); } finally { console.log = log; process.stderr.write = err; }
    };
    const docs = makeRepo('rope-docs');
    for (const [what, patch] of [
      ['a failure in the render', (real) => ({ computeRender: () => { throw new Error('injected failure'); } }), 'task'],
      ['a stop signal during the apply', (real) => ({ computeRender: (...a) => { process.emit('SIGINT'); return real.computeRender(...a); } })],
    ]) {
      const slug = `rope-${passed}`;
      const ws = make(slug, [[docs, ['--link']]], ['--no-code']);
      const before = tree(ws);
      const plan = P.planPromote(ws, W.readState(ws), {}, cfg);
      const real = { computeRender: G.computeRender };
      Object.assign(G, patch(real));
      let err = null;
      try {
        await quiet(async () => { try { await P.applyPromote(plan); } catch (e) { err = e; } });
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
      it(`${what}: the task as it was, byte for byte, no directory left`, () => assert.deepStrictEqual(tree(ws), before));
      const again = json(['promote', slug]);
      it(`${what}: run again, it goes through`, () => {
        assert.strictEqual(again.code, 0, again.all);
        assert.strictEqual(readState(ws).kind, 'epic');
      });
    }
  }

  console.log('\nwsg add --link of a symlink that is there already');
  {
    const api = makeRepo('cart-api');
    const other = makeRepo('cart-other');
    const ws = make('cart-task');
    fs.symlinkSync(api, path.join(ws, 'cart-api'));
    const plan = json(['add', api, '--link', '--ws', ws, '--dry-run']);
    it('--dry-run: the plan says it is taken as it is, the link is no file it writes', () => {
      assert.strictEqual(plan.code, 0, plan.all);
      assert.ok(plan.doc.result.notes.includes('cart-api is a symlink to it already: registered as it is'), plan.out);
      assert.ok(!plan.doc.result.files.includes(path.join(ws, 'cart-api')));
      assert.ok(plan.doc.result.files.includes(path.join(ws, '.claude', 'rules', 'cart-api.md')));
    });
    const r = json(['add', api, '--link', '--ws', ws]);
    it('registered: exit 0, the link untouched, a rule and the state', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(fs.readlinkSync(path.join(ws, 'cart-api')), api);
      assert.deepStrictEqual(readState(ws).sources.map((s) => [s.name, s.path, s.mode]), [['cart-api', api, 'link']]);
      assert.strictEqual(readState(ws).sources[0].adopt, undefined);
      assert.ok(fs.existsSync(path.join(ws, '.claude', 'rules', 'cart-api.md')));
    });
    const ws2 = make('cart-task-2');
    fs.symlinkSync(other, path.join(ws2, 'cart-api'));
    const before2 = tree(ws2);
    const r2 = json(['add', api, '--link', '--ws', ws2]);
    it('a symlink of that name to another directory: refused, nothing touched', () => {
      assert.strictEqual(r2.code, 2, r2.all);
      assert.match(r2.doc.error.message, /cart-api already exists in the workspace/);
      assert.deepStrictEqual(tree(ws2), before2);
    });
    const ws3 = make('cart-task-3');
    fs.symlinkSync(api, path.join(ws3, 'cart-api'));
    const r3 = json(['add', api, '--branch', 'feat/x', '--ws', ws3]);
    it('the same link, asked for a worktree: refused', () => {
      assert.strictEqual(r3.code, 2, r3.all);
      assert.match(r3.doc.error.message, /cart-api already exists in the workspace/);
    });
    const ep = make('cart-epic', [], ['--kind', 'epic']);
    fs.symlinkSync(api, path.join(ep, 'cart-api'));
    const r4 = json(['add', api, '--ws', ep]);
    it('in an epic, where a repository is a link by default: registered as it is', () => {
      assert.strictEqual(r4.code, 0, r4.all);
      assert.strictEqual(readState(ep).sources[0].name, 'cart-api');
    });
  }

  finished = true;
  console.log(failed === 0 ? `\n${passed} checks passed\n` : `\nfailed: ${failed}, ${passed} passed\n`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  console.log(`\nFAIL  ${e.stack || e}`);
  process.exitCode = 1;
});
