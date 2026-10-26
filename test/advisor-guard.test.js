'use strict';

// lib/advisor-guard.js, the PreToolUse hook of the Claude Code wsg-advisor: a table of calls it
// lets through and calls it blocks, then the script itself as Claude Code runs it — JSON on stdin,
// exit 0 or 2.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(ROOT, 'lib', 'advisor-guard.js');
const G = require(GUARD);
// The advisor runs wsg only as `node "<this package's bin/cli.js>"`, the path install-skills renders.
const CLI = path.join(ROOT, 'bin', 'cli.js');
const W = `node "${CLI}"`;

let failed = 0;
const it = (name, fn) => {
  try { fn(); console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};

// A workspace on disk, for where git may run: WS with .claude/wsg.json naming one source, REPO
// (its .git/config has the remote origin); WT, the source's worktree inside the workspace, its .git
// a file pointing into REPO/.git/worktrees; a symlink to REPO in WS; EVIL, a repository outside
// with a config of its own; REPO/vendor/bare, a committed directory git would take for a bare
// repository. Real paths: the guard compares them after realpath.
const FX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-guard-fx-')));
process.on('exit', () => fs.rmSync(FX, { recursive: true, force: true }));
const WS = path.join(FX, 'ws');
const REPO = path.join(FX, 'svc');
const WT = path.join(WS, 'svc');
const EVIL = path.join(FX, 'evil');
const write = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
write(path.join(WS, '.claude', 'wsg.json'), JSON.stringify({ version: 2, sources: [{ name: 'svc', path: REPO, mode: 'worktree' }, { name: 'gone', path: path.join(FX, 'gone') }] }));
fs.mkdirSync(path.join(WS, 'a dir'), { recursive: true });
write(path.join(REPO, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = /x/origin.git\n[remote "nourl"]\n\tfetch = x\n[branch "upstream"]\n\turl = y\n');
write(path.join(REPO, '.git', 'HEAD'), 'ref: refs/heads/main\n');
write(path.join(REPO, '.git', 'worktrees', 'svc', 'commondir'), '../..\n');
write(path.join(REPO, 'src', 'a.js'), '');
write(path.join(REPO, 'vendor', 'bare', 'HEAD'), 'ref: refs/heads/main\n');
write(path.join(REPO, 'vendor', 'bare', 'config'), '[core]\n\tfsmonitor = touch /tmp/owned\n');
fs.mkdirSync(path.join(REPO, 'vendor', 'bare', 'objects'), { recursive: true });
fs.mkdirSync(path.join(REPO, 'vendor', 'bare', 'refs'), { recursive: true });
write(path.join(WT, '.git'), `gitdir: ${path.join(REPO, '.git', 'worktrees', 'svc')}\n`);
fs.symlinkSync(REPO, path.join(WS, 'svc-link'));
fs.symlinkSync(EVIL, path.join(WS, 'evil-link'));
fs.symlinkSync(EVIL, path.join(REPO, 'evil-link'));
write(path.join(EVIL, '.git', 'config'), '[core]\n\tfsmonitor = touch /tmp/owned\n[remote "origin"]\n\turl = /x\n');
fs.mkdirSync(path.join(WS, 'origin'));
fs.mkdirSync(path.join(FX, 'ws-other'));

// The session runs in the worktree unless a row says otherwise: the hook input carries its cwd.
const bash = (command, cwd = WT) => ({ tool_name: 'Bash', tool_input: { command, description: 'x' }, cwd });
const mcp = (name) => ({ tool_name: name, tool_input: {} });

console.log('\nthe advisor guard: Bash');
const ALLOWED = [
  'git log --oneline -5',
  `git -C ${REPO} log -1`,
  `git -C "${WS}/a dir" show HEAD:package.json`,
  'git --no-pager diff main...HEAD -- src/a.js',
  'git diff --output-indicator-new=+ HEAD',
  'git status --porcelain',
  'git for-each-ref refs/heads',
  'git symbolic-ref refs/remotes/origin/HEAD',
  'git ls-remote --heads origin',
  'git blame -L 1,10 src/a.js',
  'git rev-parse --abbrev-ref HEAD',
  'git merge-base main HEAD',
  'git ls-files --others --ignored --exclude-standard',
  'git grep -n retry',
  'git branch',
  'git branch --list',
  'git branch -vv',
  'git branch -a',
  'git branch --show-current',
  `${W} guide advisor`,
  `${W} check`,
  `${W} check /tmp/ws/x`,
  `${W} --where`,
  `${W} --help`,
  `${W} --version`,
  `${W} add x --dry-run`,
  `${W} add /tmp/repo --branch feature/X-1 --verify "npm test" --dry-run`,
  `${W} remove api --dry-run`,
  `node ${CLI} guide advisor`,
  'cat notes.md',
  'cat "notes with space.md"',
  'head -n 20 AGENTS.md',
  'tail -n 5 journal.md',
  'wc -l AGENTS.md',
  "grep -rn 'retry' .",
  "grep -n 'a\\.b' src/a.js",
  'rg -n SPEC-42 /tmp/ws',
  'ls -la',
  'pwd',
  "find . -name '*.md' -type f",
  'command -v wsg',
  'which wsg',
  '  git log -1  ',
];
const BLOCKED = [
  'printf x >> f',
  'printf ... >> notes.md',
  'echo hi > notes.md',
  'cat notes.md | tee copy.md',
  'tee notes.md',
  "sed -i 's/a/b/' notes.md",
  'git branch -D feature/x',
  'git branch feature/new',
  'git branch -m a b',
  'git push',
  'git push origin main',
  'git -C . push origin log',
  'git diff --output=x',
  'git diff --output x',
  'git log -o x',
  'git show --outp=x HEAD',
  'git ls-remote --upload-pack=touch origin',
  'git ls-remote --upl=touch origin',
  'git ls-remote --exec=touch origin',
  'git ls-remote -u touch origin',
  'git grep -O vim retry',
  'git grep --open-files-in-pager=vim retry',
  'git grep -nOvim retry',
  'git symbolic-ref HEAD refs/heads/x',
  'git symbolic-ref -d HEAD',
  'git -c core.pager=touch log',
  'git checkout main',
  'git commit -m x',
  'git reset --hard',
  'git status; rm -rf .',
  'git status && rm notes.md',
  'git status || true',
  'git log &',
  'cat $(echo notes.md)',
  'cat `echo notes.md`',
  'cat "$HOME/x"',
  "grep 'a>b' notes.md",
  'cat notes.md\nrm notes.md',
  'find . -delete',
  'find . -name x -exec rm {} ;',
  'find . -execdir rm x',
  'find . -ok rm',
  'find . -fprint out.txt',
  'find . -fprintf out.txt %p',
  'find . -fls out.txt',
  'find . -de{l,}ete',
  'rg --pre=touch x',
  'rg --pre touch x',
  `${W} add x`,
  `${W} remove api`,
  `${W} new x`,
  `${W} refresh`,
  `${W} team fullstack`,
  `${W} team fullstack --dry-run`,
  `${W} install-skills`,
  'wsg guide advisor',
  'wsg add x --dry-run',
  'npx @korbutds/wsg guide advisor',
  'npx @korbutds/wsg add x --dry-run',
  'npx other-package guide',
  'command ls',
  'rm notes.md',
  'mv a b',
  'touch x',
  'node -e "1"',
  'npm test',
  'cd /tmp',
  'FOO=1 git log',
  'cat "unclosed',
  '',
  '   ',
];
for (const c of ALLOWED) it(`allowed: ${c}`, () => assert.deepStrictEqual(G.decide(bash(c)), { allow: true }));
for (const c of BLOCKED) {
  it(`blocked: ${JSON.stringify(c)}`, () => {
    const r = G.decide(bash(c));
    assert.strictEqual(r.allow, false);
    assert.match(r.reason, /^wsg-advisor is read-only: /);
  });
}
it('the reason names the command and says it is not on the list', () => {
  assert.match(G.decide(bash('printf x >> f')).reason, /^wsg-advisor is read-only: printf x >> f is not on its list/);
});
it('a command that is not a string is blocked', () => assert.strictEqual(G.decide({ tool_name: 'Bash', tool_input: { command: 1 } }).allow, false));
it('a Bash call without tool_input is blocked', () => assert.strictEqual(G.decide({ tool_name: 'Bash' }).allow, false));
it('a word knows whether the shell would expand a glob in it', () => {
  const w = G.splitWords(`find . -ex* '-ok*' \\*.md [-]x a*b "*"`);
  assert.deepStrictEqual(w.map((x) => [x.w, x.glob, x.lead]), [
    ['find', false, false], ['.', false, false], ['-ex*', true, false], ['-ok*', false, false], ['*.md', false, false],
    ['[-]x', true, true], ['a*b', true, false], ['*', false, false]]);
});
it('words are split as the shell splits them', () => {
  assert.deepStrictEqual(G.split(`git -C "/a b" log 'x y' c\\ d`), ['git', '-C', '/a b', 'log', 'x y', 'c d']);
  assert.deepStrictEqual(G.split('a ""'), ['a', '']);
  assert.strictEqual(G.split('a "b'), null);
});

console.log('\nthe advisor guard: MCP');
const MCP_ALLOWED = [
  'mcp__tracker__get_issue',
  'mcp__tracker__search_issues',
  'mcp__tracker__get_issue_comments',
  'mcp__tracker__get_issue_transitions',
  'mcp__wiki__getPage',
  'mcp__wiki__list-spaces',
  'mcp__code__list_merge_requests',
  'mcp__code__get_merge_request',
  'mcp__plugin_x_server__fetch_document',
  'mcp__docs__resolve-library-id',
  'mcp__docs__query-docs',
  'mcp__a__describeTable',
];
const MCP_BLOCKED = [
  'mcp__tracker__create_issue',
  'mcp__tracker__update_issue',
  'mcp__tracker__add_comment',
  'mcp__tracker__transition_issue',
  'mcp__tracker__get_and_update_issue',
  'mcp__chat__send_message',
  'mcp__chat__search_and_reply',
  'mcp__code__merge_branch',
  'mcp__code__approveMergeRequest',
  'mcp__code__run_job',
  'mcp__wiki__publish',
  'mcp__wiki__page',
  'mcp__x__setValue',
  'mcp__x__upload-file',
  'mcp__get__delete_item',
];
for (const n of MCP_ALLOWED) it(`allowed: ${n}`, () => assert.deepStrictEqual(G.decide(mcp(n)), { allow: true }));
for (const n of MCP_BLOCKED) {
  it(`blocked: ${n}`, () => {
    const r = G.decide(mcp(n));
    assert.strictEqual(r.allow, false);
    assert.match(r.reason, /^wsg-advisor is read-only: /);
  });
}
it('the server name does not count, only what follows mcp__<server>__', () => {
  assert.strictEqual(G.mcpAllowed('mcp__get_stuff__create_issue'), false);
  assert.strictEqual(G.mcpAllowed('mcp__create_stuff__get_issue'), true);
  assert.strictEqual(G.mcpAllowed('mcp__srv__delete__get'), false);
  assert.strictEqual(G.mcpAllowed('mcp__srv__get__items'), true);
});
it('a name that is not mcp__<server>__<tool> is blocked', () => {
  for (const n of ['mcp__get_issue', 'mcp____get_issue', 'mcp__srv__']) assert.strictEqual(G.mcpAllowed(n), false, n);
});

console.log('\nthe advisor guard: the bypass table');
// Calls a review found the guard let through, and reads that must keep working. Each row: the call,
// whether it may run, why.
const BYPASS = [
  // A `#` starts a comment: the shell drops `--dry-run`, wsg runs for real.
  [bash(`${W} add x # --dry-run`), false, '# comments out --dry-run'],
  [bash(`${W} remove x # --dry-run`), false, '# comments out --dry-run'],
  [bash(`${W} add x #--dry-run`), false, '#word comments out --dry-run'],
  [bash('cat notes.md # x'), false, '# anywhere blocks'],
  // `--dry-run` taken as the value of the flag before it.
  ...['--note', '--branch', '--base', '--target', '--verify', '--carry', '--ws'].map((f) => [bash(`${W} add x ${f} --dry-run`), false, `${f} swallows --dry-run`]),
  [bash(`${W} remove x --ws --dry-run`), false, '--ws swallows --dry-run'],
  [bash(`${W} add x -- --dry-run`), false, '--dry-run after -- is a path'],
  [bash(`${W} add x --dry-run=1`), false, '--dry-run takes no value'],
  [bash(`${W} add x --bogus --dry-run`), false, 'unknown flag'],
  [bash(`${W} add x y --dry-run`), false, 'a second path'],
  [bash(`${W} add --dry-run`), true, 'wsg reports the missing path itself, nothing runs'],
  [bash(`${W} add x --note "a b" --dry-run`), true, '--note takes its value, --dry-run stays'],
  [bash(`${W} add x --dry-run --reset-to-base`), true, 'a dry run of a reset changes nothing'],
  [bash(`${W} remove x --ws /tmp/ws --dry-run`), true, 'remove with --ws and --dry-run'],
  [bash(`${W} add [-][-] --dry-run`), false, 'a glob could become --'],
  [bash(`${W} check --bogus`), false, 'check takes no flags'],
  [bash(`${W} check a b`), false, 'check takes one path'],
  [bash(`${W} guide advisor extra`), false, 'guide takes one topic'],
  [bash(`${W} guide --bogus`), false, 'guide takes no flags'],
  [bash(`${W} guide`), true, 'guide without a topic'],
  [bash(`${W} --where add x`), false, 'a global flag stands alone'],
  [bash('npx @korbutds/wsg guide advisor extra'), false, 'npx is not the wsg the advisor runs'],
  // git runs programs through an external diff or a textconv filter.
  [bash('git diff --ext-diff'), false, '--ext-diff runs diff.external'],
  [bash('git log -p --ext-d'), false, '--ext-diff abbreviated'],
  [bash('git show --textconv HEAD'), false, '--textconv runs a filter'],
  [bash('git log --textc -p'), false, '--textconv abbreviated'],
  [bash('git grep --textconv x'), false, 'grep --textconv'],
  [bash('git diff --no-ext-diff'), true, 'turning it off is fine'],
  [bash('git diff --text'), true, '--text is an option of its own'],
  // A glob in an option word can expand to an option.
  [bash('find . -ex* rm'), false, 'a glob in an option word'],
  [bash('find . -ok?ir x'), false, 'a ? in an option word'],
  [bash('find . -[e]xec rm'), false, 'a [ in an option word'],
  [bash('find . [-]exec rm'), false, 'a word starting with a glob'],
  [bash('rg x *'), false, 'a bare glob can expand to an option of rg'],
  [bash("find . -name '*.md'"), true, 'a quoted glob is literal'],
  [bash('find . -name \\*.md'), true, 'an escaped glob is literal'],
  [bash('ls src/*.js'), true, 'a glob in a path'],
  [bash('cat *.md'), true, 'cat has no option that runs anything'],
  [bash('git log -- src/*.js'), true, 'a glob in a path after --'],
  [bash("git branch --list 'feat*'"), true, 'branch --list with a quoted pattern'],
  [bash('git branch --list feat*'), true, 'branch --list with a pattern'],
  [bash('git branch -a --list feature/*'), true, 'branch -a --list with a pattern'],
  [bash('git branch feat*'), false, 'a pattern without --list creates a branch'],
  [bash('git branch --list -D x'), false, '-D with --list'],
  // MCP: a write that reads on the way, or a write verb the list missed.
  ...['mcp__design__find_replace_text', 'mcp__vcs__resolve_discussion', 'mcp__chat__mark_as_read', 'mcp__chat__messenger-mark-as-read',
    'mcp__x__search_replace', 'mcp__x__find_and_replace', 'mcp__x__toggle_read_state', 'mcp__x__get_and_archive',
    'mcp__x__query_and_insert', 'mcp__x__listAndPurge', 'mcp__srv__delete__get', 'mcp__x__get_and_trash',
    'mcp__x__export_frames', 'mcp__x__download_attachment', 'mcp__x__import_template', 'mcp__x__mark_key_moved',
    'mcp__x__resolve_thread', 'mcp__x__metric_ingest', 'mcp__x__session_reload', 'mcp__x__find_and_lock',
    // False blocks the rule accepts: a share link is looked up, but `share` and `link` write elsewhere.
    'mcp__a__resolve_share_link', 'mcp__a__resolve_calendar_link', 'mcp__x__page', 'mcp__x__promql'].map((n) => [mcp(n), false, 'MCP write or unclear']),
  ...['mcp__proxy__filter_flows', 'mcp__tasks__user_info', 'mcp__tasks__user-info', 'mcp__metrics__sh_metric', 'mcp__files__cloud-stat',
    'mcp__keys__key_history', 'mcp__docs__resolve_library_id',
    'mcp__a__get_proxy_status', 'mcp__code__list_merge_requests'].map((n) => [mcp(n), true, 'MCP read']),
  // `resolve` is a lookup only when the next word says what is looked up: these used to pass on the
  // last word alone.
  ...['mcp__chat__resolve-message-url', 'mcp__a__resolve_thread_url'].map((n) => [mcp(n), false, 'resolve not followed by a LOOKUP word']),
];
for (const [input, allow, why] of BYPASS) {
  const what = input.tool_name === 'Bash' ? JSON.stringify(input.tool_input.command) : input.tool_name;
  it(`${allow ? 'allowed' : 'blocked'}: ${what} (${why})`, () => {
    const r = G.decide(input);
    assert.strictEqual(r.allow, allow, JSON.stringify(r));
    if (!allow) assert.match(r.reason, /^wsg-advisor is read-only: /);
  });
}

console.log('\nthe advisor guard: the allowlist findings');
// The second review: holes a deny list kept leaving. Every allowed binary now has a table of the
// options it takes, and anything else blocks. Each row: the call, whether it may run, why.
const FINDINGS = [
  // 1. symbolic-ref: [-q|--quiet] [--short] <one name>, nothing else.
  [bash('git symbolic-ref -qd refs/remotes/origin/HEAD'), false, '-d in a cluster deletes the symref'],
  [bash('git symbolic-ref -dq refs/remotes/origin/HEAD'), false, '-d in a cluster deletes the symref'],
  [bash('git symbolic-ref --delete HEAD'), false, '--delete'],
  [bash('git symbolic-ref --no-recurse HEAD'), false, 'not in the table'],
  [bash('git symbolic-ref -m x HEAD refs/heads/x'), false, '-m writes'],
  [bash('git symbolic-ref'), false, 'one name is required'],
  [bash('git symbolic-ref --short refs/remotes/origin/HEAD'), true, 'the default branch'],
  [bash('git symbolic-ref -q --short HEAD'), true, '-q and --short'],
  [bash('git symbolic-ref --quiet HEAD'), true, '--quiet'],
  // 2. rg runs programs: --pre, --hostname-bin, --search-zip.
  [bash('rg --hostname-bin=./build.sh --hyperlink-format=default x .'), false, '--hostname-bin runs a program'],
  [bash('rg --hostname-bin ./build.sh --hyperlink-format default x .'), false, '--hostname-bin, space form'],
  [bash("rg --pre-glob '*.gz' x"), false, '--pre-glob'],
  [bash('rg -z x'), false, '-z decompresses with a program'],
  [bash('rg --search-zip x'), false, '--search-zip'],
  [bash('rg -nz x'), false, '-z in a cluster'],
  [bash('rg --no-config --bogus x'), false, 'an option not in the table'],
  [bash('rg -e -x src'), false, 'a value that looks like an option'],
  [bash("rg -uu --hidden -g '*.js' -t js -n -C 3 retry ."), true, 'the usual search'],
  [bash('rg -C3 -m1 -i x'), true, 'values attached in a cluster'],
  [bash('rg --files'), true, '--files'],
  [bash('rg --json --column -o x src'), true, '--json, --column, -o'],
  [bash('rg --sort path --max-depth 2 --no-heading x'), true, '--sort path'],
  [bash('rg -F -w -x -N -l -c -S -s x'), true, 'bool shorts'],
  [bash('rg --glob=!dist -T md --type=js --max-count=1 --no-ignore x'), true, 'long values with ='],
  [bash('rg -e foo -e bar .'), true, '-e twice'],
  // 3. git subcommands: a table each; --ext-diff and --textconv never; a URL never for ls-remote.
  [bash('git log --show-signature'), false, 'runs gpg'],
  [bash('git log --format=%G?'), false, 'a %G format runs gpg'],
  [bash("git log '--pretty=format:%h %GS'"), false, 'a %G format runs gpg'],
  [bash("git for-each-ref '--format=%(signature)'"), false, 'a signature atom runs gpg'],
  [bash('git log --bogus'), false, 'an option not in the table'],
  [bash('git log --ext-diff -p'), false, '--ext-diff'],
  [bash('git diff --no-ext'), false, 'an abbreviation is not an option of the table'],
  [bash('git diff -O/tmp/order'), false, '-O is not in the table'],
  [bash('git diff --output-ind=+'), false, 'abbreviated'],
  [bash('git blame --textconv x'), false, 'blame --textconv'],
  [bash('git show --textconv=x HEAD'), false, '--textconv with a value'],
  [bash('git status --porcelain --bogus'), false, 'status: not in the table'],
  [bash('git ls-files --with-tree=HEAD --bogus'), false, 'ls-files: not in the table'],
  [bash('git rev-parse --parseopt'), false, 'rev-parse: not in the table'],
  [bash('git merge-base --bogus a b'), false, 'merge-base: not in the table'],
  [bash('git grep --open-files-in-pager x'), false, 'grep: the pager'],
  [bash('git -P grep -O x'), false, 'grep -O'],
  [bash('git ls-remote fd::3'), false, 'a transport by name'],
  [bash("git ls-remote 'ext::sh -c touch% x'"), false, 'the ext transport'],
  [bash('git ls-remote origin::x'), false, '<name>:: is a remote helper'],
  [bash('git ls-remote https://example.com/x.git'), false, 'a URL'],
  [bash('git ls-remote host:repo'), false, 'an scp-style URL'],
  [bash('git ls-remote ./other'), false, 'a path'],
  [bash('git ls-remote --server-option=x origin'), false, 'ls-remote: not in the table'],
  [bash('git branch -l foo'), false, '-l was --create-reflog in older git'],
  [bash('git branch -c a b'), false, '-c copies a branch'],
  [bash('git branch --sort=-committerdate x'), false, 'a name without --list creates a branch'],
  [bash('git -C p* log'), false, 'a glob in an option value can become more words'],
  [bash('git l* -1'), false, 'a glob in the subcommand'],
  [bash('git log --grep x*'), false, 'a glob in an option value'],
  [bash('git log --oneline --no-textconv --no-ext-diff -p -5 -- src/a.js'), true, 'turning them off is fine'],
  [bash('git log --format=%h%x09%s --since=2.weeks --author=x -n 3'), true, 'log formats and limits'],
  [bash('git log -S retry --pickaxe-all --stat'), true, 'pickaxe'],
  [bash('git log -L 1,5:src/a.js'), true, 'log -L'],
  [bash('git show --stat --format=fuller HEAD~1'), true, 'show'],
  [bash('git diff --cached --name-status -M50% main...HEAD'), true, 'diff'],
  [bash('git diff -U0 --word-diff=color --color=always HEAD'), true, 'diff with attached optional values'],
  [bash('git status --porcelain=v1 -b -uno'), true, 'status'],
  [bash('git status --short --ignored'), true, 'status'],
  [bash("git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/heads"), false, '( is a shell character, quoted or not'],
  [bash('git for-each-ref --sort=-committerdate --count=5 refs/heads'), true, 'for-each-ref'],
  [bash('git for-each-ref --count 5 refs/heads'), true, 'for-each-ref --count'],
  [bash('git ls-remote'), true, 'the default remote'],
  [bash('git ls-remote origin'), true, 'a configured remote'],
  [bash('git ls-remote .'), true, 'this repository'],
  [bash('git ls-remote --heads --tags origin main'), true, 'with a pattern'],
  [bash('git ls-remote --symref origin HEAD'), true, '--symref'],
  [bash('git blame -w -M -C --date=short -L 1,10 src/a.js'), true, 'blame'],
  [bash('git blame --porcelain --no-textconv HEAD -- src/a.js'), true, 'blame'],
  [bash('git rev-parse --show-toplevel'), true, 'rev-parse'],
  [bash('git rev-parse --verify -q --short=8 HEAD'), true, 'rev-parse'],
  [bash('git merge-base --is-ancestor a b'), true, 'merge-base'],
  [bash('git merge-base --fork-point main'), true, 'merge-base'],
  [bash('git ls-files -co --exclude-standard -z'), true, 'ls-files'],
  [bash('git grep -n -i -e retry -- src'), true, 'git grep'],
  [bash('git grep -C2 --heading --break x HEAD'), true, 'git grep'],
  [bash('git branch -r -v --sort=-committerdate'), true, 'branch listing'],
  [bash('git branch --contains HEAD --list'), true, 'branch --contains'],
  [bash('git branch --merged main'), true, '--merged takes main as its commit and lists'],
  [bash('git -P log -1'), true, '-P is --no-pager'],
  // find: primaries from a table, with their argument counts.
  [bash('find . -printf %p'), false, '-printf is not in the table'],
  [bash('find . -name x -o -delete'), false, '-delete after -o'],
  [bash('find . -fprint0 x'), false, '-fprint0'],
  [bash('find . -depth 2'), false, '-depth takes an argument in one find and not the other'],
  [bash('find . -newer x -exec rm {} +'), false, '-exec'],
  [bash('find -D tree .'), false, '-D'],
  [bash('find . -type f x'), false, 'a word after the expression started is not a primary'],
  [bash('find . -maxdepth 2 -type f -name *.md'), false, 'an unquoted glob in a value'],
  [bash("find -H . -maxdepth 2 -type f -name '*.md' -print"), true, 'the usual find'],
  [bash('find src -size -10k -mtime -1 ! -name x -newermt 2026-01-01'), true, 'values that start with -'],
  [bash('find src/* -prune -o -type d -print0'), true, 'a glob in a path, operators'],
  // The readers: a table too.
  [bash('ls --bogus'), false, 'ls: not in the table'],
  [bash('cat --bogus x'), false, 'cat: not in the table'],
  [bash('head --bogus x'), false, 'head: not in the table'],
  [bash('tail -f journal.md'), false, 'tail -f never ends'],
  [bash('tail -F journal.md'), false, 'tail -F never ends'],
  [bash('wc --bogus x'), false, 'wc: not in the table'],
  [bash('grep -Z x y'), false, 'BSD grep -Z decompresses'],
  [bash('grep --bogus x y'), false, 'grep: not in the table'],
  [bash('pwd x'), false, 'pwd takes no operand'],
  [bash('which --bogus git'), false, 'which: not in the table'],
  [bash('command -V git'), false, 'only command -v'],
  [bash('command -v'), false, 'command -v needs a name'],
  [bash('command -v -p git'), false, 'command -v takes names only'],
  [bash('ls -laR src'), true, 'ls'],
  [bash('ls -1 --color=never src'), true, 'ls'],
  [bash('cat -n notes.md'), true, 'cat'],
  [bash('head -5 notes.md'), true, 'head -NUM'],
  [bash('head -n5 -q a b'), true, 'head'],
  [bash('tail --lines=5 notes.md'), true, 'tail'],
  [bash('wc -lw notes.md'), true, 'wc'],
  [bash("grep -rn --include='*.js' -e retry -A2 src"), true, 'grep'],
  [bash('grep -5 x notes.md'), true, 'grep -NUM'],
  [bash('pwd -P'), true, 'pwd'],
  [bash('which -a git'), true, 'which'],
  [bash('command -v git rg'), true, 'command -v'],
  // 4. MCP: the first word is the read verb, or the second after a prefix.
  ...['rebuild_search_index', 'follow_list', 'block_user_list', 'notify_list', 'fork_repo_list', 'make_list', 'tag_search_results',
    'find_or_make_issue', 'getOrMake', 'increment_metric', 'report_status', 'wipe_history', 'build_index_status', 'init_details',
    'resolve_issue_by_id', 'query', 'sql_query', 'graphql_query', 'run_cypher', 'gql', 'db_query', 'listUsersANDDelete',
    'get__wipe', 'XMLHttpGetAndPurge', 'stat_file', 'info_update'].map((n) => [mcp(`mcp__x__${n}`), false, 'MCP: not a read']),
  [mcp('mcp__db__query'), false, 'a bare query runs whatever it is given'],
  [mcp('mcp__foo__get__wipe'), false, '__ after the server is a word separator'],
  [mcp('mcp__srv__get____x'), false, 'an empty word between __'],
  [mcp('mcp__srv__get_issué'), false, 'a character a tool name does not have'],
  [mcp('mcp__s.v__get_issue'), false, 'a character a tool name does not have'],
  ...['mcp__wiki_server__wiki_get_page', 'mcp__chat__chat_list_messages', 'mcp__tasks__user_info', 'mcp__metrics__sh_metric',
    'mcp__files__cloud_stat', 'mcp__srv__status', 'mcp__docs__resolve_library_id', 'mcp__docs__query-docs', 'mcp__x__getIssueDetails',
    'mcp__x__getHTTPStatus', 'mcp__x__list_tag_values', 'mcp__ci__get_build_log'].map((n) => [mcp(n), true, 'MCP read']),
  // 5. wsg is this package's CLI, run by node with its absolute path; nothing else.
  [bash('wsg guide advisor'), false, 'bare wsg: whichever is on PATH'],
  [bash('wsg check'), false, 'bare wsg'],
  [bash('npx @korbutds/wsg guide advisor'), false, 'npx fetches and runs a package'],
  [bash('npx -y @korbutds/wsg@0.3.0 guide advisor'), false, 'npx'],
  [bash('node /tmp/other/bin/cli.js guide advisor'), false, 'another script'],
  [bash(`node --require /tmp/x.js "${CLI}" guide advisor`), false, 'a node option before the path'],
  [bash(`node "${CLI}x" guide`), false, 'a path that only starts with it'],
  [bash(`node "${ROOT}/lib/../bin/cli.js" guide`), false, 'the path is compared as written'],
  [bash(`node "${ROOT}//bin/cli.js" guide`), false, 'the path is compared as written'],
  [bash(`node "${CLI}" add x`), false, 'add without --dry-run'],
  [bash(`node "${CLI}"`), false, 'no command'],
  [bash('node -e 1'), false, 'node -e'],
  [bash(`node "${CLI}" add x --note --dry-run`), false, '--note swallows --dry-run'],
  [bash(`node "${CLI}" guide advisor`), true, 'the guide'],
  [bash(`node "${CLI}" add /tmp/repo --branch feature/X-1 --dry-run`), true, 'a dry run'],
  [bash(`node '${CLI}' --where`), true, 'single quotes'],
  // 6. Input hygiene: control characters and Unicode spaces anywhere; only space and tab trimmed.
  ...['cat notes.md rm x', 'cat\u000bnotes.md', 'git log\u0000', '﻿git log', 'git​log', ' git log -1',
    'git log -1 ', 'cat notes.md\u0085', 'cat\u000cnotes.md', 'git log\u007f', 'ls ', 'cat　x', 'cat x',
    'git log -1\r'].map((c) => [bash(c), false, `a control character or Unicode space: ${JSON.stringify(c)}`]),
  [bash('\tgit log -1\t'), true, 'tabs are trimmed'],
  // zsh EXTENDED_GLOB: ^x is "every file but x", ~ a home or an exclusion.
  [bash('rg x ^README'), false, '^ at the start of a word'],
  [bash('rg -n x ~/notes'), false, '~ at the start of a word'],
  [bash('git -C ~/repo log'), false, '~ in an option value'],
  [bash('find . -name x ^y'), false, '^ in find'],
  [bash('cat ~/notes.md'), true, 'cat has no option that runs anything'],
  // 7. The third review. git -C <dir> runs <dir>'s repository config (core.fsmonitor): only the
  // workspace, its sources and what is under them, after realpath; the workspace is found from cwd.
  [bash(`git -C ${EVIL} status`), false, 'a repository outside the workspace'],
  [bash(`git -C ${FX} log`), false, 'the directory above the workspace'],
  [bash(`git -C ${FX}/ws-other log`), false, 'a sibling of the workspace'],
  [bash(`git -C ${WS}/../evil log`), false, '.. out of the workspace'],
  [bash(`git -C ${WS}/evil-link status`), false, 'a symlink in the workspace to a directory outside'],
  [bash(`git -C ${REPO}/evil-link log`), false, 'a symlink in a source to a directory outside'],
  [bash(`git -C ${REPO}/vendor/bare status`), false, 'a bare repository committed inside a source'],
  [bash(`git -C ${REPO}/vendor/bare/refs log`), false, 'under a bare repository inside a source'],
  [bash(`git -C ${FX}/gone log`), false, 'a source whose path is gone'],
  [bash(`git -C ${WS}/nope log`), false, 'a directory that does not exist'],
  [bash('git -C ../evil log', WS), false, 'relative, out of the workspace'],
  [bash(`git -C ${WS} -C ../evil status`), false, 'the second -C leaves the workspace'],
  [bash(`git -C ${EVIL} -C ${WS} status`), false, 'every -C must be in the workspace'],
  [bash(`git -C ${WS} log`, EVIL), false, 'no workspace at or above cwd: no -C at all'],
  [{ tool_name: 'Bash', tool_input: { command: `git -C ${REPO} log` } }, false, 'no cwd in the hook input: no -C at all'],
  [bash('git -C "" log'), false, 'an empty -C'],
  [bash(`git -C ${WS} status`), true, 'the workspace'],
  [bash(`git -C ${WT} status`), true, 'a worktree in the workspace'],
  [bash(`git -C ${WS}/svc-link log -1`), true, 'a symlink to a source'],
  [bash(`git -C ${REPO}/src log`), true, 'a directory of a source'],
  [bash('git -C svc log', WS), true, 'relative to cwd'],
  [bash(`git -C ${WS} -C svc status`), true, '-C after -C'],
  [bash('git status', EVIL), true, 'without -C git runs where the session is, as before'],
  // git ls-remote <name>: only a remote the repository configures; any other name is a path to git.
  [bash('git ls-remote origin'), true, 'origin, from the config of the worktree\'s common git dir'],
  [bash(`git -C ${REPO} ls-remote --heads origin`), true, 'origin of the source'],
  [bash('git ls-remote nourl'), false, 'a remote section without a url'],
  [bash('git ls-remote upstream'), false, 'not a remote section'],
  [bash('git ls-remote evil'), false, 'not configured'],
  [bash('git ls-remote origin', WS), false, 'the workspace is no repository: origin is the directory of that name'],
  [bash(`git -C ${WS} ls-remote origin`), false, 'the same with -C'],
  [{ tool_name: 'Bash', tool_input: { command: 'git ls-remote origin' } }, false, 'no cwd: no repository to read remotes from'],
  [bash('git ls-remote', WS), true, 'the default remote'],
  [bash('git ls-remote .'), true, 'this repository'],
  // MCP: a prefix is a word of the server's name or a generic one, never just a short word.
  ...['sort_list_items', 'hide_list_item', 'flag_search_result', 'clean_list_cache', 'pay_list_invoices', 'nuke_search_x', 'ack_status']
    .map((n) => [mcp(`mcp__x__${n}`), false, 'MCP: a short word is no prefix']),
  ...['mcp__issues__issue_get_comments', 'mcp__x__sh_list_metrics', 'mcp__x__db_list_tables', 'mcp__x__wiki_search_pages',
    'mcp__sort__sort_list_items', 'mcp__x__query_docs', 'mcp__x__query_issues'].map((n) => [mcp(n), true, 'MCP: a prefix of the server or a generic one']),
  // Query languages, whatever the verb: any word ending in `ql`; `query` with only RAW words after it.
  ...['yql', 'get_yql_result', 'kql_search', 'get_hql', 'sparql_select', 'get_promql_range', 'searchGraphQL', 'list_ql',
    'query_raw', 'query_raw_sql', 'queryRaw', 'query_statement', 'get_cypher'].map((n) => [mcp(`mcp__x__${n}`), false, 'MCP: a query language']),
  // node <CLI> add: && || | ; ( ) # < > only inside a quoted --verify or --note value.
  [bash(`${W} add ${REPO} --verify "npm run lint && npm test" --dry-run`), true, '&& inside a quoted --verify'],
  [bash(`${W} add x --note "a | b (c) #1" --dry-run`), true, '| ( ) # inside a quoted --note'],
  [bash(`${W} add x --verify 'a && b' --dry-run`), true, 'single quotes'],
  [bash(`${W} add x --verify="a; b" --note='x<y>z || w' --dry-run`), true, 'attached values'],
  [bash(`${W} add x --verify "a" && rm x --dry-run`), false, '&& after the quote'],
  [bash(`${W} add x --verify "a && b --dry-run`), false, 'an unbalanced quote'],
  [bash(`${W} add x --verify 'a' #x --dry-run`), false, '# outside the quotes'],
  [bash(`${W} add x --verify "a"#x --dry-run`), false, '# right after the quote'],
  [bash(`${W} add x --note "a" > out --dry-run`), false, '> outside the quotes'],
  [bash(`${W} add x --verify a\\&\\&b --dry-run`), false, 'escaped, not quoted'],
  [bash(`${W} add x --verify "a\\" && b" --dry-run`), true, 'an escaped " stays inside the quotes'],
  [bash(`${W} add x --verify 'a\\' && b' --dry-run`), false, 'no escape inside single quotes: && is outside'],
  [bash(`${W} add "x;y" --dry-run`), false, 'a path is no free text'],
  [bash(`${W} add x --branch "a;b" --dry-run`), false, '--branch is no free text'],
  [bash(`${W} add --note --verify "a;b" --dry-run`), false, '--note takes --verify, "a;b" is the path'],
  [bash(`${W} add x -- --verify "a;b"`), false, 'after -- it is a path'],
  [bash(`${W} add x --verify "$(touch y)" --dry-run`), false, '$ blocks anywhere'],
  [bash(`${W} add x --verify "\`touch y\`" --dry-run`), false, 'a backtick blocks anywhere'],
  [bash(`${W} add x --verify "a {b}" --dry-run`), false, 'braces block anywhere'],
  [bash(`${W} add x --verify "a\nb" --dry-run`), false, 'a line break blocks anywhere'],
  [bash(`${W} add x --verify "a && b"`), false, 'still no --dry-run'],
  [bash(`${W} remove x --ws "a;b" --dry-run`), false, 'remove has no free text'],
  [bash(`${W} check "a;b"`), false, 'check has no free text'],
  [bash("grep 'a;b' notes.md"), false, 'only node <CLI> add takes quoted operators'],
  [bash(`${W} help`), true, 'help'],
  [bash(`${W} help add`), false, 'help takes nothing'],
  // What a block reason suggests instead of a format with ( ) must pass.
  [bash('git for-each-ref --sort=-committerdate refs/heads'), true, 'branches by date'],
  [bash('git branch -v --sort=-committerdate'), true, 'branches by date'],
  // The sibling-workspace search of the guide, a form zsh does not refuse when a glob matches nothing.
  [bash("grep -ril 'SPEC-42' /tmp/ws --include=notes.md --include=AGENTS.md --include=LEARNINGS.md --include=ERRORS.md --exclude-dir=node_modules --exclude-dir=.git"), true, 'the guide\'s sibling search'],
  // 8. The fourth review. Sorting on a signature runs gpg, as a %G format does.
  [bash('git for-each-ref --sort=signature:grade refs/heads'), false, 'a signature sort key runs gpg'],
  [bash('git for-each-ref --sort=-*signature refs/tags'), false, 'reversed, dereferenced'],
  [bash('git for-each-ref --sort=v:signature:grade'), false, 'a version sort of it'],
  [bash('git for-each-ref --sort signature'), false, 'the value as the next word'],
  [bash('git branch --sort=signature'), false, 'branch sorts the same way'],
  [bash('git branch -v --sort=-signature:signer'), false, 'reversed'],
  [bash('git ls-remote --sort=signature origin'), false, 'ls-remote sorts the same way'],
  [bash('git log --format=%GK'), false, 'a %G format still runs gpg'],
  [bash('git show --pretty=format:%G? HEAD'), false, 'a %G format still runs gpg'],
  [bash('git log -S%G --oneline'), true, 'a pickaxe search for %G is text, not a format'],
  [bash('git grep -e %G -- src'), true, 'a grep pattern is text'],
  [bash('git branch --sort=-committerdate'), true, 'other sort keys'],
  // --no-optional-locks and --no-lazy-fetch: allowed with -C, -P and --no-pager in any order.
  [bash('git --no-optional-locks --no-lazy-fetch status --porcelain'), true, 'the form the guide asks for'],
  [bash(`git --no-lazy-fetch -C ${REPO} --no-optional-locks -P log -1`), true, 'any order with -C and -P'],
  [bash('git --no-pager --no-optional-locks --no-lazy-fetch diff HEAD'), true, 'with --no-pager'],
  [bash('git status --porcelain'), true, 'not required'],
  [bash('git --no-optional-locks=1 status'), false, 'it takes no value'],
  [bash('git --no-optional-lock status'), false, 'an abbreviation'],
  [bash('git --no-lazy-fetch -c core.pager=x log'), false, '-c still blocks'],
  [bash('git --no-optional-locks push'), false, 'the subcommand is still checked'],
  // --diff-merges=remerge runs the merge again, as --remerge-diff does.
  [bash('git log --diff-merges=remerge -p'), false, 'remerge'],
  [bash('git log --diff-merges=r -p'), false, 'r is remerge'],
  [bash('git show --diff-merges remerge HEAD'), false, 'remerge as the next word'],
  [bash('git log --remerge-diff'), false, 'not in the table'],
  [bash('git log --diff-merges=bogus'), false, 'a value git does not take'],
  [bash('git log --diff-merges=first-parent -p'), true, 'first-parent'],
  [bash('git show --diff-merges=cc HEAD'), true, 'dense-combined'],
  // GNU tail's obsolete form: +1f, -cf follow the file forever.
  [bash('tail +1f journal.md'), false, '+Nf follows'],
  [bash('tail -cf journal.md'), false, '-cf follows'],
  [bash('tail -5f journal.md'), false, '-Nf follows'],
  [bash('tail +f journal.md'), false, '+f follows'],
  [bash('tail +10l journal.md'), true, 'the obsolete form without f'],
  [bash('tail -n +10 journal.md'), true, 'from line 10'],
  [bash('tail -c 100 journal.md'), true, 'bytes'],
  // git branch: --contains, --no-contains, --merged and --no-merged take the next word whatever it
  // is (LASTARG_DEFAULT); with them, or --points-at, branch lists and a word is a pattern.
  [bash('git branch --contains HEAD'), true, '--contains a commit'],
  [bash('git branch --contains'), true, 'the last word: HEAD'],
  [bash('git branch --no-merged main'), true, '--no-merged'],
  [bash('git branch -r --merged origin/main'), true, 'remote branches merged'],
  [bash("git branch --contains HEAD 'feat*'"), true, 'with a pattern'],
  [bash('git branch --points-at HEAD x'), true, '--points-at lists, x is a pattern'],
  [bash('git branch --contains -D x'), true, 'git takes -D as the commit too: an error, nothing deleted'],
  [bash('git branch --contains x* y'), false, 'a glob in the value'],
  [bash('git branch newname'), false, 'creates a branch'],
  [bash('git branch -v newname'), false, '-v does not list: it creates'],
  [bash('git branch newname --sort=refname'), false, '--sort does not list'],
  [bash('git branch --merged main -m a b'), false, '-m is not in the table'],
  [bash('git branch --merged main -d x'), false, '-d is not in the table'],
  [bash('git for-each-ref --contains HEAD refs/heads'), true, 'for-each-ref takes it the same way'],
  // Values only where the tool requires one: an option that takes one optionally or only attached
  // is 'o', and the word after it is an operand.
  [bash('git diff --unified=1 HEAD'), true, '--unified, attached'],
  [bash('git log --min-parents=2 --max-parents=3 --encoding=UTF-8 -1'), true, '=-only in git'],
  [bash('git blame --encoding=UTF-8 src/a.js'), true, '=-only in git'],
  [bash('git rev-parse --since=2.weeks --until=now'), true, '=-only in rev-parse'],
  [bash('git log --encoding *x'), false, 'no value: *x is an operand that could expand to an option'],
  [bash('grep --context=2 x notes.md'), true, '--context attached: optional in BSD grep'],
  [bash('ls -T x'), false, 'ls -T: a full time in BSD, a tab size in GNU'],
  [bash('ls -lT'), false, 'in a cluster'],
  // MCP: a queue or key store write; a query the caller writes; a query language.
  ...['get_del', 'del_key', 'rm_file', 'queue_pop', 'pop_message', 'ack_message', 'consume_events', 'claim_task',
    'dequeue_job', 'read_query', 'query_database', 'query_db', 'query_table', 'query_data', 'queryDatabase', 'get_query',
    'db_read_query', 'search_splunk', 'splunk_search', 'spl_search', 'git_fetch', 'git_fetch_origin', 'git_filter_branch',
    'git_read_tree', 'git_commit', 'git_checkout', 'git_branch', 'open_nodes'].map((n) => [mcp(`mcp__x__${n}`), false, 'MCP: not a read']),
  // Kept blocked on purpose: a query language, even one for search.
  ...['mcp__tracker__search_issues_jql', 'mcp__wiki__search_pages_cql', 'mcp__wiki__cql_search'].map((n) => [mcp(n), false, 'MCP: a query language, deliberate']),
  ...['git_log', 'git_show', 'git_diff', 'git_diff_staged', 'git_diff_unstaged', 'git_status', 'git_blame', 'git_list_branches',
    'directory_tree', 'query_docs', 'list_display_modes', 'get_split_view'].map((n) => [mcp(`mcp__x__${n}`), true, 'MCP read']),
];
let findingsFailed = 0;
for (const [input, allow, why] of FINDINGS) {
  const what = input.tool_name === 'Bash' ? JSON.stringify(input.tool_input.command) : input.tool_name;
  it(`${allow ? 'allowed' : 'blocked'}: ${what} (${why})`, () => {
    const r = G.decide(input);
    if (r.allow !== allow) findingsFailed++;
    assert.strictEqual(r.allow, allow, JSON.stringify(r));
    if (!allow) assert.match(r.reason, /^wsg-advisor is read-only: /);
  });
}
console.log(`  findings: ${FINDINGS.length - findingsFailed}/${FINDINGS.length} as expected`);
it('a block on -C names the allowed roots', () => {
  assert.match(G.decide(bash(`git -C ${EVIL} status`)).reason, new RegExp(`git -C only in the workspace and its sources: ${WS}, ${REPO}\\.`));
  assert.match(G.decide(bash(`git -C ${WS} log`, EVIL)).reason, /git -C needs a workspace: none at or above the session directory/);
});
it('a block on ( suggests the forms without a format', () => {
  const r = G.decide(bash("git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/heads"));
  assert.match(r.reason, /git for-each-ref --sort=-committerdate refs\/heads or git branch -v --sort=-committerdate/);
});
it('the guide\'s sibling search passes the guard as written', () => {
  const guide = fs.readFileSync(path.join(ROOT, 'docs', 'advisor-guide.md'), 'utf8');
  const m = /`(grep -ril '<ticket or term>' <WS_ROOT> [^`]+)`/.exec(guide);
  assert.ok(m, 'the guide has the grep -ril form');
  assert.deepStrictEqual(G.decide(bash(m[1].replace('<ticket or term>', 'SPEC-42').replace('<WS_ROOT>', '/tmp/ws'))), { allow: true });
  assert.doesNotMatch(guide, /<WS_ROOT>\/\*\//, 'no glob over <WS_ROOT>/*/: zsh refuses one that matches nothing');
});
it('the guide\'s git commands run with --no-optional-locks --no-lazy-fetch and pass the guard', () => {
  const guide = fs.readFileSync(path.join(ROOT, 'docs', 'advisor-guide.md'), 'utf8');
  const cmds = [...guide.matchAll(/`(git [^`]+)`/g)].map((m) => m[1]).filter((c) => /^git (--no-optional-locks --no-lazy-fetch |log |blame |for-each-ref |symbolic-ref )/.test(c));
  assert.ok(cmds.length >= 5, cmds.join('\n'));
  for (const c of cmds) {
    assert.match(c, /^git --no-optional-locks --no-lazy-fetch /, c);
    const run = c.replace('<file>', 'src/a.js').replace('<a>,<b>', '1,5').replace('<term>', 'retry');
    if (run.includes('…')) continue;
    assert.deepStrictEqual(G.decide(bash(run)), { allow: true }, run);
  }
  for (const f of [path.join('claude', 'agents', 'wsg-advisor.md'), path.join('codex', 'agents', 'wsg-advisor.toml')]) {
    assert.ok(fs.readFileSync(path.join(ROOT, 'templates', f), 'utf8').includes('Every git command as `git --no-optional-locks --no-lazy-fetch …`'), f);
  }
});
it('the workspace is the nearest directory with .claude/wsg.json, with its sources', () => {
  assert.deepStrictEqual(G.workspaceOf(path.join(REPO, 'src')), null);
  assert.deepStrictEqual(G.workspaceOf(path.join(WS, 'a dir')), { ws: WS, roots: [WS, REPO] });
  assert.strictEqual(G.workspaceOf('relative/dir'), null);
});

console.log('\nthe advisor guard: anything else');
// The hook matches every tool: only the ones that read pass, the rest block — a subagent could
// write for it, Monitor runs a shell. SubagentHandback carries a backgrounded advisor's report back.
for (const t of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
  'SubagentHandback']) {
  it(`allowed: ${t}`, () => assert.deepStrictEqual(G.decide({ tool_name: t, tool_input: {} }), { allow: true }));
}
for (const t of ['Write', 'Edit', 'NotebookEdit', 'Agent', 'Task', 'Monitor', 'EnterWorktree', 'ExitWorktree', 'Artifact', 'ArtifactData',
  'TaskStop', 'Skill', 'CronCreate', 'RemoteTrigger', 'SendMessage', 'Workflow', 'PushNotification', 'TodoWrite', 'SomeNewTool', '', undefined]) {
  it(`blocked: ${t}`, () => {
    const r = G.decide({ tool_name: t, tool_input: {} });
    assert.strictEqual(r.allow, false);
    assert.match(r.reason, /^wsg-advisor is read-only: /);
  });
}
it('no input is blocked', () => {
  assert.strictEqual(G.decide(null).allow, false);
  assert.strictEqual(G.decide('Bash').allow, false);
});

