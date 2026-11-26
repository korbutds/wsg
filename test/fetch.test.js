'use strict';

// A fresh base: `wsg add` and `wsg new --epic` run `git fetch` before a worktree's branch starts, so
// it starts from what origin has now; a dry run never fetches and says so; a task with a worktree
// gets the fresh-base block in AGENTS.md. Every command runs in a child process with its own HOME,
// WS_ROOT and config; origin is a local bare repository. Nothing here needs the network.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

process.env.WSG_LANG = 'en';

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const G = require(path.join(ROOT, 'lib', 'git.js'));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-fetch-')));
const home = path.join(tmp, 'home');
const wsRoot = path.join(tmp, 'ws');
for (const d of [home, wsRoot]) fs.mkdirSync(d, { recursive: true });

const ENV = {
  PATH: process.env.PATH,
  HOME: home,
  WSG_LANG: 'en',
  WSG_CONFIG: path.join(tmp, 'no-config'),
  WS_ROOT: wsRoot,
  CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
  CODEX_HOME: path.join(tmp, 'codex-config'),
  WSG_NO_LAUNCH: '1',
  GIT_CONFIG_NOSYSTEM: '1',
};
const wsg = (args, { env = {} } = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: tmp, encoding: 'utf8', env: { ...ENV, ...env }, maxBuffer: 1 << 28 });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
};
const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...ENV } }).trim();
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

// A repository with origin, a local bare one, and a clone of origin that pushes to it behind the
// repository's back: what a teammate's merge looks like to a main checkout that has not fetched.
let repoN = 0;
function makeRepo({ origin = true } = {}) {
  const name = `repo${++repoN}`;
  const dir = path.join(tmp, 'repos', name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
  if (!origin) return { dir };
  const bare = path.join(tmp, 'origins', `${name}.git`);
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  git(tmp, ['init', '-q', '--bare', '-b', 'main', bare]);
  git(dir, ['remote', 'add', 'origin', bare]);
  git(dir, ['push', '-q', 'origin', 'main']);
  git(dir, ['fetch', '-q', 'origin']);
  const peer = path.join(tmp, 'peers', name);
  git(tmp, ['clone', '-q', bare, peer]);
  git(peer, ['config', 'user.email', 'peer@example.com']);
  git(peer, ['config', 'user.name', 'peer']);
  // A commit on origin the repository has not fetched; returns its hash.
  let n = 0;
  const push = (branch = 'main') => {
    git(peer, ['checkout', '-q', '-B', branch, branch === 'main' ? 'origin/main' : 'HEAD']);
    fs.writeFileSync(path.join(peer, `p${++n}.ts`), `export const p = ${n};\n`);
    git(peer, ['add', '-A']);
    git(peer, ['commit', '-qm', `peer ${n}`]);
    git(peer, ['push', '-q', 'origin', branch]);
    return git(peer, ['rev-parse', 'HEAD']);
  };
  return { dir, bare, push };
}
const originMain = (dir) => git(dir, ['rev-parse', 'refs/remotes/origin/main']);
const newTask = (slug) => {
  const r = wsg(['new', slug, '--no-launch']);
  assert.strictEqual(r.code, 0, r.all);
  return path.join(wsRoot, slug);
};
const locks = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.lock')) out.push(p);
    }
  };
  walk(path.join(dir, '.git'));
  return out;
};
const FRESH = /<!-- \/wsg:verification -->\n<!-- wsg:fresh-base -->\nA task branch starts from `origin\/main` as of a `git fetch`, and origin moves on after that\.\n- When work starts/;

let failed = 0;
let passed = 0;
const it = (name, fn) => {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};
let finished = false;
process.on('exit', () => {
  if (!finished) { console.log('\nFAIL  the suite stopped before the end'); process.exitCode = 1; }
});

