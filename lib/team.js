'use strict';

// `wsg team <preset>`: a team of roles for the agent of this workspace. The portable part lives in
// the workspace — a card per role in team/<role>.md and the stages in team/workflow.md — and every
// agent reads it. Claude Code gets an adapter per role (.claude/agents/wsg-<role>.md) that only
// points at the card, and in a task workspace /wsg-feature to run the workflow; a process skill
// gets one pointer line instead. AGENTS.md gets the `team` block.
//
// It only adds. A file that exists is the owner's from then on: kept as it is, never overwritten
// or removed; only the marked blocks (roles in workflow.md, team in AGENTS.md and the process
// skill) are rendered again. A run with a role left out (--without) is not remembered: the next
// run without --without adds it.

const fs = require('node:fs');
const path = require('node:path');
const T = require('./templates');
const generate = require('./generate');
const { t } = require('./i18n');

const ROLES = ['pm', 'designer', 'frontend', 'backend', 'devops', 'reviewer'];
const PRESETS = { fullstack: ROLES };

// The adapter's name, wsg-<role>, is the key of the role's memory: a role is never renamed, a new
// one is added instead. The read-only roles have no file tools and hand their document back to the
// lead (doc); they keep Bash, so read-only is their card's rule, not a sandbox. No role may start
// subagents of its own: the lead hands out the work. No `tools:` allowlist — it would hide MCP tools.
const READ_ONLY = ['Write', 'Edit', 'NotebookEdit', 'Agent'];
// The tool names an adapter may list, for `wsg check`; any MCP tool is mcp__<server>__<tool>.
// Task is the older name of Agent.
const KNOWN_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch', 'Write', 'Edit', 'NotebookEdit', 'Agent', 'Task'];
const knownTool = (name) => KNOWN_TOOLS.includes(name) || name.startsWith('mcp__');
const ROLE_META = {
  pm: {
    description: "Turns the owner's task into requirements — scope, acceptance criteria, open questions — and returns them as requirements.md text. Read-only. Use in stage 1 of /wsg-feature.",
    disallowed: READ_ONLY,
    doc: '`requirements.md`',
  },
  designer: {
    description: 'Read-only for code and the design. Use only when the task has an agreed design: returns design.md text (screens, states, copy, tokens, gaps), and after implementation a Design section for review.md.',
    disallowed: READ_ONLY,
    doc: '`design.md` (in stage 5, of the `## Design` section for `review.md`)',
  },
  frontend: {
    description: 'Implements UI: markup, styles, responsive layout, accessibility, loading, empty and error states. Follows design.md when there is one.',
    disallowed: ['Agent'],
  },
  backend: {
    description: 'Implements server-side work. Agrees the API contract in plan.md before writing code.',
    disallowed: ['Agent'],
  },
  devops: {
    description: "Infrastructure work listed in plan.md. Deploy, secrets, DNS and destructive operations only with the owner's explicit permission.",
    disallowed: ['Agent'],
  },
  reviewer: {
    description: 'Reviews the finished change and returns findings; never fixes. Use in stage 5 of /wsg-feature.',
    disallowed: READ_ONLY,
    doc: '`review.md` (its `## Findings` and `## Not checked`)',
  },
};

const WORKFLOW = path.join('team', 'workflow.md');
const FEATURE = path.join('.claude', 'skills', 'wsg-feature', 'SKILL.md');
const cardRel = (role) => path.join('team', `${role}.md`);
const adapterRel = (role) => path.join('.claude', 'agents', `wsg-${role}.md`);
// The process skill's one line: the procedure is still the skill's, the roles are on call.
const POINTER = 'With a team: run this procedure as the tech lead of `team/workflow.md`, handing its stages to the roles there.';

// One key per line, the description quoted: it holds colons.
function adapter(role) {
  const m = ROLE_META[role];
  const out = ['---', `name: wsg-${role}`, `description: ${JSON.stringify(m.description)}`,
    `disallowedTools: ${m.disallowed.join(', ')}`, 'model: inherit', 'memory: user', '---', ''];
  out.push(`You are wsg-${role}. Read \`team/${role}.md\` from the workspace root and follow it; if it is missing, say so and stop.`,
    'Read `team/workflow.md` for the stages and who owns which file.');
  if (m.doc) out.push('', `Return the full text of ${m.doc} as your final message; do not try to write it. The lead saves it.`);
  return out.join('\n') + '\n';
}

