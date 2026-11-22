#!/usr/bin/env bash
#
# Smoke test against the real Claude Code. Manual, not part of npm test: it needs claude on PATH,
# a logged-in account and the network, and it spends a few requests on a small model.
#
#   test/smoke-claude.sh [model]          default: haiku
#
# What it checks, each in a fresh workspace under a temp dir:
#   1. A session starts in the workspace; wsg-setup is manual-only, so the model doesn't list it.
#   2. Open item 3: `claude -p "/wsg-setup"` runs the skill, and the skill runs `wsg guide setup`.
#   3. Open item 2: a directory `wsg add --reference` writes into additionalDirectories while a
#      session runs — readable in that session? In a new one? A directory never attached is the
#      control: it must stay unreadable, or the other two prove nothing.
#   4. The wsg-advisor agent: in the `agents` of the stream-json init event; run with --agent and
#      asked to edit notes.md, it leaves the file unchanged (no Write or Edit tool, and its hook
#      blocks a Bash write); a plain read command still runs, and so does wsg by the CLI path its
#      agent file names (`node "<bin/cli.js>" --version`).
#   5. The team (`wsg team fullstack`): the six wsg-<role> agents are in the init event's agents in
#      the workspace and absent from its parent; a read-only role run with --agent has no Write,
#      Edit or NotebookEdit tool; asked to edit notes.md anyway, what it does is printed as info
#      (it keeps Bash, so it may write: a known limit, not asserted). Open item 1, as info: a
#      session that runs `wsg team` itself, then calls a role it just wrote — picked up live?
#      Role memory is not checked: it needs a config dir of its own, and a temp CLAUDE_CONFIG_DIR
#      has no login. The team's agents are project-level, written by wsg team in the temp workspace.
#   6. An epic and its task (`wsg new --kind epic`, then `wsg new --epic`): `wsg check` passes on
#      both. Two sessions in the task directory. One with the Skill tool alone: the epic's
#      wsg-epic-* skills are in the init event's skills but not offered to the model (manual-only),
#      while a model-invocable control skill added to the epic is; it quotes a marker put into the
#      epic's pointer rule. The other reads a marker line of ../knowledge.md with the Read tool.
#   7. The task's status, wsg only, no model: `wsg list --json` shows the task of step 6 open;
#      `wsg status <epic>/<task> review`, then `wsg close <epic>/<task>`; `wsg list --json` and the
#      epic's tasks.md show it done with today's date.
#   8. Opt-in (WSG_SMOKE_MCP=1), no model: an epic's MCP servers (`wsg mcp`). An epic gets a stdio
#      server (a dummy one written to the temp dir) and turns off a global one; in its task,
#      `claude mcp list` names the epic's server and not the one turned off, while a global server
#      the epic leaves on is listed (the control). It runs with a CLAUDE_CONFIG_DIR of its own in
#      the temp dir, whose .claude.json holds the two global servers: the user's config is not read
#      or touched, and no login is needed. WSG_SMOKE_ONLY=mcp runs this step alone — then nothing
#      of the steps above runs, the advisor agent is not installed and no model is asked.
#   9. Opt-in (WSG_SMOKE_08=1), no model, no claude: what wsg 0.8 adds, in a scratch WS_ROOT with a
#      temp repository. `wsg new --no-code` (no repository, noCode in list --json); a task with a
#      worktree archived (`wsg archive`: the worktree gone, the branch kept, list says archived) and
#      unarchived (the worktree back on the branch, status open); `wsg reorder` of an epic's task
#      directories and of its tracker tasks under "## Other tasks", the order in tasks.md and in
#      wsg list --json; and what 0.8.1 adds: `wsg move` of a task with a worktree into the epic and
#      out again, the worktree usable at each place, tasks.md following, wsg check clean; and what
#      0.9.0 adds: `wsg promote` of a task with a link into an epic in place (the dry run changes
#      nothing, the link and notes stay, wsg check clean, a task made in it), and of a hand-made
#      workspace without .claude/wsg.json, its repository symlink taken as a source.
#      WSG_SMOKE_ONLY=v08 runs this step alone: claude need not be installed, and nothing under the
#      user's config dir is touched.
#
# The agent is the user-level one: for the run, this checkout's agent is rendered into
# ${CLAUDE_CONFIG_DIR:-~/.claude}/agents/wsg-advisor.md, as `wsg install-skills` would write it,
# with its hook pointing at this checkout's lib/advisor-guard.js. A wsg-advisor.md already there is
# moved to wsg-advisor.md.wsg-test-backup next to it and put back when the script exits, Ctrl+C
# included; after a SIGKILL the next run of either script does it (test/advisor-agent.sh). One run
# of the two scripts at a time: a second one stops at start while the first holds the lock. Other Claude Code
# sessions of this user see this checkout's agent meanwhile. No other file in that dir is touched,
# apart from the session history Claude Code keeps for the temp workspaces, removed at the end.
#
# Outcome recorded on 2026-10-21 with Claude Code 2.1.306 and haiku:
#   1 and 2 pass. 3 was inconclusive: the never-attached control directory was readable as well
#   (reads outside the workspace were allowed by that user's own settings), so open item 2 stays
#   unverified; `wsg add` keeps printing its restart notice when settings.json changes.
#   In -p mode a workspace whose trust dialog was never accepted ignores permissions.allow from
#   its .claude/settings.json (Claude Code says so on stderr); see README, Limitations.
# Outcome recorded on 2026-10-23 for step 4, with a project-level copy of the agent: the advisor
# appended to notes.md with Bash `printf … >>`; the prompt rule alone does not hold. Hence the
# guard hook, and the user-level agent: a project-level one in an untrusted folder skips its hooks.
# Outcome recorded on 2026-10-27 for step 5, with Claude Code 2.1.311 and haiku: the asserted parts
#   pass. Mid-session pickup (open item 1): not picked up — a session that ran `wsg team fullstack`
#   in a workspace whose .claude/agents/ existed at start got "Agent type 'wsg-pm' not found"; hence
#   `wsg team` asks for a new session whenever it adds an adapter. wsg-reviewer, asked to edit
#   notes.md with acceptEdits, left it unchanged.
# Outcome recorded on 2026-11-14 for step 6, with Claude Code 2.1.323 and haiku: all pass. The
#   init event lists the epic's manual-only skills and the control skill; the model, with the Skill
#   tool alone, names only the control one and quotes the rule's marker; ../knowledge.md is read
#   with the Read tool. With --tools "" the model is offered no skill at all, the control included.
# Outcome recorded on 2026-11-16 for step 8 (WSG_SMOKE_ONLY=mcp), with Claude Code 2.1.325: all
#   pass. In the task, never trusted, the epic's server is listed as "Pending approval"; the denied
#   global server is not listed; the control is connected.
#
# The temp dir and the session history Claude Code keeps for it are removed at the end.

