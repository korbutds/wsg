'use strict';

// What makes a directory a wsg workspace: where it may live, what it and its skill may be called,
// and the state file that says which parts of it the generator owns.

const fs = require('node:fs');
const path = require('node:path');
const { t } = require('./i18n');

// A slug becomes a directory under WS_ROOT and a `ws <slug>` argument; a skill name becomes a
// directory under .claude/skills and a /command. Neither may carry a path: `../x` would put the
// workspace — and its rollback's rm -rf — outside WS_ROOT.
const KEBAB = /^[a-z0-9][a-z0-9-]*$/;

// Names the generator creates at the workspace root. A source with one of these names would be a
// symlink there, and writing the template would go through it — over the user's own file
// outside the workspace. `repo` is allowed: the pointer is skipped when a source takes the name.
// `.git` too: a symlink to someone's .git would make the workspace itself a work tree of that repo.
// requirements.md, design.md, plan.md, review.md and team/ are kept free for the team workflow;
// tasks.md, decisions.md, knowledge.md, context/ (`wsg context`) and .mcp.json (`wsg mcp`) for an epic;
// checklist.md for a task's checklist, spec.md (and plan.md) for its spec stages (`wsg new --spec`).
// A task of an epic is a directory in it, so its slug can't take
// these names either.
const RESERVED = ['CLAUDE.md', 'AGENTS.md', 'README.md', 'notes.md', 'SETUP.md', 'journal.md', 'runs', 'checklist.md', 'spec.md',
  'mr-target-branch.txt', 'requirements.md', 'design.md', 'plan.md', 'review.md', 'team',
  'tasks.md', 'decisions.md', 'knowledge.md', 'context', '.mcp.json', '.claude', '.claude-memory', '.learnings', '.git'];
const reserved = (name) => RESERVED.some((n) => n.toLowerCase() === name.toLowerCase());

// An epic holds the knowledge and the repositories of one tracker epic; its tasks are ordinary
// task workspaces inside its directory.
const KINDS = ['task', 'process', 'epic'];

// .claude/wsg.json is the single source of truth for the parts wsg generates: the sources and how
// each one is attached. Every `wsg add` re-renders from it the marked blocks of AGENTS.md, CLAUDE.md
// and README.md, the settings, the rules and the pointers. Text that people and agents write — why,
// done, scope, invariants, links — lives only in AGENTS.md, outside the markers: a copy here would
// drift from what the agent actually reads. The ticket too, with one exception: a task of an epic
// keeps the parsed key here, written once by `wsg new`, for the epic's branch templates.
// A task or a process also keeps its status here: "open", "review" or "done", and "closed" with the
// date it became done — only while it is done. `wsg new` writes "open"; a state from an older wsg
// has no status, which reads as open (statusOf). An epic has no status: its tasks do. wsg 0.4 and
// 0.5 keep both keys, since every writer spreads the state it read, so the version stays. A value
// this wsg doesn't know (a status from a later version) never makes the state unreadable: it is a
// warning (statusProblem, shown by wsg check), and the task stays listed in its epic.
// `wsg archive` (lib/archive.js) sets "archived" and an "archive" record: { date, previous: { status,
// closed }, sources: [the source entries as they were], byEpic? } for a task or a process — byEpic:
// true when the archive of its epic took it; { date, sources, cascade: [the slugs of the tasks that
// archive took] } for an epic, which has no status. While archived, "sources" is empty: the sources
// are in the record, so render, check and list see none, and `wsg unarchive` attaches them again.
// An archived state is version 4 (ARCHIVED_STATE_VERSION), so an older wsg refuses it.
// A task made with `wsg new --no-code` keeps "noCode": true: no worktree, no branch (wsg add takes
// links and references only), and wsg check asks for a Definition of done instead of a repository.
// An older wsg ignores the key and keeps it, since every writer spreads the state it read.
// A task made with `wsg new --spec` keeps "spec": true: it goes through spec.md, plan.md and
// checklist.md, each stage after the owner's ok (the Stages section of its AGENTS.md).
const STATE_FILE = path.join('.claude', 'wsg.json');
// An epic is version 3: wsg 0.4 refuses it instead of taking it for a task. An archived workspace,
// of any kind, is version 4: wsg 0.7 and earlier refuse it instead of changing it (a status set, a
// source added) into a state this wsg could no longer bring back.
const STATE_VERSION = 2;
const EPIC_STATE_VERSION = 3;
const ARCHIVED_STATE_VERSION = 4;
const stateVersion = (kind, archived = false) => (archived ? ARCHIVED_STATE_VERSION : kind === 'epic' ? EPIC_STATE_VERSION : STATE_VERSION);

