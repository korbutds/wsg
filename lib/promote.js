'use strict';

// A task that turned out to be repeatable becomes a process. Sources, rules, and
// memory stay; a skill stub and a journal with the first run appear.
// There is no reverse conversion — no scenario calls for it.

const fs = require('node:fs');
const path = require('node:path');
const ui = require('./ui');
const { t } = require('./i18n');
const { ask } = require('./interview');
const { resolveWs } = require('./config');
const g = require('./git');
const T = require('./templates');
const check = require('./check');

// opts.skillName skips the prompt (tests, scripts).
async function run(target, cfg, opts = {}) {
  const ws = resolveWs(target, cfg);
  if (!fs.existsSync(ws)) throw new Error(t('promote.noWorkspace', { ws }));
  // Without this check, `wsg --promote .` from the wrong directory lays out the skill,
  // journal, and runs/ into WS_ROOT or straight into a repository checkout. CLAUDE.md
  // alone is not a sign: almost every repository has one. Only the generator writes
  // ws-kind; workspaces created before it still have CLAUDE.md without .git.
  const hasKind = fs.existsSync(path.join(ws, '.claude', 'ws-kind'));
  const legacy = fs.existsSync(path.join(ws, 'CLAUDE.md')) && !fs.existsSync(path.join(ws, '.git'));
  if (!hasKind && !legacy) throw new Error(t('promote.notWorkspace', { ws }));
  if (check.wsKind(ws) === 'process') throw new Error(t('promote.alreadyProcess'));

  ui.head(t('promote.head', { ws }));
  ui.dim(t('promote.intro'));

  const skillName = opts.skillName || await ask({
    message: t('interview.skillName'),
    validate: (v) => (/^[a-z0-9][a-z0-9-]*$/.test(v.trim()) ? true : t('validate.kebab')),
  });

  // Promote writes below; a symlink anywhere on those paths — the file itself or a directory
  // on the way (a workspace generated before sources were checked, .claude/skills linked to a
  // shared skills folder, a dangling link) — would send the write outside the workspace.
  // Checked for every path before the first write, so a refusal leaves nothing half-done.
  for (const rel of ['AGENTS.md', 'journal.md', 'runs', '.claude/ws-kind', `.claude/skills/${skillName}/SKILL.md`]) {
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const p = path.join(ws, ...parts.slice(0, i));
      let st = null;
      try { st = fs.lstatSync(p); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (st && st.isSymbolicLink()) {
        throw new Error(t('promote.symlink', { path: path.relative(ws, p), ws }));
      }
    }
  }

  const agentsMd = path.join(ws, 'AGENTS.md');
  const title = fs.existsSync(agentsMd)
    ? (fs.readFileSync(agentsMd, 'utf8').split('\n')[0] || '').replace(/^#\s*/, '') || path.basename(ws)
    : path.basename(ws);

  fs.mkdirSync(path.join(ws, '.claude', 'skills', skillName), { recursive: true });
  fs.mkdirSync(path.join(ws, 'runs'), { recursive: true });

  const skillFile = path.join(ws, '.claude', 'skills', skillName, 'SKILL.md');
  if (fs.existsSync(skillFile)) {
    ui.warn(t('promote.skillExists', { skill: skillName }));
  } else {
    // The task's sources are what's in the workspace now: the skill mentions pushes and MRs only
    // when there is a repository to push from.
    const repos = fs.readdirSync(ws).map((n) => ({ path: path.join(ws, n) })).filter((r) => g.isRepo(r.path));
    fs.writeFileSync(skillFile, T.skillMd({
      skillName,
      title,
      repos,
      varies: [],
      fixed: [],
      steps: [
        'FILL IN: write down the steps based on what was actually done the first time.',
        'Source — journal.md and notes.md of this workspace.',
      ],
    }, { isRepo: (r) => g.isRepo(r.path) }), { flag: 'wx' });
    ui.info(t('promote.skillCreated', { skill: skillName }));
  }

  const journal = path.join(ws, 'journal.md');
  if (fs.existsSync(journal)) {
    ui.warn(t('promote.journalExists'));
  } else {
    fs.writeFileSync(
      journal,
      T.journalMd({ title }) +
        `\n## Run 1 — as a task (${T.today()})\n\n` +
        'The workspace started as a task; the first run is described in `notes.md`.\n' +
        'FILL IN: move the takeaways here — what broke, what was decided, what not to do.\n',
      { flag: 'wx' }
    );
    ui.info(t('promote.journalCreated'));
  }

  fs.writeFileSync(path.join(ws, '.claude', 'ws-kind'), 'process\n');
  ui.info(t('promote.kindSwitched'));

  // Without this, AGENTS.md keeps describing a one-off task, and an agent opening the
  // workspace later will not learn about the skill, journal, and runs/ — the terminal output is long gone.
  if (fs.existsSync(agentsMd)) {
    const text = fs.readFileSync(agentsMd, 'utf8');
    // Russian headings come from workspaces generated with the old templates.
    if (!/^## (How it runs|Как запускается)/m.test(text)) {
      const block = [
        '## How it runs',
        '',
        ...T.howItRuns(skillName),
        '',
        'The workspace started as a task, so the sections below may describe one',
        'specific run — FILL IN: generalize them to the process.',
        '',
      ].join('\n');
      const m = /^## (Layout|Раскладка)/m.exec(text);
      const anchor = m ? m.index : -1;
      const updated = anchor >= 0
        ? text.slice(0, anchor) + block + text.slice(anchor)
        : text.trimEnd() + '\n\n' + block;
      fs.writeFileSync(agentsMd, updated);
      ui.info(t('promote.sectionAdded'));
    }
  }

  const worktrees = fs.readdirSync(ws).filter((n) => {
    const p = path.join(ws, n);
    try {
      return fs.statSync(p).isDirectory() && !fs.lstatSync(p).isSymbolicLink() && g.isRepoRoot(p);
    } catch {
      return false;
    }
  });
  if (worktrees.length) {
    ui.info('');
    ui.warn(t('promote.hasWorktrees', { list: worktrees.join(', ') }));
    ui.dim(t('promote.worktreesHint'));
  }

  ui.info('');
  const code = check.run(ws, cfg);
  ui.head(t('cli.done'));
  ui.info(t('promote.next', { skill: skillName }));
  return code;
}

module.exports = { run };