set -euo pipefail

MODEL="${1:-haiku}"
MCP_ONLY=no; [ "${WSG_SMOKE_ONLY:-}" = mcp ] && MCP_ONLY=yes
V08_ONLY=no; [ "${WSG_SMOKE_ONLY:-}" = v08 ] && V08_ONLY=yes
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "$V08_ONLY" = yes ] || command -v claude >/dev/null || { echo "claude is not on PATH" >&2; exit 1; }
command -v node >/dev/null || { echo "node is not on PATH" >&2; exit 1; }

# The user-level advisor for the run, and what a killed run left behind: test/advisor-agent.sh.
SCRIPT="test/smoke-claude.sh"
# shellcheck source=test/advisor-agent.sh
. "$SRC/test/advisor-agent.sh"
# Step 8 alone installs no agent: nothing under the user's config dir is touched.
[ "$MCP_ONLY" = yes ] || [ "$V08_ONLY" = yes ] || recover_advisor
TMP="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/wsg-smoke-XXXXXX")" && pwd -P)"
PROJECTS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
session_dir() { printf '%s/%s' "$PROJECTS" "$(printf '%s' "$1" | sed 's/[^a-zA-Z0-9]/-/g')"; }
WORKSPACES=()
cleanup() {
  restore_advisor
  for w in "${WORKSPACES[@]}"; do rm -rf "$(session_dir "$w")"; done
  rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# This checkout's wsg, whatever else is installed.
mkdir -p "$TMP/bin"
printf '#!/bin/sh\nexec node %q "$@"\n' "$SRC/bin/cli.js" > "$TMP/bin/wsg"
chmod +x "$TMP/bin/wsg"
export PATH="$TMP/bin:$PATH" WS_ROOT="$TMP/ws" WSG_CONFIG="$TMP/no-config" WSG_LANG=en WSG_NO_LAUNCH=1

git init -q -b main "$TMP/repo"
git -C "$TMP/repo" -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m init
mkdir -p "$TMP/ref" "$TMP/control"
echo "REF-TOKEN-7d1" > "$TMP/ref/token.txt"
echo "CONTROL-TOKEN-3f9" > "$TMP/control/token.txt"

# Not in $(…): the cleanup list must be filled in this shell.
fresh() {
  wsg new "$1" --no-launch >/dev/null
  wsg add "$TMP/repo" --branch "smoke/$1" --ws "$1" >/dev/null
  WORKSPACES+=("$WS_ROOT/$1")
}
# ask <dir> <prompt> [options]: the prompt goes first, since --allowedTools takes a list.
# No MCP servers: no check needs one, and a long tool list makes every request cost more.
ask() { local dir="$1" prompt="$2"; shift 2; (cd "$dir" && claude -p "$prompt" --model "$MODEL" --strict-mcp-config "$@" 2>/dev/null) || true; }
pass=0 fail=0
report() { if [ "$2" = yes ]; then echo "  ok    $1"; pass=$((pass + 1)); else echo "  FAIL  $1"; fail=$((fail + 1)); fi; }
has() { case "$1" in *"$2"*) echo yes ;; *) echo no ;; esac; }
hasnt() { case "$1" in *"$2"*) echo no ;; *) echo yes ;; esac; }
# The agents (or the tools) Claude Code loaded, one per line, from the init event of a stream-json
# reply — not the model's words, which could name an agent just because a file does.
init_list() {
  printf '%s' "$1" | node -e '
    const key = process.argv[1];
    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      const init = s.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .find((e) => e && e.type === "system" && e.subtype === "init");
      const list = (init && Array.isArray(init[key]) ? init[key] : []).map((a) => (typeof a === "string" ? a : a && a.name));
      process.stdout.write(list.join("\n"));
    });' "$2"
}
# The text of every tool result in a stream-json reply, one per line.
tool_results() {
  printf '%s' "$1" | node -e '
    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      const out = [];
      for (const l of s.split("\n")) {
        let e; try { e = JSON.parse(l); } catch { continue; }
        const content = e && e.type === "user" && e.message && Array.isArray(e.message.content) ? e.message.content : [];
        for (const c of content) {
          if (c && c.type === "tool_result") out.push(typeof c.content === "string" ? c.content : JSON.stringify(c.content));
        }
      }
      process.stdout.write(out.join("\n").replace(/\n/g, " "));
    });'
}
# The reply of a stream-json run: the result of its result event.
reply_of() {
  printf '%s' "$1" | node -e '
    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      const r = s.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .find((e) => e && e.type === "result");
      process.stdout.write(r && typeof r.result === "string" ? r.result : "");
    });'
}
listed() { printf '%s\n' "$1" | grep -qx "$2" && echo yes || echo no; }
# The first 300 characters of a reply, on one line. Not `head -c | tr`: a byte cut splits a
# multibyte character, and tr in a UTF-8 locale stops on it with "Illegal byte sequence".
snippet() { local s="${1//$'\n'/ }"; printf '%s' "${s:0:300}"; }