// The statuses `wsg status` sets; archived is known too, but only `wsg archive` sets it.
const STATUSES = ['open', 'review', 'done'];
const KNOWN_STATUSES = [...STATUSES, 'archived'];
// A task's or a process's status as stored, even one this wsg doesn't know; "open" when there is
// none (a state from before it); null for an epic.
const statusOf = (state) => {
  if (state.kind === 'epic') return null;
  return typeof state.status === 'string' && state.status ? state.status : 'open';
};
// How a status reads next to a task's name (wsg list, the epic's tasks.md): nothing for open,
// [review], [done YYYY-MM-DD] — [done] without a valid date —, [archived YYYY-MM-DD]. A status this
// wsg doesn't know shows as it is, [blocked], when it is a plain word; anything else (a hand edit
// with spaces or brackets) as [?], so a line of markdown can't be broken by it. date: the date it was
// closed, for done; the date it was archived, for archived.
const statusMarker = (status, date) => {
  if (status === null || status === undefined || status === 'open') return '';
  if (status === 'done' || status === 'archived') return isDate(date) ? `[${status} ${date}]` : `[${status}]`;
  return typeof status === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(status) ? `[${status}]` : '[?]';
};
// Whether wsg archive took the workspace: an "archive" record, or — a half archive, which wsg check
// reports — a task's status "archived" without one.
const isArchived = (state) => !!state && (state.archive !== undefined || statusOf(state) === 'archived');
// The date it was archived, or null.
const archivedOn = (state) => (state && state.archive && isDate(state.archive.date) ? state.archive.date : null);
// A workspace nothing changes any more until it is reopened: a task or a process that is done or
// archived, an archived epic. The epic's changes are not rendered into it (refreshEpicTasks), its
// staleness is not reported (wsg check).
const isFrozen = (state) => isArchived(state) || statusOf(state) === 'done';
// The marker of a workspace's state: its status with the date that goes with it; an archived epic
// has no status, and reads [archived date] all the same.
const markerOf = (state) => (isArchived(state) ? statusMarker('archived', archivedOn(state))
  : statusMarker(statusOf(state), state.closed));
// YYYY-MM-DD and a real day: 2026-02-30 is not one.
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;

function slugError(slug) {
  if (!slug) return t('validate.required');
  if (!KEBAB.test(slug)) return t('validate.kebab');
  return '';
}

// The wsg- prefix belongs to the generator's own skills (/wsg-setup), so a procedure can't shadow one.
function skillError(name) {
  if (!name) return t('validate.required');
  if (!KEBAB.test(name)) return t('validate.kebab');
  if (name.startsWith('wsg-')) return t('validate.skillPrefix');
  return '';
}

// The kebab rule already rules out separators; the resolved path is checked anyway, so the
// guarantee doesn't hang on a regular expression.
function childPath(dir, slug) {
  const root = path.resolve(dir);
  const ws = path.resolve(root, slug);
  if (path.dirname(ws) !== root) throw new Error(t('workspace.outside', { slug, root }));
  return ws;
}

const wsPath = (slug, cfg) => childPath(cfg.WS_ROOT, slug);

// lstat: a dangling symlink is an entry too.
const entryExists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

// Called by generate before anything is created: the answers may come from a test or a script,
// not only from the CLI, which validates the same things.
// a.epicWs: a task of that epic, placed in its directory — next to the epic's own files and the
// links to its sources, so the slug must not be one of their names.
function assertSafe(a, cfg) {
  if (!KINDS.includes(a.kind)) throw new Error(t('workspace.badKind', { kind: a.kind }));
  const bad = slugError(a.slug);
  if (bad) throw new Error(t('workspace.badSlug', { slug: a.slug, why: bad }));
  const ws = a.epicWs ? childPath(a.epicWs, a.slug) : wsPath(a.slug, cfg);
  if (a.kind === 'process') {
    const badSkill = skillError(a.skillName);
    if (badSkill) throw new Error(t('workspace.badSkill', { name: a.skillName, why: badSkill }));
  }
  if (a.epicWs) {
    if (a.kind !== 'task') throw new Error(t('workspace.epicTaskKind', { kind: a.kind }));
    if (reserved(a.slug)) throw new Error(t('workspace.childReserved', { slug: a.slug }));
    const epic = epicState(a.epicWs);
    if (epic.sources.some((s) => ((s && s.name) || '').toLowerCase() === a.slug.toLowerCase())) {
      throw new Error(t('workspace.childIsSource', { slug: a.slug }));
    }
    if (entryExists(ws)) throw new Error(t('validate.exists', { path: ws }));
    return ws;
  }
  if (fs.existsSync(ws)) throw new Error(t('validate.exists', { path: ws }));
  return ws;
}

const hasState = (dir) => fs.existsSync(path.join(dir, STATE_FILE));
// Workspaces made by wsg 0.1 have ws-kind but no state file.
const hasKind = (dir) => fs.existsSync(path.join(dir, '.claude', 'ws-kind'));
// A workspace of wsg 0.1, without the state file: ws-kind, or — older still — a CLAUDE.md in a
// directory that is not a repository. wsg add and the others refuse it; wsg list shows it.
const isLegacy = (dir) => !hasState(dir)
  && (hasKind(dir) || (fs.existsSync(path.join(dir, 'CLAUDE.md')) && !fs.existsSync(path.join(dir, '.git'))));

