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
  if (!/^[a-z]+$/.test(topic) || !fs.existsSync(file)) {
    const topics = fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('-guide.md')).map((f) => f.slice(0, -9));
    invalid(t('cli.guideTopic', { topic, topics: topics.sort().join(', ') }));
  }
  process.stdout.write(fs.readFileSync(file, 'utf8'));
  process.exit(0);
}


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
const { FLAGS } = lib('flags');

// add, remove and promote change wsg.json: one at a time per workspace (lib/lock.js).
// opts: as acquire takes them.
function lock(ws, opts) {
  try {
    lib('lock').acquire(ws, opts);
  } catch (e) {
    if (e.invalid) invalid(e.message);
    throw e;
  }
}

// The workspace a command acts on: the given slug or path, else the nearest one above the
// current directory — a shell is often inside one of its worktrees.
function targetWs(given) {
  const W = lib('workspace');
  if (given) {
    const ws = config.resolveWs(given, cfg);
    if (!fs.existsSync(ws)) invalid(t('cli.noWorkspace', { ws }));
    if (W.hasState(ws)) return { ws, legacy: false };
    // 0.1 marks: ws-kind, or — older still — a CLAUDE.md in a directory that is not a repository.
    const old = fs.existsSync(path.join(ws, '.claude', 'ws-kind'))
      || (fs.existsSync(path.join(ws, 'CLAUDE.md')) && !fs.existsSync(path.join(ws, '.git')));
    if (!old) invalid(t('cli.notWorkspace', { ws }));
    return { ws, legacy: true };
  }
  return W.find(process.cwd());
}

async function cmdNew(args) {
  const { flags, pos } = parse(args, FLAGS.new, 1);
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
  const { flags, pos } = parse(args, FLAGS.add, 1);
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
  // Held from the checks to the last write: the state they read is the state that gets changed.
  if (!flags['--dry-run']) lock(ws);

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
  try {
    const { settingsChanged } = await generate.add(ws, res.spec, cfg);
    ui.head(t('cli.added', { name: res.spec.name }));
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

async function cmdRemove(args) {
  const { flags, pos } = parse(args, FLAGS.remove, 1);
  if (!pos[0]) invalid(t('cli.removeName'));
  const found = targetWs(flags['--ws']);
  if (!found) invalid(t('cli.notInWorkspace'));
  if (found.legacy) invalid(t('cli.legacyWorkspace', { ws: found.ws }));
  const { ws } = found;
  const generate = lib('generate');
  const ui = lib('ui');
  if (!flags['--dry-run']) lock(ws);
  let plan;
  try {
    plan = generate.planRemove(ws, pos[0], { deleteIgnored: !!flags['--delete-ignored'] });
  } catch (e) {
    if (e && e.name === 'Interrupted') throw e; // Ctrl+C while git listed the worktree: exit 130
    invalid(e.message);
  }
  const r = plan.source;
  if (flags['--dry-run']) {
    process.stdout.write(`${JSON.stringify({
      workspace: ws,
      name: r ? r.name : pos[0],
      ...(r ? { path: r.path, mode: r.reference ? 'reference' : r.mode } : {}),
      ...(plan.branch ? { branchKept: plan.branch } : {}),
      ...(plan.ignored.length ? { ignored: plan.ignored } : {}),
      files: plan.errors.length ? [] : plan.files,
      settingsChanged: plan.settingsChanged,
      errors: plan.errors,
      warnings: plan.warnings,
    }, null, 2)}\n`);
    return plan.errors.length ? INVALID : 0;
  }
  if (plan.errors.length) {
    for (const e of plan.errors) process.stderr.write(`wsg: ${e}\n`);
    return INVALID;
  }
  guardPlatform();
  try {
    const { branch } = await generate.remove(ws, r.name, cfg, { deleteIgnored: !!flags['--delete-ignored'], ignored: plan.ignored });
    ui.head(t('cli.removed', { name: r.name }));
    if (branch) ui.info(t('cli.branchKept', { branch, path: r.path }));
  } catch (e) {
    // Files that appeared after the plan: refused before anything changed.
    if (e && e.invalid) {
      process.stderr.write(`wsg: ${e.message}\n`);
      return INVALID;
    }
    if (e && e.name === 'Interrupted') {
      process.stderr.write(`${t('cli.addCancelled')}\n`);
      return 130;
    }
    throw e;
  }
  ui.info(t('cli.addNext'));
  return 0;
}

function cmdCheck(args) {
  const { pos } = parse(args, FLAGS.check, 1);
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
  const { flags, pos } = parse(args, FLAGS.promote, 1);
  if (!flags['--skill']) invalid(t('cli.promoteSkill'));
  const bad = lib('workspace').skillError(flags['--skill']);
  if (bad) invalid(t('workspace.badSkill', { name: flags['--skill'], why: bad }));
  guardPlatform();
  let target = pos[0];
  if (!target) {
    const found = lib('workspace').find(process.cwd());
    target = found ? found.ws : process.cwd();
  }
  // Only a directory that has .claude/ can be a workspace; promote refuses anything else itself.
  // promote is synchronous to the end: a signal handler would never run, only swallow Ctrl+C.
  const ws = config.resolveWs(target, cfg);
  if (fs.existsSync(path.join(ws, '.claude'))) lock(ws, { signals: false });
  return lib('promote').run(target, cfg, { skillName: flags['--skill'] });
}

function cmdInstallSkills(args) {
  const { flags } = parse(args, FLAGS['install-skills'], 0);
  const ui = lib('ui');
  const skills = lib('skills');
  let code = 0;
  if (flags['--uninstall']) {
    for (const { file, status } of skills.uninstall()) {
      if (status === 'removed') ui.ok(t('cli.skillRemoved', { file }));
      else if (status === 'absent') ui.ok(t('cli.skillAbsent', { file }));
      else {
        ui.fail(t('cli.skillNotOurs', { file }));
        code = 1;
      }
    }
    return code;
  }
  for (const { file, status } of skills.install()) {
    if (status === 'written') ui.ok(t('cli.skillWritten', { file }));
    else if (status === 'unchanged') ui.ok(t('cli.skillUnchanged', { file }));
    else {
      ui.fail(t('cli.skillRefused', { file }));
      code = 1;
    }
  }
  return code;
}

// Commands that don't read the settings work even when they are broken, so a bad config can
// be diagnosed and the install finished.
const NO_CONFIG = new Set(['install-skills']);

const COMMANDS = {
  new: cmdNew,
  add: cmdAdd,
  remove: cmdRemove,
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
  if (cfgError && !NO_CONFIG.has(cmd)) die(t('cli.cannotReadSettings', { msg: cfgError.message }));
  // A reader that went away (`wsg remove --dry-run | head`): there is no one to show the rest to,
  // and a stack trace would replace the exit code. The command finishes; its code is the exit code.
  let code = null;
  const onStreamError = (e) => {
    if (!e || e.code !== 'EPIPE') throw e;
    if (code !== null) process.exit(code);
  };
  process.stdout.on('error', onStreamError);
  process.stderr.on('error', onStreamError);
  try {
    code = await run(rest);
    // A pipe takes output asynchronously: exiting at once would cut a long --dry-run at 64 KiB.
    // On a pipe gone the write fails, and its callback still runs.
    let pending = 2;
    const done = () => { if (--pending === 0) process.exit(code); };
    process.stdout.write('', done);
    process.stderr.write('', done);
  } catch (e) {
    if (e && e.name === 'Interrupted') {
      process.stderr.write(`\n${t('cli.cancelled')}\n`);
      process.exit(130);
    }
    die(String((e && e.message) || e));
  }
})();
