'use strict';

// `wsg team`: the role cards, the workflow, the Claude Code adapters, /wsg-feature or the process
// skill's pointer, and the AGENTS.md block — run as a user or an agent runs it, in a child process
// with its own HOME, WS_ROOT and Claude config dir. Nothing here needs the network or a real agent.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

// Messages are matched in English; on a machine with a Russian locale the UI would switch.
process.env.WSG_LANG = 'en';

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const team = require(path.join(ROOT, 'lib', 'team.js'));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-team-')));
const home = path.join(tmp, 'home');
const wsRoot = path.join(tmp, 'ws');
for (const d of [home, wsRoot]) fs.mkdirSync(d, { recursive: true });

const ENV = {
  PATH: process.env.PATH,
  HOME: home,
  WSG_LANG: 'en',
  WSG_CONFIG: path.join(tmp, 'no-config'),
  WS_ROOT: wsRoot,
  CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
  CODEX_HOME: path.join(tmp, 'codex-config'),
  WSG_NO_LAUNCH: '1',
};
const wsg = (args, { cwd = tmp } = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: ENV });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
};
const fresh = (slug, extra = []) => {
  const r = wsg(['new', slug, '--no-launch', ...extra]);
  assert.strictEqual(r.code, 0, r.all);
  return path.join(wsRoot, slug);
};

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const api = path.join(tmp, 'api');
fs.mkdirSync(api);
git(api, ['init', '-q', '-b', 'main']);
git(api, ['config', 'user.email', 'test@example.com']);
git(api, ['config', 'user.name', 'test']);
fs.writeFileSync(path.join(api, 'a.ts'), 'export const a = 1;\n');
git(api, ['add', '-A']);
git(api, ['commit', '-qm', 'init']);

// Every path under a directory with its type and bytes: "touches nothing" means this is unchanged.
function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d).sort()) {
      const p = path.join(d, e);
      const rel = path.relative(dir, p);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) {
        out[rel] = 'dir';
        walk(p);
      } else out[rel] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}
const read = (ws, rel) => fs.readFileSync(path.join(ws, rel), 'utf8');
// The frontmatter as its lines, and the keys in order.
const front = (text) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'no frontmatter');
  return m[1].split('\n');
};
const keys = (text) => front(text).map((l) => l.slice(0, l.indexOf(':')));
const value = (text, key) => {
  const l = front(text).find((x) => x.startsWith(`${key}:`));
  return l === undefined ? undefined : l.slice(key.length + 1).trim();
};
const block = (text, name) => {
  const m = new RegExp(`^<!-- wsg:${name} -->\\n([\\s\\S]*?)\\n<!-- /wsg:${name} -->$`, 'm').exec(text);
  return m ? m[1] : null;
};
const withoutBlock = (text, name) => text.replace(new RegExp(`^<!-- wsg:${name} -->\\n[\\s\\S]*?\\n<!-- /wsg:${name} -->\\n`, 'm'), '');