console.log('\nthe advisor guard as a hook script');
const run = (input) => {
  const r = spawnSync(process.execPath, [GUARD], { input, encoding: 'utf8' });
  return { code: r.status, err: r.stderr };
};
it('an allowed call: exit 0, nothing on stderr', () => assert.deepStrictEqual(run(JSON.stringify(bash('cat notes.md'))), { code: 0, err: '' }));
it('a blocked call: exit 2 with the reason on stderr', () => {
  const r = run(JSON.stringify({ ...bash('printf x >> notes.md'), agent_type: 'wsg-advisor', hook_event_name: 'PreToolUse' }));
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /^wsg-advisor is read-only: printf x >> notes\.md is not on its list/);
});
it('a tool outside the list: exit 2', () => assert.strictEqual(run(JSON.stringify({ tool_name: 'Agent', tool_input: { prompt: 'write x' } })).code, 2));
it('SubagentHandback: exit 0', () => assert.strictEqual(run(JSON.stringify({ tool_name: 'SubagentHandback', tool_input: { message: 'FOR THE OWNER' } })).code, 0));
it('Read: exit 0', () => assert.strictEqual(run(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' } })).code, 0));
it('a blocked MCP call: exit 2', () => assert.strictEqual(run(JSON.stringify(mcp('mcp__tracker__create_issue'))).code, 2));
it('malformed JSON: exit 2', () => {
  const r = run('{"tool_name": "Bash", ');
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /unreadable hook input/);
});
it('empty input: exit 2', () => assert.strictEqual(run('').code, 2));
it('the wsg it allows is bin/cli.js of its own package', () => assert.strictEqual(G.WSG_CLI, CLI));
it('a guard in another package allows that package\'s CLI, not this one', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  // Real: node resolves the guard's __dirname through symlinks, and so does install-skills.
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-guard-')));
  try {
    fs.mkdirSync(path.join(other, 'lib'));
    for (const f of ['advisor-guard.js', 'flags.js']) fs.copyFileSync(path.join(ROOT, 'lib', f), path.join(other, 'lib', f));
    const guard = path.join(other, 'lib', 'advisor-guard.js');
    const code = (cmd) => spawnSync(process.execPath, [guard], { input: JSON.stringify(bash(cmd)), encoding: 'utf8' }).status;
    assert.strictEqual(code(`node "${path.join(other, 'bin', 'cli.js')}" guide advisor`), 0);
    assert.strictEqual(code(`${W} guide advisor`), 2);
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});
it('JSON that is not an object: exit 2', () => assert.strictEqual(run('42').code, 2));

console.log(failed === 0 ? '\nall checks passed\n' : `\nfailed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
