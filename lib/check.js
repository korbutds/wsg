'use strict';

// Validator against the limits documented by vendors. Run it periodically, not only
// after creation: files grow, and the limit creeps up unnoticed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ui = require('./ui');
const g = require('./git');
const generate = require('./generate');
const { openFence, fencedLines } = generate;
const T = require('./templates');
const L = require('./launch');
const skills = require('./skills');
const team = require('./team');
const W = require('./workspace');
const CTX = require('./context');
const M = require('./mcp');

// The size of a <!-- wsg:epic-rules --> block that the AGENTS.md size finding names.
const EPIC_RULES_LARGE = 4096;

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
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  // Claude Code doesn't import inside code blocks, so neither does the check. Fences are read as
  // the generated blocks read them: a ```` fence isn't closed by the ``` line inside it.
  const fenced = fencedLines(lines).inside;
  for (const [i, raw] of lines.entries()) {
    if (fenced[i]) continue;
    // An import can stand anywhere in the text ("See @README for …"), but not inside `code`,
    // and only after a space or at the line start — so user@example.com isn't one.
    const line = raw.replace(/`[^`]*`/g, '');
    // A line that is nothing but the import is certainly meant as one; in prose, @word may be an
    // npm package (@scope/name), a team or a handle — see how check treats a missing target.
    const standalone = /^\s*@[^\s`]+\s*$/.test(line);
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
      out.push({ imp, res, standalone });
    }
  }
  return out;
}