# 8. An epic's MCP servers in a task, as `claude mcp list` there sees them. No model.
mcp_step() {
  echo "8. an epic's MCP servers: claude mcp list in its task (no model)"
  local srv="$TMP/bin/dummy-mcp.js" cfg="$TMP/mcp-config" e t out
  cat > "$srv" <<'JS'
// A stdio MCP server that answers initialize and tools/list, enough for a health check.
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
rl.on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: process.argv[2] || 'dummy', version: '0.0.1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [] } });
  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
JS
  mkdir -p "$cfg"
  node -e 'const [file, srv] = process.argv.slice(1);
    const s = (n) => ({ command: "node", args: [srv, n] });
    require("fs").writeFileSync(file, JSON.stringify({ mcpServers: { smokeoff: s("smokeoff"), smokeon: s("smokeon") } }));' "$cfg/.claude.json" "$srv"
  wsg new mcpe --kind epic --no-launch >/dev/null
  wsg new mcpe-a --epic mcpe --no-launch >/dev/null
  e="$WS_ROOT/mcpe"; t="$e/mcpe-a"
  CLAUDE_CONFIG_DIR="$cfg" wsg mcp add smokeepic --ws mcpe -- node "$srv" smokeepic >/dev/null
  CLAUDE_CONFIG_DIR="$cfg" wsg mcp disable smokeoff --ws mcpe >/dev/null
  report "the task's settings.json enables the epic's server and denies the global one" \
    "$(grep -q '"smokeepic"' "$t/.claude/settings.json" && grep -q '"serverName": "smokeoff"' "$t/.claude/settings.json" && echo yes || echo no)"
  out="$(cd "$t" && CLAUDE_CONFIG_DIR="$cfg" claude mcp list 2>&1)" || true
  report "claude mcp list in the task names the epic's server" "$(has "$out" smokeepic)"
  report "and not the global server the epic turns off" "$(hasnt "$out" smokeoff)"
  report "a global server the epic leaves on is listed (the control)" "$(has "$out" smokeon)"
  echo "  info  $(snippet "$out")"
}
# 9. What wsg 0.8 adds, with wsg alone: a task without code, archive and unarchive, reorder, move,
# promote. No model.
v08_step() {
  echo "9. wsg 0.8 and 0.9: --no-code, archive and unarchive, reorder, move, promote (no model)"
  local nc="$WS_ROOT/v08-spec" ar="$WS_ROOT/v08-arc" ep="$WS_ROOT/v08-epic" field
  # A field of a workspace in wsg list --json: v08_field <slug> <expression on the entry e>.
  v08_field() {
    wsg list --json | node -e '
      let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
        const e = JSON.parse(s).result.workspaces.find((w) => w.slug === process.argv[1]);
        process.stdout.write(String(e ? eval(process.argv[2]) : "missing"));
      });' "$1" "$2"
  }
  wsg new v08-spec --no-code --no-launch >/dev/null && ok=yes || ok=no
  report "wsg new --no-code" "$ok"
  report "list --json: noCode true, no sources" "$([ "$(v08_field v08-spec 'e.noCode + " " + e.sources.length')" = "true 0" ] && echo yes || echo no)"
  report "no repository in it: no repo pointer" "$([ ! -e "$nc/repo" ] && echo yes || echo no)"

  wsg new v08-arc --no-launch >/dev/null
  wsg add "$TMP/repo" --branch smoke/v08-arc --ws v08-arc >/dev/null
  report "wsg archive --dry-run changes nothing" "$(wsg archive v08-arc --dry-run >/dev/null && [ -d "$ar/repo" ] && echo yes || echo no)"
  wsg archive v08-arc >/dev/null && ok=yes || ok=no
  report "wsg archive" "$ok"
  report "the worktree is gone, the branch kept" "$([ ! -e "$ar/repo" ] && git -C "$TMP/repo" rev-parse -q --verify refs/heads/smoke/v08-arc >/dev/null && echo yes || echo no)"
  report "list --json: archived, its source in archivedSources" "$([ "$(v08_field v08-arc 'e.status + " " + e.archivedSources.length')" = "archived 1" ] && echo yes || echo no)"
  wsg unarchive v08-arc >/dev/null && ok=yes || ok=no
  report "wsg unarchive" "$ok"
  report "the worktree is back on its branch, status open" "$([ "$(git -C "$ar/repo" branch --show-current 2>/dev/null) $(wsg status v08-arc)" = "smoke/v08-arc open" ] && echo yes || echo no)"

  wsg new v08-epic --kind epic --no-launch >/dev/null
  for t in a-one b-two c-three; do wsg new "$t" --epic v08-epic --no-code --no-launch >/dev/null; done
  wsg reorder c-three --to 1 --ws v08-epic --dry-run >/dev/null && ok=yes || ok=no
  report "wsg reorder --dry-run" "$ok"
  wsg reorder c-three --to 1 --ws v08-epic >/dev/null && ok=yes || ok=no
  report "wsg reorder of a task directory" "$ok"
  report "list --json: the epic's tasks in the new order" "$([ "$(v08_field v08-epic 'e.tasks.map((t) => t.slug).join(",")')" = "c-three,a-one,b-two" ] && echo yes || echo no)"
  report "tasks.md: the block in the new order" "$(has "$(tr '\n' ' ' < "$ep/tasks.md")" '- `c-three/` - `a-one/` - `b-two/`')"
  printf -- '- ACME-1 first\n- ACME-2 second\n  a line under it\n' >> "$ep/tasks.md"
  wsg reorder ACME-2 --before ACME-1 --ws v08-epic >/dev/null && ok=yes || ok=no
  report "wsg reorder of a tracker task under Other tasks" "$ok"
  report "list --json: trackerTasks in the new order" "$([ "$(v08_field v08-epic 'e.trackerTasks.map((t) => t.id).join(",")')" = "ACME-2,ACME-1" ] && echo yes || echo no)"
  report "wsg check sees no drift in tasks.md" "$(hasnt "$(wsg check v08-epic 2>&1)" 'lists other tasks')"

  # wsg 0.8.1: a task with a worktree moved into the epic and out again, the worktree usable at each place.
  local mv="$WS_ROOT/v081-mv"
  wsg new v081-mv --no-launch >/dev/null
  wsg add "$TMP/repo" --branch smoke/v081-mv --ws v081-mv >/dev/null
  report "wsg move --dry-run changes nothing" "$(wsg move v081-mv --epic v08-epic --dry-run >/dev/null && [ -d "$mv/repo" ] && [ ! -e "$ep/v081-mv" ] && echo yes || echo no)"
  wsg move v081-mv --epic v08-epic >/dev/null && ok=yes || ok=no
  report "wsg move into the epic" "$ok"
  report "the worktree is usable there, on its branch" "$([ "$(git -C "$ep/v081-mv/repo" branch --show-current 2>/dev/null)" = smoke/v081-mv ] && echo yes || echo no)"
  report "tasks.md lists the task" "$(has "$(cat "$ep/tasks.md")" '- `v081-mv/`')"
  report "wsg check of the moved task finds no error" "$(wsg check v08-epic/v081-mv >/dev/null 2>&1 && echo yes || echo no)"
  wsg move v08-epic/v081-mv --out >/dev/null && ok=yes || ok=no
  report "wsg move --out" "$ok"
  report "the worktree is usable back in WS_ROOT, the epic's tasks.md without it" "$([ "$(git -C "$mv/repo" branch --show-current 2>/dev/null)" = smoke/v081-mv ] && [ "$(hasnt "$(cat "$ep/tasks.md")" 'v081-mv')" = yes ] && echo yes || echo no)"

  # wsg 0.9.0: a task with a link becomes an epic in place; so does a hand-made workspace.
  local pr="$WS_ROOT/v09-pr" hand="$WS_ROOT/v09-hand"
  wsg new v09-pr --no-launch >/dev/null
  wsg add "$TMP/repo" --link --ws v09-pr >/dev/null
  printf '\nA note of the owner.\n' >> "$pr/notes.md"
  report "wsg promote --dry-run changes nothing" "$(wsg promote v09-pr --dry-run >/dev/null && [ "$(cat "$pr/.claude/ws-kind")" = task ] && [ ! -e "$pr/knowledge.md" ] && echo yes || echo no)"
  wsg promote v09-pr >/dev/null 2>&1 && ok=yes || ok=no
  report "wsg promote" "$ok"
  report "list --json: an epic, its link source kept" "$([ "$(v08_field v09-pr 'e.kind + " " + e.sources.length')" = "epic 1" ] && [ -L "$pr/repo" ] && echo yes || echo no)"
  report "notes.md kept, the epic files made" "$([ "$(has "$(cat "$pr/notes.md")" 'A note of the owner.')" = yes ] && [ -f "$pr/knowledge.md" ] && [ -f "$pr/tasks.md" ] && echo yes || echo no)"
  report "wsg check of the new epic finds no error" "$(wsg check v09-pr >/dev/null 2>&1 && echo yes || echo no)"
  wsg new v09-pr-a --epic v09-pr --no-code --no-launch >/dev/null && ok=yes || ok=no
  report "a task made in it, listed in its tasks.md" "$([ "$ok" = yes ] && has "$(cat "$pr/tasks.md")" '- `v09-pr-a/`' || echo no)"
  mkdir -p "$hand/.claude"
  echo task > "$hand/.claude/ws-kind"
  printf '# hand\n\n## Why\n\nA hand-made workspace.\n' > "$hand/AGENTS.md"
  printf '# hand\n\n@AGENTS.md\n' > "$hand/CLAUDE.md"
  ln -s "$TMP/repo" "$hand/app"
  wsg promote v09-hand >/dev/null 2>&1 && ok=yes || ok=no
  report "wsg promote of a workspace without .claude/wsg.json" "$ok"
  report "its repository symlink is a source now, the link as it was" "$([ "$(v08_field v09-hand 'e.kind + " " + e.sources.map((s) => s.name).join(",")')" = "epic app" ] && [ "$(readlink "$hand/app")" = "$TMP/repo" ] && echo yes || echo no)"
}
if [ "$V08_ONLY" = yes ]; then
  v08_step
  echo
  echo "passed: $pass, failed: $fail"
  [ "$fail" = 0 ]
  exit
