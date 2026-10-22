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
const report = (dir, cfg) => {
  const lines = [];
  const log = console.log;
  console.log = (x) => lines.push(String(x));
  let code;
  try { code = check.run(dir, cfg); } finally { console.log = log; }
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
    const spans = [];
    let fence = false;
    for (const line of guide.split('\n')) {
      if (/^\s*```/.test(line)) { fence = !fence; continue; }
      if (fence) spans.push(line.trim());
      else for (const m of line.matchAll(/`([^`]+)`/g)) spans.push(m[1]);
    }
    const allFlags = new Set([...GLOBAL, ...Object.values(FLAGS).flatMap(Object.keys)]);
    const problems = [];
    for (const span of spans) {
      for (const m of span.matchAll(/(?:^|[\s(])wsg\s+([a-z][a-z-]*)([^|&;]*)/g)) {
        const cmd = m[1];
        if (!FLAGS[cmd]) { problems.push(`unknown command: wsg ${cmd}`); continue; }
        for (const f of m[2].match(/--[a-z][a-z-]*/g) || []) if (!(f in FLAGS[cmd])) problems.push(`wsg ${cmd} has no ${f}`);
      }
      if (/^--[a-z]/.test(span)) for (const f of span.match(/--[a-z][a-z-]*/g)) if (!allFlags.has(f)) problems.push(`no such flag: ${f}`);
    }
    it('every wsg command and flag in the guide exists', () => assert.deepStrictEqual(problems, []));
    it('the guide names every flag of add and remove', () => {
      const named = new Set(spans.flatMap((x) => x.match(/--[a-z][a-z-]*/g) || []));
      const missing = [...Object.keys(FLAGS.add), ...Object.keys(FLAGS.remove)].filter((f) => !named.has(f));
      assert.deepStrictEqual(missing, []);
    });
    it('the guide says how to record a ticket after wsg new', () => assert.match(guide, /`Ticket:` line[\s\S]{0,200}WSG_TRACKER_URL/));
    it('the guide says what --dry-run needs', () => assert.match(guide, /--dry-run[\s\S]{0,300}--branch/));

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
    const i2 = wsg(['install-skills']);
    it('running it again is a no-op', () => {
      assert.strictEqual(i2.code, 0);
      assert.match(i2.out, /up to date/);
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
    });
    fs.rmSync(skill);
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
      assert.strictEqual(fs.readFileSync(path.join(claudeDir, 'skills', 'other.md'), 'utf8'), 'not ours\n');
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
    wsg(['install-skills']);

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

  console.log('\nthe package');
  {
    const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, npm_config_loglevel: 'silent' } });
    let files = [];
    try { files = JSON.parse(r.stdout)[0].files.map((f) => f.path); } catch { /* reported below */ }
    it('ships the templates and the guide', () => {
      for (const f of ['templates/claude/wsg-setup/SKILL.md', 'templates/claude/wsg-new/SKILL.md', 'docs/setup-guide.md']) assert.ok(files.includes(f), f);
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
