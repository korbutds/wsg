'use strict';

// An epic's MCP servers for Claude Code (wsg 0.7): the `mcp` key of an epic's state, its render into
// <epic>/.mcp.json and into enabledMcpjsonServers / deniedMcpServers of each workspace's
// .claude/settings.json, the snapshot (mcpRendered) that lets a removal take out exactly wsg's
// entries. Each command runs in a child process with its own HOME, CLAUDE_CONFIG_DIR and WS_ROOT;
// nothing here needs the network or a real agent, and no real user config is ever read.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.WSG_LANG = 'en';

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const W = require(path.join(ROOT, 'lib', 'workspace.js'));
const M = require(path.join(ROOT, 'lib', 'mcp.js'));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-mcp-')));
const home = path.join(tmp, 'home');
const claudeDir = path.join(tmp, 'claude-config');
fs.mkdirSync(home);
fs.mkdirSync(claudeDir);
const ENV = {
  PATH: process.env.PATH,
  HOME: home,
  WSG_LANG: 'en',
  WSG_CONFIG: path.join(tmp, 'no-config'),
  CLAUDE_CONFIG_DIR: claudeDir,
  WSG_NO_LAUNCH: '1',
};
const wsg = (args, { cwd = tmp, env = {}, input = '' } = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', input, env: { ...ENV, ...env }, maxBuffer: 1 << 26 });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
};
const jsonOf = (r) => { try { return JSON.parse(r.out); } catch { return null; } };

let failed = 0;
const it = (name, fn) => {
  try { fn(); console.log(`  ok    ${name}`); } catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};
let finished = false;
process.on('exit', () => {
  if (!finished) { console.log('\nFAIL  the suite stopped before the end'); process.exitCode = 1; }
});

const read = (p) => fs.readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(read(p));
const exists = (p) => fs.existsSync(p);
const stateFile = (ws) => path.join(ws, '.claude', 'wsg.json');
const settingsFile = (ws) => path.join(ws, '.claude', 'settings.json');
const stateOf = (ws) => readJson(stateFile(ws));
const settingsOf = (ws) => readJson(settingsFile(ws));
const setJson = (p, fn) => fs.writeFileSync(p, `${JSON.stringify(fn(readJson(p)), null, 2)}\n`);
const setState = (ws, fn) => setJson(stateFile(ws), fn);
// A root of its own with an epic in it: { root, env, ep }.
function epicRoot(name, slug = 'shop') {
  const root = path.join(tmp, name);
  const env = { WS_ROOT: root };
  const r = wsg(['new', slug, '--kind', 'epic', '--no-launch'], { env });
  if (r.code !== 0) throw new Error(r.all);
  return { root, env, ep: path.join(root, slug) };
}
const newTask = (env, slug, epic = 'shop') => {
  const r = wsg(['new', slug, '--epic', epic, '--no-launch'], { env });
  if (r.code !== 0) throw new Error(r.all);
};

const STDIO = { name: 'shopdb', transport: 'stdio', command: 'npx', args: ['-y', 'shop-db-mcp', '--readonly'], env: [{ name: 'SHOP_DB_TOKEN' }, { name: 'SHOP_REGION', value: 'eu' }], agents: ['claude'] };
const HTTP = { name: 'tracker', transport: 'http', url: 'https://mcp.example.com/acme', bearerEnv: 'ACME_TRACKER_TOKEN', agents: ['claude'] };
const MCP = { servers: [STDIO, HTTP], disabled: { claude: ['github', 'plugin:acme:docs'] } };