fi
if [ "$MCP_ONLY" = yes ]; then
  mcp_step
  echo
  echo "passed: $pass, failed: $fail"
  [ "$fail" = 0 ]
  exit
fi

echo "1. a session starts in the workspace"
fresh one; W1="$WS_ROOT/one"
out="$(ask "$W1" "Without tools: list the skill names available to you that start with wsg-, or say NONE. Then print the directory you were started in.")"
report "the session starts in the workspace" "$(has "$out" "$W1")"
report "wsg-setup is not offered to the model" "$(hasnt "$out" wsg-setup)"

echo "2. /wsg-setup runs the guide (open item 3)"
fresh two; W2="$WS_ROOT/two"
out="$(ask "$W2" /wsg-setup --max-turns 2 --output-format stream-json --verbose)"
report "the skill ran wsg guide setup" "$(has "$out" 'wsg guide setup')"
report "and got the guide back" "$(has "$out" 'wsg setup guide')"

echo "3. additionalDirectories added during a session (open item 2)"
fresh three; W3="$WS_ROOT/three"
read_prompt() { printf 'Use the Read tool on %s and reply with its single line only. If you cannot read it, reply NO-ACCESS.' "$1"; }
control="$(ask "$W3" "$(read_prompt "$TMP/control/token.txt")" --max-turns 3 --allowedTools 'Bash(wsg *)')"
mid="$(ask "$W3" "Run exactly: wsg add $TMP/ref --reference --note smoke. Then $(read_prompt "$TMP/ref/token.txt")" --max-turns 6 --allowedTools 'Bash(wsg *)')"
after="$(ask "$W3" "$(read_prompt "$TMP/ref/token.txt")" --max-turns 3 --allowedTools 'Bash(wsg *)')"
grep -q "$TMP/ref" "$W3/.claude/settings.json" && attached=yes || attached=no
report "wsg add wrote it into settings.json" "$attached"
if [ "$(has "$control" CONTROL-TOKEN)" = yes ]; then
  # Reads outside the workspace are allowed anyway here (user-level settings, a permission mode):
  # the two reads below can't tell additionalDirectories apart from that.
  echo "  info  inconclusive: a directory never attached is readable too, so this can't be decided here"
