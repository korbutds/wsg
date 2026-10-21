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

// A lock file is written right after it is created: read in between, it is empty. One that is empty
// or unreadable is judged stale only when it is older than this.
const FRESH_MS = 5000;
const young = (file) => {
  try { return Date.now() - fs.statSync(file).mtimeMs < FRESH_MS; } catch { return false; }
};

// A stale file is moved aside before it is deleted: of two at once, only one rename finds it. One
// that turns out to be fresh — made after it was read — goes back, and its holder is busy.
function removeStale(file, stale) {
  const aside = `${file}.${process.pid}.${Date.now()}`;
  try {
    fs.renameSync(file, aside);
  } catch (e) {
    if (e.code === 'ENOENT') return; // removed by someone else
    throw e;
  }
  let moved = null;
  try { moved = fs.readFileSync(aside, 'utf8'); } catch { /* unreadable: stale */ }
  if (moved === null || moved === stale) {
    fs.rmSync(aside, { force: true });
    return;
  }
  // link, not rename: it fails instead of replacing a file made in the meantime.
  try { fs.linkSync(aside, file); } catch { /* a third one has it now */ }
  fs.rmSync(aside, { force: true });
  let holder = null;
  try { holder = JSON.parse(moved); } catch { /* shown as ? */ }
  throw busy(holder, file);
}

// Whether a lock file found in place is held: by a live process, or just made and not written yet.
function held(file, text) {
  let holder = null;
  try { holder = JSON.parse(text); } catch { /* unreadable */ }
  if (holder && Number.isInteger(holder.pid)) return alive(holder.pid) ? holder : null;
  return young(file) ? holder || {} : null;
}

// Takeovers go one at a time: a second lock, <lock>.takeover, is held from moving the stale lock
// aside to creating the new one. Without it, of three commands the third could move the second's
// fresh lock while the first put it back. One left by a killed command is stale like the lock.
// Nothing stands above it to re-check under: removeStale's compare after the move is the check.
// Returns its release().
function takeoverLock(file, mine) {
  const tf = `${file}.takeover`;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(tf, mine, { flag: 'wx' });
      return () => {
        try { if (fs.readFileSync(tf, 'utf8') === mine) fs.unlinkSync(tf); } catch { /* gone already */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let text = null;
      try { text = fs.readFileSync(tf, 'utf8'); } catch (r) { text = r.code === 'ENOENT' ? null : ''; }
      if (attempt > 0) throw busy(readHolder(tf), tf);
      if (text === null) continue; // released in between: try again
      const holder = held(tf, text);
      if (holder) throw busy(holder, tf);
      removeStale(tf, text);
    }
  }
}

// guarded() in generate.js rolls back and ends the process on a stop signal itself. While it runs,
// the lock's own handler stands aside; the exit releases the lock.
let handedOver = 0;
function handOver() {
  handedOver++;
  let back = false;
  return () => { if (!back) { back = true; handedOver--; } };
}

// Returns release(). Throws an error with .invalid set when another command holds the lock.
// Released on exit too: a refusal ends the process from deep inside the command.
// opts.signals (default true): release on a stop signal and exit 130. A JS handler runs only when
// the event loop gets a turn, so it is installed only for commands that give it one (add and
// remove, through guarded()). Installed for a command that is synchronous to the end (promote),
// it would only swallow Ctrl+C: the command would finish and exit 0. There Ctrl+C kills the
// process as usual, and the lock it leaves names a dead pid: the next command takes it over.
function acquire(ws, opts = {}) {
  const signals = opts.signals !== false;
  const dir = path.join(ws, '.claude');
  // Never through a link: the lock would be taken somewhere else, and the next write refused anyway.
  if (fs.lstatSync(dir).isSymbolicLink()) throw Object.assign(new Error(t('gen.symlinkOnPath', { path: '.claude', file: LOCK, ws })), { invalid: true });
  const file = path.join(ws, LOCK);
  const mine = JSON.stringify({ pid: process.pid, time: new Date().toISOString() });
  let released = false;
  const onSignal = () => {
    if (handedOver > 0) return;
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
  if (signals) for (const sig of STOP_SIGNALS) process.on(sig, onSignal);
  process.on('exit', release);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.writeFileSync(file, mine, { flag: 'wx' });
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (attempt > 1) throw busy(readHolder(file), file);
        let text = null;
        try { text = fs.readFileSync(file, 'utf8'); } catch (r) { text = r.code === 'ENOENT' ? null : ''; }
        if (text === null) continue; // released in between: try again
        const holder = held(file, text);
        if (holder) throw busy(holder, file);
        const done = takeoverLock(file, mine);
        try {
          // Judged stale before the takeover lock was ours: another takeover may have finished in
          // between. Only the very lock judged stale is taken over; anything else is someone's.
          let now = null;
          try { now = fs.readFileSync(file, 'utf8'); } catch (r) { now = r.code === 'ENOENT' ? null : ''; }
          if (now !== text) {
            let holderNow = null;
            try { holderNow = JSON.parse(now); } catch { /* gone or unreadable: shown as ? */ }
            throw busy(holderNow, file);
          }
          // The same text is not the same lock when it is empty: a lock made since, not written
          // yet, reads empty too. Judged again, it is young.
          const again = held(file, now);
          if (again) throw busy(again, file);
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* shown as ? */ }
          ui.warn(t('lock.stale', { pid: parsed && parsed.pid !== undefined ? parsed.pid : '?', file }));
          removeStale(file, text);
          // Still under the takeover lock: a lock made here in between is someone else's.
          fs.writeFileSync(file, mine, { flag: 'wx' });
        } catch (c) {
          if (c.code === 'EEXIST') throw busy(readHolder(file), file);
          throw c;
        } finally {
          done();
        }
        break;
      }
    }
  } catch (e) {
    release(); // the handlers go; the file is someone else's and stays
    throw e;
  }
  return release;
}

module.exports = { LOCK, acquire, handOver };
