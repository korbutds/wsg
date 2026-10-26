#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { FLAGS, GLOBAL, parse: parseFlags } = require(path.join(__dirname, 'flags.js'));

// The PreToolUse hook of the Claude Code wsg-advisor agent, run before every tool call: it keeps
// the advisor read-only for Bash and MCP tools, which `disallowedTools` cannot do, and blocks any
// tool not known to only read. Claude Code passes the call as JSON on
// stdin; exit 0 lets it run, exit 2 blocks it and shows stderr to the agent. Anything unexpected —
// bad JSON, an unknown tool, an exception — blocks: a guard that fails open guards nothing.
//
// Bash: one plain command, and an allowlist all the way down — the binary, the git subcommand and
// every option each takes. An option not in its table blocks, so does a shell operator or
// expansion character anywhere, quoted or not: telling a quoted `>` from a redirection is where a
// guard goes wrong. MCP: the tool's own name must say it reads (get, list, search…) and must not
// say it writes. A list, not a sandbox: the advisor can still read anything its tools reach.

// > < | ; & ` $ ( ) { } # and line breaks. `{}` because brace expansion can build an option
// (`-de{l,}ete`); `$` because an expansion is decided after this check; `#` because it starts a
// comment, and `wsg add x # --dry-run` would run without its `--dry-run`.
const SHELL_CHARS = /[><|;&`$(){}#\n\r]/;
// A control character or a Unicode space, separator or format character anywhere: the shell and
// this guard could split such a command differently. Space and tab are the only blanks.
const BAD_CHARS = /[\x00-\x08\x0a-\x1f\x7f\p{Cc}\p{Cf}\p{Z}]/u;
const hasBadChars = (cmd) => [...cmd].some((c) => c !== ' ' && c !== '\t' && BAD_CHARS.test(c));
// The characters a shell may expand in a word: bash's * ? [, and zsh's ^ and ~ (EXTENDED_GLOB:
// `^x` is every file but x; `~` a home directory, or an exclusion inside a pattern).
const GLOB = '*?[^~';

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

// --- option tables
//
// A table: { short: { c: type }, long: { name: type }, num } with type
//   'b'  takes no value;
//   'v'  takes one: attached (`-n5`, `--max-count=5`) or as the next word, which must not start
//        with `-` — had the tool taken the option as 'b', that word would be an option to it;
//   'o'  takes one only attached (`-U3`, `--stat=50`), never the next word;
// and num: `-5` is a number option (head, git log). A long option matches only by its full name:
// git and GNU tools accept abbreviations (`--ext-d`), and an abbreviation of an allowed option
// could be one of a blocked one. A short cluster (`-uu`, `-C3`) is read char by char.
const t = (spec, num = false) => {
  const short = {};
  const long = {};
  for (const [type, names] of Object.entries(spec)) {
    for (const n of names.split(/\s+/).filter(Boolean)) {
      if (n.startsWith('--')) long[n.slice(2)] = type;
      else short[n.slice(1)] = type;
    }
  }
  return { short, long, num };
};
const merge = (...tables) => ({
  short: Object.assign({}, ...tables.map((x) => x.short)),
  long: Object.assign({}, ...tables.map((x) => x.long)),
  num: tables.some((x) => x.num),
});
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Reads words (from splitWords) against a table. { opts: [{ name, value }], operands: [word] }, or
// null when a word is not in the table. A word with a glob may only be an operand: as an option or
// a value, what the shell makes of it is not what was checked, and one glob can become several
// words and shift the rest.
function parseOpts(words, table) {
  const opts = [];
  const operands = [];
  const value = (i) => {
    const x = words[i];
    return x && !x.glob && !x.w.startsWith('-') ? x.w : null;
  };
  for (let i = 0; i < words.length; i++) {
    const x = words[i];
    const a = x.w;
    if (a === '--' && !x.glob) {
      operands.push(...words.slice(i + 1));
      break;
    }
    if (!a.startsWith('-') || a === '-') {
      operands.push(x);
      continue;
    }
    if (x.glob) return null;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const type = has(table.long, name) ? table.long[name] : null;
      if (!type) return null;
      if (eq > 0) {
        if (type === 'b') return null;
        opts.push({ name: `--${name}`, value: a.slice(eq + 1) });
      } else if (type === 'v') {
        const v = value(++i);
        if (v === null) return null;
        opts.push({ name: `--${name}`, value: v });
      } else opts.push({ name: `--${name}`, value: null });
      continue;
    }
    if (table.num && /^-\d+$/.test(a)) {
      opts.push({ name: '-NUM', value: a.slice(1) });
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      const c = a[j];
      const type = has(table.short, c) ? table.short[c] : null;
      if (!type) return null;
      if (type === 'b') {
        opts.push({ name: `-${c}`, value: null });
        continue;
      }
      const rest = a.slice(j + 1);
      if (rest || type === 'o') opts.push({ name: `-${c}`, value: rest || null });
      else {
        const v = value(++i);
        if (v === null) return null;
        opts.push({ name: `-${c}`, value: v });
      }
      break;
    }
  }
  return { opts, operands };
}

// --- the readers
//
// None of their options runs a program or writes, so an operand glob may expand to any of them
// (`cat *` in a directory with a file named `-n`). A literal option still has to be in the table.
const READERS = {
  cat: t({ b: '-b -e -n -s -t -u -v -A -E -T --number --number-nonblank --squeeze-blank --show-all --show-ends --show-tabs --show-nonprinting' }),
  head: t({ b: '-q -v --quiet --silent --verbose', v: '-n -c --lines --bytes' }, true),
  // No -f or -F: following a file never ends, and the advisor would hang.
  tail: t({ b: '-q -v -r --quiet --silent --verbose', v: '-n -c --lines --bytes' }, true),
  wc: t({ b: '-l -w -c -m -L --lines --words --bytes --chars --max-line-length' }),
  ls: t({
    b: '-a -A -b -B -c -C -d -f -F -g -G -h -H -i -k -l -L -m -n -o -p -q -r -R -s -S -t -T -u -U -v -x -1 -@ -e -O '
      + '--all --almost-all --human-readable --si --recursive --reverse --directory --classify --inode --size --numeric-uid-gid '
      + '--dereference --group-directories-first --full-time --no-group --literal --escape',
    o: '--color --sort --time --format --time-style --indicator-style --quoting-style',
  }),
  // No -z/-Z: BSD grep's -Z decompresses; -z is not needed.
  grep: t({
    b: '-r -R -n -i -y -l -L -c -w -x -F -E -G -P -v -o -h -H -s -q -I -a -U -b '
      + '--recursive --dereference-recursive --line-number --ignore-case --no-ignore-case --files-with-matches '
      + '--files-without-match --count --word-regexp --line-regexp --fixed-strings --extended-regexp --basic-regexp '
      + '--perl-regexp --invert-match --only-matching --no-filename --with-filename --no-messages --quiet --silent --text '
      + '--byte-offset --null --line-buffered',
    v: '-A -B -C -e -f -m --after-context --before-context --context --regexp --file --max-count --include --exclude '
      + '--exclude-dir --binary-files',
    o: '--color --colour',
  }, true),
  pwd: t({ b: '-L -P' }),
  which: t({ b: '-a -s' }),
};

function readerAllowed(name, words) {
  const r = parseOpts(words, READERS[name]);
  if (!r) return false;
  if (name === 'pwd') return r.operands.length === 0;
  return true;
}

// --- rg
const RG = t({
  b: '-i -S -s -w -x -F -n -N -l -c -o -u -v -L -H -I -0 -P -U --ignore-case --smart-case --case-sensitive --word-regexp '
    + '--line-regexp --fixed-strings --line-number --no-line-number --files-with-matches --files-without-match --count '
    + '--count-matches --only-matching --unrestricted --invert-match --follow --with-filename --no-filename --null '
    + '--pcre2 --multiline --hidden --no-hidden --no-ignore --no-ignore-vcs --no-ignore-parent --no-ignore-dot '
    + '--no-ignore-global --ignore --files --json --no-json --column --no-column --heading --no-heading --trim '
    + '--no-config --stats --type-list --glob-case-insensitive --vimgrep --byte-offset --no-messages --quiet -q '
    + '--line-buffered --block-buffered --no-unicode --crlf --text -a --one-file-system --passthru',
  v: '-e -g -t -T -m -A -B -C -d -M -j -E --regexp --glob --iglob --type --type-not --max-count --after-context '
    + '--before-context --context --max-depth --max-columns --max-filesize --threads --sort --sortr --color --colors '
    + '--context-separator --field-match-separator --encoding --engine --replace -r',
});

// --- find: primaries, with the number of words each takes. `-depth` is left out: it takes an
// argument in BSD find and none in GNU find, so the word after it would be read two ways.
const FIND_LEAD = new Set(['-H', '-L', '-P', '-E', '-X', '-s', '-x']);
const FIND0 = new Set(['-print', '-print0', '-prune', '-empty', '-true', '-false', '-not', '-and', '-or', '-a', '-o', '!',
  '-xdev', '-mount', '-ls', '-quit', '-nouser', '-nogroup', '-readable', '-writable', '-executable', '-follow']);
const FIND1 = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-type',
  '-xtype', '-maxdepth', '-mindepth', '-size', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-newer', '-user',
  '-group', '-perm', '-links', '-inum', '-samefile', '-lname', '-ilname', '-uid', '-gid']);

function findAllowed(words) {
  let i = 0;
  while (i < words.length && FIND_LEAD.has(words[i].w) && !words[i].glob) i++;
  // Paths: up to the first word that starts the expression.
  for (; i < words.length && !words[i].w.startsWith('-') && words[i].w !== '!'; i++) {
    if (words[i].lead) return false;
  }
  for (; i < words.length; i++) {
    const x = words[i];
    if (x.glob) return false;
    if (FIND0.has(x.w)) continue;
    if (FIND1.has(x.w) || /^-newer[aBcmt][aBcmt]$/.test(x.w)) {
      const v = words[++i];
      if (!v || v.glob) return false;
      continue;
    }
    return false;
  }
  return true;
}

// --- git
//
// Global options: only where to run and no pager. Each subcommand has its table; --ext-diff and
// --textconv are in none (their --no- forms are), nor --output, --show-signature, -O, --exec or
// --upload-pack. What a repository's own config turns on by itself (core.fsmonitor, diff.external,
// a textconv driver, core.sshCommand) no option here can turn off: attached repositories are
// trusted, like any code the owner runs.
const DIFF = t({
  b: '-p -u -s -z -R -a -b -w -W -D --patch --no-patch --raw --patch-with-raw --patch-with-stat --numstat --shortstat '
    + '--summary --name-only --name-status --check --full-index --binary --find-copies-harder --irreversible-delete '
    + '--pickaxe-all --pickaxe-regex --no-relative --text --ignore-space-at-eol --ignore-space-change --ignore-all-space '
    + '--ignore-blank-lines --ignore-cr-at-eol --function-context --exit-code --quiet --no-ext-diff --no-textconv '
    + '--no-prefix --default-prefix --no-color --minimal --patience --histogram --compact-summary --no-renames '
    + '--indent-heuristic --no-indent-heuristic --no-color-moved --no-color-moved-ws --cached --staged --merge-base',
  v: '-S -G -I -l --unified --diff-filter --src-prefix --dst-prefix --line-prefix --word-diff-regex --diff-algorithm '
    + '--anchored --output-indicator-new --output-indicator-old --output-indicator-context --inter-hunk-context '
    + '--ws-error-highlight --ignore-matching-lines --rotate-to --skip-to',
  o: '-U -M -C -B --stat --dirstat --abbrev --break-rewrites --find-renames --find-copies --relative --color --color-moved '
    + '--color-moved-ws --color-words --word-diff --ignore-submodules --submodule',
});
const LOG = merge(DIFF, t({
  b: '-i -E -F -P -g -m -c -t --oneline --abbrev-commit --no-abbrev-commit --graph --no-decorate --all --first-parent '
    + '--no-merges --merges --all-match --invert-grep --regexp-ignore-case --extended-regexp --fixed-strings --perl-regexp '
    + '--basic-regexp --follow --reverse --topo-order --date-order --author-date-order --full-history --simplify-merges '
    + '--simplify-by-decoration --dense --sparse --left-right --left-only --right-only --cherry-pick --cherry-mark --cherry '
    + '--boundary --source --parents --children --no-notes --cc --combined-all-paths --mailmap --use-mailmap '
    + '--no-mailmap --no-use-mailmap --log-size --relative-date --walk-reflogs --reflog --no-expand-tabs --no-walk '
    + '--do-walk --show-linear-break --bisect --full-diff --clear-decorations --show-pulls --no-diff-merges',
  v: '-n -L --max-count --skip --since --after --until --before --author --committer --grep --grep-reflog --date '
    + '--min-parents --max-parents --encoding --glob --exclude --diff-merges --since-as-filter',
  o: '--format --pretty --decorate --decorate-refs --decorate-refs-exclude --branches --tags --remotes --ancestry-path '
    + '--notes --show-notes --expand-tabs',
}, true));
const GIT = {
  log: LOG,
  show: LOG,
  diff: DIFF,
  status: t({
    b: '-s -b -v -z --short --branch --long --verbose --no-column --ahead-behind --no-ahead-behind --renames --no-renames '
      + '--show-stash --null',
    o: '-u --porcelain --untracked-files --ignored --ignore-submodules --column --find-renames',
  }),
  'for-each-ref': t({
    b: '--shell --perl --python --tcl --ignore-case --omit-empty',
    v: '--format --sort --count --points-at --exclude',
    o: '--merged --no-merged --contains --no-contains',
  }),
  'symbolic-ref': t({ b: '-q --quiet --short' }),
  'ls-remote': t({ b: '-h -t -q --heads --tags --branches --refs --quiet --exit-code --get-url --symref', v: '--sort' }),
  blame: t({
    b: '-b -c -e -f -l -n -p -s -t -w --root --show-stats --porcelain --line-porcelain --incremental --show-name '
      + '--show-number --show-email --no-textconv --first-parent --color-lines --color-by-age --progress --no-progress --minimal',
    v: '-L -S --date --ignore-rev --ignore-revs-file --contents --encoding',
    o: '-M -C --abbrev',
  }),
  'rev-parse': t({
    b: '-q --quiet --verify --symbolic --symbolic-full-name --show-toplevel --show-prefix --show-cdup --git-dir '
      + '--git-common-dir --absolute-git-dir --is-inside-work-tree --is-inside-git-dir --is-bare-repository '
      + '--is-shallow-repository --show-superproject-working-tree --all --local-env-vars --revs-only --no-revs --flags '
      + '--no-flags --not --sq',
    v: '--git-path --since --until --after --before',
    o: '--abbrev-ref --short --branches --tags --remotes --glob --exclude --show-object-format --path-format --disambiguate',
  }),
  'merge-base': t({ b: '-a --all --octopus --independent --is-ancestor --fork-point' }),
  'ls-files': t({
    b: '-c -d -m -o -i -s -u -k -z -t -v -f --cached --deleted --modified --others --ignored --stage --unmerged --killed '
      + '--directory --no-empty-directory --eol --exclude-standard --error-unmatch --full-name --recurse-submodules '
      + '--deduplicate --sparse --resolve-undo --debug',
    v: '-x -X --exclude --exclude-from --exclude-per-directory --with-tree --format',
    o: '--abbrev',
  }),
  // No -O/--open-files-in-pager: it runs a pager of its choice.
  grep: t({
    b: '-n -i -I -w -v -l -L -c -h -H -E -G -F -P -p -W -r -o -q -z -a --line-number --ignore-case --word-regexp '
      + '--invert-match --files-with-matches --name-only --files-without-match --count --full-name --extended-regexp '
      + '--basic-regexp --fixed-strings --perl-regexp --show-function --function-context --recursive --no-recursive --cached '
      + '--untracked --no-index --exclude-standard --no-exclude-standard --recurse-submodules --column --only-matching '
      + '--quiet --null --break --heading --all-match --no-color --text --no-textconv --and --or --not',
    v: '-e -f -A -B -C -m --after-context --before-context --context --max-depth --threads --max-count',
    o: '--color',
  }, true),
  // The listing forms only; -l is not there: in an older git it was --create-reflog.
  branch: t({
    b: '-v -a -r -i --list --all --remotes --show-current --no-color --no-column --ignore-case --no-abbrev --omit-empty --verbose',
    v: '--format --sort --points-at',
    o: '--contains --no-contains --merged --no-merged --color --column --abbrev',
  }),
};
// A format that verifies signatures runs gpg: %G… in a pretty format, %(signature…) in a ref one.
const SIGNS = /%G|%\(signature/;

function gitAllowed(words) {
  // Global options, up to the subcommand.
  let i = 0;
  while (i < words.length && words[i].w.startsWith('-')) {
    const x = words[i];
    if (x.glob) return false;
    if (x.w === '-C') {
      const v = words[i + 1];
      if (!v || v.glob) return false;
      i += 2;
    } else if (x.w === '-P' || x.w === '--no-pager') i += 1;
    else return false;
  }
  const subWord = words[i];
  if (!subWord || subWord.glob || !has(GIT, subWord.w)) return false;
  const sub = subWord.w;
  const r = parseOpts(words.slice(i + 1), GIT[sub]);
  if (!r) return false;
  if (r.opts.some((o) => o.value !== null && SIGNS.test(o.value))) return false;
  // An operand glob may not start the word: it could expand to an option.
  if (r.operands.some((x) => x.lead)) return false;
  const names = new Set(r.opts.map((o) => o.name));
  // `git branch x` creates: a word that is not an option only as a pattern of --list.
  if (sub === 'branch') return r.operands.length === 0 || names.has('--list');
  // Reading a symref takes one name; two would write it.
  if (sub === 'symbolic-ref') return r.operands.length === 1;
  // The repository, if named, is a remote name or `.`: a URL, a path or `<transport>::` would let
  // git run a transport of the caller's choice.
  if (sub === 'ls-remote') {
    const repo = r.operands[0];
    return !repo || repo.w === '.' || /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo.w);
  }
  return true;
}

// --- wsg: only this package's CLI, by its absolute path, with node and no node option. `wsg` on
// PATH or `npx` could be any wsg; another script is not wsg at all.
const WSG_CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');

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

function nodeAllowed(words) {
  const [cli, ...rest] = words;
  if (!cli || cli.glob || cli.w !== WSG_CLI) return false;
  // A glob in an argument could be a flag or a second path once expanded.
  if (rest.some((x) => x.glob)) return false;
  return wsgAllowed(rest.map((x) => x.w));
}

function commandAllowed(words) {
  const [v, ...names] = words;
  return !!v && v.w === '-v' && !v.glob && names.length > 0 && names.every((x) => !x.glob && !x.w.startsWith('-'));
}

function bashAllowed(cmd) {
  if (typeof cmd !== 'string' || SHELL_CHARS.test(cmd) || hasBadChars(cmd)) return false;
  const words = splitWords(cmd.replace(/^[ \t]+|[ \t]+$/g, ''));
  if (!words || !words.length || words[0].glob) return false;
  const [first, ...args] = words;
  const name = first.w;
  if (has(READERS, name)) return readerAllowed(name, args);
  // Not a reader: no glob at the start of any word, where it could expand to an option.
  if (args.some((x) => x.lead)) return false;
  if (name === 'rg') {
    const r = parseOpts(args, RG);
    return !!r;
  }
  if (name === 'find') return findAllowed(args);
  if (name === 'command') return commandAllowed(args);
  if (name === 'git') return gitAllowed(args);
  if (name === 'node') return nodeAllowed(args);
  return false;
}

// --- MCP
//
// The name after mcp__<server>__ in words: get_issue, listMergeRequests, search-pages are split on
// _, -, __ and camelCase (`getHTTPStatus`: get, http, status), lower case. Then:
// - no word anywhere a write verb or a conjunction (and, or, then): find_replace_text,
//   get_and_archive and mark_as_read write;
// - no query language (sql, graphql, cypher, gql) and no bare `query`: it runs what it is given;
// - the first word is a read verb, or the second after a prefix — a first word that is not a
//   verb, in a name of three words or more, and either a word of the server's name or at most five
//   letters (`wiki_get_page`, `sh_list_x`);
// - or, with no verb at all, two words at most ending in a READ_NOUNS one, the first a prefix
//   (user_info, sh_metric).
// A verb the lists miss is not a prefix only when it is long and not in the server's name; a short
// one (`nuke_search_x`) would pass. False blocks are fine, false allows not.
const words = (name) => name
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  .split(/[_-]+/)
  .filter(Boolean)
  .map((w) => w.toLowerCase());
const READ_VERBS = new Set(['get', 'list', 'search', 'fetch', 'find', 'read', 'query', 'view', 'describe', 'show', 'lookup',
  'count', 'filter']);
const WRITE_VERBS = new Set([
  'create', 'update', 'delete', 'remove', 'add', 'set', 'send', 'post', 'put', 'patch', 'generate', 'export', 'login', 'auth',
  'transition', 'assign', 'upload', 'move', 'copy', 'write', 'edit', 'comment', 'reply', 'publish', 'run', 'execute', 'trigger',
  'approve', 'reject', 'merge', 'replace', 'mark', 'toggle', 'archive', 'insert', 'upsert', 'purge', 'import', 'save', 'download',
  'install', 'apply', 'complete', 'rename', 'clear', 'submit', 'cancel', 'schedule', 'invalidate', 'reload', 'enable', 'disable',
  'lock', 'unlock', 'link', 'unlink', 'inject', 'open', 'close', 'resolve', 'reopen', 'start', 'stop', 'restart', 'kill', 'sync',
  'refresh', 'reset', 'revert', 'commit', 'push',
  'trash', 'untrash', 'label', 'unlabel', 'spam', 'respond', 'join', 'leave', 'flush', 'unsubscribe', 'subscribe', 'invite',
  'share', 'grant', 'revoke', 'deploy', 'restore', 'register', 'bind', 'attach', 'detach', 'clone', 'group', 'ungroup', 'swap',
  'resize', 'rotate', 'reorder', 'reparent', 'reschedule', 'uncomplete', 'draft', 'modify', 'change', 'quit', 'uninstall',
  'navigate', 'switch', 'drop', 'truncate', 'destroy', 'terminate', 'prune', 'compose', 'forward', 'mutation', 'mutate', 'pin',
  'unpin', 'star', 'react', 'mute', 'book', 'answer', 'and', 'or', 'then',
  'rebuild', 'reindex', 'unfollow', 'unblock', 'increment', 'decrement', 'wipe', 'initialize', 'ingest', 'retry', 'rerun', 'rollback', 'release', 'promote', 'demote', 'ban', 'kick', 'accept',
  'decline', 'confirm', 'dismiss', 'snooze', 'acknowledge', 'escalate', 'invoke', 'exec', 'eval', 'spawn', 'provision',
  'rebase', 'squash', 'unlike', 'bookmark', 'unwatch', 'erase', 'reassign', 'untag', 'migrate', 'unmount',
]);
// Verbs that are also nouns: harmless after a read verb (list_tag_values, get_build_log), but never
// a prefix, so that tag_search_results or report_status is not read as one.
const NOT_PREFIX = new Set(['tag', 'report', 'build', 'block', 'follow', 'notify', 'fork', 'make', 'init', 'process', 'handle',
  'convert', 'transform', 'seed', 'fill', 'mount', 'watch', 'like', 'vote', 'release', 'scale', 'launch', 'mention', 'index']);
const READ_NOUNS = new Set(['info', 'stat', 'stats', 'metric', 'metrics', 'status', 'overview', 'history', 'details']);
// resolve_library_id and resolve-message-url look a name up; resolve_discussion closes a thread.
// Only the word right after `resolve` decides.
const LOOKUP = new Set(['id', 'ids', 'url', 'urls', 'uri', 'link', 'links', 'library', 'name', 'names']);
const QUERY_LANG = /sql|graphql|cypher|gql/;

function mcpAllowed(tool) {
  if (typeof tool !== 'string' || !/^mcp__[A-Za-z0-9_-]+$/.test(tool)) return false;
  const parts = tool.split('__');
  if (parts.length < 3 || parts[0] !== 'mcp' || !parts[1] || parts.slice(2).some((p) => !p)) return false;
  const server = new Set(words(parts[1]));
  const rest = parts.slice(2).join('_');
  if (QUERY_LANG.test(rest.toLowerCase())) return false;
  const ws = words(rest)
    // "merge request" is a thing, not the act of merging: list_merge_requests only reads.
    .filter((w, i, all) => !(w === 'merge' && /^requests?$/.test(all[i + 1] || '')))
    .map((w, i, all) => (w === 'resolve' && LOOKUP.has(all[i + 1]) ? 'lookup' : w));
  if (!ws.length || ws.some((w) => WRITE_VERBS.has(w))) return false;
  const prefix = (w) => !READ_VERBS.has(w) && !READ_NOUNS.has(w) && !NOT_PREFIX.has(w) && (server.has(w) || w.length <= 5);
  let verb = -1;
  if (READ_VERBS.has(ws[0])) verb = 0;
  else if (ws.length >= 3 && prefix(ws[0]) && READ_VERBS.has(ws[1])) verb = 1;
  if (verb >= 0) {
    // `query` with nothing after it is a query language of its own: mcp__db__query.
    return !(ws[verb] === 'query' && verb === ws.length - 1);
  }
  const last = ws[ws.length - 1];
  if (!READ_NOUNS.has(last)) return false;
  return ws.length === 1 || (ws.length === 2 && prefix(ws[0]));
}

// The hook matches every tool ("*"): what is not Bash, MCP or one of these blocks — Agent (a
// subagent with write tools), Monitor (a shell), EnterWorktree, a cron, a workflow, and any tool
// Claude Code adds later.
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool']);

// { allow: true } or { allow: false, reason }.
function decide(input) {
  if (!input || typeof input !== 'object') return { allow: false, reason: 'wsg-advisor guard: no tool call in the hook input' };
  const tool = input.tool_name;
  if (READ_TOOLS.has(tool)) return { allow: true };
  if (tool === 'Bash') {
    const cmd = input.tool_input && input.tool_input.command;
    if (bashAllowed(cmd)) return { allow: true };
    const shown = typeof cmd === 'string' ? JSON.stringify(cmd.replace(/^[ \t]+/, '').split('\n')[0].slice(0, 120)).slice(1, -1) : String(cmd);
    return {
      allow: false,
      reason: `wsg-advisor is read-only: ${shown} is not on its list. One plain read command at a time, with options from `
        + 'its list: no pipes, redirection, ;, && or $; git -C <path> instead of cd; wsg only as node "<path>" from the agent file.',
    };
  }
  if (typeof tool === 'string' && tool.startsWith('mcp__')) {
    if (mcpAllowed(tool)) return { allow: true };
    return { allow: false, reason: `wsg-advisor is read-only: ${tool} is not a tool that only reads (get, list, search, fetch, find…).` };
  }
  return { allow: false, reason: `wsg-advisor is read-only: ${tool} is not one of its tools (Read, Grep, Glob, WebFetch, WebSearch, read-only Bash and MCP).` };
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

module.exports = { decide, split, splitWords, bashAllowed, mcpAllowed, WSG_CLI };
