'use strict';

// Interview in Node. Its job is to collect answers and hand them to the core as a ready file.
// A prompt library rather than `read`: validation before an answer is accepted, live directory
// search, arrow-key selection. The "input shifted by one line" class of bugs is impossible here:
// each question knows whether the previous one was asked.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { styleText } = require('node:util');
const { input, select, search } = require('@inquirer/prompts');
// Selection of untracked files is shared across the project: if the lists diverged, the user
// would confirm one thing and another would get copied.
const { ignoredCandidates } = require('./git');
const { sourceProblem } = require('./generate');

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

function expandPath(p) {
  return p.replace(/^~(?=\/|$)/, os.homedir());
}

// validate sees the answer with surrounding whitespace, and inquirer returns it as is.
// A branch "feat " would pass validation and fail on git worktree add at the very end.
const ask = async (opts, context) => (await input(opts, context)).trim();

// The source name becomes a directory in the workspace and an @name/AGENTS.md import in CLAUDE.md,
// and an import containing a space doesn't resolve.
const sourceName = (full) => path.basename(full).replace(/\s+/g, '-');

// A relative path would produce a self-referencing symlink: ws/src -> src.
const resolveSource = (p) => path.resolve(expandPath(p));

const { git, isRepo, isRepoRoot } = require('./git');
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

// Live directory search: replaces readline Tab completion and works better —
// options are visible immediately, without a second keypress.
async function askPath(message) {
  return search({
    message,
    theme: theme(),
    source: async (term) => {
      const raw = expandPath((term || '').trim());
      let dir;
      let frag;
      if (!raw) {
        dir = os.homedir();
        frag = '';
      } else if (raw.endsWith('/')) {
        dir = raw;
        frag = '';
      } else {
        dir = path.dirname(raw);
        frag = path.basename(raw).toLowerCase();
      }
      let entries = [];
      try {
        entries = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => path.join(dir, e.name))
          .filter((p) => path.basename(p).toLowerCase().startsWith(frag))
          .slice(0, 40);
      } catch {
        entries = [];
      }
      const items = entries.map((p) => ({
        name: `${p}${isRepoRoot(p) ? `  · ${t('prompt.git')}` : ''}`,
        value: p,
      }));
      // Always allow accepting the input as typed: the directory may not appear
      // in the results yet, while the path is typed correctly.
      if (raw && fs.existsSync(raw)) items.unshift({ name: `${raw}  · ${t('prompt.selectItem')}`, value: raw });
      // Without this item, a typo leaves only "done" in the list, and Enter
      // silently ends source input.
      else if (raw && !entries.length) items.unshift({ name: `${raw}  · ${t('prompt.noSuchDir')}`, value: raw });
      const done = { name: t('prompt.done'), value: '' };
      if (raw === '') items.unshift(done);
      else items.push(done);
      return items;
    },
  });
}

async function askMulti(message, hint) {
  const lines = [];
  console.log(`\n${message}${hint ? `\n  ${hint}` : ''}`);
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

  const ticketRaw = await ask({
    message: a.kind === 'process' ? t('interview.ticket.process') : t('interview.ticket'),
  });

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

  a.problem = await askMulti(
    a.kind === 'process' ? t('interview.problem.process') : t('interview.problem'),
    t('interview.problem.hint')
  );
  if (a.problem.length === 0) throw new Error(t('interview.problemEmpty'));

  a.dod = await askMulti(
    a.kind === 'process' ? t('interview.dod.process') : t('interview.dod'),
    t('interview.emptyToFinish')
  );

  if (a.kind === 'process') {
    a.skillName = await ask({
      message: t('interview.skillName'),
      validate: (v) => (/^[a-z0-9][a-z0-9-]*$/.test(v.trim()) ? true : t('validate.kebab')),
    });
    a.varies = await askMulti(t('interview.varies'), t('interview.emptyToFinish'));
    a.fixed = await askMulti(t('interview.fixed'), t('interview.emptyToFinish'));
    a.steps = await askMulti(t('interview.steps'), t('interview.steps.hint'));
    a.stateLabel = 'repeatable process; each run\'s ticket is an argument';
  } else {
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
      // "done" is the highlighted item on an empty input: one Enter here used to end the
      // interview with an error and lose every answer given so far.
      console.log(t('interview.sourceFirst'));
      continue;
    }
    const full = resolveSource(p);
    if (a.repos.some((r) => r.path === full)) {
      console.log(t('interview.sourceDup', { name: a.repos.find((r) => r.path === full).name }));
      continue;
    }
    const name = sourceName(full);
    // A file, or a name the workspace uses itself, would end up with a template written over it.
    const problem = sourceProblem({ path: full, name });
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
    if (name !== path.basename(full)) console.log(t('interview.sourceRenamed', { name }));
    const repo = { path: full, name, mode: 'link', branch: '', base: '', target: '—', verify: '', note: '', carry: [], cloneNm: false };

    const inGit = isRepo(full);
    if (inGit && a.kind === 'process') {
      console.log(t('interview.processLink'));
    } else if (inGit && !isRepoRoot(full)) {
      // A worktree is always of the whole repository, not of a subdirectory.
      const top = git(full, ['rev-parse', '--show-toplevel']);
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
      const head = git(full, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
      const local = git(full, ['symbolic-ref', '--short', 'HEAD']);
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
  a.invariants = await askMulti(t('interview.invariants'), t('interview.invariants.hint'));

  a.personalRules = false;
  if (cfg.WSG_GLOBAL_MEMORY && fs.existsSync(cfg.WSG_GLOBAL_MEMORY)) {
    a.personalRules = await askYesNo({
      message: t('interview.personalRules', { file: cfg.WSG_GLOBAL_MEMORY }),
      default: true,
    });
  }

  return a;
}

module.exports = { run, ask, sourceName, resolveSource, parseTicket, branchError, parseYesNo, askYesNo };
