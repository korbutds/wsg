'use strict';

// `wsg mcp`: an epic's MCP servers for Claude Code. The epic's state.mcp (lib/workspace.js) is the
// source of truth; every render turns it into
// - <epic>/.mcp.json: the epic's servers, next to whatever the owner keeps there. Claude Code finds
//   it from the epic and from every task inside it (a project's .mcp.json is looked up in the
//   directories above too);
// - .claude/settings.json of the epic and of each of its tasks: enabledMcpjsonServers names the
//   epic's servers (a parent's settings.json does not apply in a task, so each workspace has its
//   own), deniedMcpServers the global servers the epic turns off, by name.
// Each workspace keeps in its state what the render put there (state.mcpRendered): a server removed
// or enabled again takes out exactly wsg's entries, the owner's own ones stay. Secrets only by
// reference: ${VAR} in .mcp.json, which Claude Code expands from its environment.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const W = require('./workspace');
const { t } = require('./i18n');

const MCP_JSON = '.mcp.json';
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// What an epic's state renders for Claude Code: { servers, enabled, denied } — the servers for
// claude, their names, the names it turns off.
function claudeWanted(mcp) {
  const servers = mcp ? mcp.servers.filter((s) => s.agents.includes('claude')) : [];
  return { servers, enabled: servers.map((s) => s.name), denied: mcp && mcp.disabled.claude ? [...mcp.disabled.claude] : [] };
}

// A server as .mcp.json has it: the variables by reference, ${NAME}, which Claude Code expands.
function entryOf(s) {
  if (s.transport === 'http') {
    return { type: 'http', url: s.url, ...(s.bearerEnv ? { headers: { Authorization: `Bearer \${${s.bearerEnv}}` } } : {}) };
  }
  const env = {};
  for (const e of s.env) env[e.name] = hasOwn(e, 'value') ? e.value : `\${${e.name}}`;
  return { type: 'stdio', command: s.command, args: [...s.args], ...(s.env.length ? { env } : {}) };
}

// The variables a server reads from the environment it is started in: the ones forwarded by
// reference and the bearer token's.
const envRefs = (s) => (s.transport === 'http' ? (s.bearerEnv ? [s.bearerEnv] : []) : s.env.filter((e) => !hasOwn(e, 'value')).map((e) => e.name));

// The epic's .mcp.json as the render leaves it. text: the file as it is, null for none; servers: the
// epic's servers for claude; owned: the names the last render put there. A name the owner has there
// already is refused, never overwritten. Returns { obj, remove, changed, owned } — obj null when the
// file stays as it is or goes (remove). Throws on a file that is no JSON object.
function renderMcpJson(text, servers, owned, file) {
  if (text === null && !servers.length) return { obj: null, remove: false, changed: false, owned: [] };
  let was = {};
  if (text !== null) {
    try {
      was = JSON.parse(text);
    } catch (e) {
      throw new Error(t('mcp.jsonInvalid', { file, msg: e.message }));
    }
    if (!was || typeof was !== 'object' || Array.isArray(was)) throw new Error(t('mcp.jsonInvalid', { file, msg: 'not an object' }));
    if (was.mcpServers !== undefined && (!was.mcpServers || typeof was.mcpServers !== 'object' || Array.isArray(was.mcpServers))) {
      throw new Error(t('mcp.jsonInvalid', { file, msg: '"mcpServers" is not an object' }));
    }
  }
  const had = was.mcpServers || {};
  const names = servers.map((s) => s.name);
  const next = {};
  for (const [k, v] of Object.entries(had)) {
    if (owned.includes(k) && !names.includes(k)) continue; // wsg's, gone from the state
    next[k] = v;
  }
  for (const s of servers) {
    if (hasOwn(had, s.name) && !owned.includes(s.name)) throw new Error(t('mcp.ownerEntry', { name: s.name, file }));
    next[s.name] = entryOf(s);
  }
  // The other keys of the file stay where they are; mcpServers keeps its place, or comes last.
  const obj = text === null || was.mcpServers === undefined ? { ...was, mcpServers: next } : Object.fromEntries(Object.entries(was).map(([k, v]) => [k, k === 'mcpServers' ? next : v]));
  // Nothing left but an empty mcpServers that wsg's entries were the last of: the file goes.
  if (!Object.keys(next).length && Object.keys(obj).length === 1 && owned.length) {
    return { obj: null, remove: text !== null, changed: text !== null, owned: [] };
  }
  return { obj, remove: false, changed: text === null || JSON.stringify(obj) !== JSON.stringify(was), owned: names };
}