// The nearest directory at or above `start` that is a workspace. A session or a shell is often
// inside one of its worktrees, so the current directory alone is not enough.
// Returns { ws, legacy } or null; legacy: a 0.1 workspace, without the state file.
function find(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (hasState(dir)) return { ws: dir, legacy: false };
    if (hasKind(dir)) return { ws: dir, legacy: true };
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// { preset, roles, pointer? }: roles kebab-case names; pointer: the process skill got its line.
const teamOk = (team) => !!team && typeof team === 'object' && !Array.isArray(team)
  && typeof team.preset === 'string' && KEBAB.test(team.preset)
  && Array.isArray(team.roles) && team.roles.every((r) => typeof r === 'string' && KEBAB.test(r))
  && (team.pointer === undefined || team.pointer === true);

// Exactly these keys: a misspelt one would otherwise pass and be silently ignored.
const shape = (o, keys) => !!o && typeof o === 'object' && !Array.isArray(o)
  && Object.keys(o).sort().join() === [...keys].sort().join();
// A task's link to its epic, which is always the directory above it.
const epicLinkOk = (epic) => shape(epic, ['slug']) && typeof epic.slug === 'string' && KEBAB.test(epic.slug);
// What a task of the epic gets from a source: its branch template, base, carry list, clone flag.
const taskDefaultsOk = (d) => shape(d, ['branch', 'base', 'carry', 'cloneNm'])
  && typeof d.branch === 'string' && typeof d.base === 'string'
  && Array.isArray(d.carry) && d.carry.every((c) => typeof c === 'string')
  && typeof d.cloneNm === 'boolean';

// An epic's context (`wsg context`): what its tasks may read when they touch the topic, listed in
// the <!-- wsg:epic-context --> block of the epic's and of every task's AGENTS.md. state.context is a
// list of items; the bodies live in <epic>/context/, their paths kept relative to the epic, so the
// epic's directory can move. A file: { id, type: "file", title, description, path: "context/<name>",
// bytes, sha256, binary, copied } — copied: wsg copied it in, so `wsg context remove` deletes it;
// false for one that was in context/ already and was only listed, which a removal only unlists. A
// note: { id, type: "note", title, description, path: "context/notes/<id>.md", bytes, sha256 }. A
// link: { id, type: "link", title, description, url }. bytes and sha256 as the body was written or
// listed: the index renders from the state alone, so an unchanged epic renders the same bytes, and a
// removal or a rewrite can tell a hand edit from what wsg wrote.
const CONTEXT = {
  // Every line of the index is paid on every request of every session of every task.
  textMax: 200,
  idMax: 64,
  fileWarn: 1024 * 1024,
  fileMax: 20 * 1024 * 1024,
  blockWarn: 2048,
  blockMax: 4096,
};
const CONTEXT_TYPES = ['file', 'note', 'link'];
// A title or a description: one line of at most CONTEXT.textMax characters, no control characters.
const oneLine = (s, empty = false) => typeof s === 'string' && (empty || s.trim() !== '') && s === s.trim()
  && [...s].length <= CONTEXT.textMax && !/[\x00-\x1f\x7f]/.test(s);
// The name a copied file keeps in context/: a plain file name, not hidden, not notes/ (the notes' own
// directory). '' when it may be used, else why not.
function contextNameProblem(name) {
  if (typeof name !== 'string' || !name || name.includes('/') || name === '.' || name === '..') return 'not a plain file name';
  if (name.startsWith('.')) return 'a hidden name';
  if (/[\x00-\x1f\x7f]/.test(name)) return 'a control character in the name';
  if (name.toLowerCase() === 'notes') return 'notes is the directory of the notes';
  // Claude Code may load a CLAUDE.md below the session's directory as instructions: a context file
  // is read on demand, never as rules.
  if (/^(claude|agents)(\.local|\.override)?\.md$/i.test(name)) return 'a name agents take for their instructions (CLAUDE.md, AGENTS.md, their .local and .override forms)';
  if (Buffer.byteLength(name) > 255) return 'a name longer than 255 bytes';
  return '';
}
const isUrl = (u) => typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u) && [...u].length <= 2048;
const contextIdOk = (id) => typeof id === 'string' && KEBAB.test(id) && id.length <= CONTEXT.idMax;

