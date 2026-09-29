#!/usr/bin/env bash
#
# Install from a repository clone. Via npm is simpler: npm i -g @korbutds/wsg
#
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
CFG_DIR="$HOME/.config/wsg"

if [ -t 1 ]; then B=$'\033[1m'; Y=$'\033[33m'; G=$'\033[32m'; N=$'\033[0m'
else B=''; Y=''; G=''; N=''; fi
ok()   { printf '  %sOK%s   %s\n' "$G" "$N" "$*"; }
warn() { printf '  %sWARN%s %s\n' "$Y" "$N" "$*"; }

printf '\n%swsg — install from clone%s\n\n' "$B" "$N"

NEED='Node 20.19+ or 22.13+ is required'
command -v node >/dev/null || { printf '%s\n' "$NEED" >&2; exit 1; }
NV="$(node -p 'process.versions.node')"
# Matches engines in package.json: the interview loads an ESM package via require(),
# which works without a flag from 20.19 and 22.12; the prompt library itself needs 22.13 on 22.x.
node -e '
  const [M, m] = process.versions.node.split(".").map(Number);
  process.exit(M >= 24 || (M === 23 && m >= 5) || (M === 22 && m >= 13) || (M === 20 && m >= 19) ? 0 : 1);
' || { printf '%s, found %s\n' "$NEED" "$NV" >&2; exit 1; }
ok "node $NV"
command -v git >/dev/null || { printf 'git is required\n' >&2; exit 1; }
ok "git found"

if [ -d "$SRC/node_modules/@inquirer" ]; then
  ok "dependencies installed"
else
  warn "no dependencies — running npm install"
  (cd "$SRC" && npm install --omit=dev --silent)
  ok "dependencies installed"
fi

mkdir -p "$BIN_DIR"
ln -sf "$SRC/bin/cli.js" "$BIN_DIR/wsg"
ok "$BIN_DIR/wsg -> $SRC/bin/cli.js"
IN_PATH=1
case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR is in PATH" ;;
  *) IN_PATH=0 ;;
esac

mkdir -p "$CFG_DIR"
if [ -f "$CFG_DIR/config" ]; then ok "config already exists: $CFG_DIR/config"
else cp "$SRC/config.example" "$CFG_DIR/config"; ok "created $CFG_DIR/config — adjust WS_ROOT"; fi

# The guard keeps the rc from spewing "command not found" if wsg is later removed or PATH changes.
LINE='command -v wsg >/dev/null && eval "$(wsg shell-init zsh)"'
# Keep $HOME as a variable: the rc survives a username change and profile migration.
PATH_LINE="export PATH=\"\$HOME${BIN_DIR#"$HOME"}:\$PATH\""
case "$BIN_DIR" in "$HOME"/*) ;; *) PATH_LINE="export PATH=\"$BIN_DIR:\$PATH\"" ;; esac
# zsh reads $ZDOTDIR/.zshrc when it is set; lib/shellrc.js writes to the same place.
RC="${ZDOTDIR:-$HOME}/.zshrc"
LOGIN_SHELL="${SHELL:-}"
if [ "${LOGIN_SHELL##*/}" != zsh ]; then
  [ "$IN_PATH" = 1 ] || warn "add to PATH: $PATH_LINE"
  warn "the ws function is written in zsh; only wsg is available in ${LOGIN_SHELL##*/}"
elif grep -qxF "$LINE" "$RC" 2>/dev/null && { [ "$IN_PATH" = 1 ] || grep -qxF "$PATH_LINE" "$RC"; }; then
  ok "ws function already set up in $RC"
else
  # Remove old wsg lines and rewrite the block: the old one without a guard would spew
  # "command not found" after wsg is removed, and PATH must come before eval.
  # The PATH line goes only when it sits right under our "# wsg" marker: the same line
  # elsewhere is the user's own (pipx, mise and friends put it there too).
  # Our PATH line is written back even when ~/.local/bin is on PATH now: most likely
  # it got there from that very line, and without it the next shell loses wsg.
  WRITE_PATH=0
  [ "$IN_PATH" = 1 ] || WRITE_PATH=1
  if [ -f "$RC" ]; then
    awk -v a='# wsg' -v c="$PATH_LINE" '$0 == c && prev == a { f = 1 } { prev = $0 } END { exit !f }' "$RC" \
      && WRITE_PATH=1
    cp "$RC" "$RC.wsg-backup"
    awk -v a='# wsg' -v b="$LINE" -v c="$PATH_LINE" -v d='eval "$(wsg shell-init zsh)"' '
      $0 == c && prev == a { prev = $0; next }
      $0 != a && $0 != b && $0 != d { print }
      { prev = $0 }
    ' "$RC.wsg-backup" > "$RC"
  fi
  {
    printf '\n# wsg\n'
    [ "$WRITE_PATH" = 1 ] && printf '%s\n' "$PATH_LINE"
    printf '%s\n' "$LINE"
  } >> "$RC"
  [ "$IN_PATH" = 1 ] || ok "added $BIN_DIR to PATH in $RC"
  ok "ws function set up in $RC (previous file: $RC.wsg-backup)"
fi

WS_ROOT_DEFAULT="$HOME/workspaces"
mkdir -p "$WS_ROOT_DEFAULT"
ok "workspaces directory: $WS_ROOT_DEFAULT"

printf '\n%sDone%s\n  open a new terminal tab, then: wsg --help\n\n' "$B" "$N"
