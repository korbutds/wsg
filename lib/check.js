'use strict';

// Validator against the limits documented by vendors. Run it periodically, not only
// after creation: files grow, and the limit creeps up unnoticed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ui = require('./ui');
const g = require('./git');

const LIMITS = {
  claudeMdTarget: 100,
  claudeMdMax: 200,
  agentsMdTarget: 16384,
  agentsMdMax: 32768,
  ruleTarget: 80,
  memoryMaxLines: 200,
  memoryMaxBytes: 25600,
  alwaysOnTarget: 20480,
  importHops: 4,
};

// @-imports of one file, resolved against that file's directory, as Claude Code does.
function importsOf(file) {
  const dir = path.dirname(file);
  const out = [];
  let fence = false;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    // Claude Code doesn't import inside code blocks, so neither does the check.
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
    if (fence) continue;
    // An import can stand anywhere in the text ("See @README for …"), but not inside `code`,
    // and only after a space or at the line start — so user@example.com isn't one.
    const line = raw.replace(/`[^`]*`/g, '');
    for (const m of line.matchAll(/(?:^|\s)@([^\s`]+)/g)) {
      const imp = m[1].replace(/[.,;:!?)\]]+$/, ''); // "…see @AGENTS.md." — the dot ends the sentence
      if (!imp) continue;
      // "@backend-team owns the API" is a mention, not an import: a path has a / or a dot.
      if (!/[/.~]/.test(imp) && !fs.existsSync(path.join(dir, imp))) continue;
      const res = imp.startsWith('/')
        ? imp
        : imp.startsWith('~')
          ? path.join(os.homedir(), imp.slice(1))
          : path.join(dir, imp);
      out.push({ imp, res });
    }
  }
  return out;
}

const wsKind = (ws) => {
  const f = path.join(ws, '.claude', 'ws-kind');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : 'task';
};

const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').length - 1;
const bytes = (f) => fs.statSync(f).size;

// Workspaces generated before the English templates carry Russian headings and the
// ЗАПОЛНИТЬ placeholder, so every detection below accepts both forms.
const FILL_IN = /FILL IN|ЗАПОЛНИТЬ/;

