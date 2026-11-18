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
let passed = 0;
let skipped = 0;
// A block that can't run here (as root, a checkout without the tags, a file system without copy-on-write): said, and counted in the last line.
const skip = (why) => { skipped++; console.log(`  skip  ${why}`); };
const it = (name, fn) => {
  try { fn(); passed++; console.log(`  ok    ${name}`); } catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
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
// A file made read-only stops a write only for a user other than root: those rollback tests skip then.
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
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

  console.log('\nwsg mcp add, list, remove: envelopes, fan-out');
  {
    const { env, ep } = epicRoot('cmd-root');
    for (const slug of ['cart', 'old', 'held']) newTask(env, slug);
    wsg(['close', 'shop/old'], { env });
    const lockFile = path.join(ep, 'held', '.claude', 'wsg.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
    const SECRET = 's3cr3t-value-9f2';
    const LITERAL = 'eu-west-literal';
    const envS = { ...env, SHOP_DB_TOKEN: SECRET };
    fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify({ mcpServers: { github: { command: 'gh', env: { GITHUB_TOKEN: SECRET } }, shopdb: { url: `https://x/?token=${SECRET}` } } }));
    const oldBefore = read(settingsFile(path.join(ep, 'old')));
    const heldBefore = read(settingsFile(path.join(ep, 'held')));
    const dry = wsg(['mcp', 'add', 'shopdb', '--env', `SHOP_DB_TOKEN,SHOP_REGION=${LITERAL}`, '--ws', 'shop', '--dry-run', '--json', '--', 'npx', '-y', 'shop-db-mcp'], { env: envS });
    const dj = jsonOf(dry);
    it('a dry run: the plan in the envelope, nothing written, the tasks listed', () => {
      assert.strictEqual(dry.code, 0, dry.all);
      assert.strictEqual(dj.command, 'mcp add');
      assert.strictEqual(dj.dryRun, true);
      assert.deepStrictEqual(dj.result.files.map((f) => path.relative(ep, f)).sort(), ['.claude/settings.json', '.claude/wsg.json', '.mcp.json']);
      assert.ok(!exists(path.join(ep, '.mcp.json')));
      assert.ok(!('mcp' in stateOf(ep)));
      assert.deepStrictEqual(dj.result.tasks.map((x) => [x.task, x.refreshed, x.code]), [['cart', false, null], ['held', false, null], ['old', false, 'done']]);
    });
    const add = wsg(['mcp', 'add', 'shopdb', '--env', `SHOP_DB_TOKEN,SHOP_REGION=${LITERAL}`, '--ws', 'shop', '--json', '--', 'npx', '-y', 'shop-db-mcp', '--json'], { env: envS });
    const aj = jsonOf(add);
    it('add: ok, the server with its variables by name, restartNeeded, settingsChanged', () => {
      assert.strictEqual(add.code, 0, add.all);
      assert.deepStrictEqual(aj.result.server, { name: 'shopdb', transport: 'stdio', command: 'npx', args: ['-y', 'shop-db-mcp', '--json'], url: null, env: ['SHOP_DB_TOKEN', 'SHOP_REGION'], bearerEnv: null, agents: ['claude'] });
      assert.strictEqual(aj.result.restartNeeded, true);
      assert.strictEqual(aj.result.settingsChanged, true);
    });
    it('.mcp.json holds the secret by reference only; the literal is there, as given', () => {
      const text = read(path.join(ep, '.mcp.json'));
      assert.ok(!text.includes(SECRET));
      assert.deepStrictEqual(JSON.parse(text).mcpServers.shopdb.env, { SHOP_DB_TOKEN: '${SHOP_DB_TOKEN}', SHOP_REGION: LITERAL });
    });
    it('a flag after -- is the server\'s, not wsg\'s', () => assert.deepStrictEqual(stateOf(ep).mcp.servers[0].args, ['-y', 'shop-db-mcp', '--json']));
    it('a name the user-scope config has too: a warning', () => assert.ok(aj.warnings.some((w) => /user-scope Claude Code config has a server shopdb too/.test(w))));
    it('fan-out: the open task refreshed, the done one left, the busy one reported, the epic\'s change kept', () => {
      const by = Object.fromEntries(aj.result.tasks.map((x) => [x.task, x]));
      assert.deepStrictEqual([by.cart.refreshed, by.old.code, by.held.code], [true, 'done', 'busy']);
      assert.deepStrictEqual(settingsOf(path.join(ep, 'cart')).enabledMcpjsonServers, ['shopdb']);
      assert.strictEqual(read(settingsFile(path.join(ep, 'old'))), oldBefore);
      assert.strictEqual(read(settingsFile(path.join(ep, 'held'))), heldBefore);
      assert.deepStrictEqual(Object.keys(readJson(path.join(ep, '.mcp.json')).mcpServers), ['shopdb']);
    });
    const list = wsg(['mcp', 'list', '--ws', 'shop', '--json'], { env: envS });
    const lj = jsonOf(list);
    it('list: the servers, disabled, the user-scope names and transports', () => {
      assert.strictEqual(list.code, 0, list.all);
      assert.deepStrictEqual(Object.keys(lj.result), ['workspace', 'servers', 'disabled', 'global', 'missingEnv']);
      assert.deepStrictEqual(lj.result.global, { claude: [{ name: 'github', transport: 'stdio' }, { name: 'shopdb', transport: 'http' }] });
      assert.deepStrictEqual(lj.result.disabled, { claude: [] });
      assert.deepStrictEqual(lj.result.missingEnv, []);
    });
    it('missingEnv: a variable this environment has no value for', () => {
      assert.deepStrictEqual(jsonOf(wsg(['mcp', 'list', '--ws', 'shop', '--json'], { env })).result.missingEnv, ['SHOP_DB_TOKEN']);
    });
    const dis = wsg(['mcp', 'disable', 'plugin:acme:docs', '--ws', 'shop', '--json'], { env: envS });
    const plain = wsg(['mcp', 'list', '--ws', 'shop'], { env: envS });
    const rem = wsg(['mcp', 'remove', 'shopdb', '--ws', 'shop', '--json'], { env: envS });
    it('envelopes and plain output never carry a value: neither the secret in the environment or the user config, nor a literal', () => {
      for (const r of [dry, add, list, dis, plain, rem]) {
        assert.ok(!r.all.includes(SECRET), r.all);
        assert.ok(!r.all.includes(LITERAL), r.all);
      }
    });
    it('disable: a plugin\'s server by plugin:<plugin>:<server>, denied in the epic and its tasks', () => {
      assert.strictEqual(dis.code, 0, dis.all);
      assert.deepStrictEqual(jsonOf(dis).result.disabled, { claude: ['plugin:acme:docs'] });
      assert.deepStrictEqual(settingsOf(path.join(ep, 'cart')).deniedMcpServers, [{ serverName: 'plugin:acme:docs' }]);
    });
    it('remove: gone from .mcp.json and the settings of the epic and its tasks', () => {
      assert.strictEqual(rem.code, 0, rem.all);
      assert.ok(!exists(path.join(ep, '.mcp.json')));
      assert.ok(!('enabledMcpjsonServers' in settingsOf(ep)));
      assert.ok(!('enabledMcpjsonServers' in settingsOf(path.join(ep, 'cart'))));
      assert.deepStrictEqual(stateOf(ep).mcp, { servers: [], disabled: { claude: ['plugin:acme:docs'] } });
    });
    const en = wsg(['mcp', 'enable', 'plugin:acme:docs', '--ws', 'shop', '--json'], { env });
    it('enable: the name goes, and with it the mcp key and the snapshots', () => {
      assert.strictEqual(en.code, 0, en.all);
      assert.ok(!('mcp' in stateOf(ep)) && !('mcpRendered' in stateOf(ep)));
      assert.ok(!('deniedMcpServers' in settingsOf(path.join(ep, 'cart'))));
      assert.ok(!('mcpRendered' in stateOf(path.join(ep, 'cart'))));
    });
    fs.rmSync(lockFile);
    it('the busy task catches up at its next refresh', () => {
      const r = wsg(['refresh', '--ws', path.join(ep, 'held')], { env });
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(read(settingsFile(path.join(ep, 'held'))), heldBefore);
    });
    fs.rmSync(path.join(claudeDir, '.claude.json'));
  }

  console.log('\nwsg mcp: refusals');
  {
    const { env, ep } = epicRoot('refuse-root');
    newTask(env, 'cart');
    const snapshot = () => JSON.stringify([read(stateFile(ep)), read(settingsFile(ep)), read(settingsFile(path.join(ep, 'cart'))), exists(path.join(ep, '.mcp.json'))]);
    const before = snapshot();
    const refused = (args, re, code = 2) => {
      const r = wsg(args, { env });
      // --json before the server's command: after -- it would be the server's.
      const at = args.indexOf('--');
      const j = jsonOf(wsg(at < 0 ? [...args, '--json'] : [...args.slice(0, at), '--json', ...args.slice(at)], { env }));
      assert.strictEqual(r.code, code, r.all);
      assert.match(r.err, re);
      assert.strictEqual(j.ok, false);
      assert.strictEqual(j.error.code, 'invalid_input');
      assert.strictEqual(j.error.rollback, 'none');
      assert.strictEqual(snapshot(), before);
    };
    const cases = [
      ['--agent codex', ['mcp', 'add', 'x', '--agent', 'codex', '--ws', 'shop', '--', 'srv'], /Codex MCP is not supported yet/],
      ['--agent codex on disable', ['mcp', 'disable', 'github', '--agent', 'codex', '--ws', 'shop'], /Codex MCP is not supported yet/],
      ['an unknown agent', ['mcp', 'add', 'x', '--agent', 'cursor', '--ws', 'shop', '--', 'srv'], /unknown agent cursor/],
      ['a name with a space', ['mcp', 'add', 'my server', '--ws', 'shop', '--', 'srv'], /letters, digits, - and _/],
      ['a plugin-style name for the epic\'s own server', ['mcp', 'add', 'plugin:a:b', '--ws', 'shop', '--', 'srv'], /letters, digits, - and _/],
      ['a name of 65 characters', ['mcp', 'add', 'a'.repeat(65), '--ws', 'shop', '--', 'srv'], /at most 64/],
      ['a secret-looking literal', ['mcp', 'add', 'db', '--env', 'DB_PASSWORD=hunter2', '--ws', 'shop', '--', 'srv'], /DB_PASSWORD looks like a secret/],
      ['a secret-looking literal, a part of the name', ['mcp', 'add', 'db', '--env', 'X_API_KEY=1', '--ws', 'shop', '--', 'srv'], /X_API_KEY looks like a secret/],
      ['a variable name that is none', ['mcp', 'add', 'db', '--env', '1X', '--ws', 'shop', '--', 'srv'], /1X… is not a variable name/],
      ['a variable twice', ['mcp', 'add', 'db', '--env', 'A,A=1', '--ws', 'shop', '--', 'srv'], /given twice/],
      ['no command and no URL', ['mcp', 'add', 'db', '--ws', 'shop'], /how is db started/],
      ['a command and a URL', ['mcp', 'add', 'db', '--url', 'https://x', '--ws', 'shop', '--', 'srv'], /either a command after -- or --url/],
      ['--env with --url', ['mcp', 'add', 'db', '--url', 'https://x', '--env', 'A', '--ws', 'shop'], /--env is for a server started by a command/],
      ['--bearer-env with a command', ['mcp', 'add', 'db', '--bearer-env', 'T', '--ws', 'shop', '--', 'srv'], /--bearer-env is for an http server/],
      ['a URL that is no http one', ['mcp', 'add', 'db', '--url', 'ftp://x', '--ws', 'shop'], /only an http or https URL/],
      ['remove of a server the epic has not', ['mcp', 'remove', 'nope', '--ws', 'shop'], /the epic has no server nope/],
      ['no verb', ['mcp'], /wsg mcp needs one of add, remove, disable, enable, list/],
      ['an unknown verb', ['mcp', 'bogus'], /unknown command: mcp bogus/],
      ['add without a name', ['mcp', 'add', '--ws', 'shop'], /specify the server/],
      ['a task, not an epic', ['mcp', 'list', '--ws', path.join(ep, 'cart')], /is a task workspace: wsg mcp works on an epic/],
      ['list takes no --dry-run', ['mcp', 'list', '--dry-run', '--ws', 'shop'], /unknown argument: --dry-run/],
    ];
    for (const [name, args, re] of cases) it(`refused: ${name}`, () => refused(args, re));
    it('a secret name with a value by reference: taken', () => {
      const r = wsg(['mcp', 'add', 'db', '--env', 'DB_PASSWORD=${SHOP_PW}', '--ws', 'shop', '--dry-run', '--json', '--', 'srv'], { env });
      assert.strictEqual(r.code, 0, r.all);
    });
    it('a non-secret literal: taken', () => {
      const r = wsg(['mcp', 'add', 'db', '--env', 'MONKEY=1,AUTHOR=me', '--ws', 'shop', '--dry-run', '--json', '--', 'srv'], { env });
      assert.strictEqual(r.code, 0, r.all);
    });
    it('a secret-looking argument or URL query: a warning naming the flag, never the value', () => {
      const r = jsonOf(wsg(['mcp', 'add', 'db', '--ws', 'shop', '--dry-run', '--json', '--', 'srv', '--api-key', 'zz-value-1', '--x-token=zz-value-2', 'API_SECRET=zz-value-3', 'https://h/?access_token=zz-value-4', '--plain', '${OK_TOKEN}'], { env }));
      const ws = r.warnings.filter((w) => /may carry a secret/.test(w));
      assert.strictEqual(ws.length, 4, ws.join('\n'));
      assert.ok(ws.some((w) => /\(--api-key\)/.test(w)) && ws.some((w) => /\(--x-token\)/.test(w)));
      // The arguments themselves are in the result: what the owner typed (the contract says so).
      assert.doesNotMatch(r.warnings.join('\n'), /zz-value/);
      const u = jsonOf(wsg(['mcp', 'add', 'trk', '--url', 'https://h/mcp?apikey=zz-value-5', '--ws', 'shop', '--dry-run', '--json'], { env }));
      assert.ok(u.warnings.some((w) => /URL of trk may carry a secret/.test(w)));
      assert.ok(!u.warnings.join('\n').includes('zz-value'));
    });
    it('a secret name with text around a reference, or a default: refused', () => {
      for (const v of ['abc123${SHOP_X}', '${SHOP_X}abc', '${SHOP_X:-abc123}']) {
        const r = wsg(['mcp', 'add', 'db', '--env', `API_KEY=${v}`, '--ws', 'shop', '--dry-run', '--json', '--', 'srv'], { env });
        assert.strictEqual(r.code, 2, `${v}: ${r.all}`);
        assert.match(jsonOf(r).error.message, /API_KEY looks like a secret/);
      }
    });
    it('arguments: a value that is exactly ${VAR} is no warning; text around it is', () => {
      const quiet = jsonOf(wsg(['mcp', 'add', 'db', '--ws', 'shop', '--dry-run', '--json', '--', 'srv', '--api-key', '${SHOP_K}', '--token=${SHOP_T}', 'DB_PASSWORD=${SHOP_P}', 'https://h/?access_token=${SHOP_A}', 'Authorization: Bearer ${SHOP_B}'], { env }));
      assert.deepStrictEqual(quiet.warnings.filter((w) => /may carry a secret/.test(w)), []);
      const loud = jsonOf(wsg(['mcp', 'add', 'db', '--ws', 'shop', '--dry-run', '--json', '--', 'srv', '--token=abc123${SHOP_T}', '--api-key', 'x${SHOP_K}', 'Authorization: Bearer zz${SHOP_B}'], { env }));
      assert.strictEqual(loud.warnings.filter((w) => /may carry a secret/.test(w)).length, 3, loud.warnings.join('\n'));
      const url = jsonOf(wsg(['mcp', 'add', 'trk', '--url', 'https://h/mcp?token=${SHOP_T}', '--ws', 'shop', '--dry-run', '--json'], { env }));
      assert.ok(!url.warnings.some((w) => /may carry a secret/.test(w)));
    });
    it('a refused --url, --bearer-env or --env name: the message repeats no secret', () => {
      const cases = [
        ['--url', 'ftp://user:tok-secret-1@h.example/x?token=tok-secret-2', /ftp:\/\/h\.example/],
        ['--url', 'https://h.example/a b?token=tok-secret-3', /: https:\/\/h\.example$/],
        ['--bearer-env', 'Bearer tok-secret-4', /^Bea… is not a variable name/],
      ];
      for (const [flag, value, re] of cases) {
        const r = jsonOf(wsg(['mcp', 'add', 'trk', ...(flag === '--url' ? [] : ['--url', 'https://h.example/mcp']), flag, value, '--ws', 'shop', '--json'], { env }));
        assert.strictEqual(r.ok, false);
        assert.match(r.error.message, re);
        assert.doesNotMatch(JSON.stringify(r.error), /tok-secret/);
      }
      const e = jsonOf(wsg(['mcp', 'add', 'db', '--env', 'TOKEN:tok-secret-5', '--ws', 'shop', '--json', '--', 'srv'], { env }));
      assert.strictEqual(e.ok, false);
      assert.match(e.error.message, /TOK… is not a variable name/);
      assert.doesNotMatch(JSON.stringify(e), /tok-secret/);
    });
    it('the server\'s arguments after --, named like wsg\'s flags, stay the server\'s', () => {
      const args = ['tool', '--json', '--dry-run', '--ws', 'elsewhere', '--help', '--version'];
      const r = wsg(['mcp', 'add', 'flagged', '--ws', 'shop', '--', ...args], { env });
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(jsonOf(r), null);
      assert.match(r.out, /Added MCP server flagged/);
      const srv = stateOf(ep).mcp.servers.find((s) => s.name === 'flagged');
      assert.deepStrictEqual([srv.command, ...srv.args], args);
      assert.strictEqual(wsg(['mcp', 'remove', 'flagged', '--ws', 'shop'], { env }).code, 0);
    });
    // A server of the owner's in .mcp.json by the same name.
    fs.writeFileSync(path.join(ep, '.mcp.json'), `${JSON.stringify({ mcpServers: { db: { command: 'mine' } } })}\n`);
    it('a name the owner\'s .mcp.json has: refused, the file as it was', () => {
      const r = jsonOf(wsg(['mcp', 'add', 'db', '--ws', 'shop', '--json', '--', 'srv'], { env }));
      assert.strictEqual(r.ok, false);
      assert.match(r.error.message, /has a server db that wsg did not put there/);
      assert.deepStrictEqual(readJson(path.join(ep, '.mcp.json')), { mcpServers: { db: { command: 'mine' } } });
      assert.ok(!('mcp' in stateOf(ep)));
    });
    fs.rmSync(path.join(ep, '.mcp.json'));
    wsg(['mcp', 'add', 'db', '--ws', 'shop', '--', 'srv'], { env });
    it('the same name twice, in another case: refused', () => assert.match(wsg(['mcp', 'add', 'DB', '--ws', 'shop', '--', 'srv'], { env }).err, /has a server db already/));
    it('disable of the epic\'s own server: refused', () => assert.match(wsg(['mcp', 'disable', 'db', '--ws', 'shop'], { env }).err, /the epic's own server: wsg mcp remove db/));
    it('enable of a name that is not off: a warning, nothing changes', () => {
      const r = jsonOf(wsg(['mcp', 'enable', 'github', '--ws', 'shop', '--json'], { env }));
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.result.restartNeeded, false);
      assert.deepStrictEqual(r.result.files, []);
      assert.ok(r.warnings.some((w) => /not turned off/.test(w)));
    });
    it('disable of a name the user-scope config does not have: done, with a warning', () => {
      const r = jsonOf(wsg(['mcp', 'disable', 'github', '--ws', 'shop', '--json'], { env }));
      assert.strictEqual(r.ok, true);
      assert.ok(r.warnings.some((w) => /no server github/.test(w)));
    });
    it('a name that is turned off can\'t be the epic\'s own', () => assert.match(wsg(['mcp', 'add', 'github', '--ws', 'shop', '--', 'srv'], { env }).err, /a global server the epic turns off/));
    it('help: wsg help mcp, wsg mcp add --help', () => {
      for (const args of [['help', 'mcp'], ['mcp', '--help'], ['mcp', 'add', '--help'], ['help', 'mcp', 'list']]) {
        const r = wsg(args, { env });
        assert.strictEqual(r.code, 0, r.all);
        assert.match(r.out, /wsg mcp add <name>/);
      }
    });
  }

  console.log('\nwsg refresh --tasks, refresh --json');
  {
    const { env, ep } = epicRoot('refresh-root');
    for (const slug of ['cart', 'old']) newTask(env, slug);
    wsg(['close', 'shop/old'], { env });
    setState(ep, (s) => ({ ...s, mcp: { servers: [STDIO], disabled: { claude: ['github'] } } }));
    const plainDry = wsg(['refresh', '--dry-run', '--ws', ep], { env });
    it('plain --dry-run stays what it was: no tasks key, relative files', () => {
      const j = JSON.parse(plainDry.out);
      assert.deepStrictEqual(Object.keys(j), ['workspace', 'files', 'settingsChanged', 'errors', 'warnings']);
      assert.ok(j.files.includes('.mcp.json'));
    });
    const dryTasks = JSON.parse(wsg(['refresh', '--tasks', '--dry-run', '--ws', ep], { env }).out);
    it('plain --dry-run --tasks lists the tasks, nothing written', () => {
      assert.deepStrictEqual(dryTasks.tasks.map((x) => [x.task, x.code]), [['cart', null], ['old', 'done']]);
      assert.ok(!exists(path.join(ep, '.mcp.json')));
    });
    const jd = jsonOf(wsg(['refresh', '--dry-run', '--json', '--ws', ep], { env }));
    it('--json --dry-run: an envelope, the files absolute, tasks null without --tasks', () => {
      assert.strictEqual(jd.ok, true);
      assert.strictEqual(jd.command, 'refresh');
      assert.strictEqual(jd.dryRun, true);
      assert.ok(jd.result.files.includes(path.join(ep, '.mcp.json')));
      assert.strictEqual(jd.result.tasks, null);
      assert.ok(!exists(path.join(ep, '.mcp.json')));
    });
    const plain = wsg(['refresh', '--tasks', '--ws', ep], { env });
    it('--tasks: the epic, then its open tasks; the done one left as it is', () => {
      assert.strictEqual(plain.code, 0, plain.all);
      assert.match(plain.out, /Tasks refreshed: cart/);
      assert.match(plain.out, /Done tasks left as they are: old/);
      assert.ok(exists(path.join(ep, '.mcp.json')));
      assert.deepStrictEqual(settingsOf(path.join(ep, 'cart')).enabledMcpjsonServers, ['shopdb']);
      assert.ok(!('enabledMcpjsonServers' in settingsOf(path.join(ep, 'old'))));
    });
    const j = jsonOf(wsg(['refresh', '--tasks', '--json', '--ws', ep], { env }));
    it('--tasks --json: nothing left to change, every task in the result', () => {
      assert.strictEqual(j.ok, true);
      assert.deepStrictEqual(j.result.files, []);
      assert.strictEqual(j.result.settingsChanged, false);
      assert.deepStrictEqual(j.result.tasks.map((x) => [x.task, x.refreshed, x.code]), [['cart', true, null], ['old', false, 'done']]);
    });
    it('--tasks outside an epic: refused', () => {
      const r = wsg(['refresh', '--tasks', '--ws', path.join(ep, 'cart')], { env });
      assert.strictEqual(r.code, 2, r.all);
      assert.match(r.err, /--tasks refreshes the tasks of an epic/);
      assert.strictEqual(jsonOf(wsg(['refresh', '--tasks', '--json', '--ws', path.join(ep, 'cart')], { env })).error.code, 'invalid_input');
    });
    it('--json, a refusal: the envelope, invalid_input', () => {
      fs.writeFileSync(path.join(ep, '.mcp.json'), '{ broken');
      const r = wsg(['refresh', '--json', '--dry-run', '--ws', ep], { env });
      assert.strictEqual(r.code, 2, r.all);
      assert.strictEqual(jsonOf(r).error.code, 'invalid_input');
      fs.rmSync(path.join(ep, '.mcp.json'));
      wsg(['refresh', '--ws', ep], { env });
    });
  }

  console.log('\nwsg check: the epic\'s MCP servers');
  {
    const { env, ep } = epicRoot('check-root');
    for (const slug of ['cart', 'pay']) newTask(env, slug);
    const items = (ws, extra = {}) => {
      const j = jsonOf(wsg(['check', ws, '--json'], { env: { ...env, ...extra } }));
      return j.result.sections.flatMap((x) => x.items.map((it) => `${it.level} ${it.text}`));
    };
    const has = (list, re) => list.some((l) => re.test(l));
    it('an epic and a task without servers: no MCP lines', () => {
      assert.ok(!has(items(ep), /MCP/));
      assert.ok(!has(items(path.join(ep, 'cart')), /MCP/));
    });
    wsg(['mcp', 'add', 'shopdb', '--env', 'SHOP_DB_TOKEN', '--ws', 'shop', '--', 'srv'], { env });
    wsg(['mcp', 'disable', 'github', '--ws', 'shop'], { env });
    const clean = items(ep, { SHOP_DB_TOKEN: 'x' });
    it('all in place: an ok line, the trust note, no warning about MCP', () => {
      assert.ok(has(clean, /^ok MCP: 1 server of the epic, 1 global turned off/), clean.join('\n'));
      assert.ok(has(clean, /^info in a terminal, the epic's MCP servers stay "Pending approval" in a task until its folder is trusted/));
      assert.ok(!has(clean, /^(warn|fail) .*MCP/), clean.join('\n'));
    });
    it('a variable not set in this environment: a warning naming it, never a value', () => {
      const l = items(ep);
      assert.ok(has(l, /^warn MCP: not set in this environment: SHOP_DB_TOKEN/));
    });
    it('the task: its settings enable the epic\'s servers, the trust note', () => {
      const l = items(path.join(ep, 'cart'), { SHOP_DB_TOKEN: 'x' });
      assert.ok(has(l, /^ok \.claude\/settings\.json enables the epic's MCP servers \(1\) and turns off 1 global/), l.join('\n'));
      assert.ok(has(l, /Pending approval/));
    });
    // A task left behind: its settings edited back by hand.
    setJson(settingsFile(path.join(ep, 'pay')), (s) => { const { enabledMcpjsonServers, ...rest } = s; return rest; });
    it('a stale task: named in the epic\'s check', () => assert.ok(has(items(ep, { SHOP_DB_TOKEN: 'x' }), /^warn tasks without the epic's MCP servers as they are now in their \.claude\/settings\.json: pay — run wsg refresh --tasks here/)));
    it('and in its own', () => assert.ok(has(items(path.join(ep, 'pay'), { SHOP_DB_TOKEN: 'x' }), /^warn \.claude\/settings\.json: enabledMcpjsonServers or deniedMcpServers is not what the epic's MCP servers say now/)));
    wsg(['refresh', '--tasks', '--ws', ep], { env });
    it('refresh --tasks clears it', () => assert.ok(!has(items(ep, { SHOP_DB_TOKEN: 'x' }), /^warn tasks without the epic's MCP/)));
    // .mcp.json lost the epic's entry.
    setJson(path.join(ep, '.mcp.json'), (j) => ({ mcpServers: {} }));
    it('.mcp.json missing a wsg entry: a warning naming it', () => assert.ok(has(items(ep, { SHOP_DB_TOKEN: 'x' }), /^warn \.mcp\.json has no entry for the epic's MCP server shopdb/)));
    setJson(path.join(ep, '.mcp.json'), (j) => ({ mcpServers: { shopdb: { command: 'edited' } } }));
    it('an entry edited by hand: a warning to refresh', () => assert.ok(has(items(ep, { SHOP_DB_TOKEN: 'x' }), /^warn \.mcp\.json is not the epic's MCP servers as they are now/)));
    wsg(['refresh', '--ws', ep], { env });
    // A user-scope server by the same name.
    fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify({ mcpServers: { shopdb: { command: 'other', env: { T: 'hidden-value-7' } } } }));
    const shadow = wsg(['check', ep], { env: { ...env, SHOP_DB_TOKEN: 'x' } });
    it('a server that takes the name of a user-scope one: a warning; nothing of that config is printed', () => {
      assert.match(shadow.all, /the epic's server shopdb takes the name of a server in your user-scope Claude Code config/);
      assert.ok(!shadow.all.includes('hidden-value-7'));
    });
    fs.rmSync(path.join(claudeDir, '.claude.json'));
    // The owner put a server by the epic's name into .mcp.json, and wsg's snapshot does not know it.
    setState(ep, (s) => ({ ...s, mcpRendered: { ...s.mcpRendered, mcpJson: [] } }));
    it('an owner\'s entry by the epic\'s server name: FAIL, refresh refuses', () => assert.ok(has(items(ep, { SHOP_DB_TOKEN: 'x' }), /^fail .*has a server shopdb that wsg did not put there/)));
  }

  console.log('\nwsg mcp: a failed write is rolled back');
  if (asRoot) skip('running as root: a read-only file does not stop a write');
  else {
    const { env, ep } = epicRoot('rollback-root');
    newTask(env, 'cart');
    const task = path.join(ep, 'cart');
    const snap = (dir) => {
      const out = {};
      const walk = (d) => {
        for (const e of fs.readdirSync(d).sort()) {
          const p = path.join(d, e);
          const rel = path.relative(dir, p);
          if (rel === path.join('.claude', 'wsg.lock')) continue;
          const st = fs.lstatSync(p);
          if (st.isDirectory()) { out[rel] = 'dir'; walk(p); } else out[rel] = st.isSymbolicLink() ? `-> ${fs.readlinkSync(p)}` : fs.readFileSync(p).toString('base64');
        }
      };
      walk(dir);
      return out;
    };
    const before = snap(ep);
    fs.chmodSync(settingsFile(ep), 0o444);
    const r = wsg(['mcp', 'add', 'shopdb', '--ws', 'shop', '--json', '--', 'srv'], { env });
    fs.chmodSync(settingsFile(ep), 0o644);
    const j = jsonOf(r);
    it('the epic\'s settings.json can\'t be written: step_failed, rolled back, the epic and its task as they were', () => {
      assert.strictEqual(r.code, 1, r.all);
      assert.strictEqual(j.error.code, 'step_failed');
      assert.strictEqual(j.error.rollback, 'done');
      assert.deepStrictEqual(snap(ep), before);
    });
    const taskBefore = snap(task);
    fs.chmodSync(settingsFile(task), 0o444);
    const r2 = wsg(['mcp', 'add', 'shopdb', '--ws', 'shop', '--json', '--', 'srv'], { env });
    fs.chmodSync(settingsFile(task), 0o644);
    const j2 = jsonOf(r2);
    it('a task\'s settings.json can\'t be written: the epic\'s change kept, the task reported failed and as it was', () => {
      assert.strictEqual(r2.code, 0, r2.all);
      assert.deepStrictEqual(j2.result.tasks.map((x) => [x.task, x.refreshed, x.code]), [['cart', false, 'failed']]);
      assert.deepStrictEqual(Object.keys(readJson(path.join(ep, '.mcp.json')).mcpServers), ['shopdb']);
      assert.deepStrictEqual(snap(task), taskBefore);
    });
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

  console.log('\nwsg check after the last server went while a task was busy; a reopened task');
  {
    const { env, ep } = epicRoot('late-root');
    for (const slug of ['cart', 'held', 'old']) newTask(env, slug);
    wsg(['close', 'shop/old'], { env });
    wsg(['mcp', 'add', 'shopdb', '--ws', 'shop', '--', 'srv'], { env });
    const lockFile = path.join(ep, 'held', '.claude', 'wsg.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
    wsg(['mcp', 'remove', 'shopdb', '--ws', 'shop'], { env });
    fs.rmSync(lockFile);
    const items = (ws) => jsonOf(wsg(['check', ws, '--json'], { env })).result.sections.flatMap((x) => x.items.map((it) => `${it.level} ${it.text}`));
    it('the epic has no servers and no snapshot left, the busy task still has wsg\'s entries', () => {
      assert.ok(!('mcp' in stateOf(ep)) && !('mcpRendered' in stateOf(ep)));
      assert.deepStrictEqual(settingsOf(path.join(ep, 'held')).enabledMcpjsonServers, ['shopdb']);
    });
    it('the epic\'s check names that task', () => assert.ok(items(ep).some((l) => /^warn tasks without the epic's MCP servers as they are now in their \.claude\/settings\.json: held/.test(l))));
    wsg(['refresh', '--tasks', '--ws', ep], { env });
    it('and is quiet once it is refreshed', () => assert.ok(!items(ep).some((l) => /MCP/.test(l))));
    // A done task left out of a change, then reopened.
    wsg(['mcp', 'add', 'tracker', '--url', 'https://mcp.example.com/acme', '--ws', 'shop'], { env });
    it('a done task is left out of the change', () => assert.ok(!('enabledMcpjsonServers' in settingsOf(path.join(ep, 'old')))));
    const r = wsg(['status', 'shop/old', 'open'], { env });
    it('reopened, it gets the epic\'s servers at once', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.deepStrictEqual(settingsOf(path.join(ep, 'old')).enabledMcpjsonServers, ['tracker']);
      assert.strictEqual(stateOf(path.join(ep, 'old')).status, 'open');
      assert.deepStrictEqual(stateOf(path.join(ep, 'old')).mcpRendered, { enabled: ['tracker'], denied: [] });
      assert.deepStrictEqual(jsonOf(wsg(['refresh', '--dry-run', '--ws', path.join(ep, 'old')], { env })).files, []);
    });
    // An owner's own .mcp.json that is no JSON, in an epic whose wsg servers are all gone.
    wsg(['mcp', 'remove', 'tracker', '--ws', 'shop'], { env });
    fs.writeFileSync(path.join(ep, '.mcp.json'), '// mine\n{}\n');
    it('an owner\'s .mcp.json with comments in an epic without wsg\'s servers: check says nothing about it', () => {
      const r2 = wsg(['check', ep, '--json'], { env });
      assert.ok(!items(ep).some((l) => /MCP|mcp\.json/.test(l)), items(ep).join('\n'));
      assert.notStrictEqual(jsonOf(r2).error && jsonOf(r2).error.code, 'internal');
    });
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
  console.log(failed === 0 ? `\n${passed} checks passed, ${skipped} blocks skipped\n` : `\nfailed: ${failed}, ${passed} passed, ${skipped} blocks skipped\n`);
  finished = true;
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.log(`\nFAIL  ${e.stack || e}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  finished = true;
  process.exit(1);
});
