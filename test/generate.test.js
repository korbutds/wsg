'use strict';

// Generation and the check run without a terminal: answers are supplied programmatically.
// Before this the only option was an end-to-end run with piped stdin, which broke
// whenever the questions shifted.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Messages are matched in English; on a machine with a Russian locale the UI would switch.
// Set before any lib module is loaded, and inherited by every child process.
process.env.WSG_LANG = 'en';

const ROOT = path.resolve(__dirname, '..');
const generate = require(path.join(ROOT, 'lib', 'generate.js'));
const check = require(path.join(ROOT, 'lib', 'check.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-test-'));
const wsRoot = path.join(tmp, 'ws');
const repo = path.join(tmp, 'api');
const docs = path.join(tmp, 'docs');
fs.mkdirSync(wsRoot, { recursive: true });
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(docs, { recursive: true });
fs.writeFileSync(path.join(docs, 'brief.md'), 'brief\n');

const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
git(['init', '-q', '-b', 'main', '.']);
git(['config', 'user.email', 'test@example.com']);
git(['config', 'user.name', 'test']);
fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=x\n');
git(['add', '-A']);
git(['commit', '-qm', 'init']);

const cfg = { WS_ROOT: wsRoot, WSG_GLOBAL_MEMORY: '', WSG_PARENT_CONTEXT: '' };

// ws as the user gets it: rendered by `wsg shell-init zsh`, placeholders replaced.
const renderWs = (lang) => execFileSync(process.execPath, [path.join(ROOT, 'bin', 'cli.js'), 'shell-init', 'zsh'],
  { encoding: 'utf8', env: { ...process.env, WSG_LANG: lang, WSG_CONFIG: path.join(tmp, 'no-config') } });
const wsZsh = path.join(tmp, 'wsg.zsh');
fs.writeFileSync(wsZsh, renderWs('en'));

let failed = 0;
const it = (name, fn) => {
  try { fn(); console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};
// Generator output is noise in a test run — it gets in the way of reading results.
const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
};
const quietAsync = async (fn) => {
  const log = console.log;
  const err = process.stderr.write;
  console.log = () => {};
  process.stderr.write = () => true;
  try { return await fn(); } finally { console.log = log; process.stderr.write = err; }
};
// Error message or an empty string: it() is synchronous, generation is not.
const failure = async (fn) => {
  try { await quietAsync(fn); return ''; } catch (e) { return e.message; }
};

const base = {
  ticket: 'PROJ-412',
  ticketUrl: 'https://tracker.example.com/browse/PROJ-412',
  problem: ['The token is not refreshed in background tabs.'],
  dod: ['Refresh works, tests are green.'],
  links: ['Spec | https://example.com/spec'],
  invariants: ['Retries are deliberately not added — the caller decides'],
  personalRules: false,
};

// A suite that stops half-way must not pass: a prompt waiting on a closed stdin, or a rejected
// promise, would otherwise end the process with code 0 and no summary.
let finished = false;
process.on('exit', () => {
  if (!finished) { console.log('\nFAIL  the suite stopped before the end'); process.exitCode = 1; }
});

