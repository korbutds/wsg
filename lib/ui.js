'use strict';

const tty = process.stdout.isTTY;
const c = (code) => (tty ? `\u001b[${code}m` : '');
const B = c(1), R = c(31), Y = c(33), G = c(32), D = c(2), N = c(0);

// With a sink set (--json, lib/json.js) nothing goes to stdout: each line is handed to it with its
// level instead. err stays on stderr: it is diagnostics, not output.
let sinkFn = null;
const line = (level, text, shown) => (sinkFn ? sinkFn(level, text) : console.log(shown));

module.exports = {
  B, R, Y, G, D, N,
  head: (s) => line('head', s, `\n${B}${s}${N}`),
  info: (s) => line('info', s, s),
  dim: (s) => line('dim', s, `${D}${s}${N}`),
  ok: (s) => line('ok', s, `  ${G}OK${N}   ${s}`),
  warn: (s) => line('warn', s, `  ${Y}WARN${N} ${s}`),
  fail: (s) => line('fail', s, `  ${R}FAIL${N} ${s}`),
  err: (s) => process.stderr.write(`${s}\n`),
  sink: (fn) => { sinkFn = fn; },
};
