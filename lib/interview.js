'use strict';

// Interview in Node. Its job is to collect answers and hand them to the core as a ready file.
// A prompt library rather than `read`: validation before an answer is accepted, live directory
// search, arrow-key selection. The "input shifted by one line" class of bugs is impossible here:
// each question knows whether the previous one was asked.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { styleText } = require('node:util');
const { input, select } = require('@inquirer/prompts');
// Selection of untracked files is shared across the project: if the lists diverged, the user
// would confirm one thing and another would get copied.
const { ignoredCandidates } = require('./git');
const { sourceProblem, missingChain } = require('./generate');

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

const { expandPath, tildePath, pathPrompt } = require('./pathPrompt');

// validate sees the answer with surrounding whitespace, and inquirer returns it as is.
// A branch "feat " would pass validation and fail on git worktree add at the very end.
const ask = async (opts, context) => (await input(opts, context)).trim();

// The source name becomes a directory in the workspace and an @name/AGENTS.md import in CLAUDE.md,
// and an import containing a space doesn't resolve.
const sourceName = (full) => path.basename(full).replace(/\s+/g, '-');

// A relative path would produce a self-referencing symlink: ws/src -> src.
const resolveSource = (p) => path.resolve(expandPath(p));

const { git, isRepo, isRepoRoot, newFolderInRepo } = require('./git');
const { t } = require('./i18n');

// The key hint under select/search lists ("↑↓ navigate • ⏎ select") in the UI language.
// Same look as inquirer's own: bold key, dim action.
const theme = () => ({
  style: {
    keysHelpTip: (keys) => keys
      .map(([k, action]) => {
        // An action a newer inquirer adds and the catalog doesn't know yet stays as inquirer wrote it.
        const text = t(`prompt.${action}`);
        return `${styleText('bold', k)} ${styleText('dim', text === `prompt.${action}` ? action : text)}`;
      })
      .join(styleText('dim', ' • ')),
  },
});

// A path typed like in a shell, Tab completes (lib/pathPrompt.js). Empty Enter means "done".
function askPath(message) {
  const th = theme();
  return pathPrompt({
    message,
    hint: t('prompt.pathHint'),
    doneLabel: t('prompt.done'),
    gitLabel: t('prompt.git'),
    isRepoRoot,
    keys: th.style.keysHelpTip([['tab', 'complete'], ['⏎', 'accept']]),
  });
}

// Edit distance, for telling a typo (Helth) from a new name. Short names only — folder names.
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

// Existing folders next to a new name that it was probably meant to be: cut short (Doc for
// Documents), a typo (Helth for Health), or another case (documents on Linux).
function lookalikes(dir, name) {
  const n = name.toLowerCase();
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }
  return entries
    .map((e) => e.name)
    .filter((e) => {
      const l = e.toLowerCase();
      return l.startsWith(n) || (n.length >= 4 && distance(l, n) <= (n.length >= 8 ? 2 : 1));
    })
    .map((e) => path.join(dir, e));
}

// A directory that doesn't exist yet is offered to be created: a new project's notes usually
// start with an empty folder. Nothing is created here — generation does it, so --dry-run, Ctrl+C
// and a rollback leave no stray folders. Returns whether to use the path.
// Enter means yes only when nothing suggests a slip: a missing parent is usually a typo
// (~/Documets/Health), and a name close to an existing folder's (~/Doc, ~/Documents/Helth) was
// usually meant to be that folder — Enter takes exactly what was typed. A path that can't be
// created points to the reason: a link to an unmounted drive, a file on the way, or a place only
// root may write to (/Users/health — the home directory was usually meant).
async function ensureDir(full, context, chain = missingChain(full)) {
  const { missing, existing } = chain;
  if (!missing.length) return true;
  let st = null;
  try { st = fs.statSync(existing); } catch { /* a dangling link: below */ }
  if (!st) {
    let target = '';
    try { target = fs.readlinkSync(existing); } catch { /* not a link */ }
    console.log(t('interview.createDangling', { path: tildePath(full), parent: tildePath(existing), target }));
    return false;
  }
  if (!st.isDirectory()) {
    console.log(t('interview.createNotDir', { path: tildePath(full), parent: tildePath(existing) }));
    return false;
  }
  try {
    fs.accessSync(existing, fs.constants.W_OK);
  } catch {
    console.log(t('interview.createFailed', { path: full, parent: existing }));
    if (!full.startsWith(os.homedir() + path.sep)) {
      console.log(t('interview.maybeHome', { path: tildePath(path.join(os.homedir(), path.basename(full))) }));
    }
    return false;
  }
  let likely = missing.length === 1;
  if (missing.length > 1) console.log(t('interview.createChain', { list: missing.map(tildePath).join('\n    ') }));
  else {
    const near = lookalikes(existing, path.basename(full));
    if (near.length) {
      likely = false;
      console.log(t('interview.maybeHome', { path: near.slice(0, 3).map(tildePath).join(', ') }));
    }
  }
  return askYesNo({ message: t('interview.createDir', { path: tildePath(full) }), default: likely }, context);
}

