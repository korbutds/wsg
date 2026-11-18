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

const argv = process.argv.slice(2);

// --json is read from argv before anything can refuse: a flag error, a broken config, a refusal
// deep in a command is then an envelope on stdout too (lib/json.js), and ui prints nothing there.
const J = require(path.join(ROOT, 'lib', 'json.js'));
const { FLAGS, GLOBAL, GROUPS, commandOf } = require(path.join(ROOT, 'lib', 'flags.js'));
const ALIASES = { '--check': 'check', '--promote': 'promote' };
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const known = (c) => hasOwn(FLAGS, ALIASES[c] || c);
// `wsg --version --json` gives the version in the envelope.
const takesJson = (c) => c === '--version' || c === '-v' || (known(c) && hasOwn(FLAGS[ALIASES[c] || c], '--json'));
// The flags of a command as its parse will read them, in one pass: not the value of the flag before
// it (`--note --json` is a note), not after `--`. Flags it doesn't know count: parse refuses them.
function flagsSeen(args, spec) {
  const out = new Set();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (!a.startsWith('-') || a === '-' || a.includes('=')) continue;
    if (hasOwn(spec, a) && spec[a] === 'value') i++;
    else out.add(a);
  }
  return out;
}
{
  // An unknown command or a global flag has no flag table: any --json counts, and it is no dry run.
  // A two-word command is named by both words (`context add`), its flags read after them.
  const { name: command, words } = commandOf(argv, ALIASES);
  const seen = command ? flagsSeen(argv.slice(words), FLAGS[command]) : new Set(argv);
  // A dry run only for a command that has one: `check --dry-run` is refused as the flag it is.
  if (seen.has('--json')) J.start({ command, dryRun: !!command && hasOwn(FLAGS[command], '--dry-run') && seen.has('--dry-run') });
}

// jsonCode: the envelope's error code; by default the one the exit code stands for. rollback: what
// the envelope says was changed — "none" by default: die is called before anything is touched.
function die(msg, code = 1, jsonCode = code === INVALID ? 'invalid_input' : 'internal', rollback = 'none') {
  if (J.active()) process.exit(J.fail(jsonCode, msg, { rollback }));
  process.stderr.write(`wsg: ${msg}\n`);
  process.exit(code);
}
const invalid = (msg) => die(msg, INVALID);

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

// `wsg --version --json`, in either order, and nothing else: the version in the envelope.
const VERSION_FLAGS = ['--version', '-v'];
if (J.active() && (VERSION_FLAGS.includes(cmd) || (cmd === '--json' && VERSION_FLAGS.includes(rest[0])))) {
  const others = argv.filter((a) => a !== '--json');
  const extra = others.find((a, i) => i > 0 || !VERSION_FLAGS.includes(a));
  if (extra !== undefined) invalid(t('cli.extraArg', { arg: extra }));
  process.exit(J.succeed({ version: pkg.version }));
}

// A command that has no --json, help and the global flags included: refused as the flag it is, in
// the envelope. An unknown command is reported as one further down.
if (J.active() && !takesJson(cmd) && (known(cmd) || GLOBAL.includes(cmd) || cmd === 'help')) {
  invalid(t('cli.unknownArg', { arg: '--json' }));
}

