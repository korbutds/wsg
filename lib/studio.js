'use strict';

// `wsg studio install`: the latest wsg studio build from the public korbutds/wsg-studio-releases,
// downloaded over https into /Applications (~/Applications when /Applications can't be written).
// A file Node downloads gets no com.apple.quarantine flag, so Gatekeeper does not block the app the
// way it blocks a browser download of an app that is not notarized. The .sha256 next to the zip is
// checked before anything is unpacked. Studio running refuses the install: quitting it would cut
// the agent sessions inside. Everything outside is a dependency (deps) so the tests run it with
// fakes: no network, no real /Applications.

const crypto = require('node:crypto');
const path = require('node:path');
const { t } = require('./i18n');

const REPO = 'korbutds/wsg-studio-releases';
const ASSET = 'wsg-studio-mac-arm64.zip';
const APP = 'wsg studio.app';
// The main process: Contents/MacOS/<productName> (wsg-studio electron-builder.yml).
const PROCESS = 'wsg studio';
const BASE_URL = `https://github.com/${REPO}/releases/latest/download/`;
const SYSTEM_APPS = '/Applications';
const MAX_REDIRECTS = 5;
const SHA_TIMEOUT_MS = 30 * 1000;
const ZIP_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_SHA_BYTES = 4096;

// code: the envelope's error code (invalid_input: refused before anything was touched, exit 2;
// step_failed: exit 1; interrupted: a stop signal, exit 130). rollback, kept, details: as
// lib/json.js has them; kept — what the cleanup left in the target directory.
const STOP_SIGNALS = ['SIGINT', 'SIGHUP', 'SIGTERM'];
class StudioError extends Error {
  constructor(code, message, rollback = 'none') {
    super(message);
    this.name = 'StudioError';
    this.code = code;
    this.rollback = rollback;
    this.kept = [];
    this.details = [];
  }
}
const refuse = (msg) => new StudioError('invalid_input', msg);
const failed = (msg, rollback = 'none') => new StudioError('step_failed', msg, rollback);

// The first 64-hex token of a .sha256 file (`<hash>  <name>`, as shasum writes it), lowercased;
// null when it has none.
function parseSha(text) {
  if (typeof text !== 'string') return null;
  const m = /^\s*([0-9a-fA-F]{64})(?=\s|$)/.exec(text);
  return m ? m[1].toLowerCase() : null;
}

// http://127.0.0.1 only: a local test server, never a host on the network.
const isLocalHttp = (u) => u.protocol === 'http:' && u.hostname === '127.0.0.1';

// The base URL the assets are under: WSG_STUDIO_RELEASES_URL (https, or http://127.0.0.1 for the
// tests) or the public repo's latest release. { base, local }: local — http to 127.0.0.1 allowed.
function releasesBase(env = {}) {
  const given = env.WSG_STUDIO_RELEASES_URL;
  if (given === undefined || given === '') return { base: BASE_URL, local: false };
  let u;
  try {
    u = new URL(given);
  } catch {
    throw refuse(t('studio.badUrl', { url: given }));
  }
  if (u.protocol !== 'https:' && !isLocalHttp(u)) throw refuse(t('studio.badUrl', { url: given }));
  const base = u.href.endsWith('/') ? u.href : `${u.href}/`;
  return { base, local: isLocalHttp(u) };
}

// A pattern for pgrep -f: the path as it is, regex characters escaped.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Throws when Studio runs: its main process from the target, or any process named as Studio's main
// one. Fails closed: a pgrep that neither finds (0) nor finds nothing (1) refuses too. late: the
// check before the swap, a step_failed with that rollback; the first one is invalid_input. A pgrep
// ended by a stop signal (Ctrl+C reaches the whole process group) is the interruption, with the
// same rollback: none at the first check, late's before the swap.
function assertNotRunning(app, deps, late = null) {
  const stop = (msg) => (late ? failed(msg, late) : refuse(msg));
  const checks = [['-f', `${escapeRe(app)}/Contents/MacOS/`], ['-x', PROCESS]];
  for (const args of checks) {
    let r;
    try {
      r = deps.run('pgrep', args);
    } catch (e) {
      r = { status: null, error: e };
    }
    if (r && STOP_SIGNALS.includes(r.signal)) throw new StudioError('interrupted', t('studio.cancelled'), late || 'none');
    const status = r && r.status;
    if (status === 0) throw stop(t(late ? 'studio.runningLate' : 'studio.running', { app }));
    if (status !== 1) {
      const why = status === null || status === undefined ? String((r && r.error && r.error.message) || (r && r.signal) || 'none') : status;
      throw stop(t('studio.pgrepRefused', { status: why, app }));
    }
  }
}