// One list of settings.json, merged: wsg's names first, then the owner's entries — those the last
// render did not put there. A name the owner lists already is the owner's: kept as it is, never
// taken as wsg's. key: the object key of an entry (deniedMcpServers: serverName), or null for a list
// of names. Returns { list, owned, changed, drop } — drop: the key goes (wsg's entries were all it had).
function mergeList(had, wanted, owned, key, file, setting) {
  if (had !== undefined && !Array.isArray(had)) {
    if (!wanted.length && !owned.length) return { list: had, owned: [], changed: false, drop: false };
    throw new Error(t('mcp.settingsInvalid', { file, key: setting }));
  }
  const nameOf = (x) => (key ? (x && typeof x === 'object' && !Array.isArray(x) ? x[key] : undefined) : x);
  const owner = (had || []).filter((x) => !(owned.includes(nameOf(x)) && (!key || Object.keys(x).length === 1)));
  const ownerNames = new Set(owner.map(nameOf));
  const mine = wanted.filter((n) => !ownerNames.has(n));
  const list = [...mine.map((n) => (key ? { [key]: n } : n)), ...owner];
  const drop = !list.length && had !== undefined && owned.length > 0;
  const changed = drop || (had === undefined ? list.length > 0 : JSON.stringify(list) !== JSON.stringify(had));
  return { list, owned: mine, changed, drop };
}

// The MCP keys of a workspace's settings.json, merged in place. j: the settings, parsed; wanted:
// { enabled, denied }; prev: the state's mcpRendered (or none). Returns { changed, enabled, denied }:
// the names wsg owns now.
function mergeSettings(j, wanted, prev, file) {
  const p = prev || { enabled: [], denied: [] };
  const en = mergeList(j.enabledMcpjsonServers, wanted.enabled, p.enabled, null, file, 'enabledMcpjsonServers');
  const de = mergeList(j.deniedMcpServers, wanted.denied, p.denied, 'serverName', file, 'deniedMcpServers');
  for (const [k, r] of [['enabledMcpjsonServers', en], ['deniedMcpServers', de]]) {
    if (!r.changed) continue;
    if (r.drop) delete j[k];
    else j[k] = r.list;
  }
  return { changed: en.changed || de.changed, enabled: en.owned, denied: de.owned };
}

// The servers of the user-scope Claude Code config ($CLAUDE_CONFIG_DIR/.claude.json, else
// ~/.claude.json): [{ name, transport }] — the names and transports only, never a command, an
// argument, a URL or a value. Plugin servers and claude.ai connectors are not in that file, so not
// here. A file that is missing or doesn't read gives [].
function globalClaude(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR || env.HOME || os.homedir();
  let servers;
  try {
    servers = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')).mcpServers;
  } catch {
    return [];
  }
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
  return Object.keys(servers).sort().map((name) => {
    const v = servers[name];
    const type = v && typeof v === 'object' && typeof v.type === 'string' ? v.type : '';
    return { name, transport: ['stdio', 'http', 'sse'].includes(type) ? type : v && typeof v === 'object' && v.url ? 'http' : 'stdio' };
  });
}

// --- `wsg mcp add|remove|disable|enable|list` (bin/cli.js). Each write plans first — nothing
// touched, every refusal collected — then writes the epic in one transaction (generate.guarded),
// then the caller refreshes the epic's tasks (generate.refreshEpicTasks), as `wsg context` does.
// lib/context.js and lib/generate.js are required where they are used: generate requires this file.