// Why an epic's context can't be used, or ''.
function contextProblem(items) {
  if (!Array.isArray(items)) return '"context" must be a list of items';
  const ids = new Set();
  const paths = new Set();
  for (const [i, x] of items.entries()) {
    const at = `context item ${x && typeof x === 'object' && typeof x.id === 'string' ? x.id : `#${i + 1}`}`;
    if (!x || typeof x !== 'object' || Array.isArray(x) || !CONTEXT_TYPES.includes(x.type)) return `${at}: "type" must be one of ${CONTEXT_TYPES.join(', ')}`;
    const keys = x.type === 'file' ? ['id', 'type', 'title', 'description', 'path', 'bytes', 'sha256', 'binary', 'copied']
      : x.type === 'note' ? ['id', 'type', 'title', 'description', 'path', 'bytes', 'sha256'] : ['id', 'type', 'title', 'description', 'url'];
    if (!shape(x, keys)) return `${at}: a ${x.type} has exactly ${keys.join(', ')}`;
    if (!contextIdOk(x.id)) return `${at}: "id" must be kebab-case, at most ${CONTEXT.idMax} characters`;
    if (ids.has(x.id)) return `${at}: the id is used twice`;
    ids.add(x.id);
    if (!oneLine(x.title)) return `${at}: "title" must be one line of at most ${CONTEXT.textMax} characters`;
    if (!oneLine(x.description, true)) return `${at}: "description" must be one line of at most ${CONTEXT.textMax} characters`;
    if (x.type === 'link') {
      if (!isUrl(x.url)) return `${at}: "url" must be an http or https URL`;
      continue;
    }
    if (!Number.isSafeInteger(x.bytes) || x.bytes < 0) return `${at}: "bytes" must be a whole number`;
    if (typeof x.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(x.sha256)) return `${at}: "sha256" must be 64 hex digits`;
    if (x.type === 'note' && x.path !== `context/notes/${x.id}.md`) return `${at}: a note's "path" is context/notes/${x.id}.md`;
    if (x.type === 'file') {
      if (typeof x.binary !== 'boolean') return `${at}: "binary" must be true or false`;
      if (typeof x.copied !== 'boolean') return `${at}: "copied" must be true or false`;
      if (typeof x.path !== 'string' || !x.path.startsWith('context/') || contextNameProblem(x.path.slice(8))) return `${at}: a file's "path" is context/<name>, a plain file name`;
    }
    if (paths.has(x.path.toLowerCase())) return `${at}: the path is used twice`;
    paths.add(x.path.toLowerCase());
  }
  return '';
}

// An epic's MCP servers (`wsg mcp`): rendered into <epic>/.mcp.json, which Claude Code finds from
// the epic and from every task in it, and enabled by name in each workspace's own
// .claude/settings.json (enabledMcpjsonServers); global servers the epic turns off are listed there
// as deniedMcpServers. state.mcp is { servers, disabled }. A server: { name, transport: "stdio",
// command, args, env, agents } or { name, transport: "http", url, bearerEnv, agents }; env is
// [{ name }] — the variable forwarded by reference, ${NAME} in .mcp.json — or [{ name, value }], a
// literal that is no secret (wsg mcp add refuses one for a secret-looking name); bearerEnv: the
// variable that holds an http server's token, sent as "Authorization: Bearer ${VAR}", or null.
// agents: the agents the server is for — only "claude" is rendered in this version. disabled:
// { claude: [names] }, any name Claude Code may know a server by (plugin:<plugin>:<server> too).
// Secrets never get into the state: only the names of the variables that hold them.
const MCP_AGENTS = ['claude', 'codex'];
const MCP = { nameMax: 64, deniedMax: 200 };
const MCP_TRANSPORTS = ['stdio', 'http'];
// A name Claude Code takes for a server of .mcp.json: letters, digits, - and _ (its tools are
// mcp__<name>__<tool>). A name with : is a plugin's server, never one of the epic's own.
const mcpNameOk = (n) => typeof n === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(n) && n.length <= MCP.nameMax;
// A name to deny: whatever a server may be called elsewhere (a plugin's, a connector's with spaces),
// one line without control characters.
const deniedNameOk = (n) => typeof n === 'string' && n !== '' && n === n.trim() && [...n].length <= MCP.deniedMax && !/[\x00-\x1f\x7f]/.test(n);
const envNameOk = (n) => typeof n === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && n.length <= 128;
// A command, an argument, a literal value: any text without control characters.
const plainText = (s) => typeof s === 'string' && !/[\x00-\x1f\x7f]/.test(s);

