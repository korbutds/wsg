'use strict';

// The flags each command takes: 'bool' or 'value'. bin/cli.js parses with these, and the tests
// check docs/setup-guide.md against them, so the guide can't name a flag that doesn't exist.

const FLAGS = {
  new: { '--title': 'value', '--kind': 'value', '--skill': 'value', '--ticket': 'value', '--epic': 'value', '--sources': 'value',
    '--no-code': 'bool', '--dry-run': 'bool', '--json': 'bool', '--no-launch': 'bool' },
  add: {
    '--worktree': 'bool', '--link': 'bool', '--reference': 'bool',
    '--branch': 'value', '--base': 'value', '--reset-to-base': 'bool', '--target': 'value',
    '--verify': 'value', '--carry': 'value', '--clone-node-modules': 'bool', '--no-clone-node-modules': 'bool',
    '--note': 'value', '--branch-template': 'value', '--dry-run': 'bool', '--json': 'bool', '--ws': 'value',
  },
  remove: { '--delete-ignored': 'bool', '--dry-run': 'bool', '--json': 'bool', '--ws': 'value' },
  refresh: { '--tasks': 'bool', '--dry-run': 'bool', '--json': 'bool', '--ws': 'value' },
  team: { '--without': 'value', '--dry-run': 'bool', '--ws': 'value' },
  check: { '--json': 'bool' },
  list: { '--json': 'bool' },
  status: { '--dry-run': 'bool', '--json': 'bool' },
  close: { '--dry-run': 'bool', '--json': 'bool' },
  archive: { '--delete-ignored': 'bool', '--dry-run': 'bool', '--json': 'bool', '--ws': 'value' },
  unarchive: { '--dry-run': 'bool', '--json': 'bool', '--ws': 'value' },
  // Two-word commands are keyed by both words: `wsg context add` reads FLAGS['context add'].
  'context add': { '--id': 'value', '--title': 'value', '--desc': 'value', '--dry-run': 'bool', '--json': 'bool', '--ws': 'value' },
  'context note': {
    '--text': 'value', '--from': 'value', '--title': 'value', '--desc': 'value', '--replace': 'bool', '--discard-edits': 'bool',
    '--dry-run': 'bool', '--json': 'bool', '--ws': 'value',
  },
  'context remove': { '--discard-edits': 'bool', '--dry-run': 'bool', '--json': 'bool', '--ws': 'value' },
  'context list': { '--json': 'bool', '--ws': 'value' },
  'mcp add': { '--env': 'value', '--url': 'value', '--bearer-env': 'value', '--agent': 'value', '--dry-run': 'bool', '--json': 'bool', '--ws': 'value' },
  'mcp remove': { '--dry-run': 'bool', '--json': 'bool', '--ws': 'value' },
  'mcp disable': { '--agent': 'value', '--dry-run': 'bool', '--json': 'bool', '--ws': 'value' },
  'mcp enable': { '--agent': 'value', '--dry-run': 'bool', '--json': 'bool', '--ws': 'value' },
  'mcp list': { '--json': 'bool', '--ws': 'value' },
  promote: { '--skill': 'value' },
  guide: {},
  'install-skills': { '--uninstall': 'bool' },
  'shell-init': {},
};

// The first words of the two-word commands: `wsg context` or `wsg mcp` alone is no command.
const GROUPS = ['context', 'mcp'];

// The command argv names, as FLAGS keys it — `context add` for `wsg context add …` — or null for one
// it does not know (a group without a word it has included); words: how many arguments it took.
function commandOf(argv, aliases = {}) {
  const [a, b] = argv;
  if (GROUPS.includes(a)) return Object.prototype.hasOwnProperty.call(FLAGS, `${a} ${b}`) ? { name: `${a} ${b}`, words: 2 } : { name: null, words: 1 };
  const name = aliases[a] || a;
  return typeof a === 'string' && Object.prototype.hasOwnProperty.call(FLAGS, name) ? { name, words: 1 } : { name: null, words: 1 };
}

// Taken on their own, as the only argument.
const GLOBAL = ['--help', '-h', '--version', '-v', '--where'];

// Hand-written on purpose: a few flags per command don't justify a dependency. spec maps a flag
// to 'bool' or 'value'; --flag=value works too. Anything unknown is invalid input, never ignored:
// an agent that typoed a flag must not believe it took effect. { flags, pos }, or { error, arg }
// with error the i18n key of the message (cli.unknownArg, cli.noValue, cli.needsValue,
// cli.extraArg). bin/cli.js and the advisor guard parse with it, so they read a command alike.
function parse(args, spec, maxPositional) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      pos.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith('-') || a === '-') {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    const type = Object.prototype.hasOwnProperty.call(spec, name) ? spec[name] : undefined;
    if (!type) return { error: 'cli.unknownArg', arg: name };
    if (type === 'bool') {
      if (eq > 0) return { error: 'cli.noValue', arg: name };
      flags[name] = true;
    } else {
      const v = eq > 0 ? a.slice(eq + 1) : args[++i];
      if (v === undefined) return { error: 'cli.needsValue', arg: name };
      flags[name] = v;
    }
  }
  if (pos.length > maxPositional) return { error: 'cli.extraArg', arg: pos[maxPositional] };
  return { flags, pos };
}

module.exports = { FLAGS, GLOBAL, GROUPS, commandOf, parse };
