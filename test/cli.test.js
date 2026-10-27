'use strict';

// The commands as a user or an agent runs them: `wsg new`, `add`, `check`, `promote`, `guide`,
// `install-skills`, each in a child process with its own HOME, WS_ROOT and Claude config dir.
// Nothing here needs the network or a real agent.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

// Messages are matched in English; on a machine with a Russian locale the UI would switch.
process.env.WSG_LANG = 'en';

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const W = require(path.join(ROOT, 'lib', 'workspace.js'));
const generate = require(path.join(ROOT, 'lib', 'generate.js'));
const check = require(path.join(ROOT, 'lib', 'check.js'));
const L = require(path.join(ROOT, 'lib', 'launch.js'));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-cli-')));
const home = path.join(tmp, 'home');
const wsRoot = path.join(tmp, 'ws');
const claudeDir = path.join(tmp, 'claude-config');
const fakeBin = path.join(tmp, 'bin');
for (const d of [home, wsRoot, fakeBin]) fs.mkdirSync(d, { recursive: true });

// A fake claude that records how it was started instead of starting anything.
const launched = path.join(tmp, 'launched');
fs.writeFileSync(path.join(fakeBin, 'claude'),
  `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > ${JSON.stringify(launched)}\n`, { mode: 0o755 });

const ENV = {
  PATH: `${fakeBin}:${process.env.PATH}`,
  HOME: home,
  WSG_LANG: 'en',
  WSG_CONFIG: path.join(tmp, 'no-config'),
  WS_ROOT: wsRoot,
  CLAUDE_CONFIG_DIR: claudeDir,
  WSG_NO_LAUNCH: '1',
};
const wsg = (args, { cwd = tmp, env = {}, input = '' } = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', input, env: { ...ENV, ...env }, maxBuffer: 1 << 28 });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
};

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
function makeRepo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\nlocal.pem\n');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'pkg', 'index.ts'), 'export {};\n');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# repo rules\n');
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=x\n');
  fs.writeFileSync(path.join(dir, 'local.pem'), 'pem\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
  return dir;
}
const api = makeRepo('api');
const web = makeRepo('web');
const docs = path.join(tmp, 'docs');
fs.mkdirSync(docs);
fs.writeFileSync(path.join(docs, 'brief.md'), 'brief\n');

// Every path under a directory with its type and bytes: "touches nothing" means this is unchanged.
function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d).sort()) {
      const p = path.join(d, e);
      const rel = path.relative(dir, p);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) {
        out[rel] = 'dir';
        // A worktree's contents are git's business; that it exists at all is what matters.
        if (!fs.existsSync(path.join(p, '.git'))) walk(p);
      } else out[rel] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}
