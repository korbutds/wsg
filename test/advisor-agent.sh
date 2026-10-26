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
# One run at a time: from recover_advisor to restore_advisor a run holds the lock
# agents/.wsg-test-lock, a directory with "<pid> <script>" in its file pid. Two runs that overlap
# would otherwise both move the agent aside, the second one over the user's backup. A lock whose
# run is gone — no such pid, or a pid now given to a process whose command does not name the
# script — is taken over.
#
# The agent carries a stamp line, `<!-- wsg: temporary agent of <script>, pid <pid> -->`, so a run
# killed with SIGKILL, which runs no trap, is cleaned up by the next one: recover_advisor removes a
# stamped agent whose run is gone and puts the backup back. `wsg check` warns about a stamped one.
# A run moves aside only a file without a stamp and never over a backup, and at exit removes only
# the agent stamped with its own pid.

AGENTS_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/agents"
AGENT="$AGENTS_DIR/wsg-advisor.md"
AGENT_BACKUP="$AGENT.wsg-test-backup"
AGENT_LOCK="$AGENTS_DIR/.wsg-test-lock"
AGENT_WRITTEN="" AGENT_MOVED="" AGENTS_DIR_MADE="" AGENT_LOCKED=""

exists() { [ -e "$1" ] || [ -L "$1" ]; }
# run_alive <pid> <script>: the pid is there and its command names the script. kill -0 alone would
# take a pid the system has since given to another process for the run.
run_alive() {
  local cmd
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null || return 1
  cmd="$(ps -o command= -p "$1" 2>/dev/null)" || return 1
  case "$cmd" in *"${2##*/}"*) return 0 ;; *) return 1 ;; esac
}
# "<pid> <script>" from the stamp of an agent file, or nothing.
stamp_of() {
  [ -f "$1" ] || return 0
  sed -n 's/^<!-- wsg: temporary agent of \(test\/[A-Za-z0-9._-]*\), pid \([0-9][0-9]*\) -->$/\2 \1/p' "$1" | head -n 1
}
die() { release_lock; echo "$1" >&2; exit 1; }

acquire_lock() {
  if [ ! -d "$AGENTS_DIR" ]; then mkdir -p "$AGENTS_DIR"; AGENTS_DIR_MADE=1; fi
  local holder pid script tries=0
  until mkdir "$AGENT_LOCK" 2>/dev/null; do
    tries=$((tries + 1))
    [ "$tries" -le 3 ] || die "could not take $AGENT_LOCK: remove it if no test run is going"
    holder="$(cat "$AGENT_LOCK/pid" 2>/dev/null || true)"
    pid="${holder%% *}" script="${holder#* }"
    if [ -z "$holder" ]; then
      # Taken a moment ago and its pid not written yet, or left by a run killed right then.
      if [ -n "$(find "$AGENT_LOCK" -maxdepth 0 -mmin -1 2>/dev/null)" ]; then
        die "another test run is starting ($AGENT_LOCK): wait for it"
      fi
    elif run_alive "$pid" "$script"; then
      die "another test run ($script, pid $pid) is using $AGENT: wait for it to end"
    fi
    rm -rf "$AGENT_LOCK"
    echo "removed $AGENT_LOCK: left by a test run that is gone${pid:+ (pid $pid)}" >&2
  done
  printf '%s %s\n' "$$" "$SCRIPT" > "$AGENT_LOCK/pid"
  AGENT_LOCKED=1
}

release_lock() {
  [ -n "$AGENT_LOCKED" ] || return 0
  local holder
  holder="$(cat "$AGENT_LOCK/pid" 2>/dev/null || true)"
  if [ "${holder%% *}" = "$$" ]; then rm -rf "$AGENT_LOCK"; fi
  AGENT_LOCKED=""
}

# Before anything else: take the lock, then clean up what a killed run left behind.
recover_advisor() {
  acquire_lock
  local stamp pid script f
  stamp="$(stamp_of "$AGENT")"
  if [ -n "$stamp" ]; then
    pid="${stamp%% *}" script="${stamp#* }"
    if run_alive "$pid" "$script"; then
      die "$AGENT is the temporary agent of a run still going (pid $pid): wait for it to end"
    fi
    rm -f "$AGENT"
    echo "removed $AGENT: a temporary agent left by a test run (pid $pid)" >&2
  fi
  # A render a killed run did not get to move into place.
  for f in "$AGENT".tmp.*; do
    if exists "$f"; then rm -f "$f"; fi
  done
  if exists "$AGENT_BACKUP"; then
    if exists "$AGENT"; then
      die "both $AGENT and $AGENT_BACKUP are there: keep the one you want, delete the other"
    fi
    mv "$AGENT_BACKUP" "$AGENT"
    echo "put your $AGENT back from $AGENT_BACKUP, left by a test run" >&2
  fi
}

install_advisor() {
  if [ ! -d "$AGENTS_DIR" ]; then mkdir -p "$AGENTS_DIR"; AGENTS_DIR_MADE=1; fi
  if exists "$AGENT"; then
    if exists "$AGENT_BACKUP"; then
      die "$AGENT_BACKUP is already there: not moving $AGENT over it — keep the one you want, delete the other"
    fi
    if [ -n "$(stamp_of "$AGENT")" ]; then
      die "$AGENT is the temporary agent of another test run: not moving it aside"
    fi
    mv "$AGENT" "$AGENT_BACKUP"
    AGENT_MOVED=1
    echo "your $AGENT is in $AGENT_BACKUP until this run ends" >&2
  fi
  # Rendered next to it, then moved into place: a run killed meanwhile leaves no half-written agent.
  local tmp="$AGENT.tmp.$$"
  node -e 'const [skills, script, pid] = process.argv.slice(1);
    const S = require(skills);
    const text = S.render(S.ITEMS.find((x) => x.name === "wsg-advisor" && x.root === "claude"));
    process.stdout.write(text.replace(`${S.MARKER}\n`, `${S.MARKER}\n${S.tempStamp(script, pid)}\n`));' \
    "$SRC/lib/skills.js" "$SCRIPT" "$$" > "$tmp" || { rm -f "$tmp"; die "could not render $AGENT"; }
  mv -f "$tmp" "$AGENT"
  AGENT_WRITTEN=1
}

restore_advisor() {
  local stamp
  rm -f "$AGENT.tmp.$$"
  if [ -n "$AGENT_WRITTEN" ]; then
    stamp="$(stamp_of "$AGENT")"
    if [ "${stamp%% *}" = "$$" ]; then rm -f "$AGENT"; fi
  fi
  if [ -n "$AGENT_MOVED" ] && exists "$AGENT_BACKUP" && ! exists "$AGENT"; then mv "$AGENT_BACKUP" "$AGENT"; fi
  release_lock
  if [ -n "$AGENTS_DIR_MADE" ]; then rmdir "$AGENTS_DIR" 2>/dev/null || true; fi
}
