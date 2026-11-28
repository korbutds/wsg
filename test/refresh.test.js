'use strict';

// wsg refresh as one transaction: a write that fails puts back what it wrote already and answers
// step_failed (exit 1), not invalid_input. Every command runs in a child process with its own HOME,
// WS_ROOT and config. Nothing here needs git, the network or a real agent.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.WSG_LANG = 'en';

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-refresh-')));
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
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

let failed = 0;
let skipped = 0;
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
  assert.strictEqual(wsg(['new', 'cart', '--no-launch']).code, 0);
  const cart = path.join(wsRoot, 'cart');
  const agents = path.join(cart, 'AGENTS.md');
  const readme = path.join(cart, 'README.md');
  const good = { agents: read(agents), readme: read(readme) };
  // Both files lose a block by hand, so a refresh writes AGENTS.md first, then README.md.
  const broken = {
    agents: good.agents.replace(/<!-- wsg:advisor -->\n[\s\S]*?<!-- \/wsg:advisor -->\n/, ''),
    readme: good.readme.replace(/<!-- wsg:sources -->\n[\s\S]*?<!-- \/wsg:sources -->\n/, ''),
    // One marker of a pair left: the render refuses before the first write.
    unpaired: good.readme.replace('<!-- /wsg:sources -->\n', ''),
  };
  assert.notStrictEqual(broken.agents, good.agents);
  assert.notStrictEqual(broken.readme, good.readme);
  const breakBoth = () => {
    fs.chmodSync(readme, 0o644);
    fs.writeFileSync(agents, broken.agents);
    fs.writeFileSync(readme, broken.readme);
  };

  console.log('wsg refresh: a write that fails after the first one');
  if (process.getuid && process.getuid() === 0) skip('as root a read-only file is still writable');
  else {
    breakBoth();
    const plan = JSON.parse(wsg(['refresh', '--dry-run', '--ws', cart]).out);
    it('the dry run plans AGENTS.md before README.md', () => {
      assert.deepStrictEqual(plan.errors, []);
      assert.ok(plan.files.indexOf('AGENTS.md') >= 0 && plan.files.indexOf('AGENTS.md') < plan.files.indexOf('README.md'), plan.files.join(', '));
    });

    fs.chmodSync(readme, 0o444);
    const r = json(['refresh', '--ws', cart]);
    it('--json: step_failed, exit 1, rolled back, nothing kept', () => {
      assert.strictEqual(r.code, 1, r.all);
      assert.ok(r.doc, r.all);
      assert.strictEqual(r.doc.ok, false);
      assert.strictEqual(r.doc.error.code, 'step_failed');
      assert.strictEqual(r.doc.error.exitCode, 1);
      assert.strictEqual(r.doc.error.rollback, 'done');
      assert.deepStrictEqual(r.doc.error.kept, []);
      assert.match(r.doc.error.message, /README\.md/);
    });
    it('--json: each render warning once', () => {
      assert.strictEqual(r.doc.warnings.length, 2, r.doc.warnings.join('\n'));
      assert.strictEqual(new Set(r.doc.warnings).size, 2);
    });
    it('--json: AGENTS.md is put back as it was before the run', () => assert.strictEqual(read(agents), broken.agents));
    it('--json: README.md is untouched', () => assert.strictEqual(read(readme), broken.readme));

    const p = wsg(['refresh', '--ws', cart]);
    it('plain: exit 1, the rollback said on stderr', () => {
      assert.strictEqual(p.code, 1, p.all);
      assert.match(p.err, /Rolling back/);
      assert.match(p.err, /README\.md/);
      assert.doesNotMatch(p.out, /Updated:/);
      assert.doesNotMatch(p.all, /WARN/);
    });
    it('plain: AGENTS.md is put back as it was before the run', () => assert.strictEqual(read(agents), broken.agents));

    const dry = wsg(['refresh', '--dry-run', '--ws', cart]);
    it('--dry-run with a read-only file: exit 0, nothing written', () => {
      assert.strictEqual(dry.code, 0, dry.all);
      assert.strictEqual(read(agents), broken.agents);
    });

    fs.chmodSync(readme, 0o644);
    const okJson = json(['refresh', '--ws', cart, '--dry-run']);
    it('--json --dry-run: each warning once', () => assert.strictEqual(new Set(okJson.doc.warnings).size, okJson.doc.warnings.length));
    const ok = wsg(['refresh', '--ws', cart]);
    it('writable again: the refresh writes both and says the warnings', () => {
      assert.strictEqual(ok.code, 0, ok.all);
      assert.match(ok.all, /WARN AGENTS\.md: added the <!-- wsg:advisor --> block/);
      assert.strictEqual(read(agents), good.agents);
      assert.match(read(readme), /<!-- wsg:sources -->\n[\s\S]*<!-- \/wsg:sources -->\n/);
    });
  }

  console.log('wsg refresh: a render that fails before the first write stays invalid_input');
  {
    breakBoth();
    fs.writeFileSync(readme, broken.unpaired);
    const r = json(['refresh', '--ws', cart]);
    it('invalid_input, exit 2, rollback none', () => {
      assert.strictEqual(r.code, 2, r.all);
      assert.ok(r.doc, r.all);
      assert.strictEqual(r.doc.error.code, 'invalid_input');
      assert.strictEqual(r.doc.error.rollback, 'none');
      assert.match(r.doc.error.message, /wsg:sources/);
    });
    it('nothing written', () => {
      assert.strictEqual(read(agents), broken.agents);
      assert.strictEqual(read(readme), broken.unpaired);
    });
    const p = wsg(['refresh', '--ws', cart]);
    it('plain: exit 2, nothing written', () => {
      assert.strictEqual(p.code, 2, p.all);
      assert.strictEqual(read(agents), broken.agents);
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