(async () => {
  console.log('wsg add fetches origin first');
  {
    const repo = makeRepo();
    const ws = newTask('fresh-a');
    it('a task without a source has no fresh-base block', () => assert.doesNotMatch(read(ws, 'AGENTS.md'), /wsg:fresh-base/));
    const before = originMain(repo.dir);
    const fresh = repo.push();

    const dry = wsg(['add', repo.dir, '--branch', 'task/fresh-a', '--ws', ws, '--dry-run']);
    it('--dry-run: refs/remotes/origin/main unchanged, the base said to be as of the last fetch', () => {
      assert.strictEqual(dry.code, 0, dry.all);
      assert.strictEqual(originMain(repo.dir), before);
      assert.ok(JSON.parse(dry.out).warnings.includes('dry run, no git fetch: origin/main is as of the last fetch; the real run fetches origin first'), dry.out);
    });

    const r = wsg(['add', repo.dir, '--branch', 'task/fresh-a', '--ws', ws]);
    const tree = path.join(ws, path.basename(repo.dir));
    it('the real add: exit 0, the new branch starts at the commit pushed after the last fetch', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(originMain(repo.dir), fresh);
      assert.strictEqual(git(tree, ['rev-parse', 'HEAD']), fresh);
      assert.doesNotMatch(r.all, /git fetch/);
    });
    it('AGENTS.md gets the fresh-base block after Verification, without a "new in wsg" warning', () => {
      assert.match(read(ws, 'AGENTS.md'), FRESH);
      assert.doesNotMatch(r.all, /fresh-base/);
    });

    const pushed = repo.push('task/fresh-b');
    const ws2 = newTask('fresh-b');
    const c = wsg(['add', repo.dir, '--branch', 'task/fresh-b', '--ws', ws2]);
    it('a branch pushed to origin since the last fetch is continued, not started anew', () => {
      assert.strictEqual(c.code, 0, c.all);
      assert.match(c.all, /continuing origin\/task\/fresh-b/);
      assert.strictEqual(git(path.join(ws2, path.basename(repo.dir)), ['rev-parse', 'HEAD']), pushed);
    });

    console.log('\nthe fresh-base block follows the worktrees');
    const rm = wsg(['remove', path.basename(repo.dir), '--ws', ws2]);
    it('removing the last worktree drops the block', () => {
      assert.strictEqual(rm.code, 0, rm.all);
      assert.doesNotMatch(read(ws2, 'AGENTS.md'), /wsg:fresh-base/);
    });
    // A task made by wsg 0.9.4: a worktree, no block.
    const agents = path.join(ws, 'AGENTS.md');
    fs.writeFileSync(agents, read(agents).replace(/<!-- wsg:fresh-base -->[\s\S]*?<!-- \/wsg:fresh-base -->\n/, ''));
    const rf = wsg(['refresh', '--ws', ws]);
    it('refresh puts it back in a task with a worktree, as news of wsg 0.9.5', () => {
      assert.strictEqual(rf.code, 0, rf.all);
      assert.match(read(agents), FRESH);
      assert.match(rf.all, /AGENTS\.md: added the <!-- wsg:fresh-base --> block \(new in wsg 0\.9\.5\)/);
    });

    const again = wsg(['refresh', '--ws', ws]);
    it('a render with the block there keeps the Verification placeholder: its bullets are no commands', () => {
      assert.strictEqual(again.code, 0, again.all);
      assert.match(read(agents), /<!-- wsg:verification -->\n- FILL IN: no command was set when the sources were attached\.\n<!-- \/wsg:verification -->\n<!-- wsg:fresh-base -->/);
      assert.match(again.all, /up to date/);
    });

    const linkRepo = makeRepo();
    const linkBefore = originMain(linkRepo.dir);
    linkRepo.push();
    const ws3 = newTask('fresh-link');
    const l = wsg(['add', linkRepo.dir, '--link', '--ws', ws3]);
    it('--link never fetches, and a link-only task has no block', () => {
      assert.strictEqual(l.code, 0, l.all);
      assert.strictEqual(originMain(linkRepo.dir), linkBefore);
      assert.doesNotMatch(read(ws3, 'AGENTS.md'), /wsg:fresh-base/);
    });
  }

  console.log('\nwhen the fetch cannot run');
  {
    const broken = makeRepo();
    git(broken.dir, ['remote', 'set-url', 'origin', path.join(tmp, 'nowhere.git')]);
    const ws = newTask('fetch-broken');
    const r = wsg(['add', broken.dir, '--branch', 'task/fetch-broken', '--ws', ws]);
    it('a broken remote: a warning, exit 0, the branch from origin/main as the last fetch left it', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.match(r.all, /WARN.* git fetch origin failed \(.+\): the base is as of the last fetch/);
      assert.strictEqual(git(path.join(ws, path.basename(broken.dir)), ['rev-parse', 'HEAD']), originMain(broken.dir));
    });

    const local = makeRepo({ origin: false });
    const ws2 = newTask('fetch-none');
    const n = wsg(['add', local.dir, '--branch', 'task/fetch-none', '--ws', ws2]);
    it('no origin: nothing fetched, no fetch warning, the local main as before', () => {
      assert.strictEqual(n.code, 0, n.all);
      assert.doesNotMatch(n.all, /git fetch/);
      assert.match(n.all, /no origin\/main: branching from the local main/);
    });
    const dn = wsg(['add', local.dir, '--branch', 'task/fetch-none-2', '--ws', newTask('fetch-none-2'), '--dry-run']);
    it('no origin, --dry-run: no "as of the last fetch" warning', () => {
      assert.strictEqual(dn.code, 0, dn.all);
      assert.doesNotMatch(dn.out, /last fetch/);
    });

    // An upload-pack that hangs: git fetch waits on it until wsg stops git with SIGTERM.
    const slow = makeRepo();
    git(slow.dir, ['config', 'remote.origin.uploadpack', 'sleep 3; git-upload-pack']);
    const ws3 = newTask('fetch-slow');
    const started = Date.now();
    const s = wsg(['add', slow.dir, '--branch', 'task/fetch-slow', '--ws', ws3], { env: { WSG_FETCH_TIMEOUT_MS: '500' } });
    const took = Date.now() - started;
    git(slow.dir, ['config', '--unset', 'remote.origin.uploadpack']);
    // A lock git left behind would make the next fetch fail: this one must go through.
    const after = spawnSync('git', ['-C', slow.dir, 'fetch', '-q', 'origin'], { encoding: 'utf8' });
    it('a fetch over the timeout is stopped fast: a warning, exit 0, the repository usable after it', () => {
      assert.strictEqual(s.code, 0, s.all);
      assert.match(s.all, /git fetch origin failed \(timed out after 0\.5s\)/);
      assert.ok(took < 30000, `${took}ms`);
      assert.strictEqual(after.status, 0, after.stderr);
      assert.deepStrictEqual(locks(slow.dir), []);
    });
  }

  console.log('\nthe ssh command of the owner is kept');
  {
    const { dir } = makeRepo({ origin: false });
    it('no ssh command anywhere: BatchMode, no prompt', () => {
      const env = G.fetchEnv(dir, { PATH: process.env.PATH });
      assert.strictEqual(env.GIT_TERMINAL_PROMPT, '0');
      assert.strictEqual(env.GIT_SSH_COMMAND, 'ssh -o BatchMode=yes -o ConnectTimeout=10');
    });
    it('GIT_SSH_COMMAND or GIT_SSH in the environment: left as it is', () => {
      assert.strictEqual(G.fetchEnv(dir, { GIT_SSH_COMMAND: 'ssh -i key' }).GIT_SSH_COMMAND, 'ssh -i key');
      assert.strictEqual(G.fetchEnv(dir, { GIT_SSH: '/usr/bin/my-ssh' }).GIT_SSH_COMMAND, undefined);
    });
    git(dir, ['config', 'core.sshCommand', 'ssh -i ~/.ssh/acme']);
    it('core.sshCommand set by the owner: no GIT_SSH_COMMAND over it', () => {
      assert.strictEqual(G.fetchEnv(dir, { PATH: process.env.PATH }).GIT_SSH_COMMAND, undefined);
    });
  }

  console.log('\nwsg new --epic fetches origin first');
  {
    const repo = makeRepo();
    assert.strictEqual(wsg(['new', 'shop', '--kind', 'epic', '--no-launch']).code, 0);
    const ep = path.join(wsRoot, 'shop');
    const a = wsg(['add', repo.dir, '--branch-template', 'task/{slug}', '--ws', ep]);
    assert.strictEqual(a.code, 0, a.all);
    it('an epic has no fresh-base block', () => assert.doesNotMatch(read(ep, 'AGENTS.md'), /wsg:fresh-base/));
    const before = originMain(repo.dir);
    const fresh = repo.push();
    const dry = wsg(['new', 'cart', '--epic', 'shop', '--dry-run']);
    it('--dry-run: nothing fetched, the base said to be as of the last fetch', () => {
      assert.strictEqual(dry.code, 0, dry.all);
      assert.strictEqual(originMain(repo.dir), before);
      assert.match(dry.out, /dry run, no git fetch: origin\/main is as of the last fetch/);
    });
    const r = wsg(['new', 'cart', '--epic', 'shop', '--no-launch']);
    const task = path.join(ep, 'cart');
    it('the task\'s branch starts at the commit pushed after the last fetch', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(git(path.join(task, path.basename(repo.dir)), ['rev-parse', 'HEAD']), fresh);
    });
    it('the task gets the fresh-base block', () => assert.match(read(task, 'AGENTS.md'), FRESH));
    const pushed = repo.push('task/pay');
    const p = wsg(['new', 'pay', '--epic', 'shop', '--no-launch']);
    it('a task branch pushed to origin since the last fetch is continued', () => {
      assert.strictEqual(p.code, 0, p.all);
      assert.strictEqual(git(path.join(ep, 'pay', path.basename(repo.dir)), ['rev-parse', 'HEAD']), pushed);
    });
    const nc = wsg(['new', 'notes', '--epic', 'shop', '--no-code', '--no-launch']);
    it('a task without code in the epic has no block', () => {
      assert.strictEqual(nc.code, 0, nc.all);
      assert.doesNotMatch(read(ep, 'notes', 'AGENTS.md'), /wsg:fresh-base/);
    });
  }

  // Every git fetch wsg runs, logged by a git on PATH in front of the real one.
  const fakeBin = path.join(tmp, 'fake-bin');
  const fetchLog = path.join(tmp, 'fetch.log');
  fs.mkdirSync(fakeBin, { recursive: true });
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(fakeBin, 'git'), `#!/bin/sh\n[ "$3" = fetch ] && echo "$2 $6" >> '${fetchLog}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const traced = { PATH: `${fakeBin}:${process.env.PATH}` };
  const fetches = () => (fs.existsSync(fetchLog) ? read(fetchLog).trim().split('\n').filter(Boolean) : []);

  console.log('\none fetch per repository and remote');
  {
    const repo = makeRepo();
    assert.strictEqual(wsg(['new', 'mall', '--kind', 'epic', '--no-launch']).code, 0);
    const ep = path.join(wsRoot, 'mall');
    assert.strictEqual(wsg(['add', repo.dir, '--branch-template', 'task/{slug}', '--ws', ep]).code, 0);
    fs.rmSync(fetchLog, { force: true });
    const r = wsg(['new', 'shoes', '--epic', 'mall', '--no-launch'], { env: traced });
    it('wsg new --epic: the epic\'s source fetched once, though fromEpic and resolve both ask', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.deepStrictEqual(fetches().map((l) => l.split(' ').pop()), ['origin']);
    });
    assert.strictEqual(wsg(['new', 'hats', '--epic', 'mall', '--sources', 'none', '--no-launch']).code, 0);
    fs.rmSync(fetchLog, { force: true });
    const a = wsg(['add', path.basename(repo.dir), '--ws', path.join(ep, 'hats')], { env: traced });
    it('wsg add <name> in a task of the epic: fetched once', () => {
      assert.strictEqual(a.code, 0, a.all);
      assert.deepStrictEqual(fetches().map((l) => l.split(' ').pop()), ['origin']);
    });
  }

  console.log('\n--base on another remote');
  {
    const repo = makeRepo();
    // upstream: a second bare repository with a branch x, fetched once, then moved on.
    const up = path.join(tmp, 'origins', 'upstream.git');
    git(tmp, ['clone', '-q', '--bare', repo.bare, up]);
    git(repo.dir, ['remote', 'add', 'upstream', up]);
    const upPeer = path.join(tmp, 'peers', 'upstream');
    git(tmp, ['clone', '-q', up, upPeer]);
    const upPush = () => {
      fs.writeFileSync(path.join(upPeer, `u${Date.now()}.ts`), 'export const u = 1;\n');
      git(upPeer, ['add', '-A']);
      git(upPeer, ['-c', 'user.email=peer@example.com', '-c', 'user.name=peer', 'commit', '-qm', 'upstream']);
      git(upPeer, ['push', '-q', 'origin', 'HEAD:x']);
      return git(upPeer, ['rev-parse', 'HEAD']);
    };
    upPush();
    git(repo.dir, ['fetch', '-q', 'upstream']);
    const beforeUp = git(repo.dir, ['rev-parse', 'refs/remotes/upstream/x']);
    const freshUp = upPush();
    const ws = newTask('up-a');
    const dry = wsg(['add', repo.dir, '--branch', 'task/up-a', '--base', 'refs/remotes/upstream/x', '--ws', ws, '--dry-run']);
    it('--dry-run, --base refs/remotes/upstream/x: nothing fetched, the warning names upstream', () => {
      assert.strictEqual(dry.code, 0, dry.all);
      assert.strictEqual(git(repo.dir, ['rev-parse', 'refs/remotes/upstream/x']), beforeUp);
      assert.ok(JSON.parse(dry.out).warnings.includes('dry run, no git fetch: refs/remotes/upstream/x is as of the last fetch; the real run fetches upstream first'), dry.out);
    });
    fs.rmSync(fetchLog, { force: true });
    const r = wsg(['add', repo.dir, '--branch', 'task/up-a', '--base', 'upstream/x', '--ws', ws], { env: traced });
    it('--base upstream/x: origin and upstream fetched, once each; the branch starts at upstream\'s new commit', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.deepStrictEqual(fetches().map((l) => l.split(' ').pop()), ['origin', 'upstream']);
      assert.strictEqual(git(path.join(ws, path.basename(repo.dir)), ['rev-parse', 'HEAD']), freshUp);
    });
  }

  finished = true;
  console.log(failed === 0 ? `\n${passed} checks passed\n` : `\nfailed: ${failed}, ${passed} passed\n`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  console.log(`\nFAIL  ${e.stack || e}`);
  process.exitCode = 1;
});
