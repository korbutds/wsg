'use strict';

// The commands as a user or an agent runs them: `wsg new`, `add`, `check`, `promote`, `guide`,
// each in a child process with its own HOME, WS_ROOT and Claude config dir.
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
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', input, env: { ...ENV, ...env } });
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
      ['an existing branch without --reuse-branch', [api, '--branch', 'feature/existing'], /--reuse-branch/],
      ['a base that does not resolve', [api, '--branch', 'b2', '--base', 'origin/nope'], /ref origin\/nope not found/],
      ['an unknown carry entry', [api, '--branch', 'b3', '--carry', '.env,secret.key'], /secret\.key is not among/],
      ['--branch on a link', [api, '--link', '--branch', 'x'], /--branch applies only to a worktree/],
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

  console.log('\nwsg add: an existing branch is reused only on request');
  {
    const tip = git(api, ['rev-parse', 'feature/existing']);
    const wsR = path.join(wsRoot, 'reuse');
    wsg(['new', 'reuse', '--no-launch']);
    const r = wsg(['add', api, '--branch', 'feature/existing', '--reuse-branch', '--base', 'main'], { cwd: wsR });
    it('--reuse-branch attaches it', () => assert.strictEqual(r.code, 0, r.all));
    it('the old head is saved in backup/', () => {
      const bk = branches(api).find((b) => b.startsWith('backup/feature-existing-'));
      assert.ok(bk, branches(api).join(' '));
      assert.strictEqual(git(api, ['rev-parse', bk]), tip);
    });
    it('the branch is reset to the base', () => assert.strictEqual(git(api, ['rev-parse', 'feature/existing']), git(api, ['rev-parse', 'main'])));
    execFileSync('git', ['-C', api, 'worktree', 'remove', '--force', path.join(wsR, 'api')]);
  }

  console.log('\nwsg add: a failure rolls back only this source');
  {
    const before = tree(demo);
    const beforeBranches = branches(web);
    const beforeWorktrees = worktrees(web);
    // A directory where the rule file goes: the worktree is made first, then writing the rule fails.
    const web2 = makeRepo('web2');
    fs.mkdirSync(path.join(demo, '.claude', 'rules', 'web2.md'));
    const snap = tree(demo);
    const r = wsg(['add', web2, '--branch', 'task/doomed'], { cwd: demo });
    it('the add fails', () => {
      assert.strictEqual(r.code, 1, r.all);
      assert.match(r.err, /Rolling back/);
    });
    it('the workspace is exactly as before, byte for byte', () => assert.deepStrictEqual(tree(demo), snap));
    it('no worktree is left registered', () => assert.strictEqual(worktrees(web2), 1));
    it('the created branch is deleted', () => assert.ok(!branches(web2).includes('task/doomed')));
    it('other sources are untouched', () => {
      assert.deepStrictEqual(branches(web), beforeBranches);
      assert.strictEqual(worktrees(web), beforeWorktrees);
    });
    fs.rmdirSync(path.join(demo, '.claude', 'rules', 'web2.md'));
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
      assert.match(r2.err, /only one of the <!-- wsg:layout --> markers/);
    });
    fs.writeFileSync(agentsFile, text.replace('<!-- wsg:layout -->\n<!-- /wsg:layout -->\n', ''));
    const r3 = wsg(['add', web, '--link'], { cwd: wsM });
    it('a deleted pair is put back, with a warning', () => {
      assert.strictEqual(r3.code, 0, r3.all);
      assert.match(r3.out, /WARN AGENTS\.md: the <!-- wsg:layout --> markers were missing/);
      assert.match(fs.readFileSync(agentsFile, 'utf8'), /## Layout\n<!-- wsg:layout -->\n- `web` — symlink/);
    });
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

  console.log('\nwsg guide, the rest of the CLI');
  {
    const g1 = wsg(['guide', 'setup']);
    const guide = fs.readFileSync(path.join(ROOT, 'docs', 'setup-guide.md'), 'utf8');
    it('wsg guide setup prints the guide', () => assert.strictEqual(g1.out, guide));
    it('wsg guide defaults to setup', () => assert.strictEqual(wsg(['guide']).out, guide));
    it('an unknown guide: exit 2', () => assert.strictEqual(wsg(['guide', 'nope']).code, 2));
    it('the guide covers the setup dialogue', () => {
      for (const s of ['wsg add', '--dry-run', '--reference', 'wsg check', 'notes.md', 'FILL IN', 'for-each-ref', 'restart']) assert.ok(guide.includes(s), s);
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

  console.log('\nthe package');
  {
    const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, npm_config_loglevel: 'silent' } });
    let files = [];
    try { files = JSON.parse(r.stdout)[0].files.map((f) => f.path); } catch { /* reported below */ }
    it('ships the templates and the guide', () => {
      for (const f of ['templates/claude/wsg-setup/SKILL.md', 'docs/setup-guide.md']) assert.ok(files.includes(f), f);
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
  finished = true;
  process.exit(1);
});
