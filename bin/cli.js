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
const { FLAGS, GLOBAL } = require(path.join(ROOT, 'lib', 'flags.js'));
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
  const command = known(argv[0]) ? ALIASES[argv[0]] || argv[0] : null;
  const seen = command ? flagsSeen(argv.slice(1), FLAGS[command]) : new Set(argv);
  if (seen.has('--json')) J.start({ command, dryRun: !!command && seen.has('--dry-run') });
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
// then, so `--note --help` stays a value. Every command in lib/flags.js has a help.<command> text.
{
  const asked = rest.length === 1 && (rest[0] === '--help' || rest[0] === '-h') && known(cmd);
  if (cmd === 'help' || asked) {
    const topic = cmd === 'help' ? rest[0] : cmd;
    if (cmd === 'help' && rest.length > 1) invalid(t('cli.extraArg', { arg: rest[1] }));
    if (!known(topic)) invalid(t('cli.unknownCommand', { cmd: topic }));
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
      try {
        return W.epicState(epicWs);
      } catch (e) {
        return invalid(e.message);
      }
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
  const errors = [];
  let planned = null;
  try {
    planned = W.assertSafe(meta, cfg);
  } catch (e) {
    if (!dryRun) invalid(e.message);
    errors.push(e.message);
  }
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
      const res = S.fromEpic(name, epic, vars, {}, { ws: planned, state, home });
      taken.plans.push(res.plan);
      errors.push(...res.errors.map((e) => `${name}: ${e}`));
      taken.warnings.push(...res.warnings.map((w) => `${name}: ${w}`));
      taken.notes.push(...res.notes.map((n) => `${name}: ${n}`));
      if (res.spec) {
        taken.specs.push(res.spec);
        state.sources.push(res.spec);
      }
    }
  }
  if (dryRun) {
    const state = { ...generate.skeletonState({ ...meta, ...(epic ? { epic: { slug: epic.slug }, ticketKey: generate.ticketKey(meta) } : {}) }), sources: taken.specs };
    process.stdout.write(`${JSON.stringify({
      workspace: planned || (epicWs ? path.join(epicWs, meta.slug) : path.join(cfg.WS_ROOT, meta.slug)),
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
    if (e && e.invalid) invalid(e.message);
    // tasks.md edited during the run is kept: "nothing created" would not be the whole truth.
    if (e && e.name === 'Interrupted' && (e.rollbackFailed || (e.kept && e.kept.length))) {
      process.stderr.write(`\n${cancelled(e)}\n`);
      return 130;
    }
    throw e;
  }
  // Not held through the agent's session: its setup runs wsg add, and the epic must stay usable.
  release();
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
  // as it would be attached, or — refused — as far as it was worked out. done: what the add itself
  // reported ({ settingsChanged, backupBranch }); without it the result is a plan, and says how the
  // worktree would start.
  const result = (done = null) => {
    const x = res.spec || res.plan || {};
    const name = x.name || null;
    const mode = x.reference || x.mode === 'reference' ? 'reference' : x.mode || null;
    const p = res.plan || {};
    // The source's own clone flag, or the plan's when it was refused before the spec.
    const nmClone = p.nodeModules && typeof p.nodeModules.clone === 'boolean' ? p.nodeModules.clone : null;
    const task = x.task && typeof x.task === 'object' && !Array.isArray(x.task) ? x.task : null;
    return {
      workspace: ws,
      source: {
        name,
        mode,
        path: x.path || null,
        workspacePath: name ? path.join(ws, name) : null,
        branch: x.branch || null,
        base: x.base || null,
        target: x.target && x.target !== '—' ? x.target : null,
        verify: x.verify || null,
        note: x.note || null,
        carry: Array.isArray(x.carry) ? x.carry : [],
        cloneNm: typeof x.cloneNm === 'boolean' ? x.cloneNm : nmClone,
        from: x.from || null,
        // An epic's defaults for its tasks, always these four keys; base null: the default.
        task: task && {
          branch: typeof task.branch === 'string' ? task.branch : null,
          base: typeof task.base === 'string' && task.base ? task.base : null,
          carry: Array.isArray(task.carry) ? task.carry : [],
          cloneNm: typeof task.cloneNm === 'boolean' ? task.cloneNm : nmClone,
        },
      },
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
// markers deleted by hand. Nothing else is touched; --dry-run lists what would change.
function cmdRefresh(args) {
  const { flags } = parse(args, FLAGS.refresh, 0);
  const found = targetWs(flags['--ws']);
  if (!found) invalid(t('cli.notInWorkspace'));
  if (found.legacy) invalid(t('cli.legacyWorkspace', { ws: found.ws }));
  const { ws } = found;
  const generate = lib('generate');
  const W = lib('workspace');
  const ui = lib('ui');
  if (flags['--dry-run']) {
    let rendered = null;
    let error = '';
    try {
      rendered = generate.computeRender(ws, W.readState(ws), null);
    } catch (e) {
      error = e.message;
    }
    process.stdout.write(`${JSON.stringify({
      workspace: ws,
      files: rendered ? generate.changedFiles(rendered) : [],
      settingsChanged: rendered ? rendered.settingsChanged : false,
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
  const files = generate.changedFiles(rendered);
  if (files.length) ui.head(t('cli.refreshed', { list: files.join(', ') }));
  else ui.ok(t('cli.refreshNone'));
  if (rendered.settingsChanged) ui.info(t('cli.refreshRestart'));
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
      if (J.active()) process.exit(J.fail('interrupted', t('cli.cancelled'), J.rollbackOf(e, currentWs)));
      process.stderr.write(`\n${t('cli.cancelled')}\n`);
      process.exit(130);
    }
    // A step that failed inside guarded(): rolled back, or as far as it went.
    if (J.active() && e && e.rollback) process.exit(J.fail('step_failed', String(e.message), J.rollbackOf(e, currentWs)));
    die(String((e && e.message) || e), 1, 'internal', 'unknown');
  }
})();