function run(wsIn, cfg) {
  const ws = path.resolve(wsIn);
  if (!fs.existsSync(ws)) throw new Error(`no such directory ${ws}`);
  let fails = 0;
  let warns = 0;
  const ok = (s) => ui.ok(s);
  const warn = (s) => { warns++; ui.warn(s); };
  const fail = (s) => { fails++; ui.fail(s); };

  const kind = wsKind(ws);
  ui.head(`Checking workspace: ${ws}`);
  ui.dim(`  kind: ${kind}`);

  let alwaysOn = 0;

  // --- CLAUDE.md and its imports
  const claudeMd = path.join(ws, 'CLAUDE.md');
  if (fs.existsSync(claudeMd)) {
    const l = lines(claudeMd);
    alwaysOn += bytes(claudeMd);
    if (l > LIMITS.claudeMdMax) fail(`CLAUDE.md — ${l} lines, ceiling ${LIMITS.claudeMdMax}`);
    else if (l > LIMITS.claudeMdTarget) warn(`CLAUDE.md — ${l} lines, target ≤ ${LIMITS.claudeMdTarget}`);
    else ok(`CLAUDE.md — ${l} lines`);

    // The whole chain: an imported file's own imports load too, up to the hop limit. Each file
    // counts once toward the budget; "outside" is decided by the real path, through symlinks.
    const realWs = fs.realpathSync(ws);
    const seen = new Set([fs.realpathSync(claudeMd)]);
    const queue = [{ file: claudeMd, hops: 0 }];
    while (queue.length) {
      const { file, hops } = queue.shift();
      const from = path.relative(ws, file);
      for (const { imp, res } of importsOf(file)) {
        const where = from === 'CLAUDE.md' ? '' : ` (in ${from})`;
        if (!fs.existsSync(res)) { fail(`import @${imp}${where} does not resolve`); continue; }
        if (hops + 1 > LIMITS.importHops) {
          warn(`import @${imp}${where} is ${hops + 1} hops deep — Claude Code stops at ${LIMITS.importHops}`);
          continue;
        }
        const real = fs.realpathSync(res);
        if (seen.has(real)) continue;
        seen.add(real);
        if (!real.startsWith(realWs + path.sep)) warn(`import @${imp}${where} points outside the workspace — expect a one-time approval dialog`);
        else ok(`import @${imp}${where}`);
        if (fs.statSync(real).isFile()) {
          alwaysOn += bytes(real);
          queue.push({ file: res, hops: hops + 1 });
        }
      }
    }
  } else {
    fail('no CLAUDE.md');
  }

  // --- AGENTS.md
  const agentsMd = path.join(ws, 'AGENTS.md');
  if (fs.existsSync(agentsMd)) {
    const b = bytes(agentsMd);
    if (b > LIMITS.agentsMdMax) fail(`AGENTS.md — ${b} B, Codex chain ceiling ${LIMITS.agentsMdMax}`);
    else if (b > LIMITS.agentsMdTarget) warn(`AGENTS.md — ${b} B, target ≤ ${LIMITS.agentsMdTarget}`);
    else ok(`AGENTS.md — ${b} B`);
    const text = fs.readFileSync(agentsMd, 'utf8');
    // Russian stems (провер, команд, инвариант) match workspaces from the old templates.
    // Body of the first section whose heading matches, up to the next heading of any level.
    const section = (re) => {
      const m = text.match(new RegExp(`^##+ .*(${re.source}).*$`, 'im'));
      if (!m) return null;
      const rest = text.slice(m.index + m[0].length);
      const next = rest.search(/^#{1,6} /m);
      return next < 0 ? rest : rest.slice(0, next);
    };
    // The headings are always generated, so their presence alone says nothing: look inside.
    const verify = section(/провер|verif|команд|check|command/i);
    if (verify === null) warn('AGENTS.md has no section with a verifiable command (tests/typecheck/build)');
    else if (FILL_IN.test(verify)) warn('verification section has no command yet (FILL IN)');
    else if (/^- None: the sources are documents/m.test(verify)) ok('no verification command needed: the sources are documents');
    else ok('AGENTS.md has a verification command');
    const inv = section(/инвариант|invariant/i);
    if (inv === null) warn('no "invariants are not findings" section');
    else if (/None recorded yet/.test(inv)) ui.dim('  no invariants recorded yet');
    else ok('invariants are described');
  } else {
    fail('no AGENTS.md — Codex will see nothing');
  }

  // --- rules
  const rulesDir = path.join(ws, '.claude', 'rules');
  if (fs.existsSync(rulesDir)) {
    for (const f of fs.readdirSync(rulesDir).filter((n) => n.endsWith('.md')).sort()) {
      const p = path.join(rulesDir, f);
      const text = fs.readFileSync(p, 'utf8');
      const l = lines(p);
      if (text.startsWith('---') && /^paths:/m.test(text)) {
        if (l > LIMITS.ruleTarget) warn(`${f} — ${l} lines, target ≤ ${LIMITS.ruleTarget}`);
        else ok(`${f} — ${l} lines, paths set`);
      } else {
        warn(`${f} — no paths: loaded every session (${l} lines)`);
        alwaysOn += bytes(p);
      }
    }
  }

  // --- settings.json
  const settings = path.join(ws, '.claude', 'settings.json');
  if (fs.existsSync(settings)) {
    try {
      const j = JSON.parse(fs.readFileSync(settings, 'utf8'));
      ok('settings.json is valid');
      j.autoMemoryDirectory
        ? ok('autoMemoryDirectory is set — task memory is separate')
        : warn('no autoMemoryDirectory — memory will go to the repository-wide one');
    } catch (e) {
      fail(`settings.json — invalid JSON: ${e.message}`);
    }
  } else {
    fail('no .claude/settings.json');
  }

  // --- notes.md
  const notes = path.join(ws, 'notes.md');
  if (fs.existsSync(notes)) {
    // "Текущий контекст" is the heading in workspaces from the old templates.
    /Current context|Текущий контекст/.test(fs.readFileSync(notes, 'utf8'))
      ? ok('notes.md — "Current context" block is in place')
      : warn('notes.md has no "Current context" block');
  } else {
    warn('no notes.md');
  }

  // --- process specifics
  if (kind === 'process') {
    const skillsDir = path.join(ws, '.claude', 'skills');
    let found = false;
    if (fs.existsSync(skillsDir)) {
      for (const d of fs.readdirSync(skillsDir)) {
        const sk = path.join(skillsDir, d, 'SKILL.md');
        if (!fs.existsSync(sk)) continue;
        found = true;
        const text = fs.readFileSync(sk, 'utf8');
        /^disable-model-invocation:\s*true/m.test(text)
          ? ok(`skill ${d} — invoked manually only`)
          : warn(`skill ${d} may fire on its own: no disable-model-invocation`);
        if (FILL_IN.test(text)) warn(`skill ${d} has no steps described`);
      }
    }
    if (!found) fail('process without a skill: the procedure has nowhere to live');
    fs.existsSync(path.join(ws, 'journal.md')) ? ok('journal.md is in place') : fail('no journal.md — the run journal');
    const runs = path.join(ws, 'runs');
    if (fs.existsSync(runs)) ok(`runs recorded: ${fs.readdirSync(runs).filter((n) => n.endsWith('.md')).length}`);
    else warn('no runs/ directory');
  }

  // --- .learnings not at the root of a git checkout
  for (const name of fs.readdirSync(ws)) {
    const d = path.join(ws, name);
    let st;
    try { st = fs.statSync(d); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (g.isRepoRoot(d) && fs.existsSync(path.join(d, '.learnings'))) {
      fail(`${name}/.learnings/ is at the root of a git checkout: the task journal does not belong there`);
    }
  }
  if (fs.existsSync(path.join(ws, '.learnings'))) ok('.learnings/ at the workspace root');

  // --- symlinks
  for (const name of fs.readdirSync(ws).sort()) {
    const p = path.join(ws, name);
    let ls;
    try { ls = fs.lstatSync(p); } catch { continue; }
    if (!ls.isSymbolicLink()) continue;
    fs.existsSync(p) ? ok(`symlink ${name} → ${fs.readlinkSync(p)}`) : fail(`broken symlink ${name}`);
  }

  // --- memory
  const memIndex = path.join(ws, '.claude-memory', 'MEMORY.md');
  if (fs.existsSync(memIndex)) {
    const ml = lines(memIndex);
    const mb = bytes(memIndex);
    if (ml > LIMITS.memoryMaxLines || mb > LIMITS.memoryMaxBytes) {
      fail(`MEMORY.md — ${ml} lines / ${mb} B, anything beyond ${LIMITS.memoryMaxLines} lines or ${LIMITS.memoryMaxBytes} B is not loaded`);
    } else {
      ok(`MEMORY.md — ${ml} lines / ${mb} B`);
    }
    alwaysOn += mb;
  }

  // --- budget
  ui.head('Always-on budget');
  if (cfg.WSG_PARENT_CONTEXT && fs.existsSync(cfg.WSG_PARENT_CONTEXT)) {
    alwaysOn += bytes(cfg.WSG_PARENT_CONTEXT);
    ui.dim(`  counted parent ${cfg.WSG_PARENT_CONTEXT}`);
  }
  if (alwaysOn > LIMITS.alwaysOnTarget) warn(`≈${alwaysOn} B into every session, target ≤ ${LIMITS.alwaysOnTarget}`);
  else ok(`≈${alwaysOn} B into every session`);

  ui.head(`Total: ${fails} errors, ${warns} warnings`);
  return fails === 0 ? 0 : 1;
}

module.exports = { run, LIMITS, wsKind };
