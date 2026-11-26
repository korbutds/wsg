'use strict';

// A task's description for the owner: description.md, `wsg describe`, `wsg new --description` and
// the description key of `wsg list --json`. Every command runs in a child process with its own HOME,
// WS_ROOT and config. Nothing here needs git, the network or a real agent.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.WSG_LANG = 'en';

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const W = require(path.join(ROOT, 'lib', 'workspace.js'));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-describe-')));
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
const wsg = (args, { cwd = tmp, env = {}, input } = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...ENV, ...env }, input, maxBuffer: 1 << 28 });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
};
const json = (args, opts) => {
  const r = wsg([...args, '--json'], opts);
  let doc = null;
  try { doc = JSON.parse(r.out); } catch { /* the test says so */ }
  return { ...r, doc };
};
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const listed = (slug, epic = null) => {
  const all = json(['list']).doc.result.workspaces;
  const top = all.find((w) => w.slug === (epic || slug));
  return epic ? top.tasks.find((w) => w.slug === slug) : top;
};

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

const RESULT_KEYS = ['workspace', 'task', 'epic', 'description', 'previous', 'changed', 'file'];

(async () => {
  assert.strictEqual(wsg(['new', 'shop', '--kind', 'epic', '--no-launch']).code, 0);
  assert.strictEqual(wsg(['new', 'pay', '--epic', 'shop', '--no-launch']).code, 0);
  assert.strictEqual(wsg(['new', 'cart', '--no-launch']).code, 0);
  const pay = path.join(wsRoot, 'shop', 'pay');
  const cart = path.join(wsRoot, 'cart');
  const payFile = path.join(pay, 'description.md');
  const cartFile = path.join(cart, 'description.md');

  console.log('lib/workspace.js');
  {
    it('description.md is reserved', () => assert.ok(W.RESERVED.includes('description.md')));
    it('one lookup: descriptionPath', () => assert.strictEqual(W.descriptionPath('/x/y'), path.join('/x/y', 'description.md')));
    it('the limit is 600', () => assert.strictEqual(W.DESCRIPTION_MAX, 600));
    it('normalized: CRLF, trim, blank lines squeezed', () => {
      assert.strictEqual(W.normalizeDescription('  a\r\n\r\n \r\n\r\nb\rc  \n'), 'a\n\nb\nc');
      assert.strictEqual(W.normalizeDescription('a\n\nb'), 'a\n\nb');
    });
    it('counted by code points', () => {
      assert.strictEqual(W.descriptionOf('𝔸'.repeat(600)).error, undefined);
      assert.match(W.descriptionOf('𝔸'.repeat(601)).error, /601 characters, at most 600/);
    });
  }

  console.log('wsg describe: read, set, clear');
  {
    const none = wsg(['describe', 'shop/pay']);
    it('none: exit 0, nothing on stdout, a hint on stderr', () => {
      assert.strictEqual(none.code, 0, none.all);
      assert.strictEqual(none.out, '');
      assert.match(none.err, /shop\/pay has no description/);
    });
    const noneJson = json(['describe', 'shop/pay']);
    it('none, --json: the keys, description null', () => {
      assert.strictEqual(noneJson.code, 0, noneJson.all);
      assert.strictEqual(noneJson.doc.command, 'describe');
      assert.deepStrictEqual(Object.keys(noneJson.doc.result), RESULT_KEYS);
      assert.deepStrictEqual(noneJson.doc.result, {
        workspace: pay, task: 'pay', epic: 'shop', description: null, previous: null, changed: false, file: payFile,
      });
    });
    const set = json(['describe', 'shop/pay', '--text', '  Payment fails at the shop checkout.\r\n\r\n\r\n\r\nIt should go through.  ']);
    it('set: exit 0, changed, normalized, written with a newline', () => {
      assert.strictEqual(set.code, 0, set.all);
      assert.strictEqual(set.doc.dryRun, false);
      assert.strictEqual(set.doc.result.changed, true);
      assert.strictEqual(set.doc.result.previous, null);
      assert.strictEqual(set.doc.result.description, 'Payment fails at the shop checkout.\n\nIt should go through.');
      assert.strictEqual(read(payFile), 'Payment fails at the shop checkout.\n\nIt should go through.\n');
    });
    it('no lock left behind', () => {
      assert.ok(!exists(path.join(pay, '.claude', 'wsg.lock')));
      assert.ok(!exists(path.join(wsRoot, 'shop', '.claude', 'wsg.lock')));
    });
    const plain = wsg(['describe', 'shop/pay']);
    it('read: the text alone on stdout', () => {
      assert.strictEqual(plain.code, 0, plain.all);
      assert.strictEqual(plain.out, 'Payment fails at the shop checkout.\n\nIt should go through.\n');
      assert.strictEqual(plain.err, '');
    });
    // The same text spelled otherwise: nothing written, the file as it was.
    fs.writeFileSync(payFile, 'Payment fails at the shop checkout.\r\n\r\nIt should go through.');
    const same = json(['describe', 'shop/pay', '--text', 'Payment fails at the shop checkout.\n\nIt should go through.']);
    it('the text it has: changed false, nothing written', () => {
      assert.strictEqual(same.code, 0, same.all);
      assert.strictEqual(same.doc.result.changed, false);
      assert.strictEqual(same.doc.result.previous, same.doc.result.description);
      assert.strictEqual(read(payFile), 'Payment fails at the shop checkout.\r\n\r\nIt should go through.');
    });
    it('the plain run says unchanged', () => assert.match(wsg(['describe', 'shop/pay', '--text', 'Payment fails at the shop checkout.\n\nIt should go through.']).out, /unchanged/));
    const byPath = json(['describe', pay]);
    it('addressed by path: the same task', () => {
      assert.strictEqual(byPath.code, 0, byPath.all);
      assert.strictEqual(byPath.doc.result.epic, 'shop');
      assert.strictEqual(byPath.doc.result.task, 'pay');
    });
    const fromFile = path.join(tmp, 'text.txt');
    fs.writeFileSync(fromFile, 'From a file.\n');
    const ff = wsg(['describe', 'cart', '--from', 'text.txt'], { cwd: tmp });
    it('--from FILE, relative to the current directory; a standalone task by slug', () => {
      assert.strictEqual(ff.code, 0, ff.all);
      assert.match(ff.out, /Description of cart written/);
      assert.strictEqual(read(cartFile), 'From a file.\n');
    });
    const fs1 = json(['describe', 'cart', '--from', '-'], { input: 'From stdin.\r\n' });
    it('--from -: stdin', () => {
      assert.strictEqual(fs1.code, 0, fs1.all);
      assert.strictEqual(fs1.doc.result.epic, null);
      assert.strictEqual(fs1.doc.result.previous, 'From a file.');
      assert.strictEqual(read(cartFile), 'From stdin.\n');
    });
    const missing = json(['describe', 'cart', '--from', path.join(tmp, 'nosuch.txt')]);
    it('--from a file that is not there: invalid input', () => {
      assert.strictEqual(missing.code, 2, missing.all);
      assert.match(missing.doc.error.message, /cannot read/);
    });
    fs.writeFileSync(path.join(tmp, 'big.txt'), 'x'.repeat(70 * 1024));
    const big = json(['describe', 'cart', '--from', path.join(tmp, 'big.txt')]);
    it('--from a file over the read ceiling: invalid input, nothing written', () => {
      assert.strictEqual(big.code, 2, big.all);
      assert.match(big.doc.error.message, /more than 65536 bytes/);
      assert.strictEqual(read(cartFile), 'From stdin.\n');
    });
    const bigIn = json(['describe', 'cart', '--from', '-'], { input: 'y'.repeat(70 * 1024) });
    it('stdin over the read ceiling: invalid input', () => assert.strictEqual(bigIn.code, 2, bigIn.all));

    const dry = json(['describe', 'cart', '--clear', '--dry-run']);
    it('--clear --dry-run: planned, nothing removed', () => {
      assert.strictEqual(dry.code, 0, dry.all);
      assert.strictEqual(dry.doc.dryRun, true);
      assert.strictEqual(dry.doc.result.changed, true);
      assert.strictEqual(dry.doc.result.description, null);
      assert.ok(exists(cartFile));
    });
    const dryPlain = wsg(['describe', 'cart', '--text', 'Other.', '--dry-run']);
    it('--text --dry-run plain: the plan as JSON, nothing written', () => {
      assert.strictEqual(dryPlain.code, 0, dryPlain.all);
      const p = JSON.parse(dryPlain.out);
      assert.deepStrictEqual(Object.keys(p), [...RESULT_KEYS, 'errors', 'warnings']);
      assert.strictEqual(p.description, 'Other.');
      assert.strictEqual(read(cartFile), 'From stdin.\n');
    });
    const clear = json(['describe', 'cart', '--clear']);
    it('--clear: the file removed', () => {
      assert.strictEqual(clear.code, 0, clear.all);
      assert.strictEqual(clear.doc.result.changed, true);
      assert.strictEqual(clear.doc.result.previous, 'From stdin.');
      assert.ok(!exists(cartFile));
    });
    const again = json(['describe', 'cart', '--clear']);
    it('--clear with none: nothing to do', () => {
      assert.strictEqual(again.code, 0, again.all);
      assert.strictEqual(again.doc.result.changed, false);
    });
    fs.writeFileSync(cartFile, '  \n\n');
    const ws1 = json(['describe', 'cart', '--clear']);
    it('--clear of a file with only whitespace removes it', () => {
      assert.strictEqual(ws1.doc.result.changed, true);
      assert.ok(!exists(cartFile));
    });
  }

  console.log('wsg describe: refusals');
  {
    fs.writeFileSync(payFile, 'Kept.\n');
    const refused = (name, args, re, opts) => {
      const r = json(args, opts);
      it(`${name}: exit 2, nothing written`, () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.strictEqual(r.doc.error.code, 'invalid_input');
        if (re) assert.match(r.doc.error.message, re);
        assert.strictEqual(read(payFile), 'Kept.\n');
      });
    };
    refused('--text and --clear', ['describe', 'shop/pay', '--text', 'a', '--clear'], /at most one of/);
    refused('--text and --from', ['describe', 'shop/pay', '--text', 'a', '--from', '-'], /at most one of/);
    refused('an empty text', ['describe', 'shop/pay', '--text', ' \r\n \n'], /empty/);
    refused('601 characters', ['describe', 'shop/pay', '--text', 'я'.repeat(601)], /601 characters, at most 600/);
    refused('no task', ['describe'], /name the task/);
    refused('an unknown task', ['describe', 'nosuch'], /no workspace/);
    refused('an epic', ['describe', 'shop', '--text', 'a'], /is an epic/);
    refused('an epic, read', ['describe', 'shop'], /is an epic/);
    refused('an unknown flag', ['describe', 'shop/pay', '--bogus']);
    const ok600 = json(['describe', 'shop/pay', '--text', 'я'.repeat(600)]);
    it('600 characters: written', () => {
      assert.strictEqual(ok600.code, 0, ok600.all);
      assert.strictEqual(read(payFile), `${'я'.repeat(600)}\n`);
    });
    fs.writeFileSync(payFile, 'Kept.\n');
    const tooLongPlain = wsg(['describe', 'shop/pay', '--text', 'я'.repeat(601)]);
    it('601 characters, plain: exit 2, said on stderr', () => {
      assert.strictEqual(tooLongPlain.code, 2);
      assert.match(tooLongPlain.err, /at most 600/);
    });

    const legacy = path.join(wsRoot, 'old');
    fs.mkdirSync(path.join(legacy, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(legacy, '.claude', 'ws-kind'), 'task\n');
    const lg = json(['describe', 'old', '--text', 'a']);
    it('a 0.1 workspace: invalid input, nothing written', () => {
      assert.strictEqual(lg.code, 2, lg.all);
      assert.match(lg.doc.error.message, /wsg 0\.1/);
      assert.ok(!exists(path.join(legacy, 'description.md')));
    });

    // A lock held by a live process: busy, nothing written. The task's, then the epic's.
    const held = JSON.stringify({ pid: process.pid, time: new Date().toISOString() });
    for (const [what, dir] of [['the task', pay], ['the epic', path.join(wsRoot, 'shop')]]) {
      const lockFile = path.join(dir, '.claude', 'wsg.lock');
      fs.writeFileSync(lockFile, held);
      const busy = json(['describe', 'shop/pay', '--text', 'New.']);
      const read1 = json(['describe', 'shop/pay']);
      const dryBusy = json(['describe', 'shop/pay', '--text', 'New.', '--dry-run']);
      fs.unlinkSync(lockFile);
      it(`${what}'s lock held: busy, exit 2, nothing written`, () => {
        assert.strictEqual(busy.code, 2, busy.all);
        assert.strictEqual(busy.doc.error.code, 'busy');
        assert.strictEqual(read(payFile), 'Kept.\n');
      });
      it(`${what}'s lock held: reading and a dry run take none`, () => {
        assert.strictEqual(read1.code, 0, read1.all);
        assert.strictEqual(dryBusy.code, 0, dryBusy.all);
      });
    }

    // A symlink there: never read through, never written through.
    const outside = path.join(tmp, 'outside.md');
    fs.writeFileSync(outside, 'Outside.\n');
    fs.unlinkSync(payFile);
    fs.symlinkSync(outside, payFile);
    const viaLink = json(['describe', 'shop/pay', '--text', 'New.']);
    const clearLink = json(['describe', 'shop/pay', '--clear']);
    const readLink = json(['describe', 'shop/pay']);
    const listLink = listed('pay', 'shop');
    it('a symlinked description.md: a write refused, the target untouched', () => {
      assert.strictEqual(viaLink.code, 2, viaLink.all);
      assert.match(viaLink.doc.error.message, /description\.md is there but can't be read \(symlink\)/);
      assert.strictEqual(clearLink.code, 2, clearLink.all);
      assert.strictEqual(read(outside), 'Outside.\n');
      assert.ok(fs.lstatSync(payFile).isSymbolicLink());
    });
    it('a symlinked description.md: reading gives null with a warning', () => {
      assert.strictEqual(readLink.code, 0, readLink.all);
      assert.strictEqual(readLink.doc.result.description, null);
      assert.match(readLink.doc.warnings.join('\n'), /symlink/);
    });
    it('a symlinked description.md: list gives null and a problem', () => {
      assert.strictEqual(listLink.description, null);
      assert.match(listLink.problems.join('\n'), /description\.md is there but can't be read \(symlink\)/);
    });
    fs.unlinkSync(payFile);
    fs.writeFileSync(payFile, 'Kept.\n');

    // A write that fails rolls back: the task's directory without write permission.
    if (process.getuid && process.getuid() === 0) skip('as root a directory without write permission is still writable');
    else {
      fs.chmodSync(pay, 0o555);
      let r;
      try { r = json(['describe', 'shop/pay', '--text', 'New.']); } finally { fs.chmodSync(pay, 0o755); }
      it('a write that fails: step_failed, exit 1, the file as it was', () => {
        assert.strictEqual(r.code, 1, r.all);
        assert.strictEqual(r.doc.error.code, 'step_failed');
        assert.strictEqual(r.doc.error.rollback, 'done');
        assert.strictEqual(read(payFile), 'Kept.\n');
      });
    }
  }

  console.log('wsg describe: an archived task');
  {
    assert.strictEqual(wsg(['new', 'frozen', '--no-launch']).code, 0);
    const frozen = path.join(wsRoot, 'frozen');
    assert.strictEqual(wsg(['describe', 'frozen', '--text', 'Before the archive.']).code, 0);
    const ar = wsg(['archive', 'frozen']);
    it('archived', () => assert.strictEqual(ar.code, 0, ar.all));
    const w = json(['describe', 'frozen', '--text', 'After.']);
    const c = json(['describe', 'frozen', '--clear', '--dry-run']);
    const r = json(['describe', 'frozen']);
    it('a write is refused, a dry run too: exit 2, nothing written', () => {
      assert.strictEqual(w.code, 2, w.all);
      assert.match(w.doc.error.message, /archived: its description is frozen/);
      assert.strictEqual(c.code, 2, c.all);
      assert.strictEqual(read(frozen, 'description.md'), 'Before the archive.\n');
    });
    it('reading works', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(r.doc.result.description, 'Before the archive.');
    });
  }

  console.log('wsg list: description');
  {
    fs.writeFileSync(payFile, '  Payment text.\r\n');
    it('a task with one: the text, trimmed', () => assert.strictEqual(listed('pay', 'shop').description, 'Payment text.'));
    it('a task without: null', () => {
      assert.ok(!exists(cartFile));
      assert.strictEqual(listed('cart').description, null);
    });
    fs.writeFileSync(cartFile, '');
    it('an empty file: null, no problem', () => {
      const e = listed('cart');
      assert.strictEqual(e.description, null);
      assert.deepStrictEqual(e.problems, []);
    });
    fs.writeFileSync(cartFile, ' \n\t\n');
    it('whitespace only: null', () => assert.strictEqual(listed('cart').description, null));
    fs.unlinkSync(cartFile);
    fs.writeFileSync(path.join(wsRoot, 'shop', 'description.md'), 'An epic file.\n');
    it('an epic: null, even with the file', () => assert.strictEqual(listed('shop').description, null));
    fs.unlinkSync(path.join(wsRoot, 'shop', 'description.md'));
    fs.mkdirSync(cartFile);
    it('a directory there: null and a problem', () => {
      const e = listed('cart');
      assert.strictEqual(e.description, null);
      assert.match(e.problems.join('\n'), /description\.md is there but can't be read \(not a file\)/);
    });
    fs.rmdirSync(cartFile);
    fs.writeFileSync(cartFile, 'z'.repeat(W.DESCRIPTION_READ_MAX + 1));
    it('a file over 64 KiB: null and a problem, not read', () => {
      const e = listed('cart');
      assert.strictEqual(e.description, null);
      assert.match(e.problems.join('\n'), /can't be read \(more than 65536 bytes\)/);
    });
    const overRead = json(['describe', 'cart']);
    const overWrite = json(['describe', 'cart', '--text', 'New.']);
    it('a file over 64 KiB: describe reads null with a warning, refuses a write', () => {
      assert.strictEqual(overRead.code, 0, overRead.all);
      assert.strictEqual(overRead.doc.result.description, null);
      assert.match(overRead.doc.warnings.join('\n'), /more than 65536 bytes/);
      assert.strictEqual(overWrite.code, 2, overWrite.all);
      assert.strictEqual(fs.statSync(cartFile).size, W.DESCRIPTION_READ_MAX + 1);
    });
    fs.unlinkSync(cartFile);
    if (process.getuid && process.getuid() === 0) skip('as root a file without read permission is still readable');
    else {
      fs.writeFileSync(cartFile, 'Hidden.\n');
      fs.chmodSync(cartFile, 0o000);
      let e;
      let r;
      let w;
      try {
        e = listed('cart');
        r = json(['describe', 'cart']);
        w = json(['describe', 'cart', '--text', 'New.']);
      } finally { fs.chmodSync(cartFile, 0o644); }
      it('an unreadable file: list gives null and a problem', () => {
        assert.strictEqual(e.description, null);
        assert.match(e.problems.join('\n'), /description\.md is there but can't be read \(EACCES\)/);
      });
      it('an unreadable file: describe reads null with a warning', () => {
        assert.strictEqual(r.code, 0, r.all);
        assert.strictEqual(r.doc.result.description, null);
        assert.match(r.doc.warnings.join('\n'), /EACCES/);
      });
      it('an unreadable file: a write refused, exit 2, the file as it was', () => {
        assert.strictEqual(w.code, 2, w.all);
        assert.match(w.doc.error.message, /EACCES/);
        assert.strictEqual(read(cartFile), 'Hidden.\n');
      });
      fs.unlinkSync(cartFile);
    }
    const plain = wsg(['list']);
    it('the plain list does not show it', () => assert.doesNotMatch(plain.out, /Payment text/));
  }

  console.log('wsg new --description');
  {
    const made = json(['new', 'refund', '--epic', 'shop', '--description', 'Refunds take a week.\r\n\r\n\r\nThey should take a day.', '--no-launch']);
    const refund = path.join(wsRoot, 'shop', 'refund');
    it('made: the file written, normalized, the result says it', () => {
      assert.strictEqual(made.code, 0, made.all);
      assert.strictEqual(made.doc.result.description, 'Refunds take a week.\n\nThey should take a day.');
      assert.strictEqual(read(refund, 'description.md'), 'Refunds take a week.\n\nThey should take a day.\n');
    });
    it('list gives it', () => assert.strictEqual(listed('refund', 'shop').description, 'Refunds take a week.\n\nThey should take a day.'));
    const without = json(['new', 'plain-b', '--no-launch']);
    it('without it: no file, description null', () => {
      assert.strictEqual(without.doc.result.description, null);
      assert.ok(!exists(path.join(wsRoot, 'plain-b', 'description.md')));
    });
    const dry = wsg(['new', 'dry-a', '--description', 'A dry one.', '--dry-run']);
    it('--dry-run: the plan names it, nothing made', () => {
      assert.strictEqual(dry.code, 0, dry.all);
      assert.strictEqual(JSON.parse(dry.out).description, 'A dry one.');
      assert.ok(!exists(path.join(wsRoot, 'dry-a')));
    });
    const dryJson = json(['new', 'dry-b', '--description', 'A dry one.', '--dry-run']);
    it('--dry-run --json: the result has it, nothing made', () => {
      assert.strictEqual(dryJson.code, 0, dryJson.all);
      assert.strictEqual(dryJson.doc.result.description, 'A dry one.');
      assert.ok(!exists(path.join(wsRoot, 'dry-b')));
    });
    for (const [name, args, re] of [
      ['601 characters', ['new', 'long-a', '--description', 'я'.repeat(601)], /at most 600/],
      ['an empty one', ['new', 'empty-a', '--description', '   '], /empty/],
      ['an epic', ['new', 'epic-a', '--kind', 'epic', '--description', 'An epic.'], /only for a task/],
    ]) {
      const r = json([...args, '--no-launch']);
      it(`${name}: refused, exit 2, nothing made`, () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.match(r.doc.error.message, re);
        assert.ok(!exists(path.join(wsRoot, args[1])));
      });
    }
  }

  console.log('agent rules');
  {
    const a = read(pay, 'AGENTS.md');
    it('the task AGENTS.md: read it, write it with wsg describe', () => {
      assert.match(a, /`description\.md` is the task's description for the owner: read it when you start work; when you create or record the task, write it with `wsg describe`/);
      assert.match(a, /no status, code or paths\./);
    });
    it('Layout lists description.md', () => assert.match(a, /- `description\.md` — the task's description for the owner \(`wsg describe`\)\./));
    it('the epic: a reported problem gets its description', () => assert.match(read(wsRoot, 'shop', 'AGENTS.md'), /its description for the owner with `wsg describe`/));
    const items = json(['check', pay]).doc.result.sections.flatMap((s) => s.items);
    it('the always-on budget stays within its target', () => {
      const b = items.find((i) => /into every session/.test(i.text));
      assert.ok(b, 'a budget line');
      assert.strictEqual(b.level, 'ok', b.text);
    });
    it('Layout lists it in the layout block', () => assert.match(a, /<!-- wsg:layout -->\n(?:[^\n]*\n)*?- `description\.md` — [^\n]*\n<!-- \/wsg:layout -->/));
    it('the block of a task of an epic comes after the epic\'s blocks', () => assert.match(a, /<!-- \/wsg:epic-context -->\n<!-- wsg:description -->\n`description\.md` is/));
    it('a standalone task: right after the advisor block', () => assert.match(read(cart, 'AGENTS.md'), /<!-- \/wsg:advisor -->\n<!-- wsg:description -->\n/));
    it('an epic has neither', () => {
      const e = read(wsRoot, 'shop', 'AGENTS.md');
      assert.doesNotMatch(e, /wsg:description/);
      assert.doesNotMatch(e, /- `description\.md`/);
    });

    // A task made before the block: wsg refresh adds it, with the news, and the Layout entry.
    for (const [name, ws, args] of [['a task of an epic', pay, ['refresh', '--ws', pay]], ['a standalone task', cart, ['refresh', '--ws', cart]]]) {
      const file = path.join(ws, 'AGENTS.md');
      const fresh = read(file);
      const old = fresh.replace(/<!-- wsg:description -->\n[\s\S]*?<!-- \/wsg:description -->\n/, '').replace(/- `description\.md` — [^\n]*\n/, '');
      fs.writeFileSync(file, old);
      const r1 = wsg(args);
      const after = read(file);
      const r2 = wsg(args);
      it(`${name}: refresh adds the block, saying it is new in wsg 0.9.5`, () => {
        assert.notStrictEqual(old, fresh);
        assert.strictEqual(r1.code, 0, r1.all);
        assert.match(r1.all, /AGENTS\.md: added the <!-- wsg:description --> block \(new in wsg 0\.9\.5\)/);
        assert.strictEqual(after, fresh);
      });
      it(`${name}: a second refresh changes nothing`, () => {
        assert.strictEqual(r2.code, 0, r2.all);
        assert.doesNotMatch(r2.all, /wsg:description/);
        assert.strictEqual(read(file), fresh);
      });
    }
    // A task promoted to an epic: the block and the Layout entry go, the file stays as it was.
    assert.strictEqual(wsg(['new', 'promo', '--description', 'Grew into an epic.', '--no-launch']).code, 0);
    const pr = wsg(['promote', 'promo']);
    it('wsg promote drops the block and the Layout entry, keeps description.md', () => {
      assert.strictEqual(pr.code, 0, pr.all);
      const e = read(wsRoot, 'promo', 'AGENTS.md');
      assert.doesNotMatch(e, /wsg:description|- `description\.md`/);
      assert.strictEqual(read(wsRoot, 'promo', 'description.md'), 'Grew into an epic.\n');
      assert.strictEqual(listed('promo').description, null);
    });
    const h = wsg(['help', 'describe']);
    it('wsg help describe', () => {
      assert.strictEqual(h.code, 0, h.all);
      assert.match(h.out, /^wsg describe <task>/m);
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
