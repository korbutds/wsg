#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const i18n = require(path.join(ROOT, 'lib', 'i18n'));
const { t } = i18n;


function die(msg, code = 1) {
  process.stderr.write(`wsg: ${msg}\n`);
  process.exit(code);
}

const argv = process.argv.slice(2);

// The config goes first: it may set the UI language. A broken config must not break --help or
// the shell-init line in .zshrc, so its error is only reported by the commands that need it.
const config = require(path.join(ROOT, 'lib', 'config.js'));
let cfg = null;
let cfgError = null;
try {
  cfg = config.load();
  i18n.init(cfg.lang);
} catch (e) {
  cfgError = e;
  i18n.init(i18n.resolveLang(process.env, process.env.WSG_LANG));
}

if (argv[0] === '--help' || argv[0] === '-h') {
  process.stdout.write(t('cli.usage'));
  process.exit(0);
}
if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}
if (argv[0] === '--where') {
  process.stdout.write(`${ROOT}\n`);
  process.exit(0);
}

// The navigation function can't be a program: a child process can't change the
// parent's directory. Print its code for eval — the same way zoxide and starship do.
if (argv[0] === 'shell-init') {
  const shell = argv[1] || path.basename(process.env.SHELL || 'zsh');
  if (shell !== 'zsh') {
    die(t('cli.shellUnsupported', { shell }));
  }
  process.stdout.write(i18n.renderShell(fs.readFileSync(path.join(ROOT, 'shell', 'wsg.zsh'), 'utf8')));
  process.exit(0);
}

if (cfgError) die(t('cli.cannotReadSettings', { msg: cfgError.message }));

function guardPlatform() {
  if (os.platform() === 'win32') {
    die(t('cli.windows'));
  }
}

(async () => {
  try {
    if (argv[0] === '--check') {
      if (!argv[1]) die(t('cli.specifyPath'));
      process.exit(require(path.join(ROOT, 'lib', 'check.js')).run(config.resolveWs(argv[1], cfg), cfg));
    }

    if (argv[0] === '--promote') {
      guardPlatform();
      if (!argv[1]) die(t('cli.specifySlug'));
      process.exit(await require(path.join(ROOT, 'lib', 'promote.js')).run(argv[1], cfg));
    }

    if (argv[0] && argv[0].startsWith('-') && argv[0] !== '--dry-run') {
      die(t('cli.unknownArg', { arg: argv[0] }));
    }

    guardPlatform();
    const interview = require(path.join(ROOT, 'lib', 'interview.js'));
    const generate = require(path.join(ROOT, 'lib', 'generate.js'));
    const check = require(path.join(ROOT, 'lib', 'check.js'));
    const ui = require(path.join(ROOT, 'lib', 'ui.js'));
    const T = require(path.join(ROOT, 'lib', 'templates.js'));

    const a = await interview.run(cfg);
    if (argv.includes('--dry-run')) {
      ui.head(t('cli.dryRun', { ws: path.join(cfg.WS_ROOT, a.slug) }));
      process.exit(0);
    }

    const ws = await generate.run(a, cfg);
    const code = check.run(ws, cfg);
    ui.head(code === 0 ? t('cli.done') : t('cli.doneWithErrors'));
    ui.info(`  cd ${T.sh(ws)} && claude`);
    const pending = [];
    for (const f of ['README.md', 'AGENTS.md', 'notes.md']) {
      if (fs.readFileSync(path.join(ws, f), 'utf8').includes('FILL IN')) pending.push(`./${f}`);
    }
    const rules = path.join(ws, '.claude', 'rules');
    for (const f of fs.readdirSync(rules)) {
      if (fs.readFileSync(path.join(rules, f), 'utf8').includes('FILL IN')) pending.push(`./.claude/rules/${f}`);
    }
    if (pending.length) {
      ui.info('');
      ui.dim(t('cli.fillIn'));
      for (const p of pending) ui.info(`  ${p}`);
    }
    process.exit(code === 0 ? 0 : 1);
  } catch (e) {
    if (e && (e.name === 'ExitPromptError' || e.name === 'AbortPromptError' || e.name === 'Interrupted')) {
      process.stderr.write(`\n${t('cli.cancelled')}\n`);
      process.exit(130);
    }
    die(String((e && e.message) || e));
  }
})();
