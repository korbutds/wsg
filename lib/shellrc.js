'use strict';

// The ws function lives in the user's shell, not in wsg: a child process can't change its
// parent's directory, so it has to be hooked into .zshrc (install.sh does that). wsg only needs to
// know whether it is there, to suggest `ws <slug>` as the next step rather than a cd.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// shell/wsg.zsh exports this when it loads: the only reliable sign that ws exists in the shell
// wsg was started from, wherever the user hooked it (.zshrc, a plugin, a sourced file).
const loaded = (env = process.env) => env.WSG_WS_LOADED === '1';

// zsh reads $ZDOTDIR/.zshrc when ZDOTDIR is set. install.sh writes to the same place.
const home = (env) => env.HOME || os.homedir();
const rcPath = (env = process.env) => path.join(env.ZDOTDIR || home(env), '.zshrc');

// ZDOTDIR is often set in .zshenv without export, so Node may not see it: look in both files.
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

module.exports = { loaded, rcPath, isHooked };
