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

module.exports = { MCP_JSON, claudeWanted, entryOf, envRefs, renderMcpJson, mergeList, mergeSettings, globalClaude };
