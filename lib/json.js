'use strict';

// --json: stdout is exactly one JSON document, the envelope; stderr keeps only diagnostics.
// { schemaVersion, wsgVersion, ok, command, dryRun, result, error, warnings } — every key always
// there. error is null on success. result is the command's outcome, or null when there is none to
// give: a refused --dry-run still carries its plan. error: { code, exitCode, message, details,
// rollback, kept }; rollback: "none" (shown that nothing was changed: refused before the first
// step), "done" (put back as it was, but for kept — files copied in when a worktree was made, such as
// .env and node_modules, and ignored files deleted with --delete-ignored do not come back),
// "incomplete" (a rollback step failed: the workspace may be broken) or "unknown" (no rollback ran
// and nothing says whether anything changed: a crash, an error from outside a step); kept: absolute
// paths the rollback left as they were edited during the run. code and the enums are stable; message,
// details and warnings are text for people, in the UI language, never for parsing. Exit codes are
// those of the plain commands. Paths are absolute. check's result is its report by section, each
// line an item with level "ok", "warn", "fail" or "info" (a note); check's warnings are those
// items, not the envelope's warnings, and a check_failed error's details are its fail lines. A
// section's title is the heading check printed; an empty title only for lines that came before the
// first heading, which check does not print today.

const fs = require('node:fs');
const path = require('node:path');
const ui = require('./ui');

const SCHEMA_VERSION = 1;
const WSG_VERSION = require(path.join(__dirname, '..', 'package.json')).version;
// code → exit code. busy: another wsg command holds the workspace's lock (lib/lock.js).
// check_failed: wsg check found errors.
const CODES = { invalid_input: 2, busy: 2, step_failed: 1, check_failed: 1, interrupted: 130, internal: 1 };
const ROLLBACK = ['none', 'done', 'incomplete', 'unknown'];
const STOP_SIGNALS = ['SIGINT', 'SIGHUP', 'SIGTERM'];

const mode = { on: false, command: null, dryRun: false, warnings: [], emitted: false, exitCode: null };

// Written synchronously, all of it: process.exit right after an asynchronous write to a pipe cuts
// the document at the pipe's buffer (64 KiB on macOS). A full non-blocking pipe says EAGAIN: wait a
// little and go on. A reader gone (EPIPE): there is no one to give the rest to.
const pause = new Int32Array(new SharedArrayBuffer(4));
function writeAll(fd, text) {
  const buf = Buffer.from(text);
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off, buf.length - off);
    } catch (e) {
      if (e.code === 'EAGAIN') { Atomics.wait(pause, 0, 0, 5); continue; }
      if (e.code === 'EPIPE') return;
      throw e;
    }
  }
}

