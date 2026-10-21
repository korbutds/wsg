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

function gitRun(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || ''), status: r.status, signal: r.signal };
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
function ignoredCandidates(repo) {
  // -z: without it non-ASCII names come C-quoted and are silently dropped by statSync.
  return git(repo, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])
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
  git, gitRun, isRepo, isRepoRoot, headShort, currentBranch, localBranches,
  branchExists, branchRefConflict, worktreeBranches, ignoredCandidates,
};