// Why an epic's MCP servers can't be used, or ''.
function mcpProblem(mcp) {
  if (!shape(mcp, ['servers', 'disabled'])) return '"mcp" must be { servers, disabled }';
  if (!Array.isArray(mcp.servers)) return '"mcp.servers" must be a list';
  const names = new Set();
  for (const [i, x] of mcp.servers.entries()) {
    const at = `mcp server ${x && typeof x === 'object' && typeof x.name === 'string' ? x.name : `#${i + 1}`}`;
    if (!x || typeof x !== 'object' || Array.isArray(x) || !MCP_TRANSPORTS.includes(x.transport)) return `${at}: "transport" must be one of ${MCP_TRANSPORTS.join(', ')}`;
    const keys = x.transport === 'stdio' ? ['name', 'transport', 'command', 'args', 'env', 'agents'] : ['name', 'transport', 'url', 'bearerEnv', 'agents'];
    if (!shape(x, keys)) return `${at}: a ${x.transport} server has exactly ${keys.join(', ')}`;
    if (!mcpNameOk(x.name)) return `${at}: "name" must be letters, digits, - and _, at most ${MCP.nameMax} characters`;
    if (names.has(x.name.toLowerCase())) return `${at}: the name is used twice`;
    names.add(x.name.toLowerCase());
    if (!Array.isArray(x.agents) || !x.agents.length || x.agents.some((a) => !MCP_AGENTS.includes(a)) || new Set(x.agents).size !== x.agents.length) {
      return `${at}: "agents" must be a list of ${MCP_AGENTS.join(', ')}, each once`;
    }
    if (x.transport === 'stdio') {
      if (!plainText(x.command) || !x.command.trim()) return `${at}: "command" must be one line of text`;
      if (!Array.isArray(x.args) || !x.args.every(plainText)) return `${at}: "args" must be a list of one-line texts`;
      if (!Array.isArray(x.env)) return `${at}: "env" must be a list`;
      const envs = new Set();
      for (const e of x.env) {
        const ok = (shape(e, ['name']) || (shape(e, ['name', 'value']) && plainText(e.value))) && envNameOk(e.name);
        if (!ok) return `${at}: each "env" entry is { name } or { name, value }, the name a variable's (A-Z, 0-9, _)`;
        if (envs.has(e.name)) return `${at}: the variable ${e.name} is listed twice`;
        envs.add(e.name);
      }
    } else {
      if (!isUrl(x.url)) return `${at}: "url" must be an http or https URL`;
      if (x.bearerEnv !== null && !envNameOk(x.bearerEnv)) return `${at}: "bearerEnv" must be a variable's name or null`;
    }
  }
  const d = mcp.disabled;
  if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some((k) => !MCP_AGENTS.includes(k))) return `"mcp.disabled" must be { ${MCP_AGENTS.join(', ')} } lists of names`;
  for (const [agent, list] of Object.entries(d)) {
    if (!Array.isArray(list) || !list.every(deniedNameOk) || new Set(list).size !== list.length) return `"mcp.disabled.${agent}" must be a list of names, each once`;
  }
  return '';
}

// What a render of the MCP servers put into the workspace, so the next one takes out exactly that
// and keeps the owner's own entries: { enabled, denied } — names in enabledMcpjsonServers and
// deniedMcpServers of .claude/settings.json; an epic also mcpJson — the servers of its .mcp.json.
// Written by every render (generate.computeRender), never by hand; '' when it can be used.
function mcpRenderedProblem(r, kind) {
  const keys = kind === 'epic' ? ['mcpJson', 'enabled', 'denied'] : ['enabled', 'denied'];
  if (!shape(r, keys)) return `"mcpRendered" must be { ${keys.join(', ')} }`;
  for (const k of keys) if (!Array.isArray(r[k]) || !r[k].every(deniedNameOk)) return `"mcpRendered.${k}" must be a list of names`;
  return '';
}

// Why the state can't be used, or ''.
function stateProblem(state) {
  if (!state || typeof state !== 'object' || !KINDS.includes(state.kind)) return `"kind" must be one of ${KINDS.join(', ')}`;
  const version = stateVersion(state.kind, state.archive !== undefined);
  if (state.version !== version || !Array.isArray(state.sources)) return `expected version ${version} with a sources list`;
  if (state.epic !== undefined && (state.kind !== 'task' || !epicLinkOk(state.epic))) {
    return '"epic" belongs only to a task, as { "slug": <kebab-case> }';
  }
  if (state.context !== undefined) {
    if (state.kind !== 'epic') return '"context" belongs only to an epic';
    const bad = contextProblem(state.context);
    if (bad) return bad;
  }
  if (state.mcp !== undefined) {
    if (state.kind !== 'epic') return '"mcp" belongs only to an epic';
    const bad = mcpProblem(state.mcp);
    if (bad) return bad;
  }
  if (state.mcpRendered !== undefined) {
    const bad = mcpRenderedProblem(state.mcpRendered, state.kind);
    if (bad) return bad;
  }
  // `wsg new --no-code`: a task without code. Only true, only for a task: a hand edit that says
  // false or puts it on an epic would otherwise read as something it is not.
  // `wsg reorder`: the order of the epic's tasks (byTaskOrder). A slug no task has any more is allowed:
  // it is ignored, and the next reorder drops it.
  if (state.taskOrder !== undefined) {
    if (state.kind !== 'epic') return '"taskOrder" belongs only to an epic';
    if (!Array.isArray(state.taskOrder) || !state.taskOrder.every((x) => typeof x === 'string' && KEBAB.test(x)) || new Set(state.taskOrder).size !== state.taskOrder.length) {
      return '"taskOrder" must be a list of task slugs, each once';
    }
  }
  if (state.noCode !== undefined && (state.kind !== 'task' || state.noCode !== true)) return '"noCode" belongs only to a task, as true';
  if (state.spec !== undefined && (state.kind !== 'task' || state.spec !== true)) return '"spec" belongs only to a task, as true';
  if (state.ticket !== undefined && (state.epic === undefined || typeof state.ticket !== 'string' || !state.ticket.trim())) {
    return '"ticket" belongs only to a task of an epic, as a non-empty string';
  }
  // A reference is read, never changed: a task gets no branch of it.
  const i = state.sources.findIndex((s) => s && s.task !== undefined
    && (state.kind !== 'epic' || s.reference === true || !taskDefaultsOk(s.task)));
  if (i !== -1) {
    const name = state.sources[i].name || `#${i + 1}`;
    return `source ${name}: "task" belongs only to an epic source that is not a reference, as { branch, base, carry, cloneNm }`;
  }
  // A source a task took from its epic's (S.fromEpic).
  const j = state.sources.findIndex((s) => s && s.from !== undefined && (state.epic === undefined || s.from !== 'epic'));
  if (j !== -1) return `source ${state.sources[j].name || `#${j + 1}`}: "from" belongs only to a source of a task of an epic, as "epic"`;
  if (state.archive !== undefined) return archiveProblem(state);
  return '';
}

