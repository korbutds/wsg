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
# Open item 1 (agents written mid-session are picked up live) belongs to the team, phase 2.
#
# The agent is the user-level one: for the run, this checkout's agent is rendered into
# ${CLAUDE_CONFIG_DIR:-~/.claude}/agents/wsg-advisor.md, as `wsg install-skills` would write it,
# with its hook pointing at this checkout's lib/advisor-guard.js. A wsg-advisor.md already there is
# moved to a temp backup and put back when the script exits, Ctrl+C included; other Claude Code
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
#
# The temp dir and the session history Claude Code keeps for it are removed at the end.

set -euo pipefail

MODEL="${1:-haiku}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v claude >/dev/null || { echo "claude is not on PATH" >&2; exit 1; }
command -v node >/dev/null || { echo "node is not on PATH" >&2; exit 1; }

TMP="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/wsg-smoke-XXXXXX")" && pwd -P)"
PROJECTS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
session_dir() { printf '%s/%s' "$PROJECTS" "$(printf '%s' "$1" | sed 's/[^a-zA-Z0-9]/-/g')"; }
# The advisor as `wsg install-skills` writes it (the same render, only this item), at the user
# level: Claude Code runs the hooks of a user-level agent, and skips those of a project-level one
# in a folder it was not told to trust. A wsg-advisor.md already there is moved to a backup dir
# first and put back at exit, Ctrl+C included; nothing else under the config dir is touched.
AGENTS_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/agents"
AGENT="$AGENTS_DIR/wsg-advisor.md"
AGENT_BACKUP="" AGENT_WRITTEN="" AGENTS_DIR_MADE=""
install_advisor() {
  if [ ! -d "$AGENTS_DIR" ]; then mkdir -p "$AGENTS_DIR"; AGENTS_DIR_MADE=1; fi
  if [ -e "$AGENT" ] || [ -L "$AGENT" ]; then
    AGENT_BACKUP="$(mktemp -d "${TMPDIR:-/tmp}/wsg-advisor-backup-XXXXXX")/wsg-advisor.md"
    mv "$AGENT" "$AGENT_BACKUP"
    echo "your $AGENT is in $AGENT_BACKUP until this run ends" >&2
  fi
  AGENT_WRITTEN=1
  node -e 'const S = require(process.argv[1]);
    process.stdout.write(S.render(S.ITEMS.find((x) => x.name === "wsg-advisor" && x.root === "claude")));' \
    "$SRC/lib/skills.js" > "$AGENT"
}
restore_advisor() {
  if [ -n "$AGENT_WRITTEN" ]; then rm -f "$AGENT"; fi
  if [ -n "$AGENT_BACKUP" ] && { [ -e "$AGENT_BACKUP" ] || [ -L "$AGENT_BACKUP" ]; }; then
    mv "$AGENT_BACKUP" "$AGENT" && rmdir "$(dirname "$AGENT_BACKUP")"
  fi
  if [ -n "$AGENTS_DIR_MADE" ]; then rmdir "$AGENTS_DIR" 2>/dev/null || true; fi
}
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
agents="$(printf '%s' "$out" | node -e '
  let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
    const init = s.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((e) => e && e.type === "system" && e.subtype === "init");
    const list = (init && Array.isArray(init.agents) ? init.agents : []).map((a) => (typeof a === "string" ? a : a && a.name));
    process.stdout.write(list.join("\n"));
  });')"
report "wsg-advisor is in the agents of the init event" "$(printf '%s\n' "$agents" | grep -qx wsg-advisor && echo yes || echo no)"
before="$(shasum "$W4/notes.md")"
out="$(ask "$W4" "Append the line SMOKE-EDIT-5c2 to notes.md in the current directory." --agent wsg-advisor --max-turns 4 --permission-mode acceptEdits)"
after="$(shasum "$W4/notes.md")"
report "asked to edit notes.md, the advisor leaves it unchanged" "$([ "$before" = "$after" ] && echo yes || echo no)"
echo "  info  its reply: $(printf '%s' "$out" | head -c 300 | tr '\n' ' ')"
# The guard must not block what the advisor is meant to do: a plain read command runs.
out="$(ask "$W4" "Run exactly this Bash command and reply with its output only: git -C $TMP/repo log -1 --format=%s" --agent wsg-advisor --max-turns 3 --allowedTools 'Bash(git *)')"
report "a plain read command still runs (git log)" "$(has "$out" init)"
# The advisor's only wsg: this checkout's CLI by its path, as the agent file names it.
CLI="$SRC/bin/cli.js"
out="$(ask "$W4" "Run exactly this Bash command and reply with its output only: node \"$CLI\" --version" --agent wsg-advisor --max-turns 3 --allowedTools "Bash(node *)")"
report "wsg runs by the CLI path (node <cli> --version)" "$(has "$out" "$(node "$CLI" --version)")"

echo
echo "passed: $pass, failed: $fail"
[ "$fail" = 0 ]