// One YAML scalar as a frontmatter value holds it: "…" (read as JSON), '…', a [flow, list], or a
// plain one with a ` # comment` after it. null when it can't be read: an unclosed quote.
function scalar(raw) {
  let m = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(raw);
  if (m) {
    try { return JSON.parse(`"${m[1]}"`); } catch { return null; }
  }
  m = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(raw);
  if (m) return m[1].replace(/''/g, "'");
  m = /^\[(.*)\]\s*(?:#.*)?$/.exec(raw);
  if (m) return m[1].split(',').map((x) => scalar(x.trim())).filter((x) => x !== null && x !== '');
  if (/^["']/.test(raw)) return null;
  return raw.replace(/(^|\s+)#.*$/, '').trim();
}

// The frontmatter of an agent or a skill as its top-level keys, or null when there is none or a line
// in it can't be read. Read as Claude Code's YAML reads what people write: a BOM, CRLF, comments,
// a `- item` block list or a [flow] list, a `>`/`|` block scalar, nested maps (hooks:) skipped.
function frontmatter(text) {
  const all = text.replace(/^﻿/, '').split(/\r?\n/);
  if (all[0].trimEnd() !== '---') return null;
  const end = all.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (end < 0) return null;
  const out = {};
  let key = null; // the key the indented lines below belong to
  let folded = null; // a block scalar being read: its lines
  for (const l of all.slice(1, end)) {
    if (folded && (/^\s/.test(l) || !l.trim())) {
      folded.push(l.trim());
      continue;
    }
    if (folded) {
      out[key] = folded.filter(Boolean).join(' ');
      folded = null;
    }
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const item = /^\s*-\s+(.*)$/.exec(l);
    if (item) {
      if (key && Array.isArray(out[key])) {
        const v = scalar(item[1].trim());
        if (v === null) return null;
        out[key].push(v);
      }
      continue;
    }
    if (/^\s/.test(l)) {
      key = null; // a nested map: its own lists are not the key's
      continue;
    }
    const m = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(l);
    if (!m) return null;
    key = m[1];
    const raw = (m[2] || '').trim();
    if (/^[|>][+-]?\s*(?:#.*)?$/.test(raw)) {
      folded = [];
      continue;
    }
    if (raw === '' || raw.startsWith('#')) {
      out[key] = [];
      continue;
    }
    const v = scalar(raw);
    if (v === null) return null;
    out[key] = v;
  }
  if (folded) out[key] = folded.filter(Boolean).join(' ');
  return { keys: out, body: all.slice(end + 1).join('\n') };
}
// A value as text: a key with nothing after it (a list, a map) has none.
const str = (v) => (typeof v === 'string' ? v : '');
// tools and disallowedTools: `A, B`, a [flow] list or a block list. `Bash(git *)` is Bash.
const toolList = (v) => (Array.isArray(v) ? v : str(v).split(','))
  .map((x) => String(x).trim()).filter(Boolean);
const toolName = (x) => x.replace(/\(.*\)$/, '');

const wsKind = (ws) => {
  const f = path.join(ws, '.claude', 'ws-kind');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : 'task';
};

const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').length - 1;
const bytes = (f) => fs.statSync(f).size;
// A rule with paths: loads only once the session reads a file it matches.
const hasPaths = (text) => text.startsWith('---') && /^paths:/m.test(text);
// A marker as wsg add reads it: a line of its own at column 0, outside code blocks.
const hasMarkerIn = (text, marker) => {
  const all = text.split('\n');
  const fenced = fencedLines(all).inside;
  return all.some((l, i) => !fenced[i] && l.trimEnd() === marker);
};
const hasMarker = (file, marker) => hasMarkerIn(fs.readFileSync(file, 'utf8'), marker);

// The text without a block that has exactly one pair of markers (as blockLines finds it): the
// epic's Owner rules pasted into a task may have headings of their own, which are not the task's.
function withoutBlock(text, name) {
  const all = text.split('\n');
  const fenced = fencedLines(all).inside;
  const open = all.findIndex((l, i) => !fenced[i] && l.trimEnd() === `<!-- wsg:${name} -->`);
  const close = all.findIndex((l, i) => i > open && !fenced[i] && l.trimEnd() === `<!-- /wsg:${name} -->`);
  return open >= 0 && close > open ? [...all.slice(0, open), ...all.slice(close + 1)].join('\n') : text;
}

// Workspaces generated before the English templates carry Russian headings and the
// ЗАПОЛНИТЬ placeholder, so every detection below accepts both forms.
const FILL_IN = /FILL IN|ЗАПОЛНИТЬ/;

// env: where the agent and its config directories are looked up (PATH, HOME, CLAUDE_CONFIG_DIR,
// CODEX_HOME) — a parameter, so a test can't pick up the machine's own.
function run(wsIn, cfg, env = process.env) {
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
      for (const { imp, res, standalone } of importsOf(file)) {
        const where = from === 'CLAUDE.md' ? '' : ` (in ${from})`;
        if (!fs.existsSync(res)) {
          // Missing: a line of its own is a broken import. In prose it fails only the reader's
          // intent, not the check: a name with a file extension is probably a mistyped file,
          // anything else (@korbutds/wsg) is not a file reference at all.
          if (standalone) fail(`import @${imp}${where} does not resolve`);
          else if (/\.[A-Za-z0-9]+$/.test(path.basename(imp))) {
            warn(`@${imp}${where} looks like an import but does not resolve — if it isn't one, put it in backticks`);
          }
          continue;
        }
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
    const text = fs.readFileSync(agentsMd, 'utf8');
    // The epic's Owner rules count toward the limits too: a large block is named, it is cut in the epic.
    const rulesBlock = generate.blockLines(text, 'epic-rules');
    const rulesBytes = rulesBlock ? Buffer.byteLength(rulesBlock.join('\n')) : 0;
    const ofIt = rulesBytes >= EPIC_RULES_LARGE ? `; ${rulesBytes} B of it is the <!-- wsg:epic-rules --> block, the epic's Owner rules — shorten them in ../AGENTS.md` : '';
    if (b > LIMITS.agentsMdMax) fail(`AGENTS.md — ${b} B, Codex chain ceiling ${LIMITS.agentsMdMax}${ofIt}`);
    else if (b > LIMITS.agentsMdTarget) warn(`AGENTS.md — ${b} B, target ≤ ${LIMITS.agentsMdTarget}${ofIt}`);
    else ok(`AGENTS.md — ${b} B`);
    // Russian stems (провер, команд, инвариант) match workspaces from the old templates.
    // Body of the first section whose heading matches, up to the next heading of any level. Not in
    // the epic's Owner rules: a heading there ("### Why these checks") is the epic's, not the task's.
    const own = rulesBlock ? withoutBlock(text, 'epic-rules') : text;
    const section = (re) => {
      const m = own.match(new RegExp(`^##+ .*(${re.source}).*$`, 'im'));
      if (!m) return null;
      const rest = own.slice(m.index + m[0].length);
      const next = rest.search(/^#{1,6} /m);
      return next < 0 ? rest : rest.slice(0, next);
    };
    // An archived workspace (wsg archive) has its sources in the archive record: nothing to verify,
    // no repository attached, by design. Read here once; reported with the state below.
    let archivedState = null;
    try {
      const st = JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'wsg.json'), 'utf8'));
      if (st && typeof st === 'object' && W.KINDS.includes(st.kind) && W.isArchived(st)) archivedState = st;
    } catch { /* reported below */ }
    // The headings are always generated, so their presence alone says nothing: look inside.
    const verify = section(/провер|verif|команд|check|command/i);
    if (archivedState) { /* nothing to run while archived */ } else if (verify === null) warn('AGENTS.md has no section with a verifiable command (tests/typecheck/build)');
    else if (FILL_IN.test(verify)) warn('verification section has no command yet (FILL IN)');
    else if (/^- None: /m.test(verify)) ok('no verification command needed: nothing in the sources to run');
    else ok('AGENTS.md has a verification command');
    const inv = section(/инвариант|invariant/i);
    // A process has "Rules and boundaries" instead and gets the section only when it has invariants;
    // an epic has none: its tasks keep their own. FILL IN comes first: the skeleton's placeholder
    // offers "None recorded yet." as an answer.
    if (inv === null) {
      if (kind !== 'process' && kind !== 'epic') warn('no "invariants are not findings" section');
    } else if (FILL_IN.test(inv)) warn('invariants section is not filled in yet (FILL IN)');
    else if (/None recorded yet/.test(inv)) ui.dim('  no invariants recorded yet');
    else ok('invariants are described');

    // Only workspaces made by wsg 0.2+ have the state file; older ones are not judged by it, so
    // their report stays what it was. Until the setup dialogue is done this is a warning, not a
    // failure: a fresh skeleton passes its own check.
    const stateFile = path.join(ws, '.claude', 'wsg.json');
    if (fs.existsSync(stateFile)) {
      let state = null;
      try {
        state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      } catch (e) {
        fail(`.claude/wsg.json — invalid JSON: ${e.message}; wsg add refuses this workspace until it is fixed`);
      }
      if (state) {
        // A status this wsg doesn't know reads anyway (lib/workspace.js): said here, or nowhere.
        const statusBad = typeof state === 'object' && W.KINDS.includes(state.kind) ? W.statusProblem(state) : null;
        // A status "archived" without its record is a half archive: no command can bring its sources back.
        if (statusBad && state.status === 'archived' && state.archive === undefined) fail(`.claude/wsg.json: ${statusBad}`);
        else if (statusBad) warn(`.claude/wsg.json: ${statusBad}`);
        // An epic's ticket is what syncing reads the tracker by; a task may have none.
        if (state.kind === 'epic' && /^Ticket:.*(FILL IN|ЗАПОЛНИТЬ)/m.test(text)) warn('the epic has no ticket yet (Ticket: FILL IN) — syncing has nothing to read in the tracker');
        const git = (Array.isArray(state.sources) ? state.sources : []).filter((r) => !r.reference);
        const why = section(/\bwhy\b/i);
        const missing = [];
        if (!git.length && !archivedState) missing.push('no git repository attached');
        if (why === null || FILL_IN.test(why)) missing.push('"Why" is not filled in');
        if (missing.length) warn(`setup not finished: ${missing.join(', ')} — run /wsg-setup (or follow SETUP.md)`);
        else if (!archivedState) ok(`setup finished: ${git.length} git ${git.length === 1 ? 'repository' : 'repositories'} attached`);
        if (archivedState && state.archive && typeof state.archive === 'object') checkArchived(ws, state, { warn, fail });
        // A task taken out of its epic by hand keeps the block, and nothing renders it any more.
        if (generate.blockLines(text, 'epic-context') && state.kind !== 'epic' && !(state.kind === 'task' && state.epic)) {
          warn('AGENTS.md has a <!-- wsg:epic-context --> block, but this workspace is neither an epic nor a task of one: nothing updates it — delete the block');
        }
        if (rulesBlock && !(state.kind === 'task' && state.epic)) warn('AGENTS.md has a <!-- wsg:epic-rules --> block, but this workspace is no task of an epic: nothing updates it — delete the block, or move the rules you keep into ## Owner rules');
      }
      // Read as wsg add reads its markers: at column 0, outside code blocks.
      const all = text.split('\n');
      const fenced = fencedLines(all).inside;
      all.some((l, i) => !fenced[i] && l.trimEnd() === '<!-- wsg:advisor -->')
        ? ok('AGENTS.md sends questions for the owner through wsg-advisor')
        : warn('AGENTS.md has no <!-- wsg:advisor --> block: questions go straight to the owner — run wsg refresh');
    }
  } else {
    fail('no AGENTS.md — Codex will see nothing');
  }

  // --- files with generated blocks: an unclosed code fence hides the markers after it
  if (fs.existsSync(path.join(ws, '.claude', 'wsg.json'))) {
    for (const f of ['AGENTS.md', 'CLAUDE.md', 'README.md']) {
      const p = path.join(ws, f);
      if (!fs.existsSync(p)) continue;
      const open = openFence(fs.readFileSync(p, 'utf8'));
      if (open) fail(`${f} — the code block opened on line ${open.line} is never closed: wsg markers after it are not seen, wsg add refuses the file`);
    }
  }

  // --- rules
  const rulesDir = path.join(ws, '.claude', 'rules');
  if (fs.existsSync(rulesDir)) {
    for (const f of fs.readdirSync(rulesDir).filter((n) => n.endsWith('.md')).sort()) {
      const p = path.join(rulesDir, f);
      const text = fs.readFileSync(p, 'utf8');
      const l = lines(p);
      if (hasPaths(text)) {
        if (l > LIMITS.ruleTarget) warn(`${f} — ${l} lines, target ≤ ${LIMITS.ruleTarget}`);
        else ok(`${f} — ${l} lines, paths set`);
      } else if (kind === 'epic' && f === T.EPIC_RULE) {
        // Loaded every session on purpose: the pointer to knowledge.md, for the epic and its tasks.
        ok(`${f} — the pointer to knowledge.md, loaded every session (${bytes(p)} B)`);
        alwaysOn += bytes(p);
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
    const runs = path.join(ws, 'runs');
    const runFiles = fs.existsSync(runs) ? fs.readdirSync(runs).filter((n) => n.endsWith('.md')) : [];
    // New processes start without steps on purpose: they are worked out on the first run. After a
    // run — a runs/ file, or a journal entry like the one --promote writes for the task it was —
    // a missing procedure means something is off.
    const journalFile = path.join(ws, 'journal.md');
    const ran = runFiles.length > 0 || (fs.existsSync(journalFile) && /^## Run \d/m.test(fs.readFileSync(journalFile, 'utf8')));
    let found = false;
    if (fs.existsSync(skillsDir)) {
      for (const d of fs.readdirSync(skillsDir)) {
        // wsg-setup, and a wsg-feature left from the task it was, are the generator's, not the procedure.
        if (d.startsWith('wsg-')) continue;
        const sk = path.join(skillsDir, d, 'SKILL.md');
        if (!fs.existsSync(sk)) continue;
        found = true;
        const text = fs.readFileSync(sk, 'utf8');
        /^disable-model-invocation:\s*true/m.test(text)
          ? ok(`skill ${d} — invoked manually only`)
          : warn(`skill ${d} may fire on its own: no disable-model-invocation`);
        if (FILL_IN.test(text)) {
          if (ran) warn(`skill ${d} has no steps described, though it has been run`);
          else ok(`skill ${d}: steps are worked out on the first run`);
        }
      }
    }
    if (!found) fail('process without a skill: the procedure has nowhere to live');
    fs.existsSync(journalFile) ? ok('journal.md is in place') : fail('no journal.md — the run journal');
    if (fs.existsSync(runs)) ok(`runs recorded: ${runFiles.length}`);
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

  if (kind === 'epic') checkEpic(ws, env, { ok, warn, fail });
  // A task of an epic: the state names one. What its sessions load from the epic is counted below.
  let ownState = null;
  try { ownState = JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'wsg.json'), 'utf8')); } catch { /* reported above */ }
  // Another kind with an "epic" is a broken state, not a task to check against its epic.
  if (ownState && ownState.epic !== undefined && ownState.kind !== 'task') fail(`.claude/wsg.json — "epic" belongs only to a task, and this workspace is kind ${ownState.kind}: remove it`);
  const fromEpic = ownState && ownState.kind === 'task' && ownState.epic !== undefined ? checkEpicTask(ws, ownState, env, { ok, warn, fail }) : null;

  // --- the advisor agent, for the agent this workspace is started with (0.2+ workspaces only)
  if (fs.existsSync(path.join(ws, '.claude', 'wsg.json'))) {
    ui.head('Advisor');
    const agent = L.resolveAgent(cfg, env);
    const kind = L.agentKind(agent);
    if (kind === 'claude' || kind === 'codex') {
      const tool = kind === 'claude' ? 'Claude Code' : 'Codex';
      const { file, status, guard } = skills.status(env).find((x) => x.item.name === 'wsg-advisor' && x.item.root === kind);
      if (status === 'current') ok(`wsg-advisor for ${tool}: ${file}`);
      // install-skills skips the Codex agent without Codex: naming it would not help.
      else if (status === 'missing' && kind === 'codex' && !skills.codexPresent(env)) warn('Codex not found (no CODEX_HOME, ~/.codex or codex on PATH) — the Codex advisor is not installed');
      else if (status === 'missing') warn(`wsg-advisor for ${tool} is not installed — run wsg install-skills`);
      // A run killed with SIGKILL leaves the user's own agent next to it (test/advisor-agent.sh).
      else if (status === 'temporary' && fs.existsSync(`${file}.wsg-test-backup`)) warn(`${file} is a temporary agent left by a test run, and your own agent is saved as ${file}.wsg-test-backup — move it back`);
      else if (status === 'temporary') warn(`${file} is a temporary agent left by a test run — run wsg install-skills or delete it`);
      else if (status === 'outdated') warn(`${file} is outdated — run wsg install-skills`);
      else if (status === 'broken') warn(`${file} is broken: its hook runs ${guard}, which is not there, so every tool call of the advisor is blocked — run wsg install-skills`);
      else warn(`${file} was not written by wsg, so it is not wsg's advisor — move it away, then run wsg install-skills`);
      // Claude Code decides to delegate from CLAUDE.md as much as from the agent's description.
      if (kind === 'claude' && fs.existsSync(claudeMd)) {
        const all = fs.readFileSync(claudeMd, 'utf8').split('\n');
        const fenced = fencedLines(all).inside;
        all.some((l, i) => !fenced[i] && l.trimEnd() === '<!-- wsg:advisor -->')
          ? ok('CLAUDE.md tells Claude Code to call wsg-advisor before it asks the owner')
          : warn('CLAUDE.md has no <!-- wsg:advisor --> block: Claude Code is less likely to call the advisor — run wsg refresh');
      }
    } else if (agent) ui.dim(`  ${agent} has no wsg-advisor agent: it follows wsg guide advisor inline`);
    else ui.dim('  no agent configured (WSG_AGENT): the advisor agent is not checked');
    // A project-level agent wins over the user-level one of the same name, from the workspace or a
    // directory above it. The user-level file itself (~/.claude/agents under a workspace in HOME) is
    // not one.
    for (const { item, file: user } of skills.status(env).filter((x) => x.item.name === 'wsg-advisor')) {
      const rel = path.join(item.root === 'claude' ? '.claude' : '.codex', item.dest);
      for (const file of shadowsOf(ws, rel, user)) {
        const shown = path.dirname(file) === path.join(ws, path.dirname(rel)) ? rel : file;
        warn(`${shown} shadows the wsg-advisor agent wsg installs: the name is reserved for wsg — rename it`);
      }
    }
  }

  // --- the team `wsg team` installed, and what each role remembers (role memory)
  // Whatever a hand-made file there holds, the check goes on to its total.
  try {
    alwaysOn += checkTeam(ws, env, cfg, { ok, warn, fail });
  } catch (e) {
    fail(`the team check stopped: ${e.message}`);
  }

  // --- budget
  ui.head('Always-on budget');
  // The epic's files apart, so the owner sees where the bytes come from.
  const counted = new Set();
  if (fromEpic) {
    ui.dim(`  this task: ≈${alwaysOn} B`);
    const sum = fromEpic.files.reduce((n, f) => n + f.bytes, 0);
    if (fromEpic.files.length) {
      ui.dim(`  ${fromEpic.linked ? 'the epic above' : 'the directory above'}: ≈${sum} B — ${fromEpic.files.map((f) => `${f.rel} ${f.bytes} B`).join(', ')}`);
    }
    if (fromEpic.onDemand.length) ui.dim(`  not counted, paths: set (load when their files are read): ${fromEpic.onDemand.join(', ')}`);
    alwaysOn += sum;
    for (const f of fromEpic.files) counted.add(f.real);
  }
  if (cfg.WSG_PARENT_CONTEXT && fs.existsSync(cfg.WSG_PARENT_CONTEXT)) {
    if (counted.has(fs.realpathSync(cfg.WSG_PARENT_CONTEXT))) ui.dim(`  parent ${cfg.WSG_PARENT_CONTEXT} is the epic's, counted once`);
    else {
      alwaysOn += bytes(cfg.WSG_PARENT_CONTEXT);
      ui.dim(`  counted parent ${cfg.WSG_PARENT_CONTEXT}`);
    }
  }
  if (alwaysOn > LIMITS.alwaysOnTarget) warn(`≈${alwaysOn} B into every session, target ≤ ${LIMITS.alwaysOnTarget}`);
  else ok(`≈${alwaysOn} B into every session`);

  ui.head(`Total: ${fails} errors, ${warns} warnings`);
  return fails === 0 ? 0 : 1;
}

// An archived workspace (wsg archive): the info line — since when, the branches kept —, what is off in
// the record as warnings (W.archiveWarnings: a run that stopped half-way, a hand edit), and a fail for
// a source the record lists that is still in the workspace though the state no longer has it
// attached: wsg unarchive refuses it until it is moved out.
function checkArchived(ws, state, { warn, fail }) {
  const a = state.archive;
  const sources = Array.isArray(a.sources) ? a.sources.filter(W.isSource) : [];
  const branches = sources.filter((s) => s.mode === 'worktree' && s.branch).map((s) => `${s.name} (${s.branch})`);
  ui.dim(`  archived ${W.isDate(a.date) ? a.date : '?'}; branches kept: ${branches.length ? branches.join(', ') : 'none (no worktree was attached)'}`);
  for (const w of W.archiveWarnings(state)) warn(`.claude/wsg.json: ${w}`);
  const attached = new Set((Array.isArray(state.sources) ? state.sources : []).filter(W.isSource).map((s) => s.name));
  for (const s of sources) {
    if (typeof s.name !== 'string' || !s.name || attached.has(s.name)) continue;
    let st = null;
    try { st = fs.lstatSync(path.join(ws, s.name)); } catch { /* gone, as it should be */ }
    if (st) fail(`archived, but ${s.name} is still in the workspace — a half archive: wsg unarchive refuses it until it is moved out`);
  }
}

// What an epic has beyond a task: the knowledge base within its size, the pointer rule that sends
// every session to it, the tasks list with its block, and the manual skills over `wsg guide epic`.
// An epic has no repo pointer and no mr-target-branch.txt, and is checked for neither.
function checkEpic(ws, env, { ok, warn, fail }) {
  ui.head('Epic');
  const knowledge = path.join(ws, 'knowledge.md');
  if (!fs.existsSync(knowledge)) fail('no knowledge.md — the epic\'s tasks have nothing to read before their first edit');
  else {
    const b = bytes(knowledge);
    if (b > T.KNOWLEDGE_MAX) fail(`knowledge.md — ${b} B, ceiling ${T.KNOWLEDGE_MAX}: rewrite it, move rationale to decisions.md`);
    else if (b > T.KNOWLEDGE_TARGET) warn(`knowledge.md — ${b} B, target ≤ ${T.KNOWLEDGE_TARGET}: rewrite it rather than append`);
    else ok(`knowledge.md — ${b} B`);
  }
  fs.existsSync(path.join(ws, '.claude', 'rules', T.EPIC_RULE))
    ? ok(`.claude/rules/${T.EPIC_RULE} points sessions to knowledge.md`)
    : warn(`no .claude/rules/${T.EPIC_RULE}: sessions are not told to read knowledge.md`);
  const tasks = path.join(ws, 'tasks.md');
  if (!fs.existsSync(tasks)) warn('no tasks.md — the list of the epic\'s tasks');
  else {
    const all = fs.readFileSync(tasks, 'utf8').split('\n');
    const fenced = fencedLines(all).inside;
    all.some((l, i) => !fenced[i] && l.trimEnd() === '<!-- wsg:tasks -->')
      ? ok('tasks.md has its <!-- wsg:tasks --> block')
      : warn('tasks.md has no <!-- wsg:tasks --> block — run wsg refresh');
  }
  for (const name of T.EPIC_SKILLS) {
    const sk = path.join(ws, '.claude', 'skills', name, 'SKILL.md');
    if (!fs.existsSync(sk)) warn(`no skill ${name}: /${name} is not there — run wsg guide epic and follow it by hand`);
    else if (/^disable-model-invocation:\s*true/m.test(fs.readFileSync(sk, 'utf8'))) ok(`skill ${name} — invoked manually only`);
    else warn(`skill ${name} may fire on its own: no disable-model-invocation`);
  }

  // wsg team is refused in an epic: an agent here loads into every session of every task below.
  const agentsDir = path.join(ws, '.claude', 'agents');
  const adapters = fs.existsSync(agentsDir)
    ? fs.readdirSync(agentsDir).filter((f) => /^wsg-.+\.md$/.test(f) && f !== 'wsg-advisor.md').sort() : [];
  for (const f of adapters) warn(`.claude/agents/${f} in an epic: every session of its tasks loads it too — a team belongs in a task (wsg team there), move it`);

  // The tasks: what W.childrenOf finds, and the directories it leaves out for a state that doesn't read.
  let state;
  let children;
  try {
    state = W.readState(ws);
    children = W.childrenOf(ws);
  } catch (e) {
    warn(`the epic's tasks can't be listed: ${e.message}`);
    return;
  }
  const listed = new Set(children.map((c) => c.ws));
  for (const e of fs.readdirSync(ws, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name).sort()) {
    const dir = path.join(ws, e);
    if (listed.has(dir) || !W.hasState(dir)) continue;
    let s;
    try { s = W.readState(dir); } catch (err) {
      warn(`${e}/ — ${err.message}: not listed as a task of the epic, and tasks.md has no line for it, until it is fixed`);
      continue;
    }
    warn(`${e}/ is a ${s.kind} workspace inside the epic, but not its task: its state has no "epic"`);
  }
  for (const c of children) {
    const name = path.basename(c.ws);
    if (c.mismatch) warn(`task ${name} names epic ${c.state.epic.slug} in its state, not ${state.slug}: moved or copied by hand — fix "epic" in ${name}/.claude/wsg.json, or move it to its epic`);
    else ok(`task ${name}${c.state.ticket ? ` ${c.state.ticket}` : ''}`);
    // Done, but what it staged for the epic is still in its notes: the epic's closing moves the
    // merged entries out of `## For the epic`, so entries there were not merged (W.forEpicPending).
    if (W.isFrozen(c.state) && W.forEpicPending(c.ws, c.state)) {
      warn(`task ${name} is ${W.isArchived(c.state) ? 'archived' : 'done'}, but "## For the epic" in its notes.md still has entries: the epic has not merged them — wsg guide epic, section Closing`);
    }
  }
  if (!children.length) ui.dim('  no tasks yet');

  // The tasks whose epic-rules block is not the epic's Owner rules now: a refresh in each renders it
  // (the epic's own refresh never writes into its tasks). One read per task, no git; a task that
  // names another epic is reported above.
  const rules = generate.epicRules(ws, state.slug);
  if (rules.kind === 'refused') warn(`the Owner rules in AGENTS.md can't be rendered into the tasks: ${rules.why} — each task keeps the block it has`);
  else if (rules.missing && children.length) warn('AGENTS.md has no ## Owner rules section: each task keeps the rules its block has, a new task gets none — put the section back (FILL IN, or the rules)');
  else if (children.length) {
    const want = T.epicRulesLines(state.slug, rules).join('\n');
    const stale = children.filter((c) => {
      if (c.mismatch || W.isArchived(c.state)) return false;
      let text;
      try { text = fs.readFileSync(path.join(c.ws, 'AGENTS.md'), 'utf8'); } catch { return false; }
      const disk = generate.blockLines(text, 'epic-rules');
      return disk === null || disk.join('\n') !== want;
    }).map((c) => path.basename(c.ws));
    if (stale.length) warn(`tasks without the epic's Owner rules as they are now in their AGENTS.md: ${stale.join(', ')} — run wsg refresh in each`);
  }

  checkEpicContext(ws, state, children, { ok, warn, fail });
  checkEpicMcp(ws, state, children, env, { ok, warn, fail });

  // The block as refresh would render it from the tasks in the directory now.
  if (fs.existsSync(tasks) && hasMarker(tasks, '<!-- wsg:tasks -->')) {
    try {
      if (generate.renderTasks(ws, state).changed) warn('tasks.md lists other tasks or statuses than this directory holds — run wsg refresh');
    } catch (e) {
      warn(`the tasks block in tasks.md can't be rendered: ${e.message}`);
    }
  }
}

// The epic's context (`wsg context`): every listed file is there and within its limits, nothing in
// context/ is left out of the index, the index block is within its ceiling, and the epic's own block
// and its tasks' are the index as it is now. A task that is done is not refreshed by `wsg context`
// and is left out of the stale list; so is one that names another epic (reported above).
function checkEpicContext(ws, state, children, { ok, warn, fail }) {
  const items = state.context || [];
  const C = W.CONTEXT;
  const taken = CTX.takenProblem(ws, state);
  if (taken && items.length) fail(`context/: ${taken}`);
  else if (taken) ui.dim('  context/ is taken by something else: wsg context refuses until it is moved');
  const listed = new Set();
  for (const x of items) {
    if (x.type === 'link') continue;
    listed.add(x.path);
    const p = path.join(ws, x.path);
    let st = null;
    try { st = fs.lstatSync(p); } catch { /* missing */ }
    if (!st || !st.isFile()) {
      fail(`context item ${x.id}: ${x.path} is missing — the index points to nothing: put the file back, or wsg context remove ${x.id}`);
      continue;
    }
    const [size, max] = CTX.sizesOf(st.size, C.fileMax);
    const [, soft] = CTX.sizesOf(st.size, C.fileWarn);
    if (st.size > C.fileMax) fail(`context item ${x.id}: ${x.path} — ${size}, ceiling ${max}: attach it as a link instead`);
    else if (st.size > C.fileWarn) warn(`context item ${x.id}: ${x.path} — ${CTX.sizesOf(st.size, C.fileWarn)[0]}, above ${soft}: an agent reads it only in parts`);
    // Edited by hand: the size the index shows is stale. For a file wsg wrote, wsg context remove or
    // note --replace refuses it until --discard-edits; one only listed is the owner's to edit.
    if (st.size <= C.fileMax && CTX.unchanged(ws, x) === false) {
      if (x.type === 'file' && !x.copied) ui.dim(`  context item ${x.id}: ${x.path} changed since it was listed — the index shows the old size: remove and add it again to list it anew`);
      else warn(`context item ${x.id}: ${x.path} changed since wsg wrote it — the index shows the old size; wsg context remove and note --replace refuse it without --discard-edits`);
    }
  }
  // What lies in context/ that no item lists: no agent is told it is there. Hidden files (.DS_Store)
  // are not looked at.
  const dir = path.join(ws, 'context');
  const unlisted = [];
  if (!taken && fs.existsSync(dir)) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      if (e.name === 'notes' && e.isDirectory()) {
        for (const n of fs.readdirSync(path.join(dir, 'notes'))) {
          if (!n.startsWith('.') && !listed.has(`context/notes/${n}`)) unlisted.push(`context/notes/${n}`);
        }
      } else if (!listed.has(`context/${e.name}`)) unlisted.push(`context/${e.name}${e.isDirectory() ? '/' : ''}`);
    }
  }
  for (const f of unlisted.sort()) {
    // Each with the fix that works for it: a note's file can't be listed where it is, nor a directory.
    if (f.startsWith('context/notes/')) warn(`${f} is in context/notes/ but no note lists it: no agent is told it is there — delete it, or move it out of context/ and write it with wsg context note <id> --from <file>`);
    else if (f.endsWith('/')) warn(`${f} is a directory in context/, which holds only files: no agent is told it is there — delete it, or attach it as a reference source (wsg add <path> --reference)`);
    else warn(`${f} is in context/ but not in the index: no agent is told it is there — list it (wsg context add ${path.join(ws, f)}) or delete it`);
  }
  // No items: the blocks are empty. One that still lists something (a task that was busy when the last
  // item went) is stale; a block that is not there at all is fine.
  if (!items.length) {
    let own0 = null;
    try { own0 = generate.blockLines(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8'), 'epic-context'); } catch { /* reported above */ }
    if (own0 && own0.length) warn('the <!-- wsg:epic-context --> block in AGENTS.md is not the index as it is now — run wsg refresh');
    const stale0 = children.filter((c) => {
      if (c.mismatch || W.isFrozen(c.state)) return false;
      let text;
      try { text = fs.readFileSync(path.join(c.ws, 'AGENTS.md'), 'utf8'); } catch { return false; }
      const disk = generate.blockLines(text, 'epic-context');
      return disk !== null && disk.length > 0;
    }).map((c) => path.basename(c.ws));
    if (stale0.length) warn(`tasks without the epic's context index as it is now in their AGENTS.md: ${stale0.join(', ')} — run wsg refresh in each`);
    return;
  }
  const bytes = CTX.blockBytes(state.slug, items);
  if (bytes > C.blockMax) fail(`the context index block is ${bytes} B, ceiling ${C.blockMax}: every task pays it on every request — shorten titles and descriptions, or remove items`);
  else if (bytes > C.blockWarn) warn(`the context index block is ${bytes} B, target ≤ ${C.blockWarn}: keep titles and descriptions short`);
  else ok(`context: ${items.length} ${items.length === 1 ? 'item' : 'items'}, the index block ${bytes} B`);
  let own = null;
  try { own = generate.blockLines(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8'), 'epic-context'); } catch { /* no AGENTS.md: reported above */ }
  const wantOwn = T.epicContextLines(state.slug, { kind: 'items', items }, 'epic').join('\n');
  if (own === null) warn('AGENTS.md has no <!-- wsg:epic-context --> block: the epic\'s sessions are not told about its context — run wsg refresh');
  else if (own.join('\n') !== wantOwn) warn('the <!-- wsg:epic-context --> block in AGENTS.md is not the index as it is now — run wsg refresh');
  const want = T.epicContextLines(state.slug, { kind: 'items', items }, 'task').join('\n');
  const stale = children.filter((c) => {
    if (c.mismatch || W.isFrozen(c.state)) return false;
    let text;
    try { text = fs.readFileSync(path.join(c.ws, 'AGENTS.md'), 'utf8'); } catch { return false; }
    const disk = generate.blockLines(text, 'epic-context');
    return disk === null || disk.join('\n') !== want;
  }).map((c) => path.basename(c.ws));
  if (stale.length) warn(`tasks without the epic's context index as it is now in their AGENTS.md: ${stale.join(', ')} — run wsg refresh in each`);
}

// What a refresh would do to the MCP keys of a workspace's settings.json: 'stale' when it would change
// them, 'ok' when not, null when the file does not read (reported elsewhere), or the refusal's text.
function mcpSettingsDrift(ws, wanted, prev) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'settings.json'), 'utf8')); } catch { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  try {
    return M.mergeSettings(j, wanted, prev, path.join(ws, '.claude', 'settings.json')).changed ? 'stale' : 'ok';
  } catch (e) {
    return e.message;
  }
}

// What a terminal session needs before a task gets the epic's servers: said in the epic and in a task.
const MCP_TRUST = '  in a terminal, the epic\'s MCP servers stay "Pending approval" in a task until its folder is trusted: one trust dialog per task directory, a trusted epic does not carry over';

// The variables the epic's servers read that this environment has no value for, and the epic's
// servers that take a name of the user-scope config.
function mcpEnvAndShadows(mcp, env, warn) {
  const missing = M.missingEnv(mcp, env);
  if (missing.length) warn(`MCP: not set in this environment: ${missing.join(', ')} — a server that reads one starts without it; export it where the agent runs (the app captures its environment once)`);
  const globals = new Set(M.globalClaude(env).map((g) => g.name));
  for (const s of mcp.servers.filter((x) => x.agents.includes('claude') && globals.has(x.name))) {
    warn(`MCP: the epic's server ${s.name} takes the name of a server in your user-scope Claude Code config: in the epic and its tasks the epic's is used — rename one of them if both are needed`);
  }
}

// The epic's MCP servers (`wsg mcp`): its .mcp.json has every server of the state as wsg renders it,
// its settings.json and each open task's enable and deny what the state says, the variables are set,
// no server hides a user-scope one. Nothing is said for an epic that never had servers and no open
// task of which still has wsg's MCP entries (one that was busy when the last server went).
function checkEpicMcp(ws, state, children, env, { ok, warn, fail }) {
  const mcp = state.mcp;
  const prev = state.mcpRendered;
  const open = children.filter((c) => !c.mismatch && !W.isFrozen(c.state));
  if (!mcp && !prev && !open.some((c) => c.state.mcpRendered)) return;
  const wanted = M.claudeWanted(mcp);
  // .mcp.json only when wsg has servers there or entries to take out: the owner's own file — a
  // symlink, JSON with comments — is not wsg's to judge.
  if (wanted.servers.length || (prev && prev.mcpJson.length)) {
    const file = path.join(ws, M.MCP_JSON);
    try {
      const text = generate.readOwned(ws, M.MCP_JSON);
      const r = M.renderMcpJson(text, wanted.servers, prev ? prev.mcpJson : [], file);
      if (r.changed) {
        let had = {};
        try { had = (text === null ? {} : JSON.parse(text).mcpServers) || {}; } catch { /* rendered above */ }
        const missing = wanted.servers.map((s) => s.name).filter((n) => !Object.prototype.hasOwnProperty.call(had, n));
        if (missing.length) warn(`.mcp.json has no entry for the epic's MCP ${missing.length === 1 ? 'server' : 'servers'} ${missing.join(', ')}: sessions here and in the tasks don't start ${missing.length === 1 ? 'it' : 'them'} — run wsg refresh`);
        else warn('.mcp.json is not the epic\'s MCP servers as they are now — run wsg refresh');
      }
    } catch (e) {
      fail(`${e.message} — wsg refresh refuses the epic until then`);
    }
  }
  const own = mcpSettingsDrift(ws, wanted, prev);
  if (own === 'stale') warn('.claude/settings.json: enabledMcpjsonServers or deniedMcpServers is not what the epic\'s MCP servers say now — run wsg refresh');
  else if (own && own !== 'ok') fail(`${own} — wsg refresh refuses the epic until then`);
  const stale = open.filter((c) => {
    const d = mcpSettingsDrift(c.ws, wanted, c.state.mcpRendered);
    return d !== null && d !== 'ok';
  }).map((c) => path.basename(c.ws));
  if (stale.length) warn(`tasks without the epic's MCP servers as they are now in their .claude/settings.json: ${stale.join(', ')} — run wsg refresh --tasks here, or wsg refresh in each`);
  if (!mcp) return;
  mcpEnvAndShadows(mcp, env, warn);
  const off = mcp.disabled.claude || [];
  ok(`MCP: ${wanted.servers.length} ${wanted.servers.length === 1 ? 'server' : 'servers'} of the epic, ${off.length} global turned off`);
  if (wanted.servers.length) ui.dim(MCP_TRUST);
}

// The epic's MCP servers in a task: its settings.json enables and denies what the epic says now.
// epic: the epic's state, read by checkEpicTask; null when the link is broken (reported there).
function checkEpicTaskMcp(ws, state, epic, env, { ok, warn }) {
  if (!epic || (!epic.mcp && !state.mcpRendered)) return;
  const wanted = M.claudeWanted(epic.mcp);
  const d = mcpSettingsDrift(ws, wanted, state.mcpRendered);
  if (d === 'stale') warn('.claude/settings.json: enabledMcpjsonServers or deniedMcpServers is not what the epic\'s MCP servers say now — run wsg refresh');
  else if (d && d !== 'ok') warn(`${d} — wsg refresh refuses this task until then`);
  else if (d === 'ok' && epic.mcp) ok(`.claude/settings.json enables the epic's MCP servers (${wanted.enabled.length}) and turns off ${wanted.denied.length} global`);
  if (!epic.mcp) return;
  mcpEnvAndShadows(epic.mcp, env, warn);
  if (wanted.servers.length) ui.dim(MCP_TRUST);
}

// The epic's context index in a task's AGENTS.md: the block is there and is what a refresh would
// render from the epic now (epicContextBlock against the block on disk). linked: as for the rules.
function checkEpicContextBlock(ws, state, text, linked, { ok, warn }) {
  const disk = generate.blockLines(text, 'epic-context');
  if (disk === null) {
    if (openFence(text)) return; // reported with the epic-rules block and below
    // A task made before 0.7 has no block; while its epic has no context it misses nothing.
    const now = linked ? generate.epicContext(generate.epicDirOf(ws), state.epic.slug) : null;
    if (!hasMarkerIn(text, '<!-- wsg:epic-context -->') && now && now.kind === 'items' && !now.items.length) return;
    hasMarkerIn(text, '<!-- wsg:epic-context -->')
      ? warn('AGENTS.md: the <!-- wsg:epic-context --> markers are not one pair at the start of a line — fix them, wsg refresh refuses the file until then')
      : warn('AGENTS.md has no <!-- wsg:epic-context --> block: agents are not told about the epic\'s context — run wsg refresh');
    return;
  }
  if (!linked) return;
  const b = generate.epicContextBlock(ws, state, text);
  if (b.context.kind === 'refused') warn(`the epic's context index can't be rendered: ${b.context.why} — the <!-- wsg:epic-context --> block keeps what it had`);
  else if (b.lines.join('\n') !== disk.join('\n')) warn('the <!-- wsg:epic-context --> block is not the epic\'s context index as it is now — run wsg refresh');
  else if (b.context.items.length) ok(`AGENTS.md has the epic's context index: ${b.context.items.length} ${b.context.items.length === 1 ? 'item' : 'items'}`);
}

// The epic's Owner rules in a task's AGENTS.md: the block is there, it is what a refresh would render
// from the epic now (epicRulesBlock against the block on disk, without computeRender), and the
// task's own Owner rules section does not repeat it. linked: the directory above is its epic; when
// not, the epic link is reported already and only the marker is looked for.
function checkEpicRules(ws, state, text, linked, { ok, warn }) {
  const disk = generate.blockLines(text, 'epic-rules');
  if (disk === null) {
    // An open fence hides every marker after it; the fence itself is reported below.
    if (openFence(text)) warn('AGENTS.md: a code block is never closed, so the <!-- wsg:epic-rules --> block can\'t be read — close it, wsg refresh refuses the file until then');
    else hasMarkerIn(text, '<!-- wsg:epic-rules -->')
      ? warn('AGENTS.md: the <!-- wsg:epic-rules --> markers are not one pair at the start of a line — fix them, wsg refresh refuses the file until then')
      : warn('AGENTS.md has no <!-- wsg:epic-rules --> block: agents other than Claude Code do not get the epic\'s Owner rules — run wsg refresh');
    return;
  }
  if (!linked) return;
  const b = generate.epicRulesBlock(ws, state, text);
  if (b.rules.kind === 'refused') warn(`the epic's Owner rules can't be rendered: ${b.rules.why} — the <!-- wsg:epic-rules --> block keeps what it had`);
  else if (b.kept) warn('the epic\'s AGENTS.md has no ## Owner rules section — the <!-- wsg:epic-rules --> block keeps what it had');
  else if (b.lines.join('\n') !== disk.join('\n')) warn('the <!-- wsg:epic-rules --> block is not the epic\'s Owner rules as they are now — run wsg refresh');
  else if (b.rules.kind === 'rules') ok('AGENTS.md has the epic\'s Owner rules as they are now');
  else ok('the epic has no Owner rules yet; AGENTS.md says so');
  const copy = generate.rulesOverlap(text, b.rules);
  if (copy) {
    warn(copy.n === copy.m
      ? 'the task\'s own ## Owner rules section repeats the epic\'s, which the <!-- wsg:epic-rules --> block renders: delete the section'
      : `${copy.n} of ${copy.m} lines of the task's own ## Owner rules section are also the epic's, which the <!-- wsg:epic-rules --> block renders: keep only the task's own rules there`);
  }
}

// A task of an epic: the directory above is that epic, and AGENTS.md says so to agents that read
// only it. Returns what Claude Code loads into every session of the task from the directory above:
// { linked, files: [{ rel, bytes, real }], onDemand: [rel] } — linked: it is the task's epic.
function checkEpicTask(ws, state, env, { ok, warn, fail }) {
  ui.head('Epic');
  // The real directory above, as Claude Code walks it: a task opened through a symlink elsewhere
  // still sits in its epic.
  const parent = path.dirname(fs.realpathSync(ws));
  const slug = state.epic && typeof state.epic.slug === 'string' ? state.epic.slug : '';
  const problem = W.stateProblem(state);
  let why = '';
  let epic = null;
  if (problem) why = `.claude/wsg.json: ${problem}`;
  else if (!W.hasState(parent)) why = `the directory above, ${parent}, is no wsg workspace`;
  else {
    try {
      epic = W.readState(parent);
      if (epic.kind !== 'epic') why = `the directory above, ${parent}, is a ${epic.kind} workspace, not an epic`;
      else if (epic.slug !== slug) why = `the directory above is epic ${epic.slug}, but this task's state names ${slug}`;
    } catch (e) {
      why = e.message;
    }
  }
  if (why) {
    fail(`epic link broken: ${why} — move the task into its epic's directory, or fix "epic" in .claude/wsg.json`);
    epic = null;
  } else ok(`part of epic ${slug}, the directory above`);

  const agentsMd = path.join(ws, 'AGENTS.md');
  if (fs.existsSync(agentsMd)) {
    hasMarker(agentsMd, '<!-- wsg:epic -->')
      ? ok('AGENTS.md points to the epic\'s knowledge.md and tasks.md')
      : warn('AGENTS.md has no <!-- wsg:epic --> block: agents other than Claude Code are not told about the epic — run wsg refresh');
    checkEpicRules(ws, state, fs.readFileSync(agentsMd, 'utf8'), !why, { ok, warn });
    checkEpicContextBlock(ws, state, fs.readFileSync(agentsMd, 'utf8'), !why, { ok, warn });
  }
  checkEpicTaskMcp(ws, state, epic, env, { ok, warn });

  // A source taken from the epic that the epic has dropped since: the task keeps its worktree,
  // new tasks just don't get it.
  if (epic) {
    const names = new Set(epic.sources.map((s) => String((s && s.name) || '').toLowerCase()));
    for (const s of state.sources.filter((x) => x && x.from === 'epic' && !names.has(String(x.name || '').toLowerCase()))) {
      warn(`source ${s.name} was taken from the epic, which has no source of that name now — the task keeps it; new tasks don't get it`);
    }
  }

  // What a session started here loads from the directory above (probe, Claude Code 2.1.312, -p):
  // its CLAUDE.md (and CLAUDE.local.md), .claude/rules/*.md — those with paths: only once their
  // files are read — and its agents, of which the session sees the descriptions, counted as
  // checkTeam counts the task's own. Its @-imports point outside the task and were not loaded, so
  // the epic's @AGENTS.md is not counted. An interactive, trusted session (probe P3) is not probed
  // yet. Rules in subdirectories are not read, as the task's own rules check doesn't read them.
  const files = [];
  const onDemand = [];
  const unreadable = (rel, e) => warn(`${rel} in the directory above can't be read (${e.code || e.message}): not counted in the budget`);
  const add = (rel) => {
    const p = path.join(parent, rel);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) files.push({ rel, bytes: bytes(p), real: fs.realpathSync(p) });
    } catch (e) { unreadable(rel, e); }
  };
  add('CLAUDE.md');
  add('CLAUDE.local.md');
  const list = (rel) => {
    const dir = path.join(parent, rel);
    try {
      return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort() : [];
    } catch (e) {
      unreadable(rel, e);
      return [];
    }
  };
  for (const f of list(path.join('.claude', 'rules'))) {
    const rel = path.join('.claude', 'rules', f);
    let text;
    try { text = fs.readFileSync(path.join(parent, rel), 'utf8'); } catch (e) { unreadable(rel, e); continue; }
    if (hasPaths(text)) onDemand.push(rel);
    else add(rel);
  }
  for (const f of list(path.join('.claude', 'agents'))) {
    const rel = path.join('.claude', 'agents', f);
    let text;
    try { text = fs.readFileSync(path.join(parent, rel), 'utf8'); } catch (e) { unreadable(rel, e); continue; }
    const fm = frontmatter(text);
    const b = fm ? Buffer.byteLength(str(fm.keys.description)) : 0;
    if (b) files.push({ rel: `${rel} (description)`, bytes: b, real: null });
  }
  return { linked: !why, files, onDemand };
}