// Why the "archive" record of a state can't be used, or '' (see STATE_FILE). A record that doesn't
// read makes the state unreadable: wsg unarchive could not bring the sources back from it.
function archiveProblem(state) {
  const a = state.archive;
  const epic = state.kind === 'epic';
  const keys = epic ? ['date', 'sources', 'cascade'] : ['date', 'previous', 'sources'];
  if (!shape(a, keys) && (epic || !shape(a, [...keys, 'byEpic']))) {
    return `"archive" of ${epic ? 'an epic' : `a ${state.kind}`} has exactly ${keys.join(', ')}${epic ? '' : ' (and byEpic)'}`;
  }
  if (!isDate(a.date)) return '"archive.date" must be a date YYYY-MM-DD';
  if (!Array.isArray(a.sources) || !a.sources.every((s) => isSource(s) && typeof s.name === 'string' && s.name && typeof s.path === 'string' && s.path)) {
    return '"archive.sources" must be a list of source entries, each with a name and a path';
  }
  if (epic) {
    if (!Array.isArray(a.cascade) || !a.cascade.every((x) => typeof x === 'string' && KEBAB.test(x)) || new Set(a.cascade).size !== a.cascade.length) {
      return '"archive.cascade" must be a list of task slugs, each once';
    }
    return '';
  }
  const p = a.previous;
  if (!shape(p, ['status', 'closed']) || typeof p.status !== 'string' || !p.status || p.status === 'archived' || (p.closed !== null && !isDate(p.closed))) {
    return '"archive.previous" must be { status, closed }: the status before, and the date it was closed or null';
  }
  if (a.byEpic !== undefined && a.byEpic !== true) return '"archive.byEpic" must be true when given';
  return '';
}

// What is off in a record that reads, as warnings: a hand edit or a run that stopped half-way. Never
// a reason to refuse the state: wsg unarchive must still bring the sources back from it.
function archiveWarnings(state) {
  if (!state || state.archive === undefined) return [];
  const out = [];
  if (state.kind !== 'epic' && state.status !== 'archived') out.push('"archive" goes only with "status": "archived": wsg unarchive puts back the status recorded before');
  if (Array.isArray(state.sources) && state.sources.length) {
    out.push('archived, but "sources" is not empty (an archive or an unarchive stopped half-way): run wsg archive or wsg unarchive again');
  }
  return out;
}

// What is wrong with the status of a state that reads, as a warning, or null. Never a reason to
// refuse the state (see STATE_FILE).
function statusProblem(state) {
  if (state.kind === 'epic') {
    return state.status !== undefined || state.closed !== undefined
      ? '"status" and "closed" belong only to a task or a process, not to an epic: ignored' : null;
  }
  if (state.status !== undefined && !KNOWN_STATUSES.includes(state.status)) {
    return `"status" ${JSON.stringify(state.status)} is not one of ${KNOWN_STATUSES.join(', ')}: this wsg doesn't know it`;
  }
  if (state.status === 'archived' && state.archive === undefined) {
    return '"status" "archived" without an "archive" record: a half archive, its sources are not recorded — set a status with wsg status, then attach what is missing';
  }
  if (state.closed !== undefined && (state.status !== 'done' || !isDate(state.closed))) {
    return '"closed" goes only with "status": "done", as a date YYYY-MM-DD';
  }
  return null;
}

