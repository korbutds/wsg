'use strict';

// The wsg config is a shell file: the zsh function `ws` sources it. wsg reads it through a
// shell as well, so `export KEY=…`, $XDG_… and other expansions mean the same in both tools —
// otherwise ws and wsg could quietly work in different roots.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const W = require('./workspace');

const DEFAULTS = {
  WS_ROOT: path.join(os.homedir(), 'workspaces'),
  WSG_TRACKER_URL: '',
  WSG_GLOBAL_MEMORY: '',
  WSG_PARENT_CONTEXT: '',
  WSG_LANG: '',
  // The same setting ws reads: `wsg new` starts this agent in the new workspace.
  WSG_AGENT: '',
};

function expand(v) {
  // $HOME only as a whole name: otherwise $HOMEBREW_PREFIX turns into /Users/x/BREW_PREFIX
  return v
    .replace(/^~(?=\/|$)/, os.homedir())
    .replace(/\$HOME(?![A-Z0-9_])/g, os.homedir())
    .replace(/\$\{HOME\}/g, os.homedir());
}

// Fallback when no shell is available: simple KEY="value" assignments only.
function parseSimple(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    // strip quotes; for an unquoted value, cut off a trailing comment
    const quoted = val.match(/^(['"])(.*)\1\s*(?:#.*)?$/);
    if (quoted) val = quoted[2];
    else val = val.replace(/\s+#.*$/, '').trim();
    out[m[1]] = val;
  }
  return out;
}

function readConfig(file) {
  const keys = Object.keys(DEFAULTS);
  // The keys are removed from the shell's environment so that only the file's values come back:
  // precedence between the environment and the file is decided below.
  const env = { ...process.env };
  for (const k of keys) delete env[k];
  // zsh first: that's what ws sources the file with, so zsh-only syntax means the same here.
  // `|| exit 1`: an error inside the file aborts only the `.`, and the values printed after
  // it would be silently cut at the broken line.
  const script = `. "$1" >/dev/null 2>&1 || exit 1; printf '%s\\0' ${keys.map((k) => `"\${${k}-}"`).join(' ')}`;
  for (const [shell, args] of [['zsh', ['-f', '-c']], ['/bin/sh', ['-c']]]) {
    const r = spawnSync(shell, [...args, script, 'wsg-config', file], { encoding: 'utf8', env });
    if (r.error || r.status !== 0) continue;
    const vals = r.stdout.split('\0');
    const out = {};
    keys.forEach((k, i) => { if (vals[i]) out[k] = vals[i]; });
    return out;
  }
  return parseSimple(fs.readFileSync(file, 'utf8'));
}

// Relative paths are taken from $HOME, not from wherever wsg was started: settings.json gets
// absolute Read() rules and autoMemoryDirectory from WS_ROOT. shell/wsg.zsh does the same.
const PATH_KEYS = ['WS_ROOT', 'WSG_GLOBAL_MEMORY', 'WSG_PARENT_CONTEXT'];

function load() {
  const file =
    process.env.WSG_CONFIG || path.join(os.homedir(), '.config', 'wsg', 'config');
  const out = { ...DEFAULTS };
  if (fs.existsSync(file)) {
    for (const [k, v] of Object.entries(readConfig(file))) out[k] = expand(v);
  }
  // Environment variables take precedence over the file: handy for running tests.
  for (const k of Object.keys(DEFAULTS)) {
    if (process.env[k]) out[k] = expand(process.env[k]);
  }
  for (const k of PATH_KEYS) {
    if (out[k]) out[k] = path.resolve(os.homedir(), out[k]);
  }
  return { ...out, configFile: file, lang: require('./i18n').resolveLang(process.env, out.WSG_LANG) };
}

// A slug is looked up in WS_ROOT, a path — relative to the current directory: `wsg --check .`
// must check the workspace you're in, not all of WS_ROOT. `<epic>/<task>` is a task of an epic in
// WS_ROOT when nothing by that path is here (lstat: a dangling link here still wins).
function resolveWs(target, cfg) {
  if (path.isAbsolute(target)) return target;
  const looksLikePath = target.includes(path.sep) || target === '.' || target === '..' || target.startsWith('~');
  if (!looksLikePath) return path.join(cfg.WS_ROOT, target);
  const here = path.resolve(target.replace(/^~(?=\/|$)/, os.homedir()));
  const nested = epicTask(target.replace(/\/$/, ''), cfg);
  return nested && !lexists(here) ? nested : here;
}

const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const lexists = (p) => lstat(p) !== null;

// WS_ROOT/<epic>/<task>, or '' when the target isn't one. Only under a real epic and only a real
// directory: <task>/<source> would otherwise reach a source's symlink, and `wsg promote` would
// write through it outside WS_ROOT.
function epicTask(target, cfg) {
  const parts = target.split('/');
  if (parts.length !== 2 || !parts.every((p) => W.KEBAB.test(p))) return '';
  const epic = path.join(cfg.WS_ROOT, parts[0]);
  const ws = path.join(epic, parts[1]);
  const st = lstat(ws);
  if (!st || !st.isDirectory()) return '';
  try {
    return W.readState(epic).kind === 'epic' ? ws : '';
  } catch {
    return '';
  }
}

module.exports = { load, expand, resolveWs };