else
  echo "  info  readable in the same session: $(has "$mid" REF-TOKEN)"
  echo "  info  readable in a new session:    $(has "$after" REF-TOKEN)"
fi

echo "4. the wsg-advisor agent"
fresh four; W4="$WS_ROOT/four"
install_advisor
# The agents Claude Code loaded, from the init event of the stream — not the model's reply, which
# could name wsg-advisor just because AGENTS.md does.
out="$(ask "$W4" "Reply OK." --max-turns 1 --output-format stream-json --verbose)"
agents="$(init_list "$out" agents)"
report "wsg-advisor is in the agents of the init event" "$(listed "$agents" wsg-advisor)"
before="$(shasum "$W4/notes.md")"
out="$(ask "$W4" "Append the line SMOKE-EDIT-5c2 to notes.md in the current directory." --agent wsg-advisor --max-turns 4 --permission-mode acceptEdits)"
after="$(shasum "$W4/notes.md")"
report "asked to edit notes.md, the advisor leaves it unchanged" "$([ "$before" = "$after" ] && echo yes || echo no)"
echo "  info  its reply: $(snippet "$out")"
# The guard must not block what the advisor is meant to do: a plain read command runs.
out="$(ask "$W4" "Run exactly this Bash command and reply with its output only: git -C $TMP/repo log -1 --format=%s" --agent wsg-advisor --max-turns 3 --allowedTools 'Bash(git *)')"
report "a plain read command still runs (git log)" "$(has "$out" init)"
# The advisor's only wsg: this checkout's CLI by its path, as the agent file names it.
CLI="$SRC/bin/cli.js"
out="$(ask "$W4" "Run exactly this Bash command and reply with its output only: node \"$CLI\" --version" --agent wsg-advisor --max-turns 3 --allowedTools "Bash(node *)")"
report "wsg runs by the CLI path (node <cli> --version)" "$(has "$out" "$(node "$CLI" --version)")"

