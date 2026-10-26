# Sourced by test/smoke-claude.sh and test/eval-advisor.sh, with SRC (this checkout) and SCRIPT
# (test/<name>.sh) set: the user-level wsg-advisor for one run.
#
# Claude Code runs the hooks of a user-level agent and skips those of a project-level one in a
# folder it was not told to trust, so the run renders this checkout's agent, as
# `wsg install-skills` writes it, into ${CLAUDE_CONFIG_DIR:-~/.claude}/agents/wsg-advisor.md. A
# wsg-advisor.md already there is moved next to it, to wsg-advisor.md.wsg-test-backup, and put back
# at exit, Ctrl+C included; nothing else under the config dir is touched. Other Claude Code
# sessions of this user see this checkout's agent meanwhile.
#
# The agent carries a stamp line, `<!-- wsg: temporary agent of <script>, pid <pid> -->`, so a run
# killed with SIGKILL, which runs no trap, is cleaned up by the next one: recover_advisor removes a
# stamped agent whose pid is gone and puts the backup back. `wsg check` warns about a stamped one.

AGENTS_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/agents"
AGENT="$AGENTS_DIR/wsg-advisor.md"
AGENT_BACKUP="$AGENT.wsg-test-backup"
AGENT_WRITTEN="" AGENT_MOVED="" AGENTS_DIR_MADE=""

exists() { [ -e "$1" ] || [ -L "$1" ]; }
# The pid in the stamp of an agent file, or nothing.
stamp_pid() {
  [ -f "$1" ] || return 0
  sed -n 's/^<!-- wsg: temporary agent of test\/[A-Za-z0-9._-]*, pid \([0-9][0-9]*\) -->$/\1/p' "$1" | head -n 1
}

# Before anything else: what a killed run left behind.
recover_advisor() {
  local pid
  pid="$(stamp_pid "$AGENT")"
  if [ -n "$pid" ]; then
    if kill -0 "$pid" 2>/dev/null; then
      echo "$AGENT is the temporary agent of a run still going (pid $pid): wait for it to end" >&2
      exit 1
    fi
    rm -f "$AGENT"
    echo "removed $AGENT: a temporary agent left by a test run (pid $pid)" >&2
  fi
  if exists "$AGENT_BACKUP"; then
    if exists "$AGENT"; then
      echo "both $AGENT and $AGENT_BACKUP are there: keep the one you want, delete the other" >&2
      exit 1
    fi
    mv "$AGENT_BACKUP" "$AGENT"
    echo "put your $AGENT back from $AGENT_BACKUP, left by a test run" >&2
  fi
}

install_advisor() {
  if [ ! -d "$AGENTS_DIR" ]; then mkdir -p "$AGENTS_DIR"; AGENTS_DIR_MADE=1; fi
  if exists "$AGENT"; then
    mv "$AGENT" "$AGENT_BACKUP"
    AGENT_MOVED=1
    echo "your $AGENT is in $AGENT_BACKUP until this run ends" >&2
  fi
  AGENT_WRITTEN=1
  node -e 'const [skills, script, pid] = process.argv.slice(1);
    const S = require(skills);
    const text = S.render(S.ITEMS.find((x) => x.name === "wsg-advisor" && x.root === "claude"));
    process.stdout.write(text.replace(`${S.MARKER}\n`, `${S.MARKER}\n${S.tempStamp(script, pid)}\n`));' \
    "$SRC/lib/skills.js" "$SCRIPT" "$$" > "$AGENT"
}

restore_advisor() {
  if [ -n "$AGENT_WRITTEN" ]; then rm -f "$AGENT"; fi
  if [ -n "$AGENT_MOVED" ] && exists "$AGENT_BACKUP"; then mv "$AGENT_BACKUP" "$AGENT"; fi
  if [ -n "$AGENTS_DIR_MADE" ]; then rmdir "$AGENTS_DIR" 2>/dev/null || true; fi
}
