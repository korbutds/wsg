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
  'wsg guide advisor',
  'wsg check',
  'wsg check /tmp/ws/x',
  'wsg --where',
  'wsg --help',
  'wsg --version',
  'wsg add x --dry-run',
  'wsg add /tmp/repo --branch feature/X-1 --verify "npm test" --dry-run',
  'wsg remove api --dry-run',
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
  'npx @korbutds/wsg guide advisor',
  'npx --yes @korbutds/wsg guide advisor',
  'npx -y @korbutds/wsg@0.3.0 guide advisor',
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
  'wsg add x',
  'wsg remove api',
  'wsg new x',
  'wsg refresh',
  'wsg install-skills',
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
  [bash('wsg add x # --dry-run'), false, '# comments out --dry-run'],
  [bash('wsg remove x # --dry-run'), false, '# comments out --dry-run'],
  [bash('wsg add x #--dry-run'), false, '#word comments out --dry-run'],
  [bash('cat notes.md # x'), false, '# anywhere blocks'],
  // `--dry-run` taken as the value of the flag before it.
  ...['--note', '--branch', '--base', '--target', '--verify', '--carry', '--ws'].map((f) => [bash(`wsg add x ${f} --dry-run`), false, `${f} swallows --dry-run`]),
  [bash('wsg remove x --ws --dry-run'), false, '--ws swallows --dry-run'],
  [bash('wsg add x -- --dry-run'), false, '--dry-run after -- is a path'],
  [bash('wsg add x --dry-run=1'), false, '--dry-run takes no value'],
  [bash('wsg add x --bogus --dry-run'), false, 'unknown flag'],
  [bash('wsg add x y --dry-run'), false, 'a second path'],
  [bash('wsg add --dry-run'), true, 'wsg reports the missing path itself, nothing runs'],
  [bash('wsg add x --note "a b" --dry-run'), true, '--note takes its value, --dry-run stays'],
  [bash('wsg add x --dry-run --reset-to-base'), true, 'a dry run of a reset changes nothing'],
  [bash('wsg remove x --ws /tmp/ws --dry-run'), true, 'remove with --ws and --dry-run'],
  [bash('wsg add [-][-] --dry-run'), false, 'a glob could become --'],
  [bash('wsg check --bogus'), false, 'check takes no flags'],
  [bash('wsg check a b'), false, 'check takes one path'],
  [bash('wsg guide advisor extra'), false, 'guide takes one topic'],
  [bash('wsg guide --bogus'), false, 'guide takes no flags'],
  [bash('wsg guide'), true, 'guide without a topic'],
  [bash('wsg --where add x'), false, 'a global flag stands alone'],
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
    'mcp__keys__key_history', 'mcp__chat__resolve-message-url', 'mcp__docs__resolve_library_id', 'mcp__a__resolve_thread_url',
    'mcp__a__get_proxy_status', 'mcp__code__list_merge_requests'].map((n) => [mcp(n), true, 'MCP read']),
];
for (const [input, allow, why] of BYPASS) {
  const what = input.tool_name === 'Bash' ? JSON.stringify(input.tool_input.command) : input.tool_name;
  it(`${allow ? 'allowed' : 'blocked'}: ${what} (${why})`, () => {
    const r = G.decide(input);
    assert.strictEqual(r.allow, allow, JSON.stringify(r));
    if (!allow) assert.match(r.reason, /^wsg-advisor is read-only: /);
  });
}

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
it('JSON that is not an object: exit 2', () => assert.strictEqual(run('42').code, 2));

console.log(failed === 0 ? '\nall checks passed\n' : `\nfailed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