echo "5. the team"
fresh five; W5="$WS_ROOT/five"
wsg team fullstack --ws five >/dev/null
ROLES="pm designer frontend backend devops reviewer"
agents="$(init_list "$(ask "$W5" "Reply OK." --max-turns 1 --output-format stream-json --verbose)" agents)"
all=yes; for r in $ROLES; do [ "$(listed "$agents" "wsg-$r")" = yes ] || all=no; done
report "the six wsg-<role> agents are in the init event in the workspace" "$all"
# The parent holds the workspaces, not their .claude/: none of the roles there.
WORKSPACES+=("$WS_ROOT")
agents="$(init_list "$(ask "$WS_ROOT" "Reply OK." --max-turns 1 --output-format stream-json --verbose)" agents)"
none=yes; for r in $ROLES; do [ "$(listed "$agents" "wsg-$r")" = no ] || none=no; done
report "and absent from the workspace's parent" "$none"
# A read-only role: its disallowedTools take the file tools away. An empty list proves nothing.
tools="$(init_list "$(ask "$W5" "Reply OK." --agent wsg-reviewer --max-turns 1 --output-format stream-json --verbose)" tools)"
nofile=no
if [ -n "$tools" ]; then
  nofile=yes; for x in Write Edit NotebookEdit; do [ "$(listed "$tools" "$x")" = no ] || nofile=no; done