// A name that says it holds a secret — the whole name or a part between _ - . is one of the words
// checked in URLs (lib/context.js): GITHUB_TOKEN, API_KEY, DB_PASSWORD; not MONKEY or AUTHOR.
function secretName(name) {
  const { SECRET_WORDS } = require('./context');
  const lower = String(name).toLowerCase();
  return SECRET_WORDS.has(lower) || lower.split(/[_\-.]+/).some((part) => SECRET_WORDS.has(part));
}
// A value that is exactly a reference to one variable, ${NAME}: no secret is in it. Not one with a
// default (${NAME:-value}) or text around it — that text may be the secret.
const byReference = (v) => typeof v === 'string' && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v);
// A URL that carries a secret: user info, or a secret-named key in the query or the fragment whose
// value is not exactly a reference.
function urlCarriesSecret(u) {
  if (u.username || u.password) return true;
  const pairs = [...u.searchParams];
  if (u.hash.includes('=')) pairs.push(...new URLSearchParams(u.hash.slice(1)));
  return pairs.some(([k, v]) => secretName(k) && !byReference(v));
}
// What a refusal may repeat of a URL: its scheme and host, never its path, query or user info.
function shownUrl(given) {
  try {
    const u = new URL(given);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '…';
  }
}
// What a refusal may repeat of a name that is not a variable's: its first three characters only — a
// token pasted in its place stays out of the message.
const shownName = (name) => `${[...String(name)].slice(0, 3).join('')}…`;

// --env A,B=literal as given: [{ name } | { name, value }], or the refusals. A literal for a name that
// says it is a secret is refused: it would be written into .mcp.json, which every task's agent can
// read — forward the variable by its name instead.
function parseEnv(given, server) {
  const env = [];
  const errors = [];
  const parts = String(given).split(',').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) errors.push(t('cli.needsValue', { arg: '--env' }));
  for (const part of parts) {
    const eq = part.indexOf('=');
    const name = eq < 0 ? part : part.slice(0, eq);
    if (!W.envNameOk(name)) { errors.push(t('mcp.badEnvName', { name: shownName(name) })); continue; }
    if (env.some((e) => e.name === name)) { errors.push(t('mcp.envTwice', { name })); continue; }
    if (eq < 0) { env.push({ name }); continue; }
    const value = part.slice(eq + 1);
    if (!W.plainText(value)) { errors.push(t('mcp.badEnvValue', { name })); continue; }
    if (secretName(name) && !byReference(value)) { errors.push(t('mcp.secretLiteral', { name, server })); continue; }
    env.push({ name, value });
  }
  return { env, errors };
}

// Arguments that look like they carry a secret: a flag named like one (--token, --api-key=…) whose
// value — after = or the next argument — is not exactly ${VAR}, NAME=… with such a name, a URL with
// one in it, an Authorization header. Only warned about, by position and flag name — the value is
// never repeated: it would land in the envelope too.
function argWarnings(server, args) {
  const out = [];
  args.forEach((a, i) => {
    if (byReference(a)) return;
    const n = i + 1;
    if (/^--?[A-Za-z]/.test(a)) {
      const eq = a.indexOf('=');
      const flag = eq < 0 ? a : a.slice(0, eq);
      if (!secretName(flag.replace(/^-+/, ''))) return;
      if (byReference(eq < 0 ? args[i + 1] : a.slice(eq + 1))) return;
      out.push(t('mcp.argSecret', { server, n, what: flag }));
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
      const key = a.slice(0, a.indexOf('='));
      if (secretName(key) && !byReference(a.slice(a.indexOf('=') + 1))) out.push(t('mcp.argSecret', { server, n, what: `${key}=…` }));
    } else if (/^https?:\/\//i.test(a)) {
      let u = null;
      try { u = new URL(a); } catch { /* not a URL after all */ }
      if (u && urlCarriesSecret(u)) out.push(t('mcp.argSecret', { server, n, what: 'URL' }));
    } else if (/^(authorization:|bearer |basic )/i.test(a)) {
      const rest = a.replace(/^authorization:\s*/i, '').replace(/^(bearer|basic)\s+/i, '').trim();
      if (!byReference(rest)) out.push(t('mcp.argSecret', { server, n, what: a.split(/[: ]/)[0] }));
    }
  });
  return out;
}

// A server as --json gives it: every key always there, null or [] where it does not apply; the
// variables by name only, never a literal's value. command, args and url are what the owner gave:
// a token put there by hand is the owner's (wsg mcp add warns about it).
function serverResult(s) {
  if (!s) return null;
  const stdio = s.transport === 'stdio';
  return {
    name: s.name,
    transport: s.transport,
    command: stdio ? s.command : null,
    args: stdio ? [...s.args] : [],
    url: stdio ? null : s.url,
    env: stdio ? s.env.map((e) => e.name) : [],
    bearerEnv: stdio ? null : s.bearerEnv,
    agents: [...s.agents],
  };
}