// Called by bin/cli.js before anything can refuse, so a flag error or a broken config is an
// envelope too. From here on ui prints nothing to stdout; its warnings go into the envelope. A crash
// is an internal error in the envelope too, so stdout is never left empty.
function start({ command = null, dryRun = false } = {}) {
  Object.assign(mode, { on: true, command, dryRun, warnings: [], emitted: false, exitCode: null });
  ui.sink((level, text) => { if (level === 'warn') mode.warnings.push(text); });
  const crash = (e) => {
    process.stderr.write(`${(e && e.stack) || e}\n`);
    process.exit(fail('internal', String((e && e.message) || e), { rollback: 'unknown' }));
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  // A stop signal where neither the lock (lib/lock.js) nor a rollback (guarded() in lib/generate.js)
  // listens — a dry run, before the lock: nothing was changed. Where they listen, they answer it.
  const onSignal = (sig) => {
    if (process.listenerCount(sig) > 1) return;
    process.exit(fail('interrupted', require('./i18n').t('cli.cancelled'), { rollback: 'none' }));
  };
  for (const sig of STOP_SIGNALS) process.on(sig, onSignal);
}

const active = () => mode.on;
// The command's own reading of --dry-run, once its flags are parsed.
const setDryRun = (v) => { mode.dryRun = !!v; };

function envelope(ok, result, error, warnings = []) {
  return {
    schemaVersion: SCHEMA_VERSION,
    wsgVersion: WSG_VERSION,
    ok,
    command: mode.command,
    dryRun: mode.dryRun,
    result: result === undefined ? null : result,
    error: error || null,
    warnings: [...warnings, ...mode.warnings],
  };
}

// Once per run: a second document would make stdout unparseable. Returns the exit code of the
// document on stdout — the first one, whatever is asked after it.
function emit(env, exitCode) {
  if (mode.emitted) return mode.exitCode;
  mode.emitted = true;
  mode.exitCode = exitCode;
  writeAll(1, `${JSON.stringify(env, null, 2)}\n`);
  return exitCode;
}

// o.warnings: the command's own, ahead of the ones ui collected. Returns the exit code.
function succeed(result, o = {}) {
  return emit(envelope(true, result, null, o.warnings), 0);
}

// o: { details, rollback, kept, result, warnings }; rollback by default: "unknown" for an internal
// error, "none" for the rest — refusals made before anything is touched. Returns the exit code.
function fail(code, message, o = {}) {
  if (!Object.prototype.hasOwnProperty.call(CODES, code)) throw new Error(`unknown error code ${code}`);
  const rollback = o.rollback || (code === 'internal' ? 'unknown' : 'none');
  if (!ROLLBACK.includes(rollback)) throw new Error(`unknown rollback ${rollback}`);
  return emit(envelope(false, o.result, {
    code,
    exitCode: CODES[code],
    message: String(message),
    details: o.details || [],
    rollback,
    kept: o.kept || [],
  }, o.warnings), CODES[code]);
}

// What an error from guarded() (lib/generate.js) says about the rollback, for fail(): each kept
// path absolute as guarded() gives it (keptAbs), else relative to the workspace ws, or as it is
// without one. An error that says nothing (not from guarded(), not marked by the command) is
// "unknown".
const rollbackOf = (e, ws) => ({
  rollback: (e && ROLLBACK.includes(e.rollback) && e.rollback) || 'unknown',
  kept: ((e && e.kept) || []).map((k, i) => (e.keptAbs && e.keptAbs[i]) || (ws ? path.resolve(ws, k) : k)),
});

// A source as --json gives it (add, new, list): a spec, a plan, or a state entry — whatever is known.
// Every key always there; null for what is not; paths absolute. ws: the workspace it is in; plan:
// the source's plan, for the clone flag of one refused before its spec was made.
function sourceResult(ws, x, plan = x) {
  const name = typeof x.name === 'string' && x.name ? x.name : null;
  const nmClone = plan && plan.nodeModules && typeof plan.nodeModules.clone === 'boolean' ? plan.nodeModules.clone : null;
  const task = x.task && typeof x.task === 'object' && !Array.isArray(x.task) ? x.task : null;
  return {
    name,
    mode: x.reference || x.mode === 'reference' ? 'reference' : x.mode || null,
    path: typeof x.path === 'string' && x.path ? x.path : null,
    workspacePath: name && ws ? path.join(ws, name) : null,
    branch: x.branch || null,
    base: x.base || null,
    target: x.target && x.target !== '—' ? x.target : null,
    verify: x.verify || null,
    note: x.note || null,
    carry: Array.isArray(x.carry) ? x.carry : [],
    cloneNm: typeof x.cloneNm === 'boolean' ? x.cloneNm : nmClone,
    from: x.from || null,
    // An epic's defaults for its tasks, always these four keys; base null: the default.
    task: task && {
      branch: typeof task.branch === 'string' ? task.branch : null,
      base: typeof task.base === 'string' && task.base ? task.base : null,
      carry: Array.isArray(task.carry) ? task.carry : [],
      cloneNm: typeof task.cloneNm === 'boolean' ? task.cloneNm : nmClone,
    },
  };
}

module.exports = { SCHEMA_VERSION, WSG_VERSION, CODES, ROLLBACK, start, active, setDryRun, succeed, fail, rollbackOf, writeAll, sourceResult };
