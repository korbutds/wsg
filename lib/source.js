'use strict';

// One source, from what `wsg add` was given to a spec that generate can attach. Everything the
// interview of 0.1 checked between questions happens here, before anything is touched: a rejected
// add leaves the workspace and the repository exactly as they were.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const g = require('./git');
const { RESERVED } = require('./workspace');
const { t } = require('./i18n');

const TICKET_RE = /[A-Z][A-Z0-9]+-\d+/;

// Ticket ID from the answer: a key like ABC-123 anywhere in it (a URL included), or — when the
// whole answer is a bare number — the number itself, which is what the tracker prefix in the
// config is for. Lowercase "fix-2" stays free text: it's more often a branch than a ticket.
function parseTicket(raw) {
  const m = raw.match(TICKET_RE);
  if (m) return m[0];
  if (/^\d+$/.test(raw)) return raw;
  return '';
}

// `wsg new --ticket`: a URL is kept as the link, a key or number gets one from the tracker prefix,
// and anything else is written down as given.
function ticketFields(raw, cfg) {
  const text = (raw || '').trim();
  if (!text) return { ticket: '', ticketUrl: '' };
  const ticket = parseTicket(text);
  if (/^https?:\/\//.test(text)) return { ticket, ticketUrl: text.split(/\s+/)[0] };
  if (cfg.WSG_TRACKER_URL && ticket) return { ticket, ticketUrl: cfg.WSG_TRACKER_URL + ticket };
  return { ticket: ticket || text, ticketUrl: '' };
}

// A relative path would produce a self-referencing symlink: ws/src -> src.
const resolvePath = (p) => path.resolve(p.replace(/^~(?=\/|$)/, os.homedir()));

// The source name becomes a directory in the workspace and an @name/AGENTS.md import in CLAUDE.md,
// and an import containing a space doesn't resolve.
const sourceName = (full) => path.basename(full).replace(/\s+/g, '-');

// Why a source can't be used, or ''. Compared case-insensitively: macOS and Windows file
// systems treat readme.md and README.md as the same file. stat follows links, so a dangling one
// (an unmounted drive) is reported as missing.
function sourceProblem(r) {
  let st;
  try { st = fs.statSync(r.path); } catch { st = null; }
  if (!st) return t('gen.sourceMissing', { path: r.path });
  if (!st.isDirectory()) return t('gen.sourceNotDir', { path: r.path });
  if (RESERVED.some((n) => n.toLowerCase() === r.name.toLowerCase())) {
    return t('gen.sourceReserved', { name: r.name });
  }
  return '';
}

// Why a task branch name can't be used, or '' if it can. Everything here would otherwise fail
// only at worktree add, after the workspace files were already touched.
function branchError(repo, b, heads, busy) {
  if (!b) return t('validate.required');
  if (!g.git(repo, ['check-ref-format', '--branch', b])) return t('validate.branchInvalid', { b });
  if (busy.includes(b)) return t('validate.branchBusy', { b });
  // Git branches are paths: a/b and a/b/c can't exist at the same time.
  const conflict = heads.find((h) => b.startsWith(h + '/') || h.startsWith(b + '/'));
  if (conflict) return t('validate.branchConflict', { conflict });
  return '';
}

// The default MR target: what the remote calls its default branch, else the branch checked out now.
function defaultTarget(repo) {
  const head = g.git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
  return head || g.git(repo, ['symbolic-ref', '--short', 'HEAD']) || 'main';
}

const resolvesToCommit = (repo, ref) => !!g.git(repo, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);

// The repo pointer is a relative link to a sibling; a source named repo is an absolute one.
function isRepoPointer(ws, name) {
  if (name.toLowerCase() !== 'repo') return false;
  try {
    return !fs.readlinkSync(path.join(ws, name)).includes('/');
  } catch {
    return false;
  }
}

// Flags that make sense only for a worktree: given for a link, they'd be silently ignored, and the
// agent would believe a branch was created.
const WORKTREE_ONLY = [['branch', '--branch'], ['base', '--base'], ['reuseBranch', '--reuse-branch'],
  ['carry', '--carry'], ['cloneNm', '--clone-node-modules']];

// raw: the path as given; opts: { mode: 'worktree'|'link'|'reference', branch, base, reuseBranch,
// target, verify, carry: 'all'|'none'|'a,b', cloneNm: true|false, note }; ctx: { ws, state }.
// Returns { spec, errors, warnings, plan }: spec is what generate attaches (null when there are
// errors), plan is what --dry-run prints.
function resolve(raw, opts = {}, { ws, state } = {}) {
  const errors = [];
  const warnings = [];
  const sources = (state && state.sources) || [];
  const done = (spec, plan) => ({ spec: errors.length ? null : spec, errors, warnings, plan });

  if (!raw) {
    errors.push(t('add.noPath'));
    return done(null, null);
  }
  const full = resolvePath(raw);
  const name = sourceName(full);
  const plan = { path: full, name };
  const problem = sourceProblem({ path: full, name });
  if (problem) {
    errors.push(problem);
    return done(null, plan);
  }
  if (name !== path.basename(full)) warnings.push(t('add.renamed', { name }));
  // Case-insensitive, like the file systems on macOS and Windows.
  const samePath = sources.find((s) => s.path.toLowerCase() === full.toLowerCase());
  const sameName = sources.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (samePath) errors.push(t('add.duplicatePath', { name: samePath.name }));
  else if (sameName) errors.push(t('add.duplicateName', { name, path: sameName.path }));
  else if (ws) {
    let taken = false;
    try { fs.lstatSync(path.join(ws, name)); taken = true; } catch { /* free */ }
    if (taken && !isRepoPointer(ws, name)) errors.push(t('add.taken', { name }));
  }

  const kind = (state && state.kind) || 'task';
  const inGit = g.isRepo(full);
  let mode;
  if (!inGit) {
    // Not under git: material to read, never the code the task changes. Attached only when asked
    // for, so a mistyped repository path isn't quietly linked as a plain folder.
    if (opts.mode !== 'reference') errors.push(t('add.notGit', { path: full }));
    mode = 'reference';
  } else if (opts.mode === 'reference') {
    errors.push(t('add.referenceIsGit', { path: full }));
    mode = 'link';
  } else if (!g.isRepoRoot(full)) {
    // A worktree is always of the whole repository, not of a subdirectory.
    const top = g.git(full, ['rev-parse', '--show-toplevel']);
    if (opts.mode === 'worktree') errors.push(t('add.subdirWorktree', { top }));
    else if (!opts.mode) warnings.push(t('add.subdirLink', { top }));
    mode = 'link';
  } else if (kind === 'process') {
    // A process has no permanent branch: the skill creates one per run.
    if (opts.mode === 'worktree') errors.push(t('add.processWorktree'));
    else if (!opts.mode) warnings.push(t('add.processLink'));
    mode = 'link';
  } else {
    mode = opts.mode || 'worktree';
  }
  plan.mode = mode;

  if (mode !== 'worktree') {
    for (const [key, flag] of WORKTREE_ONLY) {
      if (opts[key] !== undefined) errors.push(t('add.worktreeOnly', { flag, mode }));
    }
  }
  if (mode === 'reference' && opts.target !== undefined) errors.push(t('add.worktreeOnly', { flag: '--target', mode }));

  const spec = {
    path: full,
    name,
    mode: mode === 'worktree' ? 'worktree' : 'link',
    reference: mode === 'reference',
    branch: '',
    base: '',
    target: '—',
    verify: (opts.verify || '').trim(),
    note: (opts.note || '').trim(),
    carry: [],
    cloneNm: false,
  };
  plan.verify = spec.verify;
  plan.note = spec.note;

  if (mode === 'reference') {
    // Code-only scope: a reference sits next to the repositories, it doesn't replace them.
    if (!sources.some((s) => !s.reference)) warnings.push(t('add.referenceFirst'));
    return done(spec, plan);
  }

  spec.target = (opts.target || '').trim() || defaultTarget(full);
  plan.target = spec.target;
  if (mode === 'link') return done(spec, plan);

  // --- worktree
  const heads = g.localBranches(full);
  const busy = g.worktreeBranches(full);
  spec.branch = (opts.branch || '').trim();
  plan.branch = spec.branch;
  if (!spec.branch) errors.push(t('add.branchRequired'));
  else {
    const bad = branchError(full, spec.branch, heads, busy);
    if (bad) errors.push(bad);
  }
  plan.branchExists = !!spec.branch && heads.includes(spec.branch);
  if (plan.branchExists) {
    // `worktree add -B` resets the branch to the base; the old head goes to backup/… first.
    // Commits survive, but the branch is no longer the same — so it takes an explicit flag.
    if (!opts.reuseBranch) errors.push(t('add.branchExists', { branch: spec.branch }));
    else warnings.push(t('add.branchReset', { branch: spec.branch }));
  }

  if (opts.base !== undefined) {
    spec.base = opts.base.trim();
    if (!resolvesToCommit(full, spec.base)) errors.push(t('validate.refNotFound', { ref: spec.base, name }));
  } else if (resolvesToCommit(full, `origin/${spec.target}`)) {
    spec.base = `origin/${spec.target}`;
  } else if (resolvesToCommit(full, spec.target)) {
    // No remote (or not fetched): the local target branch is the only base there is.
    spec.base = spec.target;
    warnings.push(t('add.baseLocal', { target: spec.target }));
  } else {
    errors.push(t('validate.refNotFound', { ref: `origin/${spec.target}`, name }));
  }
  plan.base = spec.base;

  // Files git ignores but the work needs (.env, certificates): the same list the dry run shows.
  const candidates = g.ignoredCandidates(full);
  plan.carryCandidates = candidates;
  const pick = (opts.carry === undefined ? 'all' : String(opts.carry)).trim();
  if (pick === 'all') spec.carry = candidates;
  else if (pick === 'none' || pick === '') spec.carry = [];
  else {
    for (const f of pick.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (candidates.includes(f)) spec.carry.push(f);
      else errors.push(t('add.carryUnknown', { file: f }));
    }
  }
  plan.carry = spec.carry;

  // Copy-on-write is macOS-only (see cloneDir), so elsewhere the default is to install instead.
  const inMain = fs.existsSync(path.join(full, 'node_modules'));
  spec.cloneNm = opts.cloneNm === undefined ? inMain && os.platform() === 'darwin' : !!opts.cloneNm;
  if (opts.cloneNm && !inMain) warnings.push(t('add.nmMissing'));
  plan.nodeModules = { inMainCheckout: inMain, clone: spec.cloneNm };
  return done(spec, plan);
}

module.exports = {
  parseTicket, ticketFields, resolvePath, sourceName, sourceProblem, branchError, defaultTarget,
  isRepoPointer, resolve,
};
