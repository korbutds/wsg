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

// Returns release(). Throws an error with .invalid set when another command holds the lock.
// Released on exit too: a refusal ends the process from deep inside the command.
function acquire(ws) {
  const dir = path.join(ws, '.claude');
  // Never through a link: the lock would be taken somewhere else, and the next write refused anyway.
  if (fs.lstatSync(dir).isSymbolicLink()) throw Object.assign(new Error(t('gen.symlinkOnPath', { path: '.claude', file: LOCK, ws })), { invalid: true });
  const file = path.join(ws, LOCK);
  const mine = JSON.stringify({ pid: process.pid, time: new Date().toISOString() });
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(file, mine, { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' || attempt > 0) throw e;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* unreadable: stale */ }
      if (holder && Number.isInteger(holder.pid) && alive(holder.pid)) {
        throw Object.assign(new Error(t('lock.busy', { pid: holder.pid, time: holder.time, file })), { invalid: true });
      }
      ui.warn(t('lock.stale', { pid: holder ? holder.pid : '?', file }));
      fs.rmSync(file, { force: true });
    }
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off('exit', release);
    try {
      if (fs.readFileSync(file, 'utf8') === mine) fs.unlinkSync(file);
    } catch { /* gone already */ }
  };
  process.on('exit', release);
  return release;
}

module.exports = { LOCK, acquire };