async function askMulti(message, hint) {
  const lines = [];
  console.log(`\n${message}\n  ${hint ? `${hint} ` : ''}${t('interview.finish')}`);
  for (;;) {
    const v = await input({
      message: `  ${lines.length + 1}.`,
      theme: { prefix: '' },
    });
    if (!v.trim()) break;
    lines.push(v.trim());
  }
  return lines;
}

// Yes/no in any UI language. inquirer's confirm knows one word per answer and silently turns
// anything else into the default — "нет" to "Clone node_modules?" became yes. Here both
// languages' words are accepted whatever the UI language is, an empty answer is the default,
// and an unknown one is asked again rather than guessed.
const YES = ['y', 'yes', 'д', 'да'];
const NO = ['n', 'no', 'н', 'нет'];
function parseYesNo(value, def) {
  const v = String(value).trim().toLowerCase();
  if (v === '') return def;
  if (YES.includes(v)) return true;
  if (NO.includes(v)) return false;
  return null;
}

// context: inquirer's { input, output } streams — the tests type real answers through them.
async function askYesNo({ message, default: def }, context) {
  const answer = await ask({
    message: `${message} ${def ? t('prompt.yesNoDefaultYes') : t('prompt.yesNoDefaultNo')}`,
    validate: (v) => (parseYesNo(v, def) === null ? t('validate.yesNo') : true),
  }, context);
  return parseYesNo(answer, def);
}

// Why a task branch name can't be used, or '' if it can. Everything here would otherwise fail
// only at worktree add, at the very end, after all answers are given.
function branchError(repo, b, heads, busy) {
  if (!b) return t('validate.required');
  if (!git(repo, ['check-ref-format', '--branch', b])) return t('validate.branchInvalid', { b });
  if (busy.includes(b)) return t('validate.branchBusy', { b });
  // Git branches are paths: a/b and a/b/c can't exist at the same time.
  const conflict = heads.find((h) => b.startsWith(h + '/') || h.startsWith(b + '/'));
  if (conflict) return t('validate.branchConflict', { conflict });
  return '';
}

// First run, no WSG_LANG anywhere: the interview is the first thing a person reads, so its
// language is asked rather than guessed from the locale — a Russian speaker often runs an English
// locale. The locale only picks the highlighted answer. The choice is saved unless `save` is false
// (--dry-run creates nothing), and the UI switches to it right away.
async function askLanguage(cfg, { save = true } = {}, context) {
  const { init, current } = require('./i18n');
  const lang = await select({
    // Both languages: this is asked before the person has picked one.
    message: 'Language / Язык',
    theme: theme(),
    default: current(),
    choices: [
      { name: 'English', value: 'en' },
      { name: 'Русский', value: 'ru' },
    ],
  }, context);
  init(lang);
  cfg.WSG_LANG = lang;
  if (save) {
    require('./config').saveSetting(cfg.configFile, 'WSG_LANG', lang);
    console.log(styleText('dim', t('interview.langSaved', { file: cfg.configFile })));
  }
  return lang;
}

