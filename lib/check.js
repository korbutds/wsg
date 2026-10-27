'use strict';

// Validator against the limits documented by vendors. Run it periodically, not only
// after creation: files grow, and the limit creeps up unnoticed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ui = require('./ui');
const g = require('./git');
const { openFence, fencedLines } = require('./generate');
const L = require('./launch');
const skills = require('./skills');
const team = require('./team');

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
    else if (/^- None: /m.test(verify)) ok('no verification command needed: nothing in the sources to run');
    else ok('AGENTS.md has a verification command');
    const inv = section(/инвариант|invariant/i);
    // A process has "Rules and boundaries" instead and gets the section only when it has invariants.
    // FILL IN comes first: the skeleton's placeholder offers "None recorded yet." as an answer.
    if (inv === null) {
      if (kind !== 'process') warn('no "invariants are not findings" section');
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
        const git = (Array.isArray(state.sources) ? state.sources : []).filter((r) => !r.reference);
        const why = section(/\bwhy\b/i);
        const missing = [];
        if (!git.length) missing.push('no git repository attached');
        if (why === null || FILL_IN.test(why)) missing.push('"Why" is not filled in');
        if (missing.length) warn(`setup not finished: ${missing.join(', ')} — run /wsg-setup (or follow SETUP.md)`);
        else ok(`setup finished: ${git.length} git ${git.length === 1 ? 'repository' : 'repositories'} attached`);
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
    alwaysOn += checkTeam(ws, env, { ok, warn, fail });
  } catch (e) {
    fail(`the team check stopped: ${e.message}`);
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

// The team section: only for a workspace with a team — state.team, team/workflow.md, or an adapter
// of a role wsg knows — so older workspaces get no new findings. A team without state.team was not
// made by `wsg team` (copied by hand, or the state rewritten): its problems are warnings. Returns
// the bytes it adds to the always-on budget: the adapters' descriptions, which Claude Code shows
// the session to choose a subagent.
function checkTeam(ws, env, { ok, warn, fail }) {
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