function readState(ws) {
  const file = path.join(ws, STATE_FILE);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(t('workspace.stateInvalid', { file, msg: e.message }));
  }
  const problem = stateProblem(state);
  if (problem) throw new Error(t('workspace.stateInvalid', { file, msg: problem }));
  // `wsg team` writes it, and every render pastes its roles into AGENTS.md and team/workflow.md:
  // a hand edit that breaks it refuses every command, not only `wsg team`.
  if (state.team !== undefined && !teamOk(state.team)) throw new Error(t('team.stateInvalid', { file }));
  return state;
}

const stateJson = (state) => `${JSON.stringify(state, null, 2)}\n`;

// The state of the directory given as an epic; anything else — no state, another kind — is
// refused with one message. A state that doesn't read keeps its own error.
function epicState(epicWs) {
  if (!hasState(epicWs)) throw new Error(t('workspace.notEpic', { ws: epicWs }));
  const state = readState(epicWs);
  if (state.kind !== 'epic') throw new Error(t('workspace.notEpic', { ws: epicWs }));
  return state;
}

// The directories a session in the workspace reads besides its own: the linked sources, references
// included, in their order. settings.json lists them as additionalDirectories (generate.computeRender,
// templates.settingsJson), so the two can't drift. A task's epic directory is not here: it is the
// parent of the workspace, see epicOf. An entry that is not a source object (a hand edit: null, a
// string) is skipped, so one broken entry can't take wsg list down; wsg list reports it.
const isSource = (s) => !!s && typeof s === 'object' && !Array.isArray(s);
const extraDirs = (state) => state.sources.filter((s) => isSource(s) && s.mode === 'link' && typeof s.path === 'string').map((s) => s.path);

// The epic a task belongs to: the directory above it, or null for a task outside an epic.
const epicOf = (ws, state) => (state && state.epic ? path.dirname(path.resolve(ws)) : null);

// Items in the order of an epic's tasks (its state's "taskOrder", set by wsg reorder): the ones it
// names first, as it names them, then the rest by name — a task made later appends, a slug it names
// that no task has any more is ignored. nameOf: the task's directory name of an item.
function byTaskOrder(items, taskOrder, nameOf = (x) => x) {
  const at = new Map((Array.isArray(taskOrder) ? taskOrder : []).map((s, i) => [s, i]));
  const rank = (x) => (at.has(nameOf(x)) ? at.get(nameOf(x)) : at.size);
  return [...items].sort((x, y) => rank(x) - rank(y) || (nameOf(x) < nameOf(y) ? -1 : nameOf(x) > nameOf(y) ? 1 : 0));
}

// The epic's tasks: directories right inside it whose state links them to an epic. Symlinked
// directories are skipped on purpose: those are the links to the epic's sources. A task whose
// state doesn't read is left out — one broken task must not break the epic's commands.
// Returns [{ ws, state, mismatch }] in the epic's order (byTaskOrder); mismatch: the task names
// another epic (moved or copied by hand), for check to warn about.
function childrenOf(epicWs) {
  const { slug, taskOrder } = epicState(epicWs);
  const out = [];
  const entries = byTaskOrder(fs.readdirSync(epicWs, { withFileTypes: true }).filter((e) => e.isDirectory()), taskOrder, (e) => e.name);
  for (const e of entries) {
    const ws = path.join(epicWs, e.name);
    if (!hasState(ws)) continue;
    let state;
    try { state = readState(ws); } catch { continue; }
    if (state.epic) out.push({ ws, state, mismatch: state.epic.slug !== slug });
  }
  return out;
}