async function run(cfg) {
  const a = { repos: [] };

  a.kind = await select({
    message: t('interview.kind'),
    theme: theme(),
    choices: [
      { name: t('interview.kind.task'), value: 'task' },
      { name: t('interview.kind.process'), value: 'process' },
    ],
  });

  a.slug = await ask({
    message: t('interview.slug'),
    validate: (v) => {
      const s = v.trim();
      if (!s) return t('validate.required');
      if (!/^[a-z0-9][a-z0-9-]*$/.test(s)) return t('validate.kebab');
      if (fs.existsSync(path.join(cfg.WS_ROOT, s))) return t('validate.exists', { path: path.join(cfg.WS_ROOT, s) });
      return true;
    },
  });

  a.title = await ask({
    message: t('interview.title'),
    validate: (v) => (v.trim() ? true : t('validate.required')),
  });

  // A process has no ticket of its own: each run may have one, and it goes into the run's name.
  const ticketRaw = a.kind === 'process' ? '' : await ask({ message: t('interview.ticket') });

  a.ticket = '';
  a.ticketUrl = '';
  if (ticketRaw) {
    a.ticket = parseTicket(ticketRaw);
    if (/^https?:\/\//.test(ticketRaw)) {
      a.ticketUrl = ticketRaw.split(/\s+/)[0];
      console.log(t('interview.ticketParsed', { ticket: a.ticket || '—', url: a.ticketUrl }));
    } else if (cfg.WSG_TRACKER_URL && a.ticket) {
      a.ticketUrl = cfg.WSG_TRACKER_URL + a.ticket;
      console.log(t('interview.ticketFromPrefix', { url: a.ticketUrl }));
    } else {
      a.ticketUrl = await ask({ message: t('interview.ticketUrl') });
    }
  }

  // A few narrow questions instead of one wide one: the person knows what each answer is for, and
  // the agent gets them in separate sections. They go into AGENTS.md, read in every session —
  // hence the "1–3 lines" in the intro: a long answer is context paid for on every turn.
  // A process has no step-by-step question: steps are worked out with the owner on the first run.
  const k = a.kind === 'process' ? '.process' : '';
  console.log(`\n${t(`interview.about${k}`)}`);
  a.problem = await askMulti(t(`interview.problem${k}`), t(`interview.problem${k}.hint`));
  // Not skippable: this is what the agent decides the scope by.
  while (a.problem.length === 0) {
    console.log(t('interview.problemRequired'));
    a.problem = await askMulti(t(`interview.problem${k}`), '');
  }

  if (a.kind === 'process') {
    a.trigger = await askMulti(t('interview.trigger'), t('interview.trigger.hint'));
    a.skillName = await ask({
      message: t('interview.skillName'),
      validate: (v) => (/^[a-z0-9][a-z0-9-]*$/.test(v.trim()) ? true : t('validate.kebab')),
    });
    a.varies = await askMulti(t('interview.varies'), t('interview.varies.hint', { skill: a.skillName }));
    a.fixed = await askMulti(t('interview.fixed'), t('interview.fixed.hint'));
    a.dod = await askMulti(t('interview.dod.process'), t('interview.dod.process.hint'));
    a.steps = [];
    a.stateLabel = 'repeatable process; each run gets its own input';
  } else {
    a.dod = await askMulti(t('interview.dod'), t('interview.dod.hint'));
    a.outOfScope = await askMulti(t('interview.outOfScope'), t('interview.outOfScope.hint'));
    // The values go into AGENTS.md, so they stay English; only the names are shown.
    a.stateLabel = await select({
      message: t('interview.state'),
      theme: theme(),
      choices: [
        { name: t('interview.state.new'), value: 'new feature' },
        { name: t('interview.state.update'), value: 'updating existing work, not a new feature' },
        { name: t('interview.state.legacy'), value: 'understanding legacy code before changing it' },
      ],
    });
  }

  console.log(`\n${t('interview.sources')}`);
  for (;;) {
    const p = await askPath(t('interview.sourcePath'));
    if (!p) {
      if (a.repos.length) break;
      // A workspace can live without sources — notes, a knowledge base — but an Enter pressed
      // by accident shouldn't decide that.
      // No by default: two Enters in a row must not settle it.
      if (await askYesNo({ message: t('interview.noSources'), default: false })) break;
      continue;
    }
    const full = resolveSource(p);
    if (a.repos.some((r) => r.path === full)) {
      console.log(t('interview.sourceDup', { name: a.repos.find((r) => r.path === full).name }));
      continue;
    }
    const name = sourceName(full);
    // A folder to be created is judged by the nearest one that exists: a new folder inside a
    // repository is part of that repository, and git can't be asked about a path that isn't there.
    const chain = missingChain(full);
    const create = chain.missing.length > 0;
    const probe = create ? chain.existing : full;
    // A file, or a name the workspace uses itself, would end up with a template written over it.
    const problem = sourceProblem({ path: full, name, create });
    if (problem) {
      console.log(`  ${problem}`);
      continue;
    }
    // Case-insensitive, like the file systems on macOS and Windows.
    const clash = a.repos.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (clash) {
      console.log(t('interview.sourceNameTaken', { name, path: clash.path }));
      continue;
    }
    // Asked after the checks: confirming a folder only to have its name rejected would be a waste.
    if (create && !(await ensureDir(full, undefined, chain))) continue;
    if (name !== path.basename(full)) console.log(t('interview.sourceRenamed', { name }));
    const repo = { path: full, name, create, mode: 'link', branch: '', base: '', target: '—', verify: '', note: '', carry: [], cloneNm: false };

    // For a new folder, what generation will see once it exists: see newFolderInRepo.
    const inGit = create ? newFolderInRepo(probe) : isRepo(probe);
    if (inGit && a.kind === 'process') {
      console.log(t('interview.processLink'));
    } else if (inGit && (create || !isRepoRoot(full))) {
      // A worktree is always of the whole repository, not of a subdirectory.
      const top = git(probe, ['rev-parse', '--show-toplevel']);
      console.log(t('interview.subdirLink', { top }));
    } else if (inGit) {
      repo.mode = await select({
        message: t('interview.mode', { name }),
        theme: theme(),
        choices: [
          { name: t('interview.mode.worktree'), value: 'worktree' },
          { name: t('interview.mode.link'), value: 'link' },
        ],
      });
    } else {
      console.log(t('interview.notGit'));
      repo.note = await ask({ message: t('interview.note') });
    }

    if (inGit) {
      const head = git(probe, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
      const local = git(probe, ['symbolic-ref', '--short', 'HEAD']);
      repo.target = await ask({ message: t('interview.target'), default: head || local || 'main' });
    }

    if (repo.mode === 'worktree') {
      const heads = git(full, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
        .split('\n')
        .filter(Boolean);
      const busy = git(full, ['worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((l) => l.startsWith('branch '))
        .map((l) => l.replace('branch refs/heads/', ''));
      for (;;) {
        repo.branch = await ask({
          message: t('interview.branch'),
          validate: (v) => branchError(full, v.trim(), heads, busy) || true,
        });
        if (!heads.includes(repo.branch)) break;
        // Generation resets an existing branch to the base (`worktree add -B`) and saves the old
        // head in backup/…. Commits survive, but the branch is no longer the same — worth knowing up front.
        const reuse = await askYesNo({
          message: t('interview.branchReuse', { branch: repo.branch }),
          default: false,
        });
        if (reuse) break;
      }
      repo.base = await ask({
        message: t('interview.base'),
        default: `origin/${repo.target}`,
        validate: (v) =>
          git(full, ['rev-parse', '--verify', '-q', `${v.trim()}^{commit}`])
            ? true
            : t('validate.refNotFound', { ref: v.trim(), name }),
      });
    }

    // Outside git it may be documents or code (a tarball, an SVN checkout): the hint says which answer fits.
    console.log(inGit ? t('interview.verify.hint') : t('interview.verify.hint.docs'));
    repo.verify = await ask({ message: t('interview.verify') });

    if (repo.mode === 'worktree') {
      const cand = ignoredCandidates(full);
      if (cand.length) {
        console.log(t('interview.carryList'));
        cand.forEach((c, i) => console.log(`    ${i + 1}) ${c}`));
        // all/none stay English words: they are typed, like y/n.
        const pick = await ask({ message: t('interview.carryPick'), default: 'all' });
        const p2 = pick.toLowerCase();
        if (p2 === 'all' || p2 === '' ) repo.carry = cand;
        else if (p2 !== 'none' && p2 !== 'n')
          repo.carry = p2.split(/\s+/).map((n) => cand[parseInt(n, 10) - 1]).filter(Boolean);
      }
      if (fs.existsSync(path.join(full, 'node_modules'))) {
        console.log(t('interview.nmHint'));
        repo.cloneNm = await askYesNo({ message: t('interview.nmClone'), default: true });
      }
    }

    a.repos.push(repo);
  }

  a.links = await askMulti(t('interview.links'), t('interview.links.hint'));
  // A process already has rules and boundaries; invariants are about a task's code under review.
  a.invariants = a.kind === 'process' ? [] : await askMulti(t('interview.invariants'), t('interview.invariants.hint'));

  a.personalRules = false;
  if (cfg.WSG_GLOBAL_MEMORY && fs.existsSync(cfg.WSG_GLOBAL_MEMORY)) {
    a.personalRules = await askYesNo({
      message: t('interview.personalRules', { file: cfg.WSG_GLOBAL_MEMORY }),
      default: true,
    });
  }

  return a;
}

module.exports = { run, askLanguage, ensureDir, ask, theme, sourceName, resolveSource, parseTicket, branchError, parseYesNo, askYesNo };