// The roles block of team/workflow.md: the roles this workspace has, each with its card.
const rolesLines = (roles) => roles.map((r) => `- \`${r}\` — \`team/${r}.md\`, subagent \`wsg-${r}\``);

// The roles a run installs: the preset's, without the ones left out. { roles } or { error }.
function rolesFor(preset, without) {
  const presets = Object.keys(PRESETS).join(', ');
  if (!preset) return { error: t('team.noPreset', { presets }) };
  if (!Object.hasOwn(PRESETS, preset)) return { error: t('team.badPreset', { preset, presets }) };
  const out = without === undefined ? [] : String(without).split(',').map((x) => x.trim()).filter(Boolean);
  const bad = out.filter((x) => !ROLES.includes(x));
  if (bad.length) return { error: t('team.badRole', { role: bad.join(', '), roles: ROLES.join(', ') }) };
  const roles = PRESETS[preset].filter((x) => !out.includes(x));
  if (!roles.length) return { error: t('team.noRoles', { preset }) };
  return { roles };
}

const isDir = (ws, rel) => {
  const st = generate.lstat(path.join(ws, rel));
  return !!st && st.isDirectory();
};

// What `wsg team` would write, worked out without writing: --dry-run shows it, apply writes exactly
// it. Returns { roles, installed, files: [{ rel, body, exists, changed, own, same }], rendered,
// restart, errors, warnings, notes }. own: a file wsg team creates (kept when it exists); the others
// are files whose block it renders. same: an existing file holds what wsg would write anew.
// notes: the warnings of its own, the rest come with the render.
function plan(ws, state, preset, without) {
  const errors = [];
  const notes = [];
  const files = [];
  const empty = { roles: [], installed: [], files, rendered: null, restart: false, errors, warnings: notes, notes };
  const r = rolesFor(preset, without);
  if (r.error) {
    errors.push(r.error);
    return empty;
  }
  // Its shape — kebab-case role names included — is checked by readState.
  const had = state.team;
  const old = had ? had.roles : [];
  // In the order of ROLES; a role only a newer wsg knows is kept after them.
  const installed = [...ROLES.filter((x) => old.includes(x) || r.roles.includes(x)), ...old.filter((x) => !ROLES.includes(x))];

  // A directory on the way that is a file would fail the write half-way: refused here, with the
  // files under it left out. A symlinked one is refused by readOwned.
  const badDirs = new Set();
  const dirOk = (rel) => {
    const parts = path.dirname(rel).split(path.sep);
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join(path.sep);
      if (badDirs.has(dir)) return false;
      const st = generate.lstat(path.join(ws, dir));
      if (st && !st.isDirectory() && !st.isSymbolicLink()) {
        badDirs.add(dir);
        errors.push(t('team.notADir', { path: dir, ws }));
        return false;
      }
    }
    return true;
  };
  // The file as it is now: null when there is none, undefined when it is refused.
  const current = (rel) => {
    if (!dirOk(rel)) return undefined;
    try {
      return generate.readOwned(ws, rel);
    } catch (e) {
      errors.push(e.message);
      return undefined;
    }
  };
  const own = (rel, body) => {
    const now = current(rel);
    if (now !== undefined) files.push({ rel, body, exists: now !== null, changed: now === null, own: true, same: now === body });
  };
  // A pair deleted by hand is put back, with a warning; the first insertion is no news.
  const block = (rel, text, name, lines, anchor, first, opts) => {
    try {
      const b = generate.replaceBlock(text, rel, name, lines, anchor, opts);
      if (b.restored && !first) notes.push(t('gen.markerRestored', { file: rel, name }));
      return b.text;
    } catch (e) {
      errors.push(e.message);
      return undefined;
    }
  };

  for (const role of r.roles) {
    own(cardRel(role), T.template(path.join('team', 'roles', `${role}.md`)));
    own(adapterRel(role), adapter(role));
  }
  // workflow.md is the owner's too; only its roles block follows the installed roles.
  const wf = current(WORKFLOW);
  if (wf !== undefined) {
    const roles = (text, first) => block(WORKFLOW, text, 'roles', rolesLines(installed), /^## Roles in this workspace[ \t]*$/, first);
    const anew = roles(T.template(path.join('team', 'workflow-feature.md')), true);
    const body = wf === null ? anew : roles(wf, false);
    if (body !== undefined) files.push({ rel: WORKFLOW, body, exists: wf !== null, changed: body !== wf, own: true, same: wf === anew });
  }
  // Whether the process skill holds the pointer once this run is done: then a missing one later
  // was deleted by hand. A task promoted to a process gets its first one on the next run.
  let pointer = !!(had && had.pointer);
  if (state.kind === 'process') {
    // A process has its procedure skill already: one pointer line there, no second skill.
    const rel = path.join('.claude', 'skills', state.skillName || '', 'SKILL.md');
    const text = state.skillName ? current(rel) : null;
    if (text === null) notes.push(t('team.skillMissing', { file: rel }));
    else if (text !== undefined) {
      const body = block(rel, text, 'team', [POINTER], /^# /, !pointer, { frontmatter: true });
      if (body !== undefined) {
        files.push({ rel, body, exists: true, changed: body !== text, own: false });
        pointer = true;
      }
    }
  } else {
    own(FEATURE, T.template(path.join('claude', 'wsg-feature', 'SKILL.md')));
  }

  const next = { ...state, team: { preset, roles: installed, ...(pointer ? { pointer: true } : {}) } };
  let rendered = null;
  try {
    rendered = generate.computeRender(ws, next, null, [], { fresh: had ? [] : ['team'] });
  } catch (e) {
    errors.push(e.message);
  }
  // Claude Code live-reloads only directories that existed when the session started: a hint only
  // when this run makes .claude/agents/, or the skill's directory under a .claude/skills/ it makes.
  const creates = (rel) => files.some((f) => f.rel === rel && !f.exists);
  const restart = (!isDir(ws, path.join('.claude', 'agents')) && r.roles.some((x) => creates(adapterRel(x))))
    || (!isDir(ws, path.join('.claude', 'skills')) && creates(FEATURE));
  return {
    roles: r.roles,
    installed,
    files,
    rendered,
    restart,
    errors,
    warnings: [...notes, ...(rendered ? rendered.warnings : [])],
    notes,
  };
}

// What a plan lists, as --dry-run and the summary show it.
const created = (p) => p.files.filter((f) => !f.exists).map((f) => f.rel);
const kept = (p) => p.files.filter((f) => f.own && f.exists && !f.changed).map((f) => f.rel);
// The kept files worth a line: the ones that differ from what wsg would write (an owner's edit).
const keptDiffering = (p) => p.files.filter((f) => f.own && f.exists && !f.changed && !f.same).map((f) => f.rel);
const updated = (p) => [...p.files.filter((f) => f.exists && f.changed).map((f) => f.rel),
  ...(p.rendered ? generate.changedFiles(p.rendered) : [])];

// The directories on the way that are missing, made one by one; undo removes them, empty, after
// the files in them (the steps run newest first).
function makeDirs(ws, rel, txn) {
  const parts = path.dirname(rel).split(path.sep);
  for (let i = 1; i <= parts.length; i++) {
    const dir = parts.slice(0, i).join(path.sep);
    const p = path.join(ws, dir);
    if (generate.lstat(p)) continue;
    generate.assertNoLinks(ws, path.join(dir, 'x'));
    fs.mkdirSync(p);
    txn.add(() => fs.rmdirSync(p));
  }
}

// A new file, never through a path that appeared since the plan: wx. Undo deletes only what this
// run created — the step is recorded once the file is ours.
function createFile(ws, rel, body, txn) {
  makeDirs(ws, rel, txn);
  generate.assertNoLinks(ws, rel);
  const p = path.join(ws, rel);
  const fd = fs.openSync(p, 'wx');
  txn.add(() => fs.rmSync(p, { force: true }));
  try {
    fs.writeSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
}

// Writes a plan without errors. New files first, then the blocks, then AGENTS.md and the state:
// a failure anywhere puts every file back as it was and removes what was created.
function apply(ws, p) {
  return generate.guarded((txn) => {
    const edited = p.files.filter((f) => f.exists && f.changed).map((f) => f.rel);
    const before = generate.snapshot(ws, [...generate.RENDERED, ...edited]);
    txn.add(() => generate.restore(ws, before));
    for (const f of p.files) {
      if (!f.exists) createFile(ws, f.rel, f.body, txn);
      else if (f.changed) generate.writeOwned(ws, f.rel, f.body);
    }
    generate.applyRender(ws, p.rendered);
    return { written: created(p).length + updated(p).length };
  }, t('team.rollingBack', { ws }));
}

// The roles that hand their document back to the lead instead of writing it.
const HANDBACK = ROLES.filter((r) => ROLE_META[r].doc);

module.exports = { ROLES, PRESETS, ROLE_META, HANDBACK, KNOWN_TOOLS, knownTool, POINTER, adapter, rolesFor, plan, apply, created, kept, keptDiffering, updated };
