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
const WORKTREE_ONLY = [['branch', '--branch'], ['base', '--base'], ['resetToBase', '--reset-to-base'],
  ['carry', '--carry'], ['cloneNm', '--clone-node-modules']];

// The placeholders of an epic's branch template, and what --dry-run expands them to for a sample.
const TEMPLATE_VARS = { slug: 'sample-task', ticket: 'PROJ-1' };

// A branch template of an epic expanded for one task; vars: { slug, ticket }.
const expandTemplate = (template, vars) => template.replace(/\{(slug|ticket)\}/g, (_, k) => vars[k]);

// Why a branch template can't be used, or ''. Every task of the epic gets its branch from it, so it
// must name the task — a placeholder — and expand to a valid branch name. The user part is literal.
function templateError(repo, template) {
  if (!template) return t('add.templateEmpty');
  if (/[\r\n`]/.test(template) || template.includes('<!--')) return t('add.templateText', { template });
  const used = [...template.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
  const unknown = used.find((v) => !Object.prototype.hasOwnProperty.call(TEMPLATE_VARS, v));
  if (unknown !== undefined) return t('add.templateUnknown', { template, name: `{${unknown}}` });
  const sample = expandTemplate(template, TEMPLATE_VARS);
  // A lone brace left over: "{slug" is no placeholder, and git would take the brace literally.
  if (/[{}]/.test(sample)) return t('add.templateUnknown', { template, name: sample.match(/[{}]/)[0] });
  if (!used.length) return t('add.templateNoPlaceholder', { template });
  if (!g.git(repo, ['check-ref-format', '--branch', sample])) return t('add.templateInvalid', { template, sample });
  return '';
}

// The files a worktree of the repository may get copied in, and the ones picked: 'all' (the
// default), 'none' or a list, each name checked against the candidates. Shared by a task's worktree
// and an epic's task defaults, so the two pick alike.
function pickCarry(candidates, carry, errors) {
  const pick = (carry === undefined ? 'all' : String(carry)).trim();
  if (pick === 'all') return [...candidates];
  if (pick === 'none' || pick === '') return [];
  const out = [];
  for (const f of pick.split(',').map((x) => x.trim()).filter(Boolean)) {
    if (candidates.includes(f)) out.push(f);
    else errors.push(t('add.carryUnknown', { file: f }));
  }
  return out;
}

// Copy-on-write is macOS-only (see cloneDir), so elsewhere the default is to install instead.
const cloneDefault = (repo) => fs.existsSync(path.join(repo, 'node_modules')) && os.platform() === 'darwin';

// Flags that in an epic describe the worktrees its tasks get, so they need --branch-template.
const TASK_DEFAULTS = [['base', '--base'], ['carry', '--carry'], ['cloneNm', '--clone-node-modules']];
const typed = (opts, key, flag) => (key === 'cloneNm' && opts.cloneNm === false ? '--no-clone-node-modules' : flag);

// raw: the path as given; opts: { mode: 'worktree'|'link'|'reference', branch, base, resetToBase,
// target, verify, carry: 'all'|'none'|'a,b', cloneNm: true|false, note, branchTemplate }; ctx: { ws,
// state, home }: home, the workspace's real path, given for one not made yet (a task of an epic that
// `wsg new` is about to make), which has none to read.
// Returns { spec, errors, warnings, notes, plan }: spec is what generate attaches (null when there
// are errors), plan is what --dry-run prints, notes are what happens, worth a line but no warning.
function resolve(raw, opts = {}, { ws, state, home: given } = {}) {
  const errors = [];
  const warnings = [];
  const notes = [];
  const sources = (state && state.sources) || [];
  const done = (spec, plan) => {
    if (plan) plan.notes = notes;
    return { spec: errors.length ? null : spec, errors, warnings, notes, plan };
  };

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
  if (ws) {
    // The workspace inside its own source, or a source inside the workspace: a symlink loop, and
    // rules and settings that would apply to themselves. Compared by real path, through links;
    // the native one also brings the case on disk, so T1 and t1 on APFS compare as one directory.
    const real = fs.realpathSync.native(full);
    const home = given || fs.realpathSync.native(ws);
    let why = '';
    if (real === home) why = 'add.selfSource';
    else if (real.startsWith(home + path.sep)) why = 'add.insideSource';
    else if (home.startsWith(real + path.sep)) why = 'add.containsSource';
    if (why) {
      errors.push(t(why, { path: full, ws }));
      return done(null, plan);
    }
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
  const epic = kind === 'epic';
  // The epic's pointer rule is .claude/rules/epic-knowledge.md: a source's rule by that name would
  // stand in its place.
  if (epic && `${name.toLowerCase()}.md` === 'epic-knowledge.md') errors.push(t('add.epicReserved', { name }));
  // `wsg new --sources none` means no source: one by that name could never be picked.
  if (epic && name.toLowerCase() === 'none') errors.push(t('add.epicNoneReserved'));
  if (!epic && opts.branchTemplate !== undefined) errors.push(t('add.templateOnlyEpic'));
  const inGit = g.isRepo(full);
  let mode;
  if (!inGit) {
    // Not under git: material to read, never the code the task changes. Attached only when asked
    // for, so a mistyped repository path isn't quietly linked as a plain folder.
    if (opts.mode !== 'reference') errors.push(t('add.notGit', { path: full }));
    mode = 'reference';
  } else if (opts.mode === 'reference') {
    errors.push(t(epic ? 'add.referenceIsGitEpic' : 'add.referenceIsGit', { path: full }));
    mode = 'link';
  } else if (!g.isRepoRoot(full)) {
    // A worktree is always of the whole repository, not of a subdirectory.
    const top = g.git(full, ['rev-parse', '--show-toplevel']);
    if (opts.mode === 'worktree') errors.push(t('add.subdirWorktree', { top }));
    else if (!opts.mode) warnings.push(t('add.subdirLink', { top }));
    mode = 'link';
  } else if (epic) {
    // An epic has no branch of its own: its repositories are links, its tasks get the worktrees.
    if (opts.mode === 'worktree') errors.push(t('add.epicWorktree'));
    mode = 'link';
  } else if (state && state.noCode) {
    // A task without code (`wsg new --no-code`): nothing is changed in a repository, so there is no
    // branch and no worktree; a repository is read through a link.
    if (opts.mode === 'worktree') errors.push(t('add.noCodeWorktree'));
    else if (!opts.mode) warnings.push(t('add.noCodeLink'));
    mode = 'link';
  } else {
    mode = opts.mode || 'worktree';
  }
  plan.mode = mode;

  if (epic) {
    // The epic's own branch flags: there is none. The task defaults need a template to apply to.
    for (const [key, flag] of [['branch', '--branch'], ['resetToBase', '--reset-to-base']]) {
      if (opts[key] !== undefined) errors.push(t('add.branchInEpic', { flag }));
    }
    const template = opts.branchTemplate === undefined ? undefined : opts.branchTemplate.trim();
    if (template !== undefined && mode !== 'link') errors.push(t('add.templateNotRepo', { mode }));
    else if (template === undefined) {
      // A reference is never branched: for it these flags are worktree-only, as anywhere else.
      const key = mode === 'link' ? 'add.taskDefaultsNeedTemplate' : 'add.worktreeOnly';
      for (const [k, flag] of TASK_DEFAULTS) if (opts[k] !== undefined) errors.push(t(key, { flag: typed(opts, k, flag), mode }));
    } else if (!g.isRepoRoot(full)) errors.push(t('add.templateSubdir', { top: g.git(full, ['rev-parse', '--show-toplevel']) }));
  } else if (mode !== 'worktree') {
    for (const [key, flag] of WORKTREE_ONLY) {
      if (opts[key] === undefined) continue;
      // The flag as typed: --no-clone-node-modules sets the same option to false.
      const given = key === 'cloneNm' && opts.cloneNm === false ? '--no-clone-node-modules' : flag;
      errors.push(t('add.worktreeOnly', { flag: given, mode }));
    }
  }
  if (mode === 'reference' && opts.target !== undefined) errors.push(t('add.worktreeOnly', { flag: '--target', mode }));

  // These land in markdown: a newline would break the line it is on, `<!--` could pass for a
  // marker, and the command is shown in a code span, which a backtick would end. Refused, not
  // escaped — the agent is told and passes a clean value.
  for (const [key, flag] of [['verify', '--verify'], ['note', '--note']]) {
    const v = opts[key];
    if (v === undefined) continue;
    if (/[\r\n]/.test(v)) errors.push(t('add.multiline', { flag }));
    if (v.includes('<!--')) errors.push(t('add.markerValue', { flag }));
    if (key === 'verify' && v.includes('`')) errors.push(t('add.backtick', { flag }));
  }
  if (opts.target !== undefined && opts.target.trim() && !g.git(full, ['check-ref-format', '--branch', opts.target.trim()])) {
    errors.push(t('add.badTarget', { target: opts.target.trim() }));
  }

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
    if (!sources.some((s) => !s.reference) && !(state && state.noCode)) warnings.push(t('add.referenceFirst'));
    return done(spec, plan);
  }

  spec.target = (opts.target || '').trim() || defaultTarget(full);
  plan.target = spec.target;
  if (mode === 'link') {
    // Only shown, never checked out: a typo is a warning, but worth one.
    const known = (ref) => g.gitRun(full, ['show-ref', '--verify', '--quiet', ref]).ok;
    if (opts.target !== undefined && !known(`refs/heads/${spec.target}`) && !known(`refs/remotes/origin/${spec.target}`)) {
      warnings.push(t('add.targetUnknown', { target: spec.target, name }));
    }
    if (epic && opts.branchTemplate !== undefined && g.isRepoRoot(full)) spec.task = taskDefaults(full, name, opts, plan, errors, warnings);
    // Only next to a plan that goes through: beside a refusal it would point the wrong way.
    else if (epic && g.isRepoRoot(full) && !errors.length) notes.push(t('add.epicLinkedIntoTasks', { name }));
    return done(spec, plan);
  }

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
  const b = spec.branch;
  plan.branchExists = !!b && heads.includes(b);
  const remote = b && g.gitRun(full, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${b}`]).ok ? `origin/${b}` : '';
  if (remote) plan.remoteBranch = remote;
  const base = opts.base === undefined ? undefined : opts.base.trim();

  // How the branch starts. An existing branch is usually an open MR: its commits are the work, so it
  // is attached as it is; resetting it to the base takes --reset-to-base (and leaves a backup).
  // A branch only on origin is continued from there — a new one from the base would drop its commits.
  if (plan.branchExists && !opts.resetToBase) {
    spec.start = 'attach';
    if (base !== undefined) errors.push(t('add.baseWithExisting', { branch: b }));
    if (remote) {
      const [ahead, behind] = g.git(full, ['rev-list', '--left-right', '--count', `${b}...${remote}`]).split(/\s+/).map(Number);
      if (ahead || behind) warnings.push(t('add.diverged', { branch: b, ahead, behind }));
    }
    notes.push(t('add.attachAsIs', { branch: b }));
  } else if (plan.branchExists) {
    spec.start = 'reset';
    warnings.push(t('add.branchReset', { branch: b }));
  } else if (remote && (base === undefined || base === remote)) {
    spec.start = 'continue';
    if (opts.resetToBase) errors.push(t('add.resetNew', { branch: b }));
    spec.base = remote;
    notes.push(t('add.continuing', { remote }));
  } else if (remote) {
    spec.start = 'new';
    if (!opts.resetToBase) errors.push(t('add.remoteBase', { remote, base }));
    else warnings.push(t('add.remoteReset', { remote, branch: b, base }));
  } else {
    spec.start = 'new';
    if (opts.resetToBase && b) errors.push(t('add.resetNew', { branch: b }));
  }
  plan.start = spec.start;

  if (spec.start === 'attach' || spec.start === 'continue') {
    // The branch itself is where the worktree starts: there is no base to pick.
    if (spec.start === 'attach') spec.base = b;
  } else if (base !== undefined) {
    spec.base = base;
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
  spec.carry = pickCarry(candidates, opts.carry, errors);
  plan.carry = spec.carry;

  const inMain = fs.existsSync(path.join(full, 'node_modules'));
  spec.cloneNm = opts.cloneNm === undefined ? cloneDefault(full) : !!opts.cloneNm;
  if (opts.cloneNm && !inMain) warnings.push(t('add.nmMissing'));
  plan.nodeModules = { inMainCheckout: inMain, clone: spec.cloneNm };
  return done(spec, plan);
}

// What a task of the epic gets from this repository: { branch, base, carry, cloneNm }, defaulting
// as a task's own worktree does. The carry list is resolved now, against what the main checkout
// holds today — never stored as "all", so a file that appears later isn't copied unseen. base ''
// means what a task's worktree defaults to when it is made: origin/<target>, else <target>.
function taskDefaults(repo, name, opts, plan, errors, warnings) {
  const branch = opts.branchTemplate.trim();
  const bad = templateError(repo, branch);
  if (bad) errors.push(bad);
  const base = opts.base === undefined ? '' : opts.base.trim();
  if (base && !resolvesToCommit(repo, base)) errors.push(t('validate.refNotFound', { ref: base, name }));
  const candidates = g.ignoredCandidates(repo);
  const carry = pickCarry(candidates, opts.carry, errors);
  const inMain = fs.existsSync(path.join(repo, 'node_modules'));
  const cloneNm = opts.cloneNm === undefined ? cloneDefault(repo) : !!opts.cloneNm;
  if (opts.cloneNm && !inMain) warnings.push(t('add.nmMissing'));
  plan.task = { branch, sampleBranch: bad ? '' : expandTemplate(branch, TEMPLATE_VARS), base, carry, carryCandidates: candidates, cloneNm };
  return { branch, base, carry, cloneNm };
}

// The epic's source by that name, as the file systems compare names: case-insensitively.
const epicSource = (epicState, name) => epicState.sources.find((s) => s && typeof s.name === 'string'
  && s.name.toLowerCase() === String(name).toLowerCase());
const sourceList = (epicState) => epicState.sources.map((s) => s.name).join(', ') || '—';

// What a task of the epic gets from the epic's source `name`: its path, target, verify and note,
// and — for a source with task defaults — a worktree on the template's branch, with the epic's base,
// carry list and clone flag; without them, the link as is. opts: the flags given, as resolve takes
// them; each one given wins over the epic's. vars: { slug, ticket } of the task, and for what a
// refusal says: given, the --ticket text of a task being made; made, the task exists. ctx: as resolve
// takes it. Then resolve runs on the result as on any add: the same checks, the same plan. Returns
// what resolve returns, the spec and the plan marked from: 'epic'.
function fromEpic(name, epicState, vars, opts = {}, ctx = {}) {
  const s = epicSource(epicState, name);
  const refused = (msg, plan) => ({ spec: null, errors: [msg], warnings: [], notes: [], plan: { ...plan, from: 'epic', notes: [] } });
  if (!s) return refused(t('add.epicSourceUnknown', { name, epic: epicState.slug, list: sourceList(epicState) }), { name });
  const warnings = [];
  const merged = { ...opts };
  // A task without code takes a source the epic branches for its tasks as a link: it has no branch.
  const noCode = !!(ctx.state && ctx.state.noCode);
  merged.mode = opts.mode || (s.task && !noCode ? 'worktree' : s.reference ? 'reference' : 'link');
  // A reference has no target to reuse: given one, resolve would refuse it as a flag.
  if (merged.target === undefined && !s.reference && s.target && s.target !== '—') merged.target = s.target;
  if (merged.verify === undefined && s.verify) merged.verify = s.verify;
  if (merged.note === undefined && s.note) merged.note = s.note;
  // Given --link, the task defaults are not for it; --worktree on a source linked as is needs --branch.
  if (merged.mode === 'worktree' && s.task) {
    if (merged.branch === undefined) {
      if (s.task.branch.includes('{ticket}') && !vars.ticket) {
        // What to say depends on where the task stands: made already, or a ticket given without a key.
        const key = vars.made ? 'add.templateTaskNoKey' : vars.given ? 'add.templateTicketNoKey' : 'add.templateNeedsTicket';
        return refused(t(key, { name: s.name, template: s.task.branch, ticket: vars.given }), { path: s.path, name: s.name, mode: 'worktree' });
      }
      merged.branch = expandTemplate(s.task.branch, vars);
    }
    // The epic's base is where a new branch starts. A branch that exists, here or on origin, starts
    // where it is, as resolve decides; --base given is resolve's to judge.
    const b = String(merged.branch).trim();
    const exists = !!b && (g.localBranches(s.path).includes(b)
      || g.gitRun(s.path, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${b}`]).ok);
    if (merged.base === undefined && s.task.base && !exists) merged.base = s.task.base;
    // A source gone from disk is resolve's to report: no carry warning beside it.
    if (merged.carry === undefined && fs.existsSync(s.path)) {
      // Resolved when the source was added: a file gone from the main checkout since is not copied.
      const now = g.ignoredCandidates(s.path);
      const gone = s.task.carry.filter((c) => !now.includes(c));
      if (gone.length) warnings.push(t('add.epicCarryGone', { list: gone.join(', ') }));
      const keep = s.task.carry.filter((c) => now.includes(c));
      merged.carry = keep.length ? keep.join(',') : 'none';
    }
    if (merged.cloneNm === undefined) merged.cloneNm = s.task.cloneNm;
  }
  const res = resolve(s.path, merged, ctx);
  res.warnings.unshift(...warnings);
  if (res.spec) res.spec.from = 'epic';
  if (res.plan) res.plan.from = 'epic';
  return res;
}

module.exports = {
  TEMPLATE_VARS, expandTemplate, templateError, epicSource, fromEpic,
  parseTicket, ticketFields, resolvePath, sourceName, sourceProblem, branchError, defaultTarget,
  isRepoPointer, resolve,
};
