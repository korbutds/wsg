'use strict';

// lib/advisor-guard.js, the PreToolUse hook of the Claude Code wsg-advisor: a table of calls it
// lets through and calls it blocks, then the script itself as Claude Code runs it — JSON on stdin,
// exit 0 or 2.

const assert = require('node:assert');
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

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command, description: 'x' } });
const mcp = (name) => ({ tool_name: name, tool_input: {} });

console.log('\nthe advisor guard: Bash');
const ALLOWED = [
  'git log --oneline -5',
  'git -C /tmp/repo log -1',
  'git -C "/tmp/a dir" show HEAD:package.json',
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
  'wsg guide advisor',
  'wsg add x --dry-run',
  'npx @korbutds/wsg guide advisor',
  'npx --yes @korbutds/wsg guide advisor',
  'npx -y @korbutds/wsg@0.3.0 guide advisor',
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
  `${W} install-skills`,
  'wsg add x',
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
  [bash('npx @korbutds/wsg guide advisor extra'), false, 'npx guide: one topic'],
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
  [bash('git branch --merged main'), false, 'a word without --list: could be a name'],
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
  // 5. wsg as this package's CLI, run by node with its absolute path.
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

console.log('\nthe advisor guard: anything else');
// The hook matches every tool: only the ones that read pass, the rest block — a subagent could
// write for it, Monitor runs a shell.
for (const t of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool']) {
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
