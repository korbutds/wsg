'use strict';

// Workspace creation. On any failure — full rollback: the directory is removed,
// worktrees are detached, created branches are deleted if they have no commits outside the remote.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const T = require('./templates');
const g = require('./git');
const ui = require('./ui');
const { t } = require('./i18n');

// Copy-on-write. Node doesn't have it: COPYFILE_FICLONE exists, doesn't fail,
// and silently copies byte by byte — 57 MB of data took 57 MB of disk vs 0 MB with `cp -c`.
// Hence the external cp, and only on macOS.
function cloneDir(src, dst) {
  if (os.platform() !== 'darwin') return { ok: false, reason: t('gen.cowApfsOnly') };
  const r = spawnSync('cp', ['-Rc', src, dst], { encoding: 'utf8' });
  return r.status === 0 ? { ok: true } : { ok: false, reason: t('gen.clonefileUnavailable'), signal: r.signal };
}

function freeKb(p) {
  const r = spawnSync('df', ['-k', p], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const last = String(r.stdout).trim().split('\n').pop().split(/\s+/);
  return parseInt(last[3], 10);
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

function interrupted(res) {
  if (STOP_SIGNALS.includes(res.signal)) throw interruptedError();
}

async function run(a, cfg) {
  let hit = false;
  const onSignal = () => { hit = true; };
  for (const sig of STOP_SIGNALS) process.on(sig, onSignal);
  // With the terminal gone, writing the rollback messages fails with EIO/EPIPE; that must not
  // crash the rollback itself.
  const ignore = () => {};
  process.stdout.on('error', ignore);
  process.stderr.on('error', ignore);
  try {
    const { ws, rollback } = create(a, cfg);
    // Creation is synchronous, so the signal handler can't fire while it runs. A pending
    // Ctrl+C is read in the poll phase. A timer resumes us in the timers phase whatever
    // phase run() was called from, and the setImmediate after it fires in the check phase
    // of the same turn — so a poll phase always lies in between.
    // The user asked to cancel — roll back even the finished workspace.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setImmediate(resolve));
    if (hit) {
      rollback();
      throw interruptedError();
    }
    return ws;
  } finally {
    for (const sig of STOP_SIGNALS) process.off(sig, onSignal);
    process.stdout.off('error', ignore);
    process.stderr.off('error', ignore);
  }
}

// Names the generator creates at the workspace root. A source with one of these names would be a
// symlink there, and writing the template would go through it — over the user's own file
// outside the workspace. `repo` is allowed: the pointer is skipped when a source takes the name.
// `.git` too: a symlink to someone's .git would make the workspace itself a work tree of that repo.
const RESERVED = ['CLAUDE.md', 'AGENTS.md', 'README.md', 'notes.md', 'journal.md', 'runs',
  'mr-target-branch.txt', '.claude', '.claude-memory', '.learnings', '.git'];

// Why a source can't be used, or ''. Compared case-insensitively: macOS and Windows file
// systems treat readme.md and README.md as the same file.
function sourceProblem(r) {
  let st;
  try { st = fs.statSync(r.path); } catch { return t('gen.sourceMissing', { path: r.path }); }
  if (!st.isDirectory()) return t('gen.sourceNotDir', { path: r.path });
  if (RESERVED.some((n) => n.toLowerCase() === r.name.toLowerCase())) {
    return t('gen.sourceReserved', { name: r.name });
  }
  return '';
}

function create(a, cfg) {
  const ws = path.join(cfg.WS_ROOT, a.slug);
  if (fs.existsSync(ws)) throw new Error(t('validate.exists', { path: ws }));
  const seen = new Set();
  for (const r of a.repos) {
    const problem = sourceProblem(r);
    if (problem) throw new Error(problem);
    if (seen.has(r.name.toLowerCase())) throw new Error(t('gen.twoSources', { name: r.name }));
    seen.add(r.name.toLowerCase());
  }

  const ctx = {
    ws,
    wsRoot: cfg.WS_ROOT,
    globalMemory: a.personalRules ? cfg.WSG_GLOBAL_MEMORY : '',
    isRepo: (r) => g.isRepo(r.path),
    hasAgentsMd: (r) => fs.existsSync(path.join(ws, r.name, 'AGENTS.md')),
    hasClaudeMd: (r) => fs.existsSync(path.join(ws, r.name, 'CLAUDE.md')),
    head: (r) => g.headShort(path.join(ws, r.name)),
  };

  const madeBranches = [];
  // Existing branches reset to the base via -B: on rollback they are restored from the backup.
  const resetBranches = [];
  let created = false;

  const rollback = () => {
    if (!created) return;
    ui.err(`\n${t('gen.rollingBack', { ws })}`);
    const touched = new Set();
    for (const r of a.repos) {
      if (r.mode !== 'worktree') continue;
      touched.add(r.path);
      if (!fs.existsSync(path.join(ws, r.name))) continue;
      const rm = g.gitRun(r.path, ['worktree', 'remove', '--force', path.join(ws, r.name)]);
      if (!rm.ok) ui.err(t('gen.worktreeRemoveFailed', { name: r.name, out: rm.out.trim() }));
    }
    fs.rmSync(ws, { recursive: true, force: true });
    // The directory is gone, but the worktree registration may remain — otherwise the next run
    // with the same slug hits "already registered" and the branch can't be deleted.
    for (const repo of touched) g.gitRun(repo, ['worktree', 'prune']);
    for (const { repo, name, backup, tracking } of resetBranches) {
      const back = g.gitRun(repo, ['branch', '-f', name, backup]);
      if (!back.ok) {
        ui.err(t('gen.branchLeftAtBase', { name, backup, out: back.out.trim() }));
        continue;
      }
      g.gitRun(repo, ['branch', '-D', backup]);
      // Safety net: worktree add runs with --no-track and should leave the tracking config alone
      const restored = Object.entries(tracking).every(([key, value]) =>
        value === null
          ? [0, 5].includes(g.gitRun(repo, ['config', '--unset', key]).status) // 5: was not set
          : g.gitRun(repo, ['config', key, value]).ok);
      if (restored) ui.err(t('gen.branchRestored', { name }));
      else ui.err(t('gen.branchRestoredNoUpstream', { name }));
    }
    for (const { repo, name, base } of madeBranches) {
      // worktree add may have been interrupted before it created the branch.
      if (!g.branchExists(repo, name)) continue;
      // The branch was created by this run from base: anything not in base was made afterwards.
      // Comparing with the remote won't do — in a repo without a remote it counts the whole history.
      const unique = g.git(repo, ['rev-list', '--count', name, '--not', base]);
      if (unique !== '0') {
        ui.err(t('gen.branchKept', { name, base }));
        continue;
      }
      const del = g.gitRun(repo, ['branch', '-D', name]);
      if (del.ok) ui.err(t('gen.branchDeleted', { name }));
      else ui.err(t('gen.branchDeleteFailed', { name, out: del.out.trim() }));
    }
    ui.err(t('gen.rollbackDone'));
  };

  try {
    ui.head(t('gen.creating', { ws }));
    fs.mkdirSync(path.join(ws, '.claude', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.claude-memory'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.learnings'), { recursive: true });
    created = true;
    fs.writeFileSync(path.join(ws, '.claude', 'ws-kind'), `${a.kind}\n`);
    if (a.kind === 'process') {
      fs.mkdirSync(path.join(ws, '.claude', 'skills', a.skillName), { recursive: true });
      fs.mkdirSync(path.join(ws, 'runs'), { recursive: true });
    }

    for (const r of a.repos) {
      const dest = path.join(ws, r.name);
      if (r.mode === 'worktree') {
        if (g.worktreeBranches(r.path).includes(r.branch)) {
          throw new Error(t('validate.branchBusy', { b: r.branch }));
        }
        // Not branchExists: a show-ref interrupted by Ctrl+C would look like "no branch",
        // and rollback would then delete someone else's branch as if created here.
        const exists = g.gitRun(r.path, ['show-ref', '--verify', '--quiet', `refs/heads/${r.branch}`]);
        interrupted(exists);
        if (exists.ok) {
          // `-B` resets the existing branch to the base, so this path is forbidden without a
          // confirmed backup: silently losing commits is worse than refusing.
          const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
          const bk = `backup/${r.branch.replace(/\//g, '-')}-${stamp}`;
          // Raw config values, not the resolved @{upstream}: that fails when the remote-tracking
          // ref is missing (after fetch --prune), and restoring "no upstream" would wipe the setting.
          const tracking = {};
          for (const key of [`branch.${r.branch}.remote`, `branch.${r.branch}.merge`]) {
            const v = g.gitRun(r.path, ['config', '--get', key]);
            interrupted(v);
            if (v.status !== 0 && v.status !== 1) throw new Error(`git config --get ${key}: ${v.out.trim()}`);
            tracking[key] = v.status === 0 ? v.out.trim() : null; // 1: key not set
          }
          const bkRes = g.gitRun(r.path, ['branch', bk, r.branch]);
          if (!bkRes.ok) {
            throw new Error(t('gen.backupFailed', { branch: r.branch, bk, out: bkRes.out.trim() }));
          }
          ui.info(t('gen.backup', { bk }));
          resetBranches.push({ repo: r.path, name: r.branch, backup: bk, tracking });
          // --no-track: the branch keeps its own upstream (an MR branch tracks origin/<itself>).
          // With --track, git would point it at the base, and pull would merge the base into it.
          const res = g.gitRun(r.path, ['worktree', 'add', '--no-track', '-B', r.branch, dest, r.base]);
          interrupted(res);
          if (!res.ok) throw new Error(`worktree add: ${res.out.trim()}`);
        } else {
          const conflict = g.branchRefConflict(r.path, r.branch);
          if (conflict) throw new Error(t('gen.branchConflict', { branch: r.branch, conflict }));
          // Record before the call: an interrupted worktree add may still have created the branch.
          madeBranches.push({ repo: r.path, name: r.branch, base: r.base });
          const res = g.gitRun(r.path, ['worktree', 'add', '--no-track', '-b', r.branch, dest, r.base]);
          interrupted(res);
          if (!res.ok) throw new Error(`worktree add: ${res.out.trim()}`);
        }
        ui.info(t('gen.worktree', { name: r.name, branch: r.branch }));

        if (r.carry && r.carry.length) {
          const copied = [];
          for (const c of r.carry) {
            try {
              fs.mkdirSync(path.dirname(path.join(dest, c)), { recursive: true });
              // EXCL: a file ignored here may be tracked in the base — don't overwrite the checked-out one
              fs.copyFileSync(path.join(r.path, c), path.join(dest, c), fs.constants.COPYFILE_EXCL);
              copied.push(c);
            } catch (e) {
              // e.g. the file vanished between the interview and creation
              ui.warn(t('gen.notCopied', { file: c, why: e.code || e.message }));
            }
          }
          ui.info(t('gen.copied', { n: copied.length, total: r.carry.length }));
          // The rule for this repository lists these files as copied: only what actually was.
          r.carry = copied;
        }

        if (r.cloneNm && fs.existsSync(path.join(dest, 'node_modules'))) {
          // node_modules is committed in this repository (GitHub Actions do that): the worktree
          // already has it, and cp -R would nest a copy inside.
          ui.dim(t('gen.nmTracked'));
        } else if (r.cloneNm && fs.existsSync(path.join(r.path, 'node_modules'))) {
          ui.info(t('gen.nmCloning'));
          const before = freeKb(ws);
          const res = cloneDir(path.join(r.path, 'node_modules'), path.join(dest, 'node_modules'));
          interrupted(res);
          if (res.ok) {
            const after = freeKb(ws);
            const mb = before != null && after != null ? Math.round((before - after) / 1024) : '?';
            ui.info(t('gen.nmCloned', { mb }));
            ui.dim(t('gen.nmVersions'));
          } else {
            // cp may have created part of the tree before failing (another volume, no APFS)
            fs.rmSync(path.join(dest, 'node_modules'), { recursive: true, force: true });
            ui.warn(t('gen.nmNotCopied', { reason: res.reason }));
          }
        }
      } else {
        fs.symlinkSync(r.path, dest);
        ui.info(t('gen.symlink', { name: r.name, path: r.path }));
      }
    }

    // `repo` must point to a repository, not just the first source:
    // tools use it to determine the project and the MR target branch.
    const main = a.repos.find((r) => r.mode === 'worktree' && g.isRepo(r.path))
      || a.repos.find((r) => g.isRepo(r.path));
    if (main) {
      if (a.repos.some((r) => r.name.toLowerCase() === 'repo')) { // Repo and repo are one file on APFS
        ui.warn(t('gen.repoNamed'));
      } else {
        fs.symlinkSync(main.name, path.join(ws, 'repo'));
      }
      fs.writeFileSync(path.join(ws, 'mr-target-branch.txt'), `${main.target}\n`, { flag: 'wx' });
    } else {
      ui.dim(t('gen.noGit'));
    }

    // wx: never write through an existing path — a symlink there would lead outside the workspace.
    const w = (rel, body) => fs.writeFileSync(path.join(ws, rel), body, { flag: 'wx' });
    w('.claude/settings.json', T.settingsJson(a, ctx));
    w('CLAUDE.md', T.claudeMd(a, ctx));
    w('AGENTS.md', T.agentsMd(a, ctx));
    w('README.md', T.readmeMd(a, ctx));
    w('notes.md', T.notesMd(a, ctx));
    w('.learnings/LEARNINGS.md', T.learningsMd(a));
    w('.learnings/ERRORS.md', T.errorsMd(a));
    for (const r of a.repos) w(path.join('.claude/rules', `${r.name}.md`), T.ruleMd(a, r, ctx));
    if (a.kind === 'process') {
      w(path.join('.claude/skills', a.skillName, 'SKILL.md'), T.skillMd(a));
      w('journal.md', T.journalMd(a));
    }

    JSON.parse(fs.readFileSync(path.join(ws, '.claude/settings.json'), 'utf8'));
    return { ws, rollback };
  } catch (e) {
    rollback();
    throw e;
  }
}

module.exports = { run, cloneDir, sourceProblem, RESERVED };
