#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const i18n = require(path.join(ROOT, 'lib', 'i18n'));
const { t } = i18n;

// Exit codes: 0 ok; 1 the check found errors, or a step failed and was rolled back;
// 2 invalid input — rejected before anything was touched.
const INVALID = 2;

function die(msg, code = 1) {
  process.stderr.write(`wsg: ${msg}\n`);
  process.exit(code);
}
const invalid = (msg) => die(msg, INVALID);

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

const cmd = argv[0];
const rest = argv.slice(1);

if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  process.stdout.write(t('cli.usage'));
  process.exit(0);
}
if (cmd === '--version' || cmd === '-v') {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}
if (cmd === '--where') {
  process.stdout.write(`${ROOT}\n`);
  process.exit(0);
}

// The navigation function can't be a program: a child process can't change the
// parent's directory. Print its code for eval — the same way zoxide and starship do.
if (cmd === 'shell-init') {
  const shell = rest[0] || path.basename(process.env.SHELL || 'zsh');
  if (shell !== 'zsh') {
    die(t('cli.shellUnsupported', { shell }));
  }
  process.stdout.write(i18n.renderShell(fs.readFileSync(path.join(ROOT, 'shell', 'wsg.zsh'), 'utf8')));
  process.exit(0);
}

// The guides ship in the package, so an upgrade reaches existing workspaces without regenerating
// them: /wsg-setup only says "run wsg guide setup".
if (cmd === 'guide') {
  const topic = rest[0] || 'setup';
  if (rest.length > 1) invalid(t('cli.extraArg', { arg: rest[1] }));
  const file = path.join(ROOT, 'docs', `${topic}-guide.md`);
  if (!/^[a-z]+$/.test(topic) || !fs.existsSync(file)) invalid(t('cli.guideTopic', { topic }));
  process.stdout.write(fs.readFileSync(file, 'utf8'));
  process.exit(0);
}

if (cfgError) die(t('cli.cannotReadSettings', { msg: cfgError.message }));

function guardPlatform() {
  if (os.platform() === 'win32') {
    die(t('cli.windows'));
  }
}

// Hand-written on purpose: a few flags per command don't justify a dependency. spec maps a flag
// to 'bool' or 'value'; --flag=value works too. Anything unknown is invalid input, never ignored:
// an agent that typoed a flag must not believe it took effect.
function parse(args, spec, maxPositional) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      pos.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith('-') || a === '-') {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    const type = spec[name];
    if (!type) invalid(t('cli.unknownArg', { arg: name }));
    if (type === 'bool') {
      if (eq > 0) invalid(t('cli.noValue', { arg: name }));
      flags[name] = true;
    } else {
      const v = eq > 0 ? a.slice(eq + 1) : args[++i];
      if (v === undefined) invalid(t('cli.needsValue', { arg: name }));
      flags[name] = v;
    }
  }
  if (pos.length > maxPositional) invalid(t('cli.extraArg', { arg: pos[maxPositional] }));
  return { flags, pos };
}

const lib = (name) => require(path.join(ROOT, 'lib', `${name}.js`));

// The workspace a command acts on: the given slug or path, else the nearest one above the
// current directory — a shell is often inside one of its worktrees.
function targetWs(given) {
  const W = lib('workspace');
  if (given) {
    const ws = config.resolveWs(given, cfg);
    if (!fs.existsSync(ws)) invalid(t('cli.noWorkspace', { ws }));
    return { ws, legacy: !W.hasState(ws) };
  }
  return W.find(process.cwd());
}