(async () => {
  console.log('\ntask workspace');
  const task = {
    ...base,
    kind: 'task',
    slug: 'oauth-refresh',
    title: 'Token refresh',
    stateLabel: 'new feature',
    repos: [
      { name: 'api', path: repo, mode: 'worktree', branch: 'alice/task/oauth/PROJ-412', base: 'main', target: 'main', verify: 'echo ok', note: '', carry: ['.env'], cloneNm: false },
      { name: 'docs', path: docs, mode: 'link', branch: '', base: '', target: '—', verify: '', note: 'briefs', carry: [], cloneNm: false },
    ],
  };
  const ws = await quietAsync(() => generate.run(task, cfg));
  for (const f of ['CLAUDE.md', 'AGENTS.md', 'README.md', 'notes.md', 'mr-target-branch.txt',
    '.claude/settings.json', '.claude/rules/api.md', '.claude/rules/docs.md', '.claude/ws-kind',
    '.learnings/LEARNINGS.md', '.learnings/ERRORS.md']) {
    it(`created ${f}`, () => assert.ok(fs.existsSync(path.join(ws, f))));
  }
  it('kind recorded as task', () => assert.strictEqual(fs.readFileSync(path.join(ws, '.claude/ws-kind'), 'utf8').trim(), 'task'));
  it('worktree is on the right branch', () =>
    assert.strictEqual(execFileSync('git', ['-C', path.join(ws, 'api'), 'branch', '--show-current'], { encoding: 'utf8' }).trim(), 'alice/task/oauth/PROJ-412'));
  it('untracked file copied', () => assert.ok(fs.existsSync(path.join(ws, 'api', '.env'))));
  it('symlink to a non-git directory', () => assert.ok(fs.existsSync(path.join(ws, 'docs', 'brief.md'))));
  it('repo points to the first source', () => assert.strictEqual(fs.readlinkSync(path.join(ws, 'repo')), 'api'));
  it('invariant made it into AGENTS.md', () => assert.match(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8'), /Retries are deliberately not added/));
  it('no import of repo rules when the repo has no AGENTS.md', () =>
    assert.doesNotMatch(fs.readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8'), /@api\/AGENTS\.md/));
  it('settings.json is valid and has autoMemoryDirectory', () => {
    const j = JSON.parse(fs.readFileSync(path.join(ws, '.claude/settings.json'), 'utf8'));
    assert.ok(j.autoMemoryDirectory);
    assert.deepStrictEqual(j.permissions.additionalDirectories, [docs]);
  });
  it('rule for a non-git directory does not suggest git commands', () =>
    assert.doesNotMatch(fs.readFileSync(path.join(ws, '.claude/rules/docs.md'), 'utf8'), /git -C docs/));
  it('no placeholders left in a language other than English', () =>
    assert.doesNotMatch(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8') + fs.readFileSync(path.join(ws, 'notes.md'), 'utf8'), /[А-Яа-яЁё]/));
  it('notes.md does not call a non-git directory a shared checkout', () => {
    const notes = fs.readFileSync(path.join(ws, 'notes.md'), 'utf8');
    assert.match(notes, /\*\*docs\*\* — directory .*, not under git\./);
    assert.doesNotMatch(notes, /\*\*docs\*\* — shared checkout/);
  });
  it('--check passes', () => assert.strictEqual(quiet(() => check.run(ws, cfg)), 0));
  {
    // Lines Claude Code doesn't import: inside a code block, and an @mention.
    const claudeMd = path.join(ws, 'CLAUDE.md');
    const orig = fs.readFileSync(claudeMd, 'utf8');
    fs.writeFileSync(claudeMd, orig + '\n@backend-team owns the API\n\n```\n@missing/file.md\n```\n');
    it('--check skips code blocks and @mentions', () => assert.strictEqual(quiet(() => check.run(ws, cfg)), 0));
    fs.writeFileSync(claudeMd, orig + '\n@missing/file.md\n');
    it('--check still fails a real broken import', () => assert.strictEqual(quiet(() => check.run(ws, cfg)), 1));
    fs.writeFileSync(claudeMd, orig);
  }

  console.log('\nprocess workspace');
  const proc = {
    ...base,
    kind: 'process',
    slug: 'release-flow',
    title: 'Banner release',
    ticket: '',
    ticketUrl: '',
    stateLabel: "repeatable process; each run's ticket is an argument",
    skillName: 'release-banner',
    varies: ['campaign ticket'],
    fixed: ['repositories and conventions'],
    steps: ['Read the ticket', 'Create a branch'],
    repos: [{ name: 'api', path: repo, mode: 'link', branch: '', base: '', target: 'main', verify: 'echo ok', note: '', carry: [], cloneNm: false }],
  };
  const wp = await quietAsync(() => generate.run(proc, cfg));
  it('kind recorded as process', () => assert.strictEqual(fs.readFileSync(path.join(wp, '.claude/ws-kind'), 'utf8').trim(), 'process'));
  it('skill is manual-only and carries the steps', () => {
    const sk = fs.readFileSync(path.join(wp, '.claude/skills/release-banner/SKILL.md'), 'utf8');
    assert.match(sk, /^disable-model-invocation: true$/m);
    assert.match(sk, /1\. Read the ticket/);
    assert.match(sk, /Append a paragraph to `journal\.md`/);
  });
  it('run journal created', () => assert.ok(fs.existsSync(path.join(wp, 'journal.md'))));
  it('runs directory created', () => assert.ok(fs.existsSync(path.join(wp, 'runs'))));
  it('AGENTS.md explains how the procedure runs', () =>
    assert.match(fs.readFileSync(path.join(wp, 'AGENTS.md'), 'utf8'), /## How it runs/));
  it('--check passes', () => assert.strictEqual(quiet(() => check.run(wp, cfg)), 0));

  console.log('\nrollback on failure');
  const bad = { ...task, slug: 'rollback-me', repos: [{ ...task.repos[0], branch: 'alice/task/oauth/PROJ-412/deeper' }] };
  const badErr = await failure(() => generate.run(bad, cfg));
  it('a branch name conflict aborts creation', () => assert.match(badErr, /conflict|worktree add/i));
  it('no directory left after rollback', () => assert.ok(!fs.existsSync(path.join(wsRoot, 'rollback-me'))));
  {
    // The same failure, now after two new folders under one missing parent were made: the worktree
    // step comes after folder creation, so this is a real rollback, not a rejected run.
    const shared = path.join(tmp, 'rb-new');
    const mk = (n) => ({ name: n, path: path.join(shared, n), create: true, mode: 'link', branch: '', base: '', target: '—', verify: '', note: '', carry: [], cloneNm: false });
    const printed = [];
    const log = console.log;
    const err = process.stderr.write;
    console.log = (x) => printed.push(String(x));
    process.stderr.write = () => true;
    try {
      await generate.run({ ...bad, slug: 'rollback-dirs', repos: [...bad.repos, mk('a'), mk('b')] }, cfg);
    } catch { /* expected: the branch name conflict */ } finally { console.log = log; process.stderr.write = err; }
    it('the folders were created before the failure', () => assert.match(printed.join('\n'), /folder created: .*rb-new\/b/));
    it('rollback removes them and their shared parent', () => assert.ok(!fs.existsSync(shared)));
    fs.mkdirSync(path.join(shared, 'a'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'a', 'mine.txt'), 'x');
    await failure(() => generate.run({ ...bad, slug: 'rollback-dirs2', repos: [...bad.repos, mk('b')] }, cfg));
    it('a folder that already had files is not touched', () => assert.ok(fs.existsSync(path.join(shared, 'a', 'mine.txt'))));
    it('only the folder this run made is removed', () => assert.ok(!fs.existsSync(path.join(shared, 'b'))));
  }

  console.log('\nan existing branch is not reset without a backup');
  {
    const r2 = path.join(tmp, 'api2');
    fs.mkdirSync(r2, { recursive: true });
    const g2 = (args) => execFileSync('git', args, { cwd: r2, stdio: 'ignore' });
    g2(['init', '-q', '-b', 'main', '.']);
    g2(['config', 'user.email', 'test@example.com']);
    g2(['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(r2, 'a'), '1\n');
    g2(['add', '-A']); g2(['commit', '-qm', 'init']);
    g2(['checkout', '-q', '-b', 'feature/x']);
    fs.writeFileSync(path.join(r2, 'a'), '2\n');
    g2(['commit', '-qam', 'important commit']);
    const tip = execFileSync('git', ['-C', r2, 'rev-parse', 'feature/x'], { encoding: 'utf8' }).trim();
    g2(['checkout', '-q', 'main']);
    // a branch named `backup` makes any `backup/...` ref impossible: git branches are paths
    g2(['branch', 'backup']);
    const reuse = {
      ...base, kind: 'task', slug: 'reuse-branch', title: 'T', stateLabel: 'new feature',
      repos: [{ name: 'api2', path: r2, mode: 'worktree', branch: 'feature/x', base: 'main', target: 'main', verify: '', note: '', carry: [], cloneNm: false }],
    };
    const reuseErr = await failure(() => generate.run(reuse, cfg));
    it('creation refuses when the backup fails', () => assert.match(reuseErr, /failed to save a backup/));
    it("the existing branch's commits are intact", () =>
      assert.strictEqual(execFileSync('git', ['-C', r2, 'rev-parse', 'feature/x'], { encoding: 'utf8' }).trim(), tip));
  }

  console.log('\nreusing an existing branch keeps its upstream');
  {
    execFileSync('git', ['-C', repo, 'branch', 'feat/mr', 'main'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'config', 'branch.feat/mr.remote', 'origin'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'config', 'branch.feat/mr.merge', 'refs/heads/feat/mr'], { stdio: 'ignore' });
    const mr = { ...task, slug: 'reuse-mr', repos: [{ ...task.repos[0], branch: 'feat/mr', carry: [] }] };
    const wm = await quietAsync(() => generate.run(mr, cfg));
    const cfgOf = (key) => execFileSync('git', ['-C', repo, 'config', '--get', key], { encoding: 'utf8' }).trim();
    it('the MR branch still tracks itself, not the base', () => {
      assert.strictEqual(cfgOf('branch.feat/mr.remote'), 'origin');
      assert.strictEqual(cfgOf('branch.feat/mr.merge'), 'refs/heads/feat/mr');
    });
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', path.join(wm, 'api')], { stdio: 'ignore' });
  }

  console.log('\nnode_modules committed to the repository');
  {
    const r3 = path.join(tmp, 'action');
    fs.mkdirSync(path.join(r3, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(r3, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
    const g3 = (args) => execFileSync('git', args, { cwd: r3, stdio: 'ignore' });
    g3(['init', '-q', '-b', 'main', '.']);
    g3(['config', 'user.email', 'test@example.com']);
    g3(['config', 'user.name', 'test']);
    g3(['add', '-A']); g3(['commit', '-qm', 'init']);
    const act = { ...base, kind: 'task', slug: 'action', title: 'T', stateLabel: 'new feature',
      repos: [{ name: 'action', path: r3, mode: 'worktree', branch: 'task/a', base: 'main', target: 'main', verify: '', note: '', carry: [], cloneNm: true }] };
    const wa = await quietAsync(() => generate.run(act, cfg));
    it('the tracked node_modules is kept and not nested', () => {
      assert.ok(fs.existsSync(path.join(wa, 'action', 'node_modules', 'dep', 'index.js')));
      assert.ok(!fs.existsSync(path.join(wa, 'action', 'node_modules', 'node_modules')));
    });
    it('the worktree stays clean', () =>
      assert.strictEqual(execFileSync('git', ['-C', path.join(wa, 'action'), 'status', '--porcelain'], { encoding: 'utf8' }), ''));
    execFileSync('git', ['-C', r3, 'worktree', 'remove', '--force', path.join(wa, 'action')], { stdio: 'ignore' });
  }

  console.log('\nrollback deletes the created branch even without a remote');
  {
    const twoRepos = {
      ...task, slug: 'second-fails',
      repos: [
        { ...task.repos[0], branch: 'task/rollback-branch', carry: [] },
        // no such base — the second worktree add fails after the first branch was created
        { ...task.repos[0], name: 'api-copy', branch: 'task/other', base: 'nope', carry: [] },
      ],
    };
    const twoErr = await failure(() => generate.run(twoRepos, cfg));
    it('generation fails on the second base', () => assert.match(twoErr, /worktree add/));
    it('the first branch is deleted by rollback', () =>
      assert.strictEqual(execFileSync('git', ['-C', repo, 'branch', '--list', 'task/rollback-branch'], { encoding: 'utf8' }).trim(), ''));
  }

  console.log('\nCtrl+C during generation');
  {
    // The post-checkout hook fires inside worktree add, after the branch is created:
    // the worst moment to be interrupted. The hook drops a marker and the signal is sent
    // on it rather than on a timer — on a slow machine a timer could fire before the
    // handler is installed.
    const hook = path.join(repo, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(hook, '#!/bin/sh\n[ -n "$WSG_TEST_MARK" ] || exit 0\ntouch "$WSG_TEST_MARK"\nsleep 5\n', { mode: 0o755 });

    // Generation runs in a separate process: the signal must hit the whole group, as from a terminal.
    // run() is called from a stdin callback, like the real CLI after the interview: a pending
    // signal is delivered in a different event loop phase than from the main module.
    const runChild = (job, { selfKill = false } = {}) => {
      const jobFile = path.join(tmp, `${job.slug}.json`);
      const mark = path.join(tmp, `${job.slug}.mark`);
      fs.writeFileSync(jobFile, JSON.stringify({ job, cfg }));
      const child = `
        const fs = require('fs');
        const { job, cfg } = JSON.parse(fs.readFileSync(${JSON.stringify(jobFile)}, 'utf8'));
        if (${selfKill}) {
          // Ctrl+C while templates are written, when there are no child processes
          const write = fs.writeFileSync;
          fs.writeFileSync = (f, ...rest) => {
            if (String(f).endsWith('CLAUDE.md')) process.kill(process.pid, 'SIGINT');
            return write(f, ...rest);
          };
        }
        process.stdin.once('data', () => {
          process.stdin.pause();
          require(${JSON.stringify(path.join(ROOT, 'lib', 'generate.js'))}).run(job, cfg)
            .then(() => process.exit(0), (e) => process.exit(e.name === 'Interrupted' ? 130 : 1));
        });`;
      // set -m: a background job gets its own process group, and kill -INT -PID hits all of it.
      const script = selfKill
        ? 'echo go | node -e "$CHILD" >/dev/null 2>&1; echo $?'
        : 'set -m; (echo go | node -e "$CHILD" >/dev/null 2>&1) & pid=$!\n' +
          'for i in $(seq 100); do [ -e "$WSG_TEST_MARK" ] && break; sleep 0.1; done\n' +
          '[ -e "$WSG_TEST_MARK" ] || { kill $pid; echo no-mark; exit; }\n' +
          'kill -INT -$pid; wait $pid; echo $?';
      return require('node:child_process').spawnSync('bash', ['-c', script],
        { encoding: 'utf8', env: { ...process.env, CHILD: child, WSG_TEST_MARK: mark } }).stdout.trim();
    };
    const branches = () => execFileSync('git', ['-C', repo, 'branch', '--list'], { encoding: 'utf8' });
    const tipOf = (b) => execFileSync('git', ['-C', repo, 'rev-parse', b], { encoding: 'utf8' }).trim();

    const job = { ...task, slug: 'interrupted', repos: [{ ...task.repos[0], branch: 'task/interrupted', carry: [] }] };
    const code = runChild(job);
    it('new branch: generation ends as interrupted', () => assert.strictEqual(code, '130'));
    it('new branch: workspace directory rolled back', () => assert.ok(!fs.existsSync(path.join(wsRoot, 'interrupted'))));
    it('new branch: created branch deleted', () => assert.doesNotMatch(branches(), /task\/interrupted/));
    it('new branch: worktree not registered', () =>
      assert.doesNotMatch(execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' }), /interrupted/));

    // An existing branch with its own commit: -B moves it to main, rollback must restore it.
    execFileSync('git', ['-C', repo, 'branch', 'task/existing', 'main'], { stdio: 'ignore' });
    const own = execFileSync('git', ['-C', repo, 'commit-tree', '-p', 'task/existing', '-m', 'own', 'task/existing^{tree}'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', repo, 'branch', '-f', 'task/existing', own], { stdio: 'ignore' });
    // Tracking config whose remote-tracking ref is gone (as after fetch --prune):
    // @{upstream} doesn't resolve, but the setting is real and must survive rollback.
    execFileSync('git', ['-C', repo, 'config', 'branch.task/existing.remote', 'origin'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'config', 'branch.task/existing.merge', 'refs/heads/task/existing'], { stdio: 'ignore' });
    const reset = { ...job, slug: 'interrupted-reset', repos: [{ ...job.repos[0], branch: 'task/existing' }] };
    const code2 = runChild(reset);
    it('existing branch: generation interrupted', () => assert.strictEqual(code2, '130'));
    it('existing branch: restored to its previous head', () => assert.strictEqual(tipOf('task/existing'), own));
    it('existing branch: backup removed after restoring', () => assert.doesNotMatch(branches(), /backup\/task-existing/));
    const cfgOf = (key) => execFileSync('git', ['-C', repo, 'config', '--get', key], { encoding: 'utf8' }).trim();
    it('existing branch: tracking config restored', () => {
      assert.strictEqual(cfgOf('branch.task/existing.remote'), 'origin');
      assert.strictEqual(cfgOf('branch.task/existing.merge'), 'refs/heads/task/existing');
    });

    const late = { ...job, slug: 'interrupted-late', repos: [{ ...job.repos[0], branch: 'task/late' }] };
    fs.rmSync(hook);
    const code3 = runChild(late, { selfKill: true });
    it('Ctrl+C while writing files: generation interrupted', () => assert.strictEqual(code3, '130'));
    it('Ctrl+C while writing files: workspace rolled back', () => assert.ok(!fs.existsSync(path.join(wsRoot, 'interrupted-late'))));
    it('Ctrl+C while writing files: branch deleted', () => assert.doesNotMatch(branches(), /task\/late/));
  }

  console.log('\npaths, names and templates');
  {
    const config = require(path.join(ROOT, 'lib', 'config.js'));
    const interview = require(path.join(ROOT, 'lib', 'interview.js'));
    const T = require(path.join(ROOT, 'lib', 'templates.js'));
    it('a relative source becomes absolute', () =>
      assert.strictEqual(interview.resolveSource('src'), path.join(process.cwd(), 'src')));
    it('~ in a source is expanded', () =>
      assert.strictEqual(interview.resolveSource('~/x'), path.join(os.homedir(), 'x')));
    it('spaces in a source name are replaced', () =>
      assert.strictEqual(interview.sourceName('/x/My Project'), 'My-Project'));
    it('a slug is looked up in WS_ROOT', () => assert.strictEqual(config.resolveWs('oauth', cfg), path.join(wsRoot, 'oauth')));
    it('a dot is the current directory, not WS_ROOT', () => assert.strictEqual(config.resolveWs('.', cfg), process.cwd()));
    it('a path with ~ is expanded', () => assert.strictEqual(config.resolveWs('~/w/x', cfg), path.join(os.homedir(), 'w/x')));
    it('a path with a space is printed quoted', () => assert.strictEqual(T.sh("/a b/c'd"), `'/a b/c'\\''d'`));
    it('a plain path is printed as is', () => assert.strictEqual(T.sh('/a/b-c'), '/a/b-c'));
    it('a bare ticket number is kept for the tracker prefix', () => assert.strictEqual(interview.parseTicket('412'), '412'));
    it('a lowercase key stays free text (often a branch name)', () => assert.strictEqual(interview.parseTicket('fix-2'), ''));
    it('a ticket key is found inside a URL', () => assert.strictEqual(interview.parseTicket('https://t/browse/AB-7'), 'AB-7'));
    it('free text is not a ticket', () => assert.strictEqual(interview.parseTicket('fix auth'), ''));
    it('an invalid branch name is caught in the interview', () =>
      assert.match(interview.branchError(repo, 'feat x', [], []), /not a valid branch name/));
    it('a valid branch name passes', () => assert.strictEqual(interview.branchError(repo, 'feat/y', [], []), ''));
    {
      const g = require(path.join(ROOT, 'lib', 'git.js'));
      const sub = path.join(repo, 'pkg');
      fs.mkdirSync(sub);
      it('a subdirectory of a repo is under git', () => assert.ok(g.isRepo(sub)));
      it('but it is not a repo root, so no worktree for it', () => assert.ok(!g.isRepoRoot(sub)));
      it('a plain directory is not under git', () => assert.ok(!g.isRepo(docs)));
      fs.rmdirSync(sub);
      // A home directory under git (dotfiles) must not turn everything below it into a project.
      const home = path.join(tmp, 'home');
      fs.mkdirSync(path.join(home, 'notes'), { recursive: true });
      fs.mkdirSync(path.join(home, 'proj'));
      execFileSync('git', ['init', '-q', home]);
      execFileSync('git', ['init', '-q', path.join(home, 'proj')]);
      const inHome = (dir) => execFileSync(process.execPath, ['-e',
        `console.log(require(${JSON.stringify(path.join(ROOT, 'lib', 'git.js'))}).isRepo(${JSON.stringify(dir)}))`],
        { encoding: 'utf8', env: { ...process.env, HOME: home } }).trim();
      it('a plain directory in a git-tracked home is not a project', () => assert.strictEqual(inHome(path.join(home, 'notes')), 'false'));
      it('a real repository in a git-tracked home still is', () => assert.strictEqual(inHome(path.join(home, 'proj')), 'true'));
    }
    {
      // config.load in a child: HOME decides where relative paths go.
      const cfgFile = path.join(tmp, 'cfg-load');
      const loadWith = (text) => {
        fs.writeFileSync(cfgFile, text);
        const env = { ...process.env, HOME: tmp, WSG_CONFIG: cfgFile };
        delete env.WS_ROOT;
        return execFileSync(process.execPath, ['-e',
          `console.log(require(${JSON.stringify(path.join(ROOT, 'lib', 'config.js'))}).load().WS_ROOT)`],
          { encoding: 'utf8', env }).trim();
      };
      it('export WS_ROOT=… in the config is honored, as ws does', () =>
        assert.strictEqual(loadWith('export WS_ROOT=~/tasks\n'), path.join(tmp, 'tasks')));
      it('a relative WS_ROOT is taken from HOME', () =>
        assert.strictEqual(loadWith('WS_ROOT=rel/ws\n'), path.join(tmp, 'rel/ws')));
      it('a quoted ~ in WS_ROOT is expanded', () =>
        assert.strictEqual(loadWith('WS_ROOT="~/q"  # comment\n'), path.join(tmp, 'q')));
      const zshRoot = (text) => {
        fs.writeFileSync(cfgFile, text);
        return require('node:child_process').spawnSync('zsh', ['-f', '-c',
          `source ${JSON.stringify(wsZsh)}; print -r -- "$WS_ROOT"`],
          { encoding: 'utf8', env: { ...process.env, HOME: tmp, WSG_CONFIG: cfgFile, WS_ROOT: '' } }).stdout.trim();
      };
      const cfgWith = (text, key) => {
        fs.writeFileSync(cfgFile, text);
        const env = { ...process.env, HOME: tmp, WSG_CONFIG: cfgFile };
        delete env.WS_ROOT; delete env.WSG_TRACKER_URL;
        return execFileSync(process.execPath, ['-e',
          `console.log(require(${JSON.stringify(path.join(ROOT, 'lib', 'config.js'))}).load().${key})`],
          { encoding: 'utf8', env }).trim();
      };
      it('zsh-only syntax in the config does not cut the keys below it', () =>
        assert.strictEqual(cfgWith('WS_ROOT=/a\nif [[ $X == (a|b) ]]; then :; fi\nWSG_TRACKER_URL=https://t/\n', 'WSG_TRACKER_URL'), 'https://t/'));
      it('a broken config falls back to reading plain assignments', () =>
        assert.strictEqual(cfgWith('WS_ROOT=/a\n(\nWSG_TRACKER_URL=https://t/\n', 'WSG_TRACKER_URL'), 'https://t/'));
      it('ws resolves a relative and a quoted ~ WS_ROOT the same way', () => {
        assert.strictEqual(zshRoot('WS_ROOT=rel/ws\n').replace(/\/+/g, '/'), path.join(tmp, 'rel/ws'));
        assert.strictEqual(zshRoot('WS_ROOT="~/q"\n').replace(/\/+/g, '/'), path.join(tmp, 'q'));
      });
    }
    it('a skill description with a colon is quoted', () =>
      assert.match(T.skillMd({ skillName: 's', title: 'Release: checklist', steps: [] }), /^description: "Release: checklist"$/m));
  }

  console.log('\nws: launching the agent');
  {
    const cfgFile = path.join(tmp, 'ws-config');
    const zsh = (script) => require('node:child_process').spawnSync('zsh', ['-f', '-c',
      `source ${JSON.stringify(wsZsh)}; ${script}`],
      { encoding: 'utf8', input: '', env: { ...process.env, WS_ROOT: wsRoot, WSG_CONFIG: cfgFile, WSG_AGENT: '' } });
    const noAgent = zsh('ws oauth-refresh; print -r -- "pwd=$PWD"');
    it('no agent and no terminal: only cd and a hint', () => {
      assert.match(noAgent.stdout, /pwd=.*oauth-refresh$/m);
      assert.match(noAgent.stderr, /agent not configured/);
    });
    it('without a terminal the config is not written', () => assert.ok(!fs.existsSync(cfgFile)));
    fs.writeFileSync(cfgFile, `WSG_AGENT='print -r -- "agent in \${PWD:t}"'\n`);
    const custom = zsh('ws oauth-refresh');
    it('a custom command from the config runs in the workspace', () => assert.match(custom.stdout, /agent in oauth-refresh/));

    // Fake agents print their argv, one [arg] per argument.
    const fakeBin = path.join(tmp, 'fake-agents');
    fs.mkdirSync(fakeBin);
    for (const name of ['claude', 'codex']) {
      fs.writeFileSync(path.join(fakeBin, name),
        `#!/bin/sh\nprintf '${name}'; for a; do printf ' [%s]' "$a"; done; echo; echo "X=$WSG_TEST_X"\n`, { mode: 0o755 });
    }
    // HOME is the test dir so that ~/fake-agents/claude resolves; setup runs before ws, the
    // way .zshrc defines aliases and functions before the user types ws.
    const launch = (agent, args = '', setup = '') => {
      fs.writeFileSync(cfgFile, `WSG_AGENT=${agent}\n`);
      const r = require('node:child_process').spawnSync('zsh', ['-f', '-c',
        `${setup}\nsource ${JSON.stringify(wsZsh)}; ws oauth-refresh ${args}`],
        { encoding: 'utf8', input: '', env: { ...process.env, HOME: tmp, PATH: `${fakeBin}:${process.env.PATH}`,
          WS_ROOT: wsRoot, WSG_CONFIG: cfgFile, WSG_AGENT: '', WSG_TEST_X: '' } });
      return r.stdout + r.stderr;
    };
    it('claude with flags keeps session handling', () =>
      assert.match(launch(`'claude --model opus'`), /^claude \[--model\] \[opus\] \[-n\] \[oauth-refresh\]$/m));
    it('claude by absolute path is still claude', () =>
      assert.match(launch(`'${fakeBin}/claude'`), /^claude \[-n\] \[oauth-refresh\]$/m));
    it('an env prefix reaches claude', () => {
      const out = launch(`'WSG_TEST_X=1 claude'`);
      assert.match(out, /^claude \[-n\] \[oauth-refresh\]$/m);
      assert.match(out, /^X=1$/m);
    });
    it('a trailing comment does not swallow the flags', () =>
      assert.match(launch(`'claude # my default'`), /^claude \[-n\] \[oauth-refresh\]$/m));
    it('a command line with ; runs as written, flags not appended', () =>
      assert.match(launch(`'claude; echo after'`), /^claude\nX=\nafter$/m));
    it('~ in the command is expanded', () =>
      assert.match(launch(`'~/fake-agents/claude'`), /^claude \[-n\] \[oauth-refresh\]$/m));
    it('$VAR in the command is expanded', () =>
      assert.match(launch(`'$HOME/fake-agents/claude --x'`), /^claude \[--x\] \[-n\] \[oauth-refresh\]$/m));
    it('an alias for claude still applies', () =>
      assert.match(launch(`'claude'`, '', "alias claude='claude --from-alias'"), /^claude \[--from-alias\] \[-n\] \[oauth-refresh\]$/m));
    it('a claude function applies even with an env prefix', () =>
      assert.match(launch(`'WSG_TEST_X=1 claude'`, '', 'claude() { print -r -- "FUNC X=$WSG_TEST_X $*"; }'), /^FUNC X=1 -n oauth-refresh$/m));
    it('a redirection is not passed to claude as an argument', () =>
      assert.match(launch(`'claude 2>/dev/null'`), /^claude \[-n\] \[oauth-refresh\]$/m));
    it('a quoted ";" argument is not a separator', () =>
      assert.match(launch(`'claude --x ";"'`), /^claude \[--x\] \[;\] \[-n\] \[oauth-refresh\]$/m));
    it('a comment-only agent line is reported, not silently ignored', () =>
      assert.match(launch(`'# nothing'`), /has nothing to run/));
    it('--new starts a named session', () =>
      assert.match(launch(`'claude'`, '--new'), /^claude \[-n\] \[oauth-refresh\]$/m));
    it('codex with flags gets --add-dir for symlinked sources', () =>
      assert.match(launch(`'codex --full-auto'`), new RegExp(`^codex \\[--full-auto\\] \\[--add-dir\\] \\[${fs.realpathSync(docs).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]$`, 'm')));

    fs.rmSync(cfgFile);
    it('a number picks from the listed agents', () =>
      assert.match(zsh('_ws_pick_agent " 2 " claude codex && print -r -- "got=$REPLY"').stdout, /got=codex/));
    it('an out-of-range number is rejected', () => {
      const r = zsh('_ws_pick_agent 7 claude codex; print -r -- "rc=$?"');
      assert.match(r.stdout, /rc=1/);
      assert.match(r.stderr, /no option 7/);
    });
    it('any other answer is a command', () =>
      assert.match(zsh('_ws_pick_agent "gemini --yolo" claude && print -r -- "got=$REPLY"').stdout, /got=gemini --yolo/));
    fs.writeFileSync(cfgFile, 'WS_ROOT="/x"');
    zsh('_ws_save_agent "gemini --yolo" >/dev/null');
    it('saving after a line without a final newline keeps both lines', () =>
      assert.strictEqual(fs.readFileSync(cfgFile, 'utf8'), 'WS_ROOT="/x"\nWSG_AGENT=\'gemini --yolo\'\n'));
    fs.writeFileSync(cfgFile, 'WS_ROOT="/x"\n');
    zsh('_ws_save_agent codex >/dev/null');
    it('saving after a proper final newline adds no blank line', () =>
      assert.strictEqual(fs.readFileSync(cfgFile, 'utf8'), 'WS_ROOT="/x"\nWSG_AGENT=\'codex\'\n'));

    fs.writeFileSync(cfgFile, '# WSG_AGENT="claude"\nWS_ROOT="/x"\n\nWSG_AGENT=codex\nexport WSG_AGENT=\'old\'\n');
    zsh('_ws_save_agent claude >/dev/null');
    it('choosing again replaces the saved agent and keeps comments and blank lines', () =>
      assert.strictEqual(fs.readFileSync(cfgFile, 'utf8'), '# WSG_AGENT="claude"\nWS_ROOT="/x"\n\nWSG_AGENT=\'claude\'\n'));

    // One shell, two calls: the second sees the config as it is now.
    const reread = require('node:child_process').spawnSync('zsh', ['-f', '-c',
      `source ${JSON.stringify(wsZsh)}; ws oauth-refresh; print -r -- "WSG_AGENT=codex" > ${JSON.stringify(cfgFile)}; ws oauth-refresh; : > ${JSON.stringify(cfgFile)}; ws oauth-refresh`],
      { encoding: 'utf8', input: '', env: { ...process.env, HOME: tmp, PATH: `${fakeBin}:${process.env.PATH}`,
        WS_ROOT: wsRoot, WSG_CONFIG: cfgFile, WSG_AGENT: '', WSG_TEST_X: '' } });
    it('a changed agent applies in an open shell', () => assert.match(reread.stdout, /^claude .*\n(.*\n)*codex /m));
    it('a removed agent line is not remembered by the shell', () => assert.match(reread.stderr, /agent not configured/));
    it('an agent set in .zshrc is kept when the config has none', () => {
      fs.writeFileSync(cfgFile, 'WS_ROOT="/x"\n');
      const r = require('node:child_process').spawnSync('zsh', ['-f', '-c',
        `WSG_AGENT=codex; source ${JSON.stringify(wsZsh)}; ws oauth-refresh; ws oauth-refresh`],
        { encoding: 'utf8', input: '', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, WS_ROOT: wsRoot, WSG_CONFIG: cfgFile } });
      assert.strictEqual((r.stdout.match(/^codex /gm) || []).length, 2);
    });
    it('--claude runs claude whatever the setting says', () =>
      assert.match(launch(`'codex --full-auto'`, '--claude'), /^claude \[-n\] \[oauth-refresh\]$/m));
    fs.writeFileSync(cfgFile, "WSG_AGENT='codex'\n");
    const again = zsh('ws --agent; print -r -- "pwd=$PWD"');
    it('ws --agent without a terminal explains and keeps the setting', () => {
      assert.match(again.stderr, /agent not configured|WSG_AGENT/);
      assert.strictEqual(fs.readFileSync(cfgFile, 'utf8'), "WSG_AGENT='codex'\n");
      assert.doesNotMatch(again.stdout, /oauth-refresh/);
    });

    fs.rmSync(cfgFile);
    const list = (agentLine) => zsh(`print -r -- ${JSON.stringify(agentLine)} > ${JSON.stringify(cfgFile)}; ws`).stdout;
    it('the listing rereads the config saved by another tab', () =>
      assert.doesNotMatch(list("WSG_AGENT=codex"), /sessions:/));
    fs.rmSync(cfgFile);
    it('the listing counts Claude sessions for claude with flags', () =>
      assert.match(list("WSG_AGENT='claude --model opus'"), /sessions: \d+/));
  }

  console.log('\n--promote');
  {
    const promote = require(path.join(ROOT, 'lib', 'promote.js'));
    const notWs = path.join(tmp, 'not-a-workspace');
    fs.mkdirSync(notWs);
    const rejects = async (name, dir) => {
      const before = fs.readdirSync(dir).sort();
      try {
        await promote.run(dir, cfg);
        failed++; console.log(`  FAIL  ${name}\n        did not throw`);
      } catch (e) {
        it(name, () => assert.match(e.message, /does not look like a wsg workspace/));
      }
      it(`${name}: nothing created`, () => assert.deepStrictEqual(fs.readdirSync(dir).sort(), before));
    };
    await rejects('an empty directory is rejected', notWs);
    // a repository with its own CLAUDE.md is not a workspace; its checkout must not be written to
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# repo\n');
    await rejects('a repository with CLAUDE.md is rejected', repo);
    fs.rmSync(path.join(repo, 'CLAUDE.md'));

    // The successful path: a task becomes a process and still passes the check.
    const pm = await quietAsync(() => generate.run({ ...base, kind: 'task', slug: 'promote-me', title: 'T',
      stateLabel: 'new feature', repos: [{ name: 'docs', path: docs, mode: 'link', branch: '', base: '', target: '—', verify: '', note: '', carry: [], cloneNm: false }] }, cfg));
    it('docs-only workspace: verification says none is needed instead of FILL IN', () => {
      const agents = fs.readFileSync(path.join(pm, 'AGENTS.md'), 'utf8');
      assert.match(agents, /- None: the sources are documents/);
      assert.doesNotMatch(agents, /FILL IN: no command/);
    });
    const code = await quietAsync(() => promote.run(pm, cfg, { skillName: 'weekly-release' }));
    it('promote: kind switched to process', () => assert.strictEqual(fs.readFileSync(path.join(pm, '.claude/ws-kind'), 'utf8').trim(), 'process'));
    it('promote: skill and journal created', () => {
      assert.ok(fs.existsSync(path.join(pm, '.claude/skills/weekly-release/SKILL.md')));
      assert.ok(fs.existsSync(path.join(pm, 'journal.md')));
    });
    it('promote: AGENTS.md explains how it runs', () => assert.match(fs.readFileSync(path.join(pm, 'AGENTS.md'), 'utf8'), /## How it runs/));
    it('promote: the same wording as a new process, no ticket', () => {
      const text = fs.readFileSync(path.join(pm, 'AGENTS.md'), 'utf8');
      assert.match(text, /runs\/<date>-<short-name>\.md/);
      assert.doesNotMatch(text, /<ticket>/);
    });
    it('promote: the check passes afterwards', () => assert.strictEqual(code, 0));
    it('promote: the empty steps are still flagged — the first run was the task', () => {
      const lines = [];
      const log = console.log;
      console.log = (x) => lines.push(String(x));
      try { check.run(pm, cfg); } finally { console.log = log; }
      assert.match(lines.join('\n'), /WARN.*no steps described, though it has been run/);
    });

    // A workspace where AGENTS.md is a symlink (generated before sources were checked).
    const linked = await quietAsync(() => generate.run({ ...base, kind: 'task', slug: 'linked-agents', title: 'T',
      stateLabel: 'new feature', repos: [{ name: 'docs', path: docs, mode: 'link', branch: '', base: '', target: '—', verify: '', note: '', carry: [], cloneNm: false }] }, cfg));
    const foreign = path.join(tmp, 'foreign-AGENTS.md');
    fs.writeFileSync(foreign, 'FOREIGN\n');
    fs.rmSync(path.join(linked, 'AGENTS.md'));
    fs.symlinkSync(foreign, path.join(linked, 'AGENTS.md'));
    const pe = await failure(() => promote.run(linked, cfg, { skillName: 'x' }));
    it('promote refuses to write through a symlinked AGENTS.md', () => assert.match(pe, /is a symlink/));
    it('the file behind the symlink is untouched', () => assert.strictEqual(fs.readFileSync(foreign, 'utf8'), 'FOREIGN\n'));

    // Symlinks deeper on the way: a shared skills folder, a linked ws-kind.
    const nested = await quietAsync(() => generate.run({ ...base, kind: 'task', slug: 'nested-links', title: 'T',
      stateLabel: 'new feature', repos: [{ name: 'docs', path: docs, mode: 'link', branch: '', base: '', target: '—', verify: '', note: '', carry: [], cloneNm: false }] }, cfg));
    const sharedSkills = path.join(tmp, 'shared-skills');
    fs.mkdirSync(sharedSkills);
    fs.symlinkSync(sharedSkills, path.join(nested, '.claude', 'skills'));
    const pe2 = await failure(() => promote.run(nested, cfg, { skillName: 'x' }));
    it('promote refuses a symlinked .claude/skills', () => assert.match(pe2, /\.claude\/skills in .* is a symlink/));
    it('the shared skills folder stays empty', () => assert.deepStrictEqual(fs.readdirSync(sharedSkills), []));
    fs.rmSync(path.join(nested, '.claude', 'skills'));
    const kindFile = path.join(tmp, 'foreign-kind');
    fs.writeFileSync(kindFile, 'task\n');
    fs.rmSync(path.join(nested, '.claude', 'ws-kind'));
    fs.symlinkSync(kindFile, path.join(nested, '.claude', 'ws-kind'));
    const pe3 = await failure(() => promote.run(nested, cfg, { skillName: 'x' }));
    it('promote refuses a symlinked .claude/ws-kind', () => assert.match(pe3, /ws-kind in .* is a symlink/));
    it('the file behind ws-kind is untouched', () => assert.strictEqual(fs.readFileSync(kindFile, 'utf8'), 'task\n'));
    it('a refused promote creates nothing', () => {
      assert.ok(!fs.existsSync(path.join(nested, 'journal.md')));
      assert.ok(!fs.existsSync(path.join(nested, 'runs')));
    });
  }

  console.log('\nsources that would overwrite files outside the workspace');
  {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    const original = path.join(outside, 'README.md');
    fs.writeFileSync(original, 'ORIGINAL\n');
    const src = (p, name = path.basename(p)) => ({ name, path: p, mode: 'link', branch: '', base: '', target: '—', verify: '', note: '', carry: [], cloneNm: false });
    const tryWith = (slug, repos) => failure(() => generate.run({ ...base, kind: 'task', slug, title: 'T', stateLabel: 'new feature', repos }, cfg));
    const e1 = await tryWith('file-src', [src(original)]);
    it('a file as a source is refused', () => assert.match(e1, /not a directory/));
    it('the file outside is untouched', () => assert.strictEqual(fs.readFileSync(original, 'utf8'), 'ORIGINAL\n'));
    it('nothing is created for a refused source', () => assert.ok(!fs.existsSync(path.join(wsRoot, 'file-src'))));
    const named = path.join(outside, 'notes.md');
    fs.mkdirSync(named);
    const e2 = await tryWith('reserved-src', [src(named)]);
    it('a directory named like a workspace file is refused', () => assert.match(e2, /can't be named notes\.md/));
    const e3 = await tryWith('reserved-case', [src(named, 'Readme.MD')]);
    it('reserved names are compared case-insensitively', () => assert.match(e3, /can't be named Readme\.MD/));
    const e4 = await tryWith('dot-git', [src(path.join(repo, '.git'))]);
    it("someone's .git as a source is refused", () => assert.match(e4, /can't be named \.git/));
    // "Repo" and the repo pointer are one file on a case-insensitive disk.
    const upper = path.join(outside, 'Repo');
    fs.mkdirSync(upper);
    const e5 = await tryWith('upper-repo', [src(upper), { ...task.repos[0], branch: 'task/upper', carry: [] }]);
    it('a source named Repo does not collide with the repo pointer', () => assert.strictEqual(e5, ''));
    if (!e5) execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', path.join(wsRoot, 'upper-repo', 'api')], { stdio: 'ignore' });
  }

  console.log('\n--check follows the import chain');
  {
    const agentsMd = path.join(ws, 'AGENTS.md');
    const origA = fs.readFileSync(agentsMd, 'utf8');
    fs.writeFileSync(agentsMd, origA + '\n@missing-nested.md\n');
    it('a broken import inside an imported file fails the check', () => assert.strictEqual(quiet(() => check.run(ws, cfg)), 1));
    fs.writeFileSync(path.join(ws, 'nested.md'), '@AGENTS.md\n');
    fs.writeFileSync(agentsMd, origA + '\n@nested.md\n');
    it('an import cycle is followed once and passes', () => assert.strictEqual(quiet(() => check.run(ws, cfg)), 0));
    fs.writeFileSync(agentsMd, origA + '\nSee @missing-inline.md for details.\n');
    it('an import in the middle of a line is checked too', () => assert.strictEqual(quiet(() => check.run(ws, cfg)), 1));
    fs.writeFileSync(agentsMd, origA + '\nWrite to user@example.com, see `@not-an-import.md`.\n');
    it('an e-mail and code are not imports', () => assert.strictEqual(quiet(() => check.run(ws, cfg)), 0));
    fs.writeFileSync(agentsMd, origA);
    fs.rmSync(path.join(ws, 'nested.md'));
    const out = (dir) => {
      const lines = [];
      const log = console.log;
      console.log = (x) => lines.push(String(x));
      try { check.run(dir, cfg); } finally { console.log = log; }
      return lines.join('\n');
    };
    const noVerify = await quietAsync(() => generate.run({ ...base, kind: 'task', slug: 'no-verify', title: 'T', stateLabel: 'new feature',
      repos: [{ name: 'api', path: repo, mode: 'link', branch: '', base: '', target: 'main', verify: '', note: '', carry: [], cloneNm: false }] }, cfg));
    it('an empty verification section is a warning, not OK', () => assert.match(out(noVerify), /verification section has no command yet/));
    const docsOnly = await quietAsync(() => generate.run({ ...base, kind: 'task', slug: 'docs-only', title: 'T', stateLabel: 'new feature',
      repos: [{ name: 'docs', path: docs, mode: 'link', branch: '', base: '', target: '—', verify: '', note: '', carry: [], cloneNm: false }] }, cfg));
    it('a docs-only workspace needs no verification command', () => assert.match(out(docsOnly), /no verification command needed/));
    it('a verification command is OK', () => assert.match(out(ws), /has a verification command/));
  }

  console.log('\ncarry reports what was actually copied');
  {
    // a.ts is tracked: the main checkout's copy (edited, not committed) must not replace it
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2; // local edit\n');
    const cw = await quietAsync(() => generate.run({ ...task, slug: 'carry-missing',
      repos: [{ ...task.repos[0], branch: 'task/carry', carry: ['.env', 'gone.pem', 'a.ts'] }] }, cfg));
    execFileSync('git', ['-C', repo, 'checkout', '--', 'a.ts'], { stdio: 'ignore' });
    const rule = fs.readFileSync(path.join(cw, '.claude/rules/api.md'), 'utf8');
    it('the rule lists the copied file', () => assert.match(rule, /`\.env`/));
    it('the rule does not list a file that was not copied', () => assert.doesNotMatch(rule, /gone\.pem/));
    it('a carried file does not overwrite a tracked one', () =>
      assert.strictEqual(fs.readFileSync(path.join(cw, 'api', 'a.ts'), 'utf8'), 'export const a = 1;\n'));
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', path.join(cw, 'api')], { stdio: 'ignore' });
  }

  console.log('\nSIGTERM during generation');
  {
    const hook = path.join(repo, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(hook, '#!/bin/sh\n[ -n "$WSG_TEST_MARK" ] || exit 0\ntouch "$WSG_TEST_MARK"\nsleep 3\n', { mode: 0o755 });
    const job = { ...task, slug: 'terminated', repos: [{ ...task.repos[0], branch: 'task/terminated', carry: [] }] };
    const jobFile = path.join(tmp, 'terminated.json');
    const mark = path.join(tmp, 'terminated.mark');
    fs.writeFileSync(jobFile, JSON.stringify({ job, cfg }));
    const child = `const { job, cfg } = JSON.parse(require('fs').readFileSync(${JSON.stringify(jobFile)}, 'utf8'));
      require(${JSON.stringify(path.join(ROOT, 'lib', 'generate.js'))}).run(job, cfg)
        .then(() => process.exit(0), (e) => process.exit(e.name === 'Interrupted' ? 130 : 1));`;
    // kill hits only node, not the group: like `kill <pid>` from another terminal. The child git
    // keeps going, so the rollback comes from the handler after creation finishes.
    const r = require('node:child_process').spawnSync('bash', ['-c',
      'node -e "$CHILD" >/dev/null 2>&1 & pid=$!\n' +
      'for i in $(seq 100); do [ -e "$WSG_TEST_MARK" ] && break; sleep 0.1; done\n' +
      'kill -TERM $pid; wait $pid; echo $?'],
      { encoding: 'utf8', env: { ...process.env, CHILD: child, WSG_TEST_MARK: mark } });
    fs.rmSync(hook);
    it('SIGTERM: generation ends as interrupted', () => assert.strictEqual(r.stdout.trim(), '130'));
    it('SIGTERM: workspace rolled back', () => assert.ok(!fs.existsSync(path.join(wsRoot, 'terminated'))));
    it('SIGTERM: branch deleted', () =>
      assert.strictEqual(execFileSync('git', ['-C', repo, 'branch', '--list', 'task/terminated'], { encoding: 'utf8' }).trim(), ''));
  }

  console.log('\nws and wsg agree, codex gets every outside source');
  {
    const cfgFile = path.join(tmp, 'agree-config');
    fs.writeFileSync(cfgFile, 'WS_ROOT=/from/file\n');
    const zshRoot = require('node:child_process').spawnSync('zsh', ['-f', '-c',
      `source ${JSON.stringify(wsZsh)}; print -r -- "$WS_ROOT"`],
      { encoding: 'utf8', env: { ...process.env, WS_ROOT: '/from/env', WSG_CONFIG: cfgFile } }).stdout.trim();
    const nodeRoot = execFileSync(process.execPath, ['-e',
      `console.log(require(${JSON.stringify(path.join(ROOT, 'lib', 'config.js'))}).load().WS_ROOT)`],
      { encoding: 'utf8', env: { ...process.env, WS_ROOT: '/from/env', WSG_CONFIG: cfgFile } }).trim();
    it('WS_ROOT from the environment wins in both', () => {
      assert.strictEqual(zshRoot, '/from/env');
      assert.strictEqual(nodeRoot, '/from/env');
    });

    const other = path.join(tmp, 'other-src');
    fs.mkdirSync(path.join(other, 'repo'), { recursive: true });
    const rw = await quietAsync(() => generate.run({ ...base, kind: 'task', slug: 'named-repo', title: 'T', stateLabel: 'new feature',
      repos: [{ name: 'repo', path: path.join(other, 'repo'), mode: 'link', branch: '', base: '', target: '—', verify: '', note: '', carry: [], cloneNm: false },
        { name: 'docs', path: docs, mode: 'link', branch: '', base: '', target: '—', verify: '', note: '', carry: [], cloneNm: false }] }, cfg));
    fs.symlinkSync(docs, path.join(rw, 'docs-again'));
    const fake = path.join(tmp, 'codex-bin');
    fs.mkdirSync(fake);
    fs.writeFileSync(path.join(fake, 'codex'), '#!/bin/sh\nfor a; do printf "[%s]" "$a"; done; echo\n', { mode: 0o755 });
    const args = require('node:child_process').spawnSync('zsh', ['-f', '-c',
      `source ${JSON.stringify(wsZsh)}; ws named-repo --codex`],
      { encoding: 'utf8', input: '', env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, WS_ROOT: wsRoot, WSG_CONFIG: cfgFile + '-none' } }).stdout;
    it('a source named repo is passed to codex', () => assert.ok(args.includes(`[${fs.realpathSync(path.join(other, 'repo'))}]`)));
    it('the same target is passed once', () =>
      assert.strictEqual(args.split(`[${fs.realpathSync(docs)}]`).length - 1, 1));

    const dotSrc = path.join(tmp, 'dot-parent', '.docs');
    fs.mkdirSync(dotSrc, { recursive: true });
    await quietAsync(() => generate.run({ ...base, kind: 'task', slug: 'dot-src', title: 'T', stateLabel: 'new feature',
      repos: [{ name: '.docs', path: dotSrc, mode: 'link', branch: '', base: '', target: '—', verify: '', note: '', carry: [], cloneNm: false }] }, cfg));
    const dotArgs = require('node:child_process').spawnSync('zsh', ['-f', '-c',
      `source ${JSON.stringify(wsZsh)}; ws dot-src --codex`],
      { encoding: 'utf8', input: '', env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, WS_ROOT: wsRoot, WSG_CONFIG: cfgFile + '-none' } }).stdout;
    it('a dot-named source is passed to codex', () => assert.ok(dotArgs.includes(`[${fs.realpathSync(dotSrc)}]`), dotArgs));
  }

  console.log('\ninstall.sh from a clone');
  {
    const home = path.join(tmp, 'install-home');
    fs.mkdirSync(home);
    const run = () => require('node:child_process').spawnSync('bash', [path.join(ROOT, 'install.sh')],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, SHELL: '/bin/zsh' } });
    const first = run();
    it('install.sh succeeds', () => assert.strictEqual(first.status, 0, first.stderr));
    it('wsg is linked into ~/.local/bin', () => assert.ok(fs.existsSync(path.join(home, '.local/bin/wsg'))));
    const rc = () => fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
    it('.zshrc gets PATH and a guarded ws line', () => {
      assert.match(rc(), /^export PATH="\$HOME\/\.local\/bin:\$PATH"$/m);
      assert.match(rc(), /^command -v wsg >\/dev\/null && eval "\$\(wsg shell-init zsh\)"$/m);
    });
    const before = rc();
    run();
    it('a second run changes nothing', () => assert.strictEqual(rc(), before));
  }

  console.log('\nUI language');
  {
    const i18n = require(path.join(ROOT, 'lib', 'i18n'));
    const { en, ru } = i18n.catalogs;
    const places = (v) => [...new Set((typeof v === 'object' ? Object.values(v).join(' ') : v).match(/\{\w+\}/g) || [])].sort();
    it('ru has exactly the keys of en', () => assert.deepStrictEqual(Object.keys(ru).sort(), Object.keys(en).sort()));
    it('every ru string is non-empty and has the same placeholders', () => {
      for (const k of Object.keys(en)) {
        assert.ok(ru[k] && (typeof ru[k] === 'object' || ru[k].trim()), k);
        assert.deepStrictEqual(places(ru[k]), places(en[k]), k);
      }
    });
    it('ru plurals have every Russian form', () => {
      for (const [k, v] of Object.entries(ru)) {
        if (typeof v === 'object') for (const f of ['one', 'few', 'many', 'other']) assert.ok(v[f], `${k}.${f}`);
      }
    });
    it('ws strings carry no % (print -P), no \\ and no @@', () => {
      for (const cat of [en, ru]) {
        for (const [k, v] of Object.entries(cat)) if (k.startsWith('ws.')) assert.doesNotMatch(v, /%|\\|@@/, k);
      }
    });
    const rl = i18n.resolveLang;
    it('WSG_LANG picks the language', () => assert.strictEqual(rl({}, 'ru'), 'ru'));
    it('a Russian locale picks ru', () => assert.strictEqual(rl({ LANG: 'ru_RU.UTF-8' }), 'ru'));
    it('LC_ALL wins over LANG', () => assert.strictEqual(rl({ LC_ALL: 'C', LANG: 'ru_RU.UTF-8' }), 'en'));
    it('LC_MESSAGES counts', () => assert.strictEqual(rl({ LC_MESSAGES: 'ru_RU' }), 'ru'));
    it('an unsupported locale falls back to en', () => assert.strictEqual(rl({ LANG: 'de_DE.UTF-8' }), 'en'));
    it('the config wins over the locale', () => assert.strictEqual(rl({ LANG: 'ru_RU.UTF-8' }, 'en'), 'en'));
    it('an unknown WSG_LANG falls back to the locale', () => assert.strictEqual(rl({ LANG: 'ru_RU.UTF-8' }, 'xx'), 'ru'));
    it('nothing set is en', () => assert.strictEqual(rl({}), 'en'));

    i18n.init('ru');
    it('t gives Russian text in ru', () => assert.match(i18n.t('interview.kind'), /[А-Яа-я]/));
    it('Russian plural forms', () => {
      assert.match(i18n.t('gen.copied', { n: 1, total: 5 }), / 1 файл /);
      assert.match(i18n.t('gen.copied', { n: 3, total: 5 }), / 3 файла /);
      assert.match(i18n.t('gen.copied', { n: 5, total: 5 }), / 5 файлов /);
      assert.match(i18n.t('gen.copied', { n: 21, total: 30 }), / 21 файл /);
    });
    it('an unknown key comes back as is', () => assert.strictEqual(i18n.t('no.such.key'), 'no.such.key'));
    const saved = ru['cli.done'];
    delete ru['cli.done'];
    it('a key missing in ru falls back to en', () => assert.strictEqual(i18n.t('cli.done'), 'Done'));
    ru['cli.done'] = saved;

    // Workspace files stay English even when the whole UI is Russian.
    const printed = [];
    const log = console.log;
    const err = process.stderr.write;
    console.log = (x) => printed.push(String(x));
    process.stderr.write = () => true;
    let wr;
    try {
      wr = await generate.run({ ...base, kind: 'task', slug: 'ru-ui', title: 'English title', stateLabel: 'new feature',
        repos: [{ name: 'docs', path: docs, mode: 'link', branch: '', base: '', target: '—', verify: '', note: 'briefs', carry: [], cloneNm: false }] }, cfg);
    } finally { console.log = log; process.stderr.write = err; }
    i18n.init('en');
    it('with ru the progress is printed in Russian', () => assert.match(printed.join('\n'), /Создаю/));
    it('with ru the workspace files have no Russian', () => {
      for (const f of ['CLAUDE.md', 'AGENTS.md', 'README.md', 'notes.md', '.claude/rules/docs.md', '.learnings/LEARNINGS.md', '.learnings/ERRORS.md']) {
        assert.doesNotMatch(fs.readFileSync(path.join(wr, f), 'utf8'), /[Ѐ-ӿ]/, f);
      }
    });

    const cfgFile = path.join(tmp, 'lang-config');
    const langWith = (text, env = {}) => {
      fs.writeFileSync(cfgFile, text);
      const e = { ...process.env, WSG_CONFIG: cfgFile, ...env };
      delete e.WSG_LANG;
      Object.assign(e, env);
      return execFileSync(process.execPath, ['-e',
        `console.log(require(${JSON.stringify(path.join(ROOT, 'lib', 'config.js'))}).load().lang)`],
        { encoding: 'utf8', env: e }).trim();
    };
    it('WSG_LANG in the config is read', () => assert.strictEqual(langWith('WSG_LANG=ru\n', { LANG: 'en_US.UTF-8', LC_ALL: '' }), 'ru'));
    {
      // An unreadable config: the language still comes from WSG_LANG in the environment.
      const bad = path.join(tmp, 'unreadable-config');
      fs.mkdirSync(bad);
      const help = execFileSync(process.execPath, [path.join(ROOT, 'bin', 'cli.js'), '--help'],
        { encoding: 'utf8', env: { ...process.env, WSG_CONFIG: path.join(bad, 'nested', '..', '..', 'unreadable-config'), WSG_LANG: 'ru' } });
      it('--help follows WSG_LANG even when the config is broken', () => assert.match(help, /интерактивное создание/));
    }
    it('WSG_LANG from the environment beats the config', () => assert.strictEqual(langWith('WSG_LANG=ru\n', { WSG_LANG: 'en' }), 'en'));

    const ruZsh = path.join(tmp, 'wsg-ru.zsh');
    fs.writeFileSync(ruZsh, renderWs('ru'));
    it('the Russian ws parses', () => execFileSync('zsh', ['-n', ruZsh]));
    it('the rendered ws has no placeholders left', () => assert.doesNotMatch(fs.readFileSync(ruZsh, 'utf8'), /@@/));
    const ruWs = (script) => require('node:child_process').spawnSync('zsh', ['-f', '-c', `source ${JSON.stringify(ruZsh)}; ${script}`],
      { encoding: 'utf8', input: '', env: { ...process.env, WS_ROOT: wsRoot, WSG_CONFIG: path.join(tmp, 'no-config') } });
    it('ws speaks Russian', () => {
      assert.match(ruWs('ws').stdout, /Задачные воркспейсы/);
      assert.match(ruWs('ws nope').stderr, /нет воркспейса 'nope'/);
    });
    it('an unknown placeholder is an error', () => assert.throws(() => i18n.renderShell('"@@no.such@@"'), /unknown shell string/));
  }

  console.log('\nanswers land in their own sections');
  {
    const cfgT = { WS_ROOT: path.join(tmp, 'sections'), WSG_GLOBAL_MEMORY: '', WSG_PARENT_CONTEXT: '' };
    const task = await quietAsync(() => generate.run({ ...base, kind: 'task', slug: 'scoped', title: 'T', stateLabel: 'new feature',
      outOfScope: ['the login screen redesign'], repos: [] }, cfgT));
    const agents = fs.readFileSync(path.join(task, 'AGENTS.md'), 'utf8');
    it('task: out of scope is a section with a rule', () => {
      assert.match(agents, /## Out of scope\n\n- the login screen redesign/);
      assert.match(agents, /ask the owner first/);
    });
    it('no sources: AGENTS.md says the files live in the workspace', () => assert.match(agents, /no sources: its files live here/));
    it('no sources: verification needs no command', () => assert.match(agents, /- None: the workspace has no sources/));
    const readme = fs.readFileSync(path.join(task, 'README.md'), 'utf8');
    it('no sources: README has no empty table', () => {
      assert.doesNotMatch(readme, /\| Repository \|/);
      assert.match(readme, /## Sources\n\nNone: the files of this work live in the workspace itself/);
    });
    const proc = await quietAsync(() => generate.run({ ...base, kind: 'process', slug: 'health', title: 'Health', skillName: 'health',
      stateLabel: 'repeatable process', trigger: ['new test results arrived'], varies: ['the new documents'],
      fixed: ['no diagnoses'], steps: [], invariants: [], repos: [] }, cfgT));
    const pa = fs.readFileSync(path.join(proc, 'AGENTS.md'), 'utf8');
    const skill = fs.readFileSync(path.join(proc, '.claude/skills/health/SKILL.md'), 'utf8');
    it('process: when it runs is in AGENTS.md', () => assert.match(pa, /## When it runs\n\n- new test results arrived/));
    it('process: rules and boundaries are always-on, in AGENTS.md', () => assert.match(pa, /## Rules and boundaries\n\n- no diagnoses/));
    it('process: the skill points to them instead of repeating', () => {
      assert.doesNotMatch(skill, /no diagnoses/);
      assert.match(skill, /Rules and boundaries of every run are in AGENTS.md/);
    });
    it('process: the input of each run is in the skill', () => assert.match(skill, /## Input of each run\n\n- the new documents/));
    it('process: steps are worked out on the first run', () => assert.match(skill, /on the first run, work them out with the owner/));
    it('process: no ticket is asked for anywhere', () => {
      for (const f of [pa, skill, fs.readFileSync(path.join(proc, 'journal.md'), 'utf8')]) assert.doesNotMatch(f, /<ticket>|ticket or description/);
    });
    it('process: runs are named by date', () => {
      assert.match(pa, /runs\/<date>-<short-name>\.md/);
      assert.match(skill, /runs\/<date>-<short-name>\.md/);
    });
    it('process: it can be run without an argument', () => assert.match(pa, /Without an argument, look at what is new/));
    it('process without git: the skill says nothing about pushes and MRs', () => assert.doesNotMatch(skill, /create an MR/));
    it('process: no invariants section it was never asked for', () => assert.doesNotMatch(pa, /Invariants are not findings/));
    it('process without git: no talk of branches or a code map', () => {
      assert.doesNotMatch(pa, /no permanent branch/);
      assert.doesNotMatch(pa, /Code map/);
    });
    const checkOut = (dir) => {
      const lines = [];
      const log = console.log;
      console.log = (x) => lines.push(String(x));
      try { check.run(dir, cfgT); } finally { console.log = log; }
      return lines.join('\n');
    };
    it('a new process passes its own check with no warnings at all', () => assert.doesNotMatch(checkOut(proc), /WARN|FAIL/));
    it('a task without sources passes with no warnings', () => assert.doesNotMatch(checkOut(task), /WARN|FAIL/));
    it('and check does not claim a verification command', () => {
      assert.doesNotMatch(checkOut(task), /has a verification command/);
      assert.match(checkOut(task), /no verification command needed/);
    });
    const notes = fs.readFileSync(path.join(task, 'notes.md'), 'utf8');
    it('no sources: notes.md has no code map to fill in', () => {
      assert.doesNotMatch(notes, /Code map/);
      assert.doesNotMatch(notes, /FILL IN/);
    });
    it('no sources: the layout does not promise a code map', () => assert.doesNotMatch(agents, /code map/i));
    fs.writeFileSync(path.join(proc, 'runs', 'first.md'), '# run\n');
    it('after a run, missing steps are', () => assert.match(checkOut(proc), /no steps described, though it has been run/));
  }

  console.log('\nsource folders are created with the workspace');
  {
    const cfgD = { WS_ROOT: path.join(tmp, 'mkdirs'), WSG_GLOBAL_MEMORY: '', WSG_PARENT_CONTEXT: '' };
    const fresh = path.join(tmp, 'new-root', 'Health');
    const src = (p) => ({ name: path.basename(p), path: p, create: true, mode: 'link', branch: '', base: '', target: '—', verify: '', note: '', carry: [], cloneNm: false });
    const made = await quietAsync(() => generate.run({ ...base, kind: 'task', slug: 'mk', title: 'T', stateLabel: 'new feature', repos: [src(fresh)] }, cfgD));
    it('a folder marked for creation exists after generation', () => assert.ok(fs.statSync(fresh).isDirectory()));
    it('and is linked into the workspace', () => assert.strictEqual(fs.realpathSync(path.join(made, 'Health')), fs.realpathSync(fresh)));
    it('the rule for a folder of documents does not talk about commits', () => {
      const rule = fs.readFileSync(path.join(made, '.claude', 'rules', 'Health.md'), 'utf8');
      assert.match(rule, /how the files here are organized/);
      assert.doesNotMatch(rule, /commit conventions/);
    });

    const doomed = path.join(tmp, 'doomed-root', 'deep', 'Docs');
    // Rejected by the checks before anything is made (a file is not a source). The rollback after
    // folders were made is tested in "rollback on failure".
    const notDir = path.join(tmp, 'a-file');
    fs.writeFileSync(notDir, '');
    await failure(() => generate.run({ ...base, kind: 'task', slug: 'mk2', title: 'T', stateLabel: 'new feature',
      repos: [src(doomed), { ...src(notDir), create: false }] }, cfgD));
    it('a run rejected by the checks creates no folders', () => assert.ok(!fs.existsSync(path.join(tmp, 'doomed-root'))));

    const { missingChain, sourceProblem } = generate;
    {
      const home = path.join(tmp, 'dotfiles-home');
      fs.mkdirSync(path.join(home, 'code', 'api'), { recursive: true });
      execFileSync('git', ['init', '-q', home]);
      execFileSync('git', ['init', '-q', path.join(home, 'code', 'api')]);
      const g = require(path.join(ROOT, 'lib', 'git.js'));
      const prev = process.env.HOME;
      process.env.HOME = home;
      try {
        it('home as a dotfiles repo: a new ~/Health is not a git source', () => assert.strictEqual(g.newFolderInRepo(home), false));
        it('the same way generation will judge it once created', () => {
          fs.mkdirSync(path.join(home, 'Health'));
          assert.strictEqual(g.isRepo(path.join(home, 'Health')), false);
        });
        it('a new folder inside a real repo still is', () => assert.strictEqual(g.newFolderInRepo(path.join(home, 'code', 'api')), true));
      } finally { process.env.HOME = prev; }
    }

    {
      // mkdir -p that fails halfway: the outer folder is made, the long name is refused.
      const outer = path.join(tmp, 'half-made');
      const tooLong = path.join(outer, 'x'.repeat(300));
      await failure(() => generate.run({ ...base, kind: 'task', slug: 'half', title: 'T', stateLabel: 'new feature', repos: [src(tooLong)] }, cfgD));
      it('a mkdir that fails halfway leaves no outer folder', () => assert.ok(!fs.existsSync(outer)));
    }

    {
      const i18n = require(path.join(ROOT, 'lib', 'i18n'));
      for (const l of ['en', 'ru']) {
        i18n.init(l);
        it(`${l}: the links hint does not repeat "empty line to finish"`, () =>
          assert.ok(!i18n.t('interview.links.hint').includes(i18n.t('interview.finish'))));
      }
      i18n.init('en');
    }

    const dangling = path.join(tmp, 'dangling');
    fs.symlinkSync(path.join(tmp, 'unmounted-drive'), dangling);
    it('a dangling symlink is not a folder to create', () => assert.deepStrictEqual(missingChain(dangling).missing, []));
    it('and is reported as missing right away', () => assert.match(sourceProblem({ path: dangling, name: 'dangling', create: false }), /does not exist/));

    const { ensureDir } = require(path.join(ROOT, 'lib', 'interview.js'));
    const { PassThrough } = require('node:stream');
    const answer = async (full, typed) => {
      const input = new PassThrough();
      const output = new PassThrough();
      const log = console.log;
      const printed = [];
      console.log = (x) => printed.push(String(x));
      try {
        const r = ensureDir(full, { input, output });
        setTimeout(() => input.write(typed + '\n'), 50);
        return { value: await r, printed: printed.join('\n') };
      } finally { console.log = log; }
    };
    const one = await answer(path.join(tmp, 'only-this'), '');
    it('a missing folder in an existing parent: Enter says yes', () => assert.strictEqual(one.value, true));
    it('the interview itself creates nothing', () => assert.ok(!fs.existsSync(path.join(tmp, 'only-this'))));
    const typo = await answer(path.join(tmp, 'Documets', 'Health'), '');
    it('a missing parent (likely a typo): Enter says no', () => assert.strictEqual(typo.value, false));
    it('and the whole chain is shown', () => assert.match(typo.printed, /Documets\n\s+.*Documets\/Health/));
    fs.mkdirSync(path.join(tmp, 'Documents'), { recursive: true });
    const cut = await answer(path.join(tmp, 'Doc'), '');
    it('a name cut short (Doc next to Documents): Enter says no', () => assert.strictEqual(cut.value, false));
    it('and the existing folder is suggested', () => assert.match(cut.printed, /Documents/));
    const caseOnly = await answer(path.join(tmp, 'Receipts'), '');
    it('an unrelated new name still defaults to yes', () => assert.strictEqual(caseOnly.value, true));
    fs.mkdirSync(path.join(tmp, 'Documents', 'Health'), { recursive: true });
    const helth = await answer(path.join(tmp, 'Documents', 'Helth'), '');
    it('a typo of an existing folder (Helth): Enter says no', () => assert.strictEqual(helth.value, false));
    it('and the real folder is suggested', () => assert.match(helth.printed, /Documents\/Health/));
    const drive = path.join(tmp, 'drive');
    fs.symlinkSync(path.join(tmp, 'unmounted-volume'), drive);
    const onDrive = await answer(path.join(drive, 'Health'), 'y');
    it('a folder behind a dangling link is refused with the real reason', () => {
      assert.strictEqual(onDrive.value, false);
      assert.match(onDrive.printed, /not available/);
      assert.doesNotMatch(onDrive.printed, /write access|did you mean/);
    });
    fs.writeFileSync(path.join(tmp, 'notes.txt'), '');
    const underFile = await answer(path.join(tmp, 'notes.txt', 'sub'), 'y');
    it('a file on the way is named as the reason', () => {
      assert.strictEqual(underFile.value, false);
      assert.match(underFile.printed, /notes\.txt is a file, not a folder/);
    });
  }

  console.log('\ntyping a source path');
  {
    const { completePath, tildePath } = require(path.join(ROOT, 'lib', 'pathPrompt.js'));
    const interview = require(path.join(ROOT, 'lib', 'interview.js'));
    it('a folder dragged into the terminal: escapes are undone', () =>
      assert.strictEqual(interview.resolveSource('/x/My\\ Docs\\ \\(old\\) '), '/x/My Docs (old)'));
    it('a quoted path loses its quotes', () => assert.strictEqual(interview.resolveSource("'/x/My Docs'"), '/x/My Docs'));
    it('~ only as the leading home directory', () => {
      assert.strictEqual(tildePath(path.join(os.homedir(), 'x')), '~/x');
      assert.strictEqual(tildePath(`${os.homedir()}-shared/Documents`), `${os.homedir()}-shared/Documents`);
    });
    const base = path.join(tmp, 'complete');
    for (const d of ['medical-docs', 'media', 'Projects', '.hidden']) fs.mkdirSync(path.join(base, d), { recursive: true });
    fs.writeFileSync(path.join(base, 'medical.txt'), '');
    fs.symlinkSync(path.join(base, 'Projects'), path.join(base, 'proj-link'));
    it('a single match completes and ends with /', () => assert.strictEqual(completePath(`${base}/medic`).completed, `${base}/medical-docs/`));
    it('several matches complete to their common part', () => assert.strictEqual(completePath(`${base}/me`).completed, `${base}/medi`));
    it('files are not offered', () => assert.ok(!completePath(`${base}/medical`).matches.some((m) => m.endsWith('.txt'))));
    it('case does not matter, the real name is used', () => assert.strictEqual(completePath(`${base}/proje`).completed, `${base}/Projects/`));
    it('a symlink to a directory counts', () => assert.ok(completePath(`${base}/proj-`).matches.some((m) => m.endsWith('proj-link'))));
    it('hidden ones only when asked for', () => {
      assert.ok(!completePath(`${base}/`).matches.some((m) => m.endsWith('.hidden')));
      assert.strictEqual(completePath(`${base}/.hi`).completed, `${base}/.hidden/`);
    });
    it('~ stays ~', () => assert.match(completePath('~/').completed, /^~\//));
    it('no match leaves the text as typed', () => assert.strictEqual(completePath(`${base}/zzz`).completed, `${base}/zzz`));
    fs.mkdirSync(path.join(base, 'My Docs'));
    it('an escaped space still completes', () => assert.strictEqual(completePath(`${base}/My\\ D`).completed, `${base}/My Docs/`));
  }

  console.log('\nthe first run asks for the language');
  {
    const i18n = require(path.join(ROOT, 'lib', 'i18n'));
    const interview = require(path.join(ROOT, 'lib', 'interview.js'));
    const { PassThrough } = require('node:stream');
    const pick = async (keys, opts, cfg) => {
      const input = new PassThrough();
      const output = new PassThrough();
      const log = console.log;
      console.log = () => {};
      try {
        const answer = interview.askLanguage(cfg, opts, { input, output });
        setTimeout(() => input.write(keys), 50);
        return await answer;
      } finally { console.log = log; }
    };
    const langCfg = path.join(tmp, 'lang', 'config');
    i18n.init('en');
    const cfg1 = { configFile: langCfg, WSG_LANG: '' };
    const got = await pick('\u001b[B\r', {}, cfg1);
    it('arrow down picks Russian', () => assert.strictEqual(got, 'ru'));
    it('the UI switches right away', () => assert.strictEqual(i18n.current(), 'ru'));
    it('the choice is saved to the config', () => assert.strictEqual(fs.readFileSync(langCfg, 'utf8'), 'WSG_LANG="ru"\n'));
    it('the config sees it', () => assert.strictEqual(cfg1.WSG_LANG, 'ru'));
    fs.writeFileSync(langCfg, 'WS_ROOT="/x"\nWSG_LANG="ru"\n# WSG_LANG="en"\n');
    await pick('\u001b[A\r', {}, { configFile: langCfg, WSG_LANG: '' });
    it('choosing again replaces the saved language', () =>
      assert.strictEqual(fs.readFileSync(langCfg, 'utf8'), 'WS_ROOT="/x"\n# WSG_LANG="en"\nWSG_LANG="en"\n'));
    const dry = path.join(tmp, 'lang-dry', 'config');
    await pick('\r', { save: false }, { configFile: dry, WSG_LANG: '' });
    it('--dry-run does not write the config', () => assert.ok(!fs.existsSync(dry)));
    i18n.init('en');
  }

  console.log('\nyes/no answers typed into the prompt');
  {
    const i18n = require(path.join(ROOT, 'lib', 'i18n'));
    const interview = require(path.join(ROOT, 'lib', 'interview.js'));
    const { PassThrough } = require('node:stream');
    // Types into the real prompt through inquirer's own input/output streams.
    const typeInto = async (lines, def) => {
      const input = new PassThrough();
      const output = new PassThrough();
      let shown = '';
      output.on('data', (d) => { shown += d; });
      const answer = interview.askYesNo({ message: 'Q?', default: def }, { input, output });
      let i = 0;
      const next = () => { if (i < lines.length) { input.write(lines[i++] + '\n'); setTimeout(next, 30); } };
      setImmediate(next);
      return { value: await answer, shown };
    };
    for (const lang of ['en', 'ru']) {
      i18n.init(lang);
      const cases = [['нет', true, false], ['да', false, true], ['no', true, false], ['yes', false, true],
        ['н', true, false], ['Y', false, true], ['', true, true], ['', false, false]];
      for (const [typed, def, want] of cases) {
        const { value } = await typeInto([typed], def);
        it(`${lang} UI: "${typed}" with default ${def} is ${want}`, () => assert.strictEqual(value, want));
      }
      // Not a guess: an unknown answer is asked again, and the next one counts.
      const { value, shown } = await typeInto(['maybe', '\u0015нет'], true);
      it(`${lang} UI: an unknown answer is asked again`, () => {
        assert.strictEqual(value, false);
        assert.match(shown, lang === 'ru' ? /Ответь да или нет/ : /Answer y or n/);
      });
    }
    i18n.init('en');
  }

  console.log('\nanswers in another language');
  {
    const T = require(path.join(ROOT, 'lib', 'templates.js'));
    const rw = await quietAsync(() => generate.run({ ...base, kind: 'task', slug: 'ru-answers', title: 'Token refresh',
      problem: ['Токен не обновляется в фоновых вкладках.'], stateLabel: 'new feature',
      repos: [{ name: 'docs', path: docs, mode: 'link', branch: '', base: '', target: '—', verify: '', note: '', carry: [], cloneNm: false }] }, cfg));
    it('notes.md gets the first-session translation task', () =>
      assert.match(fs.readFileSync(path.join(rw, 'notes.md'), 'utf8'), /First-session task — translate into English/));
    it('the task covers every file the title lands in, not a list of sections', () => {
      const notes = fs.readFileSync(path.join(rw, 'notes.md'), 'utf8');
      assert.match(notes, /the title is repeated/);
      assert.match(notes, /\.claude\/skills\//);
      assert.match(notes, /Continue with: first session — translate the workspace files into English/);
    });
    it('AGENTS.md says knowledge is kept in English', () =>
      assert.match(fs.readFileSync(path.join(rw, 'AGENTS.md'), 'utf8'), /are kept in English/));
    it('English answers get neither', () => {
      assert.doesNotMatch(fs.readFileSync(path.join(ws, 'notes.md'), 'utf8'), /translate into English/);
      assert.doesNotMatch(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8'), /kept in English/);
    });
    it('a Cyrillic source note or link title counts', () => {
      assert.ok(T.hasForeignText({ ...base, title: 'T', links: ['Спека | https://x'], repos: [] }));
      assert.ok(T.hasForeignText({ ...base, title: 'T', repos: [{ note: 'брифы' }] }));
    });
    it('a verification command does not count', () =>
      assert.ok(!T.hasForeignText({ ...base, title: 'T', repos: [{ note: '', verify: 'echo привет' }] })));
  }

  console.log('\nhooking ws into .zshrc');
  {
    const shellrc = require(path.join(ROOT, 'lib', 'shellrc.js'));
    it('.zshrc follows ZDOTDIR', () => assert.strictEqual(shellrc.rcPath({ ZDOTDIR: '/z' }), '/z/.zshrc'));
    it('ws counts as loaded only with the marker from wsg.zsh', () => {
      assert.strictEqual(shellrc.loaded({ WSG_WS_LOADED: '1' }), true);
      assert.strictEqual(shellrc.loaded({}), false);
    });
    it('wsg.zsh exports the marker', () =>
      assert.match(fs.readFileSync(path.join(ROOT, 'shell', 'wsg.zsh'), 'utf8'), /^typeset -gx WSG_WS_LOADED=1$/m));

    const zd = path.join(tmp, 'zdotdir');
    const env = { ZDOTDIR: zd, HOME: path.join(tmp, 'home-without-rc') };
    it('a missing .zshrc is not hooked', () => assert.strictEqual(shellrc.isHooked(env), false));
    shellrc.hook(shellrc.rcPath(env));
    it('hooking creates a missing .zshrc and its directory', () =>
      assert.strictEqual(fs.readFileSync(path.join(zd, '.zshrc'), 'utf8'), `# wsg\n${shellrc.LINE}\n`));
    it('a hooked .zshrc is recognised', () => assert.strictEqual(shellrc.isHooked(env), true));
    const rc = path.join(zd, '.zshrc');
    fs.writeFileSync(rc, 'alias ll="ls -l"');
    shellrc.hook(rc);
    it('hooking appends after a last line without a newline', () =>
      assert.strictEqual(fs.readFileSync(rc, 'utf8'), `alias ll="ls -l"\n\n# wsg\n${shellrc.LINE}\n`));
    fs.writeFileSync(rc, '');
    shellrc.hook(rc);
    it('an empty .zshrc gets no leading blank line', () => assert.strictEqual(fs.readFileSync(rc, 'utf8'), `# wsg\n${shellrc.LINE}\n`));
    fs.writeFileSync(rc, 'eval "$(wsg shell-init zsh)"\n');
    it('a hand-written line without the guard counts too', () => assert.strictEqual(shellrc.isHooked(env), true));
    fs.writeFileSync(rc, '# eval "$(wsg shell-init zsh)"\n  #  command -v wsg && eval "$(wsg shell-init zsh)"\n');
    it('a commented-out line does not count', () => assert.strictEqual(shellrc.isHooked(env), false));
    fs.mkdirSync(path.join(rc + '.d'));
    it('an unreadable .zshrc is an error, not "missing"', () => assert.throws(() => shellrc.hook(rc + '.d')));

    const bin = path.join(tmp, 'bin-wsg');
    const npxBin = path.join(tmp, '_npx', 'abc', 'node_modules', '.bin');
    for (const d of [bin, npxBin]) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'wsg'), '#!/bin/sh\n', { mode: 0o755 });
    }
    it('wsg installed on PATH is found', () => assert.strictEqual(shellrc.wsgOnPath({ PATH: bin }), true));
    it('wsg from the npx cache does not count', () => assert.strictEqual(shellrc.wsgOnPath({ PATH: npxBin }), false));

    const cfgFile = path.join(tmp, 'cfg-decline', 'config');
    require(path.join(ROOT, 'lib', 'config.js')).saveSetting(cfgFile, 'WSG_SHELL_HOOK', 'no');
    it('a declined hook is remembered in the config', () => {
      const prev = process.env.WSG_CONFIG;
      process.env.WSG_CONFIG = cfgFile;
      try {
        assert.strictEqual(require(path.join(ROOT, 'lib', 'config.js')).load().WSG_SHELL_HOOK, 'no');
      } finally {
        if (prev === undefined) delete process.env.WSG_CONFIG;
        else process.env.WSG_CONFIG = prev;
      }
    });
  }

  console.log('\nws asks for the agent through wsg --pick-agent');
  {
    const r = require('node:child_process').spawnSync(process.execPath, [path.join(ROOT, 'bin', 'cli.js'), '--pick-agent', 'claude'],
      { encoding: 'utf8', input: '', env: { ...process.env, WSG_CONFIG: path.join(tmp, 'no-config') } });
    it('a closed input is a cancel: nothing on stdout for ws to save', () => {
      assert.strictEqual(r.status, 130);
      assert.strictEqual(r.stdout, '');
    });
    it('the cancel leaves the message to ws', () => assert.doesNotMatch(r.stderr, /nothing created/));
    it('ws calls it with the agents found in PATH', () =>
      assert.match(fs.readFileSync(path.join(ROOT, 'shell', 'wsg.zsh'), 'utf8'), /wsg --pick-agent "\$\{found\[@\]\}"/));
  }

  try { execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', path.join(ws, 'api')], { stdio: 'ignore' }); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(failed === 0 ? '\nall checks passed\n' : `\nfailed: ${failed}\n`);
  finished = true;
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.log(`\nFAIL  ${e.stack || e}`);
  finished = true;
  process.exit(1);
});