fi
report "wsg-reviewer has tools, but no Write, Edit or NotebookEdit" "$nofile"
before="$(shasum "$W5/notes.md")"
out="$(ask "$W5" "Append the line SMOKE-EDIT-9e4 to notes.md in the current directory." --agent wsg-reviewer --max-turns 4 --permission-mode acceptEdits)"
after="$(shasum "$W5/notes.md")"
echo "  info  asked to edit notes.md, wsg-reviewer changed it: $([ "$before" = "$after" ] && echo no || echo yes) (it keeps Bash: a known limit)"
echo "  info  its reply: $(snippet "$out")"
# Open item 1: agents written mid-session. One session runs wsg team in a workspace whose
# .claude/agents/ existed when it started (wsg new makes it), then calls a role it just wrote.
fresh six; W6="$WS_ROOT/six"
out="$(ask "$W6" "Run exactly this Bash command: wsg team fullstack. Then use the Agent tool with subagent_type wsg-pm and the prompt: Reply PONG-4b7 and nothing else. Finally reply with what the subagent returned, or the error you got." --max-turns 6 --allowedTools 'Bash(wsg *)' --output-format stream-json --verbose)"
[ -f "$W6/team/workflow.md" ] && ran=yes || ran=no
results="$(tool_results "$out")"
echo "  info  mid-session: wsg team ran: $ran; wsg-pm answered: $(has "$results" PONG-4b7)"
echo "  info  tool results: $(snippet "$results")"
echo "  info  role memory: not checked (a temp CLAUDE_CONFIG_DIR would have no login)"

echo "6. an epic and its task"
# The epic links the repository with a branch template, so the task gets a worktree from it.
wsg new seven --kind epic --no-launch >/dev/null
wsg add "$TMP/repo" --branch-template 'smoke/{slug}' --ws seven >/dev/null
wsg new seven-a --epic seven --no-launch >/dev/null
E7="$WS_ROOT/seven"; W7="$E7/seven-a"
WORKSPACES+=("$W7")
echo "KNOW-TOKEN-2c8" >> "$E7/knowledge.md"
for t in seven seven/seven-a; do
  chk="$(wsg check "$t" 2>&1)" && ok=yes || ok=no
  report "wsg check $t passes" "$ok"
  [ "$ok" = yes ] || echo "  info  $(snippet "$(printf '%s\n' "$chk" | grep FAIL)")"