(async () => {
  console.log('\nthe mcp key of an epic\'s state');
  {
    const base = { version: 3, kind: 'epic', slug: 'shop', title: 'Shop', sources: [] };
    const problem = (mcp, extra = {}) => W.stateProblem({ ...base, ...extra, ...(mcp === undefined ? {} : { mcp }) });
    it('no mcp: fine, as before', () => assert.strictEqual(problem(undefined), ''));
    it('servers of both transports and disabled names, a plugin\'s among them: fine', () => assert.strictEqual(problem(MCP), ''));
    it('an http server without a token variable: fine', () => assert.strictEqual(problem({ servers: [{ ...HTTP, bearerEnv: null }], disabled: { claude: [] } }), ''));
    it('only an epic has it', () => {
      assert.match(W.stateProblem({ version: 2, kind: 'task', slug: 'x', sources: [], mcp: MCP }), /"mcp" belongs only to an epic/);
    });
    const bad = [
      ['not an object', [], /"mcp" must be \{ servers, disabled \}/],
      ['no disabled', { servers: [] }, /"mcp" must be/],
      ['an unknown transport', { ...MCP, servers: [{ ...HTTP, transport: 'sse' }] }, /"transport" must be one of stdio, http/],
      ['a missing key', { ...MCP, servers: [(({ env, ...x }) => x)(STDIO)] }, /a stdio server has exactly name, transport, command, args, env, agents/],
      ['a name with a colon', { ...MCP, servers: [{ ...STDIO, name: 'plugin:x:y' }] }, /"name" must be letters, digits/],
      ['the same name twice, in another case', { ...MCP, servers: [STDIO, { ...HTTP, name: 'ShopDB' }] }, /the name is used twice/],
      ['an unknown agent', { ...MCP, servers: [{ ...STDIO, agents: ['cursor'] }] }, /"agents" must be a list of claude, codex/],
      ['no agent', { ...MCP, servers: [{ ...STDIO, agents: [] }] }, /"agents"/],
      ['an env entry with another key', { ...MCP, servers: [{ ...STDIO, env: [{ name: 'A', secret: 'x' }] }] }, /each "env" entry is \{ name \} or \{ name, value \}/],
      ['an env name that is no variable\'s', { ...MCP, servers: [{ ...STDIO, env: [{ name: 'A-B' }] }] }, /each "env" entry/],
      ['a variable twice', { ...MCP, servers: [{ ...STDIO, env: [{ name: 'A' }, { name: 'A', value: '1' }] }] }, /listed twice/],
      ['an argument of two lines', { ...MCP, servers: [{ ...STDIO, args: ['a\nb'] }] }, /"args" must be a list of one-line texts/],
      ['a URL that is no http one', { ...MCP, servers: [{ ...HTTP, url: 'file:///x' }] }, /"url" must be an http or https URL/],
      ['a bearer variable that is no name', { ...MCP, servers: [{ ...HTTP, bearerEnv: 'x y' }] }, /"bearerEnv"/],
      ['disabled for an unknown agent', { ...MCP, disabled: { cursor: [] } }, /"mcp.disabled" must be/],
      ['a disabled name twice', { ...MCP, disabled: { claude: ['a', 'a'] } }, /each once/],
    ];
    for (const [name, mcp, re] of bad) it(`refused: ${name}`, () => assert.match(problem(mcp), re));
    it('mcpRendered: an epic\'s has mcpJson, a task\'s has not', () => {
      assert.strictEqual(problem(undefined, { mcpRendered: { mcpJson: ['a'], enabled: ['a'], denied: [] } }), '');
      assert.match(W.stateProblem({ version: 2, kind: 'task', slug: 'x', sources: [], mcpRendered: { mcpJson: [], enabled: [], denied: [] } }), /"mcpRendered" must be \{ enabled, denied \}/);
    });
    it('RESERVED has .mcp.json', () => assert.ok(W.RESERVED.includes('.mcp.json')));
  }

  console.log('\nthe render: .mcp.json and the settings of the epic');
  {
    const { env, ep } = epicRoot('render-root');
    newTask(env, 'cart');
    const task = path.join(ep, 'cart');
    it('a new epic and its task have no MCP keys and no .mcp.json', () => {
      assert.ok(!exists(path.join(ep, '.mcp.json')));
      for (const ws of [ep, task]) {
        const s = settingsOf(ws);
        assert.ok(!('enabledMcpjsonServers' in s) && !('deniedMcpServers' in s));
        assert.ok(!('mcpRendered' in stateOf(ws)));
      }
    });
    // The owner's own: a server and a key in .mcp.json, entries and keys in settings.json.
    fs.writeFileSync(path.join(ep, '.mcp.json'), `${JSON.stringify({ mcpServers: { notes: { command: 'notes-mcp' } }, other: 1 }, null, 2)}\n`);
    setJson(settingsFile(ep), (s) => ({ ...s, enabledMcpjsonServers: ['notes'], deniedMcpServers: [{ serverName: 'slack' }, { serverUrl: 'https://*.example.org/*' }], model: 'x' }));
    setState(ep, (s) => ({ ...s, mcp: MCP }));
    const dry = jsonOf(wsg(['refresh', '--dry-run', '--ws', ep], { env }));
    it('a dry run of the epic lists .mcp.json, the settings and the state, settingsChanged', () => {
      assert.deepStrictEqual([...dry.files].sort(), ['.claude/settings.json', '.claude/wsg.json', '.mcp.json']);
      assert.strictEqual(dry.settingsChanged, true);
    });
    const r = wsg(['refresh', '--ws', ep], { env });
    const mcpJson = readJson(path.join(ep, '.mcp.json'));
    it('.mcp.json gets the epic\'s servers, secrets by reference, after the owner\'s', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.deepStrictEqual(Object.keys(mcpJson.mcpServers), ['notes', 'shopdb', 'tracker']);
      assert.deepStrictEqual(mcpJson.mcpServers.shopdb, { type: 'stdio', command: 'npx', args: ['-y', 'shop-db-mcp', '--readonly'], env: { SHOP_DB_TOKEN: '${SHOP_DB_TOKEN}', SHOP_REGION: 'eu' } });
      assert.deepStrictEqual(mcpJson.mcpServers.tracker, { type: 'http', url: 'https://mcp.example.com/acme', headers: { Authorization: 'Bearer ${ACME_TRACKER_TOKEN}' } });
    });
    it('the owner\'s server and key in .mcp.json stay as they were', () => {
      assert.deepStrictEqual(mcpJson.mcpServers.notes, { command: 'notes-mcp' });
      assert.strictEqual(mcpJson.other, 1);
    });
    const s1 = settingsOf(ep);
    it('settings.json: the epic\'s servers enabled, the globals denied, the owner\'s entries and keys kept after them', () => {
      assert.deepStrictEqual(s1.enabledMcpjsonServers, ['shopdb', 'tracker', 'notes']);
      assert.deepStrictEqual(s1.deniedMcpServers, [{ serverName: 'github' }, { serverName: 'plugin:acme:docs' }, { serverName: 'slack' }, { serverUrl: 'https://*.example.org/*' }]);
      assert.strictEqual(s1.model, 'x');
      assert.ok(Array.isArray(s1.permissions.allow));
    });
    it('the state records exactly what wsg put there', () => {
      assert.deepStrictEqual(stateOf(ep).mcpRendered, { mcpJson: ['shopdb', 'tracker'], enabled: ['shopdb', 'tracker'], denied: ['github', 'plugin:acme:docs'] });
    });
    it('a second refresh changes nothing', () => {
      const d = jsonOf(wsg(['refresh', '--dry-run', '--ws', ep], { env }));
      assert.deepStrictEqual(d.files, []);
      assert.strictEqual(d.settingsChanged, false);
    });
    it('the epic\'s own refresh does not write into its task', () => assert.ok(!('enabledMcpjsonServers' in settingsOf(task))));
    const rt = wsg(['refresh', '--ws', task], { env });
    it('the task\'s refresh: the same names enabled and denied, no .mcp.json of its own', () => {
      assert.strictEqual(rt.code, 0, rt.all);
      const s = settingsOf(task);
      assert.deepStrictEqual(s.enabledMcpjsonServers, ['shopdb', 'tracker']);
      assert.deepStrictEqual(s.deniedMcpServers, [{ serverName: 'github' }, { serverName: 'plugin:acme:docs' }]);
      assert.ok(!exists(path.join(task, '.mcp.json')));
      assert.deepStrictEqual(stateOf(task).mcpRendered, { enabled: ['shopdb', 'tracker'], denied: ['github', 'plugin:acme:docs'] });
    });
    newTask(env, 'checkout');
    const fresh = path.join(ep, 'checkout');
    it('a task made after the servers were added gets them at wsg new --epic', () => {
      const s = settingsOf(fresh);
      assert.deepStrictEqual(s.enabledMcpjsonServers, ['shopdb', 'tracker']);
      assert.deepStrictEqual(s.deniedMcpServers, [{ serverName: 'github' }, { serverName: 'plugin:acme:docs' }]);
      assert.deepStrictEqual(jsonOf(wsg(['refresh', '--dry-run', '--ws', fresh], { env })).files, []);
    });

    // An owner's entry with a wsg name, added to the task by hand: it stays the owner's.
    setJson(settingsFile(task), (s) => ({ ...s, enabledMcpjsonServers: [...s.enabledMcpjsonServers, 'own'], deniedMcpServers: [...s.deniedMcpServers, { serverName: 'jira' }] }));
    // The http server and one denied name go.
    setState(ep, (s) => ({ ...s, mcp: { servers: [STDIO], disabled: { claude: ['github'] } } }));
    wsg(['refresh', '--ws', ep], { env });
    wsg(['refresh', '--ws', task], { env });
    it('a removal takes out only wsg\'s entries in .mcp.json', () => {
      const j = readJson(path.join(ep, '.mcp.json'));
      assert.deepStrictEqual(Object.keys(j.mcpServers), ['notes', 'shopdb']);
      assert.strictEqual(j.other, 1);
    });
    it('and in settings.json, of the epic and of the task', () => {
      assert.deepStrictEqual(settingsOf(ep).enabledMcpjsonServers, ['shopdb', 'notes']);
      assert.deepStrictEqual(settingsOf(ep).deniedMcpServers, [{ serverName: 'github' }, { serverName: 'slack' }, { serverUrl: 'https://*.example.org/*' }]);
      assert.deepStrictEqual(settingsOf(task).enabledMcpjsonServers, ['shopdb', 'own']);
      assert.deepStrictEqual(settingsOf(task).deniedMcpServers, [{ serverName: 'github' }, { serverName: 'jira' }]);
    });
    // Everything goes.
    setState(ep, (s) => { const { mcp, ...rest } = s; return rest; });
    wsg(['refresh', '--ws', ep], { env });
    wsg(['refresh', '--ws', task], { env });
    it('with no server left the owner\'s .mcp.json keeps only its own', () => {
      assert.deepStrictEqual(readJson(path.join(ep, '.mcp.json')), { mcpServers: { notes: { command: 'notes-mcp' } }, other: 1 });
    });
    it('the owner\'s entries stay, wsg\'s go, and so does the snapshot', () => {
      assert.deepStrictEqual(settingsOf(ep).enabledMcpjsonServers, ['notes']);
      assert.deepStrictEqual(settingsOf(task).enabledMcpjsonServers, ['own']);
      assert.deepStrictEqual(settingsOf(task).deniedMcpServers, [{ serverName: 'jira' }]);
      assert.ok(!('mcpRendered' in stateOf(ep)) && !('mcpRendered' in stateOf(task)));
    });
  }

  console.log('\nthe render: files wsg made, names the owner has, an epic that can\'t be read');
  {
    const { env, ep } = epicRoot('own-root');
    newTask(env, 'cart');
    const task = path.join(ep, 'cart');
    const before = read(settingsFile(task));
    setState(ep, (s) => ({ ...s, mcp: { servers: [STDIO], disabled: { claude: [] } } }));
    wsg(['refresh', '--ws', ep], { env });
    wsg(['refresh', '--ws', task], { env });
    it('a .mcp.json wsg made holds only mcpServers', () => assert.deepStrictEqual(Object.keys(readJson(path.join(ep, '.mcp.json'))), ['mcpServers']));
    setState(ep, (s) => { const { mcp, ...rest } = s; return rest; });
    wsg(['refresh', '--ws', ep], { env });
    wsg(['refresh', '--ws', task], { env });
    it('its last server gone, the file goes', () => assert.ok(!exists(path.join(ep, '.mcp.json'))));
    it('and the task\'s settings.json is as it was made, byte for byte', () => assert.strictEqual(read(settingsFile(task)), before));

    // A server of the owner's by the epic's name: never overwritten.
    fs.writeFileSync(path.join(ep, '.mcp.json'), `${JSON.stringify({ mcpServers: { shopdb: { command: 'mine' } } })}\n`);
    setState(ep, (s) => ({ ...s, mcp: { servers: [STDIO], disabled: { claude: [] } } }));
    const r = wsg(['refresh', '--ws', ep], { env });
    it('a server of the owner\'s in .mcp.json by the epic\'s name: refresh refuses, nothing written', () => {
      assert.strictEqual(r.code, 2, r.all);
      assert.match(r.err, /has a server shopdb that wsg did not put there/);
      assert.deepStrictEqual(readJson(path.join(ep, '.mcp.json')), { mcpServers: { shopdb: { command: 'mine' } } });
    });
    fs.writeFileSync(path.join(ep, '.mcp.json'), '{ broken');
    it('a .mcp.json that is no JSON: refused, not overwritten', () => {
      const x = wsg(['refresh', '--ws', ep], { env });
      assert.strictEqual(x.code, 2, x.all);
      assert.match(x.err, /\.mcp\.json can't be read/);
      assert.strictEqual(read(path.join(ep, '.mcp.json')), '{ broken');
    });
    fs.rmSync(path.join(ep, '.mcp.json'));
    // A name the owner enabled in the epic before wsg did: the owner's, kept after a removal.
    setJson(settingsFile(ep), (s) => ({ ...s, enabledMcpjsonServers: ['shopdb'] }));
    wsg(['refresh', '--ws', ep], { env });
    it('a name the owner listed already is not taken as wsg\'s', () => {
      assert.deepStrictEqual(settingsOf(ep).enabledMcpjsonServers, ['shopdb']);
      assert.deepStrictEqual(stateOf(ep).mcpRendered.enabled, []);
    });
    setState(ep, (s) => { const { mcp, ...rest } = s; return rest; });
    wsg(['refresh', '--ws', ep], { env });
    it('and stays when the server goes', () => assert.deepStrictEqual(settingsOf(ep).enabledMcpjsonServers, ['shopdb']));
    // A list that is no list, while wsg has something to render there.
    setState(ep, (s) => ({ ...s, mcp: { servers: [STDIO], disabled: { claude: [] } } }));
    setJson(settingsFile(ep), (s) => ({ ...s, enabledMcpjsonServers: 'shopdb' }));
    it('enabledMcpjsonServers that is no list: refused', () => {
      const x = wsg(['refresh', '--ws', ep], { env });
      assert.strictEqual(x.code, 2, x.all);
      assert.match(x.err, /"enabledMcpjsonServers" is not a list/);
    });
    setJson(settingsFile(ep), (s) => ({ ...s, enabledMcpjsonServers: [] }));
    wsg(['refresh', '--ws', ep], { env });
    wsg(['refresh', '--ws', task], { env });
    // The epic can't be read: the task keeps what it has.
    const had = read(settingsFile(task));
    const good = read(stateFile(ep));
    fs.writeFileSync(stateFile(ep), '{ broken');
    const x = wsg(['refresh', '--ws', task], { env });
    it('an epic that can\'t be read: the task keeps its MCP keys and its snapshot', () => {
      assert.strictEqual(x.code, 0, x.all);
      assert.strictEqual(read(settingsFile(task)), had);
      assert.deepStrictEqual(stateOf(task).mcpRendered, { enabled: ['shopdb'], denied: [] });
    });
    fs.writeFileSync(stateFile(ep), good);
  }

  console.log('\nan owner\'s own .mcp.json in an epic without wsg\'s servers');
  {
    const { env, ep } = epicRoot('owner-json-root');
    const file = path.join(ep, '.mcp.json');
    const commented = '// the owner\'s notes\n{ "mcpServers": { "notes": { "command": "notes-mcp" } } }\n';
    fs.writeFileSync(file, commented);
    const r = wsg(['refresh', '--ws', ep], { env });
    it('one with comments, which is no JSON: refresh ok, the file untouched', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(read(file), commented);
      assert.ok(!('mcpRendered' in stateOf(ep)));
    });
    fs.rmSync(file);
    const target = path.join(tmp, 'shared-mcp.json');
    fs.writeFileSync(target, commented);
    fs.symlinkSync(target, file);
    const r2 = wsg(['refresh', '--ws', ep], { env });
    it('a symlink: refresh ok, the link and its target untouched', () => {
      assert.strictEqual(r2.code, 0, r2.all);
      assert.strictEqual(fs.readlinkSync(file), target);
      assert.strictEqual(read(target), commented);
    });
    it('a dry run says nothing would change', () => assert.deepStrictEqual(jsonOf(wsg(['refresh', '--dry-run', '--ws', ep], { env })).files, []));
  }

  console.log('\nthe render helpers');
  {
    it('mergeList: an owner\'s denied entry with more keys than serverName is never taken as wsg\'s', () => {
      const r = M.mergeList([{ serverName: 'a', note: 'mine' }], [], ['a'], 'serverName', 'f', 'deniedMcpServers');
      assert.deepStrictEqual(r.list, [{ serverName: 'a', note: 'mine' }]);
      assert.strictEqual(r.changed, false);
    });
    it('mergeList: nothing to render and nothing rendered: no key added', () => {
      const r = M.mergeList(undefined, [], [], null, 'f', 'enabledMcpjsonServers');
      assert.strictEqual(r.changed, false);
    });
    it('globalClaude: names and transports from $CLAUDE_CONFIG_DIR/.claude.json, nothing else', () => {
      const dir = path.join(tmp, 'gc');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ mcpServers: { zeta: { command: 'z', env: { T: 'secret-value' } }, alpha: { type: 'http', url: 'https://x/?token=secret-value' }, beta: { url: 'https://y' } }, projects: {} }));
      const g = M.globalClaude({ CLAUDE_CONFIG_DIR: dir, HOME: home });
      assert.deepStrictEqual(g, [{ name: 'alpha', transport: 'http' }, { name: 'beta', transport: 'http' }, { name: 'zeta', transport: 'stdio' }]);
      assert.doesNotMatch(JSON.stringify(g), /secret-value/);
    });
    it('globalClaude: no file, or one that does not read: none', () => {
      assert.deepStrictEqual(M.globalClaude({ CLAUDE_CONFIG_DIR: path.join(tmp, 'nowhere'), HOME: home }), []);
    });
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed === 0 ? '\nall checks passed\n' : `\nfailed: ${failed}\n`);
  finished = true;
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.log(`\nFAIL  ${e.stack || e}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  finished = true;
  process.exit(1);
});
