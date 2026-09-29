'use strict';

const tty = process.stdout.isTTY;
const c = (code) => (tty ? `\u001b[${code}m` : '');
const B = c(1), R = c(31), Y = c(33), G = c(32), D = c(2), N = c(0);

module.exports = {
  B, R, Y, G, D, N,
  head: (s) => console.log(`\n${B}${s}${N}`),
  info: (s) => console.log(s),
  dim: (s) => console.log(`${D}${s}${N}`),
  ok: (s) => console.log(`  ${G}OK${N}   ${s}`),
  warn: (s) => console.log(`  ${Y}WARN${N} ${s}`),
  fail: (s) => console.log(`  ${R}FAIL${N} ${s}`),
  err: (s) => process.stderr.write(`${s}\n`),
};