done
# A marker in the epic's pointer rule, and a control skill the model may call: written after
# wsg check, which knows neither. A model that answers NONE without looking fails the control.
printf '\nSmoke marker: RULE-TOKEN-6f1\n' >> "$E7/.claude/rules/epic-knowledge.md"
mkdir -p "$E7/.claude/skills/wsg-epic-smoke"
printf -- '---\nname: wsg-epic-smoke\ndescription: A control skill of the wsg smoke test; it does nothing.\n---\n\nReply SMOKE.\n' > "$E7/.claude/skills/wsg-epic-smoke/SKILL.md"
# Only the Skill tool: --tools "" hides the skills from the model too. Skill reads no file, so
# the token in this reply can only come from the loaded rule.
out="$(ask "$W7" "Without tools, reply with exactly two lines. Line 1: the names of the skills available to you that start with wsg-epic, comma-separated, or NONE. Line 2: the token in your instructions that starts with RULE-TOKEN-, or NO-RULE." --max-turns 1 --tools Skill --output-format stream-json --verbose)"
skills="$(init_list "$out" skills)"
all=yes; for x in task close sync smoke; do [ "$(listed "$skills" "wsg-epic-$x")" = yes ] || all=no; done
report "the epic's wsg-epic-* skills and the control skill are in the init event's skills" "$all"
report "the session's only tool is Skill" "$([ "$(init_list "$out" tools)" = Skill ] && echo yes || echo no)"
reply="$(reply_of "$out")"
report "the model is offered the control skill" "$(has "$reply" wsg-epic-smoke)"
offered=no; for x in task close sync; do [ "$(has "$reply" "wsg-epic-$x")" = no ] || offered=yes; done
report "but not the three wsg-epic-* skills (manual-only)" "$([ -n "$reply" ] && [ "$offered" = no ] && echo yes || echo no)"
report "the epic's rule is in the session's context" "$(has "$reply" RULE-TOKEN-6f1)"
echo "  info  its reply: $(snippet "$reply")"
out="$(ask "$W7" "Use the Read tool on ../knowledge.md and reply with its line that starts with KNOW-TOKEN-, or NO-ACCESS." --max-turns 3 --allowedTools Read --output-format stream-json --verbose)"
reply="$(reply_of "$out")"
report "the session reads ../knowledge.md with the Read tool" "$([ "$(has "$(tool_results "$out")" KNOW-TOKEN-2c8)" = yes ] && has "$reply" KNOW-TOKEN-2c8 || echo no)"
echo "  info  its reply: $(snippet "$reply")"

echo "7. the task's status: list, status review, close, list"
# A field of the task in wsg list --json: list_field <field>.
list_field() {
  wsg list --json | node -e '
    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      const e = JSON.parse(s).result.workspaces.find((w) => w.slug === "seven");
      const t = e && e.tasks.find((w) => w.slug === "seven-a");
      process.stdout.write(String(t ? t[process.argv[1]] : "missing"));
    });' "$1"
}
report "wsg list --json: the task is open" "$([ "$(list_field status)" = open ] && echo yes || echo no)"
wsg status seven/seven-a review >/dev/null && ok=yes || ok=no
report "wsg status seven/seven-a review" "$ok"
report "wsg status reads it back: review" "$([ "$(wsg status seven/seven-a)" = review ] && echo yes || echo no)"
report "tasks.md shows [review]" "$(has "$(cat "$E7/tasks.md")" '`seven-a/` [review]')"
wsg close seven/seven-a >/dev/null && ok=yes || ok=no
report "wsg close seven/seven-a" "$ok"
TODAY="$(node -e 'process.stdout.write(new Date().toISOString().slice(0, 10))')"
report "wsg list --json: done, closed today" "$([ "$(list_field status) $(list_field closed)" = "done $TODAY" ] && echo yes || echo no)"
report "tasks.md shows [done <date>]" "$(has "$(cat "$E7/tasks.md")" "\`seven-a/\` [done $TODAY]")"

[ "${WSG_SMOKE_MCP:-}" = 1 ] && mcp_step
[ "${WSG_SMOKE_08:-}" = 1 ] && v08_step

echo
echo "passed: $pass, failed: $fail"
[ "$fail" = 0 ]
