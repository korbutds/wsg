'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

function git(dir, args, { quiet = true } = {}) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'inherit'],
    }).trim();
  } catch {
    return '';
  }
}

// Ctrl+C goes to the whole process group. Without a handler Node dies immediately and the
// rollback doesn't run: the directory, the registered worktree and the branch remain. With a
// handler the signal kills only the child git or cp — visible via signal, and rollback runs.
function interruptedError() {
  const e = new Error('interrupted');
  e.name = 'Interrupted';
  return e;
}

// Ctrl+C, a closed terminal window, kill: each must roll back, not leave a half-built workspace.
const STOP_SIGNALS = ['SIGINT', 'SIGHUP', 'SIGTERM'];

// For a listing a decision rests on: the output as git wrote it (a name may be all spaces), no
// size cap that matters, and a failure is an error, never an empty list. A git stopped by Ctrl+C
// stops the command (Interrupted); a listing over the cap throws with code ENOBUFS.
const LIST_MAX = 256 * 1024 * 1024;
function gitList(dir, args, { max = LIST_MAX } = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: max });
  // Before the signal: over maxBuffer, Node kills git with SIGTERM itself.
  if (r.error) throw Object.assign(new Error(`git ${args[0]}: ${r.error.code || r.error.message}`), { code: r.error.code });
  if (STOP_SIGNALS.includes(r.signal)) throw interruptedError();
  if (r.status !== 0) {
    const why = (r.stderr || '').trim().split('\n')[0] || (r.signal ? `signal ${r.signal}` : `exit ${r.status}`);
    throw new Error(`git ${args[0]}: ${why}`);
  }
  return r.stdout;
}

function gitRun(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  // stdout alone too, for a value parsed from it: a warning git writes to stderr is no part of it.
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '', status: r.status, signal: r.signal };
}

// What `git fetch` runs with: never a prompt, a terminal that waits on nobody. GIT_TERMINAL_PROMPT=0
// stops an https password prompt; ssh asks on the tty itself, so it gets BatchMode, but only when the
// owner has no ssh command of their own (GIT_SSH, GIT_SSH_COMMAND, core.sshCommand): theirs may carry
// a key or a proxy, and replacing it would break the fetch it is there for.
function fetchEnv(dir, env = process.env) {
  const out = { ...env, GIT_TERMINAL_PROMPT: '0' };
  if (!env.GIT_SSH && !env.GIT_SSH_COMMAND && !git(dir, ['config', '--get', 'core.sshCommand'])) {
    out.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=10';
  }
  return out;
}

const FETCH_TIMEOUT_MS = 20000;

// `git fetch <remote>` before a branch is started from the remote's refs, so it starts from what
// the remote has now. No tags, no prune: only the remote-tracking branches move, nothing local goes.
// A slow or unreachable remote is stopped after the timeout (WSG_FETCH_TIMEOUT_MS) with SIGTERM, not
// SIGKILL: the .git is shared with the main checkout, and git cleans up its *.lock files on SIGTERM.
// Returns { ok, why }: a failure is the caller's warning, never an error. Ctrl+C stops the command.
function fetchRemote(dir, remote, { timeoutMs } = {}) {
  const fromEnv = Number(process.env.WSG_FETCH_TIMEOUT_MS);
  const timeout = timeoutMs || (fromEnv > 0 ? fromEnv : FETCH_TIMEOUT_MS);
  const r = spawnSync('git', ['-C', dir, 'fetch', '--no-tags', '--quiet', remote],
    { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], env: fetchEnv(dir), timeout });
  // Before the signal: a timeout is Node's own SIGTERM, no Ctrl+C.
  if (r.error) return { ok: false, why: r.error.code === 'ETIMEDOUT' ? `timed out after ${timeout / 1000}s` : r.error.code || r.error.message };
  if (STOP_SIGNALS.includes(r.signal)) throw interruptedError();
  if (r.status === 0) return { ok: true, why: '' };
  return { ok: false, why: (r.stderr || '').trim().split('\n')[0] || (r.signal ? `signal ${r.signal}` : `exit ${r.status}`) };
}

// The root of a checkout or a worktree (.git is a directory or a file there). Cheap — for listings.
const isRepoRoot = (p) => fs.existsSync(path.join(p, '.git'));
// Anywhere inside a work tree: a monorepo package or a repo's docs folder is under git too,
// and edits there land on the shared checkout's branch. A home directory that is itself a work
// tree (`git init ~` for dotfiles) doesn't make everything under it a project.
function isRepo(p) {
  const top = git(p, ['rev-parse', '--show-toplevel']);
  if (!top) return false;
  return isRepoRoot(p) || fs.realpathSync(top) !== fs.realpathSync(os.homedir());
}
const headShort = (dir) => git(dir, ['rev-parse', '--short', 'HEAD']);
const currentBranch = (dir) => git(dir, ['branch', '--show-current']);
const localBranches = (dir) =>
  git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(Boolean);

const branchExists = (dir, b) => gitRun(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`]).ok;

// Git branches are paths: refs/heads/a/b and refs/heads/a/b/c can't coexist.
function branchRefConflict(dir, b) {
  return localBranches(dir).find((h) => b.startsWith(h + '/') || h.startsWith(b + '/')) || '';
}

const worktreeBranches = (dir) =>
  git(dir, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('branch '))
    .map((l) => l.replace('branch refs/heads/', ''));

// Files ignored by git but needed for work: .env, certificates, local configs.
// They don't get into a worktree — git only carries tracked files.
// A git stopped by Ctrl+C stops the command (Interrupted): an empty list would read as "nothing
// to carry". Any other failure is an empty list, as before.
function ignoredCandidates(repo) {
  // -z: without it non-ASCII names come C-quoted and are silently dropped by statSync.
  const r = spawnSync('git', ['-C', repo, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024 });
  // Over maxBuffer Node kills git with SIGTERM itself and says so in r.error: that is no Ctrl+C.
  if (!r.error && STOP_SIGNALS.includes(r.signal)) throw interruptedError();
  return (r.status === 0 && !r.error ? r.stdout.trim() : '')
    .split('\0')
    .filter(Boolean)
    .filter((f) => !f.endsWith('/'))
    .filter((f) => f.split('/').length <= 3)
    .filter((f) => !/(^|\/)node_modules\//.test(f))
    .filter((f) => !/\.(log|tsbuildinfo|html)$/.test(f))
    .filter((f) => !/(^|\/)\.DS_Store$/.test(f))
    .filter((f) => !f.startsWith('.husky/'))
    .filter((f) => !/cache/.test(f))
    .filter((f) => {
      try {
        const st = fs.statSync(path.join(repo, f));
        return st.isFile() && st.size <= 1048576;
      } catch {
        return false;
      }
    });
}

module.exports = {
  STOP_SIGNALS, interruptedError, git, gitList, gitRun, isRepo, isRepoRoot, headShort, currentBranch, localBranches,
  branchExists, branchRefConflict, worktreeBranches, ignoredCandidates, fetchEnv, fetchRemote,
};
