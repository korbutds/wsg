'use strict';

// A path typed like in a shell: Tab completes, the matching directories are listed under the line
// as a hint, and Enter takes exactly what was typed. It replaced a search list that opened with
// the home directory: the first Enter picked whatever was on top (usually ~/Documents), and a
// directory that doesn't exist yet could not be given at all.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { styleText } = require('node:util');
const { createPrompt, useState, useRef, useKeypress, usePrefix, isEnterKey, isTabKey, makeTheme } = require('@inquirer/core');

const HINT_MAX = 8;

// A folder dragged into the terminal arrives shell-escaped — /Users/x/My\ Docs, or in quotes, with
// a trailing space. Taken literally, it names a folder that doesn't exist, and the interview would
// offer to create it. Backslash escapes are undone, a pair of surrounding quotes is dropped.
function unshell(p) {
  const s = p.trim();
  const q = s.match(/^(['"])(.*)\1$/);
  if (q) return q[2];
  return s.replace(/\\(.)/g, '$1');
}

// The one place ~ is expanded for paths typed in the interview: completion and the source path
// must read the same text the same way.
const expandPath = (p) => unshell(p).replace(/^~(?=\/|$)/, os.homedir());

// The reverse, for showing a path: only a leading home directory — /Users/dk-shared is not ~-shared.
function tildePath(p) {
  const home = os.homedir();
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

// Directories that can continue the typed text, and the text Tab turns it into.
// The typed form is kept — ~ stays ~ — only the last segment is completed.
function completePath(typed) {
  const slash = typed.lastIndexOf('/');
  // "~" alone is the home directory, like in a shell.
  if (typed === '~') return { matches: [], completed: '~/' };
  const head = slash < 0 ? '' : typed.slice(0, slash + 1);
  // Escapes are undone for reading the disk; the typed text keeps its form.
  const frag = (slash < 0 ? typed : typed.slice(slash + 1)).replace(/\\(.)/g, '$1');
  const dir = head ? expandPath(head) : process.cwd();
  let names = [];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => (e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(dir, e.name)))))
      .map((e) => e.name)
      // Hidden ones only when asked for, like shells do.
      .filter((n) => (frag.startsWith('.') || !n.startsWith('.')) && n.toLowerCase().startsWith(frag.toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    names = [];
  }
  let completed = typed;
  if (names.length === 1) completed = `${head}${names[0]}/`;
  else if (names.length > 1) {
    // Case-sensitive: with both Media and media (Linux) Tab must not pick one of them for the user.
    const common = names.reduce((acc, n) => {
      let i = 0;
      while (i < acc.length && i < n.length && acc[i] === n[i]) i++;
      return acc.slice(0, i);
    });
    if (common.length > frag.length) completed = `${head}${common}`;
  }
  return { matches: names.map((n) => path.join(dir, n)), completed };
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// config: { message, hint, doneLabel, gitLabel, isRepoRoot, keys } — keys is the rendered key-hint line.
const pathPrompt = createPrompt((config, done) => {
  const theme = makeTheme(config.theme);
  const [status, setStatus] = useState('idle');
  const [value, setValue] = useState('');
  // The state is only fresh after a re-render: a pasted path followed by Enter would be read
  // stale. The ref is updated on every key, so Enter and Tab see exactly what is in the line.
  const typed = useRef('');
  // Same for "answered": pasted text with a newline keeps sending keys after Enter.
  const answered = useRef(false);
  const prefix = usePrefix({ status, theme });

  useKeypress((key, rl) => {
    if (answered.current) return;
    if (isEnterKey(key)) {
      answered.current = true;
      setStatus('done');
      done(typed.current.trim());
    } else if (isTabKey(key)) {
      rl.clearLine(0); // drop the tab character
      const { completed } = completePath(typed.current);
      rl.write(completed);
      typed.current = completed;
      setValue(completed);
    } else {
      typed.current = rl.line;
      setValue(rl.line);
    }
  });

  const message = theme.style.message(config.message, status);
  if (status === 'done') return `${prefix} ${message} ${theme.style.answer(typed.current.trim() || config.doneLabel)}`;

  const lines = [];
  if (value) {
    const { matches } = completePath(value);
    for (const m of matches.slice(0, HINT_MAX)) {
      const git = config.isRepoRoot && config.isRepoRoot(m) ? `  · ${config.gitLabel}` : '';
      lines.push(styleText('dim', `  ${m}${git}`));
    }
    if (matches.length > HINT_MAX) lines.push(styleText('dim', `  … +${matches.length - HINT_MAX}`));
  } else if (config.hint) {
    lines.push(styleText('dim', `  ${config.hint}`));
  }
  if (config.keys) lines.push(config.keys);
  return [`${prefix} ${message} ${value}`, lines.join('\n')];
});

module.exports = { pathPrompt, completePath, expandPath, tildePath, unshell };