function writable(fs, dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const exists = (fs, p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// Where it goes: /Applications when it can be written, else ~/Applications (made later, at the
// install). { dir, make, other }: make — the directory is not there yet; other — a copy in
// /Applications that stays when it goes to ~/Applications.
function targetDir(deps) {
  const { fs } = deps;
  const system = deps.appsDir || SYSTEM_APPS;
  if (writable(fs, system)) return { dir: system, make: false, other: null };
  const user = path.join(deps.homedir(), 'Applications');
  const other = exists(fs, path.join(system, APP)) ? path.join(system, APP) : null;
  if (exists(fs, user)) {
    if (!writable(fs, user)) throw failed(t('studio.notWritable', { system, user }));
    return { dir: user, make: false, other };
  }
  if (!writable(fs, path.dirname(user))) throw failed(t('studio.notWritable', { system, user }));
  return { dir: user, make: true, other };
}

// GET url with the redirects followed by hand: every hop must be https (http://127.0.0.1 only
// under a local override). Returns the final response; 404 and other statuses are the caller's.
// abort: a stop signal's AbortSignal, or none.
async function get(url, deps, { local, timeoutMs, abort }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = abort ? AbortSignal.any([timeout, abort]) : timeout;
  let at = url;
  for (let hop = 0; ; hop++) {
    let res;
    try {
      res = await deps.fetch(at, { redirect: 'manual', signal, headers: { 'User-Agent': `wsg/${deps.version}` } });
    } catch (e) {
      throw failed(networkMessage(at, e, timeoutMs));
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= MAX_REDIRECTS) throw failed(t('studio.tooManyRedirects', { url }));
      let next;
      try {
        next = new URL(res.headers.get('location'), at);
      } catch {
        throw failed(t('studio.redirectRefused', { url: String(res.headers.get('location')) }));
      }
      if (next.protocol !== 'https:' && !(local && isLocalHttp(next))) throw failed(t('studio.redirectRefused', { url: next.href }));
      if (res.body && typeof res.body.cancel === 'function') await res.body.cancel().catch(() => {});
      at = next.href;
      continue;
    }
    return res;
  }
}

function networkMessage(url, e, timeoutMs) {
  const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
  const cause = e && e.cause && (e.cause.code || e.cause.message);
  const msg = timedOut ? t('studio.timedOut', { sec: Math.round(timeoutMs / 1000) }) : String(cause || (e && e.message) || e);
  return t('studio.network', { url, msg });
}

function checkStatus(res, url) {
  if (res.status === 404) throw failed(t('studio.noRelease', { repo: REPO, url }));
  if (res.status < 200 || res.status > 299) throw failed(t('studio.http', { status: res.status, url }));
}

async function fetchSha(url, deps, local) {
  const res = await get(url, deps, { local, timeoutMs: deps.shaTimeoutMs || SHA_TIMEOUT_MS });
  checkStatus(res, url);
  let text;
  try {
    text = await res.text();
  } catch (e) {
    throw failed(networkMessage(url, e, deps.shaTimeoutMs || SHA_TIMEOUT_MS));
  }
  const sha = text.length <= MAX_SHA_BYTES ? parseSha(text) : null;
  if (!sha) throw failed(t('studio.badSha', { url }));
  return sha;
}

// The zip streamed into file, hashed on the way. Returns its sha256.
async function fetchZip(url, file, deps, local, abort) {
  const { fs } = deps;
  const timeoutMs = deps.zipTimeoutMs || ZIP_TIMEOUT_MS;
  const res = await get(url, deps, { local, timeoutMs, abort });
  checkStatus(res, url);
  if (!res.body) throw failed(t('studio.http', { status: res.status, url }));
  const hash = crypto.createHash('sha256');
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (e) {
    throw failed(t('studio.writeFailed', { file, msg: e.message }));
  }
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      hash.update(buf);
      let off = 0;
      while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    }
  } catch (e) {
    if (e instanceof StudioError) throw e;
    if (e && typeof e.code === 'string' && /^E[A-Z]+$/.test(e.code) && e.syscall) throw failed(t('studio.writeFailed', { file, msg: e.message }));
    throw failed(networkMessage(url, e, timeoutMs));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

// cmd as a child a stop signal can end: { kill(sig), done }; done resolves, never rejects, to
// { status, signal, stderr, error } once it has exited (status null: it did not start or was killed).
function spawnChild(cmd, args) {
  const { spawn } = require('node:child_process');
  let child = null;
  const done = new Promise((resolve) => {
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      resolve({ status: null, signal: null, stderr: '', error: e });
      return;
    }
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { if (stderr.length < 64 * 1024) stderr += d; });
    child.on('error', (e) => resolve({ status: null, signal: null, stderr, error: e }));
    child.on('close', (status, signal) => resolve({ status, signal, stderr }));
  });
  return {
    kill: (sig) => {
      try {
        if (child && child.exitCode === null && child.signalCode === null) child.kill(sig);
      } catch { /* gone already */ }
    },
    done,
  };
}