const emptyMcp = () => ({ servers: [], disabled: { claude: [] } });
const mcpOf = (state) => state.mcp || emptyMcp();
// The state with these servers and names: no mcp key once both are empty.
function withMcp(state, mcp) {
  const { mcp: _was, ...rest } = state;
  const empty = !mcp.servers.length && Object.values(mcp.disabled).every((l) => !l.length);
  if (empty) return rest;
  return state.mcp ? { ...state, mcp } : { ...rest, mcp };
}

// The variables the epic's servers read that this environment has no value for: [names].
function missingEnv(mcp, env = process.env) {
  const names = new Set(mcp.servers.flatMap(envRefs));
  return [...names].filter((n) => !env[n]).sort();
}

// `wsg mcp list`: { workspace, servers, disabled, global, missingEnv }.
function listResult(epicWs, state, env = process.env) {
  const mcp = mcpOf(state);
  return {
    workspace: epicWs,
    servers: mcp.servers.map(serverResult),
    disabled: { claude: [...(mcp.disabled.claude || [])] },
    global: { claude: globalClaude(env) },
    missingEnv: missingEnv(mcp, env),
  };
}

// A new plan: next — the epic's state after it; server — the server added or removed (null for a
// name turned off or on); changed — whether the state changes at all; files — paths relative to the
// epic that the render changes.
const newPlan = (state, name) => ({ state, name, next: null, server: null, changed: false, files: [], settingsChanged: false, errors: [], warnings: [] });

// The epic rendered from the new state, with nothing written: a .mcp.json entry of the owner's by the
// same name, a broken file, a list in settings.json that is no list refuse here.
function finish(epicWs, plan) {
  if (plan.errors.length) return plan;
  plan.changed = JSON.stringify(plan.next) !== JSON.stringify(plan.state);
  try {
    const rendered = require('./generate').computeRender(epicWs, plan.next, null);
    plan.warnings.push(...rendered.warnings);
    plan.files = require('./generate').changedFiles(rendered);
    plan.settingsChanged = rendered.settingsChanged;
  } catch (e) {
    plan.errors.push(e.message);
  }
  return plan;
}

const findServer = (mcp, name) => mcp.servers.find((s) => s.name.toLowerCase() === String(name).toLowerCase());

// `wsg mcp add <name> [--env A,B=lit] -- <command> [args…]` or `wsg mcp add <name> --url URL
// [--bearer-env VAR]`. o: { argv: [command, …args], env, url, bearerEnv, global } — global: the
// user-scope servers (globalClaude), for the warning about a name that hides one.
function planAdd(epicWs, state, name, o = {}) {
  const plan = newPlan(state, name);
  const mcp = mcpOf(state);
  const argv = o.argv || [];
  if (!W.mcpNameOk(name)) plan.errors.push(t('mcp.badName', { name, max: W.MCP.nameMax }));
  else {
    const had = findServer(mcp, name);
    if (had) plan.errors.push(t('mcp.exists', { name: had.name }));
    if ((mcp.disabled.claude || []).includes(name)) plan.errors.push(t('mcp.nameDisabled', { name }));
  }
  let server = null;
  if (o.url !== undefined && argv.length) plan.errors.push(t('mcp.urlAndCommand'));
  else if (o.url === undefined && !argv.length) plan.errors.push(t('mcp.needCommand', { name }));
  else if (o.url !== undefined) {
    if (o.env !== undefined) plan.errors.push(t('mcp.envForStdio'));
    if (!W.isUrl(o.url)) plan.errors.push(t('mcp.badUrl', { url: shownUrl(o.url) }));
    else {
      let u = null;
      try { u = new URL(o.url); } catch { /* isUrl took it; new URL did not */ }
      if (!u) plan.errors.push(t('mcp.badUrl', { url: shownUrl(o.url) }));
      else if (urlCarriesSecret(u)) plan.warnings.push(t('mcp.urlSecret', { server: name }));
    }
    if (o.bearerEnv !== undefined && !W.envNameOk(o.bearerEnv)) plan.errors.push(t('mcp.badEnvName', { name: shownName(o.bearerEnv) }));
    server = { name, transport: 'http', url: o.url, bearerEnv: o.bearerEnv === undefined ? null : o.bearerEnv, agents: ['claude'] };
  } else {
    if (o.bearerEnv !== undefined) plan.errors.push(t('mcp.bearerForHttp'));
    const [command, ...args] = argv;
    if (!W.plainText(command) || !command.trim()) plan.errors.push(t('mcp.badCommand'));
    args.forEach((a, i) => { if (!W.plainText(a)) plan.errors.push(t('mcp.badArg', { n: i + 1 })); });
    const env = o.env === undefined ? { env: [], errors: [] } : parseEnv(o.env, name);
    plan.errors.push(...env.errors);
    if (W.plainText(command)) plan.warnings.push(...argWarnings(name, args));
    server = { name, transport: 'stdio', command, args, env: env.env, agents: ['claude'] };
  }
  if (plan.errors.length) return plan;
  if ((o.global || []).some((g) => g.name === name)) plan.warnings.push(t('mcp.shadowsGlobal', { name }));
  plan.server = server;
  plan.next = withMcp(state, { ...mcp, servers: [...mcp.servers, server] });
  return finish(epicWs, plan);
}