if (cmd === undefined || cmd === '--help' || cmd === '-h' || (cmd === 'help' && rest.length === 0)) {
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

// A command's options: `wsg help <command>`, or `wsg <command> --help` as its only argument — only
// then, so `--note --help` stays a value. Every command in lib/flags.js has a help.<command> text;
// the two-word ones share their group's: `wsg help context`, `wsg help context add`,
// `wsg context --help` and `wsg context add --help` print help.context.
{
  const isHelp = (a) => a === '--help' || a === '-h';
  const asked = rest.length === 1 && isHelp(rest[0]) && known(cmd);
  const group = GROUPS.includes(cmd) && ((rest.length === 1 && isHelp(rest[0]))
    || (rest.length === 2 && hasOwn(FLAGS, `${cmd} ${rest[0]}`) && isHelp(rest[1])));
  if (cmd === 'help' || asked || group) {
    const topic = cmd === 'help' ? rest[0] : cmd;
    const max = cmd === 'help' && GROUPS.includes(topic) ? 2 : 1;
    if (cmd === 'help' && rest.length > max) invalid(t('cli.extraArg', { arg: rest[max] }));
    if (cmd === 'help' && rest.length === 2 && !hasOwn(FLAGS, `${topic} ${rest[1]}`)) invalid(t('cli.unknownCommand', { cmd: `${topic} ${rest[1]}` }));
    if (!known(topic) && !GROUPS.includes(topic)) invalid(t('cli.unknownCommand', { cmd: topic }));
    process.stdout.write(t(`help.${ALIASES[topic] || topic}`));
    process.exit(0);
  }
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

// What a cancelled add, remove or team says: the workspace as it was, as it was but for the files
// the rollback kept because they changed during the run, or — a rollback step failed — neither.
const cancelled = (e) => (e.rollbackFailed ? t('cli.cancelledIncomplete')
  : e.kept && e.kept.length ? t('cli.cancelledKept', { list: e.kept.join(', ') }) : t('cli.addCancelled'));

// lib/flags.js parses; invalid input exits 2 before anything is touched.
function parse(args, spec, maxPositional) {
  const r = lib('flags').parse(args, spec, maxPositional);
  if (r.error) invalid(t(r.error, { arg: r.arg }));
  if (J.active() && hasOwn(spec, '--dry-run')) J.setDryRun(r.flags['--dry-run']);
  return r;
}

const lib = (name) => require(path.join(ROOT, 'lib', `${name}.js`));
// The workspace the command acts on, once known: the envelope gives the rollback's kept paths
// absolute against it.
let currentWs = null;

// add, remove and promote change wsg.json: one at a time per workspace (lib/lock.js).
// opts: as acquire takes them.
// Returns release(): a command that goes on after its writes (wsg new starts the agent) lets go first.
function lock(ws, opts) {
  try {
    return lib('lock').acquire(ws, opts);
  } catch (e) {
    if (e.busy) die(e.message, INVALID, 'busy');
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
    if (!W.isLegacy(ws)) invalid(t('cli.notWorkspace', { ws }));
    return { ws, legacy: true };
  }
  return W.find(process.cwd());
}

// A source as --json gives it (add, new, list): lib/json.js.
const { sourceResult } = J;

async function cmdNew(args) {
  const { flags, pos } = parse(args, FLAGS.new, 1);
  if (!pos[0]) invalid(t('cli.newSlug'));
  const kind = flags['--kind'] || 'task';
  if (!lib('workspace').KINDS.includes(kind)) invalid(t('cli.badKind', { kind }));
  if (kind !== 'process' && flags['--skill']) invalid(t('cli.skillForProcess'));
  const W = lib('workspace');
  const S = lib('source');
  // The skill named after the slug: a slug the skill rules reject asks for --skill, not another slug.
  if (kind === 'process' && !flags['--skill'] && !W.slugError(pos[0])) {
    const bad = W.skillError(pos[0]);
    if (bad) invalid(t('workspace.badSkillFromSlug', { name: pos[0], why: bad }));
  }
  const dryRun = !!flags['--dry-run'];
  if (flags['--sources'] !== undefined && flags['--epic'] === undefined) invalid(t('cli.sourcesNeedEpic'));
  // A task of an epic: the epic is named, never taken from the current directory. It is a workspace
  // right in WS_ROOT, where `<epic>/<task>` resolves; one elsewhere is refused.
  let epicWs = '';
  let epic = null;
  let release = () => {};
  if (flags['--epic'] !== undefined) {
    if (!flags['--epic']) invalid(t('cli.needsValue', { arg: '--epic' }));
    if (kind !== 'task') invalid(t('workspace.epicTaskKind', { kind }));
    const given = config.resolveWs(flags['--epic'], cfg);
    // native: the name as it is on disk — on macOS `PAY` finds `pay`, and the task must say `pay`.
    const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
    if (!fs.existsSync(given)) invalid(t('cli.noEpic', { ws: given }));
    if (path.dirname(real(given)) !== real(cfg.WS_ROOT)) invalid(t('cli.epicOutsideRoot', { ws: given, root: cfg.WS_ROOT }));
    epicWs = path.join(cfg.WS_ROOT, path.basename(real(given)));
    const readEpic = () => {
      let st;
      try {
        st = W.epicState(epicWs);
      } catch (e) {
        return invalid(e.message);
      }
      // An archived epic takes no new task: its sources are detached, its tasks archived.
      if (st.archive) invalid(t('cli.archivedWs', { ws: epicWs, name: path.basename(epicWs) }));
      return st;
    };
    epic = readEpic();
    // Held from the checks to the tasks.md write: a task made or a source added meanwhile is seen,
    // so the state is read again under it. A dry run changes nothing and takes no lock, as in add.
    if (!dryRun) {
      release = lock(epicWs);
      epic = readEpic();
    }
  }
  const meta = {
    kind,
    slug: pos[0],
    ...(epicWs ? { epicWs } : {}),
    title: (flags['--title'] || '').trim() || pos[0],
    ...S.ticketFields(flags['--ticket'], cfg),
    // A process's skill is named after the slug unless --skill says otherwise.
    skillName: flags['--skill'] || (kind === 'process' ? pos[0] : ''),
    // The digest of the owner's rules goes in whenever the file exists: the agent fills it during setup.
    personalRules: !!(cfg.WSG_GLOBAL_MEMORY && fs.existsSync(cfg.WSG_GLOBAL_MEMORY)),
  };
  const generate = lib('generate');
  const json = J.active();
  const errors = [];
  let planned = null;
  try {
    planned = W.assertSafe(meta, cfg);
  } catch (e) {
    // Under --json a refusal is the same document with --dry-run and without: collected, as there.
    if (!dryRun && !json) invalid(e.message);
    errors.push(e.message);
  }
  const target = planned || (epicWs ? path.join(epicWs, meta.slug) : path.join(cfg.WS_ROOT, meta.slug));
  currentWs = epicWs || target;
  // The epic's sources the task takes, every one resolved before anything is made: one refused
  // refuses the task, with nothing touched.
  const taken = { specs: [], plans: [], warnings: [], notes: [] };
  if (epic && planned) {
    const vars = { slug: meta.slug, ticket: generate.ticketKey(meta), given: (flags['--ticket'] || '').trim() };
    let names = epicSourcesOf(epic, flags['--sources']);
    // The one taken by default, when its branch needs a ticket the task has none of: left for later,
    // not a refusal of a task nobody asked a source for. Asked for by name, it is refused.
    if (flags['--sources'] === undefined && names.length && !vars.ticket && S.epicSource(epic, names[0]).task.branch.includes('{ticket}')) {
      taken.warnings.push(t(vars.given ? 'cli.epicDefaultTicketNoKey' : 'cli.epicDefaultNeedsTicket', { name: names[0], ticket: vars.given }));
      names = [];
    }
    const state = { kind: 'task', epic: { slug: epic.slug }, sources: [] };
    // The task is not made yet: its real path is the epic's, and its name.
    const home = path.join(fs.realpathSync.native(epicWs), meta.slug);
    for (const name of names) {
      let res;
      try {
        res = S.fromEpic(name, epic, vars, {}, { ws: planned, state, home });
      } catch (e) {
        // Ctrl+C while git was asked about the source: only read so far, nothing changed.
        if (e && e.name === 'Interrupted') throw Object.assign(e, { rollback: 'none' });
        throw e;
      }
      taken.plans.push(res.plan);
      errors.push(...res.errors.map((e) => `${name}: ${e}`));
      taken.warnings.push(...res.warnings.map((w) => `${name}: ${w}`));
      taken.notes.push(...res.notes.map((n) => `${name}: ${n}`));
      if (res.spec) {
        taken.specs.push(res.spec);
        state.sources.push(res.spec);
      }
    }
    // What createInEpic reads from the epic before it makes anything — its Owner rules, the tasks
    // block of tasks.md — checked here, in the plan: a dry run refuses what the real run would. Its
    // warnings go into a dry run's plan; a real run gets them from createInEpic, once. Owner rules
    // that can't be read never refuse the task: the block points to ../AGENTS.md, with a warning.
    try {
      const rules = dryRun ? generate.epicRules(epicWs, epic.slug) : null;
      if (rules && rules.kind === 'refused') taken.warnings.push(generate.epicRulesWarning(rules, false));
      const tasks = generate.renderTasks(epicWs, epic);
      if (dryRun) taken.warnings.push(...tasks.warnings);
    } catch (e) {
      errors.push(e.message);
    }
  }
  // The result --json gives: the workspace as planned or made, its sources as resolved or attached.
  const result = (sources = errors.length ? taken.plans : taken.specs) => ({
    workspace: target,
    kind,
    slug: meta.slug,
    title: meta.title,
    epic: epic ? epic.slug : null,
    // The ticket key parsed from what was given, as a task of an epic keeps it; the text as given.
    ticket: generate.ticketKey(meta) || null,
    ticketText: (flags['--ticket'] || '').trim() || null,
    status: kind === 'epic' ? null : 'open',
    sources: sources.map((x) => sourceResult(target, x)),
    launched: false,
  });
  if (json && errors.length) return J.fail('invalid_input', errors[0], { details: errors, result: result(), warnings: taken.warnings });
  if (dryRun && json) return J.succeed(result(), { warnings: taken.warnings });
  if (dryRun) {
    const state = { ...generate.skeletonState({ ...meta, ...(epic ? { epic: { slug: epic.slug }, ticketKey: generate.ticketKey(meta) } : {}) }), sources: taken.specs };
    process.stdout.write(`${JSON.stringify({
      workspace: target,
      state,
      sources: taken.plans,
      errors,
      warnings: taken.warnings,
    }, null, 2)}\n`);
    return errors.length ? INVALID : 0;
  }
  if (errors.length) {
    for (const e of errors) process.stderr.write(`wsg: ${e}\n`);
    return INVALID;
  }
  guardPlatform();
  const ui = lib('ui');
  for (const w of taken.warnings) ui.warn(w);
  for (const n of taken.notes) ui.info(`  ${n}`);
  let ws;
  try {
    ws = await generate.create({ ...meta, ...(epic ? { sources: taken.specs } : {}) }, cfg);
  } catch (e) {
    // The epic's files that can't be read or rendered: refused before anything was made.
    if (e && e.invalid) {
      // The plan's warnings went out through ui already: not again.
      if (json) return J.fail('invalid_input', e.message, { details: [e.message], result: result(), rollback: 'none' });
      invalid(e.message);
    }
    // Rolled back as far as it went; kept paths absolute, each from the directory it is in (the
    // task's files, the epic's tasks.md). The message as without --json.
    if (json && e && e.name === 'Interrupted') {
      const said = e.rollbackFailed || (e.kept && e.kept.length) ? cancelled(e) : t('cli.cancelled');
      return J.fail('interrupted', said, J.rollbackOf(e, target));
    }
    if (json && e && e.rollback) return J.fail('step_failed', String(e.message), J.rollbackOf(e, target));
    // tasks.md edited during the run is kept: "nothing created" would not be the whole truth.
    if (e && e.name === 'Interrupted' && (e.rollbackFailed || (e.kept && e.kept.length))) {
      process.stderr.write(`\n${cancelled(e)}\n`);
      return 130;
    }
    throw e;
  }
  // Not held through the agent's session: its setup runs wsg add, and the epic must stay usable.
  release();
  // Under --json no agent is started: stdout is the envelope, and the caller starts it.
  if (json) return J.succeed(result(W.readState(ws).sources));
  ui.head(t(epicWs && taken.specs.length ? 'cli.createdWithSources' : 'cli.created', { ws }));
  if (epicWs) {
    ui.info(t('cli.epicTaskNext', { epic: path.basename(epicWs) }));
    // As attached: a worktree on the branch it got, a link, a reference.
    const got = lib('workspace').readState(ws).sources.filter((s) => s.from === 'epic');
    const shown = got.map((s) => t(`cli.epicAs.${s.reference ? 'reference' : s.mode}`, { name: s.name, branch: s.branch }));
    if (got.length) ui.info(t('cli.epicAttached', { list: shown.join(', ') }));
    // Without a git repository the task is not set up: check says so until one is attached.
    if (!got.some((s) => !s.reference)) ui.info(t('cli.epicNoGit', { list: epic.sources.map((s) => s.name).join(', ') || '—' }));
  }

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
    const wsName = epicWs ? `${path.basename(epicWs)}/${meta.slug}` : meta.slug;
    if (shellrc.loaded() || shellrc.isHooked()) ui.info(t('cli.nextWs', { slug: wsName }));
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

// The epic's sources a new task of it takes: `--sources a,b`, `none`, or — not given — the one with a
// branch template when the epic has exactly one, else none. A name the epic has no source by is
// refused with the list; S.fromEpic matches names as it does.
function epicSourcesOf(epic, given) {
  if (given === undefined) {
    const templated = epic.sources.filter((s) => s && s.task);
    return templated.length === 1 ? [templated[0].name] : [];
  }
  const names = given.split(',').map((x) => x.trim()).filter(Boolean);
  if (!names.length) invalid(t('cli.needsValue', { arg: '--sources' }));
  if (names.some((n) => n.toLowerCase() === 'none')) {
    if (names.length > 1) invalid(t('cli.sourcesNone'));
    return [];
  }
  const S = lib('source');
  const seen = new Set();
  for (const n of names) {
    const s = S.epicSource(epic, n);
    if (!s) invalid(t('add.epicSourceUnknown', { name: n, epic: epic.slug, list: epic.sources.map((x) => x.name).join(', ') || '—' }));
    if (seen.has(s.name)) invalid(t('cli.sourcesTwice', { name: s.name }));
    seen.add(s.name);
  }
  return names.map((n) => S.epicSource(epic, n).name);
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
  currentWs = ws;
  const W = lib('workspace');
  const S = lib('source');
  const generate = lib('generate');
  const ui = lib('ui');
  const readState = (dir) => {
    try {
      return W.readState(dir);
    } catch (e) {
      return invalid(e.message);
    }
  };
  // In a task of an epic, a name with no / that one of the epic's sources has is that source, with
  // the epic's defaults for its tasks; `./name` is a path, as everywhere.
  const fromEpic = (st) => {
    if (!st.epic || pos[0].includes('/')) return null;
    const epicWs = W.epicOf(ws, st);
    let epic;
    try {
      epic = W.epicState(epicWs);
    } catch (e) {
      return invalid(t('cli.epicUnreadable', { name: pos[0], msg: e.message }));
    }
    return S.epicSource(epic, pos[0]) ? { epicWs, epic } : null;
  };
  let state = readState(ws);
  // An archived workspace has its sources in the archive record: wsg unarchive attaches them again.
  if (state.archive) invalid(t('cli.archivedWs', { ws, name: path.basename(ws) }));
  // A task of an archived epic: its epic's sources are detached, and the task comes back with it.
  if (state.epic) {
    let epicSt = null;
    try { epicSt = W.epicState(W.epicOf(ws, state)); } catch { /* fromEpic says what is wrong */ }
    if (epicSt && epicSt.archive) invalid(t('cli.epicArchivedAdd', { epic: state.epic.slug }));
  }
  let derived = fromEpic(state);
  // Held from the checks to the last write: the state they read is the state that gets changed.
  // In a task of an epic, for a name that may be one of its sources, the epic's too — always the
  // epic's first, then the task's — whether it is one or not: a source added or removed in between
  // is seen, as both are read again and the name decided again under the locks.
  if (!flags['--dry-run']) {
    if (state.epic && !pos[0].includes('/')) lock(W.epicOf(ws, state));
    lock(ws);
    state = readState(ws);
    derived = fromEpic(state);
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
    branchTemplate: flags['--branch-template'],
  };
  let res;
  try {
    res = derived
      ? S.fromEpic(pos[0], derived.epic, { slug: state.slug, ticket: state.ticket || '', made: true }, opts, { ws, state })
      : S.resolve(pos[0], opts, { ws, state });
  } catch (e) {
    // Ctrl+C while git was asked about the source: only read so far, nothing changed.
    if (e && e.name === 'Interrupted') throw Object.assign(e, { rollback: 'none' });
    throw e;
  }
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

  const json = J.active();
  // The result --json gives, plan or done: every key always there, the paths absolute. The source
  // as it would be attached, or — refused — as far as it was worked out.
  // done: what the add itself reported ({ settingsChanged, backupBranch }); without it the result
  // is a plan, and says how the worktree would start.
  const result = (done = null) => {
    const p = res.plan || {};
    return {
      workspace: ws,
      source: sourceResult(ws, res.spec || p, p),
      files: res.errors.length ? [] : planned.files.map((f) => path.join(ws, f)),
      settingsChanged: done ? done.settingsChanged : planned.settingsChanged,
      backupBranch: (done && done.backupBranch) || null,
      // What the plain add says about the source before it starts: attached as is, continuing origin/….
      notes: res.notes || [],
      plan: done ? null : {
        start: p.start || null,
        branchExists: typeof p.branchExists === 'boolean' ? p.branchExists : null,
        remoteBranch: p.remoteBranch || null,
        // An epic's source has its candidates in the defaults for its tasks.
        carryCandidates: Array.isArray(p.carryCandidates) ? p.carryCandidates
          : p.task && Array.isArray(p.task.carryCandidates) ? p.task.carryCandidates : [],
      },
    };
  };
  // A refused plan: the same document with --dry-run and without.
  if (json && res.errors.length) return J.fail('invalid_input', res.errors[0], { details: res.errors, result: result(), warnings });
  if (flags['--dry-run'] && json) return J.succeed(result(), { warnings });

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
    const added = await generate.add(ws, res.spec, cfg);
    const { settingsChanged } = added;
    if (json) return J.succeed(result(added));
    ui.head(t('cli.added', { name: res.spec.name }));
    if (settingsChanged) ui.info(t('cli.restart', { path: res.spec.path }));
  } catch (e) {
    if (e && e.name === 'Interrupted') {
      if (json) return J.fail('interrupted', cancelled(e), J.rollbackOf(e, ws));
      process.stderr.write(`${cancelled(e)}\n`);
      return 130;
    }
    // A step that failed, the last checks inside it included: exit 1 as without --json, rolled back
    // as far as it went (guarded() in lib/generate.js; "none" when it failed before the first step).
    if (json && e && e.rollback) return J.fail('step_failed', String(e.message), J.rollbackOf(e, ws));
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
  currentWs = ws;
  const generate = lib('generate');
  const ui = lib('ui');
  if (!flags['--dry-run']) lock(ws);
  try {
    if (lib('workspace').readState(ws).archive) invalid(t('cli.archivedWs', { ws, name: path.basename(ws) }));
  } catch { /* planRemove reports a state that does not read */ }
  let plan;
  try {
    plan = generate.planRemove(ws, pos[0], { deleteIgnored: !!flags['--delete-ignored'] });
  } catch (e) {
    // Ctrl+C while git listed the worktree: exit 130. Only read so far, nothing changed.
    if (e && e.name === 'Interrupted') throw Object.assign(e, { rollback: 'none' });
    invalid(e.message);
  }
  const r = plan.source;
  const json = J.active();
  // The result --json gives, plan or done: every key always there, the paths absolute.
  const result = (branch = plan.branch) => ({
    workspace: ws,
    name: r ? r.name : pos[0],
    path: r ? r.path : null,
    mode: r ? (r.reference ? 'reference' : r.mode) : null,
    branchKept: branch || null,
    ignored: r ? plan.ignored.map((f) => path.join(ws, r.name, f)) : [],
    files: plan.errors.length ? [] : plan.files.map((f) => path.join(ws, f)),
    settingsChanged: plan.settingsChanged,
  });
  // A refused plan: the same document with --dry-run and without.
  if (json && plan.errors.length) return J.fail('invalid_input', plan.errors[0], { details: plan.errors, result: result(), warnings: plan.warnings });
  if (flags['--dry-run'] && json) return J.succeed(result(), { warnings: plan.warnings });
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
    if (json) return J.succeed(result(branch));
    ui.head(t('cli.removed', { name: r.name }));
    if (branch) ui.info(t('cli.branchKept', { branch, path: r.path }));
  } catch (e) {
    // Files that appeared after the plan: refused before anything changed.
    if (e && e.invalid) {
      if (json) return J.fail('invalid_input', e.message, { details: [e.message], result: result(), warnings: plan.warnings });
      process.stderr.write(`wsg: ${e.message}\n`);
      return INVALID;
    }
    if (e && e.name === 'Interrupted') {
      if (json) return J.fail('interrupted', cancelled(e), J.rollbackOf(e, ws));
      process.stderr.write(`${cancelled(e)}\n`);
      return 130;
    }
    // A step that failed: rolled back as far as it went (guarded() in lib/generate.js).
    if (json && e && e.rollback) return J.fail('step_failed', String(e.message), J.rollbackOf(e, ws));
    throw e;
  }
  ui.info(t('cli.addNext'));
  return 0;
}

// Brings the generated parts in line with this wsg and the state: a block new in this version, or
// markers deleted by hand. Nothing else is touched; --dry-run lists what would change. --tasks, in an
// epic: then every task of it, each under its own lock, as wsg context and wsg mcp do after a change
// (a busy task is reported, a done one left as it is).
async function cmdRefresh(args) {
  const { flags } = parse(args, FLAGS.refresh, 0);
  const found = targetWs(flags['--ws']);
  if (!found) invalid(t('cli.notInWorkspace'));
  if (found.legacy) invalid(t('cli.legacyWorkspace', { ws: found.ws }));
  const { ws } = found;
  currentWs = ws;
  const generate = lib('generate');
  const W = lib('workspace');
  const ui = lib('ui');
  const json = J.active();
  const withTasks = !!flags['--tasks'];
  let slug = path.basename(ws);
  if (withTasks) {
    let st;
    try {
      st = W.readState(ws);
    } catch (e) {
      invalid(e.message);
    }
    if (st.kind !== 'epic') invalid(t('cli.refreshTasksEpic', { ws, kind: st.kind }));
    slug = st.slug;
  }
  // The result --json gives: the files absolute; tasks null without --tasks.
  const result = (rendered, tasks) => ({
    workspace: ws,
    files: rendered ? generate.changedFiles(rendered).map((f) => path.join(ws, f)) : [],
    settingsChanged: rendered ? rendered.settingsChanged : false,
    tasks: withTasks ? tasks : null,
  });
  if (flags['--dry-run']) {
    let rendered = null;
    let error = '';
    try {
      rendered = generate.computeRender(ws, W.readState(ws), null);
    } catch (e) {
      error = e.message;
    }
    const tasks = withTasks && !error ? await generate.refreshEpicTasks(ws, { dryRun: true }) : [];
    if (json) {
      if (error) return J.fail('invalid_input', error, { details: [error], result: result(null, []) });
      return J.succeed(result(rendered, tasks), { warnings: rendered.warnings });
    }
    process.stdout.write(`${JSON.stringify({
      workspace: ws,
      files: rendered ? generate.changedFiles(rendered) : [],
      settingsChanged: rendered ? rendered.settingsChanged : false,
      ...(withTasks ? { tasks } : {}),
      errors: error ? [error] : [],
      warnings: rendered ? rendered.warnings : [],
    }, null, 2)}\n`);
    return error ? INVALID : 0;
  }
  lock(ws);
  guardPlatform();
  let rendered;
  try {
    // Everything is computed before the first write: a broken pair refuses it with nothing changed.
    rendered = generate.renderGenerated(ws);
  } catch (e) {
    invalid(e.message);
  }
  let tasks = null;
  if (withTasks) {
    const r = await refreshTasksOf(ws);
    tasks = r.tasks;
    if (r.stopped) {
      const left = tasks.filter((x) => x.code === 'interrupted').map((x) => x.task).join(', ') || '—';
      const said = t('cli.refreshTasksInterrupted', { epic: slug, list: left });
      if (json) return J.fail('interrupted', said, { rollback: 'unknown', result: result(rendered, tasks) });
      process.stderr.write(`\n${said}\n`);
      return 130;
    }
  }
  if (json) return J.succeed(result(rendered, tasks));
  const files = generate.changedFiles(rendered);
  if (files.length) ui.head(t('cli.refreshed', { list: files.join(', ') }));
  else ui.ok(t('cli.refreshNone'));
  if (rendered.settingsChanged) ui.info(t('cli.refreshRestart'));
  if (tasks) reportTasks(tasks);
  return 0;
}

// A team of roles: cards and a workflow in team/, an adapter per role for Claude Code, the AGENTS.md
// block. Only adds; a file that exists is kept. --dry-run lists what would be written.
async function cmdTeam(args) {
  const { flags, pos } = parse(args, FLAGS.team, 1);
  const found = targetWs(flags['--ws']);
  if (!found) invalid(t('cli.notInWorkspace'));
  if (found.legacy) invalid(t('cli.legacyWorkspace', { ws: found.ws }));
  const { ws } = found;
  const W = lib('workspace');
  const team = lib('team');
  const ui = lib('ui');
  // Held from the plan to the last write, as in add.
  if (!flags['--dry-run']) lock(ws);
  let state;
  try {
    state = W.readState(ws);
  } catch (e) {
    invalid(e.message);
  }
  const p = team.plan(ws, state, pos[0], flags['--without']);
  if (flags['--dry-run']) {
    process.stdout.write(`${JSON.stringify({
      workspace: ws,
      roles: p.roles,
      created: p.errors.length ? [] : team.created(p),
      kept: p.errors.length ? [] : team.kept(p),
      updated: p.errors.length ? [] : team.updated(p),
      errors: p.errors,
      warnings: p.warnings,
    }, null, 2)}\n`);
    return p.errors.length ? INVALID : 0;
  }
  if (p.errors.length) {
    for (const e of p.errors) process.stderr.write(`wsg: ${e}\n`);
    return INVALID;
  }
  for (const w of p.notes) ui.warn(w);
  guardPlatform();
  let written;
  try {
    ({ written } = await team.apply(ws, p));
  } catch (e) {
    if (e && e.name === 'Interrupted') {
      process.stderr.write(`${cancelled(e)}\n`);
      return 130;
    }
    throw e;
  }
  if (written) ui.head(t('cli.teamWritten', { n: written, preset: pos[0] }));
  else ui.ok(t('cli.teamNone'));
  for (const file of team.keptDiffering(p)) ui.info(t('cli.teamKept', { file }));
  if (p.restart) ui.info(t('cli.teamRestart', { slug: state.slug || path.basename(ws) }));
  ui.info(state.kind === 'process' ? t('cli.teamNextProcess', { skill: state.skillName }) : t('cli.teamNext'));
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
  if (!J.active()) return lib('check').run(ws, cfg);
  // The report as the lines check prints, caught by ui: a head opens a section, ok/warn/fail are its
  // items, and so are the dim notes, as "info". A line before the first head would go to the
  // section with an empty title the list starts with; check opens with a head, so that section
  // stays empty. Sections with nothing in them (that one, the closing "Total") are left out:
  // summary has the counts. check's warnings are items, never the envelope's warnings. The checks
  // themselves run as without --json.
  const ui = lib('ui');
  const sections = [{ title: '', items: [] }];
  const summary = { fails: 0, warns: 0 };
  const LEVEL = { ok: 'ok', warn: 'warn', fail: 'fail', dim: 'info', info: 'info' };
  ui.sink((level, text) => {
    if (level === 'head') {
      sections.push({ title: String(text), items: [] });
      return;
    }
    if (level === 'warn') summary.warns++;
    if (level === 'fail') summary.fails++;
    sections[sections.length - 1].items.push({ level: LEVEL[level] || 'info', text: String(text).trim() });
  });
  try {
    lib('check').run(ws, cfg);
  } catch (e) {
    // Exit 1, as without --json (a file given for the workspace: ENOTDIR). check only reads.
    return J.fail('internal', String((e && e.message) || e), { rollback: 'none' });
  }
  const result = { workspace: path.resolve(ws), kind: lib('check').wsKind(path.resolve(ws)), summary, sections: sections.filter((x) => x.items.length) };
  const fails = result.sections.flatMap((x) => x.items.filter((it) => it.level === 'fail').map((it) => it.text));
  return summary.fails ? J.fail('check_failed', t('cli.checkFailed', summary), { result, details: fails }) : J.succeed(result);
}

// Every workspace under WS_ROOT, an epic's tasks under it: a tree, or with --json the same as data.
// Only reads, and runs no git (lib/list.js).
function cmdList(args) {
  parse(args, FLAGS.list, 0);
  const L = lib('list');
  const workspaces = L.collect(cfg.WS_ROOT);
  if (J.active()) return J.succeed({ wsgVersion: pkg.version, wsRoot: cfg.WS_ROOT, workspaces });
  process.stdout.write(L.render(workspaces, cfg.WS_ROOT));
  return 0;
}

// `wsg status <task>` prints a task's or a process's status; `wsg status <task> <status>` sets it,
// and `wsg close <task>` is `wsg status <task> done`: one implementation, one result. The task is
// always named — a task may be called review — and is a slug, `<epic>/<task>` or a path.
async function cmdStatus(args) {
  const { flags, pos } = parse(args, FLAGS.status, 2);
  return statusCommand(pos[0], pos[1], flags, 'cli.statusTask');
}

async function cmdClose(args) {
  const { flags, pos } = parse(args, FLAGS.close, 1);
  return statusCommand(pos[0], 'done', flags, 'cli.closeTask');
}

// value: the status to set, undefined to read it. needTask: the message for a task not named.
async function statusCommand(given, value, flags, needTask) {
  if (!given) invalid(t(needTask));
  const W = lib('workspace');
  // archived is wsg archive's: it removes the worktrees, which a status alone never does.
  if (value === 'archived') invalid(t('cli.statusArchived'));
  if (value !== undefined && !W.STATUSES.includes(value)) invalid(t('cli.badStatus', { value, list: W.STATUSES.join(', ') }));
  const found = targetWs(given);
  if (found.legacy) invalid(t('cli.legacyWorkspace', { ws: found.ws }));
  // As it is on disk: a symlink to a task (or a path with .. or a trailing /) is the task it leads
  // to — its name, its epic, the line it has in tasks.md, its locks — read and set alike.
  const ws = fs.realpathSync(found.ws);
  currentWs = ws;
  // The path the result gives: as wsg list builds it — .. and a trailing / resolved, a symlink above
  // the task (WS_ROOT behind one) kept, so a path taken from list matches it back. Only a task
  // directory that is itself a symlink is given as the task it leads to.
  const asGiven = path.resolve(found.ws);
  const shownWs = fs.lstatSync(asGiven).isSymbolicLink() ? ws : asGiven;
  const readState = () => {
    let st;
    try {
      st = W.readState(ws);
    } catch (e) {
      return invalid(e.message);
    }
    if (st.kind === 'epic') invalid(t('cli.statusEpic', { ws }));
    return st;
  };
  let state = readState();
  const setting = value !== undefined;
  const dryRun = !!flags['--dry-run'];
  // Held from the plan to the last write, the epic's first, then the task's — the order of add — and
  // the state read again under them. A dry run and a read change nothing and take no lock.
  // A task whose directory above is not an epic is refused as a dry run refuses it, before any lock:
  // a lock file is never made in a directory that is not a workspace.
  const releases = [];
  if (setting && !dryRun) {
    if (state.epic) {
      try {
        W.epicState(W.epicOf(ws, state));
      } catch (e) {
        invalid(e.message);
      }
      releases.push(lock(W.epicOf(ws, state)));
    }
    releases.push(lock(ws));
    state = readState();
  }
  // Let go as soon as the writes are done, the task's first: a Ctrl+C after them has nothing to undo.
  const release = () => { while (releases.length) releases.pop()(); };
  const generate = lib('generate');
  const ui = lib('ui');
  let plan;
  try {
    plan = generate.planStatus(ws, state, value, { cwd: process.cwd() });
  } catch (e) {
    // Ctrl+C while git was asked about a worktree: only read so far, nothing changed.
    if (e && e.name === 'Interrupted') {
      release();
      if (J.active()) return J.fail('interrupted', t('cli.statusCancelled'), { rollback: 'none' });
      process.stderr.write(`\n${t('cli.statusCancelled')}\n`);
      return 130;
    }
    throw e;
  }
  const json = J.active();
  // The result --json gives, read, planned or done: every key always there, the paths absolute.
  const result = (done = null) => ({
    workspace: shownWs,
    task: path.basename(ws),
    epic: state.epic ? state.epic.slug : null,
    status: plan.status,
    previous: plan.previous,
    closed: plan.closed,
    archived: W.archivedOn(state),
    changed: plan.changed,
    forEpicPending: plan.forEpicPending,
    sources: plan.sources,
    tasksMdUpdated: done ? done.tasksMdUpdated : plan.tasksMdUpdated,
  });
  // A refused plan: the same document with --dry-run and without.
  if (json && plan.errors.length) return J.fail('invalid_input', plan.errors[0], { details: plan.errors, result: result(), warnings: plan.warnings });
  if (!setting || (dryRun && json)) {
    if (json) return J.succeed(result(), { warnings: plan.warnings });
    // The status alone on stdout, for a script; a warning about it on stderr.
    process.stdout.write(`${plan.status}${plan.closed ? ` ${plan.closed}` : ''}\n`);
    for (const w of plan.warnings) process.stderr.write(`wsg: ${w}\n`);
    return 0;
  }
  if (dryRun) {
    process.stdout.write(`${JSON.stringify({ ...result(), errors: plan.errors, warnings: plan.warnings }, null, 2)}\n`);
    return plan.errors.length ? INVALID : 0;
  }
  if (plan.errors.length) {
    for (const e of plan.errors) process.stderr.write(`wsg: ${e}\n`);
    return INVALID;
  }
  if (!json) for (const w of plan.warnings) ui.warn(w);
  if (!plan.changed) {
    if (json) return J.succeed(result(), { warnings: plan.warnings });
    ui.ok(t('cli.statusSame', { task: path.basename(ws), status: plan.status }));
    return 0;
  }
  let done;
  try {
    done = await generate.applyStatus(ws, plan);
  } catch (e) {
    if (e && e.name === 'Interrupted') {
      if (json) return J.fail('interrupted', cancelled(e), { ...J.rollbackOf(e, ws), warnings: plan.warnings });
      process.stderr.write(`${cancelled(e)}\n`);
      return 130;
    }
    // A write that failed: both files put back as far as it went (guarded() in lib/generate.js).
    if (json && e && e.rollback) return J.fail('step_failed', String(e.message), { ...J.rollbackOf(e, ws), warnings: plan.warnings });
    throw e;
  }
  release();
  if (json) return J.succeed(result(done), { warnings: plan.warnings });
  ui.head(t('cli.statusSet', { task: path.basename(ws), previous: plan.previous, status: plan.status }));
  if (done.tasksMdUpdated) ui.info(t('cli.statusTasksMd', { file: path.join(plan.epicWs, 'tasks.md') }));
  return 0;
}

// The workspace wsg archive and wsg unarchive act on: the one named (a slug, <epic>/<task> or a
// path), the one --ws names, else the one you are in — as it is on disk, so its locks and its line in
// the epic's tasks.md are its own.
function archiveTarget(pos, flags) {
  if (pos[0] !== undefined && flags['--ws'] !== undefined) invalid(t('cli.extraArg', { arg: '--ws' }));
  const found = targetWs(pos[0] !== undefined ? pos[0] : flags['--ws']);
  if (!found) invalid(t('cli.notInWorkspace'));
  if (found.legacy) invalid(t('cli.legacyWorkspace', { ws: found.ws }));
  return fs.realpathSync(found.ws);
}

// The name a workspace is given by in messages: <epic>/<task> for a task of an epic.
const wsName = (ws, state) => (state && state.epic ? `${state.epic.slug}/${path.basename(ws)}` : path.basename(ws));

// The locks of wsg archive and wsg unarchive, taken before the plan and held to the last write: a
// task of an epic, the epic's first (its tasks.md), then the task's — the order of add and status; an
// epic, its own, then every task of it. One that is busy refuses the command with nothing changed
// (exit 2). A dry run takes none. Returns the state read again under them.
function archiveLocks(ws, state, readState) {
  const W = lib('workspace');
  if (state.epic) {
    try {
      W.epicState(W.epicOf(ws, state));
    } catch (e) {
      invalid(e.message);
    }
    lock(W.epicOf(ws, state));
  }
  lock(ws);
  const now = readState(ws);
  if (now.kind === 'epic') for (const c of lib('archive').tasksOf(ws)) lock(c.ws);
  return now;
}

// A stop signal between two steps of a run that has several transactions (an epic's tasks, then the
// epic): the step running rolls itself back (guarded), the ones done stay. Returns { stop(), done() }.
function stopBetweenSteps() {
  let stopped = false;
  const onStop = () => { stopped = true; };
  const takeBack = lib('lock').handOver();
  for (const sig of ['SIGINT', 'SIGHUP', 'SIGTERM']) process.on(sig, onStop);
  return {
    stop: () => stopped,
    done: () => {
      for (const sig of ['SIGINT', 'SIGHUP', 'SIGTERM']) process.off(sig, onStop);
      takeBack();
    },
  };
}

// `wsg archive`: lib/archive.js. Planned with everything checked before the first change; a refused
// plan is the same document with --dry-run and without.
async function cmdArchive(args) {
  const { flags, pos } = parse(args, FLAGS.archive, 1);
  const ws = archiveTarget(pos, flags);
  currentWs = ws;
  const W = lib('workspace');
  const A = lib('archive');
  const T = lib('templates');
  const ui = lib('ui');
  const readState = (dir) => {
    try {
      return W.readState(dir);
    } catch (e) {
      return invalid(e.message);
    }
  };
  const dryRun = !!flags['--dry-run'];
  const deleteIgnored = !!flags['--delete-ignored'];
  let state = readState(ws);
  if (!dryRun) state = archiveLocks(ws, state, readState);
  let plan;
  try {
    plan = A.planArchive(ws, state, { deleteIgnored });
  } catch (e) {
    // Ctrl+C while git was asked about a worktree: only read so far, nothing changed.
    if (e && e.name === 'Interrupted') {
      if (J.active()) return J.fail('interrupted', t('cli.archiveCancelled'), { rollback: 'none' });
      process.stderr.write(`\n${t('cli.archiveCancelled')}\n`);
      return 130;
    }
    throw e;
  }
  const json = J.active();
  const result = (done = null) => A.archiveResult(plan, { deleteIgnored, done });
  const name = wsName(ws, state);
  if (json && plan.errors.length) return J.fail('invalid_input', plan.errors[0], { details: plan.errors, result: result(), warnings: plan.warnings });
  if (dryRun && json) return J.succeed(result(), { warnings: plan.warnings });
  if (dryRun) {
    process.stdout.write(`${JSON.stringify({ ...result(), errors: plan.errors, warnings: plan.warnings }, null, 2)}\n`);
    return plan.errors.length ? INVALID : 0;
  }
  if (plan.errors.length) {
    for (const e of plan.errors) process.stderr.write(`wsg: ${e}\n`);
    return INVALID;
  }
  if (!json) for (const w of plan.warnings) ui.warn(w);
  if (!A.changes(plan)) {
    if (json) return J.succeed(result(), { warnings: plan.warnings });
    ui.ok(t('cli.archiveSame', { name, date: plan.date }));
    return 0;
  }
  guardPlatform();
  const between = stopBetweenSteps();
  let done;
  try {
    done = await A.applyArchive(plan, cfg, { deleteIgnored, stop: between.stop });
  } catch (e) {
    const partial = e && e.partial ? t('cli.archivePartial', { list: e.done.join(', ') }) : '';
    // A worktree that changed after the plan: refused before anything of it changed.
    if (e && e.invalid && e.rollback === 'none' && !partial) {
      if (json) return J.fail('invalid_input', e.message, { details: [e.message], result: result(), warnings: plan.warnings });
      process.stderr.write(`wsg: ${e.message}\n`);
      return INVALID;
    }
    const what = (msg) => (e && e.failedTask ? t('cli.archiveTaskFailed', { task: e.failedTask, msg }) : msg) + (partial ? `\n${partial}` : '');
    // What a run that stopped part of the way did, for a program: the tasks it archived (they stay
    // so), the one that failed, why.
    const stopped = (reason) => ({ done: (e && e.done) || [], failedTask: (e && e.failedTask) || null, reason });
    if (e && e.name === 'Interrupted') {
      if (json) return J.fail('interrupted', what(cancelled(e)), { ...J.rollbackOf(e, ws), warnings: plan.warnings, result: stopped('interrupted') });
      process.stderr.write(`${what(cancelled(e))}\n`);
      return 130;
    }
    if (e && e.rollback) {
      if (json) return J.fail('step_failed', what(String(e.message)), { ...J.rollbackOf(e, ws), warnings: plan.warnings, result: stopped(String(e.message)) });
      process.stderr.write(`wsg: ${what(String(e.message))}\n`);
      return 1;
    }
    throw e;
  } finally {
    between.done();
  }
  if (json) return J.succeed(result(done), { warnings: plan.warnings });
  const r = result(done);
  const worktrees = [r, ...r.tasks].reduce((n, x) => n + x.removes.filter((m) => m.mode === 'worktree').length, 0);
  ui.head(t('cli.archived', { name, date: plan.date }));
  ui.info(t('cli.archivedFreed', { n: worktrees, size: T.sizeOf(r.bytes) }));
  for (const b of r.keeps.branches) ui.info(t('cli.branchKept', { branch: b.branch, path: b.repo }));
  if (done.tasksMdUpdated && plan.epicWs) ui.info(t('cli.statusTasksMd', { file: path.join(plan.epicWs, 'tasks.md') }));
  ui.info(t('cli.archiveBack', { name }));
  return 0;
}

// `wsg unarchive`: lib/archive.js. Every source of the record must come back, or nothing changes.
async function cmdUnarchive(args) {
  const { flags, pos } = parse(args, FLAGS.unarchive, 1);
  const ws = archiveTarget(pos, flags);
  currentWs = ws;
  const W = lib('workspace');
  const A = lib('archive');
  const ui = lib('ui');
  const readState = (dir) => {
    try {
      return W.readState(dir);
    } catch (e) {
      return invalid(e.message);
    }
  };
  const dryRun = !!flags['--dry-run'];
  let state = readState(ws);
  if (!dryRun) state = archiveLocks(ws, state, readState);
  let plan;
  try {
    plan = A.planUnarchive(ws, state);
  } catch (e) {
    // Ctrl+C while git was asked: only read so far, nothing changed.
    if (e && e.name === 'Interrupted') {
      if (J.active()) return J.fail('interrupted', t('cli.archiveCancelled'), { rollback: 'none' });
      process.stderr.write(`\n${t('cli.archiveCancelled')}\n`);
      return 130;
    }
    throw e;
  }
  const json = J.active();
  const result = (done = null) => A.unarchiveResult(plan, { done });
  const name = wsName(ws, state);
  if (json && plan.errors.length) return J.fail('invalid_input', plan.errors[0], { details: plan.errors, result: result(), warnings: plan.warnings });
  if (dryRun && json) return J.succeed(result(), { warnings: plan.warnings });
  if (dryRun) {
    process.stdout.write(`${JSON.stringify({ ...result(), errors: plan.errors, warnings: plan.warnings }, null, 2)}\n`);
    return plan.errors.length ? INVALID : 0;
  }
  if (plan.errors.length) {
    for (const e of plan.errors) process.stderr.write(`wsg: ${e}\n`);
    return INVALID;
  }
  if (!json) for (const w of plan.warnings) ui.warn(w);
  if (!A.changes(plan)) {
    if (json) return J.succeed(result(), { warnings: plan.warnings });
    ui.ok(t('cli.unarchiveSame', { name }));
    return 0;
  }
  guardPlatform();
  const between = stopBetweenSteps();
  let done;
  try {
    done = await A.applyUnarchive(plan, cfg, { stop: between.stop });
  } catch (e) {
    const partial = e && e.partial ? t('cli.unarchivePartial', { list: e.done.join(', ') }) : '';
    const what = (msg) => (e && e.failedTask ? t('cli.unarchiveTaskFailed', { task: e.failedTask, msg }) : msg) + (partial ? `\n${partial}` : '');
    const stopped = (reason) => ({ done: (e && e.done) || [], failedTask: (e && e.failedTask) || null, reason });
    if (e && e.name === 'Interrupted') {
      if (json) return J.fail('interrupted', what(cancelled(e)), { ...J.rollbackOf(e, ws), warnings: plan.warnings, result: stopped('interrupted') });
      process.stderr.write(`${what(cancelled(e))}\n`);
      return 130;
    }
    if (e && e.rollback) {
      if (json) return J.fail('step_failed', what(String(e.message)), { ...J.rollbackOf(e, ws), warnings: plan.warnings, result: stopped(String(e.message)) });
      process.stderr.write(`wsg: ${what(String(e.message))}\n`);
      return 1;
    }
    throw e;
  } finally {
    between.done();
  }
  if (json) return J.succeed(result(done), { warnings: plan.warnings });
  const r = result(done);
  ui.head(r.status ? t('cli.unarchived', { name, status: r.status }) : t('cli.unarchivedEpic', { name, n: r.tasks.length }));
  for (const x of [r, ...r.tasks]) {
    for (const s of x.restores.filter((m) => m.branch)) ui.info(t('cli.unarchivedWorktree', { name: s.name, branch: s.branch }));
  }
  if (done.tasksMdUpdated && plan.epicWs) ui.info(t('cli.statusTasksMd', { file: path.join(plan.epicWs, 'tasks.md') }));
  return 0;
}

// Every task of the epic refreshed after its change is written (generate.refreshEpicTasks), each under
// its own lock; the caller holds the epic's. From here a stop signal stops only the refresh of the
// tasks, and says so — the epic is not put back (lib/lock.js's handler would say it was). The tasks
// left are reported; each catches up at its next wsg refresh. Returns { tasks, stopped }.
async function refreshTasksOf(ws) {
  let stop = false;
  const onStop = () => { stop = true; };
  const takeBack = lib('lock').handOver();
  for (const sig of ['SIGINT', 'SIGHUP', 'SIGTERM']) process.on(sig, onStop);
  let tasks;
  try {
    tasks = await lib('generate').refreshEpicTasks(ws, { stop: () => stop });
  } finally {
    for (const sig of ['SIGINT', 'SIGHUP', 'SIGTERM']) process.off(sig, onStop);
    takeBack();
  }
  for (const x of tasks) if (!x.refreshed && !['done', 'archived', 'interrupted'].includes(x.code)) lib('ui').warn(t('context.taskNotRefreshed', { task: x.task, reason: x.reason }));
  return { tasks, stopped: stop || tasks.some((x) => x.code === 'interrupted') };
}

// What the tasks' refresh printed for people: the ones refreshed, the done and archived ones left as
// they are.
function reportTasks(tasks) {
  const ui = lib('ui');
  const refreshed = tasks.filter((x) => x.refreshed).map((x) => x.task);
  const left = tasks.filter((x) => x.code === 'done').map((x) => x.task);
  const archived = tasks.filter((x) => x.code === 'archived').map((x) => x.task);
  if (refreshed.length) ui.info(t('context.tasksRefreshed', { list: refreshed.join(', ') }));
  if (left.length) ui.dim(t('context.tasksDone', { list: left.join(', ') }));
  if (archived.length) ui.dim(t('context.tasksArchived', { list: archived.join(', ') }));
}

// `wsg context add|note|remove|list`: an epic's context (lib/context.js). A write plans with nothing
// touched, writes the epic under its lock in one transaction, then refreshes every task of the epic,
// each under its own lock (generate.refreshEpicTasks): a task that can't be refreshed is reported in
// the result, never a rollback of the epic's change. Epics only in this version.
async function cmdContext(args) {
  const verb = args[0];
  const name = `context ${verb}`;
  if (verb === undefined) invalid(t('context.noVerb'));
  if (!hasOwn(FLAGS, name)) invalid(t('context.badVerb', { verb }));
  const { flags, pos } = parse(args.slice(1), FLAGS[name], verb === 'list' ? 0 : 1);
  if (verb !== 'list' && !pos[0]) invalid(t(`context.need.${verb}`));
  const found = targetWs(flags['--ws']);
  if (!found) invalid(t('cli.notInWorkspace'));
  if (found.legacy) invalid(t('cli.legacyWorkspace', { ws: found.ws }));
  const { ws } = found;
  currentWs = ws;
  const W = lib('workspace');
  const C = lib('context');
  const generate = lib('generate');
  const ui = lib('ui');
  const T = lib('templates');
  const readEpic = () => {
    let st;
    try {
      st = W.readState(ws);
    } catch (e) {
      return invalid(e.message);
    }
    if (st.kind !== 'epic') invalid(t('context.epicOnly', { ws, kind: st.kind }));
    return st;
  };
  let state = readEpic();
  const json = J.active();
  if (verb === 'list') {
    const items = state.context || [];
    const result = { workspace: ws, items: items.map((x) => C.itemResult(ws, x)), blockBytes: C.blockBytes(state.slug, items) };
    if (json) return J.succeed(result);
    if (!items.length) {
      ui.info(t('context.listEmpty', { epic: state.slug }));
      return 0;
    }
    const width = Math.max(...items.map((x) => x.id.length));
    for (const x of items) {
      const where = x.type === 'link' ? x.url : `${x.path}, ${T.sizeOf(x.bytes)}${x.binary ? ', binary' : ''}`;
      process.stdout.write(`${x.id.padEnd(width)}  [${x.type}] ${x.title}${x.description ? ` — ${x.description}` : ''}  (${where})\n`);
    }
    ui.dim(t('context.listBlock', { bytes: result.blockBytes, warn: W.CONTEXT.blockWarn, max: W.CONTEXT.blockMax }));
    return 0;
  }
  const dryRun = !!flags['--dry-run'];
  // A note's text, read before the lock: from stdin it may take a while to come.
  let body;
  if (verb === 'note') {
    const given = ['--text', '--from'].filter((f) => flags[f] !== undefined);
    if (given.length !== 1) invalid(t('context.noteSource'));
    if (flags['--from'] !== undefined) {
      const from = flags['--from'];
      const max = W.CONTEXT.fileMax;
      const what = from === '-' ? 'stdin' : from;
      // size: the bytes found, or the words for "more than the ceiling" when the rest was not read.
      const tooLarge = (size) => {
        const [found, ceiling] = typeof size === 'number' ? C.sizesOf(size, max) : [size, T.sizeOf(max)];
        invalid(t('context.tooLarge', { what, size: found, max: ceiling }));
      };
      // Anything but a regular file (stdin, a FIFO, /dev/zero) is read up to one byte past the
      // ceiling: what is beyond it is never held in memory.
      const capped = (fd) => {
        const chunks = [];
        let total = 0;
        const buf = Buffer.alloc(1 << 16);
        const pause = new Int32Array(new SharedArrayBuffer(4));
        for (;;) {
          let n;
          try {
            n = fs.readSync(fd, buf, 0, buf.length, null);
          } catch (e) {
            // A non-blocking stdin with nothing yet: wait a little, then ask again.
            if (e.code === 'EAGAIN') { Atomics.wait(pause, 0, 0, 10); continue; }
            if (e.code === 'EOF') break;
            throw e;
          }
          if (n === 0) break;
          chunks.push(Buffer.from(buf.subarray(0, n)));
          total += n;
          if (total > max) tooLarge(t('context.overMax', { max: T.sizeOf(max) }));
        }
        return Buffer.concat(chunks);
      };
      try {
        if (from === '-') body = capped(0);
        else {
          const fd = fs.openSync(path.resolve(from), 'r');
          try {
            const st = fs.fstatSync(fd);
            // A regular file is measured before it is read.
            if (st.isFile() && st.size > max) tooLarge(st.size);
            body = st.isFile() ? fs.readFileSync(fd) : capped(fd);
          } finally {
            fs.closeSync(fd);
          }
          if (body.length > max) tooLarge(body.length);
        }
      } catch (e) {
        invalid(t('context.noteRead', { from, msg: e.message }));
      }
    }
  }
  // Held from the plan to the last write of the epic and through the refresh of its tasks: the epic's
  // first, then each task's, as add takes them. A dry run changes nothing and takes no lock.
  if (!dryRun) {
    lock(ws);
    state = readEpic();
  }
  const plan = verb === 'add'
    ? C.planAdd(ws, state, pos[0], { id: flags['--id'], title: flags['--title'], desc: flags['--desc'], cwd: process.cwd() })
    : verb === 'note'
      ? C.planNote(ws, state, pos[0], { text: flags['--text'], body, title: flags['--title'], desc: flags['--desc'], replace: !!flags['--replace'], discard: !!flags['--discard-edits'] })
      : C.planRemove(ws, state, pos[0], { discard: !!flags['--discard-edits'] });
  // The result --json gives, plan or done: every key always there, the paths absolute.
  const result = (tasks) => ({
    workspace: ws,
    item: C.itemResult(ws, plan.item),
    files: plan.errors.length ? [] : plan.files.map((f) => path.join(ws, f)),
    restartNeeded: !plan.errors.length && plan.blockChanged,
    tasks,
  });
  // A refused plan: the same document with --dry-run and without.
  if (plan.errors.length) {
    if (json) return J.fail('invalid_input', plan.errors[0], { details: plan.errors, result: result([]), warnings: plan.warnings });
    if (dryRun) {
      process.stdout.write(`${JSON.stringify({ ...result([]), errors: plan.errors, warnings: plan.warnings }, null, 2)}\n`);
      return INVALID;
    }
    for (const e of plan.errors) process.stderr.write(`wsg: ${e}\n`);
    return INVALID;
  }
  if (dryRun) {
    const tasks = await generate.refreshEpicTasks(ws, { dryRun: true });
    if (json) return J.succeed(result(tasks), { warnings: plan.warnings });
    process.stdout.write(`${JSON.stringify({ ...result(tasks), errors: [], warnings: plan.warnings }, null, 2)}\n`);
    return 0;
  }
  guardPlatform();
  if (!json) for (const w of plan.warnings) ui.warn(w);
  try {
    await C.apply(ws, plan);
  } catch (e) {
    if (e && e.name === 'Interrupted') {
      if (json) return J.fail('interrupted', cancelled(e), { ...J.rollbackOf(e, ws), warnings: plan.warnings });
      process.stderr.write(`${cancelled(e)}\n`);
      return 130;
    }
    // A step that failed: rolled back as far as it went (guarded() in lib/generate.js).
    if (json && e && e.rollback) return J.fail('step_failed', String(e.message), { ...J.rollbackOf(e, ws), warnings: plan.warnings });
    throw e;
  }
  const { tasks, stopped } = await refreshTasksOf(ws);
  if (stopped) {
    const left = tasks.filter((x) => x.code === 'interrupted').map((x) => x.task).join(', ') || '—';
    const said = t('context.fanoutInterrupted', { epic: state.slug, list: left });
    if (json) return J.fail('interrupted', said, { rollback: 'unknown', result: result(tasks), warnings: plan.warnings });
    process.stderr.write(`\n${said}\n`);
    return 130;
  }
  if (json) return J.succeed(result(tasks), { warnings: plan.warnings });
  const item = plan.item;
  const done = verb === 'add' ? 'context.added' : verb === 'remove' ? 'context.removed'
    : state.context && state.context.some((x) => x.id === item.id) ? 'context.replaced' : 'context.noted';
  ui.head(t(done, { type: item.type, id: item.id, epic: state.slug }));
  reportTasks(tasks);
  if (plan.blockChanged) ui.info(t('context.restart'));
  return 0;
}

// `wsg mcp add|remove|disable|enable|list`: an epic's MCP servers for Claude Code (lib/mcp.js). A
// write plans with nothing touched, writes the epic under its lock in one transaction — its state,
// .mcp.json, its settings.json — then refreshes every task of the epic, each under its own lock, as
// wsg context does. Epics only, Claude Code only in this version: --agent codex is refused. Values
// never leave: results name the variables, never what they hold.
async function cmdMcp(args) {
  const verb = args[0];
  const name = `mcp ${verb}`;
  if (verb === undefined) invalid(t('mcp.noVerb'));
  if (!hasOwn(FLAGS, name)) invalid(t('mcp.badVerb', { verb }));
  // The server's command after `--`, as it is: its own flags are never wsg's.
  let words = args.slice(1);
  let argv = [];
  if (verb === 'add') {
    const at = words.indexOf('--');
    if (at >= 0) {
      argv = words.slice(at + 1);
      words = words.slice(0, at);
    }
  }
  const { flags, pos } = parse(words, FLAGS[name], verb === 'list' ? 0 : 1);
  if (verb !== 'list' && !pos[0]) invalid(t(`mcp.need.${verb}`));
  if (flags['--agent'] !== undefined && flags['--agent'] !== 'claude') {
    invalid(flags['--agent'] === 'codex' ? t('mcp.codexNotYet') : t('mcp.badAgent', { agent: flags['--agent'] }));
  }
  const found = targetWs(flags['--ws']);
  if (!found) invalid(t('cli.notInWorkspace'));
  if (found.legacy) invalid(t('cli.legacyWorkspace', { ws: found.ws }));
  const { ws } = found;
  currentWs = ws;
  const W = lib('workspace');
  const M = lib('mcp');
  const generate = lib('generate');
  const ui = lib('ui');
  const readEpic = () => {
    let st;
    try {
      st = W.readState(ws);
    } catch (e) {
      return invalid(e.message);
    }
    if (st.kind !== 'epic') invalid(t('mcp.epicOnly', { ws, kind: st.kind }));
    return st;
  };
  let state = readEpic();
  const json = J.active();
  if (verb === 'list') {
    const result = M.listResult(ws, state);
    if (json) return J.succeed(result);
    printMcpList(result, state.slug);
    return 0;
  }
  const dryRun = !!flags['--dry-run'];
  // Held from the plan to the last write of the epic and through the refresh of its tasks.
  if (!dryRun) {
    lock(ws);
    state = readEpic();
  }
  const global = M.globalClaude();
  const plan = verb === 'add'
    ? M.planAdd(ws, state, pos[0], { argv, env: flags['--env'], url: flags['--url'], bearerEnv: flags['--bearer-env'], global })
    : verb === 'remove' ? M.planRemove(ws, state, pos[0]) : M.planToggle(ws, state, pos[0], verb === 'disable', { global });
  // The result --json gives, plan or done: every key always there, the paths absolute.
  const after = plan.next ? (plan.next.mcp || { disabled: { claude: [] } }) : null;
  const result = (tasks) => ({
    workspace: ws,
    name: plan.name,
    server: M.serverResult(plan.server),
    disabled: { claude: after ? [...(after.disabled.claude || [])] : [...((state.mcp && state.mcp.disabled.claude) || [])] },
    files: plan.errors.length ? [] : plan.files.map((f) => path.join(ws, f)),
    settingsChanged: !plan.errors.length && plan.settingsChanged,
    restartNeeded: !plan.errors.length && plan.changed,
    tasks,
  });
  if (plan.errors.length) {
    if (json) return J.fail('invalid_input', plan.errors[0], { details: plan.errors, result: result([]), warnings: plan.warnings });
    if (dryRun) {
      process.stdout.write(`${JSON.stringify({ ...result([]), errors: plan.errors, warnings: plan.warnings }, null, 2)}\n`);
      return INVALID;
    }
    for (const e of plan.errors) process.stderr.write(`wsg: ${e}\n`);
    return INVALID;
  }
  if (dryRun) {
    const tasks = await generate.refreshEpicTasks(ws, { dryRun: true });
    if (json) return J.succeed(result(tasks), { warnings: plan.warnings });
    process.stdout.write(`${JSON.stringify({ ...result(tasks), errors: [], warnings: plan.warnings }, null, 2)}\n`);
    return 0;
  }
  guardPlatform();
  if (!json) for (const w of plan.warnings) ui.warn(w);
  try {
    await M.apply(ws, plan);
  } catch (e) {
    if (e && e.name === 'Interrupted') {
      if (json) return J.fail('interrupted', cancelled(e), { ...J.rollbackOf(e, ws), warnings: plan.warnings });
      process.stderr.write(`${cancelled(e)}\n`);
      return 130;
    }
    if (json && e && e.rollback) return J.fail('step_failed', String(e.message), { ...J.rollbackOf(e, ws), warnings: plan.warnings });
    throw e;
  }
  const { tasks, stopped } = await refreshTasksOf(ws);
  if (stopped) {
    const left = tasks.filter((x) => x.code === 'interrupted').map((x) => x.task).join(', ') || '—';
    const said = t('mcp.fanoutInterrupted', { epic: state.slug, list: left });
    if (json) return J.fail('interrupted', said, { rollback: 'unknown', result: result(tasks), warnings: plan.warnings });
    process.stderr.write(`\n${said}\n`);
    return 130;
  }
  if (json) return J.succeed(result(tasks), { warnings: plan.warnings });
  if (plan.changed) ui.head(t(`mcp.done.${verb}`, { name: plan.name, epic: state.slug }));
  else ui.ok(t('mcp.unchanged', { epic: state.slug }));
  reportTasks(tasks);
  if (plan.changed) ui.info(t('mcp.restart'));
  return 0;
}

// `wsg mcp list` for people: the epic's servers, the global ones it turns off, the user-scope ones,
// the variables this shell has no value for. Never a literal's value.
function printMcpList(r, slug) {
  const ui = lib('ui');
  const out = (s) => process.stdout.write(`${s}\n`);
  if (!r.servers.length) ui.info(t('mcp.listEmpty', { epic: slug }));
  const width = Math.max(0, ...r.servers.map((s) => s.name.length));
  for (const s of r.servers) {
    const what = s.transport === 'stdio' ? [s.command, ...s.args].join(' ') : s.url;
    const vars = s.transport === 'stdio' ? (s.env.length ? `  env: ${s.env.join(', ')}` : '') : (s.bearerEnv ? `  bearer: ${s.bearerEnv}` : '');
    out(`${s.name.padEnd(width)}  ${s.transport.padEnd(5)}  ${what}${vars}`);
  }
  out(t('mcp.listDisabled', { list: r.disabled.claude.join(', ') || '—' }));
  out(t('mcp.listGlobal', { list: r.global.claude.map((g) => `${g.name} [${g.transport}]`).join(', ') || '—' }));
  ui.dim(t('mcp.listPlugins'));
  if (r.missingEnv.length) ui.warn(t('mcp.listMissing', { list: r.missingEnv.join(', ') }));
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
  try {
    return await lib('promote').run(target, cfg, { skillName: flags['--skill'] });
  } catch (e) {
    if (e.invalid) invalid(e.message);
    throw e;
  }
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
    else if (status === 'skipped') ui.dim(t('cli.skillSkipped', { file }));
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
  refresh: cmdRefresh,
  team: cmdTeam,
  check: cmdCheck,
  list: cmdList,
  status: cmdStatus,
  close: cmdClose,
  promote: cmdPromote,
  context: cmdContext,
  mcp: cmdMcp,
  archive: cmdArchive,
  unarchive: cmdUnarchive,
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
      if (J.active()) process.exit(J.fail('interrupted', t('cli.cancelled'), J.rollbackOf(e, currentWs)));
      process.stderr.write(`\n${t('cli.cancelled')}\n`);
      process.exit(130);
    }
    // A step that failed inside guarded(): rolled back, or as far as it went.
    if (J.active() && e && e.rollback) process.exit(J.fail('step_failed', String(e.message), J.rollbackOf(e, currentWs)));
    die(String((e && e.message) || e), 1, 'internal', 'unknown');
  }
})();