function defaults(deps = {}) {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const ui = require('./ui');
  return {
    platform: process.platform,
    arch: process.arch,
    fetch: (...a) => globalThis.fetch(...a),
    fs: require('node:fs'),
    homedir: () => os.homedir(),
    tmpdir: () => os.tmpdir(),
    env: process.env,
    run: (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }),
    spawn: spawnChild,
    appsDir: SYSTEM_APPS,
    log: { info: ui.info, warn: ui.warn },
    version: require(path.join(__dirname, '..', 'package.json')).version,
    pid: process.pid,
    ...deps,
  };
}

// opts: { dryRun }. Returns { app, dir, replaced, sha256, asset, url, quarantine }: replaced — an
// old copy was (in a dry run: would be) replaced; quarantine — the flag found on the installed app
// (null in a dry run, or when xattr could not tell). Throws StudioError.
async function install(opts = {}, given = {}) {
  const deps = defaults(given);
  const { fs, log } = deps;
  const dryRun = !!opts.dryRun;
  const { base, local } = releasesBase(deps.env);
  if (deps.platform !== 'darwin' || deps.arch !== 'arm64') {
    throw refuse(t('studio.platform', { platform: deps.platform, arch: deps.arch }));
  }
  const target = targetDir(deps);
  const app = path.join(target.dir, APP);
  assertNotRunning(app, deps);
  const url = `${base}${ASSET}`;
  const shaUrl = `${url}.sha256`;
  const result = (o) => ({ app, dir: target.dir, replaced: exists(fs, app), sha256: null, asset: ASSET, url, quarantine: null, ...o });
  if (target.dir !== (deps.appsDir || SYSTEM_APPS)) log.info(t('studio.fallback', { dir: target.dir }));
  if (target.other) log.warn(t('studio.otherCopy', { other: target.other, dir: target.dir }));

  const expected = await fetchSha(shaUrl, deps, local);
  if (dryRun) return result({ sha256: expected });

  // From here a stop signal is this one's (lib/json.js stands aside while another listener is
  // there, as in bin/cli.js stopBetweenSteps): it stops the download or ditto, and the install
  // ends as interrupted once the temp dir and the staging are removed. The swap is synchronous:
  // a signal that comes during it is answered after it, by an install that is complete.
  const stop = { sig: null, abort: new AbortController(), child: null };
  const onStop = (sig) => {
    if (stop.sig) {
      if (stop.child) stop.child.kill('SIGKILL');
      return;
    }
    stop.sig = sig;
    stop.abort.abort();
    if (stop.child) stop.child.kill('SIGTERM');
  };
  for (const sig of STOP_SIGNALS) process.on(sig, onStop);

  let tmp = null;
  let staging = null;
  let made = false;
  // Once the target directory holds something of ours: what a failure says was put back.
  let touched = 'none';
  // The temp dir, the staging and a ~/Applications made for it removed; returns what is left in
  // the target directory (the temp dir is outside it: harmless when left).
  const cleanup = (failing) => {
    const left = [];
    for (const p of [staging, tmp]) {
      if (!p) continue;
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        if (p === staging) left.push(p);
      }
    }
    if (failing && made && !left.length) {
      try {
        fs.rmdirSync(target.dir);
      } catch { /* not empty, or not ours to remove after all */ }
    }
    return left;
  };
  const interrupted = () => stop.sig && new StudioError('interrupted', t('studio.cancelled'), touched);
  let cleaned = false;
  try {
    try {
      tmp = fs.mkdtempSync(path.join(deps.tmpdir(), 'wsg-studio-'));
    } catch (e) {
      throw failed(t('studio.writeFailed', { file: deps.tmpdir(), msg: e.message }));
    }
    const zip = path.join(tmp, ASSET);
    log.info(t('studio.downloading', { url }));
    const actual = await fetchZip(url, zip, deps, local, stop.abort.signal);
    if (stop.sig) throw interrupted();
    if (actual !== expected) throw failed(t('studio.mismatch', { expected, actual }));

    try {
      if (target.make) {
        fs.mkdirSync(target.dir, { recursive: true });
        made = true;
      }
      // On the target's volume, so the new copy goes into place with one rename.
      staging = fs.mkdtempSync(path.join(target.dir, '.wsg-studio-install-'));
    } catch (e) {
      throw failed(t('studio.writeFailed', { file: target.dir, msg: e.message }));
    }
    touched = 'done';
    stop.child = deps.spawn('ditto', ['-x', '-k', zip, staging]);
    const r = await stop.child.done;
    stop.child = null;
    // Ctrl+C reaches ditto too (the process group): its exit may come before the signal's handler
    // ran. A turn of the event loop (as guarded() in lib/generate.js) lets it run first.
    if (!r || r.status !== 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (stop.sig) throw interrupted();
    if (!r || r.status !== 0) {
      const msg = (r && ((r.stderr && String(r.stderr).trim()) || (r.error && r.error.message))) || `exit ${r && (r.signal || r.status)}`;
      throw failed(t('studio.unpackFailed', { msg }), touched);
    }
    const fresh = path.join(staging, APP);
    let found;
    let isApp;
    try {
      found = fs.readdirSync(staging).filter((n) => n !== '__MACOSX');
      isApp = found.length === 1 && found[0] === APP && fs.statSync(fresh).isDirectory();
    } catch (e) {
      throw failed(t('studio.readFailed', { dir: staging, msg: e.message }), touched);
    }
    if (!isApp) throw failed(t('studio.noApp', { app: APP, list: found.join(', ') || '-' }), touched);
    // Started while it downloaded: nothing replaced.
    assertNotRunning(app, deps, touched);

    const replaced = exists(fs, app);
    const old = path.join(target.dir, `.${APP}.old-${deps.pid}`);
    if (replaced) {
      try {
        fs.renameSync(app, old);
      } catch (e) {
        throw failed(t('studio.swapFailed', { msg: e.message, app }), touched);
      }
    }
    try {
      fs.renameSync(fresh, app);
    } catch (e) {
      if (!replaced) throw failed(t('studio.placeFailed', { msg: e.message, app }), touched);
      try {
        fs.renameSync(old, app);
      } catch {
        // The old copy is in kept: the message says to move it back by hand.
        const err = failed(t('studio.restoreFailed', { msg: e.message, app, old }), 'incomplete');
        err.kept = [old];
        throw err;
      }
      throw failed(t('studio.swapFailed', { msg: e.message, app }), touched);
    }
    if (replaced) {
      try {
        fs.rmSync(old, { recursive: true, force: true });
      } catch {
        log.warn(t('studio.oldLeft', { old }));
      }
    }

    let quarantine = null;
    try {
      const q = deps.run('xattr', ['-p', 'com.apple.quarantine', app]);
      if (q && q.status === 0) quarantine = true;
      else if (q && q.status === 1) quarantine = false;
    } catch {
      quarantine = null;
    }
    if (quarantine) log.warn(t('studio.quarantine', { app }));
    return { app, dir: target.dir, replaced, sha256: actual, asset: ASSET, url, quarantine };
  } catch (e) {
    cleaned = true;
    const left = cleanup(true);
    // A failure the signal caused (the download aborted, ditto killed) is the interruption.
    const err = interrupted() || e;
    if (left.length && err instanceof StudioError) {
      err.rollback = 'incomplete';
      err.kept = [...err.kept, ...left];
      err.details = [...err.details, ...left.map((p) => t('studio.stagingLeft', { path: p }))];
    }
    throw err;
  } finally {
    if (!cleaned) for (const p of cleanup(false)) log.warn(t('studio.stagingLeft', { path: p }));
    for (const sig of STOP_SIGNALS) process.off(sig, onStop);
  }
}

module.exports = { REPO, ASSET, APP, PROCESS, BASE_URL, StudioError, parseSha, releasesBase, escapeRe, install };