// `wsg mcp remove <name>`: the server out of the state, its entries out of .mcp.json and the settings.
function planRemove(epicWs, state, name) {
  const plan = newPlan(state, name);
  const mcp = mcpOf(state);
  const had = findServer(mcp, name);
  if (!had) {
    plan.errors.push(t('mcp.unknown', { name, list: mcp.servers.map((s) => s.name).join(', ') || '—' }));
    return plan;
  }
  plan.name = had.name;
  plan.server = had;
  plan.next = withMcp(state, { ...mcp, servers: mcp.servers.filter((s) => s !== had) });
  return finish(epicWs, plan);
}

// `wsg mcp disable <name>` / `wsg mcp enable <name>`: a global server turned off in the epic and its
// tasks (deniedMcpServers), or on again. Any name Claude Code may know a server by — a plugin's
// plugin:<plugin>:<server> too; one the user-scope config does not list is a warning (a typo, or a
// plugin's or connector's server, which that file does not list). The epic's own server is refused:
// wsg mcp remove takes it out. Turning off what is off, or on what is on, changes nothing.
function planToggle(epicWs, state, name, off, o = {}) {
  const plan = newPlan(state, name);
  const mcp = mcpOf(state);
  if (!W.deniedNameOk(name)) {
    plan.errors.push(t('mcp.badDeniedName', { name: JSON.stringify(name), max: W.MCP.deniedMax }));
    return plan;
  }
  const list = mcp.disabled.claude || [];
  if (off) {
    const own = findServer(mcp, name);
    if (own) {
      plan.errors.push(t('mcp.disableOwn', { name: own.name }));
      return plan;
    }
    if (list.includes(name)) plan.warnings.push(t('mcp.alreadyDisabled', { name }));
    else if (!name.includes(':') && !(o.global || []).some((g) => g.name === name)) plan.warnings.push(t('mcp.notGlobal', { name }));
  } else if (!list.includes(name)) plan.warnings.push(t('mcp.notDisabled', { name }));
  const next = off ? (list.includes(name) ? list : [...list, name]) : list.filter((n) => n !== name);
  plan.next = withMcp(state, { ...mcp, disabled: { ...mcp.disabled, claude: next } });
  return finish(epicWs, plan);
}

// The plan written in one transaction: the epic's files rendered from the new state, its state among
// them. A failure or Ctrl+C puts back every path it wrote. The caller holds the epic's lock.
function apply(epicWs, plan) {
  const generate = require('./generate');
  return generate.guarded((txn) => {
    const j = generate.journal();
    txn.add(() => generate.restore(epicWs, j));
    const rendered = generate.computeRender(epicWs, plan.next, null);
    generate.applyRender(epicWs, { ...rendered, warnings: [] }, j);
    return { rendered };
  }, t('mcp.rollingBack', { ws: epicWs }));
}

module.exports = {
  MCP_JSON, claudeWanted, entryOf, envRefs, renderMcpJson, mergeList, mergeSettings, globalClaude,
  secretName, byReference, urlCarriesSecret, parseEnv, argWarnings, serverResult, listResult, missingEnv, planAdd, planRemove, planToggle, apply,
};