// The `## For the epic` section of a task's notes.md holds what the task stages for its epic; the
// epic's closing moves the merged entries out of it into `## Notes`. So entries still in it mean
// "not merged yet". An entry is any non-blank line of the section outside an HTML comment (the
// template's own hint is one). The section runs to the next heading of level 1 or 2; a ### inside
// it counts as an entry. text: the notes as read; true when it has entries.
function forEpicEntries(text) {
  const lines = String(text).replace(/<!--[\s\S]*?(-->|$)/g, (c) => c.replace(/[^\n]/g, '')).split(/\r?\n/);
  const start = lines.findIndex((l) => /^## For the epic\s*$/.test(l.trimEnd()));
  if (start < 0) return false;
  for (let i = start + 1; i < lines.length && !/^#{1,2}\s/.test(lines[i]); i++) {
    if (lines[i].trim()) return true;
  }
  return false;
}

// Whether a task of an epic has entries in `## For the epic` that its epic has not merged: true or
// false; null for anything else (a task outside an epic, a process, an epic). A notes.md that is
// missing or can't be read has none. One file read, no git: wsg list calls it for every task.
function forEpicPending(ws, state) {
  if (!state || state.kind !== 'task' || !state.epic) return null;
  let text;
  try { text = fs.readFileSync(path.join(ws, 'notes.md'), 'utf8'); } catch { return false; }
  return forEpicEntries(text);
}

// The checkboxes of a checklist (a task's checklist.md): { done, total }. A checkbox is a list item
// — `-`, `*`, `+`, or `1.` / `1)`, at any indent — that starts with `[ ]`, or `[x]` / `[X]` (the
// Cyrillic х and Х too, typed on a Russian layout) for a done one. A line inside an HTML comment or a
// fenced code block (at any indent) is no item, and neither is one whose text starts with FILL IN:
// the template's placeholder until the setup writes the items. An inline code span hides what is in
// it: `<!--` there opens no comment. fillIn: such a placeholder line is there.
function checklistScan(text) {
  const out = { done: 0, total: 0, fillIn: false };
  let fence = null;
  let comment = false;
  for (const raw of String(text).split(/\r?\n/)) {
    if (fence) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(raw);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    // Code spans masked, their length kept: what they hold is neither a comment nor a fence.
    let line = raw.replace(/(`+)[^`]+?\1/g, (m) => '`'.repeat(m.length));
    if (comment) {
      const end = line.indexOf('-->');
      if (end < 0) continue;
      line = line.slice(end + 3);
      comment = false;
    }
    line = line.replace(/<!--[\s\S]*?-->/g, '');
    const open = line.indexOf('<!--');
    if (open >= 0) {
      line = line.slice(0, open);
      comment = true;
    }
    const f = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (f && line.trim() === raw.trim()) {
      fence = f[1];
      continue;
    }
    const m = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\[([ xXхХ])\](?=\s|$)(.*)$/.exec(line);
    if (!m) continue;
    if (/^\s*FILL IN\b/.test(m[2])) {
      out.fillIn = true;
      continue;
    }
    out.total++;
    if (m[1] !== ' ') out.done++;
  }
  return out;
}

// A line as checklistScan and lib/reorder.js read it: what is outside HTML comments, each code span
// masked with backticks of its length — a run of n backticks up to the next run of exactly n, so
// `` a`b `` is one span. Read left to right: inside a comment nothing is a code span, and a backtick
// there hides no `-->`. comment: whether one is open where the line starts; returns { text, comment } — comment:
// whether one is open where it ends.
function visibleText(raw, comment) {
  let text = '';
  let i = 0;
  while (i < raw.length) {
    if (comment) {
      const end = raw.indexOf('-->', i);
      if (end < 0) return { text, comment: true };
      i = end + 3;
      comment = false;
    } else if (raw.startsWith('<!--', i)) {
      i += 4;
      comment = true;
    } else if (raw[i] === '`') {
      const run = (at) => { let n = 0; while (raw[at + n] === '`') n++; return n; };
      const n = run(i);
      let j = i + n;
      let close = -1;
      while (j < raw.length) {
        if (raw[j] !== '`') { j++; continue; }
        const m = run(j);
        if (m === n) { close = j; break; }
        j += m;
      }
      const to = close < 0 ? i + n : close + n;
      text += '`'.repeat(to - i);
      i = to;
    } else {
      text += raw[i];
      i++;
    }
  }
  return { text, comment };
}
const checklistCounts = (text) => {
  const { done, total } = checklistScan(text);
  return { done, total };
};

// A task's checklist.md as counted: { done, total, fillIn }, or null — not a task, or no file (a task
// made before wsg 0.8 has none, and none is added). A file there that can't be read (no permission, a
// directory) is { unreadable: <why> }: said by wsg check and wsg list, never taken for a missing one.
// One file read: wsg list calls it for every task.
function checklistOf(ws, state) {
  if (!state || state.kind !== 'task') return null;
  let text;
  try {
    text = fs.readFileSync(path.join(ws, 'checklist.md'), 'utf8');
  } catch (e) {
    return e && e.code === 'ENOENT' ? null : { unreadable: (e && e.code) || String(e) };
  }
  return checklistScan(text);
}

module.exports = {
  checklistScan, checklistCounts, checklistOf, visibleText,
  CONTEXT, CONTEXT_TYPES, contextNameProblem, contextIdOk, isUrl, oneLine,
  MCP, MCP_AGENTS, MCP_TRANSPORTS, mcpNameOk, deniedNameOk, envNameOk, plainText, mcpProblem,
  isDate, isSource, statusMarker, markerOf, isArchived, archivedOn, isFrozen, forEpicEntries, forEpicPending,
  archiveWarnings, KEBAB, RESERVED, KINDS, STATE_FILE, STATE_VERSION, EPIC_STATE_VERSION, ARCHIVED_STATE_VERSION, stateVersion, STATUSES, KNOWN_STATUSES, statusOf, statusProblem,
  slugError, skillError, wsPath, childPath, assertSafe, find, hasState, isLegacy, stateProblem, readState, stateJson, epicState, epicOf, extraDirs, childrenOf, byTaskOrder,
};