let failed = 0;
const it = (name, fn) => {
  try { fn(); console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};

const ALL = ['pm', 'designer', 'frontend', 'backend', 'devops', 'reviewer'];
const HANDBACK = ['pm', 'designer', 'reviewer'];
const card = (r) => path.join('team', `${r}.md`);
const adapter = (r) => path.join('.claude', 'agents', `wsg-${r}.md`);
const FEATURE = path.join('.claude', 'skills', 'wsg-feature', 'SKILL.md');
const WORKFLOW = path.join('team', 'workflow.md');

try {
  console.log('\nwsg team in a task workspace');
  {
    const ws = fresh('t1');
    const agentsBefore = read(ws, 'AGENTS.md');
    const r = wsg(['team', 'fullstack'], { cwd: ws });
    it('exit 0', () => assert.strictEqual(r.code, 0, r.all));
    it('says how many files it wrote and what comes next', () => {
      assert.match(r.out, /Team fullstack: 16 files written/);
      assert.match(r.out, /\/wsg-feature/);
    });
    it('the first insertion of the block is no warning', () => assert.doesNotMatch(r.all, /WARN/));
    it('no restart hint: .claude/agents and .claude/skills were there', () => assert.doesNotMatch(r.out, /restart/));
    it('a card and an adapter per role, the workflow and /wsg-feature', () => {
      for (const role of ALL) {
        assert.ok(fs.existsSync(path.join(ws, card(role))), card(role));
        assert.ok(fs.existsSync(path.join(ws, adapter(role))), adapter(role));
      }
      assert.ok(fs.existsSync(path.join(ws, WORKFLOW)));
      assert.ok(fs.existsSync(path.join(ws, FEATURE)));
    });
    it('handback roles may not write memory, implementers write it only when the owner asks', () => {
      for (const role of HANDBACK) {
        assert.match(read(ws, card(role)), /Your memory is read-only for you; tell the lead what is worth\nremembering\./, role);
        assert.doesNotMatch(read(ws, card(role)), /Write to memory/, role);
      }
      for (const role of ['frontend', 'backend', 'devops']) assert.match(read(ws, card(role)), /Write to memory only when the owner asks/, role);
    });
    it('cards are the templates, 30 to 50 lines each', () => {
      for (const role of ALL) {
        const text = read(ws, card(role));
        assert.strictEqual(text, fs.readFileSync(path.join(ROOT, 'templates', 'team', 'roles', `${role}.md`), 'utf8'));
        const n = text.split('\n').length - 1;
        assert.ok(n >= 30 && n <= 50, `${role}: ${n} lines`);
        for (const s of ['## When you work', '## Inputs', '## What you do', '## Output', '## Do not', '## Memory']) assert.ok(text.includes(`\n${s}\n`), `${role}: ${s}`);
      }
    });
    it('adapters: strict frontmatter, one key per line, no tools allowlist', () => {
      for (const role of ALL) {
        const text = read(ws, adapter(role));
        assert.deepStrictEqual(keys(text), ['name', 'description', 'disallowedTools', 'model', 'memory'], role);
        assert.strictEqual(value(text, 'name'), `wsg-${role}`);
        assert.strictEqual(value(text, 'model'), 'inherit');
        assert.strictEqual(value(text, 'memory'), 'user');
        assert.strictEqual(JSON.parse(value(text, 'description')), team.ROLE_META[role].description);
      }
    });
    it('each adapter points to its card, which exists, and to the workflow', () => {
      for (const role of ALL) {
        const text = read(ws, adapter(role));
        assert.ok(text.includes(`Read \`team/${role}.md\``), role);
        assert.ok(text.includes('`team/workflow.md`'), role);
      }
    });
    it('handback roles lack Write and Edit and return their document', () => {
      for (const role of HANDBACK) {
        const text = read(ws, adapter(role));
        assert.deepStrictEqual(value(text, 'disallowedTools').split(', '), ['Write', 'Edit', 'NotebookEdit', 'Agent'], role);
        assert.match(text, /Return the full text of .* as your final message; do not try to write it\. The lead saves it\./, role);
      }
    });
    it('implementers deny only Agent and hand nothing back', () => {
      for (const role of ['frontend', 'backend', 'devops']) {
        const text = read(ws, adapter(role));
        assert.strictEqual(value(text, 'disallowedTools'), 'Agent', role);
        assert.doesNotMatch(text, /Return the full text/, role);
      }
    });
    it('the workflow lists every role in its roles block', () => {
      const b = block(read(ws, WORKFLOW), 'roles');
      assert.ok(b, 'no roles block');
      assert.deepStrictEqual(b.split('\n').map((l) => /^- `([a-z]+)`/.exec(l)[1]), ALL);
    });
    it('the workflow has the stages, the handback rule and the limits', () => {
      const text = read(ws, WORKFLOW);
      for (const s of ['0. Scale check', '6. Final checks', '## Handback rule', '## If a role is not installed', '## Limits']) assert.ok(text.includes(s), s);
    });
    it('/wsg-feature: its name is its directory, manual only', () => {
      const text = read(ws, FEATURE);
      assert.strictEqual(value(text, 'name'), 'wsg-feature');
      assert.strictEqual(value(text, 'disable-model-invocation'), 'true');
      assert.strictEqual(value(text, 'argument-hint'), '"[what to build]"');
      assert.match(text, /team\/workflow\.md/);
      assert.match(text, /\$ARGUMENTS/);
    });
    const agents = read(ws, 'AGENTS.md');
    it('AGENTS.md gets the team block right after the advisor block', () => {
      assert.match(agents, /<!-- \/wsg:advisor -->\n<!-- wsg:team -->\n/);
      assert.strictEqual(block(agents, 'team').split('\n').length, 3);
      assert.match(block(agents, 'team'), /`team\/workflow\.md`/);
      assert.match(block(agents, 'team'), /`\/wsg-feature`/);
    });
    it('AGENTS.md outside the markers is byte-identical', () => assert.strictEqual(withoutBlock(agents, 'team'), agentsBefore));
    it('the state records the team, the version stays', () => {
      const s = JSON.parse(read(ws, path.join('.claude', 'wsg.json')));
      assert.deepStrictEqual(s.team, { preset: 'fullstack', roles: ALL });
      assert.strictEqual(s.version, 2);
    });

    // A card the owner edited, then a second run.
    fs.appendFileSync(path.join(ws, card('backend')), '\nOur own rule.\n');
    const before = tree(ws);
    const again = wsg(['team', 'fullstack'], { cwd: ws });
    it('a re-run: exit 0, nothing to write', () => {
      assert.strictEqual(again.code, 0, again.all);
      assert.match(again.out, /nothing to write/);
    });
    it('a re-run changes no byte', () => assert.deepStrictEqual(tree(ws), before));
    it('a re-run names only the kept file that differs from what wsg would write', () => {
      assert.deepStrictEqual(again.out.split('\n').filter((l) => /kept /.test(l)).map((l) => l.trim()),
        [`kept ${card('backend')}: it exists, not overwritten`]);
    });
    it('--dry-run still lists every kept file', () => {
      const j = JSON.parse(wsg(['team', 'fullstack', '--dry-run'], { cwd: ws }).out);
      assert.deepStrictEqual(j.kept.sort(), [...ALL.flatMap((x) => [card(x), adapter(x)]), WORKFLOW, FEATURE].sort());
    });
    it('the edited card stays as the owner left it', () => assert.match(read(ws, card('backend')), /Our own rule\.\n$/));

    // wsg add after the team: the block is rendered from the state, so it stays.
    const add = wsg(['add', api, '--link'], { cwd: ws });
    it('wsg add afterwards keeps the team block', () => {
      assert.strictEqual(add.code, 0, add.all);
      assert.strictEqual(block(read(ws, 'AGENTS.md'), 'team'), block(agents, 'team'));
    });
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), withoutBlock(read(ws, 'AGENTS.md'), 'team'));
    const ref = wsg(['refresh'], { cwd: ws });
    it('wsg refresh puts a deleted team block back', () => {
      assert.strictEqual(ref.code, 0, ref.all);
      assert.match(ref.out, /the <!-- wsg:team --> markers were missing/);
      assert.doesNotMatch(ref.out, /new in wsg/);
      assert.strictEqual(block(read(ws, 'AGENTS.md'), 'team'), block(agents, 'team'));
      assert.match(read(ws, 'AGENTS.md'), /<!-- \/wsg:advisor -->\n<!-- wsg:team -->\n/);
    });
    it('a workspace without a team gets no team block on refresh', () => {
      const other = fresh('t1-none');
      wsg(['refresh'], { cwd: other });
      assert.doesNotMatch(read(other, 'AGENTS.md'), /wsg:team/);
    });
  }

  console.log('\nwsg team --without, and adding a role later');
  {
    const ws = fresh('t2');
    const r = wsg(['team', 'fullstack', '--without', 'designer,devops'], { cwd: ws });
    it('exit 0', () => assert.strictEqual(r.code, 0, r.all));
    it('the roles left out get no files', () => {
      for (const role of ['designer', 'devops']) {
        assert.ok(!fs.existsSync(path.join(ws, card(role))), card(role));
        assert.ok(!fs.existsSync(path.join(ws, adapter(role))), adapter(role));
      }
      assert.ok(fs.existsSync(path.join(ws, card('pm'))));
    });
    it('the roles block and the state have only the installed ones', () => {
      assert.doesNotMatch(block(read(ws, WORKFLOW), 'roles'), /designer|devops/);
      assert.deepStrictEqual(JSON.parse(read(ws, path.join('.claude', 'wsg.json'))).team.roles, ['pm', 'frontend', 'backend', 'reviewer']);
    });
    const dry = wsg(['team', 'fullstack', '--without', 'devops', '--dry-run'], { cwd: ws });
    it('the dry run of adding designer creates only its two files', () => {
      assert.strictEqual(dry.code, 0, dry.all);
      const j = JSON.parse(dry.out);
      assert.deepStrictEqual(j.created, [card('designer'), adapter('designer')]);
      assert.ok(j.updated.includes(WORKFLOW) && j.updated.includes('AGENTS.md'), JSON.stringify(j));
    });
    const before = tree(ws);
    const add = wsg(['team', 'fullstack', '--without', 'devops'], { cwd: ws });
    const after = tree(ws);
    it('adding designer later touches only its files, the roles blocks and the state', () => {
      assert.strictEqual(add.code, 0, add.all);
      const changed = Object.keys(after).filter((k) => after[k] !== before[k]).sort();
      assert.deepStrictEqual(changed, ['.claude/agents/wsg-designer.md', '.claude/wsg.json', 'AGENTS.md', 'team/designer.md', 'team/workflow.md']);
    });
    it('the roles block is refreshed, the rest of the workflow is untouched', () => {
      const text = read(ws, WORKFLOW);
      assert.match(block(text, 'roles'), /`designer`/);
      assert.strictEqual(withoutBlock(text, 'roles'), withoutBlock(before[WORKFLOW], 'roles'));
    });
    it('the AGENTS.md block now names designer', () => assert.match(block(read(ws, 'AGENTS.md'), 'team'), /`designer`/));

    // A re-run that adds a role and rewrites the roles block of an existing workflow.md, then fails.
    const w = fresh('t2-fail');
    wsg(['team', 'fullstack', '--without', 'designer'], { cwd: w });
    fs.appendFileSync(path.join(w, WORKFLOW), '\nOur own note.\n');
    fs.chmodSync(path.join(w, 'AGENTS.md'), 0o444);
    const snap = tree(w);
    const failedRun = wsg(['team', 'fullstack'], { cwd: w });
    fs.chmodSync(path.join(w, 'AGENTS.md'), 0o644);
    if (!(process.getuid && process.getuid() === 0)) {
      it('a failed re-run puts the edited workflow.md back byte for byte and removes the new role', () => {
        assert.strictEqual(failedRun.code, 1, failedRun.all);
        assert.deepStrictEqual(tree(w), snap);
      });
    }
  }

  console.log('\nwsg team: invalid input changes nothing');
  {
    const ws = fresh('t3');
    const before = tree(ws);
    const cases = [
      ['no preset', ['team'], /specify the preset.*fullstack/],
      ['an unknown preset', ['team', 'backend-only'], /no preset backend-only: available — fullstack/],
      ['an unknown role in --without', ['team', 'fullstack', '--without', 'qa'], /no role qa; the roles are pm, designer, frontend, backend, devops, reviewer/],
      ['every role left out', ['team', 'fullstack', '--without', ALL.join(',')], /leaves no role/],
      ['an unknown flag', ['team', 'fullstack', '--bogus'], /unknown argument: --bogus/],
      ['two presets', ['team', 'fullstack', 'more'], /unexpected argument: more/],
    ];
    for (const [why, args, msg] of cases) {
      const r = wsg(args, { cwd: ws });
      it(`${why}: exit 2 with the valid values`, () => {
        assert.strictEqual(r.code, 2, r.all);
        assert.match(r.err, msg);
      });
    }
    const dry = wsg(['team', 'nope', '--dry-run'], { cwd: ws });
    it('a dry run with an error: exit 2, the error in the JSON', () => {
      assert.strictEqual(dry.code, 2, dry.all);
      assert.match(JSON.parse(dry.out).errors[0], /no preset nope/);
    });
    it('the workspace is untouched', () => assert.deepStrictEqual(tree(ws), before));
    const outside = wsg(['team', 'fullstack'], { cwd: tmp });
    it('outside a workspace: exit 2', () => {
      assert.strictEqual(outside.code, 2, outside.all);
      assert.match(outside.err, /not inside a wsg workspace/);
    });
    const legacy = path.join(wsRoot, 'old-one');
    fs.mkdirSync(path.join(legacy, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(legacy, '.claude', 'ws-kind'), 'task\n');
    fs.writeFileSync(path.join(legacy, 'CLAUDE.md'), '# old\n');
    const oldTree = tree(legacy);
    const old = wsg(['team', 'fullstack'], { cwd: legacy });
    it('a 0.1 workspace: exit 2, nothing written', () => {
      assert.strictEqual(old.code, 2, old.all);
      assert.match(old.err, /created by wsg 0\.1/);
      assert.deepStrictEqual(tree(legacy), oldTree);
    });
  }

  console.log('\nwsg team --dry-run');
  {
    const ws = fresh('t4');
    const before = tree(ws);
    const r = wsg(['team', 'fullstack', '--dry-run', '--ws', 't4']);
    it('exit 0 and touches nothing', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.deepStrictEqual(tree(ws), before);
    });
    it('lists what would be created and updated', () => {
      const j = JSON.parse(r.out);
      assert.strictEqual(j.workspace, ws);
      assert.deepStrictEqual(j.roles, ALL);
      assert.strictEqual(j.created.length, 14);
      assert.ok(j.created.includes(FEATURE));
      assert.deepStrictEqual(j.kept, []);
      assert.deepStrictEqual(j.updated, ['AGENTS.md', path.join('.claude', 'wsg.json')]);
      assert.deepStrictEqual(j.errors, []);
    });
  }

  console.log('\nwsg team: files that are not its to write');
  {
    const ws = fresh('t5');
    const own = '---\nname: wsg-reviewer\ndescription: ours\n---\n\nOur reviewer.\n';
    fs.writeFileSync(path.join(ws, adapter('reviewer')), own);
    const r = wsg(['team', 'fullstack'], { cwd: ws });
    it('an existing adapter that differs is kept as it is', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.strictEqual(read(ws, adapter('reviewer')), own);
      assert.match(r.out, /kept \.claude\/agents\/wsg-reviewer\.md/);
      assert.ok(fs.existsSync(path.join(ws, card('reviewer'))));
    });

    const target = path.join(tmp, 'elsewhere');
    fs.mkdirSync(target);
    const linked = [
      ['team/ is a symlink', 't6', (w) => fs.symlinkSync(target, path.join(w, 'team')), /team in .* is a symlink/],
      ['an adapter is a symlink', 't7', (w) => fs.symlinkSync(path.join(target, 'x.md'), path.join(w, adapter('pm'))), /wsg-pm\.md in .* is not a regular file/],
      ['team is a file', 't8', (w) => fs.writeFileSync(path.join(w, 'team'), 'x\n'), /team in .* is not a directory/],
    ];
    for (const [why, slug, make, msg] of linked) {
      const w = fresh(slug);
      make(w);
      const before = tree(w);
      const res = wsg(['team', 'fullstack'], { cwd: w });
      it(`${why}: exit 2, the tree unchanged`, () => {
        assert.strictEqual(res.code, 2, res.all);
        assert.match(res.err, msg);
        assert.deepStrictEqual(tree(w), before);
        assert.deepStrictEqual(fs.readdirSync(target), []);
      });
    }
  }

  console.log('\nwsg team in a process workspace');
  {
    const ws = fresh('p1', ['--kind', 'process', '--skill', 'release']);
    const skill = path.join('.claude', 'skills', 'release', 'SKILL.md');
    const skillBefore = read(ws, skill);
    const r = wsg(['team', 'fullstack'], { cwd: ws });
    it('exit 0, next step is the process skill', () => {
      assert.strictEqual(r.code, 0, r.all);
      assert.match(r.out, /\/release/);
      assert.doesNotMatch(r.all, /WARN/);
    });
    it('adapters and cards, no /wsg-feature', () => {
      for (const role of ALL) assert.ok(fs.existsSync(path.join(ws, adapter(role))), role);
      assert.ok(!fs.existsSync(path.join(ws, '.claude', 'skills', 'wsg-feature')));
    });
    it('the process skill gets the pointer block after its heading', () => {
      const text = read(ws, skill);
      assert.match(text, /^# p1\n<!-- wsg:team -->\n.*`team\/workflow\.md`.*\n<!-- \/wsg:team -->\n/m);
      assert.strictEqual(withoutBlock(text, 'team'), skillBefore);
    });
    it('the AGENTS.md block names the process skill', () => assert.match(block(read(ws, 'AGENTS.md'), 'team'), /`\/release` skill/));
    const before = tree(ws);
    wsg(['team', 'fullstack'], { cwd: ws });
    it('a re-run changes no byte', () => assert.deepStrictEqual(tree(ws), before));
    it('a comment in the frontmatter is no heading: the pointer goes after `# <title>`', () => {
      const w = fresh('p3', ['--kind', 'process', '--skill', 'deploy']);
      const rel = path.join('.claude', 'skills', 'deploy', 'SKILL.md');
      fs.writeFileSync(path.join(w, rel), read(w, rel).replace('disable-model-invocation: true\n', 'disable-model-invocation: true\n# keep manual\n'));
      const res = wsg(['team', 'fullstack'], { cwd: w });
      assert.strictEqual(res.code, 0, res.all);
      const text = read(w, rel);
      assert.match(text, /^# keep manual\n---\n/m);
      assert.match(text, /^# p3\n<!-- wsg:team -->\n/m);
    });
    it('a process with its skill gone: a warning, the rest is written', () => {
      const w = fresh('p2', ['--kind', 'process', '--skill', 'upgrade']);
      fs.rmSync(path.join(w, '.claude', 'skills', 'upgrade'), { recursive: true });
      const res = wsg(['team', 'fullstack'], { cwd: w });
      assert.strictEqual(res.code, 0, res.all);
      assert.match(res.out, /WARN.*SKILL\.md is missing/);
      assert.ok(fs.existsSync(path.join(w, WORKFLOW)));
      // A card new on a re-run is no reason to restart, even with .claude/skills/ gone.
      fs.rmSync(path.join(w, '.claude', 'skills'), { recursive: true });
      fs.rmSync(path.join(w, card('pm')));
      const again = wsg(['team', 'fullstack'], { cwd: w });
      assert.strictEqual(again.code, 0, again.all);
      assert.ok(fs.existsSync(path.join(w, card('pm'))));
      assert.doesNotMatch(again.out, /restart/);
    });
  }

  console.log('\nwsg team, then wsg promote');
  {
    const ws = fresh('t11');
    wsg(['team', 'fullstack'], { cwd: ws });
    const pr = wsg(['promote', 't11', '--skill', 'ship']);
    it('promote says to run wsg team again', () => {
      assert.match(pr.out, /run wsg team fullstack to point \/ship to team\/workflow\.md/);
      assert.match(pr.out, /wsg-feature\/ is kept/);
    });
    const again = wsg(['team', 'fullstack'], { cwd: ws });
    it('the re-run adds the pointer as a first insertion, without a warning', () => {
      assert.strictEqual(again.code, 0, again.all);
      assert.doesNotMatch(again.all, /WARN/);
      assert.match(read(ws, path.join('.claude', 'skills', 'ship', 'SKILL.md')), /<!-- wsg:team -->/);
      assert.match(block(read(ws, 'AGENTS.md'), 'team'), /`\/ship` skill/);
    });
    const skill = path.join(ws, '.claude', 'skills', 'ship', 'SKILL.md');
    fs.writeFileSync(skill, withoutBlock(fs.readFileSync(skill, 'utf8'), 'team'));
    const third = wsg(['team', 'fullstack'], { cwd: ws });
    it('a pointer deleted by hand after that is put back with a warning', () => {
      assert.strictEqual(third.code, 0, third.all);
      assert.match(third.out, /wsg:team --> markers were missing/);
    });
  }

  console.log('\na broken team in wsg.json refuses every command');
  {
    const stateOf = (w) => path.join(w, '.claude', 'wsg.json');
    const broken = [
      ['no roles', { preset: 'fullstack' }],
      ['a role that is not kebab-case', { preset: 'fullstack', roles: ['pm', 'x\n<!-- /wsg:team -->'] }],
      ['roles not a list', { preset: 'fullstack', roles: 'pm' }],
    ];
    for (const [why, bad] of broken) {
      const w = fresh(`t12-${broken.findIndex((x) => x[0] === why)}`);
      const s = JSON.parse(read(w, stateOf(w).slice(w.length + 1)));
      fs.writeFileSync(stateOf(w), JSON.stringify({ ...s, team: bad }, null, 2));
      const before = tree(w);
      for (const args of [['refresh'], ['add', api, '--link'], ['team', 'fullstack']]) {
        const res = wsg(args, { cwd: w });
        it(`${why}: wsg ${args[0]} exits 2 and changes nothing`, () => {
          assert.strictEqual(res.code, 2, res.all);
          assert.match(res.err, /"team" is not \{ preset, roles \}/);
          assert.deepStrictEqual(tree(w), before);
        });
      }
    }
  }

  console.log('\nwsg team: a failure rolls everything back');
  {
    const ws = fresh('t9');
    // Without .claude/agents the run makes it, and the rollback has to take it away again.
    fs.rmdirSync(path.join(ws, '.claude', 'agents'));
    fs.chmodSync(path.join(ws, 'AGENTS.md'), 0o444);
    const before = tree(ws);
    const r = wsg(['team', 'fullstack'], { cwd: ws });
    fs.chmodSync(path.join(ws, 'AGENTS.md'), 0o644);
    if (process.getuid && process.getuid() === 0) {
      console.log('  skip  running as root: a read-only file is still writable');
    } else {
      it('the run fails and rolls back', () => {
        assert.strictEqual(r.code, 1, r.all);
        assert.match(r.err, /Adding the team aborted/);
        assert.doesNotMatch(r.out, /files written/);
      });
      it('no new file or directory is left, the rest is byte-identical', () => assert.deepStrictEqual(tree(ws), before));
    }
    const ok = wsg(['team', 'fullstack'], { cwd: ws });
    it('the next run works and says to restart for the new .claude/agents', () => {
      assert.strictEqual(ok.code, 0, ok.all);
      assert.match(ok.out, /restart the agent session/);
    });
  }

  console.log('\nwsg team: one command at a time');
  {
    const ws = fresh('t10');
    const lock = path.join(ws, '.claude', 'wsg.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
    const r = wsg(['team', 'fullstack'], { cwd: ws });
    it('a held lock: exit 2, nothing written', () => {
      assert.strictEqual(r.code, 2, r.all);
      assert.match(r.err, /another wsg command is running/);
      assert.ok(!fs.existsSync(path.join(ws, 'team')));
      assert.ok(fs.existsSync(lock));
    });
    fs.rmSync(lock);
  }

  console.log('\nthe usage');
  it('names wsg team and its flags', () => assert.match(wsg(['--help']).out, /wsg team <preset> \[--without ROLE,\.\.\.\] \[--dry-run\] \[--ws SLUG\|PATH\]/));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed === 0 ? '\nall checks passed\n' : `\nfailed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
