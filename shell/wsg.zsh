# ws — jump into a workspace and start an agent session. Part of wsg.
# Setup: eval "$(wsg shell-init zsh)" in ~/.zshrc   (install.sh does this)
#
#   ws                  list workspaces
#   ws <slug>           jump in and start the agent from WSG_AGENT
#   ws <epic>/<task>    the same for a task inside an epic
#                       (claude resumes the last session with a message, if any;
#                       a task wsg move moved: from its old directory too)
#   ws <slug> --new     jump in and start a new session
#   ws <slug> --cd      only jump in
#   ws <slug> --codex   jump in and start codex, whatever WSG_AGENT says
#   ws <slug> --claude  jump in and start claude, whatever WSG_AGENT says
#   ws --agent          choose the agent again
#
# The agent is asked on the first `ws <slug>` and saved to the config. The config is reread on
# every call, so a change made by hand or in another tab applies at once.
# A slug can be shortened to an unambiguous prefix: ws daz
# A task of an epic can be named alone: ws cart for checkout-v2/cart. A workspace named exactly
# so wins; otherwise the task does when one epic has it, even over a workspace whose name only
# starts with it (pay-old vs checkout-v2/pay); two epics with it are ambiguous. Then prefixes:
# of workspaces and of task names (ws car), or inside an epic (ws checkout-v2/ca).
#
# The @-delimited keys in double quotes are UI strings: `wsg shell-init zsh` replaces them in
# the configured language (lib/i18n), so ws never has to start Node. Source the output of
# shell-init, not this file.

WSG_CONFIG="${WSG_CONFIG:-$HOME/.config/wsg/config}"
# Tells wsg that ws is loaded in this shell (lib/shellrc.js), so `wsg new` can suggest `ws <slug>`.
typeset -gx WSG_WS_LOADED=1
_ws_load_config() {
  # WS_ROOT from the environment wins over the file, as in wsg (lib/config.js): otherwise
  # `WS_ROOT=… wsg` creates a workspace that ws then looks for somewhere else.
  local from_env="$WS_ROOT"
  # The agent is reread every time: a line removed from the file must not live on in the shell.
  # Only a value the file itself set is dropped — one set in .zshrc stays.
  [[ -n "$WSG_AGENT" && "$WSG_AGENT" == "${_ws_cfg_agent-}" ]] && WSG_AGENT=
  _ws_cfg_agent=
  [ -f "$WSG_CONFIG" ] && source "$WSG_CONFIG"
  [ -f "$WSG_CONFIG" ] && grep -Eq '^[[:space:]]*(export[[:space:]]+)?WSG_AGENT=' "$WSG_CONFIG" && _ws_cfg_agent="$WSG_AGENT"
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

# A task of an epic: a real directory in it (not a source's symlink) with CLAUDE.md and the state
# file, and no .git — a checkout of the epic has .git, a task keeps its worktrees one level down.
_ws_tasks() {
  local t
  for t in "$1"/*(N/); do
    [[ -f "$t/CLAUDE.md" && -f "$t/.claude/wsg.json" && ! -e "$t/.git" ]] && print -r -- "${t:t}"
  done
}

_ws_list_all() {              # every workspace ws can jump into: slugs, then <epic>/<task>
  local name t
  for name in $(_ws_list); do
    print -r -- "$name"
    _ws_kind_of "$WS_ROOT/$name"
    [ "$REPLY" = epic ] || continue
    for t in $(_ws_tasks "$WS_ROOT/$name"); do print -r -- "$name/$t"; done
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

# The kind in REPLY without a fork: $(<file) is read by the shell itself, a listing or a
# completion over hundreds of workspaces would otherwise start a process for each.
_ws_kind_of() {               # task|process|epic
  local f="$1/.claude/ws-kind"
  local k
  REPLY=task
  [ -f "$f" ] && k="$(<"$f")" && REPLY="${k//[ $'\n']/}"
}

_ws_sessions_dir() {          # Claude Code history directory for a path
  local esc="${1//[^a-zA-Z0-9]/-}"
  print -r -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$esc"
}

# The session to resume for a path: the newest <uuid>.jsonl with a user message in it, its id in REPLY;
# _WS_SESSION_RECENT set when that file changed in the last minute (the session may be open elsewhere).
# Not claude --continue: it skips sessions started through the Agent SDK (by an app, for example), so a
# task worked on there would start over. Other files (agent-*.jsonl) are no sessions to resume.
# Returns 1 when there is none.
_ws_last_session() {
  REPLY=""
  typeset -g _WS_SESSION_RECENT=""
  local f id
  local -a recent
  for f in "$(_ws_sessions_dir "$1")"/*.jsonl(N.om); do
    id="${${f:t}%.jsonl}"
    [[ "$id" =~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' ]] || continue
    grep -qF '"type":"user"' "$f" 2>/dev/null || continue
    REPLY="$id"
    recent=($f(N.mm-1))
    (( ${#recent} )) && _WS_SESSION_RECENT=1
    return 0
  done
  return 1
}

# The directories a task was in before wsg move moved it, the latest first, in reply: the "from" of
# each entry of "moved" in its state, an absolute path ("from": "epic" of a source is none). Read by the
# shell itself, one key a line as wsg writes the state; a path with a quote or a backslash is skipped.
# Returns 1 when there is none.
_ws_moved_from() {
  reply=()
  local f="$1/.claude/wsg.json" line MATCH MBEGIN MEND
  local -a found match mbegin mend
  [ -f "$f" ] || return 1
  for line in "${(@f)$(<"$f")}"; do
    [[ "$line" =~ '^ *"from": "(/[^"\\]*)",?$' ]] && found+=("$match[1]")
  done
  reply=("${(@Oa)found}")
  (( ${#reply} ))
}

# No session in the task's own directory: the last one Claude Code keeps under a directory the task
# was moved from (wsg move never touches ~/.claude), the latest move first. Its id in REPLY.
_ws_last_moved_session() {
  local d
  _ws_moved_from "$1" || return 1
  for d in "${reply[@]}"; do
    _ws_last_session "$d" && return 0
  done
  return 1
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
  setopt localoptions extendedglob
  mkdir -p "${WSG_CONFIG:h}" || return 1
  local -a lines
  # $(<…) drops the trailing newlines, so a last line without one doesn't glue onto ours.
  [[ -s "$WSG_CONFIG" ]] && lines=("${(@f)$(<"$WSG_CONFIG")}")
  # The previous choice is replaced, not shadowed: with two lines, which one wins depends on order.
  # Commented examples (# WSG_AGENT=…) stay.
  lines=("${(@)lines:#[[:space:]]#(export[[:space:]]##)#WSG_AGENT=*}")
  lines+=("WSG_AGENT=${(qq)1}")
  print -rl -- "${lines[@]}" > "$WSG_CONFIG" || return 1
  WSG_AGENT="$1"
  _ws_cfg_agent="$1"
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

# One line of the listing and its repositories; pad indents a task of an epic under it.
# Sets REPLY to the kind, so the caller knows an epic without reading it again.
_ws_show() {
  local d="$1" name="$2" pad="$3" sub shared extra=""
  local kind; _ws_kind_of "$d"; kind="$REPLY"
  # session history can only be counted for Claude Code: other agents store it differently
  if _ws_is_claude; then
    local -a jf; jf=("$(_ws_sessions_dir "$d")"/*.jsonl(N))
    extra=" · @@ws.list.sessions@@: ${#jf}"
  fi
  # the texts are printf arguments, never the format: a translation may hold a %
  case "$kind" in
    process)
      local -a rf; rf=("$d"/runs/*.md(N))
      printf '  %s%-*s %-7s%s · %s: %d\n' "$pad" $(( 18 - ${#pad} )) "$name" "@@ws.list.process@@" "$extra" "@@ws.list.runs@@" "${#rf}" ;;
    epic) printf '  %s%-*s %-7s%s\n' "$pad" $(( 18 - ${#pad} )) "$name" "@@ws.list.epic@@" "$extra" ;;
    *) printf '  %s%-*s %-7s%s\n' "$pad" $(( 18 - ${#pad} )) "$name" "@@ws.list.task@@" "$extra" ;;
  esac
  # a task of an epic has no .git, so the epic's tasks never pass for its repositories
  for sub in "$d"/*(ND-/); do
    # the repo pointer is a duplicate: a relative link to a sibling (a source named repo is absolute)
    [[ "${sub:t}" == repo && -L "$sub" && "$(readlink "$sub")" != */* ]] && continue
    [ -e "$sub/.git" ] || continue
    shared=""
    [ -L "$sub" ] && shared=" @@ws.list.shared@@"
    print -r -- "      $pad${sub:t}: $(_ws_repo_state "$sub" "$kind")$shared"
  done
  REPLY="$kind"
}

