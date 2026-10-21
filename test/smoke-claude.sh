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
# Open item 1 (agents written mid-session are picked up live) belongs to the team, phase 2.
#
# Outcome recorded on 2026-10-21 with Claude Code 2.1.306 and haiku:
#   1 and 2 pass. 3 was inconclusive: the never-attached control directory was readable as well
#   (reads outside the workspace were allowed by that user's own settings), so open item 2 stays
#   unverified; `wsg add` keeps printing its restart notice when settings.json changes.
#   In -p mode a workspace whose trust dialog was never accepted ignores permissions.allow from
#   its .claude/settings.json (Claude Code says so on stderr); see README, Limitations.
#
# The temp dir and the session history Claude Code keeps for it are removed at the end.

set -euo pipefail

MODEL="${1:-haiku}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v claude >/dev/null || { echo "claude is not on PATH" >&2; exit 1; }

TMP="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/wsg-smoke-XXXXXX")" && pwd -P)"
PROJECTS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
session_dir() { printf '%s/%s' "$PROJECTS" "$(printf '%s' "$1" | sed 's/[^a-zA-Z0-9]/-/g')"; }
WORKSPACES=()
cleanup() {
  for w in "${WORKSPACES[@]}"; do rm -rf "$(session_dir "$w")"; done
  rm -rf "$TMP"
}
trap cleanup EXIT

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
ask() { local dir="$1" prompt="$2"; shift 2; (cd "$dir" && claude -p "$prompt" --model "$MODEL" "$@" 2>/dev/null) || true; }
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

echo
echo "passed: $pass, failed: $fail"
[ "$fail" = 0 ]
