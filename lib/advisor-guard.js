#!/usr/bin/env node
'use strict';

// The PreToolUse hook of the Claude Code wsg-advisor agent: it keeps the advisor read-only for
// Bash and MCP tools, which `disallowedTools` cannot do. Claude Code passes the call as JSON on
// stdin; exit 0 lets it run, exit 2 blocks it and shows stderr to the agent. Anything unexpected —
// bad JSON, an unknown tool, an exception — blocks: a guard that fails open guards nothing.
//
// Bash: one plain command from a fixed list. Any shell operator or expansion character blocks the
// command, quoted or not: telling a quoted `>` from a redirection is where a guard goes wrong.
// MCP: the tool's own name must say it reads (get, list, search…) and must not say it writes.
// A list, not a sandbox: the advisor can still read anything its tools reach.

// > < | ; & ` $ ( ) { } and line breaks. `{}` because brace expansion can build an option
// (`-de{l,}ete`); `$` because an expansion is decided after this check.
const SHELL_CHARS = /[><|;&`$(){}\n\r]/;

// Splits as the shell would for a command with none of SHELL_CHARS: blanks separate words,
// '…' is literal, "…" and a backslash escape. null for an unclosed quote.
function split(cmd) {
  const words = [];
  let cur = null;
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < cmd.length && '"\\'.includes(cmd[i + 1])) cur += cmd[++i];
      else cur += c;
    } else if (c === ' ' || c === '\t') {
      if (cur !== null) words.push(cur);
      cur = null;
    } else {
      if (cur === null) cur = '';
      if (c === "'" || c === '"') quote = c;
      else if (c === '\\') {
        if (i + 1 >= cmd.length) return null;
        cur += cmd[++i];
      } else cur += c;
    }
  }
  if (quote) return null;
  if (cur !== null) words.push(cur);
  return words;
}

// `--upl` is `--upload-pack` to git: a long option is matched by any prefix of its name.
const longOf = (arg) => (arg.startsWith('--') && arg.length > 2 ? arg.slice(2).split('=')[0] : null);
const abbreviates = (arg, ...names) => {
  const l = longOf(arg);
  return !!l && names.some((n) => n.startsWith(l));
};
const shortCluster = (arg) => /^-[^-]/.test(arg);

const GIT_READ = new Set(['log', 'show', 'diff', 'status', 'for-each-ref', 'symbolic-ref', 'ls-remote',
  'blame', 'rev-parse', 'merge-base', 'ls-files', 'grep', 'branch']);
const BRANCH_FLAGS = new Set(['--list', '-v', '-vv', '-a', '-r', '--show-current']);

function gitAllowed(args) {
  let i = 0;
  // Global options: only where to run and no pager.
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C' && i + 1 < args.length) i += 2;
    else if (args[i] === '--no-pager') i += 1;
    else return false;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!GIT_READ.has(sub)) return false;
  // Runs a program: --exec and --upload-pack (ls-remote and others).
  if (rest.some((a) => abbreviates(a, 'exec', 'upload-pack'))) return false;
  if (sub === 'ls-remote' && rest.some((a) => shortCluster(a) && a.includes('u'))) return false;
  if (['diff', 'show', 'log'].includes(sub) && rest.some((a) => abbreviates(a, 'output') || a.startsWith('-o'))) return false;
  // grep -O / --open-files-in-pager runs a pager of its choice.
  if (sub === 'grep' && rest.some((a) => abbreviates(a, 'open-files-in-pager') || (shortCluster(a) && a.includes('O')))) return false;
  // `git branch x` creates, -D deletes, -m renames: only the listing forms.
  if (sub === 'branch') return rest.every((a) => BRANCH_FLAGS.has(a));
  // `git symbolic-ref HEAD refs/heads/x` writes; reading takes one name.
  if (sub === 'symbolic-ref') {
    const names = rest.filter((a) => !a.startsWith('-'));
    return names.length <= 1 && !rest.some((a) => a === '-d' || abbreviates(a, 'delete') || a === '-m');
  }
  return true;
}

function wsgAllowed(args) {
  const [sub, ...rest] = args;
  if (['guide', 'check', '--where', '--help', '-h', '--version', '-v'].includes(sub)) return true;
  if (sub === 'add' || sub === 'remove') return rest.includes('--dry-run');
  return false;
}

// npx [--yes|-y] @korbutds/wsg[@version] guide …
function npxAllowed(args) {
  let i = 0;
  if (args[i] === '--yes' || args[i] === '-y') i++;
  return /^@korbutds\/wsg(@[\w.-]+)?$/.test(args[i] || '') && args[i + 1] === 'guide';
}

function findAllowed(args) {
  // -exec, -execdir, -ok, -okdir, -fprint, -fprint0, -fprintf, -fls, -delete.
  return !args.some((a) => /^-(exec|ok|fprint)/.test(a) || a === '-fls' || a === '-delete');
}

const READERS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'pwd', 'which']);

function bashAllowed(cmd) {
  if (typeof cmd !== 'string' || SHELL_CHARS.test(cmd)) return false;
  const argv = split(cmd.trim());
  if (!argv || !argv.length) return false;
  const [name, ...args] = argv;
  if (READERS.has(name)) return true;
  // rg --pre runs a program on every file.
  if (name === 'rg') return !args.some((a) => a === '--pre' || a.startsWith('--pre='));
  if (name === 'find') return findAllowed(args);
  if (name === 'command') return args[0] === '-v' && args.length > 1;
  if (name === 'git') return gitAllowed(args);
  if (name === 'wsg') return wsgAllowed(args);
  if (name === 'npx') return npxAllowed(args);
  return false;
}

// get_issue, listMergeRequests, search-pages → their words, lower case.
const words = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').split(/[_-]+/).filter(Boolean).map((w) => w.toLowerCase());
const READ_VERBS = new Set(['get', 'list', 'search', 'fetch', 'find', 'read', 'query', 'view', 'describe', 'show', 'lookup', 'resolve']);
const WRITE_VERBS = new Set(['create', 'update', 'delete', 'remove', 'add', 'set', 'send', 'post', 'put', 'patch', 'transition',
  'upload', 'move', 'write', 'edit', 'comment', 'reply', 'publish', 'run', 'execute', 'trigger', 'assign', 'merge', 'close', 'approve']);

function mcpAllowed(tool) {
  // mcp__<server>__<tool>; a server name may hold `__` itself, the tool is what follows the last.
  const name = tool.slice(tool.lastIndexOf('__') + 2);
  // "merge request" is a thing, not the act of merging: list_merge_requests only reads.
  const ws = words(name).filter((w, i, all) => !(w === 'merge' && /^requests?$/.test(all[i + 1] || '')));
  return ws.some((w) => READ_VERBS.has(w)) && !ws.some((w) => WRITE_VERBS.has(w));
}

// { allow: true } or { allow: false, reason }.
function decide(input) {
  if (!input || typeof input !== 'object') return { allow: false, reason: 'wsg-advisor guard: no tool call in the hook input' };
  const tool = input.tool_name;
  if (tool === 'Bash') {
    const cmd = input.tool_input && input.tool_input.command;
    if (bashAllowed(cmd)) return { allow: true };
    const shown = typeof cmd === 'string' ? cmd.trim().split('\n')[0].slice(0, 120) : String(cmd);
    return {
      allow: false,
      reason: `wsg-advisor is read-only: ${shown} is not on its list. One plain read command at a time: no pipes, `
        + 'redirection, ;, && or $; git -C <path> instead of cd.',
    };
  }
  if (typeof tool === 'string' && tool.startsWith('mcp__')) {
    if (mcpAllowed(tool)) return { allow: true };
    return { allow: false, reason: `wsg-advisor is read-only: ${tool} is not a tool that only reads (get, list, search, fetch, find…).` };
  }
  return { allow: false, reason: `wsg-advisor guard: ${tool} is not a tool it checks` };
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let r;
    try {
      r = decide(JSON.parse(raw));
    } catch (e) {
      r = { allow: false, reason: `wsg-advisor guard: unreadable hook input (${e.message})` };
    }
    if (r.allow) process.exit(0);
    process.stderr.write(`${r.reason}\n`);
    process.exit(2);
  });
}

if (require.main === module) {
  // Node exits 1 on an uncaught error, and 1 does not block.
  process.on('uncaughtException', (e) => {
    process.stderr.write(`wsg-advisor guard: ${e.message}\n`);
    process.exit(2);
  });
  try {
    main();
  } catch (e) {
    process.stderr.write(`wsg-advisor guard: ${e.message}\n`);
    process.exit(2);
  }
}

module.exports = { decide, split, bashAllowed, mcpAllowed };
