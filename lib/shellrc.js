'use strict';

// The ws function lives in the user's shell, not in wsg: a child process can't change its
// parent's directory. So it has to be hooked into .zshrc. npm has no install step we could use
// (npx skips it, and many people run with --ignore-scripts), so the interview offers it at the end.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Same line as install.sh — keep the two in sync: the guard keeps the rc quiet if wsg is later
// removed or PATH changes.
const LINE = 'command -v wsg >/dev/null && eval "$(wsg shell-init zsh)"';

// shell/wsg.zsh exports this when it loads: the only reliable sign that ws exists in the shell
// wsg was started from, wherever the user hooked it (.zshrc, a plugin, a sourced file).
const loaded = (env = process.env) => env.WSG_WS_LOADED === '1';

// zsh reads $ZDOTDIR/.zshrc when ZDOTDIR is set. install.sh writes to the same place.
const home = (env) => env.HOME || os.homedir();
const rcPath = (env = process.env) => path.join(env.ZDOTDIR || home(env), '.zshrc');

// ZDOTDIR is often set in .zshenv without export, so Node may not see it: look in both files
// rather than offer a second hook.
const rcCandidates = (env = process.env) => [...new Set([rcPath(env), path.join(home(env), '.zshrc')])];

// Any form counts — the user may have written it by hand, without the guard — except a comment.
const HOOK_RE = /^[^#\n]*wsg shell-init/m;
function isHooked(env = process.env) {
  return rcCandidates(env).some((rc) => {
    try {
      return HOOK_RE.test(fs.readFileSync(rc, 'utf8'));
    } catch {
      return false;
    }
  });
}

// The hook line is guarded by `command -v wsg`, so it does nothing unless a new shell finds wsg.
// Under npx it is on PATH only for this run, from npx's own cache.
function wsgOnPath(env = process.env) {
  return (env.PATH || '').split(path.delimiter).some((dir) => {
    if (!dir || dir.split(path.sep).includes('_npx')) return false;
    try {
      fs.accessSync(path.join(dir, 'wsg'), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// A file edited by hand may lack the final newline: the new line would glue onto the last one.
function append(file, text) {
  let cur = '';
  try {
    cur = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const lead = cur === '' ? '' : cur.endsWith('\n') ? '\n' : '\n\n';
  fs.appendFileSync(file, `${lead}${text}`);
}

// Append-only, so the rest of the file is never rewritten.
const hook = (rc) => append(rc, `# wsg\n${LINE}\n`);

// A "no" is remembered in the config, or the question comes back after every workspace.
const rememberDecline = (configFile) => append(configFile, 'WSG_SHELL_HOOK="no"\n');

module.exports = { LINE, loaded, rcPath, isHooked, wsgOnPath, hook, rememberDecline };
