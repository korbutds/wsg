'use strict';

// The flags each command takes: 'bool' or 'value'. bin/cli.js parses with these, and the tests
// check docs/setup-guide.md against them, so the guide can't name a flag that doesn't exist.

const FLAGS = {
  new: { '--title': 'value', '--kind': 'value', '--skill': 'value', '--ticket': 'value', '--no-launch': 'bool' },
  add: {
    '--worktree': 'bool', '--link': 'bool', '--reference': 'bool',
    '--branch': 'value', '--base': 'value', '--reset-to-base': 'bool', '--target': 'value',
    '--verify': 'value', '--carry': 'value', '--clone-node-modules': 'bool', '--no-clone-node-modules': 'bool',
    '--note': 'value', '--dry-run': 'bool', '--ws': 'value',
  },
  remove: { '--delete-ignored': 'bool', '--dry-run': 'bool', '--ws': 'value' },
  refresh: { '--dry-run': 'bool', '--ws': 'value' },
  check: {},
  promote: { '--skill': 'value' },
  guide: {},
  'install-skills': { '--uninstall': 'bool' },
  'shell-init': {},
};

// Taken on their own, as the only argument.
const GLOBAL = ['--help', '-h', '--version', '-v', '--where'];

module.exports = { FLAGS, GLOBAL };
