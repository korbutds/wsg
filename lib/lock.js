'use strict';

// One command at a time per workspace. add, remove and promote each read wsg.json, change the
// workspace and write wsg.json back; two at once would each write a state without the other's
// source. The lock is a file created with O_EXCL that names its holder; one whose holder is gone
// (killed, a crashed machine) is taken over.

const fs = require('node:fs');
const path = require('node:path');
const ui = require('./ui');
const { t } = require('./i18n');

const LOCK = path.join('.claude', 'wsg.lock');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // someone else's process, alive
  }
}

// The stop signals generate.js rolls back on.
const STOP_SIGNALS = ['SIGINT', 'SIGHUP', 'SIGTERM'];

const readHolder = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const busy = (holder, file) => Object.assign(new Error(t('lock.busy', {
  pid: holder && holder.pid !== undefined ? holder.pid : '?', time: (holder && holder.time) || '?', file,
})), { invalid: true });

// A stale lock is moved aside before it is deleted: of two commands taking it over at once, only
// one rename finds it. The one that loses may move the lock the winner has just made — the
// contents tell, and that lock goes back where it was.
function takeOver(file, stale) {
  const aside = `${file}.${process.pid}.${Date.now()}`;
  try {
    fs.renameSync(file, aside);
  } catch (e) {
    if (e.code === 'ENOENT') return; // taken over by the other one
    throw e;
  }
  let moved = null;
  try { moved = fs.readFileSync(aside, 'utf8'); } catch { /* unreadable: stale */ }
  if (moved === null || moved === stale) {
    fs.rmSync(aside, { force: true });
    return;
  }
  // link, not rename: it fails instead of replacing a lock made in the meantime.
  try { fs.linkSync(aside, file); } catch { /* a third one has it now */ }
  fs.rmSync(aside, { force: true });
  let holder = null;
  try { holder = JSON.parse(moved); } catch { /* shown as ? */ }
  throw busy(holder, file);
}

// Returns release(). Throws an error with .invalid set when another command holds the lock.
// Released on exit too: a refusal ends the process from deep inside the command. And on a stop
// signal: until generate's guarded() takes over, nothing else would handle it, and Node would die
// with the lock in place.
function acquire(ws) {
  const dir = path.join(ws, '.claude');
  // Never through a link: the lock would be taken somewhere else, and the next write refused anyway.
  if (fs.lstatSync(dir).isSymbolicLink()) throw Object.assign(new Error(t('gen.symlinkOnPath', { path: '.claude', file: LOCK, ws })), { invalid: true });
  const file = path.join(ws, LOCK);
  const mine = JSON.stringify({ pid: process.pid, time: new Date().toISOString() });
  let released = false;
  const onSignal = (sig) => {
    // guarded() is listening too: it rolls back and ends the process, and the exit releases.
    if (process.listenerCount(sig) > 1) return;
    release();
    process.stderr.write(`\n${t('cli.addCancelled')}\n`);
    process.exit(130);
  };
  const release = () => {
    if (released) return;
    released = true;
    process.off('exit', release);
    for (const sig of STOP_SIGNALS) process.off(sig, onSignal);
    try {
      if (fs.readFileSync(file, 'utf8') === mine) fs.unlinkSync(file);
    } catch { /* gone already */ }
  };
  // Before the lock exists: a signal between the two would leave it behind.
  for (const sig of STOP_SIGNALS) process.on(sig, onSignal);
  process.on('exit', release);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.writeFileSync(file, mine, { flag: 'wx' });
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // Taken over once already, and someone made a lock again in between: they hold it.
        if (attempt > 0) throw busy(readHolder(file), file);
        let text = null;
        try { text = fs.readFileSync(file, 'utf8'); } catch (r) { text = r.code === 'ENOENT' ? null : ''; } // null: gone, try again
        let holder = null;
        try { holder = JSON.parse(text); } catch { /* unreadable: stale */ }
        if (holder && Number.isInteger(holder.pid) && alive(holder.pid)) throw busy(holder, file);
        if (text !== null) {
          ui.warn(t('lock.stale', { pid: holder ? holder.pid : '?', file }));
          takeOver(file, text);
        }
      }
    }
  } catch (e) {
    release(); // the handlers go; the file is someone else's and stays
    throw e;
  }
  return release;
}

module.exports = { LOCK, acquire };