async function cmdNew(args) {
  const { flags, pos } = parse(args, {
    '--title': 'value', '--kind': 'value', '--skill': 'value', '--ticket': 'value', '--no-launch': 'bool',
  }, 1);
  if (!pos[0]) invalid(t('cli.newSlug'));
  const kind = flags['--kind'] || 'task';
  if (kind !== 'task' && kind !== 'process') invalid(t('cli.badKind', { kind }));
  if (kind === 'process' && !flags['--skill']) invalid(t('cli.skillRequired'));
  if (kind === 'task' && flags['--skill']) invalid(t('cli.skillForProcess'));
  const W = lib('workspace');
  const S = lib('source');
  const meta = {
    kind,
    slug: pos[0],
    title: (flags['--title'] || '').trim() || pos[0],
    ...S.ticketFields(flags['--ticket'], cfg),
    skillName: flags['--skill'] || '',
    // The digest of the owner's rules goes in whenever the file exists: the agent fills it during setup.
    personalRules: !!(cfg.WSG_GLOBAL_MEMORY && fs.existsSync(cfg.WSG_GLOBAL_MEMORY)),
  };
  try {
    W.assertSafe(meta, cfg);
  } catch (e) {
    invalid(e.message);
  }
  guardPlatform();
  const ui = lib('ui');
  const ws = await lib('generate').create(meta, cfg);
  ui.head(t('cli.created', { ws }));

  const L = lib('launch');
  const agent = L.resolveAgent(cfg);
  const launch = agent ? L.launchCommand(agent, ws) : null;
  if (launch && launch.file && L.shouldLaunch({ noLaunch: !!flags['--no-launch'] })) {
    ui.dim(t('cli.launching', { agent }));
    const r = L.run(launch, ws);
    if (r.ok) return 0;
    ui.warn(t('cli.launchFailed', { agent, msg: r.error.message }));
  }
  ui.info('');
  ui.dim(t('cli.next'));
  if (launch && launch.kind === 'claude') {
    // ws starts the agent but doesn't type for it: the skill is the first thing to type there.
    const shellrc = lib('shellrc');
    if (shellrc.loaded() || shellrc.isHooked()) ui.info(t('cli.nextWs', { slug: meta.slug }));
    ui.info(`  ${launch.display}`);
  } else if (launch) {
    ui.info(`  ${launch.display}`);
    if (launch.kind === 'other') ui.info(t('cli.tellAgent'));
  } else {
    ui.info(`  cd ${lib('templates').sh(ws)}`);
    ui.info(t('cli.noAgent', { file: cfg.configFile }));
    ui.info(t('cli.tellAgent'));
  }
  return 0;
}

async function cmdAdd(args) {
  const { flags, pos } = parse(args, {
    '--worktree': 'bool', '--link': 'bool', '--reference': 'bool',
    '--branch': 'value', '--base': 'value', '--reset-to-base': 'bool', '--target': 'value',
    '--verify': 'value', '--carry': 'value', '--clone-node-modules': 'bool', '--no-clone-node-modules': 'bool',
    '--note': 'value', '--dry-run': 'bool', '--ws': 'value',
  }, 1);
  if (!pos[0]) invalid(t('cli.addPath'));
  const modes = ['--worktree', '--link', '--reference'].filter((f) => flags[f]);
  if (modes.length > 1) invalid(t('cli.oneMode'));
  if (flags['--clone-node-modules'] && flags['--no-clone-node-modules']) {
    invalid(t('cli.extraArg', { arg: '--no-clone-node-modules' }));
  }
  const found = targetWs(flags['--ws']);
  if (!found) invalid(t('cli.notInWorkspace'));
  if (found.legacy) invalid(t('cli.legacyWorkspace', { ws: found.ws }));
  const { ws } = found;
  const W = lib('workspace');
  const S = lib('source');
  const generate = lib('generate');
  const ui = lib('ui');

  let state;
  try {
    state = W.readState(ws);
  } catch (e) {
    invalid(e.message);
  }
  const opts = {
    mode: modes.length ? modes[0].slice(2) : undefined,
    branch: flags['--branch'],
    base: flags['--base'],
    resetToBase: flags['--reset-to-base'],
    target: flags['--target'],
    verify: flags['--verify'],
    carry: flags['--carry'],
    cloneNm: flags['--clone-node-modules'] ? true : flags['--no-clone-node-modules'] ? false : undefined,
    note: flags['--note'],
  };
  const res = S.resolve(pos[0], opts, { ws, state });
  // What the generated files would become is worked out before anything changes: a settings.json
  // that doesn't parse, or a half-deleted marker pair, refuses the add here.
  let planned = { files: [], settingsChanged: false, warnings: [] };
  if (res.spec) {
    try {
      planned = generate.plannedFiles(ws, res.spec);
    } catch (e) {
      res.errors.push(e.message);
    }
  }
  const warnings = [...res.warnings, ...planned.warnings];

  if (flags['--dry-run']) {
    const plan = {
      workspace: ws,
      ...(res.plan || {}),
      files: res.errors.length ? [] : planned.files,
      settingsChanged: planned.settingsChanged,
      errors: res.errors,
      warnings,
    };
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return res.errors.length ? INVALID : 0;
  }
  if (res.errors.length) {
    for (const e of res.errors) process.stderr.write(`wsg: ${e}\n`);
    return INVALID;
  }
  for (const w of res.warnings) ui.warn(w);
  for (const n of res.notes) ui.info(`  ${n}`);
  guardPlatform();
  ui.head(t('cli.added', { name: res.spec.name }));
  try {
    const { settingsChanged } = await generate.add(ws, res.spec, cfg);
    if (settingsChanged) ui.info(t('cli.restart', { path: res.spec.path }));
  } catch (e) {
    if (e && e.name === 'Interrupted') {
      process.stderr.write(`${t('cli.addCancelled')}\n`);
      return 130;
    }
    throw e;
  }
  ui.head(t('cli.done'));
  ui.info(t('cli.addNext'));
  return 0;
}

