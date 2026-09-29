# ws — jump into a workspace and start an agent session. Part of wsg.
# Setup: eval "$(wsg shell-init zsh)" in ~/.zshrc   (install.sh does this)
#
#   ws                  list workspaces
#   ws <slug>           jump in and start the agent from WSG_AGENT
#                       (claude continues the previous session, if any)
#   ws <slug> --new     jump in and start a new session
#   ws <slug> --cd      only jump in
#   ws <slug> --codex   jump in and start codex, whatever WSG_AGENT says
#
# The agent is asked on the first `ws <slug>` and saved to the config.
# A slug can be shortened to an unambiguous prefix: ws daz
#
# The @-delimited keys in double quotes are UI strings: `wsg shell-init zsh` replaces them in
# the configured language (lib/i18n), so ws never has to start Node. Source the output of
# shell-init, not this file.

WSG_CONFIG="${WSG_CONFIG:-$HOME/.config/wsg/config}"
# Tells wsg that ws is loaded in this shell (lib/shellrc.js), so it doesn't offer to hook it again.
typeset -gx WSG_WS_LOADED=1
_ws_load_config() {
  # WS_ROOT from the environment wins over the file, as in wsg (lib/config.js): otherwise
  # `WS_ROOT=… wsg` creates a workspace that ws then looks for somewhere else.
  local from_env="$WS_ROOT"
  [ -f "$WSG_CONFIG" ] && source "$WSG_CONFIG"
  [ -n "$from_env" ] && WS_ROOT="$from_env"
  WS_ROOT="${WS_ROOT:-$HOME/workspaces}"
  # Same as wsg (lib/config.js): a quoted "~/x" and a relative path are taken from $HOME,
  # otherwise the two tools would look for workspaces in different places.
  WS_ROOT="${WS_ROOT/#\~/$HOME}"
  [[ "$WS_ROOT" == /* ]] || WS_ROOT="$HOME/$WS_ROOT"
}
_ws_load_config

# Classifies WSG_AGENT. For "[VAR=value…] claude|codex [args…]" sets REPLY to the agent and
# reply to the command line without a trailing comment. The words keep their quoting: the
# line is still run through eval, so ~, $VAR, aliases and functions work as in the shell,
# and only our flags are appended — after the user's arguments, not into a comment.
# Returns 1 for anything else (a custom command, or several commands joined by ; && |),
# 2 when there is nothing to run.
_ws_agent_kind() {
  setopt localoptions extendedglob
  REPLY='' reply=()
  local -a w; w=(${(Z+C+)WSG_AGENT})              # C+: drops a trailing # comment
  (( ${#w} )) || return 2
  reply=("${w[@]}")
  local x i=1
  # Redirections are fine — the shell handles them wherever the flags land. Separators aren't:
  # the appended flags would go to the last command.
  for x in "${w[@]}"; do
    [[ $x == (\;|\;\;|\&|\&\&|\||\|\||\|\&|\&\||\&\!|\(|\)) ]] && return 1
  done
  while [[ ${w[i]} == [A-Za-z_][A-Za-z0-9_]#=* ]]; do (( i++ )); done
  case "${${(Q)w[i]}:t}" in
    claude|codex) REPLY="${${(Q)w[i]}:t}" ;;
    *) return 1 ;;
  esac
}

_ws_is_claude() {             # no agent configured yet counts as the default, claude
  [ -z "$WSG_AGENT" ] || { _ws_agent_kind && [ "$REPLY" = claude ]; }
}

_ws_list() {
  local d
  for d in "$WS_ROOT"/*(N/); do
    [ -f "$d/CLAUDE.md" ] || continue
    print -r -- "${d:t}"
  done
}

_ws_repo_state() {            # state of one checkout: branch, detached, rebase, dirty
  local r="$1" b gd st dirty=''
  b="$(git -C "$r" branch --show-current 2>/dev/null)"
  [ -n "$(git -C "$r" status --porcelain 2>/dev/null | head -1)" ] && dirty=' *'
  if [ -n "$b" ]; then
    print -nr -- "$b$dirty"
    return
  fi
  gd="$(git -C "$r" rev-parse --absolute-git-dir 2>/dev/null)"
  if [ "$2" = process ]; then
    print -nr -- "$(git -C "$r" rev-parse --short HEAD 2>/dev/null) @@ws.state.noBranch@@$dirty"
    return
  fi
  if [ -d "$gd/rebase-merge" ] || [ -d "$gd/rebase-apply" ]; then
    st="@@ws.state.rebase@@ @ $(git -C "$r" rev-parse --short HEAD 2>/dev/null)"
  else
    st="@@ws.state.detached@@ @ $(git -C "$r" rev-parse --short HEAD 2>/dev/null)"
  fi
  print -nP -- "%F{red}${st}%f$dirty"
}

_ws_kind() {                  # task|process
  local f="$1/.claude/ws-kind"
  [ -f "$f" ] && tr -d ' \n' < "$f" || print -n task
}

_ws_sessions_dir() {          # Claude Code history directory for a path
  local esc="${1//[^a-zA-Z0-9]/-}"
  print -r -- "$HOME/.claude/projects/$esc"
}

# First run without WSG_AGENT: ask for the command and append it to the config; no questions afterwards.
_ws_setup_agent() {
  setopt localoptions extendedglob
  if [[ ! -t 0 ]]; then
    print -r -u2 -- "@@ws.noAgent@@"
    return 1
  fi
  local -a found; local c
  for c in claude codex cursor-agent gemini opencode aider; do
    (( $+commands[$c] )) && found+=("$c")
  done
  print -r -- "@@ws.setup.question@@"
  local i=1
  for c in "${found[@]}"; do print -r -- "  $i) $c"; (( i++ )); done
  print -r -- "@@ws.setup.custom@@"
  local ans
  read -r "ans?> " || return 1
  _ws_pick_agent "$ans" "${found[@]}" || return 1
  _ws_save_agent "$REPLY"
}

# Answer -> command in REPLY: a number picks from the listed agents, anything else is a command.
_ws_pick_agent() {
  setopt localoptions extendedglob
  local ans="$1"; shift
  ans="${ans## ##}"; ans="${ans%% ##}"
  if [[ "$ans" == <-> ]]; then
    # A number outside the list would be saved as a "command" and fail on every launch.
    if (( ans < 1 || ans > $# )); then
      print -r -u2 -- "@@ws.pick.noOption@@"
      return 1
    fi
    ans="${@[$ans]}"
  fi
  if [[ -z "$ans" ]]; then
    print -r -u2 -- "@@ws.pick.nothing@@"
    return 1
  fi
  REPLY="$ans"
}

_ws_save_agent() {
  mkdir -p "${WSG_CONFIG:h}" || return 1
  # A config edited by hand may lack the final newline: the new line would glue onto the last one.
  # $(…) strips a trailing newline, so a non-empty result means the last byte isn't one.
  [[ -s "$WSG_CONFIG" && -n "$(tail -c 1 "$WSG_CONFIG")" ]] && print >> "$WSG_CONFIG"
  print -r -- "WSG_AGENT=${(qq)1}" >> "$WSG_CONFIG" || return 1
  WSG_AGENT="$1"
  local q="${(qq)1}"
  print -r -- "@@ws.saved@@"
}

_ws_codex() {                 # codex only sees its launch directory: add symlinks explicitly
  local dir="$1" run="${2:-codex}" sub target root="${1:A}"
  local -a add seen
  # Every symlink that leads outside the workspace, each target once. Decided by where it
  # leads, not by name: the repo pointer resolves inside (to a worktree) or to a source
  # already listed, while a real source may itself be named repo.
  for sub in "$dir"/*(ND@); do            # D: a source may be a dot-directory, e.g. .docs
    target="${sub:A}"
    [ -n "$target" ] || continue
    [[ "$target" == "$root" || "$target" == "$root"/* ]] && continue
    (( ${seen[(Ie)$target]} )) && continue
    seen+=("$target")
    add+=(--add-dir "$target")
  done
  # run is a command line from the user's own config — eval, like any other agent command
  eval "$run ${(j: :)${(q)add[@]}}"
}

ws() {
  # The config is read when the shell starts: another tab may have saved the agent since.
  [ -n "$WSG_AGENT" ] || _ws_load_config
  local root="$WS_ROOT"
  local slug="$1" mode="${2:---session}"

  if [ -z "$slug" ]; then
    print -P "%B@@ws.list.title@@%b  ${root/#$HOME/~}"
    local d name sub shared
    for name in $(_ws_list); do
      d="$root/$name"
      local kind="$(_ws_kind "$d")" extra=""
      # session history can only be counted for Claude Code: other agents store it differently
      if _ws_is_claude; then
        local -a jf; jf=("$(_ws_sessions_dir "$d")"/*.jsonl(N))
        extra=" · @@ws.list.sessions@@: ${#jf}"
      fi
      if [ "$kind" = process ]; then
        local -a rf; rf=("$d"/runs/*.md(N))
        # the texts are printf arguments, never the format: a translation may hold a %
        printf '  %-18s %-7s%s · %s: %d\n' "$name" "@@ws.list.process@@" "$extra" "@@ws.list.runs@@" "${#rf}"
      else
        printf '  %-18s %-7s%s\n' "$name" "@@ws.list.task@@" "$extra"
      fi
      for sub in "$d"/*(ND-/); do
        # the repo pointer is a duplicate: a relative link to a sibling (a source named repo is absolute)
        [[ "${sub:t}" == repo && -L "$sub" && "$(readlink "$sub")" != */* ]] && continue
        [ -e "$sub/.git" ] || continue
        shared=""
        [ -L "$sub" ] && shared=" @@ws.list.shared@@"
        print -r -- "      ${sub:t}: $(_ws_repo_state "$sub" "$kind")$shared"
      done
    done
    print -P "\n%F{242}@@ws.list.create@@%f"
    return 0
  fi

  local dir="$root/$slug"
  if [ ! -d "$dir" ]; then                       # unambiguous prefix
    local -a m; m=(${(f)"$(_ws_list)"})
    m=(${(M)m:#${slug}*})
    if [ ${#m} -eq 1 ]; then
      slug="${m[1]}"; dir="$root/$slug"
      print -P "%F{242}→ $slug%f"
    elif [ ${#m} -gt 1 ]; then
      local list="${m[*]}"
      print -r -u2 -- "@@ws.jump.ambiguous@@"; return 1
    else
      print -r -u2 -- "@@ws.jump.none@@"; return 1
    fi
  fi

  cd "$dir" || return 1

  case "$mode" in
    --cd) return 0 ;;
    --codex) _ws_codex "$dir"; return ;;
  esac

  # The directory is already changed: with no agent, the user at least lands in the workspace.
  [ -n "$WSG_AGENT" ] || _ws_setup_agent || return 0
  _ws_agent_kind
  case $? in
    2) print -r -u2 -- "@@ws.agent.nothingToRun@@"; return 1 ;;
    # A custom command runs as is: each agent has its own session-resume flags.
    # It's a string from the user's own config, hence eval.
    1) eval "$WSG_AGENT"; return ;;
  esac
  local line="${reply[*]}"
  case "$REPLY" in
    claude)
      # claude with extra flags (a model, permissions) keeps session handling
      local -a jf; jf=("$(_ws_sessions_dir "$dir")"/*.jsonl(N))
      if [ "$mode" != --new ] && [ ${#jf} -gt 0 ]; then
        eval "$line --continue"
      else
        eval "$line -n ${(q)slug}"
      fi
      ;;
    codex) _ws_codex "$dir" "$line" ;;
  esac
}

_ws_complete() { compadd -- $(_ws_list) }
compdef _ws_complete ws 2>/dev/null
