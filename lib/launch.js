'use strict';

// `wsg new` hands the setup over to the agent: it starts the agent in the new workspace with a
// first message that opens the setup dialogue. The workspace is the session's start directory —
// settings, rules and skills load only from there.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sh } = require('./templates');

// First messages. Claude Code has the workspace's /wsg-setup skill; codex has no slash skills of
// its own, so it is pointed at SETUP.md, which says the same.
const PROMPT = { claude: '/wsg-setup', codex: 'Read SETUP.md and follow it.' };

// Which agent a command line starts: the first word after VAR=value prefixes, by basename —
// `claude --model opus`, `/opt/bin/claude`, `CLAUDE_CONFIG_DIR=… claude`. The same rule as ws.
function agentKind(cmd) {
  const words = String(cmd || '').trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  const base = path.basename((words[i] || '').replace(/^['"]|['"]$/g, ''));
  return base === 'claude' || base === 'codex' ? base : 'other';
}

function onPath(name, env = process.env) {
  return (env.PATH || '').split(path.delimiter).some((dir) => {
    if (!dir) return false;
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// WSG_AGENT, or claude when it is installed: the setup skill is written for it.
const resolveAgent = (cfg, env = process.env) => cfg.WSG_AGENT || (onPath('claude', env) ? 'claude' : '');

// The command to run, or none for an agent wsg doesn't know how to give a first message to.
// WSG_AGENT is a shell command line from the user's own config (aliases aside, the same as ws runs),
// so it goes through sh; the prompt is passed as $1, never pasted into the line.
function launchCommand(agent, ws) {
  const kind = agentKind(agent);
  const cd = `cd ${sh(ws)} && `;
  if (kind === 'other') return { kind, display: `${cd}${agent}` };
  return {
    kind,
    file: '/bin/sh',
    args: ['-c', `${agent} "$1"`, 'sh', PROMPT[kind]],
    display: `${cd}${agent} "${PROMPT[kind]}"`,
  };
}

// Only into a terminal: piped, in a script or a test, the agent would start without one to talk in.
// WSG_NO_LAUNCH=1 opts out for a whole environment, --no-launch for one call.
function shouldLaunch({ noLaunch = false, env = process.env, stdin = process.stdin, stdout = process.stdout } = {}) {
  return !noLaunch && env.WSG_NO_LAUNCH !== '1' && !!stdin.isTTY && !!stdout.isTTY;
}

function run(cmd, ws) {
  const r = spawnSync(cmd.file, cmd.args, { cwd: ws, stdio: 'inherit' });
  return { ok: !r.error, error: r.error, status: r.status };
}

module.exports = { PROMPT, agentKind, onPath, resolveAgent, launchCommand, shouldLaunch, run };