const branches = (dir) => git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(Boolean);
const worktrees = (dir) => git(dir, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length;

let failed = 0;
const it = (name, fn) => {
  try { fn(); console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};
const quietAsync = async (fn) => {
  const log = console.log;
  const err = process.stderr.write;
  console.log = () => {};
  process.stderr.write = () => true;
  try { return await fn(); } finally { console.log = log; process.stderr.write = err; }
};
const failure = async (fn) => {
  try { await quietAsync(fn); return ''; } catch (e) { return e.message; }
};
// What check looks the agent and its config up in: the fake claude and this run's config dirs,
// never the machine's own.
const CHECK_ENV = { HOME: home, PATH: fakeBin, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(tmp, 'codex-config') };
const report = (dir, cfg) => {
  const lines = [];
  const log = console.log;
  console.log = (x) => lines.push(String(x));
  let code;
  try { code = check.run(dir, cfg, CHECK_ENV); } finally { console.log = log; }
  return { code, text: lines.join('\n') };
};

// A suite that stops half-way must not pass: a rejected promise would otherwise end the process
// with code 0 and no summary.
let finished = false;
process.on('exit', () => {
  if (!finished) { console.log('\nFAIL  the suite stopped before the end'); process.exitCode = 1; }
});

const cfg = { WS_ROOT: wsRoot, WSG_GLOBAL_MEMORY: '', WSG_PARENT_CONTEXT: '' };

(async () => {
  console.log('\nworkspace names');
  {
    const bad = (a) => { try { W.assertSafe(a, cfg); return ''; } catch (e) { return e.message; } };
    it('a slug with ../ is refused', () => assert.match(bad({ slug: '../x', kind: 'task' }), /slug \.\.\/x/));
    it('an uppercase slug is refused', () => assert.match(bad({ slug: 'Demo', kind: 'task' }), /Lowercase/));
    fs.mkdirSync(path.join(wsRoot, 'taken'));
    it('an existing workspace is refused', () => assert.match(bad({ slug: 'taken', kind: 'task' }), /already exists/));
    it('a process skill name with ../ is refused', () => assert.match(bad({ slug: 'p', kind: 'process', skillName: '../x' }), /skill name/));
    it('the wsg- prefix is kept for the generator', () => assert.match(bad({ slug: 'p', kind: 'process', skillName: 'wsg-setup' }), /reserved/));
    it('a good slug passes', () => assert.strictEqual(bad({ slug: 'oauth-2', kind: 'task' }), ''));
    it('a path that leaves WS_ROOT is refused even past the name rule', () => assert.throws(() => W.wsPath('../x', cfg), /outside/));
    const answers = { kind: 'task', title: 'T', problem: ['p'], dod: [], links: [], invariants: [], repos: [] };
    const e1 = await failure(() => generate.run({ ...answers, slug: '../escape' }, cfg));
    it('generate.run refuses slug ../x', () => assert.match(e1, /slug/));
    it('and creates nothing outside WS_ROOT', () => assert.ok(!fs.existsSync(path.join(tmp, 'escape'))));
    const e2 = await failure(() => generate.run({ ...answers, kind: 'process', slug: 'proc-escape', skillName: '../../x' }, cfg));
    it('generate.run refuses skill name ../x', () => assert.match(e2, /skill name/));
    it('and creates no workspace', () => assert.ok(!fs.existsSync(path.join(wsRoot, 'proc-escape'))));
  }

  console.log('\nwsg new');
  const demo = path.join(wsRoot, 'demo');
  {
    const r = wsg(['new', 'demo', '--title', 'Demo task', '--ticket', 'PROJ-7', '--no-launch']);
    it('exits 0', () => assert.strictEqual(r.code, 0, r.all));
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'README.md', 'notes.md', 'SETUP.md', '.claude/settings.json', '.claude/ws-kind',
      '.claude/wsg.json', '.claude/skills/wsg-setup/SKILL.md', '.learnings/LEARNINGS.md', '.learnings/ERRORS.md']) {
      it(`created ${f}`, () => assert.ok(fs.statSync(path.join(demo, f)).isFile()));
    }
    for (const d of ['.claude/rules', '.claude/agents', '.claude-memory']) {
      it(`created an empty ${d}/`, () => assert.deepStrictEqual(fs.readdirSync(path.join(demo, d)), []));
    }
    const agents = fs.readFileSync(path.join(demo, 'AGENTS.md'), 'utf8');
    it('AGENTS.md has the FILL IN headings', () => {
      for (const h of ['## Why', '## Definition of done', '## Out of scope', '## Invariants are not findings']) {
        assert.match(agents, new RegExp(`${h}\\n\\nFILL IN`), h);
      }
    });
    it('AGENTS.md carries the ticket', () => assert.match(agents, /^Ticket: PROJ-7$/m));
    it('AGENTS.md has empty marker pairs', () => {
      assert.match(agents, /<!-- wsg:layout -->\n<!-- \/wsg:layout -->/);
      assert.match(agents, /<!-- wsg:verification -->\n- FILL IN: no repository attached yet/);
    });
    it('CLAUDE.md imports AGENTS.md outside the generated block', () =>
      assert.match(fs.readFileSync(path.join(demo, 'CLAUDE.md'), 'utf8'), /^@AGENTS\.md\n<!-- wsg:imports -->\n<!-- \/wsg:imports -->$/m));
    it('README.md has the sources block', () => assert.match(fs.readFileSync(path.join(demo, 'README.md'), 'utf8'), /<!-- wsg:sources -->\nNone yet/));
    it('notes.md says setup is not finished', () =>
      assert.match(fs.readFileSync(path.join(demo, 'notes.md'), 'utf8'), /Setup not finished — run \/wsg-setup \(or follow SETUP\.md\)/));
    it('SETUP.md points to the guide', () => assert.match(fs.readFileSync(path.join(demo, 'SETUP.md'), 'utf8'), /`wsg guide setup`/));
    const state = JSON.parse(fs.readFileSync(path.join(demo, '.claude/wsg.json'), 'utf8'));
    it('wsg.json: version 2, no sources, no prose', () => {
      assert.strictEqual(state.version, 2);
      assert.deepStrictEqual(state.sources, []);
      assert.strictEqual(state.title, 'Demo task');
      assert.ok(!('ticket' in state) && !('problem' in state));
    });
    const skill = fs.readFileSync(path.join(demo, '.claude/skills/wsg-setup/SKILL.md'), 'utf8');
    it('the setup skill: frontmatter first, manual-only, wsg calls allowed', () => {
      assert.match(skill, /^---\nname: wsg-setup\ndescription: .+\n/);
      assert.match(skill, /^disable-model-invocation: true$/m);
      assert.match(skill, /^argument-hint: /m);
      assert.match(skill, /^allowed-tools: Bash\(wsg \*\)$/m);
      assert.match(skill, /Run `wsg guide setup` and follow it for: \$ARGUMENTS/);
    });
    it('the next step is printed', () => assert.match(r.out, /cd .*demo && claude "\/wsg-setup"/));
    it('nothing was launched', () => assert.ok(!fs.existsSync(launched)));
    const c = wsg(['check', demo]);
    it('the skeleton passes its own check', () => assert.strictEqual(c.code, 0, c.out));
    it('with warnings only', () => {
      assert.doesNotMatch(c.out, /FAIL/);
      assert.match(c.out, /WARN setup not finished: no git repository attached, "Why" is not filled in/);
    });
    it('rendering a fresh skeleton changes nothing', () =>
      assert.deepStrictEqual(generate.changedFiles(generate.computeRender(demo, W.readState(demo), null)), []));
    it('the workspace is English whatever the UI language', () => {
      const ru = wsg(['new', 'demo-ru', '--no-launch'], { env: { WSG_LANG: 'ru' } });
      assert.match(ru.out, /Создан/);
      for (const f of ['AGENTS.md', 'README.md', 'notes.md', 'SETUP.md', 'CLAUDE.md']) {
        assert.doesNotMatch(fs.readFileSync(path.join(wsRoot, 'demo-ru', f), 'utf8'), /[Ѐ-ӿ]/, f);
      }
    });

    const before = tree(wsRoot);
    const rejected = [
      ['../x', ['new', '../x', '--no-launch']],
      ['an uppercase slug', ['new', 'Demo', '--no-launch']],
      ['an existing slug', ['new', 'demo', '--no-launch']],
      ['a process without --skill', ['new', 'p1', '--kind', 'process', '--no-launch']],
      ['--skill on a task', ['new', 'p2', '--skill', 'x', '--no-launch']],
      ['an unknown kind', ['new', 'p3', '--kind', 'chore', '--no-launch']],
      ['an unknown flag', ['new', 'p4', '--titel', 'x']],
      ['a flag without its value', ['new', 'p5', '--title']],
      ['no slug', ['new']],
    ];
    for (const [name, args] of rejected) {
      const rr = wsg(args);
      it(`${name}: exit 2`, () => assert.strictEqual(rr.code, 2, rr.all));
    }
    it('rejected runs created nothing', () => assert.deepStrictEqual(tree(wsRoot), before));

    const p = wsg(['new', 'release-flow', '--kind', 'process', '--skill', 'release', '--no-launch']);
    it('a process gets its skill, journal and runs/', () => {
      assert.strictEqual(p.code, 0, p.all);
      for (const f of ['.claude/skills/release/SKILL.md', 'journal.md', 'runs']) assert.ok(fs.existsSync(path.join(wsRoot, 'release-flow', f)), f);
    });
    it('a new process passes its check', () => assert.strictEqual(wsg(['check', 'release-flow']).code, 0));

    const memory = path.join(tmp, 'rules.md');
    fs.writeFileSync(memory, '# my rules\n');
    wsg(['new', 'with-rules', '--no-launch'], { env: { WSG_GLOBAL_MEMORY: memory } });
    it('an existing WSG_GLOBAL_MEMORY gets an Owner rules section', () =>
      assert.match(fs.readFileSync(path.join(wsRoot, 'with-rules', 'AGENTS.md'), 'utf8'), /## Owner rules[\s\S]*rules\.md/));
  }

  console.log('\nlaunching the agent');
  {
    it('claude gets /wsg-setup as its first message', () => {
      const c = L.launchCommand('claude', '/w/demo');
      assert.strictEqual(c.kind, 'claude');
      assert.deepStrictEqual([c.file, ...c.args], ['/bin/sh', '-c', 'claude "$1"', 'sh', '/wsg-setup']);
    });
    it('claude with flags, a path or an env prefix is still claude', () => {
      for (const a of ['claude --model opus', '/opt/bin/claude', 'CLAUDE_CONFIG_DIR=/x claude', "'claude'"]) assert.strictEqual(L.agentKind(a), 'claude', a);
    });
    it('codex is pointed at SETUP.md', () => {
      const c = L.launchCommand('codex --full-auto', '/w/demo');
      assert.deepStrictEqual(c.args, ['-c', 'codex --full-auto "$1"', 'sh', 'Read SETUP.md and follow it.']);
    });
    it('another agent is not launched, only shown', () => {
      const c = L.launchCommand('gemini --yolo', '/w/my demo');
      assert.strictEqual(c.file, undefined);
      assert.strictEqual(c.display, "cd '/w/my demo' && gemini --yolo");
    });
    it('no launch without a terminal, or with WSG_NO_LAUNCH, or with --no-launch', () => {
      const tty = { isTTY: true };
      assert.strictEqual(L.shouldLaunch({ env: {}, stdin: tty, stdout: tty }), true);
      assert.strictEqual(L.shouldLaunch({ env: {}, stdin: {}, stdout: tty }), false);
      assert.strictEqual(L.shouldLaunch({ env: { WSG_NO_LAUNCH: '1' }, stdin: tty, stdout: tty }), false);
      assert.strictEqual(L.shouldLaunch({ noLaunch: true, env: {}, stdin: tty, stdout: tty }), false);
    });
    it('the agent is WSG_AGENT, else claude when it is on PATH', () => {
      assert.strictEqual(L.resolveAgent({ WSG_AGENT: 'codex' }, { PATH: fakeBin }), 'codex');
      assert.strictEqual(L.resolveAgent({}, { PATH: fakeBin }), 'claude');
      assert.strictEqual(L.resolveAgent({}, { PATH: path.join(tmp, 'nowhere') }), '');
    });
    const piped = wsg(['new', 'piped'], { env: { WSG_NO_LAUNCH: '' } });
    it('without a terminal wsg new does not start the agent', () => {
      assert.strictEqual(piped.code, 0, piped.all);
      assert.ok(!fs.existsSync(launched));
    });
    it('and says how to start it', () => assert.match(piped.out, /&& claude "\/wsg-setup"/));
    const other = wsg(['new', 'other-agent'], { env: { WSG_AGENT: 'gemini --yolo' } });
    it('another agent gets the SETUP.md hint', () => assert.match(other.out, /&& gemini --yolo\n\s+and tell the agent: Read SETUP\.md/));
    // A real terminal: script(1) gives the child one. Its flags differ between BSD and util-linux,
    // and it needs a stdin it can read from (a pipe fails its tcgetattr): /dev/null will do.
    if (os.platform() === 'darwin') {
      spawnSync('script', ['-q', '/dev/null', process.execPath, CLI, 'new', 'in-tty'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...ENV, WSG_NO_LAUNCH: '' }, timeout: 20000 });
      it('in a terminal claude is started in the workspace with /wsg-setup', () => {
        const [cwd, ...args] = fs.readFileSync(launched, 'utf8').trim().split('\n');
        assert.strictEqual(fs.realpathSync(cwd), path.join(wsRoot, 'in-tty'));
        assert.deepStrictEqual(args, ['/wsg-setup']);
      });
    }
  }

  console.log('\nwsg add: what is decided before anything is touched');
  const dry = (args, cwd = demo) => {
    const r = wsg(['add', ...args, '--dry-run'], { cwd });
    let plan = null;
    try { plan = JSON.parse(r.out); } catch { /* reported below */ }
    return { ...r, plan };
  };
  {
    const before = tree(demo);
    const d = dry([api, '--branch', 'feat/oauth', '--verify', 'npm test']);
    it('--dry-run prints valid JSON', () => assert.ok(d.plan, d.all));
    it('a repository root is a worktree by default', () => assert.strictEqual(d.plan.mode, 'worktree'));
    it('the plan has the git defaults', () => {
      assert.strictEqual(d.plan.target, 'main');
      assert.strictEqual(d.plan.base, 'main');
      assert.strictEqual(d.plan.branchExists, false);
    });
    it('the plan lists carry candidates and node_modules', () => {
      assert.deepStrictEqual(d.plan.carryCandidates.sort(), ['.env', 'local.pem']);
      assert.deepStrictEqual(d.plan.carry.sort(), ['.env', 'local.pem']);
      assert.deepStrictEqual(d.plan.nodeModules, { inMainCheckout: false, clone: false });
    });
    it('the plan lists the files to write', () => {
      for (const f of ['api', '.claude/rules/api.md', 'AGENTS.md', 'CLAUDE.md', 'README.md', '.claude/wsg.json', 'mr-target-branch.txt', 'repo']) {
        assert.ok(d.plan.files.includes(f), f);
      }
    });
    it('a worktree does not touch settings.json', () => assert.strictEqual(d.plan.settingsChanged, false));
    it('--dry-run touches nothing', () => assert.deepStrictEqual(tree(demo), before));
    it('--dry-run creates no branch', () => assert.ok(!branches(api).includes('feat/oauth')));
    const sub = dry([path.join(api, 'pkg')]);
    it('a subdirectory of a repository is a link', () => {
      assert.strictEqual(sub.plan.mode, 'link');
      assert.match(sub.plan.warnings.join('\n'), /part of the git repository/);
    });
    it('and its directory goes to settings.json', () => assert.strictEqual(sub.plan.settingsChanged, true));
    it('a carry list picks files', () => assert.deepStrictEqual(dry([api, '--branch', 'b1', '--carry', '.env']).plan.carry, ['.env']));
    it('--carry none copies nothing', () => assert.deepStrictEqual(dry([api, '--branch', 'b1', '--carry', 'none']).plan.carry, []));
    it('an explicit base is kept', () => assert.strictEqual(dry([api, '--branch', 'b1', '--base', 'HEAD']).plan.base, 'HEAD'));

    git(api, ['branch', 'feature/existing']);
    git(api, ['branch', 'a/b']);
    const rejected = [
      ['--worktree on a subdirectory', [path.join(api, 'pkg'), '--worktree'], /worktree is always of the whole repository: give its root/],
      ['a directory outside git without --reference', [docs], /not under git/],
      ['--reference on a repository', [api, '--reference'], /--reference is for directories outside git/],
      ['a worktree without --branch', [api], /needs a task branch/],
      ['a bad branch name', [api, '--branch', 'feat x'], /not a valid branch name/],
      ['a branch busy in another worktree', [api, '--branch', 'main'], /already checked out/],
      ['a ref-path conflict', [api, '--branch', 'a/b/c'], /conflicts with existing branch a\/b/],
      ['--base for an existing branch kept as is', [api, '--branch', 'feature/existing', '--base', 'main'], /--base applies only to a new branch/],
      ['--reset-to-base for a branch that does not exist', [api, '--branch', 'b4', '--reset-to-base'], /--reset-to-base applies to an existing branch/],
      ['the removed --reuse-branch', [api, '--branch', 'feature/existing', '--reuse-branch'], /unknown argument: --reuse-branch/],
      ['a base that does not resolve', [api, '--branch', 'b2', '--base', 'origin/nope'], /ref origin\/nope not found/],
      ['an unknown carry entry', [api, '--branch', 'b3', '--carry', '.env,secret.key'], /secret\.key is not among/],
      ['--branch on a link', [api, '--link', '--branch', 'x'], /--branch applies only to a worktree/],
      ['--no-clone-node-modules on a link, named as given', [api, '--link', '--no-clone-node-modules'], /--no-clone-node-modules applies only to a worktree/],
      ['a missing path', [path.join(tmp, 'nope')], /does not exist/],
      ['a reserved name', [path.join(tmp, 'reserved', 'notes.md'), '--reference'], /can't be named notes\.md/],
    ];
    fs.mkdirSync(path.join(tmp, 'reserved', 'notes.md'), { recursive: true });
    for (const [name, args, msg] of rejected) {
      const r = wsg(['add', ...args], { cwd: demo });
      it(`${name}: exit 2`, () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.match(r.err, msg);
      });
    }
    const dang = path.join(tmp, 'dangling');
    fs.symlinkSync(path.join(tmp, 'unmounted-drive'), dang);
    it('a dangling symlink is reported as missing', () => assert.match(wsg(['add', dang, '--reference'], { cwd: demo }).err, /does not exist/));
    it('two modes at once: exit 2', () => assert.strictEqual(wsg(['add', api, '--link', '--worktree'], { cwd: demo }).code, 2));
    it('an unknown flag: exit 2', () => assert.strictEqual(wsg(['add', api, '--brnch', 'x'], { cwd: demo }).code, 2));
    const de = dry([api, '--branch', 'a/b/c']);
    it('--dry-run reports errors as JSON too, with exit 2', () => {
      assert.strictEqual(de.code, 2);
      assert.match(de.plan.errors.join('\n'), /conflicts/);
      assert.deepStrictEqual(de.plan.files, []);
    });
    it('rejected adds touched nothing', () => assert.deepStrictEqual(tree(demo), before));
    it('and made no branch', () => assert.deepStrictEqual(branches(api).sort(), ['a/b', 'feature/existing', 'main']));

    const outside = wsg(['add', api, '--branch', 'x'], { cwd: tmp });
    it('outside a workspace: exit 2 with a hint', () => {
      assert.strictEqual(outside.code, 2);
      assert.match(outside.err, /--ws/);
    });
    const legacy = path.join(wsRoot, 'old-one');
    fs.mkdirSync(path.join(legacy, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(legacy, '.claude', 'ws-kind'), 'task\n');
    fs.writeFileSync(path.join(legacy, 'CLAUDE.md'), '# old\n');
    const old1 = wsg(['add', api, '--branch', 'x'], { cwd: legacy });
    const old2 = wsg(['add', api, '--branch', 'x', '--ws', 'old-one']);
    it('a 0.1 workspace is refused, from inside and by --ws', () => {
      for (const r of [old1, old2]) {
        assert.strictEqual(r.code, 2);
        assert.match(r.err, /created by wsg 0\.1/);
      }
    });
    it('and left as it was', () => assert.deepStrictEqual(fs.readdirSync(legacy).sort(), ['.claude', 'CLAUDE.md']));
  }

  console.log('\nwsg add: attaching');
  {
    // Prose the agent writes during setup, and a setting the owner adds by hand.
    const agentsFile = path.join(demo, 'AGENTS.md');
    const why = 'Users are logged out every hour: the refresh token is not renewed.';
    fs.writeFileSync(agentsFile, fs.readFileSync(agentsFile, 'utf8')
      .replace(/FILL IN: what problem this task solves.*\n/, `${why}\n`)
      .replace(/Starting state: FILL IN.*\n/, 'Starting state: updating existing work, not a new feature.\n'));
    const settingsFile = path.join(demo, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.model = 'opus';
    settings.permissions.allow.push('Bash(npm test)');
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');

    const first = wsg(['add', api, '--branch', 'feat/oauth', '--verify', 'npm test', '--carry', '.env'], { cwd: path.join(demo, '.claude') });
    it('a worktree is attached from anywhere inside the workspace', () => assert.strictEqual(first.code, 0, first.all));
    it('on the task branch', () => assert.strictEqual(git(path.join(demo, 'api'), ['branch', '--show-current']), 'feat/oauth'));
    it('with the chosen file copied', () => {
      assert.ok(fs.existsSync(path.join(demo, 'api', '.env')));
      assert.ok(!fs.existsSync(path.join(demo, 'api', 'local.pem')));
    });
    it('the repo pointer and the MR target', () => {
      assert.strictEqual(fs.readlinkSync(path.join(demo, 'repo')), 'api');
      assert.strictEqual(fs.readFileSync(path.join(demo, 'mr-target-branch.txt'), 'utf8'), 'main\n');
    });
    it('the rule for the repository', () => assert.match(fs.readFileSync(path.join(demo, '.claude/rules/api.md'), 'utf8'), /Task branch: `feat\/oauth`/));
    const claude = fs.readFileSync(path.join(demo, 'CLAUDE.md'), 'utf8');
    it("the repository's AGENTS.md is imported inside the block", () => assert.match(claude, /<!-- wsg:imports -->\n@api\/AGENTS\.md\n<!-- \/wsg:imports -->/));
    let agents = fs.readFileSync(agentsFile, 'utf8');
    it('Layout and Verification are rendered', () => {
      assert.match(agents, /<!-- wsg:layout -->\n- `api\/` — git worktree, branch `feat\/oauth`, target `main`\.\n  Repository rules — `api\/AGENTS\.md`/);
      assert.match(agents, /<!-- wsg:verification -->\n- api: `npm test`\n<!-- \/wsg:verification -->/);
    });
    it('the state records the source', () => {
      const st = W.readState(demo);
      assert.strictEqual(st.sources.length, 1);
      assert.deepStrictEqual(st.sources[0].carry, ['.env']);
    });

    const second = wsg(['add', web, '--link', '--verify', 'make test']);
    it('a second source: exit 2 outside the workspace, without --ws', () => assert.strictEqual(second.code, 2));
    const linked = wsg(['add', web, '--link', '--verify', 'make test', '--ws', 'demo']);
    it('a link by --ws', () => assert.strictEqual(linked.code, 0, linked.all));
    it('says a restart is needed: settings.json changed', () => assert.match(linked.out, /settings\.json changed: restart/));
    agents = fs.readFileSync(agentsFile, 'utf8');
    it('the re-rendered blocks list both sources', () => {
      assert.match(agents, /- `api\/` — git worktree[\s\S]*- `web` — symlink to the shared checkout/);
      assert.match(agents, /- api: `npm test`\n- web: `make test`/);
    });
    it('text written outside the markers survives', () => {
      assert.match(agents, new RegExp(`## Why\\n\\n${why}`));
      assert.match(agents, /Starting state: updating existing work/);
    });
    const s2 = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    it("the owner's settings survive, the directory is added", () => {
      assert.strictEqual(s2.model, 'opus');
      assert.ok(s2.permissions.allow.includes('Bash(npm test)'));
      assert.deepStrictEqual(s2.permissions.additionalDirectories, [web]);
    });
    it('the pointer stays on the worktree', () => assert.strictEqual(fs.readlinkSync(path.join(demo, 'repo')), 'api'));
    it('a duplicate path is refused', () => assert.match(wsg(['add', web, '--link'], { cwd: demo }).err, /already attached as web/));

    const ref = wsg(['add', docs, '--reference', '--note', 'product briefs'], { cwd: demo });
    it('a reference directory', () => assert.strictEqual(ref.code, 0, ref.all));
    const rule = fs.readFileSync(path.join(demo, '.claude/rules/docs.md'), 'utf8');
    it('its wording does not promise read-only', () => {
      assert.match(rule, /Reference directory outside git/);
      assert.doesNotMatch(rule + fs.readFileSync(agentsFile, 'utf8'), /read-only|read only/i);
    });
    it('README lists it as a reference', () => assert.match(fs.readFileSync(path.join(demo, 'README.md'), 'utf8'), /\| `docs` \| reference \| — \| product briefs \|/));

    fs.writeFileSync(agentsFile, fs.readFileSync(agentsFile, 'utf8').replace(/FILL IN: deliberate[^\n]*\n[^\n]*\n/, 'None recorded yet.\n'));
    const c = wsg(['check'], { cwd: path.join(demo, 'api') });
    it('wsg check finds the workspace from inside a worktree', () => assert.match(c.out, new RegExp(`Checking workspace: ${demo}\\n`)));
    it('a set-up workspace: no setup warning', () => {
      assert.strictEqual(c.code, 0, c.out);
      assert.match(c.out, /OK   setup finished: 2 git repositories attached/);
    });
  }

  console.log('\nwsg add: branches that already exist');
  {
    // A repository with a remote: an open MR's branch lives on origin, maybe locally too.
    const svc = makeRepo('svc');
    const bare = path.join(tmp, 'svc-origin.git');
    git(tmp, ['init', '-q', '--bare', bare]);
    git(svc, ['remote', 'add', 'origin', bare]);
    git(svc, ['push', '-q', 'origin', 'main']);
    // Commits without a checkout: the main checkout stays on main.
    const commit = (parent, msg) => git(svc, ['commit-tree', '-p', parent, '-m', msg, `${parent}^{tree}`]);
    const setRef = (b, sha) => git(svc, ['update-ref', `refs/heads/${b}`, sha]);
    const tipOf = (ref) => git(svc, ['rev-parse', ref]);
    const ws = (slug) => { wsg(['new', slug, '--no-launch']); return path.join(wsRoot, slug); };
    const dryIn = (dir, args) => { const r = wsg(['add', svc, ...args, '--dry-run'], { cwd: dir }); return { ...r, plan: JSON.parse(r.out) }; };
    const drop = (dir) => execFileSync('git', ['-C', svc, 'worktree', 'remove', '--force', path.join(dir, 'svc')]);

    // A local branch with its own commit: attached as it is.
    const own = commit('main', 'local work');
    setRef('feature/local', own);
    const wl = ws('br-local');
    const dl = dryIn(wl, ['--branch', 'feature/local']);
    it('an existing local branch is attached as is by default', () => {
      assert.strictEqual(dl.code, 0, dl.all);
      assert.strictEqual(dl.plan.start, 'attach');
      assert.strictEqual(dl.plan.branchExists, true);
    });
    const al = wsg(['add', svc, '--branch', 'feature/local'], { cwd: wl });
    it('its commits are kept: the branch does not move', () => {
      assert.strictEqual(al.code, 0, al.all);
      assert.strictEqual(tipOf('feature/local'), own);
      assert.strictEqual(git(path.join(wl, 'svc'), ['rev-parse', 'HEAD']), own);
    });
    it('no backup is made', () => assert.ok(!branches(svc).some((b) => b.startsWith('backup/'))));
    drop(wl);

    // Local and origin went different ways: reported, never merged.
    const pushed = commit('main', 'pushed');
    setRef('feature/both', pushed);
    git(svc, ['push', '-q', 'origin', 'feature/both']);
    const local = commit('main', 'local only');
    setRef('feature/both', local);
    const db = dryIn(ws('br-both'), ['--branch', 'feature/both']);
    it('a diverged branch is attached as is, with the counts', () => {
      assert.strictEqual(db.code, 0, db.all);
      assert.strictEqual(db.plan.start, 'attach');
      assert.match(db.plan.warnings.join('\n'), /feature\/both and origin\/feature\/both differ: 1 commits only here, 1 only on origin/);
    });

    // Only on origin: the local branch continues it.
    const remote = commit('main', 'remote work');
    setRef('feature/remote', remote);
    git(svc, ['push', '-q', 'origin', 'feature/remote']);
    git(svc, ['branch', '-D', 'feature/remote']);
    const wr = ws('br-remote');
    const dr = dryIn(wr, ['--branch', 'feature/remote']);
    it('a remote-only branch is continued', () => {
      assert.strictEqual(dr.code, 0, dr.all);
      assert.strictEqual(dr.plan.start, 'continue');
      assert.strictEqual(dr.plan.remoteBranch, 'origin/feature/remote');
      assert.strictEqual(dr.plan.base, 'origin/feature/remote');
      assert.match(dr.plan.notes.join('\n'), /continuing origin\/feature\/remote/);
    });
    const ar = wsg(['add', svc, '--branch', 'feature/remote'], { cwd: wr });
    it('the local branch starts at origin and tracks it', () => {
      assert.strictEqual(ar.code, 0, ar.all);
      assert.match(ar.out, /continuing origin\/feature\/remote/);
      assert.strictEqual(tipOf('feature/remote'), remote);
      assert.strictEqual(git(svc, ['config', '--get', 'branch.feature/remote.merge']), 'refs/heads/feature/remote');
    });
    drop(wr);
    git(svc, ['branch', '-D', 'feature/remote']);
    const wr2 = ws('br-remote-2');
    const other = dryIn(wr2, ['--branch', 'feature/remote', '--base', 'main']);
    it('another --base for a remote branch is refused', () => {
      assert.strictEqual(other.code, 2);
      assert.deepStrictEqual(other.plan.errors.length, 1);
      assert.match(other.plan.errors[0], /origin\/feature\/remote exists/);
    });
    const over = dryIn(wr2, ['--branch', 'feature/remote', '--base', 'main', '--reset-to-base']);
    it('unless --reset-to-base: a new branch, with a warning', () => {
      assert.strictEqual(over.code, 0, over.all);
      assert.strictEqual(over.plan.start, 'new');
      assert.match(over.plan.warnings.join('\n'), /commits of origin\/feature\/remote are not included/);
    });

    // --reset-to-base on a local branch: the old head goes to backup/, the branch to the base.
    const wx = ws('br-reset');
    const ax = wsg(['add', svc, '--branch', 'feature/local', '--reset-to-base', '--base', 'main'], { cwd: wx });
    it('--reset-to-base resets an existing branch', () => {
      assert.strictEqual(ax.code, 0, ax.all);
      assert.strictEqual(tipOf('feature/local'), tipOf('main'));
    });
    it('after saving its head in backup/', () => {
      const bk = branches(svc).find((b) => b.startsWith('backup/feature-local-'));
      assert.ok(bk, branches(svc).join(' '));
      assert.strictEqual(tipOf(bk), own);
    });
    drop(wx);
  }

  console.log('\nwsg add: a failure rolls back only this source');
  {
    const before = tree(demo);
    const beforeBranches = branches(web);
    const beforeWorktrees = worktrees(web);
    // A README.md that can't be written: the worktree and the rule are made first, then the render fails.
    const web2 = makeRepo('web2');
    fs.chmodSync(path.join(demo, 'README.md'), 0o444);
    const snap = tree(demo);
    const r = wsg(['add', web2, '--branch', 'task/doomed'], { cwd: demo });
    it('the add fails', () => {
      assert.strictEqual(r.code, 1, r.all);
      assert.match(r.err, /Rolling back/);
    });
    it('and does not claim it attached anything', () => assert.doesNotMatch(r.out, /Attached/));
    it('the workspace is exactly as before, byte for byte', () => assert.deepStrictEqual(tree(demo), snap));
    it('no worktree is left registered', () => assert.strictEqual(worktrees(web2), 1));
    it('the created branch is deleted', () => assert.ok(!branches(web2).includes('task/doomed')));
    it('other sources are untouched', () => {
      assert.deepStrictEqual(branches(web), beforeBranches);
      assert.strictEqual(worktrees(web), beforeWorktrees);
    });
    fs.chmodSync(path.join(demo, 'README.md'), 0o644);
    it('and the rest of the workspace is what it was', () => assert.deepStrictEqual(tree(demo), before));
  }

  console.log('\nwsg add: generated parts that were edited by hand');
  {
    const wsM = path.join(wsRoot, 'markers');
    wsg(['new', 'markers', '--no-launch']);
    const settingsFile = path.join(wsM, '.claude', 'settings.json');
    const good = fs.readFileSync(settingsFile, 'utf8');
    fs.writeFileSync(settingsFile, good.replace(/\}\s*$/, ',}'));
    const bad = fs.readFileSync(settingsFile, 'utf8');
    const r1 = wsg(['add', web, '--link'], { cwd: wsM });
    it('settings.json that does not parse refuses the add', () => {
      assert.strictEqual(r1.code, 2);
      assert.match(r1.err, /settings\.json is not valid JSON/);
    });
    it('and is not overwritten', () => assert.strictEqual(fs.readFileSync(settingsFile, 'utf8'), bad));
    it('no symlink was made', () => assert.ok(!fs.existsSync(path.join(wsM, 'web'))));
    fs.writeFileSync(settingsFile, good);

    const agentsFile = path.join(wsM, 'AGENTS.md');
    const text = fs.readFileSync(agentsFile, 'utf8');
    fs.writeFileSync(agentsFile, text.replace('<!-- /wsg:layout -->\n', ''));
    const r2 = wsg(['add', web, '--link'], { cwd: wsM });
    it('half a marker pair refuses the add', () => {
      assert.strictEqual(r2.code, 2);
      assert.match(r2.err, /AGENTS\.md: the <!-- wsg:layout --> block has 1 opening and 0 closing markers/);
    });
    fs.writeFileSync(agentsFile, text.replace('<!-- wsg:layout -->\n<!-- /wsg:layout -->\n', ''));
    const r3 = wsg(['add', web, '--link'], { cwd: wsM });
    it('a deleted pair is put back, with a warning', () => {
      assert.strictEqual(r3.code, 0, r3.all);
      assert.match(r3.out, /WARN AGENTS\.md: the <!-- wsg:layout --> markers were missing/);
      assert.match(fs.readFileSync(agentsFile, 'utf8'), /## Layout\n<!-- wsg:layout -->\n- `web` — symlink/);
    });
    // A formatter indented the pair: no second block next to it, a refusal naming the line.
    const flat = fs.readFileSync(agentsFile, 'utf8');
    const shifted = flat.replace(/^(<!-- \/?wsg:layout -->)$/gm, '  $1');
    fs.writeFileSync(agentsFile, shifted);
    const r4 = wsg(['add', docs, '--reference'], { cwd: wsM });
    it('an indented pair refuses the add: exit 2, naming the line', () => {
      assert.strictEqual(r4.code, 2, r4.all);
      const line = shifted.split('\n').indexOf('  <!-- wsg:layout -->') + 1;
      assert.match(r4.err, new RegExp(`AGENTS\\.md: line ${line} holds a <!-- wsg:layout --> marker indented`));
      assert.strictEqual(fs.readFileSync(agentsFile, 'utf8'), shifted);
    });
  }

  console.log('\nthe advisor block');
  {
    const wsA = path.join(wsRoot, 'advisor-block');
    wsg(['new', 'advisor-block', '--no-launch']);
    const agentsFile = path.join(wsA, 'AGENTS.md');
    const text = fs.readFileSync(agentsFile, 'utf8');
    const block = text.match(/^<!-- wsg:advisor -->\n([\s\S]*?)\n<!-- \/wsg:advisor -->$/m);
    it('a new workspace has the advisor block right after the intro line', () => {
      assert.ok(block, text);
      assert.match(text, /^This is a task workspace[^\n]*\n<!-- wsg:advisor -->\n/m);
    });
    it('the rule is one line, imports nothing, and names both ways to the advisor', () => {
      assert.strictEqual(block[1].split('\n').length, 1);
      assert.doesNotMatch(block[1], /@/);
      assert.match(block[1], /wsg-advisor subagent/);
      assert.match(block[1], /`wsg guide advisor`/);
      assert.match(block[1], /never say the advisor ran when it did not/);
    });
    it('it is imperative about when, and about what the owner is shown', () => {
      assert.match(block[1], /^Before you show the owner questions, decisions or a plan with open points, and before you run `wsg add`\/`wsg remove`, send them to the wsg-advisor subagent;/);
      assert.match(block[1], /Show the owner the advisor's FOR THE OWNER block as is, and nothing else from its reply/);
    });
    it('the six owner-rules lines are not part of it', () => assert.doesNotMatch(block[1], /git push|Co-Authored-By/));
    // A workspace from wsg 0.2.0: no block. wsg add brings it in, with news rather than a repair warning.
    const old = text.replace(/<!-- wsg:advisor -->\n[\s\S]*?<!-- \/wsg:advisor -->\n/, '');
    fs.writeFileSync(agentsFile, old);
    const r1 = wsg(['add', web, '--link'], { cwd: wsA });
    const after = fs.readFileSync(agentsFile, 'utf8');
    it('wsg add adds the block to a workspace that lacks it', () => {
      assert.strictEqual(r1.code, 0, r1.all);
      assert.match(after, /^This is a task workspace[^\n]*\n<!-- wsg:advisor -->\n[^\n]+\n<!-- \/wsg:advisor -->\n\n## Why/m);
    });
    it('saying it is new in 0.3.0, not that markers were missing', () => {
      assert.match(r1.out, /AGENTS\.md: added the <!-- wsg:advisor --> block \(new in wsg 0\.3\.0\)/);
      assert.doesNotMatch(r1.out, /wsg:advisor --> markers were missing/);
    });
    it('the rest of AGENTS.md is as it was, apart from the new source', () => {
      const strip = (x) => x.replace(/<!-- wsg:advisor -->\n[\s\S]*?<!-- \/wsg:advisor -->\n/, '').replace(/<!-- wsg:layout -->\n[\s\S]*?<!-- \/wsg:layout -->/, '').replace(/<!-- wsg:verification -->\n[\s\S]*?<!-- \/wsg:verification -->/, '');
      assert.strictEqual(strip(after), strip(old));
    });
    const r2 = wsg(['add', docs, '--reference', '--dry-run'], { cwd: wsA });
    it('once it is there, nothing more is said', () => assert.doesNotMatch(r2.all, /wsg:advisor/));
    fs.writeFileSync(agentsFile, after.replace('<!-- /wsg:advisor -->\n', ''));
    const r3 = wsg(['add', docs, '--reference'], { cwd: wsA });
    it('half an advisor pair refuses the add, like any block', () => {
      assert.strictEqual(r3.code, 2, r3.all);
      assert.match(r3.err, /the <!-- wsg:advisor --> block has 1 opening and 0 closing markers/);
    });
    fs.writeFileSync(agentsFile, after.replace(/^<!-- (\/?)wsg:advisor -->$/gm, '  <!-- $1wsg:advisor -->'));
    const r4 = wsg(['add', docs, '--reference'], { cwd: wsA });
    it('an indented advisor pair refuses the add', () => {
      assert.strictEqual(r4.code, 2, r4.all);
      assert.match(r4.err, /holds a <!-- wsg:advisor --> marker indented/);
    });
    // Without the intro line there is no anchor: the block goes to the end, as for any block.
    fs.writeFileSync(agentsFile, old.replace(/^This is a task workspace.*\n/m, ''));
    const r5 = wsg(['add', docs, '--reference'], { cwd: wsA });
    it('with the intro line gone, the block is added at the end', () => {
      assert.strictEqual(r5.code, 0, r5.all);
      assert.match(fs.readFileSync(agentsFile, 'utf8'), /\n\n<!-- wsg:advisor -->\n[^\n]+\n<!-- \/wsg:advisor -->\n$/);
    });
    const wsP = path.join(wsRoot, 'advisor-proc');
    wsg(['new', 'advisor-proc', '--kind', 'process', '--skill', 'release', '--no-launch']);
    it('a process workspace has it too', () => assert.match(fs.readFileSync(path.join(wsP, 'AGENTS.md'), 'utf8'), /^This is a process workspace[^\n]*\n<!-- wsg:advisor -->\n/m));

    // CLAUDE.md: the same rule in Claude Code's terms, where it decides to delegate.
    const claudeFile = path.join(wsA, 'CLAUDE.md');
    const ctext = fs.readFileSync(claudeFile, 'utf8');
    const cblock = ctext.match(/^<!-- wsg:advisor -->\n([\s\S]*?)\n<!-- \/wsg:advisor -->$/m);
    it('CLAUDE.md of a new workspace has its own advisor block under "Claude Code only"', () => {
      assert.ok(cblock, ctext);
      assert.match(ctext, /^## Claude Code only\n\n<!-- wsg:advisor -->\n[^\n]+\n<!-- \/wsg:advisor -->\n\n- Task memory/m);
    });
    it('one line: call the subagent with a self-contained brief, show only its FOR THE OWNER block', () => {
      assert.strictEqual(cblock[1].split('\n').length, 1);
      assert.doesNotMatch(cblock[1], /@/);
      assert.strictEqual(cblock[1], 'Before you show the owner questions or decisions, call the wsg-advisor subagent (Agent tool) with a self-contained brief; show the owner its FOR THE OWNER block as is, and nothing else from its reply.');
    });
    it('a process workspace has it in CLAUDE.md too', () => assert.match(fs.readFileSync(path.join(wsP, 'CLAUDE.md'), 'utf8'), /^<!-- wsg:advisor -->\n[^\n]+\n<!-- \/wsg:advisor -->$/m));
    // An older CLAUDE.md: no block. wsg add brings it in, under the heading, as news.
    const cold = ctext.replace(/<!-- wsg:advisor -->\n[\s\S]*?<!-- \/wsg:advisor -->\n\n/, '');
    fs.writeFileSync(claudeFile, cold);
    const docs2 = path.join(tmp, 'docs-claude-md');
    fs.mkdirSync(docs2, { recursive: true });
    const c1 = wsg(['add', docs2, '--reference'], { cwd: wsA });
    const cafter = fs.readFileSync(claudeFile, 'utf8');
    it('wsg add adds the CLAUDE.md block, right after the heading', () => {
      assert.strictEqual(c1.code, 0, c1.all);
      assert.match(cafter, /^## Claude Code only\n<!-- wsg:advisor -->\n[^\n]+\n<!-- \/wsg:advisor -->\n/m);
      assert.match(c1.out, /CLAUDE\.md: added the <!-- wsg:advisor --> block \(new in wsg 0\.3\.0\)/);
    });
    it('the rest of CLAUDE.md is as it was', () => {
      assert.strictEqual(cafter.replace(/<!-- wsg:advisor -->\n[\s\S]*?<!-- \/wsg:advisor -->\n/, ''), cold);
    });
    // Without the heading, the block goes to the end.
    fs.writeFileSync(claudeFile, cold.replace(/^## Claude Code only\n/m, ''));
    const c2 = wsg(['refresh'], { cwd: wsA });
    it('with the heading gone, wsg refresh adds it at the end', () => {
      assert.strictEqual(c2.code, 0, c2.all);
      assert.match(fs.readFileSync(claudeFile, 'utf8'), /\n\n<!-- wsg:advisor -->\n[^\n]+\n<!-- \/wsg:advisor -->\n$/);
    });
  }

  console.log('\nwsg check: the advisor');
  {
    const wsC = path.join(wsRoot, 'advisor-check');
    wsg(['new', 'advisor-check', '--no-launch']);
    const S = require(path.join(ROOT, 'lib', 'skills.js'));
    const env = { HOME: home, PATH: fakeBin, CLAUDE_CONFIG_DIR: path.join(tmp, 'check-claude'), CODEX_HOME: path.join(tmp, 'check-codex') };
    const run = (over = {}, c = cfg) => {
      const lines = [];
      const log = console.log;
      console.log = (x) => lines.push(String(x));
      let code;
      try { code = check.run(wsC, c, { ...env, ...over }); } finally { console.log = log; }
      return { code, text: lines.join('\n') };
    };
    const r0 = run();
    it('the workspace rule is there: OK', () => assert.match(r0.text, /OK +AGENTS\.md sends questions for the owner through wsg-advisor/));
    it('claude is the agent and the advisor is not installed: WARN naming install-skills, exit 0', () => {
      assert.strictEqual(r0.code, 0, r0.text);
      assert.match(r0.text, /\nAdvisor\n/);
      assert.match(r0.text, /WARN wsg-advisor for Claude Code is not installed — run wsg install-skills/);
    });
    it('the section comes before the budget', () => assert.ok(r0.text.indexOf('\nAdvisor\n') < r0.text.indexOf('Always-on budget')));
    S.install({ ...env });
    const claudeAgent = path.join(env.CLAUDE_CONFIG_DIR, 'agents', 'wsg-advisor.md');
    const r1 = run();
    it('installed: OK with its path, no WARN', () => {
      assert.match(r1.text, new RegExp(`OK +wsg-advisor for Claude Code: ${claudeAgent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.doesNotMatch(r1.text, /WARN.*advisor/);
    });
    fs.appendFileSync(claudeAgent, 'old\n');
    it('outdated: WARN', () => assert.match(run().text, /WARN .*wsg-advisor\.md is outdated — run wsg install-skills/));
    const gone = path.join(tmp, 'moved-package', 'lib', 'advisor-guard.js');
    fs.writeFileSync(claudeAgent, S.render(S.ITEMS.find((x) => x.name === 'wsg-advisor' && x.root === 'claude'), gone));
    it('its guard is gone (the package moved): WARN that it is broken, naming the path and install-skills', () => {
      const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(run().text, new RegExp(`WARN .*wsg-advisor\\.md is broken: its hook runs ${esc(gone)}, which is not there, so every tool call of the advisor is blocked — run wsg install-skills`));
    });
    it('install-skills repairs it', () => {
      S.install({ ...env });
      assert.doesNotMatch(run().text, /WARN.*advisor/);
    });
    fs.writeFileSync(claudeAgent, S.render(S.ITEMS.find((x) => x.name === 'wsg-advisor' && x.root === 'claude'))
      .replace('<!-- generated by wsg -->\n', `<!-- generated by wsg -->\n${S.tempStamp('test/smoke-claude.sh', 99999)}\n`));
    it('a temporary agent left by a test run: WARN naming install-skills', () => {
      const r = run();
      assert.match(r.text, /WARN .*wsg-advisor\.md is a temporary agent left by a test run — run wsg install-skills or delete it/);
      assert.strictEqual(r.code, 0);
    });
    it('a temporary agent with the user\'s own saved next to it: the WARN names the backup', () => {
      fs.writeFileSync(`${claudeAgent}.wsg-test-backup`, 'mine\n');
      try {
        const r = run();
        assert.ok(r.text.includes(`WARN ${claudeAgent} is a temporary agent left by a test run, and your own agent is saved as ${claudeAgent}.wsg-test-backup — move it back`), r.text);
        assert.strictEqual(r.code, 0);
      } finally {
        fs.rmSync(`${claudeAgent}.wsg-test-backup`);
      }
    });
    it('install-skills replaces it', () => {
      S.install({ ...env });
      assert.doesNotMatch(run().text, /WARN.*advisor/);
    });
    fs.writeFileSync(claudeAgent, '---\nname: wsg-advisor\n---\nmine\n');
    it('someone else\'s file under that name: WARN', () => assert.match(run().text, /WARN .*wsg-advisor\.md was not written by wsg, so it is not wsg's advisor/));
    S.install({ ...env, CLAUDE_CONFIG_DIR: path.join(tmp, 'check-claude-2') });
    it('CLAUDE_CONFIG_DIR is where it is looked for', () => assert.doesNotMatch(run({ CLAUDE_CONFIG_DIR: path.join(tmp, 'check-claude-2') }).text, /WARN.*advisor/));
    it('codex is the agent: the Codex agent is judged instead', () => {
      const r = run({}, { ...cfg, WSG_AGENT: 'codex --yolo' });
      assert.match(r.text, /OK +wsg-advisor for Codex: /);
      fs.rmSync(path.join(env.CODEX_HOME, 'agents', 'wsg-advisor.toml'));
      assert.match(run({}, { ...cfg, WSG_AGENT: 'codex' }).text, /WARN wsg-advisor for Codex is not installed — run wsg install-skills/);
      S.install({ ...env });
    });
    it('codex is the agent but Codex is not there: WARN that it was not found, not "run install-skills"', () => {
      const r = run({ CODEX_HOME: undefined, HOME: path.join(tmp, 'nobody'), PATH: '' }, { ...cfg, WSG_AGENT: 'codex' });
      assert.match(r.text, /WARN Codex not found \(no CODEX_HOME, ~\/\.codex or codex on PATH\) — the Codex advisor is not installed/);
      assert.doesNotMatch(r.text, /install-skills/);
    });
    it('another agent: no WARN, it follows the guide inline', () => {
      const r = run({}, { ...cfg, WSG_AGENT: 'gemini' });
      assert.match(r.text, /gemini has no wsg-advisor agent: it follows wsg guide advisor inline/);
      assert.doesNotMatch(r.text, /WARN.*advisor/);
    });
    it('no agent at all: not judged', () => {
      const r = run({ PATH: '' });
      assert.match(r.text, /no agent configured/);
      assert.doesNotMatch(r.text, /WARN.*advisor/);
    });
    it('the machine\'s own PATH and config are not read', () => assert.doesNotMatch(run({ PATH: '', HOME: path.join(tmp, 'nobody') }).text, /WARN.*advisor|Claude Code:/));
    const shadow = path.join(wsC, '.claude', 'agents', 'wsg-advisor.md');
    fs.writeFileSync(shadow, '---\nname: wsg-advisor\n---\nlocal\n');
    it('a project-level wsg-advisor shadows the installed one: WARN', () => assert.match(run().text, /WARN \.claude\/agents\/wsg-advisor\.md shadows the wsg-advisor agent/));
    fs.rmSync(shadow);
    const codexShadow = path.join(wsC, '.codex', 'agents', 'wsg-advisor.toml');
    fs.mkdirSync(path.dirname(codexShadow), { recursive: true });
    fs.writeFileSync(codexShadow, 'name = "wsg-advisor"\n');
    it('a project-level Codex wsg-advisor shadows the installed one: WARN', () => assert.match(run().text, /WARN \.codex\/agents\/wsg-advisor\.toml shadows the wsg-advisor agent/));
    fs.rmSync(path.join(wsC, '.codex'), { recursive: true });
    // In a directory above the workspace too; the user-level file itself is not a shadow.
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const [dir, rel] of [['.claude', 'wsg-advisor.md'], ['.codex', 'wsg-advisor.toml']]) {
      const above = path.join(wsRoot, dir, 'agents', rel);
      fs.mkdirSync(path.dirname(above), { recursive: true });
      fs.writeFileSync(above, 'local\n');
      it(`${dir}/agents/${rel} in a directory above the workspace: WARN with its path`, () => assert.match(run().text, new RegExp(`WARN ${esc(above)} shadows the wsg-advisor agent`)));
      it(`but not when it is the user-level ${dir} itself`, () => {
        const r = run({ CLAUDE_CONFIG_DIR: path.join(wsRoot, '.claude'), CODEX_HOME: path.join(wsRoot, '.codex') });
        assert.doesNotMatch(r.text, /shadows/);
      });
      fs.rmSync(path.join(wsRoot, dir), { recursive: true });
    }
    it('CLAUDE.md has the advisor block: OK', () => assert.match(run().text, /OK +CLAUDE\.md tells Claude Code to call wsg-advisor before it asks the owner/));
    const claudeFile = path.join(wsC, 'CLAUDE.md');
    const ctext = fs.readFileSync(claudeFile, 'utf8');
    fs.writeFileSync(claudeFile, ctext.replace(/<!-- wsg:advisor -->\n[\s\S]*?<!-- \/wsg:advisor -->\n/, ''));
    const rc = run();
    it('CLAUDE.md without it, claude the agent: WARN naming wsg refresh, exit 0', () => {
      assert.strictEqual(rc.code, 0, rc.text);
      assert.match(rc.text, /WARN CLAUDE\.md has no <!-- wsg:advisor --> block: Claude Code is less likely to call the advisor — run wsg refresh/);
    });
    it('codex or another agent: CLAUDE.md is not judged for it', () => {
      assert.doesNotMatch(run({}, { ...cfg, WSG_AGENT: 'codex' }).text, /CLAUDE\.md .*wsg:advisor|CLAUDE\.md tells/);
      assert.doesNotMatch(run({}, { ...cfg, WSG_AGENT: 'gemini' }).text, /CLAUDE\.md .*wsg:advisor|CLAUDE\.md tells/);
    });
    fs.writeFileSync(claudeFile, ctext.replace(/(<!-- wsg:advisor -->\n[\s\S]*?<!-- \/wsg:advisor -->\n)/, '```\n$1```\n'));
    it('a CLAUDE.md block only inside a code fence does not count', () => assert.match(run().text, /WARN CLAUDE\.md has no <!-- wsg:advisor --> block/));
    fs.writeFileSync(claudeFile, ctext.replace(/<!-- wsg:advisor -->\n[\s\S]*?<!-- \/wsg:advisor -->\n/, ''));
    fs.renameSync(path.join(wsC, '.claude', 'wsg.json'), path.join(wsC, '.claude', 'wsg.json.off'));
    it('a 0.1 workspace gets no CLAUDE.md advisor finding', () => assert.doesNotMatch(run().text, /CLAUDE\.md .*wsg:advisor/));
    fs.renameSync(path.join(wsC, '.claude', 'wsg.json.off'), path.join(wsC, '.claude', 'wsg.json'));
    fs.writeFileSync(claudeFile, ctext);
    const agentsFile = path.join(wsC, 'AGENTS.md');
    const text = fs.readFileSync(agentsFile, 'utf8');
    fs.writeFileSync(agentsFile, text.replace(/<!-- wsg:advisor -->\n[\s\S]*?<!-- \/wsg:advisor -->\n/, ''));
    const r2 = run();
    it('no advisor block: WARN naming wsg refresh, exit 0', () => {
      assert.strictEqual(r2.code, 0, r2.text);
      assert.match(r2.text, /WARN AGENTS\.md has no <!-- wsg:advisor --> block: .* run wsg refresh/);
    });
    fs.writeFileSync(agentsFile, text.replace(/(<!-- wsg:advisor -->\n[\s\S]*?<!-- \/wsg:advisor -->\n)/, '```\n$1```\n'));
    it('a block only inside a code fence does not count', () => assert.match(run().text, /WARN AGENTS\.md has no <!-- wsg:advisor --> block/));
    fs.writeFileSync(agentsFile, text);
    // A workspace without the state file is judged as before: no advisor findings at all.
    fs.renameSync(path.join(wsC, '.claude', 'wsg.json'), path.join(wsC, '.claude', 'wsg.json.off'));
    it('a 0.1 workspace gets no advisor findings', () => assert.doesNotMatch(run().text, /wsg-advisor|\nAdvisor\n/));
    fs.renameSync(path.join(wsC, '.claude', 'wsg.json.off'), path.join(wsC, '.claude', 'wsg.json'));
  }

  console.log('\nwsg refresh');
  {
    const wsR = path.join(wsRoot, 'refresh');
    wsg(['new', 'refresh', '--no-launch']);
    wsg(['add', web, '--link'], { cwd: wsR });
    const agentsFile = path.join(wsR, 'AGENTS.md');
    const current = fs.readFileSync(agentsFile, 'utf8');
    const before = tree(wsR);
    const r0 = wsg(['refresh'], { cwd: wsR });
    it('an up-to-date workspace: nothing to do, exit 0', () => {
      assert.strictEqual(r0.code, 0, r0.all);
      assert.match(r0.out, /up to date/);
      assert.deepStrictEqual(tree(wsR), before);
    });
    // As a 0.2.0 workspace: no advisor block, and an owner's note outside the markers.
    const old = current.replace(/<!-- wsg:advisor -->\n[\s\S]*?<!-- \/wsg:advisor -->\n/, '').replace('## Code map', 'Owner note.\n\n## Code map');
    fs.writeFileSync(agentsFile, old);
    const oldTree = tree(wsR);
    const d1 = wsg(['refresh', '--dry-run'], { cwd: wsR });
    let plan = null;
    try { plan = JSON.parse(d1.out); } catch { /* reported below */ }
    it('--dry-run lists the files it would change, as JSON, touching nothing', () => {
      assert.strictEqual(d1.code, 0, d1.all);
      assert.deepStrictEqual(plan.files, ['AGENTS.md']);
      assert.strictEqual(plan.workspace, wsR);
      assert.ok(plan.warnings.some((w) => /added the <!-- wsg:advisor --> block/.test(w)), JSON.stringify(plan.warnings));
      assert.deepStrictEqual(tree(wsR), oldTree);
    });
    const r1 = wsg(['refresh'], { cwd: wsR });
    it('wsg refresh adds the block, and says which files it updated', () => {
      assert.strictEqual(r1.code, 0, r1.all);
      assert.match(r1.out, /added the <!-- wsg:advisor --> block \(new in wsg 0\.3\.0\)/);
      assert.match(r1.out, /Updated: AGENTS\.md/);
    });
    it('and changes nothing else', () => {
      assert.strictEqual(fs.readFileSync(agentsFile, 'utf8'), current.replace('## Code map', 'Owner note.\n\n## Code map'));
      const now = tree(wsR);
      delete now['AGENTS.md'];
      delete oldTree['AGENTS.md'];
      assert.deepStrictEqual(now, oldTree);
    });
    it('the lock is released', () => assert.ok(!fs.existsSync(path.join(wsR, '.claude', 'wsg.lock'))));
    it('--ws names the workspace from outside', () => {
      const r = wsg(['refresh', '--ws', 'refresh']);
      assert.strictEqual(r.code, 0, r.all);
      assert.match(r.out, /up to date/);
    });
    fs.writeFileSync(agentsFile, current.replace('<!-- /wsg:layout -->\n', ''));
    const broken = fs.readFileSync(agentsFile, 'utf8');
    const r2 = wsg(['refresh'], { cwd: wsR });
    it('a broken pair refuses it: exit 2, nothing changed', () => {
      assert.strictEqual(r2.code, 2, r2.all);
      assert.match(r2.err, /wsg:layout --> block has 1 opening and 0 closing markers/);
      assert.strictEqual(fs.readFileSync(agentsFile, 'utf8'), broken);
    });
    const d2 = wsg(['refresh', '--dry-run'], { cwd: wsR });
    it('and its dry run reports the error: exit 2', () => {
      assert.strictEqual(d2.code, 2, d2.all);
      assert.match(JSON.parse(d2.out).errors[0], /1 opening and 0 closing/);
    });
    fs.writeFileSync(agentsFile, current);
    // settings.json that lost a linked directory: put back, with the restart notice.
    const settingsFile = path.join(wsR, '.claude', 'settings.json');
    const sj = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    delete sj.permissions.additionalDirectories;
    fs.writeFileSync(settingsFile, `${JSON.stringify(sj, null, 2)}\n`);
    const r3 = wsg(['refresh'], { cwd: wsR });
    it('a linked directory missing from settings.json is put back, with the restart notice', () => {
      assert.strictEqual(r3.code, 0, r3.all);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).permissions.additionalDirectories, [web]);
      assert.match(r3.out, /restart the agent session/);
    });
    it('outside a workspace: exit 2', () => assert.strictEqual(wsg(['refresh']).code, 2));
    it('an unknown flag: exit 2', () => assert.strictEqual(wsg(['refresh', '--force'], { cwd: wsR }).code, 2));
    it('an extra argument: exit 2', () => assert.strictEqual(wsg(['refresh', 'x'], { cwd: wsR }).code, 2));
    // A 0.1 workspace has no state to render from.
    const legacy = path.join(wsRoot, 'legacy-refresh');
    fs.mkdirSync(path.join(legacy, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(legacy, '.claude', 'ws-kind'), 'task\n');
    fs.writeFileSync(path.join(legacy, 'AGENTS.md'), '# old\n');
    const r4 = wsg(['refresh', '--ws', legacy]);
    it('a 0.1 workspace is refused: exit 2, untouched', () => {
      assert.strictEqual(r4.code, 2, r4.all);
      assert.match(r4.err, /created by wsg 0\.1/);
      assert.strictEqual(fs.readFileSync(path.join(legacy, 'AGENTS.md'), 'utf8'), '# old\n');
    });
    it('the usage names it', () => assert.match(wsg(['--help']).out, /wsg refresh \[--dry-run\] \[--ws SLUG\|PATH\]/));
  }

  console.log('\nwsg add: writes stay inside the workspace');
  {
    const wsS = path.join(wsRoot, 'safe');
    wsg(['new', 'safe', '--no-launch']);
    const add = (args) => wsg(['add', ...args], { cwd: wsS });
    const outside = path.join(tmp, 'outside-rules');
    fs.mkdirSync(outside);
    const rules = path.join(wsS, '.claude', 'rules');
    fs.rmdirSync(rules);
    fs.symlinkSync(outside, rules);
    const r1 = add([web, '--link']);
    it('a symlinked directory on the way refuses the add', () => {
      assert.strictEqual(r1.code, 2, r1.all);
      assert.match(r1.err, /\.claude\/rules .*symlink/);
    });
    it('nothing is written behind it', () => assert.deepStrictEqual(fs.readdirSync(outside), []));
    it('and no source is attached', () => assert.ok(!fs.existsSync(path.join(wsS, 'web'))));
    fs.unlinkSync(rules);
    fs.mkdirSync(rules);

    const foreign = path.join(tmp, 'foreign-AGENTS.md');
    fs.writeFileSync(foreign, '# not yours\n<!-- wsg:layout -->\n<!-- /wsg:layout -->\n');
    const agentsFile = path.join(wsS, 'AGENTS.md');
    const agentsText = fs.readFileSync(agentsFile, 'utf8');
    fs.renameSync(agentsFile, agentsFile + '.bak');
    fs.symlinkSync(foreign, agentsFile);
    const r2 = add([web, '--link']);
    it('a symlinked AGENTS.md refuses the add', () => assert.strictEqual(r2.code, 2, r2.all));
    it('the file behind it is untouched', () => assert.strictEqual(fs.readFileSync(foreign, 'utf8'), '# not yours\n<!-- wsg:layout -->\n<!-- /wsg:layout -->\n'));
    fs.unlinkSync(agentsFile);
    fs.renameSync(agentsFile + '.bak', agentsFile);

    fs.writeFileSync(path.join(rules, 'web.md'), '# my notes about web\n');
    const r3 = add([web, '--link']);
    it('a rule file wsg did not write is refused, not overwritten', () => {
      assert.strictEqual(r3.code, 2, r3.all);
      assert.match(r3.err, /\.claude\/rules\/web\.md exists/);
      assert.strictEqual(fs.readFileSync(path.join(rules, 'web.md'), 'utf8'), '# my notes about web\n');
    });
    fs.unlinkSync(path.join(rules, 'web.md'));
    const r4 = add([web, '--link']);
    it('the rule wsg writes is marked as its own', () => {
      assert.strictEqual(r4.code, 0, r4.all);
      assert.match(fs.readFileSync(path.join(rules, 'web.md'), 'utf8'), /^---\n# generated by wsg/);
    });

    const self = [
      ['the workspace itself', wsS],
      ['a directory inside it', path.join(wsS, 'scratch')],
      ['a directory containing it', wsRoot],
    ];
    fs.mkdirSync(path.join(wsS, 'scratch'));
    // On a case-insensitive file system (APFS by default) SAFE is the same directory as safe.
    const recased = path.join(path.dirname(wsS), path.basename(wsS).toUpperCase());
    if (fs.existsSync(recased)) self.push(['the workspace itself in other case', recased]);
    else console.log('  skip  the workspace in other case: the file system is case-sensitive');
    for (const [name, dir] of self) {
      const r = add([dir, '--reference']);
      it(`${name} is not a source: exit 2`, () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.match(r.err, /is the workspace|inside the workspace|contains the workspace/);
      });
    }
  }

  console.log('\nwsg add: markers are read strictly');
  {
    const wsK = path.join(wsRoot, 'strict');
    wsg(['new', 'strict', '--no-launch']);
    const agentsFile = path.join(wsK, 'AGENTS.md');
    const text = fs.readFileSync(agentsFile, 'utf8');
    // Markers quoted in prose or a code block are text, not the generated block.
    const example = '\n## Notes on wsg\n\nThe block starts at `<!-- wsg:layout -->`. For example:\n\n```\n<!-- wsg:layout -->\nexample line\n<!-- /wsg:layout -->\n```\n';
    // Before the real block: whoever reads the first marker it meets takes the quoted one.
    fs.writeFileSync(agentsFile, text.replace('## Why', `${example.trim()}\n\n## Why`));
    const r1 = wsg(['add', web, '--link'], { cwd: wsK });
    const after = fs.readFileSync(agentsFile, 'utf8');
    it('markers in code and inline code are not counted', () => {
      assert.strictEqual(r1.code, 0, r1.all);
      assert.ok(after.includes(example.trim()), after.slice(0, 600));
      assert.match(after, /## Layout\n\n<!-- wsg:layout -->\n- `web` — symlink/);
    });
    fs.writeFileSync(agentsFile, after + '\n<!-- wsg:layout -->\n<!-- /wsg:layout -->\n');
    const dup = fs.readFileSync(agentsFile, 'utf8');
    const r2 = wsg(['add', docs, '--reference'], { cwd: wsK });
    it('a second pair is refused, naming the file and the block', () => {
      assert.strictEqual(r2.code, 2, r2.all);
      assert.match(r2.err, /AGENTS\.md: the <!-- wsg:layout --> block has 2 opening and 2 closing markers/);
    });
    it('and nothing is written', () => assert.strictEqual(fs.readFileSync(agentsFile, 'utf8'), dup));

    // An unclosed fence hides every marker after it: each add would append another pair.
    const wsF = path.join(wsRoot, 'fence');
    wsg(['new', 'fence', '--no-launch']);
    const fenceFile = path.join(wsF, 'AGENTS.md');
    fs.writeFileSync(fenceFile, fs.readFileSync(fenceFile, 'utf8').replace('## Why', '```sh\nnpm test\n\n## Why'));
    const unclosed = fs.readFileSync(fenceFile, 'utf8');
    const line = unclosed.split('\n').indexOf('```sh') + 1;
    const r3 = wsg(['add', web, '--link'], { cwd: wsF });
    it('an unclosed code fence is refused: exit 2, naming the file and the line', () => {
      assert.strictEqual(r3.code, 2, r3.all);
      assert.match(r3.err, new RegExp(`AGENTS\\.md: the code block opened on line ${line} is never closed`));
    });
    it('and nothing is written', () => {
      assert.strictEqual(fs.readFileSync(fenceFile, 'utf8'), unclosed);
      assert.ok(!fs.existsSync(path.join(wsF, 'web')));
    });
    const fc = report(wsF, cfg);
    it('check fails on it', () => {
      assert.strictEqual(fc.code, 1, fc.text);
      assert.match(fc.text, new RegExp(`AGENTS\\.md — the code block opened on line ${line} is never closed`));
    });
  }

  console.log('\none command at a time');
  {
    const wsL = path.join(wsRoot, 'locked');
    wsg(['new', 'locked', '--no-launch']);
    const lock = path.join(wsL, '.claude', 'wsg.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
    const busy = [
      ['add', wsg(['add', web, '--link'], { cwd: wsL })],
      ['remove', wsg(['remove', 'web'], { cwd: wsL })],
      ['promote', wsg(['promote', 'locked', '--skill', 'x'])],
    ];
    for (const [name, r] of busy) {
      it(`${name} while another command holds the lock: exit 2`, () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.match(r.err, /another wsg command is running/);
      });
    }
    it('a held lock is left alone', () => assert.ok(fs.existsSync(lock)));
    it('and nothing was attached', () => assert.ok(!fs.existsSync(path.join(wsL, 'web'))));
    // A pid that is surely gone: a process that has already exited.
    const dead = spawnSync('true').pid;
    fs.writeFileSync(lock, JSON.stringify({ pid: dead, time: '2026-01-01T00:00:00Z' }));
    const r = wsg(['add', web, '--link'], { cwd: wsL });
    it('a stale lock is taken over, with a warning', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.match(r.out, /stale lock/);
    });
    it('the lock is released after the command', () => assert.ok(!fs.existsSync(lock)));
    wsg(['add', web, '--link'], { cwd: wsL });
    it('and after a refused one', () => assert.ok(!fs.existsSync(lock)));

    // Two commands taking over the same stale lock at once. Played out in this process: fs is
    // patched so that the other command acts at the worst moment.
    const lockLib = require(path.join(ROOT, 'lib', 'lock.js'));
    const wsR = path.join(tmp, 'lock-race');
    fs.mkdirSync(path.join(wsR, '.claude'), { recursive: true });
    const raceLock = path.join(wsR, '.claude', 'wsg.lock');
    const theirs = JSON.stringify({ pid: process.pid, time: '2026-02-02T00:00:00Z' });
    const race = (name, fn) => {
      fs.writeFileSync(raceLock, JSON.stringify({ pid: dead, time: '2026-01-01T00:00:00Z' }));
      const real = fs[name];
      let fired = false;
      fs[name] = (...a) => {
        if (!fired) { fired = true; return fn(real, ...a); }
        return real(...a);
      };
      const log = console.log;
      console.log = () => {};
      try { lockLib.acquire(wsR)(); return null; } catch (e) { return e; } finally { fs[name] = real; console.log = log; }
    };
    // The other one took the stale lock over and made its own just before this rename.
    const e1 = race('renameSync', (real, from, to) => { fs.writeFileSync(raceLock, theirs); return real(from, to); });
    it('a takeover that moved a fresh lock puts it back and reports busy', () => {
      assert.ok(e1 && e1.invalid, String(e1));
      assert.match(e1.message, /another wsg command is running .*pid \d+, since 2026-02-02/);
      assert.strictEqual(fs.readFileSync(raceLock, 'utf8'), theirs);
      assert.deepStrictEqual(fs.readdirSync(path.join(wsR, '.claude')), ['wsg.lock']);
    });
    // The other one made its lock between this takeover and the create.
    const e2 = race('rmSync', (real, ...a) => { const r = real(...a); fs.writeFileSync(raceLock, theirs); return r; });
    it('a lock made again right after the takeover: busy, not a raw EEXIST', () => {
      assert.ok(e2 && e2.invalid, String(e2));
      assert.match(e2.message, /another wsg command is running/);
      assert.strictEqual(fs.readFileSync(raceLock, 'utf8'), theirs);
    });
    // The same through the CLI: exit 2.
    fs.writeFileSync(lock, JSON.stringify({ pid: dead, time: '2026-01-01T00:00:00Z' }));
    const racing = `const fs = require('fs');
      const real = fs.rmSync;
      fs.rmSync = (p, ...a) => {
        real(p, ...a);
        if (String(p).startsWith(${JSON.stringify(`${lock}.`)})) fs.writeFileSync(${JSON.stringify(lock)}, ${JSON.stringify(theirs)});
      };
      process.argv = [process.argv[0], ${JSON.stringify(CLI)}, 'add', ${JSON.stringify(web)}, '--link', '--ws', ${JSON.stringify(wsL)}];
      require(${JSON.stringify(CLI)});`;
    const rc = spawnSync(process.execPath, ['-e', racing], { cwd: tmp, encoding: 'utf8', env: ENV });
    it('wsg add that loses the race: exit 2', () => {
      assert.strictEqual(rc.status, 2, rc.stdout + rc.stderr);
      assert.match(rc.stderr, /another wsg command is running/);
    });
    fs.rmSync(lock, { force: true });

    // Takeovers go one at a time: one in progress holds <lock>.takeover.
    const takeover = `${raceLock}.takeover`;
    const quietAcquire = () => {
      const log = console.log;
      console.log = () => {};
      try { lockLib.acquire(wsR)(); return null; } catch (e) { return e; } finally { console.log = log; }
    };
    const staleLock = JSON.stringify({ pid: dead, time: '2026-01-01T00:00:00Z' });
    fs.writeFileSync(raceLock, staleLock);
    fs.writeFileSync(takeover, theirs);
    const e3 = quietAcquire();
    it('a takeover in progress: busy, naming the takeover lock, both files left alone', () => {
      assert.ok(e3 && e3.invalid, String(e3));
      assert.match(e3.message, /another wsg command is running[\s\S]*wsg\.lock\.takeover/);
      assert.strictEqual(fs.readFileSync(raceLock, 'utf8'), staleLock);
      assert.strictEqual(fs.readFileSync(takeover, 'utf8'), theirs);
    });
    // One left by a killed command: its pid is gone and it is old.
    fs.writeFileSync(takeover, staleLock);
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(takeover, old, old);
    const e4 = quietAcquire();
    it('a takeover lock left by a dead command is removed, and the lock taken over', () => {
      assert.strictEqual(e4, null, String(e4));
      assert.deepStrictEqual(fs.readdirSync(path.join(wsR, '.claude')), []);
    });
    // An empty one, old: stale too.
    fs.writeFileSync(raceLock, staleLock);
    fs.writeFileSync(takeover, '');
    fs.utimesSync(takeover, old, old);
    const e5 = quietAcquire();
    it('an old empty takeover lock is stale too', () => {
      assert.strictEqual(e5, null, String(e5));
      assert.deepStrictEqual(fs.readdirSync(path.join(wsR, '.claude')), []);
    });
    // A lock just created and not yet written reads as empty: its holder is starting, not gone.
    fs.writeFileSync(raceLock, '');
    const e6 = quietAcquire();
    it('an empty lock just made: busy, left alone', () => {
      assert.ok(e6 && e6.invalid, String(e6));
      assert.strictEqual(fs.readFileSync(raceLock, 'utf8'), '');
    });
    fs.writeFileSync(raceLock, 'not json');
    const e7 = quietAcquire();
    it('an unreadable lock just made: busy too', () => assert.ok(e7 && e7.invalid, String(e7)));
    fs.utimesSync(raceLock, old, old);
    const e8 = quietAcquire();
    it('an old unreadable one is taken over', () => {
      assert.strictEqual(e8, null, String(e8));
      assert.deepStrictEqual(fs.readdirSync(path.join(wsR, '.claude')), []);
    });

    // A third command: the lock was judged stale, then another takeover finished before the
    // takeover lock was ours. The lock is re-read under it: someone else's is not moved aside, and
    // no "taking it over" precedes the busy.
    const lateTakeover = (other) => {
      fs.writeFileSync(raceLock, staleLock);
      const realWrite = fs.writeFileSync;
      const realRename = fs.renameSync;
      const lines = [];
      let renames = 0;
      fs.writeFileSync = (p, ...a) => {
        if (String(p).endsWith('.takeover') && fs.writeFileSync !== realWrite) {
          fs.writeFileSync = realWrite;
          other();
        }
        return realWrite(p, ...a);
      };
      fs.renameSync = (...a) => { renames++; return realRename(...a); };
      const log = console.log;
      console.log = (s) => lines.push(String(s));
      try {
        try { lockLib.acquire(wsR)(); return { e: null, lines, renames }; } catch (e) { return { e, lines, renames }; }
      } finally {
        fs.writeFileSync = realWrite;
        fs.renameSync = realRename;
        console.log = log;
      }
    };
    const l1 = lateTakeover(() => fs.writeFileSync(raceLock, theirs));
    it('a lock taken over by another before the takeover lock: busy, theirs never moved', () => {
      assert.ok(l1.e && l1.e.invalid, String(l1.e));
      assert.match(l1.e.message, /another wsg command is running .*pid \d+, since 2026-02-02/);
      assert.strictEqual(l1.renames, 0);
      assert.strictEqual(fs.readFileSync(raceLock, 'utf8'), theirs);
      assert.deepStrictEqual(fs.readdirSync(path.join(wsR, '.claude')), ['wsg.lock']);
    });
    it('and no stale-lock warning before it', () => assert.doesNotMatch(l1.lines.join('\n'), /stale lock/));
    const l2 = lateTakeover(() => fs.rmSync(raceLock));
    it('one taken over and already released: busy too, nothing made', () => {
      assert.ok(l2.e && l2.e.invalid, String(l2.e));
      assert.deepStrictEqual(fs.readdirSync(path.join(wsR, '.claude')), []);
    });
    // A takeover in progress: busy, and the warning didn't come first either.
    fs.writeFileSync(raceLock, staleLock);
    fs.writeFileSync(takeover, theirs);
    const warned = [];
    const logW = console.log;
    console.log = (s) => warned.push(String(s));
    try { lockLib.acquire(wsR)(); } catch { /* busy, checked above */ } finally { console.log = logW; }
    it('busy on the takeover lock: no stale-lock warning', () => assert.doesNotMatch(warned.join('\n'), /stale lock/));
    fs.rmSync(takeover);
    const l3 = lateTakeover(() => {});
    it('the lock judged stale still in place: taken over, with the warning', () => {
      assert.strictEqual(l3.e, null, String(l3.e));
      assert.match(l3.lines.join('\n'), /stale lock/);
      assert.deepStrictEqual(fs.readdirSync(path.join(wsR, '.claude')), []);
    });

    // An old empty lock judged stale, and before the takeover lock is ours another takeover puts a
    // fresh lock in its place, made and not written yet: empty too. Busy, the fresh one kept.
    {
      fs.writeFileSync(raceLock, '');
      const past = new Date(Date.now() - 60000);
      fs.utimesSync(raceLock, past, past);
      const realWrite = fs.writeFileSync;
      fs.writeFileSync = (p, ...a) => {
        if (String(p).endsWith('.takeover') && fs.writeFileSync !== realWrite) {
          fs.writeFileSync = realWrite;
          fs.rmSync(raceLock);
          realWrite(raceLock, '');
        }
        return realWrite(p, ...a);
      };
      const log = console.log;
      console.log = () => {};
      let e4 = null;
      try { lockLib.acquire(wsR)(); } catch (e) { e4 = e; } finally { fs.writeFileSync = realWrite; console.log = log; }
      it('an empty lock made in place of the stale empty one: busy, not taken over', () => {
        assert.ok(e4 && e4.invalid, String(e4));
        assert.strictEqual(fs.readFileSync(raceLock, 'utf8'), '');
        assert.ok(Date.now() - fs.statSync(raceLock).mtimeMs < 5000);
      });
      fs.rmSync(raceLock, { force: true });
      fs.rmSync(`${raceLock}.takeover`, { force: true });
    }

    // The lock's own handler stands aside only for guarded(), not for any other listener.
    const sigScript = `process.on('SIGINT', () => {});
      require(${JSON.stringify(path.join(ROOT, 'lib', 'lock.js'))}).acquire(${JSON.stringify(wsR)});
      process.kill(process.pid, 'SIGINT');
      setTimeout(() => process.exit(0), 500);`;
    const rs = spawnSync(process.execPath, ['-e', sigScript], { cwd: tmp, encoding: 'utf8', env: ENV });
    it('Ctrl+C with the lock held outside guarded(): exit 130, the lock released', () => {
      assert.strictEqual(rs.status, 130, rs.stdout + rs.stderr);
      assert.ok(!fs.existsSync(raceLock));
    });
    fs.rmSync(wsR, { recursive: true, force: true });

    // Ctrl+C while the source is still being resolved, before the rollback is armed: a git that
    // interrupts its own process group there. The command runs in a group of its own.
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const gitBin = path.join(tmp, 'git-interrupt-resolve');
    fs.mkdirSync(gitBin);
    fs.writeFileSync(path.join(gitBin, 'git'),
      `#!/bin/sh\ncase "$*" in *" ls-files "*) kill -INT 0; sleep 2;; esac\nexec ${realGit} "$@"\n`, { mode: 0o755 });
    const snapL = tree(wsL);
    const ri = spawnSync(process.execPath, [CLI, 'add', api, '--branch', 'task/lock-int'],
      { cwd: wsL, encoding: 'utf8', detached: true, env: { ...ENV, PATH: `${gitBin}:${ENV.PATH}` } });
    it('Ctrl+C while resolving: exit 130', () => assert.strictEqual(ri.status, 130, `${ri.status} ${ri.signal} ${ri.stdout}${ri.stderr}`));
    it('and the lock is released', () => assert.ok(!fs.existsSync(lock)));
    it('and the workspace is as it was', () => assert.deepStrictEqual(tree(wsL), snapL));
    it('no branch is left', () => assert.ok(!branches(api).includes('task/lock-int')));

    // promote is synchronous: no handler could run during it. Ctrl+C stops it as it always did,
    // instead of being swallowed with exit 0; the lock left names a dead pid.
    const gitPromote = path.join(tmp, 'git-interrupt-promote');
    fs.mkdirSync(gitPromote);
    fs.writeFileSync(path.join(gitPromote, 'git'),
      `#!/bin/sh\ncase "$*" in *"rev-parse --show-toplevel"*) kill -INT 0; sleep 2;; esac\nexec ${realGit} "$@"\n`, { mode: 0o755 });
    wsg(['new', 'prom-int', '--no-launch']);
    const rp = spawnSync(process.execPath, [CLI, 'promote', 'prom-int', '--skill', 'weekly'],
      { cwd: tmp, encoding: 'utf8', detached: true, env: { ...ENV, PATH: `${gitPromote}:${ENV.PATH}` } });
    it('Ctrl+C during promote stops it, not exit 0', () => assert.strictEqual(rp.signal, 'SIGINT', `${rp.status} ${rp.signal} ${rp.stdout}${rp.stderr}`));
    const after = wsg(['promote', 'prom-int', '--skill', 'weekly']);
    it('the next command takes the lock it left over', () => {
      assert.strictEqual(after.code, 0, after.all);
      assert.match(after.out, /stale lock/);
    });
  }

  console.log('\nwsg add: values that end up in markdown');
  {
    const wsV = path.join(wsRoot, 'values');
    wsg(['new', 'values', '--no-launch']);
    const add = (args) => wsg(['add', ...args], { cwd: wsV });
    const before = tree(wsV);
    const bad = [
      ['a verify command with a newline', [api, '--branch', 'v1', '--verify', 'npm test\nrm -rf x'], /--verify must be one line/],
      ['a verify command with a backtick', [api, '--branch', 'v1', '--verify', 'npm test `x`'], /--verify can't contain a backtick/],
      ['a note with a newline', [docs, '--reference', '--note', 'a\nb'], /--note must be one line/],
      ['a note with a marker', [docs, '--reference', '--note', 'see <!-- wsg:layout -->'], /--note can't contain <!--/],
      ['a target that is not a branch name', [web, '--link', '--target', 'bad..name'], /--target bad\.\.name is not a valid branch name/],
    ];
    for (const [name, args, msg] of bad) {
      const r = add(args);
      it(`${name}: exit 2`, () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.match(r.err, msg);
      });
    }
    it('refused values touched nothing', () => assert.deepStrictEqual(tree(wsV), before));
    const d = JSON.parse(add([web, '--link', '--target', 'release/9', '--dry-run']).out);
    it('a link target that exists nowhere is a warning', () => assert.match(d.warnings.join('\n'), /release\/9 exists neither in .* nor on origin/));
    const r = add([docs, '--reference', '--note', 'briefs | specs']);
    it('a pipe in a note does not break the README table', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.match(fs.readFileSync(path.join(wsV, 'README.md'), 'utf8'), /\| `docs` \| reference \| — \| briefs \\\| specs \|/);
    });
  }

  console.log('\nsmaller things');
  {
    const notWs = wsg(['add', web, '--link', '--ws', docs]);
    it('--ws to a directory that is no workspace says so', () => {
      assert.strictEqual(notWs.code, 2);
      assert.match(notWs.err, /not a wsg workspace/);
      assert.doesNotMatch(notWs.err, /0\.1/);
    });

    wsg(['new', 'ru-title', '--title', 'Обновление токена', '--no-launch']);
    const ruWs = path.join(wsRoot, 'ru-title');
    it('a title in another language: AGENTS.md and notes.md agree on the translation task', () => {
      assert.match(fs.readFileSync(path.join(ruWs, 'AGENTS.md'), 'utf8'), /kept in English.*\n.*see "Continue with" in `notes\.md`/);
      const notes = fs.readFileSync(path.join(ruWs, 'notes.md'), 'utf8');
      assert.match(notes, /Setup not finished/);
      assert.match(notes, /Continue with: .*translate/);
      assert.match(notes, /First-session task — translate into English/);
    });

    // Ctrl+C while the backup branch is being made: a git that interrupts its own process group
    // right there. The command runs in a group of its own, so the signal reaches only it.
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const gitBin = path.join(tmp, 'git-interrupt');
    fs.mkdirSync(gitBin);
    fs.writeFileSync(path.join(gitBin, 'git'),
      `#!/bin/sh\ncase "$*" in *" branch backup/"*) kill -INT 0; sleep 2;; esac\nexec ${realGit} "$@"\n`, { mode: 0o755 });
    git(api, ['branch', 'feature/int', 'main']);
    wsg(['new', 'int', '--no-launch']);
    const wsI = path.join(wsRoot, 'int');
    const snap = tree(wsI);
    const r = spawnSync(process.execPath, [CLI, 'add', api, '--branch', 'feature/int', '--reset-to-base', '--base', 'main'],
      { cwd: wsI, encoding: 'utf8', detached: true, env: { ...ENV, PATH: `${gitBin}:${ENV.PATH}` } });
    it('Ctrl+C while making the backup: exit 130', () => assert.strictEqual(r.status, 130, r.stdout + r.stderr));
    it('and the workspace is as it was', () => assert.deepStrictEqual(tree(wsI), snap));
    it('no backup branch is left', () => assert.ok(!branches(api).some((b) => b.startsWith('backup/feature-int'))));

    // Unreadable: neither shell can source it, and the plain reader fails too.
    const broken = path.join(tmp, 'broken-config');
    fs.writeFileSync(broken, 'WS_ROOT=/x\n', { mode: 0o000 });
    for (const args of [['--help'], ['--version'], ['--where'], ['shell-init', 'zsh'], ['guide'], ['install-skills']]) {
      const b = wsg(args, { env: { WSG_CONFIG: broken } });
      it(`wsg ${args.join(' ')} works with a broken config`, () => assert.strictEqual(b.code, 0, b.all));
    }
    it('a command that needs the config still reports it', () => {
      const b = wsg(['check', 'demo'], { env: { WSG_CONFIG: broken } });
      assert.strictEqual(b.code, 1);
      assert.match(b.err, /cannot read settings/);
    });
    it('the usage names exit 130', () => assert.match(wsg(['--help']).out, /130/));
  }

  console.log('\nwsg remove');
  {
    const wsX = path.join(wsRoot, 'rm');
    wsg(['new', 'rm', '--no-launch']);
    const agentsFile = path.join(wsX, 'AGENTS.md');
    fs.writeFileSync(agentsFile, fs.readFileSync(agentsFile, 'utf8').replace(/FILL IN: what problem this task solves.*\n/, 'Own prose.\n'));
    const settingsFile = path.join(wsX, '.claude', 'settings.json');
    const own = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    own.permissions.additionalDirectories = ['/hand/added'];
    fs.writeFileSync(settingsFile, JSON.stringify(own, null, 2) + '\n');
    const add = (args) => wsg(['add', ...args], { cwd: wsX });
    add([api, '--branch', 'task/rm', '--verify', 'npm test', '--carry', '.env']);
    add([web, '--link', '--target', 'main']);
    add([docs, '--reference']);
    const rm = (args) => wsg(['remove', ...args], { cwd: wsX });

    const before = tree(wsX);
    const d = rm(['api', '--dry-run']);
    let plan = null;
    try { plan = JSON.parse(d.out); } catch { /* below */ }
    it('--dry-run prints the plan as JSON', () => {
      assert.strictEqual(d.code, 0, d.all);
      assert.strictEqual(plan.mode, 'worktree');
      assert.strictEqual(plan.branchKept, 'task/rm');
      for (const f of ['api', '.claude/rules/api.md', 'AGENTS.md', 'CLAUDE.md', '.claude/wsg.json', 'repo']) assert.ok(plan.files.includes(f), f);
    });
    it('--dry-run touches nothing', () => assert.deepStrictEqual(tree(wsX), before));
    it('an unknown source: exit 2', () => {
      const r = rm(['nope']);
      assert.strictEqual(r.code, 2);
      assert.match(r.err, /no source nope/);
    });
    fs.writeFileSync(path.join(wsX, 'api', 'a.ts'), 'changed\n');
    fs.writeFileSync(path.join(wsX, 'api', 'new.txt'), 'new\n');
    const dirty = rm(['api']);
    it('a worktree with changes is refused, and they are listed', () => {
      assert.strictEqual(dirty.code, 2);
      assert.match(dirty.err, /a\.ts/);
      assert.match(dirty.err, /new\.txt/);
    });
    it('and nothing is touched', () => assert.deepStrictEqual(tree(wsX), before));
    git(path.join(wsX, 'api'), ['checkout', '--', 'a.ts']);
    fs.rmSync(path.join(wsX, 'api', 'new.txt'));

    git(api, ['worktree', 'lock', path.join(wsX, 'api')]);
    const locked = rm(['api']);
    it('a worktree git refuses to remove: the removal fails', () => assert.strictEqual(locked.code, 1, locked.all));
    it('and the workspace is as it was', () => assert.deepStrictEqual(tree(wsX), before));
    git(api, ['worktree', 'unlock', path.join(wsX, 'api')]);

    // Ignored, not carried: made in the worktree later, and git would delete it without a word.
    fs.writeFileSync(path.join(wsX, 'api', 'local.pem'), 'made here\n');
    const ign = rm(['api']);
    it('a worktree with ignored files wsg did not copy is refused, and they are listed', () => {
      assert.strictEqual(ign.code, 2, ign.all);
      assert.match(ign.err, /ignored files that exist nowhere else[\s\S]*local\.pem[\s\S]*--delete-ignored/);
      assert.doesNotMatch(ign.err, /\.env/);
    });
    it('and nothing is touched', () => {
      assert.deepStrictEqual(tree(wsX), before);
      assert.ok(fs.existsSync(path.join(wsX, 'api', 'local.pem')));
    });
    const ignDry = rm(['api', '--dry-run']);
    it('--dry-run lists them, and the refusal', () => {
      const p = JSON.parse(ignDry.out);
      assert.strictEqual(ignDry.code, 2, ignDry.all);
      assert.deepStrictEqual(p.ignored, ['local.pem']);
      assert.match(p.errors.join('\n'), /local\.pem/);
    });
    const ignOk = rm(['api', '--dry-run', '--delete-ignored']);
    it('--delete-ignored --dry-run: no refusal, the files still listed', () => {
      const p = JSON.parse(ignOk.out);
      assert.strictEqual(ignOk.code, 0, ignOk.all);
      assert.deepStrictEqual(p.ignored, ['local.pem']);
    });

    // A carried file edited in the worktree exists nowhere else now: refused like any other.
    fs.writeFileSync(path.join(wsX, 'api', '.env'), 'TOKEN=edited\n');
    const edited = rm(['api', '--delete-ignored', '--dry-run']);
    it('a carried file changed in the worktree is listed', () => assert.deepStrictEqual(JSON.parse(edited.out).ignored.sort(), ['.env', 'local.pem']));
    const editedRm = rm(['api']);
    it('and refused: exit 2, the edit kept', () => {
      assert.strictEqual(editedRm.code, 2, editedRm.all);
      assert.match(editedRm.err, /ignored files that exist nowhere else[\s\S]*\.env/);
      assert.strictEqual(fs.readFileSync(path.join(wsX, 'api', '.env'), 'utf8'), 'TOKEN=edited\n');
    });
    fs.writeFileSync(path.join(wsX, 'api', '.env'), fs.readFileSync(path.join(api, '.env')));

    // A file made after the plan was checked, before git removes the worktree: not deleted unasked.
    const late = generate.planRemove(wsX, 'api', { deleteIgnored: true });
    fs.writeFileSync(path.join(wsX, 'api', 'pkg', 'local.pem'), 'made after the check\n');
    const lateErr = await (async () => {
      try { await quietAsync(() => generate.remove(wsX, 'api', cfg, { deleteIgnored: true, ignored: late.ignored })); return null; } catch (e) { return e; }
    })();
    it('a file that appeared after the check: refused as invalid input, listed', () => {
      assert.deepStrictEqual(late.ignored, ['local.pem']);
      assert.ok(lateErr && lateErr.invalid, String(lateErr));
      assert.match(lateErr.message, /ignored files appeared after the check[\s\S]*pkg\/local\.pem/);
    });
    it('and nothing is touched', () => {
      assert.ok(fs.existsSync(path.join(wsX, 'api', 'pkg', 'local.pem')));
      assert.deepStrictEqual(W.readState(wsX).sources.map((x) => x.name), ['api', 'web', 'docs']);
    });
    fs.rmSync(path.join(wsX, 'api', 'pkg', 'local.pem'));
    // The same through the CLI: the file appears right after the plan, exit 2.
    const lateFile = path.join(wsX, 'api', 'pkg', 'local.pem');
    const lateCli = `const fs = require('fs');
      const gen = require(${JSON.stringify(path.join(ROOT, 'lib', 'generate.js'))});
      const real = gen.planRemove;
      gen.planRemove = (...a) => { const p = real(...a); fs.writeFileSync(${JSON.stringify(lateFile)}, 'late\\n'); return p; };
      process.argv = [process.argv[0], ${JSON.stringify(CLI)}, 'remove', 'api', '--delete-ignored', '--ws', ${JSON.stringify(wsX)}];
      require(${JSON.stringify(CLI)});`;
    const lc = spawnSync(process.execPath, ['-e', lateCli], { cwd: tmp, encoding: 'utf8', env: ENV });
    it('wsg remove that finds a file made after the check: exit 2, the worktree kept', () => {
      assert.strictEqual(lc.status, 2, lc.stdout + lc.stderr);
      assert.match(lc.stderr, /appeared after the check[\s\S]*pkg\/local\.pem/);
      assert.ok(fs.existsSync(lateFile));
      assert.ok(!fs.existsSync(path.join(wsX, '.claude', 'wsg.lock')));
    });
    fs.rmSync(lateFile);

    const r1 = rm(['api', '--delete-ignored']);
    it('with --delete-ignored the worktree is removed (carried ignored files do not count)', () => assert.strictEqual(r1.code, 0, r1.all));
    it('the directory and its registration are gone', () => {
      assert.ok(!fs.existsSync(path.join(wsX, 'api')));
      assert.ok(!git(api, ['worktree', 'list']).includes(path.join(wsX, 'api')));
    });
    it('the branch is kept, and says so', () => {
      assert.ok(branches(api).includes('task/rm'));
      assert.match(r1.out, /branch task\/rm is kept/);
    });
    it('its rule and its state entry are gone', () => {
      assert.ok(!fs.existsSync(path.join(wsX, '.claude/rules/api.md')));
      assert.deepStrictEqual(W.readState(wsX).sources.map((x) => x.name), ['web', 'docs']);
    });
    const agents = fs.readFileSync(agentsFile, 'utf8');
    it('the blocks are rendered without it', () => {
      assert.doesNotMatch(agents, /`api\/`/);
      assert.doesNotMatch(fs.readFileSync(path.join(wsX, 'CLAUDE.md'), 'utf8'), /@api\/AGENTS\.md/);
      assert.match(agents, /Own prose\./);
    });
    it('the pointer moves to the next git source', () => {
      assert.strictEqual(fs.readlinkSync(path.join(wsX, 'repo')), 'web');
      assert.strictEqual(fs.readFileSync(path.join(wsX, 'mr-target-branch.txt'), 'utf8'), 'main\n');
    });
    const r2 = rm(['web']);
    it('a link is removed as a symlink', () => {
      assert.strictEqual(r2.code, 0, r2.all);
      assert.ok(!fs.existsSync(path.join(wsX, 'web')));
      assert.ok(fs.existsSync(web));
    });
    it('without a git source the pointer and the MR target go', () => {
      assert.ok(!fs.existsSync(path.join(wsX, 'repo')) && !fs.lstatSync(wsX).isSymbolicLink());
      assert.throws(() => fs.lstatSync(path.join(wsX, 'repo')));
      assert.ok(!fs.existsSync(path.join(wsX, 'mr-target-branch.txt')));
    });
    it('settings.json loses its directory, keeps the hand-added one', () =>
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).permissions.additionalDirectories, [docs, '/hand/added']));

    // A node_modules wsg cloned is a copy too; one installed in the worktree later is not.
    const nmRepo = makeRepo('nm-repo');
    fs.appendFileSync(path.join(nmRepo, '.gitignore'), 'node_modules/\n');
    git(nmRepo, ['commit', '-qam', 'ignore node_modules']);
    fs.mkdirSync(path.join(nmRepo, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(nmRepo, 'node_modules', 'x', 'index.js'), '\n');
    const nmAdd = add([nmRepo, '--branch', 'task/nm', '--carry', 'none', '--clone-node-modules']);
    const nmPlan = () => JSON.parse(rm(['nm-repo', '--dry-run']).out);
    const cloned = W.readState(wsX).sources.find((x) => x.name === 'nm-repo');
    // Only macOS clones it (copy-on-write); elsewhere there is nothing to check.
    if (os.platform() === 'darwin') {
      it('a node_modules wsg cloned does not count as ignored files', () => {
        assert.strictEqual(nmAdd.code, 0, nmAdd.all);
        assert.strictEqual(cloned.cloneNm, true);
        assert.ok(fs.existsSync(path.join(wsX, 'nm-repo', 'node_modules', 'x', 'index.js')));
        assert.strictEqual(nmPlan().ignored, undefined);
      });
      it('and the plan says changes inside it are not protected', () =>
        assert.match(nmPlan().warnings.join('\n'), /node_modules wsg cloned into nm-repo is not checked/));
    } else console.log('  skip  a cloned node_modules: copy-on-write cloning is macOS only');
    fs.mkdirSync(path.join(wsX, 'nm-repo', 'pkg', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(wsX, 'nm-repo', 'pkg', 'node_modules', 'y.js'), '\n');
    it('one installed later does', () => assert.deepStrictEqual(nmPlan().ignored, ['pkg/node_modules/']));
    if (os.platform() === 'darwin') {
      const nmRm = rm(['nm-repo']);
      it('the refusal says the cloned node_modules is not checked', () => {
        assert.strictEqual(nmRm.code, 2, nmRm.all);
        assert.match(nmRm.err, /pkg\/node_modules\/[\s\S]*node_modules wsg cloned into nm-repo is not checked/);
      });
    }

    // A carried file in a directory where everything else is gone from the branch: git reports the
    // directory, `conf/`. Looked into, the carried copy is the only thing there and doesn't count.
    const confRepo = makeRepo('conf-repo');
    fs.mkdirSync(path.join(confRepo, 'conf'));
    fs.writeFileSync(path.join(confRepo, 'conf', 'app.json'), '{}\n');
    fs.writeFileSync(path.join(confRepo, 'conf', 'local.pem'), 'conf pem\n');
    git(confRepo, ['add', '-A']);
    git(confRepo, ['commit', '-qm', 'conf']);
    const confAdd = add([confRepo, '--branch', 'task/conf', '--carry', 'conf/local.pem']);
    const confWt = path.join(wsX, 'conf-repo');
    git(confWt, ['rm', '-q', 'conf/app.json']);
    git(confWt, ['commit', '-qm', 'drop app.json']);
    const confPlan = () => JSON.parse(rm(['conf-repo', '--dry-run']).out);
    it('a carried file alone in an ignored-only directory does not count', () => {
      assert.strictEqual(confAdd.code, 0, confAdd.all);
      assert.ok(git(confWt, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory']).split('\n').includes('conf/'));
      assert.strictEqual(confPlan().ignored, undefined);
    });
    fs.writeFileSync(path.join(confWt, 'conf', 'local.pem'), 'edited\n');
    it('changed, it is listed by itself', () => assert.deepStrictEqual(confPlan().ignored, ['conf/local.pem']));
    fs.writeFileSync(path.join(confWt, 'conf', 'local.pem'), 'conf pem\n');
    fs.mkdirSync(path.join(confWt, 'build'));
    fs.writeFileSync(path.join(confWt, 'build', 'local.pem'), 'x\n');
    it('a directory with nothing carried is still one entry', () => assert.deepStrictEqual(confPlan().ignored, ['build/']));
    fs.rmSync(path.join(confWt, 'build'), { recursive: true });
    const confRm = rm(['conf-repo']);
    it('and the source is removed', () => assert.strictEqual(confRm.code, 0, confRm.all));

    // A listing of ignored files over 1 MiB (a build's object files): read in full, not dropped
    // as if there were none — an edited carried file next to them is still refused.
    const bigRepo = makeRepo('big-repo');
    fs.appendFileSync(path.join(bigRepo, '.gitignore'), '*.o\n\\ \n');
    fs.mkdirSync(path.join(bigRepo, 'conf'));
    fs.writeFileSync(path.join(bigRepo, 'conf', 'app.json'), '{}\n');
    fs.writeFileSync(path.join(bigRepo, 'conf', 'local.pem'), 'conf pem\n');
    git(bigRepo, ['add', '-A']);
    git(bigRepo, ['commit', '-qm', 'objects ignored, conf']);
    const bigAdd = add([bigRepo, '--branch', 'task/big', '--carry', '.env,conf/local.pem']);
    const bigWt = path.join(wsX, 'big-repo');
    const objects = (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 4500; i++) fs.writeFileSync(path.join(dir, `${'o'.repeat(240)}-${i}.o`), '');
    };
    const listed = (dir) => execFileSync('git', ['-C', bigWt, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', dir], { maxBuffer: 1 << 28 }).length;
    objects(bigWt);
    fs.writeFileSync(path.join(bigWt, '.env'), 'TOKEN=edited\n');
    const bigRm = rm(['big-repo']);
    it('a listing over 1 MiB is read in full: the edited carried file refused, kept', () => {
      assert.strictEqual(bigAdd.code, 0, bigAdd.all);
      assert.ok(listed('.') > 1 << 20);
      assert.strictEqual(bigRm.code, 2, bigRm.all);
      assert.match(bigRm.err, /ignored files that exist nowhere else[\s\S]*\.env/);
      assert.strictEqual(fs.readFileSync(path.join(bigWt, '.env'), 'utf8'), 'TOKEN=edited\n');
    });
    fs.writeFileSync(path.join(bigWt, '.env'), 'TOKEN=x\n');
    for (const f of fs.readdirSync(bigWt)) if (f.endsWith('.o')) fs.rmSync(path.join(bigWt, f));
    // The same inside a directory looked into file by file: conf/ holds only ignored files now.
    git(bigWt, ['rm', '-q', 'conf/app.json']);
    git(bigWt, ['commit', '-qm', 'drop app.json']);
    objects(path.join(bigWt, 'conf'));
    fs.writeFileSync(path.join(bigWt, 'conf', 'local.pem'), 'edited\n');
    const bigConfRm = rm(['big-repo', '--dry-run']);
    it('and in a directory listed file by file', () => {
      assert.ok(listed('conf/') > 1 << 20);
      const bigConf = JSON.parse(bigConfRm.out);
      assert.ok(bigConf.ignored.includes('conf/local.pem'), bigConf.errors.join('\n'));
      assert.match(bigConf.errors.join('\n'), /conf\/local\.pem/);
    });
    fs.rmSync(path.join(bigWt, 'conf'), { recursive: true });
    fs.mkdirSync(path.join(bigWt, 'conf'));
    fs.writeFileSync(path.join(bigWt, 'conf', 'local.pem'), 'conf pem\n');

    // A name that is nothing but a space is a file like any other, and shown so it can be seen.
    fs.writeFileSync(path.join(bigWt, ' '), 'space\n');
    const space = rm(['big-repo']);
    it('an ignored file named " " is listed and refused, the name quoted', () => {
      assert.strictEqual(space.code, 2, space.all);
      assert.match(space.err, /\n {4}" "\n/);
      assert.deepStrictEqual(JSON.parse(rm(['big-repo', '--dry-run']).out).ignored, [' ']);
      assert.ok(fs.existsSync(path.join(bigWt, ' ')));
    });
    fs.rmSync(path.join(bigWt, ' '));

    // git that can't list the ignored files: no list is not an empty list, the removal is refused.
    const failGit = path.join(tmp, 'fail-git');
    fs.mkdirSync(failGit);
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(failGit, 'git'),
      `#!/bin/sh\ncase " $* " in *" --ignored "*) echo "fatal: index file corrupt" >&2; exit 128;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
    const failEnv = { PATH: `${failGit}:${ENV.PATH}` };
    const failRm = wsg(['remove', 'big-repo'], { cwd: wsX, env: failEnv });
    it('git failing to list the ignored files: exit 2, the worktree kept', () => {
      assert.strictEqual(failRm.code, 2, failRm.all);
      assert.match(failRm.err, /could not list its ignored files \(git ls-files: fatal: index file corrupt\)/);
      assert.ok(fs.existsSync(path.join(bigWt, '.env')));
      assert.ok(W.readState(wsX).sources.some((x) => x.name === 'big-repo'));
    });
    const failDry = wsg(['remove', 'big-repo', '--dry-run', '--delete-ignored'], { cwd: wsX, env: failEnv });
    it('--dry-run says so too, even with --delete-ignored', () => {
      assert.strictEqual(failDry.code, 2, failDry.all);
      assert.match(JSON.parse(failDry.out).errors.join('\n'), /could not list its ignored files/);
    });
    // Failing right before the removal, after the plan passed: refused the same way.
    const G = require(path.join(ROOT, 'lib', 'git.js'));
    const failPlan = generate.planRemove(wsX, 'big-repo');
    const realList = G.gitList;
    G.gitList = () => { throw new Error('git ls-files: signal SIGKILL'); };
    let failLate;
    try {
      failLate = await (async () => {
        try { await quietAsync(() => generate.remove(wsX, 'big-repo', cfg, {})); return null; } catch (e) { return e; }
      })();
    } finally {
      G.gitList = realList;
    }
    it('git failing at the re-check before the removal: refused as invalid, nothing touched', () => {
      assert.deepStrictEqual(failPlan.errors, []);
      assert.ok(failLate && failLate.invalid, String(failLate));
      assert.match(failLate.message, /could not list its ignored files \(git ls-files: signal SIGKILL\)/);
      assert.ok(fs.existsSync(path.join(bigWt, '.env')));
      assert.ok(W.readState(wsX).sources.some((x) => x.name === 'big-repo'));
    });
    // Ctrl+C that stops git while it lists the worktree stops the command: exit 130, not a refusal.
    const intGit = path.join(tmp, 'int-git');
    fs.mkdirSync(intGit);
    const intScript = (who) => `#!/bin/sh\ncase " $* " in *" --ignored "*) kill -INT ${who}; sleep 2;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`;
    fs.writeFileSync(path.join(intGit, 'git'), intScript('$$'), { mode: 0o755 });
    const intEnv = { PATH: `${intGit}:${ENV.PATH}` };
    const intDry = wsg(['remove', 'big-repo', '--dry-run'], { cwd: wsX, env: intEnv });
    const intRm = wsg(['remove', 'big-repo'], { cwd: wsX, env: intEnv });
    it('Ctrl+C stopping git as it lists the ignored files: exit 130, the worktree kept', () => {
      assert.strictEqual(intDry.code, 130, intDry.all);
      assert.strictEqual(intRm.code, 130, intRm.all);
      assert.doesNotMatch(intRm.err, /could not list/);
      assert.ok(fs.existsSync(path.join(bigWt, '.env')));
      assert.ok(W.readState(wsX).sources.some((x) => x.name === 'big-repo'));
    });
    // The whole group, wsg included, as a terminal sends it. wsg runs in a group of its own.
    fs.writeFileSync(path.join(intGit, 'git'), intScript('0'));
    const intGroup = spawnSync(process.execPath, [CLI, 'remove', 'big-repo'],
      { cwd: wsX, encoding: 'utf8', detached: true, env: { ...ENV, ...intEnv } });
    it('Ctrl+C to the whole group: exit 130, the lock released, the worktree kept', () => {
      assert.strictEqual(intGroup.status, 130, `${intGroup.status} ${intGroup.signal} ${intGroup.stdout}${intGroup.stderr}`);
      assert.ok(!fs.existsSync(path.join(wsX, '.claude', 'wsg.lock')));
      assert.ok(fs.existsSync(path.join(bigWt, '.env')));
    });
    G.gitList = () => { throw G.interruptedError(); };
    let intLate;
    try {
      intLate = await (async () => {
        try { await quietAsync(() => generate.remove(wsX, 'big-repo', cfg, {})); return null; } catch (e) { return e; }
      })();
    } finally {
      G.gitList = realList;
    }
    it('and at the re-check before the removal: Interrupted, not a refusal', () => {
      assert.ok(intLate && intLate.name === 'Interrupted' && !intLate.invalid, String(intLate));
      assert.ok(W.readState(wsX).sources.some((x) => x.name === 'big-repo'));
    });

    // A listing over the cap: the refusal says it is too large and what to do.
    it('a listing over the cap throws ENOBUFS', () => assert.throws(
      () => G.gitList(bigWt, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'], { max: 4 }),
      (e) => e.code === 'ENOBUFS'));
    G.gitList = () => { throw Object.assign(new Error('git ls-files: ENOBUFS'), { code: 'ENOBUFS' }); };
    let tooLarge;
    try { tooLarge = generate.planRemove(wsX, 'big-repo'); } finally { G.gitList = realList; }
    it('a listing too large refuses, suggesting to delete the build output by hand', () => {
      assert.match(tooLarge.errors.join('\n'), /git lists more than 256 MiB of files there[\s\S]*Delete the build output in it by hand/);
    });

    // A name with a line break is quoted: shown raw it reads as two names.
    fs.writeFileSync(path.join(bigWt, 'two\nlines.o'), '');
    const nl = rm(['big-repo']);
    it('an ignored name with a line break is shown quoted', () => {
      assert.strictEqual(nl.code, 2, nl.all);
      assert.ok(nl.err.includes('\n    "two\\nlines.o"\n'), nl.err);
    });
    fs.rmSync(path.join(bigWt, 'two\nlines.o'));

    // Changes listed over 1 MiB (thousands of untracked files) are read in full: the dry run
    // doesn't call the worktree clean, the list is cut at 20.
    const untracked = path.join(bigWt, 'untracked');
    fs.mkdirSync(untracked);
    for (let i = 0; i < 4500; i++) fs.writeFileSync(path.join(untracked, `${'u'.repeat(240)}-${i}.txt`), '');
    const manyDry = rm(['big-repo', '--dry-run']);
    const manyRm = rm(['big-repo']);
    it('over 1 MiB of changes: the dry run refuses them, exit 2', () => {
      assert.ok(execFileSync('git', ['-C', bigWt, 'status', '--porcelain', '-z', '--untracked-files=all'], { maxBuffer: 1 << 28 }).length > 1 << 20);
      assert.strictEqual(manyDry.code, 2, manyDry.out.slice(0, 2000));
      const errs = JSON.parse(manyDry.out).errors.join('\n');
      assert.match(errs, /has changes that exist nowhere else[\s\S]*\?\? untracked\/u+-\d+\.txt[\s\S]*… and 4480 more/);
    });
    it('and so does the removal, the worktree kept', () => {
      assert.strictEqual(manyRm.code, 2, manyRm.all);
      assert.match(manyRm.err, /has changes that exist nowhere else/);
      assert.ok(fs.existsSync(untracked));
    });
    fs.rmSync(untracked, { recursive: true });
    // git that can't say what is changed: refused as well.
    fs.writeFileSync(path.join(failGit, 'git'),
      `#!/bin/sh\ncase " $* " in *" status "*) echo "fatal: index file corrupt" >&2; exit 128;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
    const statusDry = wsg(['remove', 'big-repo', '--dry-run'], { cwd: wsX, env: failEnv });
    const statusRm = wsg(['remove', 'big-repo'], { cwd: wsX, env: failEnv });
    it('git failing to list the changes: exit 2, dry run and removal alike', () => {
      assert.strictEqual(statusDry.code, 2, statusDry.all);
      assert.match(JSON.parse(statusDry.out).errors.join('\n'), /could not list its changes \(git status: fatal: index file corrupt\)/);
      assert.strictEqual(statusRm.code, 2, statusRm.all);
      assert.ok(W.readState(wsX).sources.some((x) => x.name === 'big-repo'));
    });
    // A staged rename reads as old -> new: with -z the old name is a field of its own.
    git(bigWt, ['mv', 'a.ts', 'b.ts']);
    const renamed = JSON.parse(rm(['big-repo', '--dry-run']).out).errors.join('\n');
    it('a staged rename is shown as old -> new', () => assert.match(renamed, /\n {4}R {2}a\.ts -> b\.ts(\n|$)/));
    git(bigWt, ['mv', 'b.ts', 'a.ts']);
    // A name holding " -> " is quoted: otherwise a -> b -> c.ts doesn't say which name is which.
    git(bigWt, ['mv', 'a.ts', 'b -> c.ts']);
    const arrowed = JSON.parse(rm(['big-repo', '--dry-run']).out).errors.join('\n');
    it('a name holding " -> " is quoted', () => assert.match(arrowed, /\n {4}R {2}a\.ts -> "b -> c\.ts"(\n|$)/));
    git(bigWt, ['mv', 'b -> c.ts', 'a.ts']);

    const bigOk = rm(['big-repo']);
    it('once git can list them, the source is removed', () => assert.strictEqual(bigOk.code, 0, bigOk.all));
    it('the guide says how to fix a wrong source', () =>
      assert.match(fs.readFileSync(path.join(ROOT, 'docs', 'setup-guide.md'), 'utf8'), /`wsg remove <name>`/));
  }

  console.log('\nwsg promote');
  {
    wsg(['new', 'to-promote', '--no-launch']);
    const r1 = wsg(['promote', 'to-promote']);
    it('without --skill: exit 2, no prompt', () => {
      assert.strictEqual(r1.code, 2);
      assert.match(r1.err, /--skill/);
    });
    it('bad skill name: exit 2', () => assert.strictEqual(wsg(['promote', 'to-promote', '--skill', 'Bad']).code, 2));
    const r2 = wsg(['promote', '--skill', 'weekly-upgrade'], { cwd: path.join(wsRoot, 'to-promote') });
    it('with --skill it runs from inside the workspace', () => assert.strictEqual(r2.code, 0, r2.all));
    it('the kind is a process in both places', () => {
      assert.strictEqual(fs.readFileSync(path.join(wsRoot, 'to-promote', '.claude/ws-kind'), 'utf8').trim(), 'process');
      assert.strictEqual(W.readState(path.join(wsRoot, 'to-promote')).kind, 'process');
    });
    it('the old --promote spelling still works', () => {
      wsg(['new', 'to-promote-2', '--no-launch']);
      assert.strictEqual(wsg(['--promote', 'to-promote-2', '--skill', 'x']).code, 0);
    });
  }

  console.log('\nwsg guide, install-skills, the rest of the CLI');
  {
    // A reader that closes the pipe early (`| true`, `| head`): the exit code stays the command's,
    // no stack trace.
    const wsP = path.join(wsRoot, 'epipe');
    wsg(['new', 'epipe', '--no-launch']);
    wsg(['add', web, '--link'], { cwd: wsP });
    const closedOut = (args) => new Promise((resolve) => {
      const c = require('node:child_process').spawn(process.execPath, [CLI, ...args], { cwd: wsP, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
      c.stdout.destroy();
      let err = '';
      c.stderr.on('data', (d) => { err += d; });
      c.on('close', (status, signal) => resolve({ status, signal, err }));
    });
    const piped = await closedOut(['remove', 'web', '--dry-run']);
    it('remove --dry-run with stdout closed: exit 0, no EPIPE', () => {
      assert.strictEqual(piped.status, 0, `${piped.status} ${piped.signal} ${piped.err}`);
      assert.doesNotMatch(piped.err, /EPIPE|Unhandled/);
    });
    const pipedBad = await closedOut(['remove', 'nope', '--dry-run']);
    it('and a refused one still exits 2', () => {
      assert.strictEqual(pipedBad.status, 2, `${pipedBad.status} ${pipedBad.signal} ${pipedBad.err}`);
      assert.doesNotMatch(pipedBad.err, /EPIPE|Unhandled/);
    });
    const g1 = wsg(['guide', 'setup']);
    const guide = fs.readFileSync(path.join(ROOT, 'docs', 'setup-guide.md'), 'utf8');
    it('wsg guide setup prints the guide', () => assert.strictEqual(g1.out, guide));
    it('wsg guide defaults to setup', () => assert.strictEqual(wsg(['guide']).out, guide));
    it('an unknown guide: exit 2', () => assert.strictEqual(wsg(['guide', 'nope']).code, 2));
    it('the guide covers the setup dialogue', () => {
      for (const s of ['wsg add', '--dry-run', '--reference', 'wsg check', 'notes.md', 'FILL IN', 'for-each-ref', 'restart']) assert.ok(guide.includes(s), s);
    });

    // Every wsg command and flag the guide names exists, and every flag of add and remove is named:
    // an agent follows the guide literally, and an unknown flag is exit 2 in the middle of setup.
    const { FLAGS, GLOBAL } = require(path.join(ROOT, 'lib', 'flags.js'));
    // The code spans of a markdown text: `inline` ones and the lines of fenced blocks.
    const codeSpans = (text) => {
      const out = [];
      let fence = false;
      for (const line of text.split('\n')) {
        if (/^\s*```/.test(line)) { fence = !fence; continue; }
        if (fence) out.push(line.trim());
        else for (const m of line.matchAll(/`([^`]+)`/g)) out.push(m[1]);
      }
      return out;
    };
    const allFlags = new Set([...GLOBAL, ...Object.values(FLAGS).flatMap(Object.keys)]);
    const flagProblems = (text) => {
      const out = [];
      for (const span of codeSpans(text)) {
        for (const m of span.matchAll(/(?:^|[\s(])(?:wsg|node "<WSG_CLI>")\s+([a-z][a-z-]*)([^|&;]*)/g)) {
          const cmd = m[1];
          if (!FLAGS[cmd]) { out.push(`unknown command: wsg ${cmd}`); continue; }
          for (const f of m[2].match(/--[a-z][a-z-]*/g) || []) if (!(f in FLAGS[cmd])) out.push(`wsg ${cmd} has no ${f}`);
        }
        if (/^--[a-z]/.test(span)) for (const f of span.match(/--[a-z][a-z-]*/g)) if (!allFlags.has(f)) out.push(`no such flag: ${f}`);
      }
      return out;
    };
    const spans = codeSpans(guide);
    const problems = flagProblems(guide);
    it('every wsg command and flag in the guide exists', () => assert.deepStrictEqual(problems, []));
    it('the guide names every flag of add and remove, and --without of team', () => {
      const named = new Set(spans.flatMap((x) => x.match(/--[a-z][a-z-]*/g) || []));
      const missing = [...Object.keys(FLAGS.add), ...Object.keys(FLAGS.remove), '--without'].filter((f) => !named.has(f));
      assert.deepStrictEqual(missing, []);
    });
    it('the guide says how to record a ticket after wsg new', () => assert.match(guide, /`Ticket:` line[\s\S]{0,200}WSG_TRACKER_URL/));
    it('the guide says what --dry-run needs', () => assert.match(guide, /--dry-run[\s\S]{0,300}--branch/));
    // The advisor at each point where the setup would otherwise put questions to the owner.
    const part = (from, to) => guide.slice(guide.indexOf(from), to ? guide.indexOf(to) : undefined);
    it('ground rules: questions go through the advisor, the owner sees only its FOR THE OWNER block', () => {
      const p = part('## Ground rules', '## 1.');
      assert.match(p, /`wsg-advisor`/);
      assert.match(p, /`wsg guide advisor`/);
      assert.match(p, /Show the owner the advisor's FOR THE OWNER block as is, and nothing else from its reply/);
      assert.match(p, /Never say the advisor ran when it did not/);
    });
    it('section 1 starts with context from the advisor and checks the draft', () => assert.match(part('## 1.', 'Go through these in order'), /advisor[\s\S]*draft/));
    it('section 2 has a plan review before the "ok"', () => {
      const p = part('## 2.', '## 3.');
      assert.ok(p.indexOf('plan review') > 0 && p.indexOf('plan review') < p.indexOf('**Wait for "ok"**'));
      assert.match(p, /plan review[\s\S]{0,200}wsg remove <name> --dry-run/);
    });
    it('section 5 carries unresolved OWNER items into the summary', () => assert.match(part('## 5.', '## Running setup again'), /OWNER items the advisor left/));
    it('the team step: after a git source, optional, a dry run and the advisor before the "ok"', () => {
      const p = part('## 3. Team', '## 4.');
      assert.match(p, /Once at least one git source is attached/);
      assert.ok(p.indexOf('--dry-run') < p.indexOf('**Wait for "ok"**') && p.indexOf('advisor') < p.indexOf('**Wait for "ok"**'));
      for (const r of require(path.join(ROOT, 'lib', 'team.js')).ROLES) assert.ok(p.includes(`\`${r}\``), r);
      assert.match(p.replace(/\s+/g, ' '), /usable only after a restart/);
      assert.match(part('## 5.', '## Running setup again').replace(/\s+/g, ' '), /the team — added \(its roles/);
      assert.match(part('## 5.', '## Running setup again').replace(/\s+/g, ' '), /always after `wsg team` added roles: they are usable only in a new session/);
    });
    it('the team step gives the real always-on cost: the adapters\' descriptions and the AGENTS.md block', () => {
      const T = require(path.join(ROOT, 'lib', 'team.js'));
      const Tpl = require(path.join(ROOT, 'lib', 'templates.js'));
      const n = T.ROLES.reduce((a, r) => a + Buffer.byteLength(T.ROLE_META[r].description), 0)
        + Buffer.byteLength(`${Tpl.marked('team', Tpl.teamLines({ kind: 'task', team: { roles: T.ROLES } }))}\n`);
      assert.ok(part('## 3. Team', '## 4.').replace(/\s+/g, ' ').includes(`all six roles, ${n} B (about ${Math.round(n / 4 / 50) * 50} tokens)`), String(n));
    });
    it('the team step runs the dry run itself and sends the advisor the JSON before showing the owner', () => {
      const p = part('## 3. Team', '## 4.').replace(/\s+/g, ' ');
      assert.match(p, /run `wsg team fullstack --without <roles> --dry-run` yourself/);
      assert.match(p, /Before you show the proposal, send it to the advisor for a plan review together with that JSON — the advisor reviews it, it cannot run `wsg team` itself/);
    });
    // A live run skipped the team step without a word and stopped after setup without asking to start.
    it('the team step is always put to the owner, with a recommendation either way', () => {
      const p = part('## 3. Team (optional)', '## 4. Editing').replace(/\s+/g, ' ');
      assert.ok(p.includes('always put the team to the owner as a question — never skip this step silently'), p);
      assert.ok(p.includes('"no team, because <reason>"'), p);
      assert.ok(p.includes('for a team, go through steps 1–3 below and ask once'), p);
      assert.ok(p.includes('through the advisor, like any other question'), p);
    });
    it('finishing ends with one question: start the work now, in this session when no restart is needed', () => {
      const p = part('## 5. Finishing', '## Running setup again').replace(/\s+/g, ' ');
      assert.ok(p.includes('When no restart is needed, end with one direct question: start the work now?'), p);
      assert.ok(p.includes("When a restart is needed, don't offer to start here: say what to run first in the new session."), p);
      assert.ok(p.includes("Either way, then wait for the owner's answer."), p);
      assert.ok(p.includes('The work goes on in this session: don\'t call it "the next session"'), p);
      assert.ok(p.includes('declined, or not recommended and why'), p);
    });
    it('the wsg-setup skill: no step skipped silently, and it ends by asking to start', () => {
      const text = fs.readFileSync(path.join(ROOT, 'templates', 'claude', 'wsg-setup', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
      assert.ok(text.includes("Don't skip a step of the guide silently, the team step included, and end by asking the owner whether to start the work now."));
    });
    it('the wsg-setup skill points to the advisor', () => {
      const text = fs.readFileSync(path.join(ROOT, 'templates', 'claude', 'wsg-setup', 'SKILL.md'), 'utf8');
      assert.match(text, /`wsg-advisor` subagent first \(without it,\n`wsg guide advisor` followed inline\)/);
    });
    it('running setup again names wsg refresh', () => assert.match(part('## Running setup again'), /`wsg refresh --dry-run`[\s\S]*`wsg refresh`/));


    const skill = path.join(claudeDir, 'skills', 'wsg-new', 'SKILL.md');
    const i1 = wsg(['install-skills']);
    it('install-skills writes the wsg-new skill', () => {
      assert.strictEqual(i1.code, 0, i1.all);
      assert.match(fs.readFileSync(skill, 'utf8'), /^---\nname: wsg-new\n/);
    });
    it('the skill is model-invocable and runs wsg new', () => {
      const text = fs.readFileSync(skill, 'utf8');
      assert.doesNotMatch(text, /disable-model-invocation/);
      assert.match(text, /^allowed-tools: Bash\(wsg \*\)$/m);
      assert.match(text, /wsg new <slug> --no-launch/);
      assert.match(text, /<!-- generated by wsg -->/);
    });
    const teach = path.join(claudeDir, 'skills', 'wsg-teach', 'SKILL.md');
    it('install-skills writes /wsg-teach: manual only, named as its directory, marked', () => {
      const text = fs.readFileSync(teach, 'utf8');
      assert.match(text, /^---\nname: wsg-teach\n/);
      assert.match(text, /^disable-model-invocation: true$/m);
      assert.match(text, /^argument-hint: "<role> <url\|text>"$/m);
      assert.match(text, /^allowed-tools: Bash\(wsg \*\)$/m);
      assert.match(text, /<!-- generated by wsg -->/);
      assert.match(text, /wsg guide teach/);
      assert.match(text, /npx @korbutds\/wsg/);
      assert.match(i1.out, /wsg-teach\/SKILL\.md/);
    });
    const i2 = wsg(['install-skills']);
    it('running it again is a no-op', () => {
      assert.strictEqual(i2.code, 0);
      assert.match(i2.out, /up to date/);
      assert.match(i2.out, /up to date: .*wsg-teach\/SKILL\.md/);
    });
    fs.appendFileSync(teach, '\nold version\n');
    const i2b = wsg(['install-skills']);
    it('an outdated /wsg-teach it wrote is replaced', () => {
      assert.strictEqual(i2b.code, 0, i2b.all);
      assert.doesNotMatch(fs.readFileSync(teach, 'utf8'), /old version/);
    });
    fs.writeFileSync(teach, '---\nname: wsg-teach\n---\nmine\n');
    const i2c = wsg(['install-skills']);
    it('a /wsg-teach without the marker is refused: exit 1, kept as it is', () => {
      assert.strictEqual(i2c.code, 1, i2c.all);
      assert.match(i2c.out, /wsg-teach\/SKILL\.md exists and was not written by wsg/);
      assert.strictEqual(fs.readFileSync(teach, 'utf8'), '---\nname: wsg-teach\n---\nmine\n');
    });
    fs.writeFileSync(skill, fs.readFileSync(skill, 'utf8') + '\nold version\n');
    wsg(['install-skills']);
    it('an outdated file it wrote is replaced', () => assert.doesNotMatch(fs.readFileSync(skill, 'utf8'), /old version/));
    fs.writeFileSync(skill, '---\nname: wsg-new\n---\nmy own\n');
    const i3 = wsg(['install-skills']);
    it('a file without the marker is refused: exit 1', () => {
      assert.strictEqual(i3.code, 1);
      assert.match(i3.out, /not overwriting/);
      assert.strictEqual(fs.readFileSync(skill, 'utf8'), '---\nname: wsg-new\n---\nmy own\n');
    });
    it('without CLAUDE_CONFIG_DIR it goes to ~/.claude', () => {
      wsg(['install-skills'], { env: { CLAUDE_CONFIG_DIR: '' } });
      assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'wsg-new', 'SKILL.md')));
    });

    // --uninstall takes back only what install wrote: a file without the marker stays, exit 1.
    const S = require(path.join(ROOT, 'lib', 'skills.js'));
    it('install-skills --uninstall: an owner\'s file without the marker is kept, exit 1', () => {
      const u = wsg(['install-skills', '--uninstall']);
      assert.strictEqual(u.code, 1, u.all);
      assert.match(u.out, /kept/);
      assert.strictEqual(fs.readFileSync(skill, 'utf8'), '---\nname: wsg-new\n---\nmy own\n');
      assert.match(u.out, /wsg-teach\/SKILL\.md was not written by wsg/);
      assert.strictEqual(fs.readFileSync(teach, 'utf8'), '---\nname: wsg-teach\n---\nmine\n');
    });
    fs.rmSync(skill);
    fs.rmSync(teach);
    wsg(['install-skills']);
    fs.writeFileSync(path.join(claudeDir, 'skills', 'other.md'), 'not ours\n');
    const u1 = wsg(['install-skills', '--uninstall']);
    it('--uninstall removes every file it wrote: exit 0', () => {
      assert.strictEqual(u1.code, 0, u1.all);
      assert.match(u1.out, /removed/);
      for (const { file } of S.status({ ...ENV })) assert.ok(!fs.existsSync(file), file);
    });
    it('and the skill directory it emptied, but not skills/ itself', () => {
      assert.ok(!fs.existsSync(path.dirname(skill)));
      assert.ok(!fs.existsSync(path.dirname(teach)));
      assert.strictEqual(fs.readFileSync(path.join(claudeDir, 'skills', 'other.md'), 'utf8'), 'not ours\n');
      assert.ok(fs.statSync(path.join(claudeDir, 'agents')).isDirectory(), 'agents/ is the user\'s, never removed');
    });
    const u2 = wsg(['install-skills', '--uninstall']);
    it('--uninstall again: nothing installed, exit 0', () => {
      assert.strictEqual(u2.code, 0, u2.all);
      assert.match(u2.out, /not installed/);
    });
    it('--uninstall takes no value: exit 2', () => assert.strictEqual(wsg(['install-skills', '--uninstall=1']).code, 2));
    it('an outdated file it wrote is reported as outdated, an edited one without the marker as unmarked', () => {
      const env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(tmp, 'status-claude'), CODEX_HOME: path.join(tmp, 'status-codex') };
      assert.deepStrictEqual(S.status(env).map((x) => x.status), S.ITEMS.map(() => 'missing'));
      S.install(env);
      assert.deepStrictEqual(S.status(env).map((x) => x.status), S.ITEMS.map(() => 'current'));
      for (const { file } of S.status(env)) fs.appendFileSync(file, 'old\n');
      assert.deepStrictEqual(S.status(env).map((x) => x.status), S.ITEMS.map(() => 'outdated'));
      for (const { file } of S.status(env)) fs.writeFileSync(file, 'mine\n');
      assert.deepStrictEqual(S.status(env).map((x) => x.status), S.ITEMS.map(() => 'unmarked'));
    });
    it('an empty CLAUDE_CONFIG_DIR or CODEX_HOME means the default under HOME', () => {
      assert.strictEqual(S.configDir({ HOME: home, CLAUDE_CONFIG_DIR: '' }), path.join(home, '.claude'));
      assert.strictEqual(S.codexDir({ HOME: home, CODEX_HOME: '' }), path.join(home, '.codex'));
      assert.strictEqual(S.codexDir({ HOME: home, CODEX_HOME: '/x/codex' }), '/x/codex');
    });
    // The Codex agent only where Codex is: CODEX_HOME, ~/.codex or codex on PATH. PATH here is only
    // the fake claude's dir, so the machine's own codex is not found.
    {
      const bare = path.join(tmp, 'no-codex');
      const bareEnv = { HOME: path.join(bare, 'home'), CLAUDE_CONFIG_DIR: path.join(bare, 'claude'), CODEX_HOME: '', PATH: fakeBin };
      fs.mkdirSync(bareEnv.HOME, { recursive: true });
      const codexAgent = path.join(bareEnv.HOME, '.codex', 'agents', 'wsg-advisor.toml');
      const n = wsg(['install-skills'], { env: bareEnv });
      it('no Codex: its agent is skipped, the Claude parts installed, exit 0', () => {
        assert.strictEqual(n.code, 0, n.all);
        assert.match(n.out, /skipped .*wsg-advisor\.toml: no Codex here/);
        assert.ok(!fs.existsSync(path.join(bareEnv.HOME, '.codex')), '~/.codex was created');
        assert.ok(fs.existsSync(path.join(bareEnv.CLAUDE_CONFIG_DIR, 'agents', 'wsg-advisor.md')));
      });
      it('the skip is said in Russian too', () => assert.match(wsg(['install-skills'], { env: { ...bareEnv, WSG_LANG: 'ru' } }).out, /пропущен .*wsg-advisor\.toml: Codex здесь нет/));
      const codexBin = path.join(bare, 'codex-bin');
      fs.mkdirSync(codexBin);
      fs.writeFileSync(path.join(codexBin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const p = wsg(['install-skills'], { env: { ...bareEnv, PATH: `${fakeBin}:${codexBin}` } });
      it('codex on PATH: the agent goes to ~/.codex/agents', () => {
        assert.strictEqual(p.code, 0, p.all);
        assert.ok(fs.existsSync(codexAgent));
      });
      fs.rmSync(path.join(bareEnv.HOME, '.codex', 'agents'), { recursive: true });
      it('~/.codex there, codex not on PATH: installed too', () => {
        assert.strictEqual(wsg(['install-skills'], { env: bareEnv }).code, 0);
        assert.ok(fs.existsSync(codexAgent));
      });
      it('codexPresent: CODEX_HOME, ~/.codex or codex on PATH; an empty CODEX_HOME is unset', () => {
        const none = { HOME: path.join(bare, 'nobody'), PATH: fakeBin };
        assert.strictEqual(S.codexPresent({ ...none, CODEX_HOME: '' }), false);
        assert.strictEqual(S.codexPresent({ ...none, CODEX_HOME: path.join(bare, 'x') }), true);
        assert.strictEqual(S.codexPresent({ ...none, PATH: codexBin }), true);
        assert.strictEqual(S.codexPresent({ ...bareEnv }), true);
      });
    }
    // From here on Codex is "installed" under HOME, whatever this machine has.
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    wsg(['install-skills']);

    // The advisor: a thin agent file, the procedure in docs/advisor-guide.md.
    const advisorGuide = fs.readFileSync(path.join(ROOT, 'docs', 'advisor-guide.md'), 'utf8');
    const agentTpl = fs.readFileSync(path.join(ROOT, 'templates', 'claude', 'agents', 'wsg-advisor.md'), 'utf8');
    const agentFile = path.join(claudeDir, 'agents', 'wsg-advisor.md');
    const advisorItem = S.ITEMS.find((x) => x.name === 'wsg-advisor' && x.root === 'claude');
    const guardPath = path.join(ROOT, 'lib', 'advisor-guard.js');
    const cliPath = path.join(ROOT, 'bin', 'cli.js');
    it('install-skills writes the wsg-advisor agent, with its guard and CLI paths filled in', () => {
      const text = fs.readFileSync(agentFile, 'utf8');
      assert.strictEqual(text, agentTpl.split('<GUARD>').join(guardPath).split('<WSG_CLI>').join(cliPath));
      assert.strictEqual(text, S.render(advisorItem));
      assert.doesNotMatch(text, /<GUARD>|<WSG_CLI>/);
      assert.strictEqual(S.WSG_CLI, cliPath);
    });
    // Frontmatter Claude Code reads: first in the file; the top-level keys, one line each, apart
    // from hooks, which is a nested map.
    const front = (text) => {
      const m = text.match(/^---\n([\s\S]*?)\n---\n/);
      if (!m) return null;
      return Object.fromEntries(m[1].split('\n').filter((l) => !/^\s/.test(l)).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
    };
    const fm = front(agentTpl);
    it('the agent file starts with its frontmatter', () => assert.ok(fm, 'no frontmatter at the start'));
    it('its name is the file name, its description one line', () => {
      assert.strictEqual(fm.name, 'wsg-advisor');
      assert.ok(fm.description && fm.description.length > 80, fm.description);
      assert.deepStrictEqual(Object.keys(fm).filter((k) => !/^[a-zA-Z]+$/.test(k)), []);
    });
    it('no tools allowlist: it would hide the MCP tools', () => assert.ok(!('tools' in fm)));
    it('write tools and the tools that act for it are denied, no memory, the caller\'s model, in the foreground', () => {
      assert.deepStrictEqual(fm.disallowedTools.split(/,\s*/).sort(),
        ['Agent', 'CronCreate', 'Edit', 'EnterWorktree', 'ExitWorktree', 'Monitor', 'NotebookEdit', 'RemoteTrigger', 'Workflow', 'Write']);
      assert.ok(!('memory' in fm));
      assert.strictEqual(fm.model, 'inherit');
      assert.strictEqual(fm.background, 'false');
    });
    it('it carries the marker after the frontmatter', () => assert.match(agentTpl, /^---\n[\s\S]*?\n---\n<!-- generated by wsg -->\n/));
    // Read-only enforced: a PreToolUse hook in the frontmatter of the user-level agent, for every
    // tool ("*", the documented match-all matcher); `|| exit 2` blocks the call when node or the
    // guard is missing (any other code would not).
    // The hook command as Claude Code runs it: through the shell, the YAML '…' string undone.
    const hookCommand = (text) => text.match(/^ +command: '(.*)'$/m)[1].replace(/''/g, "'");
    const hookFor = (matcher) => `    - matcher: "${matcher}"\n      hooks:\n        - type: command\n          command: 'node "<GUARD>" || exit 2'\n`;
    it('its frontmatter has one PreToolUse hook, for every tool, running the guard', () => {
      const m = agentTpl.match(/^---\n([\s\S]*?\n)---\n/);
      assert.strictEqual(fm.hooks, '');
      assert.ok(m[1].endsWith(`hooks:\n  PreToolUse:\n${hookFor('*')}`), m[1]);
    });
    // Claude Code reads the frontmatter with a YAML parser, and a strict one (Ruby's Psych, say)
    // rejects what a lenient one lets by: ": " in a plain value is a mapping there. A reader for the
    // subset the agent file uses — maps and lists by indentation, plain, '…' and "…" values — that
    // fails on anything a strict parser could read differently.
    const strictYaml = (text) => {
      const ls = text.split('\n').filter((l) => l.trim() !== '');
      const indentOf = (l) => l.match(/^ */)[0].length;
      const scalar = (raw, at) => {
        if (raw.startsWith("'")) {
          if (!/^'(?:[^']|'')*'$/.test(raw)) throw new Error(`line ${at}: bad '…' value: ${raw}`);
          return raw.slice(1, -1).replace(/''/g, "'");
        }
        if (raw.startsWith('"')) {
          if (!/^"(?:[^"\\]|\\["\\])*"$/.test(raw)) throw new Error(`line ${at}: bad "…" value: ${raw}`);
          return JSON.parse(raw);
        }
        if (/^[-?:,[\]{}#&*!|>%@`]/.test(raw) || /: |\t| #/.test(raw) || raw.endsWith(':')) throw new Error(`line ${at}: a plain value a strict parser reads differently: ${raw}`);
        return raw;
      };
      let i = 0;
      const node = (indent) => {
        if (ls[i].slice(indent).startsWith('- ')) {
          const seq = [];
          while (i < ls.length && indentOf(ls[i]) === indent && ls[i].slice(indent).startsWith('- ')) {
            ls[i] = ' '.repeat(indent + 2) + ls[i].slice(indent + 2);
            seq.push(node(indent + 2));
          }
          return seq;
        }
        const map = {};
        while (i < ls.length && indentOf(ls[i]) === indent) {
          const m = ls[i].slice(indent).match(/^([A-Za-z][A-Za-z0-9_]*):(?: (.*))?$/);
          if (!m) throw new Error(`line ${i + 1}: not a key: value: ${ls[i]}`);
          if (m[1] in map) throw new Error(`line ${i + 1}: duplicate key ${m[1]}`);
          const at = ++i;
          if (m[2] === undefined || m[2] === '') {
            if (i >= ls.length || indentOf(ls[i]) <= indent) throw new Error(`line ${at}: ${m[1]} has no value`);
            map[m[1]] = node(indentOf(ls[i]));
          } else map[m[1]] = scalar(m[2], at);
        }
        if (i < ls.length && indentOf(ls[i]) > indent) throw new Error(`line ${i + 1}: unexpected indent: ${ls[i]}`);
        return map;
      };
      const r = node(0);
      if (i < ls.length) throw new Error(`line ${i + 1}: unexpected: ${ls[i]}`);
      return r;
    };
    const frontOf = (text) => text.match(/^---\n([\s\S]*?\n)---\n/)[1];
    it('the strict YAML reader rejects what a strict parser would', () => {
      assert.throws(() => strictYaml('description: a workspace: send it\n'), /plain value/);
      assert.throws(() => strictYaml('a: x #y\n'), /plain value/);
      assert.throws(() => strictYaml("a: 'it's'\n"), /bad '…'/);
      assert.throws(() => strictYaml('a: x\na: y\n'), /duplicate/);
      assert.throws(() => strictYaml('a: x\n   b: y\n'), /indent/);
      assert.throws(() => strictYaml('a:\n'), /no value/);
      assert.deepStrictEqual(strictYaml("a: x\nb:\n  - c: '*'\n    d: \"e\"\n"), { a: 'x', b: [{ c: '*', d: 'e' }] });
    });
    it('the rendered frontmatter is strict YAML, with the hooks in the documented shape', () => {
      for (const g of [guardPath, path.join(tmp, 'it\'s a "guard" $HOME `x`: #1', 'advisor-guard.js')]) {
        const text = S.render(advisorItem, g);
        const y = strictYaml(frontOf(text));
        assert.deepStrictEqual(Object.keys(y), ['name', 'description', 'disallowedTools', 'model', 'background', 'hooks']);
        assert.strictEqual(y.description, fm.description);
        assert.deepStrictEqual(y.hooks, { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand(text) }] }] });
        assert.match(y.hooks.PreToolUse[0].hooks[0].command, /^node ".*" \|\| exit 2$/);
        assert.deepStrictEqual(S.guardsOf(text), [g]);
      }
    });
    const shRun = (cmd, input, env = {}) => spawnSync('/bin/sh', ['-c', cmd], { input, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
    const blocked = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'printf x >> notes.md' } });
    const allowed = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cat notes.md' } });
    it('the installed hook command runs the package\'s guard: a write exits 2, a read 0', () => {
      const cmd = hookCommand(fs.readFileSync(agentFile, 'utf8'));
      assert.deepStrictEqual(S.guardsOf(fs.readFileSync(agentFile, 'utf8')), [guardPath]);
      assert.strictEqual(shRun(cmd, blocked).status, 2);
      assert.strictEqual(shRun(cmd, allowed).status, 0);
    });
    it('a guard path with spaces, quotes and $ survives YAML and the shell', () => {
      const odd = path.join(tmp, 'it\'s a "guard" $HOME `x`', 'advisor-guard.js');
      fs.mkdirSync(path.dirname(odd), { recursive: true });
      fs.copyFileSync(guardPath, odd);
      // The guard parses wsg's flags with the CLI's own table.
      fs.copyFileSync(path.join(ROOT, 'lib', 'flags.js'), path.join(path.dirname(odd), 'flags.js'));
      const text = S.render(advisorItem, odd);
      assert.deepStrictEqual(S.guardsOf(text), [odd]);
      assert.strictEqual(shRun(hookCommand(text), blocked).status, 2);
      assert.strictEqual(shRun(hookCommand(text), allowed).status, 0);
    });
    it('a missing guard or no node blocks instead of failing open', () => {
      const text = S.render(advisorItem, path.join(tmp, 'gone', 'advisor-guard.js'));
      assert.strictEqual(shRun(hookCommand(text), allowed).status, 2);
      assert.strictEqual(shRun(hookCommand(fs.readFileSync(agentFile, 'utf8')), allowed, { PATH: path.join(tmp, 'nothing') }).status, 2);
    });
    const contract = (text) => (text.match(/```\nANSWERED\n[\s\S]*?\n```/) || [''])[0];
    it('the agent and the guide give the same output contract', () => {
      assert.ok(contract(agentTpl), 'no contract in the agent file');
      assert.strictEqual(contract(agentTpl), contract(advisorGuide));
    });
    it('the contract has every section', () => {
      for (const sct of ['ANSWERED', 'OWNER (needs a human decision)', 'THIRD-PARTY', 'CONTEXT (setup/recon only)', 'PLAN REVIEW (only if commands were passed)', 'SKIPPED', 'FOR THE OWNER']) {
        assert.match(contract(agentTpl), new RegExp(`^${sct.replace(/[()/]/g, '\\$&')}$`, 'm'), sct);
      }
    });
    // The advisor runs the wsg that installed it, by path: `wsg` on PATH or npx could be another.
    it('the agent runs the guide with node and this package\'s CLI, never wsg from PATH or npx', () => {
      assert.match(agentTpl, /First run `node "<WSG_CLI>" guide advisor`/);
      assert.match(agentTpl, /never `wsg` from PATH, never `npx`/);
      assert.match(fs.readFileSync(agentFile, 'utf8'), new RegExp(`First run \`node "${cliPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" guide advisor\``));
      const codex = fs.readFileSync(path.join(ROOT, 'templates', 'codex', 'agents', 'wsg-advisor.toml'), 'utf8');
      for (const text of [agentTpl, codex, advisorGuide]) assert.doesNotMatch(text, /npx @korbutds|without wsg on PATH/);
      assert.match(advisorGuide, /the advisor runs wsg only as `node "<WSG_CLI>" …`, never `wsg` from PATH or\s+`npx`/);
    });
    it('the CLI command it is told to run passes the guard; bare wsg and npx do not', () => {
      const G = require(path.join(ROOT, 'lib', 'advisor-guard.js'));
      const text = fs.readFileSync(agentFile, 'utf8');
      const cmd = text.match(/First run `(node "[^`]*" guide advisor)`/)[1];
      assert.strictEqual(G.decide({ tool_name: 'Bash', tool_input: { command: cmd } }).allow, true, cmd);
      for (const c of ['wsg guide advisor', 'npx @korbutds/wsg guide advisor']) assert.strictEqual(G.decide({ tool_name: 'Bash', tool_input: { command: c } }).allow, false, c);
    });
    it('a CLI path with spaces and quotes survives the render and the guard', () => {
      const odd = path.join(tmp, 'it\'s a "cli" dir');
      fs.mkdirSync(path.join(odd, 'lib'), { recursive: true });
      for (const f of ['advisor-guard.js', 'flags.js']) fs.copyFileSync(path.join(ROOT, 'lib', f), path.join(odd, 'lib', f));
      const real = fs.realpathSync(odd);
      const text = S.render(advisorItem, path.join(real, 'lib', 'advisor-guard.js'), path.join(real, 'bin', 'cli.js'));
      const cmd = text.match(/First run `(node "(?:[^"\\]|\\.)*" guide advisor)`/)[1];
      const r = spawnSync(process.execPath, [path.join(real, 'lib', 'advisor-guard.js')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd } }), encoding: 'utf8' });
      assert.strictEqual(r.status, 0, r.stderr);
    });
    it('the agent and the guide keep the same hard rules', () => {
      for (const s of ['SKIPPED tracker: no tool available', '"default, reversible"', 'it is not a default: put it under OWNER, the finding in `note:`.', '`--reset-to-base`', 'get, list, search, fetch or find', 'wsg only as `node "<WSG_CLI>"`', '`add … --dry-run`', '`remove … --dry-run`']) {
        assert.ok(agentTpl.includes(s), `agent: ${s}`);
        assert.ok(advisorGuide.includes(s), `guide: ${s}`);
      }
    });
    // A question the owner's rules already answer with a no is not put to the owner again; doing
    // the step is.
    it('a no from the owner\'s rules is ANSWERED citing the rule, performing the step stays OWNER', () => {
      const rule = '"no — the owner opens MRs, AGENTS.md:<line>"';
      assert.ok(agentTpl.includes(rule), 'agent');
      assert.ok(advisorGuide.includes(rule), 'guide');
      assert.match(agentTpl, /An answer that would push, open an MR, message people[\s\S]{0,200}always goes under\s+OWNER/);
      assert.match(advisorGuide, /An\s+answer that would perform the step stays OWNER/);
    });
    // Only a plain "should I push?" is answered from the rules; asking for an exception to them is
    // the owner's call, even when the rules seem to settle it.
    it('a request for an exception to the owner\'s rules always stays OWNER', () => {
      const flat = (x) => x.replace(/\s+/g, ' ');
      for (const [name, text] of [['agent', agentTpl], ['guide', advisorGuide]]) {
        assert.ok(flat(text).includes('A request for an exception to the owner\'s rules always stays OWNER, whatever the rules say'), name);
        assert.ok(flat(text).includes('a plain "should I push or open the MR?"') || flat(text).includes('a plain question such as "should I push or open the MR?"'), name);
      }
      assert.doesNotMatch(agentTpl, /Push, MR, messages to people, `--reset-to-base`, scope changes and\s+exceptions to the owner's rules always go under OWNER/);
    });
    // A question only someone outside can answer goes to them, with a draft: an eval had it
    // under OWNER or without a draft in 2 runs of 5.
    it('a question only a named person or team outside can answer: THIRD-PARTY with a mandatory draft', () => {
      const flat = (x) => x.replace(/\s+/g, ' ');
      const rule = 'only a named person or team outside the workspace can answer';
      for (const [name, text] of [['agent', agentTpl], ['guide', advisorGuide]]) {
        assert.ok(flat(text).includes(rule), name);
        assert.match(flat(text), /always goes under THIRD-PARTY with a ready-to-send draft, never under ANSWERED or OWNER\. The draft is mandatory/, name);
      }
    });
    it('the agent and the guide forbid local file contents and secrets in a URL', () => {
      const flat = (x) => x.replace(/\s+/g, ' ');
      for (const text of [agentTpl, advisorGuide]) assert.ok(flat(text).includes('Never put the contents of a local file or a secret in a URL'));
    });
    it('README and the guide say what the guard does not see', () => {
      const flat = (x) => x.replace(/\s+/g, ' ');
      const readmeText = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
      const lim = flat(readmeText.slice(readmeText.indexOf('## Limitations'), readmeText.indexOf('## Documentation')));
      for (const x of ['**What the guard does not see.**', '(`updatedInput`)', 'shell snapshot', 'a hook that times out lets the call through',
        'never to put the contents of a local file or a secret in a URL', '`get_file` that saves the file']) assert.ok(lim.includes(x), x);
      for (const x of ['(`updatedInput`)', 'shell snapshot', 'a hook that times out lets the call through', 'WebFetch can send',
        '`core.fsmonitor` on `git status`', '`core.sshCommand` on `git ls-remote`', 'Any repository git runs in',
        'the guard limits git to the workspace and its sources', 'Their configs are trusted by the owner',
        '`git status` refreshes `.git/index`']) assert.ok(flat(advisorGuide).includes(x), x);
      for (const x of ['the config of any repository git runs in', 'limits git to the workspace and its sources',
        'only `.` or a remote the repository configures', 'refreshes `.git/index`']) assert.ok(lim.includes(x), x);
    });
    // The same agent for Codex: a TOML file, the instructions the same text as the Claude body.
    const codexTpl = fs.readFileSync(path.join(ROOT, 'templates', 'codex', 'agents', 'wsg-advisor.toml'), 'utf8');
    const codexFile = path.join(home, '.codex', 'agents', 'wsg-advisor.toml');
    const codexItem = S.ITEMS.find((x) => x.name === 'wsg-advisor' && x.root === 'codex');
    it('install-skills writes the Codex agent under ~/.codex/agents, with the CLI path filled in', () => {
      const text = fs.readFileSync(codexFile, 'utf8');
      assert.strictEqual(text, codexTpl.split('<WSG_CLI>').join(cliPath));
      assert.strictEqual(text, S.render(codexItem));
      assert.ok(text.includes(`First run \`node "${cliPath}" guide advisor\``));
      assert.doesNotMatch(text, /<WSG_CLI>/);
    });
    it('or under $CODEX_HOME/agents', () => {
      const codexHome = path.join(tmp, 'codex-home');
      assert.strictEqual(wsg(['install-skills'], { env: { CODEX_HOME: codexHome } }).code, 0);
      assert.strictEqual(fs.readFileSync(path.join(codexHome, 'agents', 'wsg-advisor.toml'), 'utf8'), S.render(codexItem));
    });
    it('the Codex agent starts with the marker as a comment', () => assert.match(codexTpl, /^# generated by wsg\n# `wsg install-skills` rewrites this file; delete the line above/));
    const tomlStr = (key) => (codexTpl.match(new RegExp(`^${key} = "([^"\\n]*)"$`, 'm')) || [])[1];
    it('its name is the file name, its description the Claude one but for the trigger', () => {
      assert.strictEqual(tomlStr('name'), 'wsg-advisor');
      const tail = (d) => d.slice(d.indexOf('. Fresh eyes'));
      assert.ok(tail(fm.description).length > 80);
      assert.strictEqual(tail(tomlStr('description')), tail(fm.description));
    });
    // Claude Code delegates on the description: a strong trigger first. Codex spawns on request.
    it('the descriptions start with when to call it: MUST BE USED for Claude Code, Spawn it for Codex', () => {
      const when = 'before you show the owner any list of questions, decisions or a plan with open points, and before you run `wsg add` or `wsg remove`.';
      assert.ok(fm.description.startsWith(`MUST BE USED ${when}`), fm.description);
      assert.ok(tomlStr('description').startsWith(`Spawn it ${when}`), tomlStr('description'));
    });
    it('its instructions are the body of the Claude agent', () => {
      const m = codexTpl.match(/^developer_instructions = '''\n([\s\S]*?)\n'''$/m);
      assert.ok(m, 'no developer_instructions literal string');
      const body = agentTpl.slice(agentTpl.indexOf('edits. -->\n') + 'edits. -->\n'.length).trim();
      assert.strictEqual(m[1], body);
    });
    it('Codex memories are off for it', () => assert.match(codexTpl, /^\[features\]\nmemories = false$/m));
    // The owner's view: a ready block at the end of the reply, forwarded as is, and the callers told so.
    it('the contract ends with FOR THE OWNER: a count line, then OWNER and THIRD-PARTY items only', () => {
      const flat = (x) => x.replace(/\s+/g, ' ');
      for (const text of [agentTpl, codexTpl, advisorGuide]) {
        assert.match(text, /\nFOR THE OWNER\n <N> questions settled by checks \(details on request\)\n Q<n>: <question> \| recommend: <option \+ reason> \| note: <what else it affects>\n Q<n>: to <role\/person> \| draft: <ready-to-send text, NOT sent>\n```/);
        assert.ok(flat(text).includes('FOR THE OWNER is always there, last: a ready block the caller forwards to the owner verbatim.'));
        assert.ok(flat(text).includes('nothing else: no evidence, no ANSWERED item, no CONTEXT, PLAN REVIEW or SKIPPED line.'));
        assert.match(text, /\n Q<n>: <question> \| why not checkable: <reason> \| recommend: <option \+ reason> \| note: <what else it affects> \| alt: <option>\n/);
        assert.ok(flat(text).includes('The owner must be able to accept a recommendation from this block alone.'));
        assert.ok(flat(text).includes('each with its question, recommendation and `note:` if it has one,'));
        assert.ok(flat(text).includes('write it in `note:` on the same line, with its path or link.'));
        assert.ok(flat(text).includes('there it is the one exception to "no evidence" and "no CONTEXT line".'));
      }
    });
    it('the agent descriptions tell the caller to show the FOR THE OWNER block as is', () => {
      const rule = 'Show the owner its FOR THE OWNER block as is, and nothing else from its reply.';
      assert.ok(front(agentTpl).description.includes(rule));
      assert.ok(/^description = "[^"\n]*"$/m.exec(codexTpl)[0].includes(rule));
    });
    // A minimal TOML reader for the subset the template uses: comments, [tables], key = "basic",
    // key = '''multi-line literal''', true/false. Anything else is an error, so a broken file fails.
    const parseToml = (text) => {
      const root = {};
      let table = root;
      const ls = text.split('\n');
      for (let i = 0; i < ls.length; i++) {
        const l = ls[i];
        if (/^\s*(#.*)?$/.test(l)) continue;
        let m = l.match(/^\[([A-Za-z0-9_-]+)\]\s*$/);
        if (m) {
          if (m[1] in root) throw new Error(`line ${i + 1}: table ${m[1]} again`);
          table = root[m[1]] = {};
          continue;
        }
        m = l.match(/^([A-Za-z0-9_-]+) = (.*)$/);
        if (!m) throw new Error(`line ${i + 1}: not a key = value: ${l}`);
        const [, key, raw] = m;
        if (key in table) throw new Error(`line ${i + 1}: duplicate key ${key}`);
        let v;
        if (raw === "'''") {
          const end = ls.indexOf("'''", i + 1);
          if (end < 0) throw new Error(`line ${i + 1}: unterminated ''' string`);
          v = ls.slice(i + 1, end).join('\n');
          i = end;
        } else if (/^"(?:[^"\\]|\\["\\nt])*"$/.test(raw)) {
          v = JSON.parse(raw);
        } else if (raw === 'true' || raw === 'false') {
          v = raw === 'true';
        } else throw new Error(`line ${i + 1}: unsupported value: ${raw}`);
        table[key] = v;
      }
      return root;
    };
    it('the minimal TOML reader rejects what Codex would', () => {
      assert.throws(() => parseToml('a = "x"\na = "y"\n'), /duplicate/);
      assert.throws(() => parseToml('a = "x\n'), /unsupported/);
      assert.throws(() => parseToml("a = '''\nx\n"), /unterminated/);
      assert.throws(() => parseToml('sandbox_mode = read-only\n'), /unsupported/);
    });
    it('the Codex agent is valid TOML with a read-only sandbox at the top level, as written and as installed', () => {
      assert.deepStrictEqual(Object.keys(parseToml(fs.readFileSync(codexFile, 'utf8'))), Object.keys(parseToml(codexTpl)));
      const t = parseToml(codexTpl);
      assert.strictEqual(t.name, 'wsg-advisor');
      assert.strictEqual(t.sandbox_mode, 'read-only');
      assert.strictEqual(typeof t.developer_instructions, 'string');
      assert.deepStrictEqual(t.features, { memories: false });
    });
    // Not verified: whether Codex applies an agent's sandbox_mode under a writable parent session.
    it('README, the guide and the agent file say only that the Codex advisor sets the read-only sandbox', () => {
      const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
      const unverified = /whether Codex\s+applies it to a spawned agent under a writable parent\s+session is not verified/;
      assert.match(advisorGuide, /In Codex the advisor's agent file sets `sandbox_mode = "read-only"`/);
      assert.match(advisorGuide, unverified);
      assert.match(readme.slice(readme.indexOf('## Limitations')), /In Codex the advisor's agent file sets\s+`sandbox_mode = "read-only"`/);
      assert.match(readme.slice(readme.indexOf('## Limitations')), unverified);
      assert.match(readme, /the Codex one sets `sandbox_mode = "read-only"`, which is\s+not verified to hold under a writable parent session/);
      assert.match(codexTpl, /whether Codex applies it to a spawned agent\n# under a writable parent session is not verified/);
      for (const text of [readme, advisorGuide, codexTpl]) assert.doesNotMatch(text, /runs in a read-only sandbox/);
    });
    it('README says a repository\'s own git config can run programs on allowed git calls', () => {
      const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
      const lim = readme.slice(readme.indexOf('## Limitations'), readme.indexOf('## Documentation'));
      for (const x of ['**A repository\'s own git config.**', '`core.fsmonitor`', '`diff.external`', '`core.sshCommand`', '`--ext-diff` and `--textconv`',
        'it cannot override', 'the workspace and the repositories you attach are trusted']) assert.ok(lim.includes(x), x);
    });
    it('--uninstall removes the Codex agent too, and keeps agents/', () => {
      const codexHome = path.join(tmp, 'codex-home');
      assert.strictEqual(wsg(['install-skills', '--uninstall'], { env: { CODEX_HOME: codexHome } }).code, 0);
      assert.ok(!fs.existsSync(path.join(codexHome, 'agents', 'wsg-advisor.toml')));
      assert.ok(fs.existsSync(path.join(codexHome, 'agents')));
      wsg(['install-skills']);
    });
    const ga = wsg(['guide', 'advisor']);
    it('wsg guide advisor prints the advisor guide', () => {
      assert.strictEqual(ga.code, 0);
      assert.strictEqual(ga.out, advisorGuide);
    });
    it('an unknown guide names the topics there are', () => assert.match(wsg(['guide', 'nope']).err, /advisor, setup/));
    it('every wsg command and flag in the advisor guide exists', () => assert.deepStrictEqual(flagProblems(advisorGuide), []));
    it('every wsg command and flag in the agent file exists', () => assert.deepStrictEqual(flagProblems(agentTpl), []));
    it('the advisor guide covers the evidence order, the caller and the inline mode', () => {
      for (const s of ['## The brief', '## Read-only', '## Procedure', '## What stays with the owner', '## Output contract',
        '## Plan review', '## wsg facts', '## For the caller', '## Inline mode', 'WS_ROOT', '**not** linked', 'log --oneline -- <file>', 'carryCandidates',
        'settings.local.json', 'not a sandbox', 'Show the owner the advisor\'s FOR THE OWNER block as is, and nothing\n  else from its reply']) assert.ok(advisorGuide.includes(s), s);
    });
    it('the evidence order is code, owner rules, wsg facts, siblings, history, tracker', () => {
      const order = ['**The code.**', '**The owner\'s rules.**', '**wsg facts.**', '**Sibling workspaces.**', '**History.**', '**The tracker**'];
      const at = order.map((x) => advisorGuide.indexOf(x));
      assert.ok(at.every((i) => i > 0), JSON.stringify(at));
      assert.deepStrictEqual([...at].sort((a, b) => a - b), at);
    });

    // The guide's facts and README say the same: an agent answers from the guide, a person reads README.
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const limitations = readme.slice(readme.indexOf('## Limitations'), readme.indexOf('## Documentation'));
    it('README and the guide both say the advisor is not a sandbox', () => {
      assert.match(limitations, /\*\*The advisor is not a sandbox\.\*\*/);
      assert.match(advisorGuide, /it is not a sandbox/);
    });
    it('README and the guide say a hook enforces the list for every tool, and where it does not run', () => {
      assert.match(limitations, /a `PreToolUse` hook in its agent file runs `lib\/advisor-guard\.js` before every\s+tool call/);
      assert.match(limitations, /anything else — another tool, a name it\s+cannot tell, a guard that cannot run — blocks the call/);
      assert.match(limitations, /That is a list, not a sandbox/);
      assert.match(limitations, /Claude Code skips\s+the hooks of a project-level agent in a folder it was not told to trust/);
      assert.match(limitations, /`wsg check` reports the agent as broken until\s+`wsg install-skills` runs again/);
      assert.match(readme, /a hook in its agent file blocks any tool\s+call that is not on its read-only list/);
      assert.match(advisorGuide, /a hook in its agent file checks every tool call\s+against a list/);
      assert.match(advisorGuide, /so is any other tool \(a subagent, a cron, a\s+workflow\) but MCP/);
      assert.match(advisorGuide, /the\s+first word is a read verb[\s\S]{0,120}or the second, after a prefix/);
      assert.match(advisorGuide, /each command, and each git subcommand, has\s+a table of the options it takes, and one not in it blocks/);
      assert.match(advisorGuide, /a `get_file` that saves the file, a `read_thread` that marks it\s+read: accepted, not blocked/);
      assert.match(advisorGuide, /A project-level copy of the agent in a folder Claude Code was not told to\s+trust runs\s+without the hook/);
      assert.doesNotMatch(advisorGuide, /None of this is enforced by wsg/);
    });
    // The list in the rules is the list the guard lets through: what the agent is told it may run, runs.
    it('every command in the advisor\'s Bash rule passes the guard', () => {
      const G = require(path.join(ROOT, 'lib', 'advisor-guard.js'));
      for (const c of ['git log', 'git show', 'git diff', 'git status', 'git blame', 'git grep', 'git rev-parse', 'git merge-base',
        'git ls-files', 'git for-each-ref', 'git symbolic-ref HEAD', 'git ls-remote', 'git branch --list', 'git branch -v', 'git branch -a',
        'git branch -r', 'git branch --show-current', 'git -C . log', ...['guide advisor', 'check', '--where', 'add x --dry-run',
          'remove x --dry-run'].map((x) => `node "${cliPath}" ${x}`), 'ls', 'cat a', 'head a', 'tail a', 'wc a', 'grep a b', 'rg a',
        'find .', 'pwd']) assert.ok(G.decide({ tool_name: 'Bash', tool_input: { command: c }, cwd: demo }).allow, c);
      // Up to the next item, whatever marks it: "2." in the agent, "-" in the guide.
      const rule = (text) => text.slice(text.indexOf('Bash only to read'), text.indexOf('Other tools, MCP included')).replace(/\s+/g, ' ').replace(/ (-|\d\.) $/, '');
      assert.ok(rule(agentTpl).includes('`git` `log`, `show`, `diff`, `status`, `blame`, `grep`, `rev-parse`, `merge-base`, `ls-files`, `for-each-ref`, `symbolic-ref`, `ls-remote`, `branch --list|-v|-a|-r|--show-current`'), rule(agentTpl));
      assert.ok(rule(agentTpl).includes('wsg only as `node "<WSG_CLI>"`: `guide`, `check`, `--where`, `add … --dry-run`, `remove … --dry-run`'), rule(agentTpl));
      assert.ok(rule(agentTpl).includes('`ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find`, `pwd`'));
      assert.ok(rule(agentTpl).includes('no pipes, redirection, `;`, `&&` or `$`'));
      assert.strictEqual(rule(advisorGuide), rule(agentTpl));
    });
    it('README and the guide agree on the facts the advisor answers from', () => {
      const facts = [
        [/reference directory, no git \| `--reference`/, /`--reference` is only for a directory \*\*not\*\* under git/],
        [/\(its branch is kept\)/, /takes only a clean worktree and keeps its branch/],
        [/only after `--delete-ignored`/, /they go only with `--delete-ignored`/],
        [/`skip-worktree` or `assume-unchanged`/, /`skip-worktree` or\s+`assume-unchanged`/],
        [/`--dry-run` prints the plan as JSON/, /prints the plan as JSON and changes nothing/],
        [/Push and MR creation are done manually by the owner|push ban/, /\*\*Push and MR\*\* are the owner's/],
      ];
      for (const [inReadme, inGuide] of facts) {
        assert.match(readme, inReadme);
        assert.match(advisorGuide, inGuide);
      }
    });
    it('README says the advisor runs wsg only by its CLI path, never from PATH or npx', () => {
      assert.match(readme, /the advisor runs wsg only as `node "<path>\/bin\/cli\.js" …` — never `wsg` from\s+PATH or `npx`/);
      assert.match(limitations, /The hook and CLI paths are absolute/);
    });
    it('README says CLAUDE.md has an advisor block too', () => assert.match(readme, /`CLAUDE\.md` has a block of the same name telling Claude Code to call the subagent/));
    it('README names refresh, install-skills --uninstall and the advisor guide', () => {
      for (const x of ['`wsg refresh [--dry-run] [--ws SLUG\\|PATH]`', '`wsg install-skills [--uninstall]`', '`wsg guide [setup\\|advisor\\|teach]`', '## Advisor', '**Codex.**', 'docs/advisor-guide.md']) assert.ok(readme.includes(x), x);
    });
    it('the version is 0.4.0, in package.json and its lock', () => {
      assert.strictEqual(wsg(['--version']).out, '0.4.0\n');
      const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
      assert.strictEqual(lock.version, '0.4.0');
      assert.strictEqual(lock.packages[''].version, '0.4.0');
    });

    const bare = wsg([]);
    it('bare wsg prints the usage and exits 0', () => {
      assert.strictEqual(bare.code, 0);
      assert.match(bare.out, /wsg new <slug>/);
    });
    it('an unknown command: exit 2', () => assert.strictEqual(wsg(['create']).code, 2));
    it('the 0.1 --dry-run is gone: exit 2', () => assert.strictEqual(wsg(['--dry-run']).code, 2));
    it('wsg check on a missing path: exit 2', () => assert.strictEqual(wsg(['check', path.join(tmp, 'nope')]).code, 2));
    it('the old --check spelling still works', () => assert.strictEqual(wsg(['--check', demo]).code, 0));
  }

  // The manual scripts against a fake claude: where the advisor comes from, and that the user's own
  // agent file is back afterwards. No real claude, no real ~/.claude.
  console.log('\nthe smoke and eval scripts');
  {
    const S = require(path.join(ROOT, 'lib', 'skills.js'));
    const rendered = S.render(S.ITEMS.find((x) => x.name === 'wsg-advisor' && x.root === 'claude'));
    const sx = path.join(tmp, 'scripts');
    const sbin = path.join(sx, 'bin');
    fs.mkdirSync(sbin, { recursive: true });
    const log = path.join(sx, 'claude.log');
    // Records each call: whether it had --agent, the user-level agent it saw, a project-level copy.
    // FAKE_INT: Ctrl+C on the script that started it — the topmost process whose command line is
    // exactly FAKE_INT, not a subshell of it.
    fs.writeFileSync(path.join(sbin, 'claude'), `#!/bin/sh
a="$CLAUDE_CONFIG_DIR/agents/wsg-advisor.md"
{
  printf 'call'
  for x in "$@"; do [ "$x" = --agent ] && printf ' --agent'; done
  printf '\\n'
  printf '%s\\n' "$@" > "$FAKE_LOG.args"
  if [ -f "$a" ]; then cp "$a" "$FAKE_LOG.agent"; echo user-agent; fi
  if [ -e "$PWD/.claude/agents/wsg-advisor.md" ]; then echo project-copy; fi
} >> "$FAKE_LOG"
# FAKE_KILL: SIGKILL instead, once the script's own stamped agent is there — no trap runs.
sig= cmd=
if [ -n "$FAKE_INT" ]; then sig=INT cmd=$FAKE_INT
elif [ -n "$FAKE_KILL" ] && grep -q '^<!-- wsg: temporary agent of ' "$a" 2>/dev/null; then sig=KILL cmd=$FAKE_KILL; fi
if [ -n "$sig" ]; then
  p=$PPID top=
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    [ "$(ps -o command= -p "$p")" = "$cmd" ] && top=$p
    p=$(ps -o ppid= -p "$p" | tr -d ' ')
  done
  [ -n "$top" ] && kill -"$sig" "$top"
  sleep 1
fi
# FAKE_APIERR=N: the first N calls end on an API error, as a gateway 502 does.
if [ -n "$FAKE_APIERR" ]; then
  n=$(cat "$FAKE_LOG.apierr" 2>/dev/null || echo 0)
  echo $((n + 1)) > "$FAKE_LOG.apierr"
  if [ "$n" -lt "$FAKE_APIERR" ]; then
    # FAKE_APIERR_PUSH / FAKE_APIERR_TOUCH: that attempt first runs git push / writes a file.
    if [ -n "$FAKE_APIERR_PUSH" ]; then echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"p1","name":"Bash","input":{"command":"git push origin main"}}]}}'; fi
    if [ -n "$FAKE_APIERR_TOUCH" ]; then echo x > "$PWD/touched-by-a-failed-attempt"; fi
    echo '{"type":"result","is_error":true,"api_error_status":'"\${FAKE_APIERR_STATUS:-502}"',"terminal_reason":"api_error","result":"API Error"}'
    exit 1
  fi
fi
# FAKE_STREAM_A / FAKE_STREAM_B: the stream-json a call with / without --agent prints.
s=$FAKE_STREAM_B
for x in "$@"; do [ "$x" = --agent ] && s=$FAKE_STREAM_A; done
if [ -n "$s" ]; then cat "$s"; else echo '{"type":"result","result":"none"}'; fi
`, { mode: 0o755 });
    // A fake codex: keeps the agent the eval's Codex stage loads.
    fs.writeFileSync(path.join(sbin, 'codex'), '#!/bin/sh\ncp "$CODEX_HOME/agents/wsg-advisor.toml" "$FAKE_LOG.codex"\necho "{}"\n', { mode: 0o755 });
    const cfgDir = path.join(sx, 'claude-config');
    const agent = path.join(cfgDir, 'agents', 'wsg-advisor.md');
    const runScript = (name, env = {}) => {
      fs.rmSync(log, { force: true });
      for (const x of ['agent', 'args', 'codex', 'apierr']) fs.rmSync(`${log}.${x}`, { force: true });
      const r = spawnSync('bash', [path.join(ROOT, 'test', name)], {
        encoding: 'utf8',
        env: { PATH: `${sbin}:${process.env.PATH}`, HOME: path.join(sx, 'home'), TMPDIR: sx, CLAUDE_CONFIG_DIR: cfgDir, FAKE_LOG: log, ...env },
        maxBuffer: 1 << 26,
      });
      const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
      const seen = fs.existsSync(`${log}.agent`) ? fs.readFileSync(`${log}.agent`, 'utf8') : null;
      const args = fs.existsSync(`${log}.args`) ? fs.readFileSync(`${log}.args`, 'utf8').split('\n') : [];
      const codex = fs.existsSync(`${log}.codex`) ? fs.readFileSync(`${log}.codex`, 'utf8') : null;
      return { code: r.status, all: r.stdout + r.stderr, calls, seen, args, codex };
    };
    const backup = `${agent}.wsg-test-backup`;
    const lock = path.join(path.dirname(agent), '.wsg-test-lock');
    const backups = () => [...fs.readdirSync(sx).filter((f) => f.startsWith('wsg-advisor-backup-')), ...(fs.existsSync(backup) ? [backup] : [])];
    // The agent a run installs: the render, with a stamp naming the script and its pid after the marker.
    const stampOf = (text) => (String(text).match(/^<!-- wsg: temporary agent of (test\/[a-z-]+\.sh), pid (\d+) -->\n/m) || []);
    const unstamped = (text) => String(text).replace(/^<!-- wsg: temporary agent of .*\n/m, '');
    for (const name of ['eval-advisor.sh', 'smoke-claude.sh']) {
      const env = name === 'eval-advisor.sh' ? { EVAL_RUNS: '1' } : {};
      const r1 = runScript(name, env);
      it(`${name}: claude sees this checkout's agent at the user level, as install-skills renders it`, () => {
        assert.match(r1.calls, /user-agent/, r1.all);
        assert.strictEqual(unstamped(r1.seen), rendered);
      });
      it(`${name}: stamped as a temporary agent of test/${name}, right after the marker`, () => {
        assert.strictEqual(stampOf(r1.seen)[1], `test/${name}`, r1.seen);
        assert.match(r1.seen, /<!-- generated by wsg -->\n<!-- wsg: temporary agent of /);
      });
      it(`${name}: no project-level copy of the agent`, () => assert.doesNotMatch(r1.calls, /project-copy/));
      it(`${name}: the agent it wrote is gone afterwards, and agents/ it made too`, () => {
        assert.ok(!fs.existsSync(agent));
        assert.ok(!fs.existsSync(path.dirname(agent)));
      });
      fs.mkdirSync(path.dirname(agent), { recursive: true });
      fs.writeFileSync(agent, 'mine\n');
      fs.writeFileSync(path.join(path.dirname(agent), 'other.md'), 'other\n');
      const r2 = runScript(name, env);
      it(`${name}: the user's own wsg-advisor.md is moved aside for the run and put back`, () => {
        assert.strictEqual(unstamped(r2.seen), rendered, r2.all);
        assert.strictEqual(fs.readFileSync(agent, 'utf8'), 'mine\n');
        assert.match(r2.all, /wsg-advisor\.md is in .*wsg-advisor\.md\.wsg-test-backup until this run ends/);
        assert.deepStrictEqual(backups(), []);
      });
      it(`${name}: nothing else in agents/ is touched`, () => assert.strictEqual(fs.readFileSync(path.join(path.dirname(agent), 'other.md'), 'utf8'), 'other\n'));
      const r3 = runScript(name, { ...env, FAKE_INT: `bash ${path.join(ROOT, 'test', name)}` });
      it(`${name}: Ctrl+C during a run puts it back too`, () => {
        assert.strictEqual(r3.code, 130, r3.all);
        assert.strictEqual(r3.calls.split('\n').filter((l) => l.startsWith('call')).length, 1, r3.calls);
        assert.strictEqual(fs.readFileSync(agent, 'utf8'), 'mine\n');
        assert.deepStrictEqual(backups(), []);
      });
      // SIGKILL runs no trap: the stamped agent and the backup stay, and the next run cleans up.
      const r4 = runScript(name, { ...env, FAKE_KILL: `bash ${path.join(ROOT, 'test', name)}` });
      it(`${name}: after a SIGKILL its stamped agent, the backup and the lock are left`, () => {
        assert.strictEqual(r4.code, null, r4.all);
        assert.ok(fs.existsSync(path.join(lock, 'pid')));
        assert.strictEqual(unstamped(fs.readFileSync(agent, 'utf8')), rendered);
        assert.strictEqual(fs.readFileSync(backup, 'utf8'), 'mine\n');
      });
      const S2 = require(path.join(ROOT, 'lib', 'skills.js'));
      it(`${name}: wsg check sees the leftover as a temporary agent`, () => {
        const st = S2.status({ HOME: path.join(sx, 'home'), CLAUDE_CONFIG_DIR: cfgDir, CODEX_HOME: path.join(sx, 'codex') }).find((x) => x.item.root === 'claude' && x.item.name === 'wsg-advisor');
        assert.strictEqual(st.status, 'temporary');
      });
      const r5 = runScript(name, env);
      it(`${name}: the next run removes the leftover and puts the user's file back`, () => {
        assert.match(r5.all, /removed .*wsg-advisor\.md: a temporary agent left by a test run \(pid \d+\)/);
        assert.match(r5.all, /put your .*wsg-advisor\.md back from .*wsg-test-backup, left by a test run/);
        assert.match(r5.all, /removed .*\.wsg-test-lock: left by a test run that is gone \(pid \d+\)/);
        assert.ok(!fs.existsSync(lock));
        assert.strictEqual(unstamped(r5.seen), rendered, r5.all);
        assert.strictEqual(fs.readFileSync(agent, 'utf8'), 'mine\n');
        assert.deepStrictEqual(backups(), []);
      });
      // A run still going: its agent is left alone, and this one stops before claude. Live means
      // the pid is there and its command names the script: this test process, as test/cli.test.js.
      const stamped = (script, pid) => rendered.replace('<!-- generated by wsg -->\n', `<!-- generated by wsg -->\n<!-- wsg: temporary agent of ${script}, pid ${pid} -->\n`);
      fs.writeFileSync(agent, stamped('test/cli.test.js', process.pid));
      const live = fs.readFileSync(agent, 'utf8');
      const r6 = runScript(name, env);
      it(`${name}: a stamped agent of a live run: exit 1, nothing touched, claude not run`, () => {
        assert.strictEqual(r6.code, 1, r6.all);
        assert.match(r6.all, /is the temporary agent of a run still going \(pid \d+\): wait for it to end/);
        assert.strictEqual(fs.readFileSync(agent, 'utf8'), live);
        assert.strictEqual(r6.calls, '');
        assert.ok(!fs.existsSync(lock), 'the lock is released on the way out');
      });
      // A pid the system gave to another process since: the stamp names test/<name>, the process
      // with that pid is not it.
      fs.writeFileSync(agent, stamped(`test/${name}`, process.pid));
      const r6b = runScript(name, env);
      it(`${name}: a stamp whose pid now belongs to another process is a leftover`, () => {
        assert.match(r6b.all, /removed .*wsg-advisor\.md: a temporary agent left by a test run/, r6b.all);
        assert.ok(!fs.existsSync(agent));
      });
      // The lock: one run at a time.
      fs.mkdirSync(lock, { recursive: true });
      fs.writeFileSync(path.join(lock, 'pid'), `${process.pid} test/cli.test.js\n`);
      fs.writeFileSync(agent, 'mine\n');
      const r6c = runScript(name, env);
      it(`${name}: the lock of a live run: exit 1, nothing touched, claude not run`, () => {
        assert.strictEqual(r6c.code, 1, r6c.all);
        assert.match(r6c.all, /another test run \(test\/cli\.test\.js, pid \d+\) is using .*wsg-advisor\.md: wait for it to end/);
        assert.strictEqual(r6c.calls, '');
        assert.strictEqual(fs.readFileSync(agent, 'utf8'), 'mine\n');
        assert.strictEqual(fs.readFileSync(path.join(lock, 'pid'), 'utf8'), `${process.pid} test/cli.test.js\n`);
      });
      fs.writeFileSync(path.join(lock, 'pid'), `${process.pid} test/${name}\n`);
      const r6d = runScript(name, env);
      it(`${name}: a lock whose pid now belongs to another process is taken over`, () => {
        assert.match(r6d.all, /removed .*\.wsg-test-lock: left by a test run that is gone/, r6d.all);
        assert.match(r6d.calls, /user-agent/);
        assert.strictEqual(fs.readFileSync(agent, 'utf8'), 'mine\n');
        assert.ok(!fs.existsSync(lock));
      });
      // Both a backup and a file of the user's: neither is overwritten.
      fs.writeFileSync(agent, 'new\n');
      fs.writeFileSync(backup, 'old\n');
      const r7 = runScript(name, env);
      it(`${name}: a backup and a file of the user's both there: exit 1, both kept`, () => {
        assert.strictEqual(r7.code, 1, r7.all);
        assert.match(r7.all, /keep the one you want, delete the other/);
        assert.strictEqual(fs.readFileSync(agent, 'utf8'), 'new\n');
        assert.strictEqual(fs.readFileSync(backup, 'utf8'), 'old\n');
      });
      fs.rmSync(path.dirname(agent), { recursive: true });
    }
    // Two runs that overlap: A.recover, B.recover, A.install, B.install, as two processes that wait
    // for each other's steps (files in ctl/). The user's own agent must survive. Without the lock
    // (NOLOCK=1 stubs it out), B must still refuse to move A's stamped agent over the backup.
    {
      const ctl = path.join(sx, 'ctl');
      const harness = path.join(sx, 'swap-run.sh');
      fs.writeFileSync(harness, `#!/usr/bin/env bash
set -euo pipefail
N="$1"; shift
SCRIPT="test/swap-run.sh"
. "$SRC/test/advisor-agent.sh"
if [ -n "\${NOLOCK:-}" ]; then acquire_lock() { :; }; release_lock() { :; }; fi
trap 'rc=$?; restore_advisor; echo "$rc" > "$CTL/$N.exit"' EXIT
for step in "$@"; do
  case "$step" in
    recover) recover_advisor ;;
    install) install_advisor ;;
    touch:*) : > "$CTL/\${step#touch:}" ;;
    wait:*) f="\${step#wait:}"; peer="\${f%%[0-9]*}"; n=0
      until [ -e "$CTL/$f" ] || [ -e "$CTL/$peer.exit" ]; do n=$((n + 1)); [ "$n" -lt 400 ] || exit 3; sleep 0.05; done ;;
  esac
done
`);
      const driver = `bash "${harness}" A recover touch:A1 wait:B1 install touch:A2 wait:B2 2>"$CTL/A.err" &
bash "${harness}" B wait:A1 recover touch:B1 wait:A2 install touch:B2 2>"$CTL/B.err" &
wait`;
      const overlap = (extra = {}) => {
        fs.rmSync(ctl, { recursive: true, force: true });
        fs.mkdirSync(ctl, { recursive: true });
        fs.mkdirSync(path.dirname(agent), { recursive: true });
        fs.writeFileSync(agent, 'mine\n');
        spawnSync('bash', ['-c', driver], { encoding: 'utf8', env: { ...process.env, SRC: ROOT, CTL: ctl, CLAUDE_CONFIG_DIR: cfgDir, ...extra } });
        const read = (f) => (fs.existsSync(path.join(ctl, f)) ? fs.readFileSync(path.join(ctl, f), 'utf8') : '');
        return { a: read('A.exit').trim(), b: read('B.exit').trim(), err: read('A.err') + read('B.err') };
      };
      const locked = overlap();
      it('two overlapping runs: the second stops at recover, the user\'s agent survives', () => {
        assert.strictEqual(locked.a, '0', locked.err);
        assert.strictEqual(locked.b, '1', locked.err);
        assert.match(locked.err, /another test run \(test\/swap-run\.sh, pid \d+\) is using/);
        assert.strictEqual(fs.readFileSync(agent, 'utf8'), 'mine\n');
        assert.deepStrictEqual(fs.readdirSync(path.dirname(agent)), ['wsg-advisor.md']);
      });
      const unlocked = overlap({ NOLOCK: '1' });
      it('without the lock: the second refuses to move the first one\'s agent aside, the user\'s agent survives', () => {
        assert.strictEqual(unlocked.a, '0', unlocked.err);
        assert.strictEqual(unlocked.b, '1', unlocked.err);
        assert.match(unlocked.err, /wsg-advisor\.md\.wsg-test-backup is already there: not moving/);
        assert.strictEqual(fs.readFileSync(agent, 'utf8'), 'mine\n');
        assert.deepStrictEqual(fs.readdirSync(path.dirname(agent)), ['wsg-advisor.md']);
      });
      // A run leaves another run's agent in place at exit: only its own stamp is removed.
      it('at exit a run removes only the agent with its own stamp', () => {
        const other = rendered.replace('<!-- generated by wsg -->\n', `<!-- generated by wsg -->\n<!-- wsg: temporary agent of test/cli.test.js, pid ${process.pid} -->\n`);
        fs.mkdirSync(path.dirname(agent), { recursive: true });
        const r = spawnSync('bash', ['-c', 'SCRIPT=test/swap-run.sh; . "$SRC/test/advisor-agent.sh"; AGENT_WRITTEN=1; printf "%s" "$OTHER" > "$AGENT"; restore_advisor; cat "$AGENT"'],
          { encoding: 'utf8', env: { ...process.env, SRC: ROOT, CLAUDE_CONFIG_DIR: cfgDir, OTHER: other } });
        assert.strictEqual(r.stdout, other, r.stderr);
      });
      fs.rmSync(path.dirname(agent), { recursive: true, force: true });
      fs.rmSync(ctl, { recursive: true, force: true });
    }
    // The reply the smoke test prints: cut by characters, so a multibyte one is never split.
    it('smoke: a reply in a multibyte script is printed on one line, cut at 300 characters, no error', () => {
      const def = fs.readFileSync(path.join(ROOT, 'test', 'smoke-claude.sh'), 'utf8').split('\n').find((l) => l.startsWith('snippet() {'));
      assert.ok(def, 'smoke-claude.sh has snippet()');
      const reply = `${'ответ '.repeat(40)}\nвторая строка ${'ё'.repeat(200)}`;
      const r = spawnSync('bash', ['-c', `${def}\nsnippet "$REPLY_TEXT"`], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'en_US.UTF-8', REPLY_TEXT: reply } });
      assert.strictEqual(r.stderr, '');
      assert.strictEqual(r.stdout, [...reply.replace(/\n/g, ' ')].slice(0, 300).join(''));
    });
    // The team step reads the init event's agents and tools, and the tool results, of a stream.
    it('smoke: init_list and tool_results read a stream-json reply', () => {
      const src = fs.readFileSync(path.join(ROOT, 'test', 'smoke-claude.sh'), 'utf8');
      const fn = (name) => {
        const m = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}$`, 'm').exec(src);
        assert.ok(m, `smoke-claude.sh has ${name}()`);
        return m[0];
      };
      const stream = [
        { type: 'system', subtype: 'init', agents: ['wsg-pm', { name: 'wsg-reviewer' }], tools: ['Read', 'Bash'] },
        { type: 'user', message: { content: [{ type: 'tool_result', content: 'PONG\nok' }, { type: 'tool_result', content: [{ type: 'text', text: 'x' }] }] } },
      ].map((e) => JSON.stringify(e)).join('\n');
      const sh = (body) => spawnSync('bash', ['-c', `${fn('init_list')}\n${fn('tool_results')}\n${body}`], { encoding: 'utf8', env: { ...process.env, STREAM: stream } });
      assert.strictEqual(sh('init_list "$STREAM" agents').stdout, 'wsg-pm\nwsg-reviewer');
      assert.strictEqual(sh('init_list "$STREAM" tools').stdout, 'Read\nBash');
      assert.strictEqual(sh('init_list "not json" agents').stdout, '');
      assert.strictEqual(sh('tool_results "$STREAM"').stdout, 'PONG ok [{"type":"text","text":"x"}]');
    });
    const calls = (r) => r.calls.split('\n').filter((l) => l.startsWith('call'));
    const both = runScript('eval-advisor.sh', { EVAL_RUNS: '1' });
    it('eval: by default stage A (--agent wsg-advisor) and stage B (the workspace agent) run', () => {
      assert.deepStrictEqual(calls(both), ['call --agent', 'call'], both.all);
    });
    const onlyB = runScript('eval-advisor.sh', { EVAL_RUNS: '2', EVAL_STAGES: 'B' });
    it('eval: EVAL_STAGES=B runs stage B alone', () => {
      assert.deepStrictEqual(calls(onlyB), ['call', 'call'], onlyB.all);
      assert.doesNotMatch(onlyB.all, /  (ok|FAIL)  A: /);
      assert.match(onlyB.all, / B: called the wsg-advisor subagent/);
    });
    // The grader on made-up sessions: the advisor's reply with FOR THE OWNER at the end, and what
    // the workspace agent then shows the owner.
    {
      const advisorReply = [
        'ANSWERED',
        ' Q1: no — CI also runs lint, typecheck and test:integration | evidence: .github/workflows/ci.yml:8 | confidence: high',
        ' Q2: no — the owner opens MRs himself | evidence: owner-rules.md:3 | confidence: high',
        ' Q3: no — --reference refuses a git repository, use --link | evidence: wsg guide advisor, wsg facts | confidence: high',
        ' Q4: no — the workspace root\'s .claude/ governs | evidence: wsg guide advisor, wsg facts | confidence: high',
        ' Q5: yes, default, reversible — it has no commits of its own | evidence: git for-each-ref -> same commit as main | confidence: high',
        ' Q6: at most 3 attempts, 10 minutes apart | evidence: billing-retry/notes.md:5 (SPEC-17) | confidence: high',
        ' Q7: target main, start from origin/main, default, reversible | evidence: git symbolic-ref -> origin/main | confidence: high',
        'THIRD-PARTY',
        ' Q8: to the spec author | draft: Does "notify the customer" mean email only, or a push too?',
        'PLAN REVIEW',
        ' wsg add shared-lib --reference — PROBLEM: --reference refuses a git repository -> wsg add shared-lib --link',
        'SKIPPED',
        ' tracker: no tool available',
        'FOR THE OWNER',
        ' 7 questions settled by checks (details on request)',
        ' Q8: to the spec author | draft: Does "notify the customer" mean email only, or a push too?',
      ].join('\n');
      const forOwner = advisorReply.slice(advisorReply.indexOf('FOR THE OWNER'));
      const stream = (name, final, withAdvisor = true) => {
        const f = path.join(sx, `${name}.jsonl`);
        const ev = withAdvisor ? [
          { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { subagent_type: 'wsg-advisor', prompt: 'brief' } }] } },
          { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: advisorReply }] }] } },
        ] : [];
        fs.writeFileSync(f, `${[...ev, { type: 'result', result: final }].map((e) => JSON.stringify(e)).join('\n')}\n`);
        return f;
      };
      const line = (r, name) => (r.all.split('\n').find((l) => l.includes(name)) || '').trim();
      const a = runScript('eval-advisor.sh', { EVAL_RUNS: '1', EVAL_STAGES: 'A', FAKE_STREAM_A: stream('a', advisorReply, false) });
      it('eval: the grader takes a reply that ends with FOR THE OWNER', () => {
        for (const n of ['hard: the reply has the contract', 'hard: at most 45 lines before FOR THE OWNER', 'every question placed exactly once', 'Q8 under THIRD-PARTY with a draft']) {
          assert.match(line(a, n), /^ok /, `${n}\n${a.all}`);
        }
        assert.match(line(a, 'FOR THE OWNER: the count line'), /^info .* — 1\/1$/, a.all);
      });
      const cases = [
        ['the block as is', `Checked with the advisor.\n\n${forOwner}`, true],
        ['an ANSWERED item as a Q line', `${forOwner}\n Q1: no — CI also runs lint, typecheck and test:integration`, false],
        ['an ANSWERED item\'s text without its number', `${forOwner}\nAlso: CI also runs lint, typecheck and test:integration.`, false],
        ['an OWNER item with a note: and a path', `${forOwner}\n Q9: Attach the repo as a worktree? | recommend: yes | note: the page is also opened by the checkout flow — src/checkout.js:12`, true],
        ['a SKIPPED section', `${forOwner}\nSKIPPED\n tracker: no tool available`, false],
        ['an evidence field', `${forOwner}\n(evidence: ci.yml:8)`, false],
        ['the whole reply', advisorReply, false],
      ];
      for (const [what, final, ok] of cases) {
        const r = runScript('eval-advisor.sh', { EVAL_RUNS: '1', EVAL_STAGES: 'B', FAKE_STREAM_B: stream('b', final) });
        it(`eval B, asserted: ${what} ${ok ? 'passes' : 'fails'} "the reply shows only the FOR THE OWNER content"`, () => {
          assert.match(line(r, 'the reply shows only the FOR THE OWNER content'), ok ? /^ok +B: .* — 1\/1 \(need 1\)$/ : /^FAIL +B: .* — 0\/1 \(need 1\)$/, r.all);
        });
      }
      // A run that ends on an API error is tried again; one that never gets a reply is not graded.
      const retried = runScript('eval-advisor.sh', { EVAL_RUNS: '1', EVAL_STAGES: 'A', FAKE_APIERR: '1', FAKE_STREAM_A: stream('a', advisorReply, false) });
      it('eval: a run that ends on an API error is tried again and graded on the retry', () => {
        assert.deepStrictEqual(calls(retried), ['call --agent', 'call --agent'], retried.all);
        assert.match(retried.all, /a1\.jsonl: an API error, trying again \(1 of 2\)/);
        assert.match(line(retried, 'hard: the reply has the contract'), /^ok +A: .* — 1\/1 \(every run\)$/, retried.all);
        assert.doesNotMatch(retried.all, /lost to an API error/);
        assert.strictEqual(retried.code, 0, retried.all);
      });
      const lostOne = runScript('eval-advisor.sh', { EVAL_RUNS: '2', EVAL_STAGES: 'A', FAKE_APIERR: '3', FAKE_STREAM_A: stream('a', advisorReply, false) });
      it('eval: a run lost to an API error in all 3 attempts is reported, the others graded without it', () => {
        assert.strictEqual(calls(lostOne).length, 4, lostOne.all);
        assert.match(lostOne.all, /a1\.jsonl: an API error in all 3 attempts: not graded/);
        assert.match(line(lostOne, 'lost to an API error'), /^info +A: lost to an API error, not graded — 1\/2$/, lostOne.all);
        assert.match(line(lostOne, 'hard: the reply has the contract'), /^ok +A: .* — 1\/1 \(every run\)$/, lostOne.all);
        assert.match(line(lostOne, 'fixture unchanged'), /^ok +A: .* — 2\/2 \(every run\)$/, lostOne.all);
        assert.match(line(lostOne, 'no git push'), /^ok +A: .* — 2\/2 \(every run\)$/, lostOne.all);
        assert.strictEqual(lostOne.code, 0, lostOne.all);
      });
      it('eval: a push or a write in a failed attempt still fails the hard checks', () => {
        const pushed = runScript('eval-advisor.sh', { EVAL_RUNS: '1', EVAL_STAGES: 'A', FAKE_APIERR: '1', FAKE_APIERR_PUSH: '1', FAKE_STREAM_A: stream('a', advisorReply, false) });
        assert.match(line(pushed, 'no git push'), /^FAIL +A: .* — 0\/1 \(every run\)$/, pushed.all);
        const touched = runScript('eval-advisor.sh', { EVAL_RUNS: '1', EVAL_STAGES: 'A', FAKE_APIERR: '3', FAKE_APIERR_TOUCH: '1' });
        assert.match(line(touched, 'fixture unchanged'), /^FAIL +A: .* — 0\/1 \(every run\)$/, touched.all);
      });
      it('eval: a 4xx API error is not retried', () => {
        const r = runScript('eval-advisor.sh', { EVAL_RUNS: '1', EVAL_STAGES: 'A', FAKE_APIERR: '1', FAKE_APIERR_STATUS: '400', FAKE_STREAM_A: stream('a', advisorReply, false) });
        assert.deepStrictEqual(calls(r), ['call --agent'], r.all);
        assert.match(line(r, 'hard: the reply has the contract'), /^FAIL /, r.all);
      });
      it('eval: one lost run of two in stage B counts once, the other is graded', () => {
        const r = runScript('eval-advisor.sh', { EVAL_RUNS: '2', EVAL_STAGES: 'B', FAKE_APIERR: '3', FAKE_STREAM_B: stream('b', `Checked with the advisor.\n\n${forOwner}`) });
        assert.match(line(r, 'lost to an API error'), /^info +B: lost to an API error, not graded — 1\/2$/, r.all);
        assert.match(line(r, 'the reply shows only the FOR THE OWNER content'), /^ok +B: .* — 1\/1 \(need 1\)$/, r.all);
        assert.strictEqual(r.code, 0, r.all);
      });
      const lostAll = runScript('eval-advisor.sh', { EVAL_RUNS: '1', EVAL_STAGES: 'A', FAKE_APIERR: '3' });
      it('eval: a stage with every run lost to an API error fails', () => {
        assert.match(line(lostAll, 'lost to an API error'), /^FAIL +A: lost to an API error, not graded — 1\/1$/, lostAll.all);
        assert.doesNotMatch(lostAll.all, /hard: the reply has the contract/);
        assert.notStrictEqual(lostAll.code, 0, lostAll.all);
      });
    }
    const onlyA = runScript('eval-advisor.sh', { EVAL_RUNS: '1', EVAL_STAGES: 'a' });
    it('eval: EVAL_STAGES=A runs stage A alone', () => assert.deepStrictEqual(calls(onlyA), ['call --agent'], onlyA.all));
    // The advisor runs wsg as node "<bin/cli.js>": the allowlist of the run lets that through.
    it('eval: the allowlist has wsg by this checkout\'s CLI path, quoted and not', () => {
      const cli = path.join(ROOT, 'bin', 'cli.js');
      for (const x of [`Bash(node "${cli}" guide*)`, `Bash(node ${cli} guide*)`, `Bash(node "${cli}" add * --dry-run*)`]) assert.ok(onlyA.args.includes(x), x);
    });
    const withCodex = runScript('eval-advisor.sh', { EVAL_RUNS: '1', EVAL_STAGES: 'A', EVAL_CODEX: '1' });
    it('eval: the Codex stage loads the Codex agent as install-skills renders it', () => {
      assert.strictEqual(withCodex.codex, S.render(S.ITEMS.find((x) => x.name === 'wsg-advisor' && x.root === 'codex')), withCodex.all);
      assert.doesNotMatch(withCodex.codex, /<WSG_CLI>/);
    });
    for (const bad of ['C', 'A,X', '']) {
      const r = runScript('eval-advisor.sh', { EVAL_RUNS: '1', EVAL_STAGES: bad });
      it(`eval: EVAL_STAGES=${JSON.stringify(bad)} is refused before anything runs: exit 2`, () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.match(r.all, /EVAL_STAGES must be A, B or A,B/);
        assert.strictEqual(r.calls, '');
        assert.ok(!fs.existsSync(agent));
      });
    }
  }

  console.log('\nthe package');
  {
    const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, npm_config_loglevel: 'silent' } });
    let files = [];
    try { files = JSON.parse(r.stdout)[0].files.map((f) => f.path); } catch { /* reported below */ }
    it('ships the templates and the guide', () => {
      for (const f of ['templates/claude/wsg-setup/SKILL.md', 'templates/claude/wsg-new/SKILL.md', 'templates/claude/agents/wsg-advisor.md',
        'templates/codex/agents/wsg-advisor.toml', 'docs/setup-guide.md', 'docs/advisor-guide.md']) assert.ok(files.includes(f), f);
    });
    it('ships no interview', () => assert.ok(!files.some((f) => /interview|pathPrompt/.test(f))));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    it('has no dependencies', () => assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0));
  }

  console.log('\nworkspaces from wsg 0.1');
  {
    // The same answers through generate.run, then the state file removed: what an old workspace
    // looks like to check, with nothing new to report.
    const answers = {
      kind: 'task', slug: 'like-old', title: 'T', ticket: '', ticketUrl: '', stateLabel: 'new feature',
      problem: ['p'], dod: ['d'], links: [], invariants: [], personalRules: false,
      repos: [{ name: 'web', path: web, mode: 'link', branch: '', base: '', target: 'main', verify: 'make test', note: '', carry: [], cloneNm: false }],
    };
    const ws = await quietAsync(() => generate.run(answers, cfg));
    fs.rmSync(path.join(ws, '.claude', 'wsg.json'));
    const out = report(ws, cfg);
    it('passes check', () => assert.strictEqual(out.code, 0, out.text));
    it('with no setup findings', () => assert.doesNotMatch(out.text, /setup|wsg\.json/));

    // The real thing: the 0.1.4 generator and check from git history, against the current check.
    const old = path.join(tmp, 'v014');
    fs.mkdirSync(old);
    const archive = spawnSync('sh', ['-c', `git -C "$1" archive c9d9fc7 lib | tar -x -C "$2"`, 'sh', ROOT, old], { encoding: 'utf8' });
    if (archive.status !== 0 || !fs.existsSync(path.join(old, 'lib', 'generate.js'))) {
      console.log('  skip  0.1.4 is not in this checkout\'s history');
    } else {
      const oldGen = require(path.join(old, 'lib', 'generate.js'));
      const oldCheck = require(path.join(old, 'lib', 'check.js'));
      const oldCfg = { ...cfg, WS_ROOT: path.join(tmp, 'ws-014') };
      const repo = (over) => ({ name: 'web', path: web, mode: 'link', branch: '', base: '', target: 'main', verify: '', note: '', carry: [], cloneNm: false, ...over });
      const cases = [
        ['task with a worktree, a link and invariants', { slug: 'o-task', invariants: ['on purpose'],
          repos: [repo({ name: 'api', path: api, mode: 'worktree', branch: 'old/task', base: 'main', verify: 'npm test' }), repo({ name: 'docs', path: docs, target: '—' })] }],
        ['task without a verification command', { slug: 'o-noverify', repos: [repo({})] }],
        ['documents only', { slug: 'o-docs', repos: [repo({ name: 'docs', path: docs, target: '—' })] }],
        ['no sources', { slug: 'o-none', repos: [] }],
        ['process', { slug: 'o-proc', kind: 'process', skillName: 'release', trigger: ['t'], varies: [], fixed: ['f'], steps: [], repos: [repo({ verify: 'make test' })] }],
      ];
      for (const [name, over] of cases) {
        const a = { ...answers, outOfScope: [], ...over };
        const dir = await quietAsync(() => oldGen.run(a, oldCfg));
        const was = (() => {
          const lines = [];
          const log = console.log;
          console.log = (x) => lines.push(String(x));
          let code;
          try { code = oldCheck.run(dir, oldCfg); } finally { console.log = log; }
          return { code, text: lines.join('\n') };
        })();
        const now = report(dir, oldCfg);
        it(`0.1.4 ${name}: the same report as before`, () => assert.strictEqual(now.text, was.text));
        it(`0.1.4 ${name}: the same exit code`, () => assert.strictEqual(now.code, was.code));
        const added = wsg(['add', docs, '--reference', '--ws', dir]);
        it(`0.1.4 ${name}: wsg add refuses it`, () => assert.strictEqual(added.code, 2));
      }
      for (const d of fs.readdirSync(oldCfg.WS_ROOT)) {
        const wt = path.join(oldCfg.WS_ROOT, d, 'api');
        if (fs.existsSync(path.join(wt, '.git'))) execFileSync('git', ['-C', api, 'worktree', 'remove', '--force', wt]);
      }
    }
  }

  for (const r of [api, web, path.join(tmp, 'web2')]) {
    try { execFileSync('git', ['-C', r, 'worktree', 'prune']); } catch { /* gone */ }
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(failed === 0 ? '\nall checks passed\n' : `\nfailed: ${failed}\n`);
  finished = true;
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.log(`\nFAIL  ${e.stack || e}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  finished = true;
  process.exit(1);
});
