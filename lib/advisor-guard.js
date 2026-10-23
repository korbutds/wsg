#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { FLAGS, GLOBAL, parse: parseFlags } = require(path.join(__dirname, 'flags.js'));

// The PreToolUse hook of the Claude Code wsg-advisor agent: it keeps the advisor read-only for
// Bash and MCP tools, which `disallowedTools` cannot do. Claude Code passes the call as JSON on
// stdin; exit 0 lets it run, exit 2 blocks it and shows stderr to the agent. Anything unexpected —
// bad JSON, an unknown tool, an exception — blocks: a guard that fails open guards nothing.
//
// Bash: one plain command from a fixed list. Any shell operator or expansion character blocks the
// command, quoted or not: telling a quoted `>` from a redirection is where a guard goes wrong.
// MCP: the tool's own name must say it reads (get, list, search…) and must not say it writes.
// A list, not a sandbox: the advisor can still read anything its tools reach.

// > < | ; & ` $ ( ) { } # and line breaks. `{}` because brace expansion can build an option
// (`-de{l,}ete`); `$` because an expansion is decided after this check; `#` because it starts a
// comment, and `wsg add x # --dry-run` would run without its `--dry-run`.
const SHELL_CHARS = /[><|;&`$(){}#\n\r]/;
const GLOB = '*?[';

// Splits as the shell would for a command with none of SHELL_CHARS: blanks separate words,
// '…' is literal, "…" and a backslash escape. Each word also says whether it holds a glob
// character the shell would expand (`glob`) and whether it starts with one (`lead`).
// null for an unclosed quote.
function splitWords(cmd) {
  const words = [];
  let cur = null;
  let quote = null;
  const start = () => { cur = { w: '', glob: false, lead: false }; };
  const lit = (c) => { cur.w += c; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else lit(c);
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < cmd.length && '"\\'.includes(cmd[i + 1])) lit(cmd[++i]);
      else lit(c);
    } else if (c === ' ' || c === '\t') {
      if (cur !== null) words.push(cur);
      cur = null;
    } else {
      if (cur === null) start();
      if (c === "'" || c === '"') quote = c;
      else if (c === '\\') {
        if (i + 1 >= cmd.length) return null;
        lit(cmd[++i]);
      } else {
        if (GLOB.includes(c)) {
          if (cur.w === '') cur.lead = true;
          cur.glob = true;
        }
        lit(c);
      }
    }
  }
  if (quote) return null;
  if (cur !== null) words.push(cur);
  return words;
}
const split = (cmd) => {
  const ws = splitWords(cmd);
  return ws && ws.map((x) => x.w);
};

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
  // An external diff and a textconv filter are programs: --ext-diff, --textconv and any prefix of
  // them, but `--text`, an option of its own, which git takes as it is.
  if (['diff', 'show', 'log', 'grep'].includes(sub) && rest.some((a) => longOf(a) !== 'text' && abbreviates(a, 'ext-diff', 'textconv'))) return false;
  // grep -O / --open-files-in-pager runs a pager of its choice.
  if (sub === 'grep' && rest.some((a) => abbreviates(a, 'open-files-in-pager') || (shortCluster(a) && a.includes('O')))) return false;
  // `git branch x` creates, -D deletes, -m renames: only the listing forms; with --list, the
  // words that are not options are patterns.
  if (sub === 'branch') {
    const list = rest.includes('--list');
    return rest.every((a) => BRANCH_FLAGS.has(a) || (list && !a.startsWith('-')));
  }
  // `git symbolic-ref HEAD refs/heads/x` writes; reading takes one name.
  if (sub === 'symbolic-ref') {
    const names = rest.filter((a) => !a.startsWith('-'));
    return names.length <= 1 && !rest.some((a) => a === '-d' || abbreviates(a, 'delete') || a === '-m');
  }
  return true;
}

// guide takes at most a topic, check at most a path, the global flags stand alone. add and
// remove are parsed as the CLI parses them (lib/flags.js): the guard and wsg must agree on what
// `--dry-run` is, or `--note --dry-run` passes here and runs for real there. Allowed only when the
// parse succeeds — no unknown flag, no extra path — and `--dry-run` is set; after `--` it would
// be a path, and the parse never sets it.
function guideAllowed(rest) {
  return rest.length === 0 || (rest.length === 1 && /^[a-z]+$/.test(rest[0]));
}

function wsgAllowed(args) {
  const [sub, ...rest] = args;
  if (GLOBAL.includes(sub)) return rest.length === 0;
  if (sub === 'guide') return guideAllowed(rest);
  if (sub === 'check') return !parseFlags(rest, FLAGS.check, 1).error;
  if (sub === 'add' || sub === 'remove') {
    const r = parseFlags(rest, FLAGS[sub], 1);
    return !r.error && r.flags['--dry-run'] === true;
  }
  return false;
}

// npx [--yes|-y] @korbutds/wsg[@version] guide [topic]
function npxAllowed(args) {
  let i = 0;
  if (args[i] === '--yes' || args[i] === '-y') i++;
  return /^@korbutds\/wsg(@[\w.-]+)?$/.test(args[i] || '') && args[i + 1] === 'guide' && guideAllowed(args.slice(i + 2));
}

function findAllowed(args) {
  // -exec, -execdir, -ok, -okdir, -fprint, -fprint0, -fprintf, -fls, -delete.
  return !args.some((a) => /^-(exec|ok|fprint)/.test(a) || a === '-fls' || a === '-delete');
}

// None of their options runs a program or writes, so a glob may expand to any of them.
const READERS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'pwd', 'which']);

// A glob the shell expands can become an option the checks below never saw: `find . -ex*` is
// `-exec` once a file of that name is there. So no unquoted glob in a word that is an option or
// that starts with the glob (`[-]exec`), but for READERS. A glob inside a path (`src/*.js`) or a
// pattern (`feat*`) stays.
const globSafe = (name, words) => READERS.has(name) || words.every((x) => !x.glob || (!x.lead && !x.w.startsWith('-')));

function bashAllowed(cmd) {
  if (typeof cmd !== 'string' || SHELL_CHARS.test(cmd)) return false;
  const words = splitWords(cmd.trim());
  if (!words || !words.length || words[0].glob) return false;
  const [name, ...args] = words.map((x) => x.w);
  if (!globSafe(name, words.slice(1))) return false;
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

// MCP: the name after mcp__<server>__ (everything after it, `__` included) in words — get_issue,
// listMergeRequests, search-pages: split on _, -, and camelCase, lower case. The first verb in it
// must be a read verb, and no word anywhere a write verb or `and`/`then`: find_replace_text,
// get_and_archive and mark_as_read write. A name with no verb at all (user_info, sh_metric) reads
// only when its last word is a READ_NOUNS one. A word that is neither is ignored, so a write
// verb the list misses passes only after a read verb: false blocks are fine, false allows not.
const words = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').split(/[_-]+/).filter(Boolean).map((w) => w.toLowerCase());
const READ_VERBS = new Set(['get', 'list', 'search', 'fetch', 'find', 'read', 'query', 'view', 'describe', 'show', 'lookup',
  'stat', 'info', 'count', 'filter']);
const WRITE_VERBS = new Set([
  'create', 'update', 'delete', 'remove', 'add', 'set', 'send', 'post', 'put', 'patch', 'generate', 'export', 'login', 'auth',
  'transition', 'assign', 'upload', 'move', 'copy', 'write', 'edit', 'comment', 'reply', 'publish', 'run', 'execute', 'trigger',
  'approve', 'reject', 'merge', 'replace', 'mark', 'toggle', 'archive', 'insert', 'upsert', 'purge', 'import', 'save', 'download',
  'install', 'apply', 'complete', 'rename', 'clear', 'submit', 'cancel', 'schedule', 'invalidate', 'reload', 'enable', 'disable',
  'lock', 'unlock', 'link', 'unlink', 'inject', 'open', 'close', 'resolve', 'reopen', 'start', 'stop', 'restart', 'kill', 'sync',
  'refresh', 'reset', 'revert', 'commit', 'push',
  // Not in the list a review asked for, met in real servers.
  'trash', 'untrash', 'label', 'unlabel', 'spam', 'respond', 'join', 'leave', 'flush', 'unsubscribe', 'subscribe', 'invite',
  'share', 'grant', 'revoke', 'deploy', 'restore', 'register', 'bind', 'attach', 'detach', 'clone', 'group', 'ungroup', 'swap',
  'resize', 'rotate', 'reorder', 'reparent', 'reschedule', 'uncomplete', 'draft', 'modify', 'change', 'quit', 'uninstall',
  'navigate', 'switch', 'drop', 'truncate', 'destroy', 'terminate', 'prune', 'compose', 'forward', 'mutation', 'pin', 'unpin',
  'star', 'react', 'mute', 'book', 'answer', 'and', 'then',
]);
const READ_NOUNS = new Set(['info', 'stat', 'stats', 'metric', 'metrics', 'status', 'overview', 'history', 'details']);
// resolve_library_id and resolve-message-url look a name up; resolve_discussion closes a thread.
const LOOKUP = new Set(['id', 'ids', 'url', 'urls', 'uri', 'link', 'links', 'library', 'name', 'names']);

function mcpAllowed(tool) {
  const parts = tool.split('__');
  if (parts.length < 3 || parts[0] !== 'mcp' || !parts[1]) return false;
  const ws = words(parts.slice(2).join('__'))
    // "merge request" is a thing, not the act of merging: list_merge_requests only reads.
    .filter((w, i, all) => !(w === 'merge' && /^requests?$/.test(all[i + 1] || '')))
    .map((w, i, all) => (w === 'resolve' && (LOOKUP.has(all[i + 1]) || LOOKUP.has(all[all.length - 1])) ? 'lookup' : w));
  if (!ws.length || ws.some((w) => WRITE_VERBS.has(w))) return false;
  const verb = ws.find((w) => READ_VERBS.has(w));
  return verb ? true : READ_NOUNS.has(ws[ws.length - 1]);
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

module.exports = { decide, split, splitWords, bashAllowed, mcpAllowed };
