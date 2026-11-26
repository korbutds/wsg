'use strict';

// `wsg studio install` (lib/studio.js): the latest wsg studio build downloaded into /Applications.
// Every run here gets fakes for the platform, pgrep, ditto, xattr and the download, and a temporary
// directory in place of /Applications, the home and the temp dir: nothing here touches the network
// (one test talks to a node:http server on 127.0.0.1) or the real /Applications.

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.WSG_LANG = 'en';

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
require(path.join(ROOT, 'lib', 'i18n')).init('en');
const S = require(path.join(ROOT, 'lib', 'studio.js'));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-studio-')));
const ENV = {
  PATH: process.env.PATH,
  HOME: path.join(tmp, 'cli-home'),
  WSG_LANG: 'en',
  WSG_CONFIG: path.join(tmp, 'no-config'),
};
fs.mkdirSync(ENV.HOME);
const wsg = (args, { env = {} } = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: tmp, encoding: 'utf8', env: { ...ENV, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
};
const jsonOf = (r) => { try { return JSON.parse(r.out); } catch { return null; } };

let failed = 0;
let passed = 0;
let skipped = 0;
const skip = (why) => { skipped++; console.log(`  skip  ${why}`); };
const it = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok    ${name}`); } catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};
let finished = false;
process.on('exit', () => {
  if (!finished) { console.log('\nFAIL  the suite stopped before the end'); process.exitCode = 1; }
});

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const URL_ZIP = `${S.BASE_URL}${S.ASSET}`;
const URL_SHA = `${URL_ZIP}.sha256`;
const MARK = path.join('Contents', 'MacOS', 'wsg studio');
const STOPS = ['SIGINT', 'SIGHUP', 'SIGTERM'];

// A run of its own: { deps, apps, home, tmpd, calls, warns, zip }. o.assets replaces what the fake
// download serves (url -> Buffer|string|Response|function), o.run answers a command before the
// defaults (pgrep: not running, ditto: unpacks an app whose binary holds the zip's text, xattr: no
// flag), o.spawn answers a child (ditto) before run does, o.fs wraps fs.
let n = 0;
function setup(o = {}) {
  const dir = path.join(tmp, `run-${++n}`);
  const apps = path.join(dir, 'Applications');
  const home = path.join(dir, 'home');
  const tmpd = path.join(dir, 'tmp');
  for (const d of [apps, home, tmpd]) fs.mkdirSync(d, { recursive: true });
  const zip = Buffer.from(`zip of run ${n}`);
  const assets = { [URL_ZIP]: zip, [URL_SHA]: `${sha256(zip)}  ${S.ASSET}\n`, ...(o.assets || {}) };
  const calls = { fetch: [], run: [] };
  const warns = [];
  const fetch = async (url, init) => {
    calls.fetch.push({ url, init });
    let a = assets[url];
    if (typeof a === 'function') a = await a(url, init);
    if (a instanceof Response) return a;
    if (a === undefined) return new Response('Not Found', { status: 404 });
    return new Response(a, { status: 200 });
  };
  const run = (cmd, args) => {
    calls.run.push([cmd, ...args]);
    const r = o.run && o.run(cmd, args, calls);
    if (r) return r;
    if (cmd === 'pgrep') return { status: 1, stdout: '', stderr: '' };
    if (cmd === 'ditto') {
      const [, , from, to] = args;
      const bin = path.join(to, S.APP, MARK);
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, fs.readFileSync(from));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'xattr') return { status: 1, stdout: '', stderr: 'No such xattr' };
    return { status: 127, stdout: '', stderr: 'unknown' };
  };
  // A child that has exited by the time it is asked: run's answer.
  const spawn = (cmd, args) => {
    const c = o.spawn && o.spawn(cmd, args, calls);
    if (c) return c;
    const r = run(cmd, args);
    return { kill: () => {}, done: Promise.resolve(r) };
  };
  const deps = {
    platform: 'darwin', arch: 'arm64', fetch, fs: o.fs || fs, homedir: () => home, tmpdir: () => tmpd,
    env: o.env || {}, run, spawn, appsDir: apps, log: { info: () => {}, warn: (w) => warns.push(w) }, version: '0.0.0-test', pid: 4242,
    ...(o.deps || {}),
  };
  return { deps, apps, home, tmpd, calls, warns, zip, app: path.join(apps, S.APP) };
}
const oldCopy = (app, text = 'old copy') => {
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, MARK), text);
};
const binOf = (app) => fs.readFileSync(path.join(app, MARK), 'utf8');
async function rejects(p) {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a refusal');
}
const ls = (d) => fs.readdirSync(d).sort();

(async () => {
  console.log('\nparseSha, releasesBase');
  const hex = 'a'.repeat(64);
  await it('a shasum line: the hash', () => assert.strictEqual(S.parseSha(`${hex}  ${S.ASSET}\n`), hex));
  await it('upper case is lowered, a bare hash works', () => assert.strictEqual(S.parseSha('AB'.repeat(32)), 'ab'.repeat(32)));
  await it('63 or 65 hex, junk, empty: none', () => {
    for (const s of ['a'.repeat(63), 'a'.repeat(65), 'not a hash', '', `x${hex}`]) assert.strictEqual(S.parseSha(s), null, s);
    assert.strictEqual(S.parseSha(undefined), null);
  });
  await it('the default base is the public repo\'s latest release', () => {
    assert.deepStrictEqual(S.releasesBase({}), { base: 'https://github.com/korbutds/wsg-studio-releases/releases/latest/download/', local: false });
  });
  await it('an https override, a slash added', () => assert.deepStrictEqual(S.releasesBase({ WSG_STUDIO_RELEASES_URL: 'https://mirror.example.com/x' }), { base: 'https://mirror.example.com/x/', local: false }));
  await it('http to 127.0.0.1 only: local', () => assert.strictEqual(S.releasesBase({ WSG_STUDIO_RELEASES_URL: 'http://127.0.0.1:9/' }).local, true));
  await it('http elsewhere, localhost, ftp, junk: invalid_input', () => {
    for (const u of ['http://example.com/', 'http://localhost:9/', 'ftp://x/', 'not a url']) {
      assert.throws(() => S.releasesBase({ WSG_STUDIO_RELEASES_URL: u }), (e) => e.code === 'invalid_input', u);
    }
  });

  console.log('\ninstall: a fresh one');
  {
    const r = setup();
    const res = await S.install({}, r.deps);
    await it('the result', () => assert.deepStrictEqual(res, {
      app: r.app, dir: r.apps, replaced: false, sha256: sha256(r.zip), asset: S.ASSET, url: URL_ZIP, quarantine: false,
    }));
    await it('the app is the one unpacked', () => assert.strictEqual(binOf(r.app), r.zip.toString()));
    await it('nothing else left in Applications or the temp dir', () => {
      assert.deepStrictEqual(ls(r.apps), [S.APP]);
      assert.deepStrictEqual(ls(r.tmpd), []);
    });
    await it('the sha256 first, then the zip; redirects by hand, a User-Agent, a timeout', () => {
      assert.deepStrictEqual(r.calls.fetch.map((c) => c.url), [URL_SHA, URL_ZIP]);
      for (const c of r.calls.fetch) {
        assert.strictEqual(c.init.redirect, 'manual');
        assert.strictEqual(c.init.headers['User-Agent'], 'wsg/0.0.0-test');
        assert.ok(c.init.signal instanceof AbortSignal);
      }
    });
    await it('pgrep twice each (before and before the swap), ditto -x -k into Applications, xattr', () => {
      const cmds = r.calls.run.map((c) => c[0]);
      assert.deepStrictEqual(cmds, ['pgrep', 'pgrep', 'ditto', 'pgrep', 'pgrep', 'xattr']);
      assert.deepStrictEqual(r.calls.run[0], ['pgrep', '-f', `${r.app.replace(/\./g, '\\.')}/Contents/MacOS/`]);
      assert.deepStrictEqual(r.calls.run[1], ['pgrep', '-x', 'wsg studio']);
      const d = r.calls.run[2];
      assert.deepStrictEqual(d.slice(0, 3), ['ditto', '-x', '-k']);
      assert.strictEqual(path.dirname(d[4]), r.apps);
      assert.deepStrictEqual(r.calls.run[5], ['xattr', '-p', 'com.apple.quarantine', r.app]);
    });
    await it('no warnings', () => assert.deepStrictEqual(r.warns, []));
  }

  console.log('\ninstall: an old copy is replaced');
  {
    const r = setup();
    oldCopy(r.app);
    fs.writeFileSync(path.join(r.app, 'Contents', 'stale'), 'x');
    const res = await S.install({}, r.deps);
    await it('replaced: true, the new binary, the old files gone', () => {
      assert.strictEqual(res.replaced, true);
      assert.strictEqual(binOf(r.app), r.zip.toString());
      assert.ok(!fs.existsSync(path.join(r.app, 'Contents', 'stale')));
    });
    await it('no .old copy, no staging left', () => assert.deepStrictEqual(ls(r.apps), [S.APP]));
  }

  console.log('\ninstall: refused before anything is touched');
  for (const [platform, arch] of [['linux', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']]) {
    const r = setup({ deps: { platform, arch } });
    const e = await rejects(S.install({}, r.deps));
    await it(`${platform} ${arch}: invalid_input, no download, no command`, () => {
      assert.strictEqual(e.code, 'invalid_input');
      assert.match(e.message, /macOS on Apple silicon/);
      assert.strictEqual(r.calls.fetch.length, 0);
      assert.strictEqual(r.calls.run.length, 0);
    });
  }
  {
    const r = setup({ run: (cmd, args) => (cmd === 'pgrep' && args[0] === '-x' ? { status: 0, stdout: '123\n' } : null) });
    oldCopy(r.app);
    const e = await rejects(S.install({}, r.deps));
    await it('Studio running: invalid_input, says to quit it, nothing downloaded, the old copy as it was', () => {
      assert.strictEqual(e.code, 'invalid_input');
      assert.match(e.message, /wsg studio is running: quit it first/);
      assert.strictEqual(r.calls.fetch.length, 0);
      assert.strictEqual(binOf(r.app), 'old copy');
      assert.deepStrictEqual(ls(r.apps), [S.APP]);
    });
  }
  {
    const r = setup({ run: (cmd, args) => (cmd === 'pgrep' && args[0] === '-f' ? { status: 0, stdout: '123\n' } : null) });
    const e = await rejects(S.install({}, r.deps));
    await it('running from the target (pgrep -f): refused too', () => assert.strictEqual(e.code, 'invalid_input'));
  }
  {
    const r = setup({ run: (cmd) => (cmd === 'pgrep' ? { status: 3, stdout: '', stderr: 'pgrep: bad' } : null) });
    oldCopy(r.app);
    const e = await rejects(S.install({}, r.deps));
    await it('pgrep failing: invalid_input (fails closed), nothing downloaded, the old copy as it was', () => {
      assert.strictEqual(e.code, 'invalid_input');
      assert.match(e.message, /could not check whether wsg studio is running \(pgrep: 3\): nothing installed/);
      assert.strictEqual(r.calls.fetch.length, 0);
      assert.strictEqual(binOf(r.app), 'old copy');
      assert.deepStrictEqual(ls(r.apps), [S.APP]);
    });
  }
  {
    const r = setup({ run: (cmd) => { if (cmd === 'pgrep') throw Object.assign(new Error('spawnSync pgrep ENOENT'), { code: 'ENOENT' }); return null; } });
    const e = await rejects(S.install({}, r.deps));
    await it('pgrep that cannot run: invalid_input naming why', () => {
      assert.strictEqual(e.code, 'invalid_input');
      assert.match(e.message, /pgrep: spawnSync pgrep ENOENT/);
      assert.strictEqual(r.calls.fetch.length, 0);
    });
  }
  {
    let seen = 0;
    const r = setup({ run: (cmd) => (cmd === 'pgrep' && ++seen > 2 ? { status: null, error: new Error('killed') } : null) });
    oldCopy(r.app);
    const e = await rejects(S.install({}, r.deps));
    await it('pgrep failing before the swap: step_failed, rollback done, nothing replaced, nothing left', () => {
      assert.strictEqual(e.code, 'step_failed');
      assert.strictEqual(e.rollback, 'done');
      assert.match(e.message, /could not check whether wsg studio is running/);
      assert.strictEqual(binOf(r.app), 'old copy');
      assert.deepStrictEqual(ls(r.apps), [S.APP]);
      assert.deepStrictEqual(ls(r.tmpd), []);
    });
  }

  for (const sig of STOPS) {
    const r = setup({ run: (cmd) => (cmd === 'pgrep' ? { status: null, signal: sig, stdout: '', stderr: '' } : null) });
    oldCopy(r.app);
    const e = await rejects(S.install({}, r.deps));
    await it(`pgrep ended by ${sig} at the first check: interrupted, rollback none, nothing downloaded`, () => {
      assert.strictEqual(e.code, 'interrupted');
      assert.strictEqual(e.rollback, 'none');
      assert.match(e.message, /Cancelled: nothing installed/);
      assert.strictEqual(r.calls.fetch.length, 0);
      assert.strictEqual(binOf(r.app), 'old copy');
      assert.deepStrictEqual(ls(r.apps), [S.APP]);
    });
  }
  {
    let seen = 0;
    const r = setup({ run: (cmd) => (cmd === 'pgrep' && ++seen > 2 ? { status: null, signal: 'SIGINT', stdout: '', stderr: '' } : null) });
    oldCopy(r.app);
    const e = await rejects(S.install({}, r.deps));
    await it('pgrep ended by SIGINT before the swap: interrupted, rollback done, nothing replaced, nothing left', () => {
      assert.strictEqual(e.code, 'interrupted');
      assert.strictEqual(e.rollback, 'done');
      assert.strictEqual(binOf(r.app), 'old copy');
      assert.deepStrictEqual(ls(r.apps), [S.APP]);
      assert.deepStrictEqual(ls(r.tmpd), []);
    });
  }
  {
    const r = setup({ run: (cmd) => (cmd === 'pgrep' ? { status: null, signal: 'SIGKILL', stdout: '', stderr: '' } : null) });
    const e = await rejects(S.install({}, r.deps));
    await it('pgrep ended by another signal: still a failing pgrep (invalid_input)', () => {
      assert.strictEqual(e.code, 'invalid_input');
      assert.match(e.message, /pgrep: SIGKILL/);
    });
  }

  console.log('\ninstall: Studio started during the download');
  {
    let seen = 0;
    const r = setup({ run: (cmd) => (cmd === 'pgrep' && ++seen > 2 ? { status: 0, stdout: '1\n' } : null) });
    oldCopy(r.app);
    const e = await rejects(S.install({}, r.deps));
    await it('step_failed, rollback done: nothing replaced, staging and temp removed', () => {
      assert.strictEqual(e.code, 'step_failed');
      assert.strictEqual(e.rollback, 'done');
      assert.match(e.message, /started during the install: nothing replaced/);
      assert.strictEqual(binOf(r.app), 'old copy');
      assert.deepStrictEqual(ls(r.apps), [S.APP]);
      assert.deepStrictEqual(ls(r.tmpd), []);
    });
  }

  console.log('\ninstall: the download');
  {
    const r = setup({ assets: { [URL_SHA]: `${'0'.repeat(64)}  ${S.ASSET}\n` } });
    oldCopy(r.app);
    const e = await rejects(S.install({}, r.deps));
    await it('sha256 mismatch: step_failed, nothing unpacked, the old copy as it was', () => {
      assert.strictEqual(e.code, 'step_failed');
      assert.match(e.message, /does not match its sha256/);
      assert.ok(!r.calls.run.some((c) => c[0] === 'ditto'));
      assert.strictEqual(binOf(r.app), 'old copy');
      assert.deepStrictEqual(ls(r.apps), [S.APP]);
      assert.deepStrictEqual(ls(r.tmpd), []);
    });
  }
  {
    const r = setup({ assets: { [URL_SHA]: '<html>not a hash</html>' } });
    const e = await rejects(S.install({}, r.deps));
    await it('a malformed .sha256: step_failed, the zip never fetched', () => {
      assert.strictEqual(e.code, 'step_failed');
      assert.match(e.message, /holds no sha256/);
      assert.deepStrictEqual(r.calls.fetch.map((c) => c.url), [URL_SHA]);
    });
  }
  {
    const r = setup({ assets: { [URL_SHA]: () => new Response('nf', { status: 404 }) } });
    const e = await rejects(S.install({}, r.deps));
    await it('no .sha256 (404): no release in korbutds/wsg-studio-releases yet', () => {
      assert.strictEqual(e.code, 'step_failed');
      assert.match(e.message, /no wsg studio release in korbutds\/wsg-studio-releases yet/);
      assert.deepStrictEqual(ls(r.apps), []);
    });
  }
  {
    const r = setup({ assets: { [URL_ZIP]: () => new Response('nf', { status: 404 }) } });
    const e = await rejects(S.install({}, r.deps));
    await it('no zip (404): the same message, nothing left', () => {
      assert.match(e.message, /no wsg studio release in korbutds\/wsg-studio-releases yet/);
      assert.deepStrictEqual(ls(r.apps), []);
      assert.deepStrictEqual(ls(r.tmpd), []);
    });
  }
  {
    const r = setup({ assets: { [URL_SHA]: () => new Response('oops', { status: 503 }) } });
    const e = await rejects(S.install({}, r.deps));
    await it('HTTP 503: named with the URL', () => assert.match(e.message, /HTTP 503 from .*\.sha256/));
  }
  {
    const r = setup({ assets: { [URL_SHA]: () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' }) }); } } });
    const e = await rejects(S.install({}, r.deps));
    await it('a network error: the cause and the proxy hint', () => {
      assert.strictEqual(e.code, 'step_failed');
      assert.match(e.message, /cannot download .*ENOTFOUND/);
      assert.match(e.message, /NODE_USE_ENV_PROXY=1/);
    });
  }
  {
    const r = setup({ assets: { [URL_SHA]: () => { throw new DOMException('timed out', 'TimeoutError'); } } });
    const e = await rejects(S.install({}, r.deps));
    await it('a timeout: said as one', () => assert.match(e.message, /no answer in 30 s/));
  }
  {
    const r = setup({ assets: { [URL_SHA]: () => new Response(null, { status: 302, headers: { location: 'http://mirror.example.com/x.sha256' } }) } });
    const e = await rejects(S.install({}, r.deps));
    await it('a redirect to http: refused, not followed', () => {
      assert.strictEqual(e.code, 'step_failed');
      assert.match(e.message, /refused a redirect to http:\/\/mirror\.example\.com/);
      assert.strictEqual(r.calls.fetch.length, 1);
    });
  }
  {
    const hop = 'https://objects.example.com/zip';
    const r = setup({ assets: { [URL_ZIP]: () => new Response(null, { status: 302, headers: { location: hop } }) } });
    r.deps.fetch = ((inner) => async (url, init) => (url === hop ? (r.calls.fetch.push({ url, init }), new Response(r.zip)) : inner(url, init)))(r.deps.fetch);
    const res = await S.install({}, r.deps);
    await it('a redirect to https: followed, the result keeps the asset URL', () => {
      assert.strictEqual(res.url, URL_ZIP);
      assert.deepStrictEqual(r.calls.fetch.map((c) => c.url), [URL_SHA, URL_ZIP, hop]);
    });
  }
  {
    const r = setup({ assets: { [URL_SHA]: (u) => new Response(null, { status: 302, headers: { location: u } }) } });
    const e = await rejects(S.install({}, r.deps));
    await it('a redirect loop: stops', () => assert.match(e.message, /too many redirects/));
  }

  console.log('\ninstall: /Applications not writable');
  if (asRoot) skip('as root every directory is writable');
  else {
    const r = setup();
    oldCopy(r.app, 'system copy');
    fs.chmodSync(r.apps, 0o555);
    try {
      const res = await S.install({}, r.deps);
      const user = path.join(r.home, 'Applications');
      await it('goes to ~/Applications, made for it', () => {
        assert.strictEqual(res.dir, user);
        assert.strictEqual(res.app, path.join(user, S.APP));
        assert.strictEqual(binOf(res.app), r.zip.toString());
        assert.deepStrictEqual(ls(user), [S.APP]);
      });
      await it('the copy in /Applications stays, warned about', () => {
        assert.strictEqual(binOf(r.app), 'system copy');
        assert.ok(r.warns.some((w) => w.includes(`an older copy stays at ${r.app}`)), r.warns.join('\n'));
      });
      await it('the running check looks at the ~/Applications copy', () => assert.ok(r.calls.run[0][2].startsWith(path.join(r.home, 'Applications').replace(/\./g, '\\.'))));
    } finally {
      fs.chmodSync(r.apps, 0o755);
    }
    const r2 = setup({ run: (cmd) => (cmd === 'ditto' ? { status: 1, stdout: '', stderr: 'ditto: boom' } : null) });
    fs.chmodSync(r2.apps, 0o555);
    try {
      const e = await rejects(S.install({}, r2.deps));
      await it('a failure there: the ~/Applications made for it removed again', () => {
        assert.strictEqual(e.rollback, 'done');
        assert.ok(!fs.existsSync(path.join(r2.home, 'Applications')));
      });
    } finally {
      fs.chmodSync(r2.apps, 0o755);
    }
  }

  console.log('\ninstall: the unpack');
  {
    const r = setup({ run: (cmd) => (cmd === 'ditto' ? { status: 1, stdout: '', stderr: 'ditto: boom' } : null) });
    oldCopy(r.app);
    const e = await rejects(S.install({}, r.deps));
    await it('ditto failing: step_failed with its error, staging gone, the old copy as it was', () => {
      assert.strictEqual(e.code, 'step_failed');
      assert.match(e.message, /ditto could not unpack the download: ditto: boom/);
      assert.strictEqual(binOf(r.app), 'old copy');
      assert.deepStrictEqual(ls(r.apps), [S.APP]);
      assert.deepStrictEqual(ls(r.tmpd), []);
    });
  }
  {
    const r = setup({ run: (cmd, args) => (cmd === 'ditto' ? (fs.mkdirSync(path.join(args[3], 'Other.app')), { status: 0 }) : null) });
    const e = await rejects(S.install({}, r.deps));
    await it('a zip without the app: step_failed naming what it holds', () => {
      assert.match(e.message, /should hold exactly "wsg studio\.app", it holds: Other\.app/);
      assert.deepStrictEqual(ls(r.apps), []);
    });
  }

  {
    const isStaging = (p) => path.basename(String(p)).startsWith('.wsg-studio-install-');
    const wrapped = { ...fs, readdirSync: (p, o) => { if (isStaging(p)) throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); return fs.readdirSync(p, o); } };
    const r = setup({ fs: wrapped });
    oldCopy(r.app);
    const e = await rejects(S.install({}, r.deps));
    await it('the unpacked download not readable: step_failed, rollback done, staging and temp removed', () => {
      assert.ok(e instanceof S.StudioError, String(e));
      assert.strictEqual(e.code, 'step_failed');
      assert.strictEqual(e.rollback, 'done');
      assert.match(e.message, /cannot read the unpacked download in .*\.wsg-studio-install-.*EACCES/);
      assert.strictEqual(binOf(r.app), 'old copy');
      assert.deepStrictEqual(ls(r.apps), [S.APP]);
      assert.deepStrictEqual(ls(r.tmpd), []);
    });
  }
  {
    const isStaging = (p) => path.basename(String(p)).startsWith('.wsg-studio-install-');
    const wrapped = { ...fs,
      statSync: (p, o) => { if (String(p).endsWith(S.APP) && isStaging(path.dirname(String(p)))) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); return fs.statSync(p, o); },
      rmSync: (p, o) => { if (isStaging(p)) throw Object.assign(new Error('EPERM: denied'), { code: 'EPERM' }); return fs.rmSync(p, o); },
    };
    const r = setup({ fs: wrapped });
    oldCopy(r.app);
    const e = await rejects(S.install({}, r.deps));
    const left = fs.readdirSync(r.apps).filter(isStaging).map((n) => path.join(r.apps, n));
    await it('the unpacked app not statable, the staging not removed: step_failed, incomplete, the staging in kept and details', () => {
      assert.strictEqual(e.code, 'step_failed');
      assert.strictEqual(e.rollback, 'incomplete');
      assert.match(e.message, /cannot read the unpacked download.*EIO/);
      assert.strictEqual(left.length, 1);
      assert.deepStrictEqual(e.kept, left);
      assert.ok(e.details.some((d) => d.includes(left[0]) && /left behind/.test(d)), e.details.join('\n'));
      assert.strictEqual(binOf(r.app), 'old copy');
    });
  }

  console.log('\ninstall: the swap');
  {
    let app = null;
    const wrapped = { ...fs, renameSync: (from, to) => {
      if (to === app && path.basename(path.dirname(from)).startsWith('.wsg-studio-install-')) throw Object.assign(new Error('EXDEV: cross-device'), { code: 'EXDEV' });
      return fs.renameSync(from, to);
    } };
    const r = setup({ fs: wrapped });
    app = r.app;
    oldCopy(r.app);
    const e = await rejects(S.install({}, r.deps));
    await it('the new copy not put in place: the old one back, step_failed, rollback done', () => {
      assert.strictEqual(e.code, 'step_failed');
      assert.strictEqual(e.rollback, 'done');
      assert.match(e.message, /the old copy is back at/);
      assert.strictEqual(binOf(r.app), 'old copy');
      assert.deepStrictEqual(ls(r.apps), [S.APP]);
    });
  }
  {
    let app = null;
    const wrapped = { ...fs, renameSync: (from, to) => {
      if (to === app) throw Object.assign(new Error('EPERM: denied'), { code: 'EPERM' });
      return fs.renameSync(from, to);
    } };
    const r = setup({ fs: wrapped });
    app = r.app;
    oldCopy(r.app);
    const e = await rejects(S.install({}, r.deps));
    const old = path.join(r.apps, `.${S.APP}.old-4242`);
    await it('neither put in place nor put back: incomplete, names where the old copy is', () => {
      assert.strictEqual(e.rollback, 'incomplete');
      assert.ok(e.message.includes(old), e.message);
      assert.strictEqual(binOf(old), 'old copy');
      assert.deepStrictEqual(e.kept, [old]);
    });
  }

  console.log('\ninstall: a stop signal');
  {
    const before = STOPS.map((sig) => process.listenerCount(sig));
    const r = setup({ assets: { [URL_ZIP]: (url, init) => new Response(new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        init.signal.addEventListener('abort', () => c.error(init.signal.reason));
        setImmediate(() => process.emit('SIGINT', 'SIGINT'));
      },
    })) } });
    oldCopy(r.app);
    const e = await rejects(S.install({}, r.deps));
    await it('during the download: interrupted, rollback none, the temp zip removed, nothing unpacked', () => {
      assert.strictEqual(e.code, 'interrupted');
      assert.strictEqual(e.rollback, 'none');
      assert.match(e.message, /Cancelled: nothing installed/);
      assert.ok(!r.calls.run.some((c) => c[0] === 'ditto'));
      assert.deepStrictEqual(ls(r.tmpd), []);
      assert.deepStrictEqual(ls(r.apps), [S.APP]);
      assert.strictEqual(binOf(r.app), 'old copy');
    });
    await it('its handlers removed after', () => assert.deepStrictEqual(STOPS.map((sig) => process.listenerCount(sig)), before));
  }
  {
    const killed = [];
    const r = setup({ spawn: (cmd, args) => {
      if (cmd !== 'ditto') return null;
      // Half unpacked when the signal comes.
      fs.mkdirSync(path.join(args[3], S.APP, 'Contents'), { recursive: true });
      let end;
      const done = new Promise((ok) => { end = ok; });
      setImmediate(() => process.emit('SIGTERM', 'SIGTERM'));
      return { kill: (sig) => { killed.push(sig); end({ status: null, signal: sig, stderr: '' }); }, done };
    } });
    oldCopy(r.app);
    const e = await rejects(S.install({}, r.deps));
    await it('during ditto: ditto stopped, interrupted, rollback done, staging and temp removed, the old copy as it was', () => {
      assert.deepStrictEqual(killed, ['SIGTERM']);
      assert.strictEqual(e.code, 'interrupted');
      assert.strictEqual(e.rollback, 'done');
      assert.deepStrictEqual(e.kept, []);
      assert.deepStrictEqual(ls(r.apps), [S.APP]);
      assert.deepStrictEqual(ls(r.tmpd), []);
      assert.strictEqual(binOf(r.app), 'old copy');
    });
  }
  {
    // Ctrl+C reaches ditto too: it may exit before the handler has run.
    const r = setup({ spawn: (cmd) => {
      if (cmd !== 'ditto') return null;
      setTimeout(() => process.emit('SIGINT', 'SIGINT'), 0);
      return { kill: () => {}, done: Promise.resolve({ status: null, signal: 'SIGINT', stderr: '' }) };
    } });
    const e = await rejects(S.install({}, r.deps));
    await it('ditto killed by the same Ctrl+C first: still interrupted, not an unpack failure', () => {
      assert.strictEqual(e.code, 'interrupted', e.message);
      assert.strictEqual(e.rollback, 'done');
      assert.deepStrictEqual(ls(r.apps), []);
    });
  }
  {
    // --json: lib/json.js answers a stop signal at once unless another listener is there. A real
    // SIGTERM to a child that runs the install with fakes, and the envelope cmdStudio makes of it.
    const dir = path.join(tmp, 'json-signal');
    const script = `
      const [root, dir] = process.argv.slice(1);
      const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
      require(path.join(root, 'lib', 'i18n')).init('en');
      const J = require(path.join(root, 'lib', 'json.js'));
      const S = require(path.join(root, 'lib', 'studio.js'));
      J.start({ command: 'studio install' });
      const apps = path.join(dir, 'Applications'), tmpd = path.join(dir, 'tmp');
      for (const d of [apps, tmpd]) fs.mkdirSync(d, { recursive: true });
      const zip = Buffer.from('zip');
      const sha = crypto.createHash('sha256').update(zip).digest('hex');
      let end;
      const deps = {
        platform: 'darwin', arch: 'arm64', fs, homedir: () => dir, tmpdir: () => tmpd, env: {}, appsDir: apps,
        log: { info() {}, warn() {} }, version: '0', pid: 1,
        fetch: async (url) => new Response(url.endsWith('.sha256') ? sha + '  x' : zip),
        run: () => ({ status: 1 }),
        // A child that runs until killed; the interval keeps the event loop alive as a real one does.
        spawn: () => {
          const alive = setInterval(() => {}, 1000);
          setTimeout(() => process.kill(process.pid, 'SIGTERM'), 20);
          return { kill: (sig) => { clearInterval(alive); end({ status: null, signal: sig }); }, done: new Promise((ok) => { end = ok; }) };
        },
      };
      S.install({}, deps).then(
        (res) => process.exit(J.succeed(res)),
        (e) => process.exit(J.fail(e.code, e.message, { rollback: e.rollback, kept: e.kept, details: e.details })),
      );`;
    const c = spawnSync(process.execPath, ['-e', script, ROOT, dir], { encoding: 'utf8', env: { ...ENV } });
    const env = jsonOf({ out: c.stdout });
    await it('--json: a real SIGTERM during ditto is the install\'s: interrupted, exit 130, rollback done, nothing left', () => {
      assert.ok(env, `status ${c.status} ${c.signal} out: ${c.stdout} err: ${c.stderr}`);
      assert.strictEqual(c.status, 130, c.stdout + c.stderr);
      assert.strictEqual(env.error.code, 'interrupted');
      assert.strictEqual(env.error.rollback, 'done');
      assert.match(env.error.message, /Cancelled: nothing installed/);
      assert.deepStrictEqual(ls(path.join(dir, 'Applications')), []);
      assert.deepStrictEqual(ls(path.join(dir, 'tmp')), []);
    });
  }

  console.log('\ninstall: the staging not removed');
  {
    const isStaging = (p) => path.basename(String(p)).startsWith('.wsg-studio-install-');
    const wrapped = { ...fs, rmSync: (p, o) => { if (isStaging(p)) throw Object.assign(new Error('EPERM: denied'), { code: 'EPERM' }); return fs.rmSync(p, o); } };
    const r = setup({ fs: wrapped, run: (cmd) => (cmd === 'ditto' ? { status: 1, stdout: '', stderr: 'ditto: boom' } : null) });
    oldCopy(r.app);
    const e = await rejects(S.install({}, r.deps));
    const left = fs.readdirSync(r.apps).filter(isStaging).map((n) => path.join(r.apps, n));
    await it('a failure: rollback incomplete, the staging in kept and details', () => {
      assert.strictEqual(e.code, 'step_failed');
      assert.strictEqual(e.rollback, 'incomplete');
      assert.strictEqual(left.length, 1);
      assert.deepStrictEqual(e.kept, left);
      assert.ok(e.details.some((d) => d.includes(left[0]) && /left behind/.test(d)), e.details.join('\n'));
      assert.strictEqual(binOf(r.app), 'old copy');
    });
    const r2 = setup({ fs: wrapped });
    const res = await S.install({}, r2.deps);
    await it('a success: installed, the staging left warned about', () => {
      assert.strictEqual(binOf(res.app), r2.zip.toString());
      assert.ok(r2.warns.some((w) => /left behind: .*\.wsg-studio-install-/.test(w)), r2.warns.join('\n'));
    });
  }

  console.log('\ninstall: quarantine');
  {
    const r = setup({ run: (cmd) => (cmd === 'xattr' ? { status: 0, stdout: '0081;...' } : null) });
    const res = await S.install({}, r.deps);
    await it('found: quarantine true, a warning with the xattr line, the flag left alone', () => {
      assert.strictEqual(res.quarantine, true);
      assert.ok(r.warns.some((w) => w.includes(`xattr -dr com.apple.quarantine "${r.app}"`)), r.warns.join('\n'));
      assert.ok(!r.calls.run.some((c) => c[0] === 'xattr' && c.includes('-d')));
    });
  }

  console.log('\ninstall --dry-run');
  {
    const r = setup();
    oldCopy(r.app);
    const res = await S.install({ dryRun: true }, r.deps);
    await it('the plan: the sha256 from the .sha256, replaced, quarantine null', () => assert.deepStrictEqual(res, {
      app: r.app, dir: r.apps, replaced: true, sha256: sha256(r.zip), asset: S.ASSET, url: URL_ZIP, quarantine: null,
    }));
    await it('only the .sha256 fetched, only pgrep run, nothing written', () => {
      assert.deepStrictEqual(r.calls.fetch.map((c) => c.url), [URL_SHA]);
      assert.deepStrictEqual([...new Set(r.calls.run.map((c) => c[0]))], ['pgrep']);
      assert.deepStrictEqual(ls(r.apps), [S.APP]);
      assert.deepStrictEqual(ls(r.tmpd), []);
      assert.strictEqual(binOf(r.app), 'old copy');
    });
  }

  console.log('\ninstall from a local server (WSG_STUDIO_RELEASES_URL), redirects followed');
  {
    const zip = Buffer.from('a zip from the local server');
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, ua: req.headers['user-agent'] });
      const port = server.address().port;
      if (req.url === `/dl/${S.ASSET}.sha256`) { res.writeHead(302, { location: `/files/${S.ASSET}.sha256` }); return res.end(); }
      if (req.url === `/dl/${S.ASSET}`) { res.writeHead(302, { location: `http://127.0.0.1:${port}/files/${S.ASSET}` }); return res.end(); }
      if (req.url === `/files/${S.ASSET}.sha256`) return res.end(`${sha256(zip)}  ${S.ASSET}\n`);
      if (req.url === `/files/${S.ASSET}`) return res.end(zip);
      if (req.url === '/away/x.sha256') { res.writeHead(302, { location: `http://localhost:${port}/files/${S.ASSET}.sha256` }); return res.end(); }
      res.writeHead(404);
      return res.end();
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const port = server.address().port;
    try {
      const r = setup({ env: { WSG_STUDIO_RELEASES_URL: `http://127.0.0.1:${port}/dl` } });
      r.deps.fetch = (...a) => globalThis.fetch(...a);
      const res = await S.install({}, r.deps);
      await it('installed from it, the 302s followed', () => {
        assert.strictEqual(res.url, `http://127.0.0.1:${port}/dl/${S.ASSET}`);
        assert.strictEqual(res.sha256, sha256(zip));
        assert.strictEqual(binOf(r.app), zip.toString());
        assert.deepStrictEqual(seen.map((s) => s.url), [`/dl/${S.ASSET}.sha256`, `/files/${S.ASSET}.sha256`, `/dl/${S.ASSET}`, `/files/${S.ASSET}`]);
      });
      await it('every request with the User-Agent', () => assert.ok(seen.every((s) => s.ua === 'wsg/0.0.0-test'), JSON.stringify(seen)));
      const r2 = setup({ env: { WSG_STUDIO_RELEASES_URL: `http://127.0.0.1:${port}/away` }, assets: {} });
      r2.deps.fetch = (url, init) => globalThis.fetch(url.replace(S.ASSET, 'x'), init);
      const e = await rejects(S.install({}, r2.deps));
      await it('a redirect to http on another host name: refused', () => assert.match(e.message, /refused a redirect to http:\/\/localhost/));
    } finally {
      await new Promise((ok) => server.close(ok));
    }
  }

  console.log('\nthe CLI');
  {
    const r = wsg(['studio']);
    await it('wsg studio alone: exit 2, names install', () => {
      assert.strictEqual(r.code, 2, r.all);
      assert.match(r.err, /wsg studio needs a command: install/);
    });
    const b = wsg(['studio', 'update']);
    await it('wsg studio update: exit 2, unknown command', () => {
      assert.strictEqual(b.code, 2, b.all);
      assert.match(b.err, /unknown command: studio update/);
    });
    const f = wsg(['studio', 'install', '--force']);
    await it('an unknown flag: exit 2', () => {
      assert.strictEqual(f.code, 2, f.all);
      assert.match(f.err, /unknown argument: --force/);
    });
    const x = wsg(['studio', 'install', 'extra']);
    await it('a positional argument: exit 2', () => assert.strictEqual(x.code, 2, x.all));
    const j = wsg(['studio', 'install', '--force', '--json']);
    await it('--json: the refusal in the envelope, command "studio install"', () => {
      const env = jsonOf(j);
      assert.ok(env, j.all);
      assert.strictEqual(j.code, 2);
      assert.strictEqual(env.command, 'studio install');
      assert.strictEqual(env.error.code, 'invalid_input');
    });
    const u = wsg(['studio', 'install', '--dry-run', '--json'], { env: { WSG_STUDIO_RELEASES_URL: 'http://example.com/' } });
    await it('a bad WSG_STUDIO_RELEASES_URL: invalid_input before anything, dryRun true', () => {
      const env = jsonOf(u);
      assert.ok(env, u.all);
      assert.strictEqual(u.code, 2);
      assert.strictEqual(env.dryRun, true);
      assert.strictEqual(env.error.code, 'invalid_input');
      assert.match(env.error.message, /WSG_STUDIO_RELEASES_URL/);
    });
    const h = wsg(['help', 'studio']);
    await it('wsg help studio: the install command, the Open Anyway note', () => {
      assert.strictEqual(h.code, 0, h.all);
      assert.match(h.out, /^wsg studio install \[--dry-run\] \[--json\]/m);
      assert.match(h.out, /Open Anyway/);
    });
    await it('wsg studio --help and wsg studio install --help: the same text', () => {
      assert.strictEqual(wsg(['studio', '--help']).out, h.out);
      assert.strictEqual(wsg(['studio', 'install', '--help']).out, h.out);
    });
    await it('the usage lists it', () => assert.match(wsg(['--help']).out, /wsg studio install/));
    await it('a broken config does not stop it (no settings needed)', () => {
      const broken = path.join(tmp, 'broken-config');
      fs.writeFileSync(broken, 'WS_ROOT=/x\n', { mode: 0o000 });
      if (asRoot) return;
      assert.match(wsg(['list'], { env: { WSG_CONFIG: broken } }).err, /cannot read settings/);
      const e = wsg(['studio', 'install', '--force'], { env: { WSG_CONFIG: broken } });
      assert.strictEqual(e.code, 2, e.all);
      assert.match(e.err, /unknown argument: --force/);
    });
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed === 0 ? `\n${passed} checks passed, ${skipped} blocks skipped\n` : `\nfailed: ${failed}, ${passed} passed, ${skipped} blocks skipped\n`);
  finished = true;
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.log(`\nFAIL  ${e.stack || e}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  finished = true;
  process.exit(1);
});