ws() {
  # Reread on every call: the agent may have been changed by hand or in another tab.
  _ws_load_config
  if [ "$1" = --agent ]; then
    _ws_setup_agent
    return
  fi
  local root="$WS_ROOT"
  local slug="$1" mode="${2:---session}"
  # A completed directory keeps its slash: without stripping it, the session would be named
  # cart/ and looked up under a path that ends in -, so no session would ever be resumed.
  while [[ "$slug" == ?*/ ]]; do slug="${slug%/}"; done

  if [ -z "$slug" ]; then
    print -P "%B@@ws.list.title@@%b  ${root/#$HOME/~}"
    local name t
    for name in $(_ws_list); do
      _ws_show "$root/$name" "$name" ''
      [ "$REPLY" = epic ] || continue
      for t in $(_ws_tasks "$root/$name"); do _ws_show "$root/$name/$t" "$name/$t" '  '; done
    done
    print -P "\n%F{242}@@ws.list.create@@%f"
    return 0
  fi

  local dir="$root/$slug"
  if [ ! -d "$dir" ]; then
    local -a all top m; all=(${(f)"$(_ws_list_all)"}); top=(${all:#*/*})
    # A bare name: a task of an epic by its own name first, then prefixes of slugs and of task
    # names. With a /, a prefix of <epic>/<task>. A prefix of an epic does not drag its tasks in.
    if [[ "$slug" == */* ]]; then
      m=(${(M)all:#${slug}*})
    else
      m=(${(M)all:#*/${slug}})
      (( ${#m} )) || m=(${(M)top:#${slug}*} ${(M)all:#*/${slug}*})
    fi
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
    # Shadows the setting for this call only: the functions below read WSG_AGENT.
    --claude) local WSG_AGENT=claude; mode=--session ;;
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
      if [ "$mode" != --new ] && { _ws_last_session "$dir" || _ws_last_moved_session "$dir"; }; then
        local id="$REPLY" rc
        [ -n "$_WS_SESSION_RECENT" ] && print -r -u2 -- "@@ws.resume.recent@@"
        eval "$line --resume ${(q)id}"
        rc=$?
        # Non-zero: the resume failed, or the session it opened exited so. Never a new session in its
        # place on its own: that is ws <slug> --new.
        (( rc )) && print -r -u2 -- "@@ws.resume.failed@@"
        return $rc
      else
        eval "$line -n ${(q)slug}"
      fi
      ;;
    codex) _ws_codex "$dir" "$line" ;;
  esac
}

_ws_complete() { compadd -- $(_ws_list_all) }
compdef _ws_complete ws 2>/dev/null