function cmdCheck(args) {
  const { pos } = parse(args, {}, 1);
  let ws;
  if (pos[0]) ws = config.resolveWs(pos[0], cfg);
  else {
    const found = lib('workspace').find(process.cwd());
    ws = found ? found.ws : process.cwd();
  }
  if (!fs.existsSync(ws)) invalid(t('cli.noWorkspace', { ws }));
  return lib('check').run(ws, cfg);
}

async function cmdPromote(args) {
  const { flags, pos } = parse(args, { '--skill': 'value' }, 1);
  if (!flags['--skill']) invalid(t('cli.promoteSkill'));
  const bad = lib('workspace').skillError(flags['--skill']);
  if (bad) invalid(t('workspace.badSkill', { name: flags['--skill'], why: bad }));
  guardPlatform();
  let target = pos[0];
  if (!target) {
    const found = lib('workspace').find(process.cwd());
    target = found ? found.ws : process.cwd();
  }
  return lib('promote').run(target, cfg, { skillName: flags['--skill'] });
}

function cmdInstallSkills(args) {
  parse(args, {}, 0);
  const ui = lib('ui');
  let code = 0;
  for (const { file, status } of lib('skills').install()) {
    if (status === 'written') ui.ok(t('cli.skillWritten', { file }));
    else if (status === 'unchanged') ui.ok(t('cli.skillUnchanged', { file }));
    else {
      ui.fail(t('cli.skillRefused', { file }));
      code = 1;
    }
  }
  return code;
}

const COMMANDS = {
  new: cmdNew,
  add: cmdAdd,
  check: cmdCheck,
  promote: cmdPromote,
  'install-skills': cmdInstallSkills,
  // The 0.1 spellings, kept for one release.
  '--check': cmdCheck,
  '--promote': cmdPromote,
};

(async () => {
  const run = COMMANDS[cmd];
  if (!run) invalid(cmd.startsWith('-') ? t('cli.unknownArg', { arg: cmd }) : t('cli.unknownCommand', { cmd }));
  try {
    process.exit(await run(rest));
  } catch (e) {
    if (e && e.name === 'Interrupted') {
      process.stderr.write(`\n${t('cli.cancelled')}\n`);
      process.exit(130);
    }
    die(String((e && e.message) || e));
  }
})();