// The team section: only for a workspace with a team — state.team, team/workflow.md, or an adapter
// of a role wsg knows — so older workspaces get no new findings. A team without state.team was not
// made by `wsg team` (copied by hand, or the state rewritten): its problems are warnings. Returns
// the bytes it adds to the always-on budget: the adapters' descriptions, which Claude Code shows
// the session to choose a subagent.
function checkTeam(ws, env, cfg, { ok, warn, fail }) {
  let state = null;
  try { state = JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'wsg.json'), 'utf8')); } catch { /* reported above */ }
  const had = state && state.team && typeof state.team === 'object' && Array.isArray(state.team.roles) ? state.team : null;
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const agentsDir = path.join(ws, '.claude', 'agents');
  // Every adapter wsg writes is wsg-<role>; a user's own agents are theirs. wsg-advisor is the
  // advisor's name, checked above. lstat: a dangling symlink is listed too.
  const adapters = isDir(agentsDir)
    ? fs.readdirSync(agentsDir).filter((f) => /^wsg-.+\.md$/.test(f) && f !== 'wsg-advisor.md').sort() : [];
  const known = adapters.some((f) => team.ROLES.includes(f.slice(4, -3)));
  if (!had && !isFile(path.join(ws, 'team', 'workflow.md')) && !known) return 0;
  ui.head('Team');
  const bad = had ? fail : warn;
  let budget = 0;
  const memory = []; // [role, dir] of the adapters that keep memory
  const memoryOff = [];

  for (const f of adapters) {
    const rel = path.join('.claude', 'agents', f);
    let text;
    try {
      text = fs.readFileSync(path.join(agentsDir, f), 'utf8');
    } catch (e) {
      bad(`${rel} — cannot be read (${e.code || e.message}): not an agent file`);
      continue;
    }
    const fm = frontmatter(text);
    if (!fm) {
      bad(`${rel} — no frontmatter, or a line in it can't be read`);
      continue;
    }
    const k = fm.keys;
    const name = f.slice(0, -3);
    const role = name.slice(4);
    const problems = [];
    if (!str(k.name)) problems.push('no name');
    else if (k.name !== name) problems.push(`name ${k.name} is not the file name ${name}`);
    if (!str(k.description)) problems.push('no description');
    const card = `team/${role}.md`;
    if (!fm.body.includes(`\`${card}\``)) problems.push(`its body does not name its card ${card}`);
    else if (!isFile(path.join(ws, 'team', `${role}.md`))) problems.push(`its card ${card} is missing`);
    for (const p of problems) bad(`${rel} — ${p}`);
    if (!problems.length) ok(`${rel} — reads ${card}`);
    // The owner may pick a model on purpose; wsg writes inherit so a role follows the session.
    if (str(k.model) !== 'inherit') warn(`${rel} — model is ${str(k.model) || 'not set'}, not inherit: the role does not follow the session's model`);
    budget += Buffer.byteLength(str(k.description));

    // Tools: the list wsg knows is not every tool there is, so a name it doesn't know is a note.
    // A known name in another case, or a word that is no tool name at all, is a typo: a warning.
    const denied = toolList(k.disallowedTools);
    const allowed = toolList(k.tools);
    for (const x of [...denied, ...allowed]) {
      const base = toolName(x);
      if (base.startsWith('mcp__') || team.KNOWN_TOOLS.includes(base)) continue;
      const like = team.KNOWN_TOOLS.find((t) => t.toLowerCase() === base.toLowerCase());
      if (like) warn(`${rel} — tool ${x}: names are case-sensitive, did you mean ${like}?`);
      else if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(base)) warn(`${rel} — ${JSON.stringify(x)} is not a tool name`);
      else ui.dim(`  ${rel}: tool ${x} is not one wsg knows — fine if your Claude Code has it`);
    }
    if (team.HANDBACK.includes(role)) {
      // Safe either way: denied, or an allowlist without the file tools.
      const writes = allowed.length
        ? ['Write', 'Edit', 'NotebookEdit'].filter((x) => allowed.map(toolName).includes(x))
        : ['Write', 'Edit'].filter((x) => !denied.map(toolName).includes(x));
      if (writes.length) warn(`${rel} — a read-only role, but it may use ${writes.join(' and ')}: it may write the file the lead saves`);
    }

    // Where Claude Code keeps a subagent's memory, by its memory: scope (the subagents docs):
    // user → <config>/agent-memory/<name>, project → .claude/agent-memory/<name>, local →
    // .claude/agent-memory-local/<name>. Only user is probed (2026-10-26); the other two are as
    // documented.
    const scope = str(k.memory);
    if (!scope || scope === 'none') memoryOff.push(role);
    else if (scope === 'user') memory.push([role, path.join(skills.configDir(env), 'agent-memory', name)]);
    else if (scope === 'project') memory.push([role, path.join(ws, '.claude', 'agent-memory', name)]);
    else if (scope === 'local') memory.push([role, path.join(ws, '.claude', 'agent-memory-local', name)]);
    else warn(`${rel} — memory: ${scope} is none of user, project, local`);
  }

  // wsg's own skills are invoked by their name, so it must be the directory's. A user's own skill
  // may take a display name.
  const skillsDir = path.join(ws, '.claude', 'skills');
  if (isDir(skillsDir)) {
    for (const d of fs.readdirSync(skillsDir).filter((x) => x.startsWith('wsg-')).sort()) {
      const sk = path.join(skillsDir, d, 'SKILL.md');
      const rel = path.join('.claude', 'skills', d, 'SKILL.md');
      if (!fs.existsSync(sk)) continue;
      let fm = null;
      try { fm = frontmatter(fs.readFileSync(sk, 'utf8')); } catch (e) { bad(`${rel} — cannot be read (${e.code || e.message})`); continue; }
      if (fm && str(fm.keys.name) && fm.keys.name !== d) bad(`${rel} — name ${fm.keys.name} is not the directory name ${d}`);
    }
  }

  isFile(path.join(ws, 'team', 'workflow.md'))
    ? ok('team/workflow.md is in place')
    : bad('no team/workflow.md — the roles have no stages to follow (run wsg team again)');
  if (had) {
    const agentsMd = path.join(ws, 'AGENTS.md');
    if (isFile(agentsMd)) {
      // Read as wsg add reads its markers: at column 0, outside code blocks.
      const all = fs.readFileSync(agentsMd, 'utf8').split('\n');
      const fenced = fencedLines(all).inside;
      all.some((l, i) => !fenced[i] && l.trimEnd() === '<!-- wsg:team -->')
        ? ok('AGENTS.md points to the team')
        : warn('AGENTS.md has no <!-- wsg:team --> block: agents other than Claude Code do not know the team — run wsg refresh');
    }
    for (const role of had.roles) {
      const gone = [path.join('team', `${role}.md`), path.join('.claude', 'agents', `wsg-${role}.md`)].filter((x) => !fs.existsSync(path.join(ws, x)));
      if (gone.length) warn(`role ${role} is in .claude/wsg.json, but ${gone.join(' and ')} ${gone.length > 1 ? 'are' : 'is'} gone — run wsg team again, or remove it by hand`);
    }
  }

  // /wsg-teach fills role memory; it is installed per user, like the advisor.
  if (had && L.agentKind(L.resolveAgent(cfg, env)) === 'claude') {
    const { file, status } = skills.status(env).find((x) => x.item.name === 'wsg-teach');
    if (status === 'current') ok(`wsg-teach for Claude Code: ${file}`);
    else if (status === 'missing') warn('wsg-teach for Claude Code is not installed: roles can not be taught practices — run wsg install-skills');
    else if (status === 'unmarked') warn(`${file} was not written by wsg, so it is not wsg's /wsg-teach — move it away, then run wsg install-skills`);
    else warn(`${file} is outdated — run wsg install-skills`);
  }

  // Role memory, shared by every workspace with that scope: warnings and notes, never failures.
  // MEMORY.md is the index Claude Code injects; it links each practice as practices/<slug>.md.
  const fresh = [];
  const fine = [];
  for (const [role, dir] of memory) {
    const index = path.join(dir, 'MEMORY.md');
    const where = `wsg-${role} memory`;
    try {
      if (!fs.existsSync(index)) {
        fresh.push(role);
        continue;
      }
      if (!isFile(index)) {
        warn(`${where}: ${index} is not a file, so the role has no index`);
        continue;
      }
      let found = false;
      const ml = lines(index);
      const mb = bytes(index);
      if (ml > LIMITS.memoryMaxLines || mb > LIMITS.memoryMaxBytes) {
        found = true;
        warn(`${where} ${index} — ${ml} lines / ${mb} B, anything beyond ${LIMITS.memoryMaxLines} lines or ${LIMITS.memoryMaxBytes} B is not loaded`);
      }
      const linked = new Set([...fs.readFileSync(index, 'utf8').matchAll(/practices\/([a-z0-9][a-z0-9-]*)\.md/g)].map((m) => m[1]));
      const pdir = path.join(dir, 'practices');
      if (fs.existsSync(pdir) && !isDir(pdir)) {
        warn(`${where}: ${pdir} is not a directory, so no practice can be read`);
        continue;
      }
      for (const slug of [...linked].sort()) {
        if (!isFile(path.join(pdir, `${slug}.md`))) {
          found = true;
          warn(`${where}: MEMORY.md links practices/${slug}.md, which is missing`);
        }
      }
      for (const f of isDir(pdir) ? fs.readdirSync(pdir).filter((x) => x.endsWith('.md')).sort() : []) {
        if (!linked.has(f.slice(0, -3))) {
          found = true;
          ui.dim(`  ${where}: practices/${f} is not in MEMORY.md, so it is never read`);
        }
      }
      if (!found) fine.push(role);
    } catch (e) {
      warn(`${where}: ${dir} cannot be read (${e.code || e.message})`);
    }
  }
  // In the order of the roles, as wsg team lists them.
  const rank = (r) => (team.ROLES.includes(r) ? team.ROLES.indexOf(r) : team.ROLES.length);
  const listed = (roles) => [...roles].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).join(', ');
  if (fine.length) ok(`role memory within limits: ${listed(fine)}`);
  if (fresh.length) ui.dim(`  no role memory yet: ${listed(fresh)} (or auto memory is disabled)`);
  if (memoryOff.length) ui.dim(`  memory off (no memory: in the adapter): ${listed(memoryOff)}`);
  return budget;
}

// <dir>/<rel> for the workspace and every directory above it, those that exist, but not `user`.
function shadowsOf(ws, rel, user) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const out = [];
  for (let dir = path.resolve(ws); ; dir = path.dirname(dir)) {
    const f = path.join(dir, rel);
    if (fs.existsSync(f) && real(f) !== real(user)) out.push(f);
    if (path.dirname(dir) === dir) break;
  }
  return out;
}

module.exports = { run, LIMITS, wsKind, frontmatter };
