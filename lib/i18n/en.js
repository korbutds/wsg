'use strict';

// English UI strings — the source of truth: every other catalog has exactly these keys.
// {name} is a t() parameter. In ws.* strings {NAME} is a zsh variable instead (see renderShell).

module.exports = {
  'cli.usage': `
wsg — Workspace Generation: per-task workspaces for agents (Claude Code, Codex).

One directory per task: its own session history, its own agent memory, rules
loaded on demand, and repositories inside as git worktrees.

  wsg new <slug> [--title T] [--kind task|process|epic] [--skill NAME] [--ticket X]
      [--epic E] [--sources a,b|none] [--no-code] [--spec] [--dry-run] [--json] [--no-launch]
      create a workspace and start the agent in it with /wsg-setup
      (--epic E: a task inside the epic E; --no-code: a task without a repository;
      --spec: spec.md and plan.md first, each approved by you)
  wsg add <path> [--worktree|--link|--reference] [--branch B] [--base REF] [--reset-to-base]
      [--target T] [--verify CMD] [--carry all|none|a,b] [--[no-]clone-node-modules]
      [--note TEXT] [--branch-template T] [--dry-run] [--json] [--ws SLUG|PATH]
      attach a source to the workspace (the one you are in by default)
  wsg remove <name> [--delete-ignored [--expect-ignored FILE]] [--dry-run] [--json] [--ws SLUG|PATH]
      detach a source: the worktree (only a clean one; its branch is kept) or the symlink
  wsg refresh [--tasks] [--dry-run] [--json] [--ws SLUG|PATH]
      bring the generated parts of a workspace up to date with this wsg
      (--tasks: an epic, then every task of it)
  wsg team <preset> [--without ROLE,...] [--dry-run] [--ws SLUG|PATH]
      add a team: role cards and a workflow, a subagent per role for Claude Code
      (preset: fullstack — pm, designer, frontend, backend, devops, reviewer)
  wsg check [path|slug] [--json]
                              check a workspace against the conventions
  wsg list [--json]           every workspace in WS_ROOT, an epic's tasks under it
  wsg status <task> [open|review|done] [--dry-run] [--json]
                              print a task's status, or set it
  wsg close <task> [--dry-run] [--json]
                              mark a task done: wsg status <task> done
  wsg archive [<task>] [--delete-ignored [--expect-ignored FILE]] [--dry-run] [--json] [--ws SLUG|PATH]
      free a finished task's worktrees, keep its branches, notes and memory
      (an epic: with its tasks)
  wsg unarchive [<task>] [--dry-run] [--json] [--ws SLUG|PATH]
      bring an archived workspace back: its worktrees on the same branches
  wsg reorder <item> (--before X | --after X | --to N) [--dry-run] [--json] [--ws E]
      move a task of an epic in its order: a task directory, or a tracker task
      under "## Other tasks" in tasks.md by its key
  wsg context add <url|path> [--id ID] [--title T] [--desc D] [--dry-run] [--json] [--ws E]
  wsg context note <id> (--text T | --from FILE|-) [--title T] [--desc D] [--replace] [...]
  wsg context remove <id> [...]       wsg context list [--json] [--ws E]
      an epic's context: files, notes and links its tasks open when they need them
  wsg mcp add <name> [--env A,B=value] -- <command> [args...] | --url URL [--bearer-env VAR]
  wsg mcp remove|disable|enable <name> [...]   wsg mcp list [--json] [--ws E]
      an epic's MCP servers for Claude Code, and the global ones it turns off
  wsg promote [slug|path] --skill NAME
                              turn a task into a process
  wsg guide [setup|advisor|teach|epic]
                              print a guide the agent follows: the setup, the advisor's,
                              teaching a team role a practice, or working in an epic
  wsg install-skills [--uninstall]
                              install (or remove) the wsg-new and wsg-teach skills and the
                              wsg-advisor agent for Claude Code and Codex
  wsg shell-init zsh          print the ws navigation function for eval
  wsg --where                 install directory (config.example lives there)
  wsg --version | --help
  wsg help <command>          a command's options (or wsg <command> --help)

Workspace kind: "task" — one ticket and one branch, until merge;
"process" — a repeatable engineering procedure in a skill (a release, a dependency upgrade);
"epic" — one tracker epic: a knowledge base, its repositories, its tasks inside it.

Exit codes: 0 ok; 1 the check found errors, or a step failed and was rolled back;
2 invalid input (nothing was changed); 130 cancelled with Ctrl+C (rolled back).

Settings: ~/.config/wsg/config (sample: config.example next to the install).
Language: WSG_LANG=en|ru in the config; without it, the locale.
Agent: WSG_AGENT in the config, used by wsg new and ws; ws --agent to choose it.
`,
  'help.new': `
wsg new <slug> [options]
  Create the workspace $WS_ROOT/<slug> and start the agent in it on the setup
  (/wsg-setup in Claude Code). Only the slug is needed, and --kind for a
  process or an epic: the setup dialogue asks for the rest, the other options only save
  the agent a question.

  <slug>               the directory name: lowercase Latin letters, digits, hyphens
  --title T            a readable name for the task, the heading of AGENTS.md, README.md
                       and notes.md. Not the description: "what and why" comes in the
                       dialogue. Default: the slug, and the agent offers a better one
  --kind task|process|epic
                       task (default): one ticket and one branch, until merge.
                       process: a workspace for a repeatable procedure (a release, a
                       dependency upgrade); it gets a skill /<skill> that runs each time,
                       and its memory and run journal build up across runs.
                       epic: one workspace per tracker epic — a knowledge base its tasks
                       read, its repositories, and its tasks, created inside it.
                       Set it here: the dialogue doesn't ask, a task becomes a process
                       only by promote
  --skill NAME         the process's skill name; default: the slug (a wsg-… slug needs
                       its own). Process only
  --ticket X           a ticket key or URL, written under the title; a key becomes a link
                       when WSG_TRACKER_URL is set in the config
  --epic E             a task of the epic E (a slug in WS_ROOT): made in $WS_ROOT/E/<slug>,
                       its AGENTS.md pointing to the epic's knowledge.md and tasks.md and
                       rendering the epic's Owner rules; the epic's tasks.md lists it.
                       Never taken from the current directory
  --sources a,b|none   with --epic: the epic's sources the task takes — a worktree on the
                       branch the epic's template gives it, or the link as is. Default: the
                       one with a branch template when the epic has exactly one, else none
  --no-code            a task without code (a spec, a research, a decision): no repository,
                       no branch, no worktree. Done is what the owner can check, not a
                       command. Material to read is attached with wsg add --link or
                       --reference; --worktree is refused. Task only; in an epic it takes
                       none of the epic's sources
  --spec               the task goes spec first: spec.md and plan.md templates, and a Stages
                       section in AGENTS.md — the spec, then the plan, then the code, then
                       checklist.md, each next stage only after your "ok". Task only. Every
                       new task gets checklist.md, with --spec or without
  --dry-run            print the plan as JSON (the task's state, each source's plan) and
                       change nothing
  --json               print one JSON document, the outcome or the error, and nothing
                       else on stdout; with --dry-run, the plan inside it. Never starts
                       the agent
  --no-launch          don't start the agent; print the next step instead
`,
  'help.add': `
wsg add <path> [options]
  Attach one source to the workspace. Every check runs before anything is touched;
  a failure rolls back only this source.

  <path>               a repository, a subdirectory of one, or a directory outside git
  --worktree           a git worktree with its own branch: the default for a repository root
  --link               a symlink to the shared checkout, for a repository the task only
                       reads; always for a subdirectory and in a process
  --reference          a symlink to a directory outside git: specs, exports, designs
  --branch B           the task branch. An existing one is attached as it is, one only
                       on origin is continued
  --base REF           what a new branch starts from; default: origin/<target>
  --reset-to-base      start an existing branch over from the base; the old head is kept
                       in backup/…
  --target T           the branch the MR goes to; default: origin/HEAD
  --verify CMD         the command that checks the work (tests), one line; goes to AGENTS.md
  --carry all|none|a,b ignored files to copy from the main checkout (.env, certificates):
                       all (default), none, or a list of names
  --[no-]clone-node-modules
                       clone node_modules from the main checkout (default, copy-on-write
                       on macOS) or leave it to install
  --note TEXT          a note on the source, shown next to it in AGENTS.md
  --branch-template T  epic only: the branch each task of the epic gets a worktree on,
                       with {slug} and/or {ticket}, e.g. alice/task/{slug}/{ticket}.
                       Without it the repository is linked into each task as is
  --dry-run            print the plan as JSON and change nothing
  --json               print one JSON document, the outcome or the error, and nothing
                       else on stdout; with --dry-run, the plan inside it
  --ws SLUG|PATH       the workspace; default: the one you are in

  In an epic a repository is always a link: --worktree, --branch and --reset-to-base
  are refused, and --base, --carry and --[no-]clone-node-modules describe the tasks'
  worktrees, so they need --branch-template.

  In a task of an epic, wsg add <name> takes the epic's source of that name: a worktree
  on the branch its template gives the task, or the link as is, with the epic's target,
  verify, note and defaults; a flag given wins. ./<name> is a path.
`,
  'help.remove': `
wsg remove <name> [options]
  Detach a source: a clean worktree (its branch is kept) or the symlink, with its rule
  and generated parts. To fix a source attached with the wrong flags: remove, then add.

  <name>               the source's name in the workspace
  --delete-ignored     also delete ignored files that exist nowhere else; without it
                       the removal stops and lists them
  --expect-ignored FILE
                       with --delete-ignored: FILE holds {ignored, ignoredStamp} of an
                       earlier --dry-run --json (the whole result does too); other
                       ignored files — one more or one less — or a change inside the
                       listed ones refuse the removal, and nothing is changed. A
                       node_modules wsg cloned and carried copies equal to the main
                       checkout are not in it and are deleted as before.
                       Any activity in a listed directory (a .DS_Store, a watcher, a
                       dev server) refuses until it stops; the refusal carries the
                       fresh list. What does not read under them refuses: it can't
                       be checked
  --dry-run            print the plan as JSON and change nothing
  --json               print one JSON document, the outcome or the error, and nothing
                       else on stdout; with --dry-run, the plan inside it
  --ws SLUG|PATH       the workspace; default: the one you are in
`,
  'help.refresh': `
wsg refresh [options]
  Bring the generated parts of a workspace up to date with this wsg: text between
  <!-- wsg:… --> markers, additionalDirectories and the MCP keys (enabledMcpjsonServers,
  deniedMcpServers) in .claude/settings.json, an epic's .mcp.json entries, the repo
  pointer and mr-target-branch.txt. Nothing else is touched.

  --tasks              in an epic: then every task of it, each under its own lock; a
                       busy task is reported and left for later, a done one as it is
  --dry-run            print the files it would change as JSON
  --json               print one JSON document, the outcome or the error, and nothing
                       else on stdout; with --dry-run, the plan inside it
  --ws SLUG|PATH       the workspace; default: the one you are in
`,
  'help.team': `
wsg team <preset> [options]
  Add a team of roles: cards and a workflow in team/, a Claude Code subagent per role,
  and /wsg-feature in a task workspace. Only adds: an existing file is kept.
  Not in an epic: run it in a task of the epic.

  <preset>             fullstack: pm, designer, frontend, backend, devops, reviewer
  --without ROLE,...   roles to leave out, comma-separated
  --dry-run            print what it would create, keep and update as JSON
  --ws SLUG|PATH       the workspace; default: the one you are in
`,
  'help.check': `
wsg check [path|slug] [--json]
  Check a workspace against the conventions: errors, warnings, the always-on budget.
  Exit 1 when it finds errors.

  path|slug            the workspace; default: the one you are in
  --json               print one JSON document — the report by section, the counts —
                       and nothing else on stdout; errors found: ok false, exit 1. Each
                       line is an item of its section: ok, warn, fail, or info for a note;
                       the warnings are there, not in the envelope's warnings
`,
  'help.list': `
wsg list [--json]
  List every workspace in WS_ROOT: epics, tasks and processes, each epic's tasks
  under it, with the kind, the status of a task ([review], [done date], [archived date]), the ticket
  and the title. A 0.1 workspace and one whose state does not read are listed too,
  with what is wrong. Only reads; runs no git.

  --json               print one JSON document — the workspaces with their state, sources
                       and the directories a session needs — and nothing else on stdout
`,
  'help.status': `
wsg status <task> [open|review|done] [options]
  Print the status of a task or a process: open, review or done (with the date it was
  closed). With a status, set it: any move is allowed, and setting the status it has
  changes nothing. Only .claude/wsg.json and, in a task of an epic, the tasks block of
  the epic's tasks.md change (a done task of an epic reopened also gets what its epic
  changed meanwhile: its generated parts are refreshed); no notes, knowledge, branches
  or worktrees. Moving to done
  warns about uncommitted or unpushed work and about entries still under
  "## For the epic" in notes.md, and never refuses for them. done is set by the epic
  session or the owner; the task's own session sets review. An archived task reads
  archived (wsg archive); its status changes only with wsg unarchive.

  <task>               the task: a slug, <epic>/<task> or a path; always given
  open|review|done     the status to set; without it the status is printed
  --dry-run            print the plan as JSON and change nothing
  --json               print one JSON document, the outcome or the error, and nothing
                       else on stdout; with --dry-run, the plan inside it
`,
  'help.archive': `
wsg archive [<task>] [options]
  Archive a finished task, a process or an epic: free the disk its worktrees hold and
  keep everything else. Goes: the worktrees (git worktree remove, never forced) with the
  node_modules and builds in them, and the symlinks. Stays: the workspace with its notes,
  memory, rules and knowledge, every branch (never deleted), and the sources as they were
  attached, in .claude/wsg.json. Everything is checked first: a worktree with changes,
  untracked files, ignored files that exist nowhere else or a detached commit no branch has
  refuses the whole archive, and nothing is touched. Unpushed commits are a warning: the
  branch keeps them. An epic takes its tasks with it; one task that refuses refuses all.

  <task>               the workspace: a slug, <epic>/<task> or a path; default: the one
                       you are in
  --delete-ignored     also delete the ignored files listed, which exist nowhere else;
                       a file that appears after the check still refuses
  --expect-ignored FILE
                       with --delete-ignored: FILE holds the blockers.ignored array of
                       an earlier --dry-run --json without --delete-ignored, the files
                       you were shown, with their stamps; other ignored files — one
                       more or one less — or a change inside the listed ones (a file
                       made, edited or deleted in a listed directory) refuse the
                       archive, nothing is changed, and the refusal lists them in the
                       same shape. A node_modules wsg cloned and carried copies equal
                       to the main checkout are not in it and are deleted as before.
                       Any activity in a listed directory (a .DS_Store, a watcher, a
                       dev server) refuses until it stops; the refusal carries the
                       fresh list. What does not read under them refuses: it can't
                       be checked
  --dry-run            print the plan as JSON — what goes, what stays, the size, what
                       refuses — and change nothing
  --json               print one JSON document, the outcome or the error, and nothing
                       else on stdout; with --dry-run, the plan inside it
  --ws SLUG|PATH       the workspace, instead of <task>
`,
  'help.unarchive': `
wsg unarchive [<task>] [options]
  Bring an archived workspace back: each worktree attached again on its branch as it
  is, each link made again, the rule files the archive kept taken as they are, the
  status it had (with the date it was closed) put back. Every source must be able to
  come back — the checkout there, the branch there and checked out nowhere else, the
  name free in the workspace — or nothing is changed. An epic brings back its links and
  the tasks its archive took; a task archived on its own stays archived. Ignored files
  deleted with --delete-ignored do not come back.

  <task>               the workspace: a slug, <epic>/<task> or a path; default: the one
                       you are in
  --dry-run            print the plan as JSON and change nothing
  --json               print one JSON document, the outcome or the error, and nothing
                       else on stdout; with --dry-run, the plan inside it
  --ws SLUG|PATH       the workspace, instead of <task>
`,
  'help.reorder': `
wsg reorder <item> (--before X | --after X | --to N) [options]
  Move a task of an epic in the order its tasks.md shows. Two groups, each ordered on
  its own, never mixed: the task directories of the epic — the <!-- wsg:tasks --> block,
  stored in the epic's .claude/wsg.json as taskOrder, which wsg list follows — and the
  tracker tasks, the list items under "## Other tasks", each moved with its indented
  lines. A tracker task is named by the key its item starts with (ACME-12, #12); a
  section with an item without a key, the same key twice, a table, other text or a
  comment or code block left open is refused, as the epic guide writes it: one item per task, key first. A new task goes
  to the end of its group. Moving a task where it is changes nothing.

  <item>               a task directory of the epic (its slug), or a tracker key
  --before X           put it right before X, of the same group
  --after X            put it right after X, of the same group
  --to N               put it at position N of its group, from 1
  --dry-run            print the plan as JSON and change nothing
  --json               print one JSON document, the outcome or the error, and nothing
                       else on stdout; with --dry-run, the plan inside it
  --ws SLUG|PATH       the epic; default: the one you are in, or the epic of the task
                       you are in
`,
  'help.close': `
wsg close <task> [options]
  Mark a task or a process done: the same as wsg status <task> done, with the same
  warnings and the same result. Nothing is merged, pushed or removed.

  <task>               the task: a slug, <epic>/<task> or a path
  --dry-run            print the plan as JSON and change nothing
  --json               print one JSON document, the outcome or the error, and nothing
                       else on stdout; with --dry-run, the plan inside it
`,
  'help.context': `
wsg context add <url|path> [options]
wsg context note <id> (--text T | --from FILE | --from -) [options]
wsg context remove <id> [options]
wsg context list [--json] [--ws SLUG|PATH]
  An epic's context: files, notes and links its tasks may need. The epic's AGENTS.md
  and every task's get an index of them, one line per item, in a <!-- wsg:epic-context -->
  block; an agent opens an item only when its work touches the topic. A change is
  rendered into every task of the epic at once: a busy task is reported and catches up
  at its next wsg refresh, a done one is left as it is. Epics only in this version.

  add <url|path>       an http(s) URL is kept as a link; a file is copied into context/
                       (one already in context/ is listed as it is); a directory is
                       refused: attach it with wsg add <path> --reference
  note <id>            write a note to context/notes/<id>.md
  remove <id>          drop an item from the index; a file wsg copied in and a note are
                       deleted from context/, a file that was there already is kept
  list                 the items, and the size of the index block every task carries
  --id ID              the item's id, kebab-case; default: from the file name or the URL
  --title T            one line, at most 200 characters; default: the file name, the URL
                       or the id
  --desc D             one line, at most 200 characters: what the item is for
  --text T             the note's text
  --from FILE|-        the note's text from a file, or from stdin with -
  --replace            rewrite a note that exists (its title and description, if given)
  --discard-edits      remove or rewrite a file or note even though it was edited by hand
                       since wsg wrote it; without it that is refused
  --dry-run            print the plan as JSON and change nothing
  --json               print one JSON document, the outcome or the error, and nothing
                       else on stdout; with --dry-run, the plan inside it
  --ws SLUG|PATH       the epic; default: the one you are in

  Limits: a file above 1 MiB is a warning, above 20 MiB refused; the index block above
  2 KiB is a warning, above 4 KiB refused. A binary file (PDF, image) is copied as it is
  and marked: Claude Code reads it, other agents may not.
`,
  'help.mcp': `
wsg mcp add <name> [--env A,B=value] -- <command> [args...]
wsg mcp add <name> --url URL [--bearer-env VAR]
wsg mcp remove <name> [options]
wsg mcp disable <name> [options]
wsg mcp enable <name> [options]
wsg mcp list [--json] [--ws SLUG|PATH]
  An epic's MCP servers for Claude Code. The epic's servers go into <epic>/.mcp.json,
  which sessions in the epic and in every task inside it find, and are enabled by name
  in each workspace's .claude/settings.json; a global server the epic turns off is
  denied there by name. The owner's own entries in both files are kept. A change is
  rendered into every task of the epic at once: a busy task is reported and catches
  up at its next wsg refresh, a done one is left as it is. Epics and Claude Code only
  in this version. Running sessions keep their servers: restart them.

  add <name>           a server started by the command after --, or an http server
                       (--url); the name: letters, digits, - and _
  remove <name>        the epic's server out of .mcp.json and the settings
  disable <name>       turn off a global server in the epic and its tasks: a name from
                       your user-scope config, or a plugin's as plugin:<plugin>:<server>
  enable <name>        turn it on again
  list                 the epic's servers, the ones turned off, the user-scope ones
                       (names only), and the variables this shell has no value for
  --env A,B=value      variables the server gets: A by reference — \${A} in .mcp.json,
                       taken from the environment the agent runs in; B=value a literal,
                       refused for a name that looks like a secret (TOKEN, KEY, SECRET,
                       PASSWORD, AUTH, ...); no commas in a value
  --url URL            an http(s) MCP server
  --bearer-env VAR     the variable holding an http server's token: sent as
                       Authorization: Bearer \${VAR}
  --agent claude       the agent; codex is not supported yet
  --dry-run            print the plan as JSON and change nothing
  --json               print one JSON document, the outcome or the error, and nothing
                       else on stdout; with --dry-run, the plan inside it; variables by
                       name only, never a value
  --ws SLUG|PATH       the epic; default: the one you are in

  Secrets stay out of the files: export them in your shell (or the app's environment)
  and pass the names. A token in an argument or a URL is warned about: .mcp.json is
  readable by every task's agent. In a terminal, a task's servers are "Pending approval"
  until the task folder is trusted, once per task directory. A server that signs in
  with OAuth: authenticate it once in a terminal session (/mcp).
`,
  'help.promote': `
wsg promote [slug|path] --skill NAME
  Turn a task into a process: sources, rules and memory stay; a skill stub and
  a journal with the first run are added. There is no way back.
  Not for an epic or its tasks.

  slug|path            the workspace; default: the one you are in
  --skill NAME         the skill the procedure is run as (/<name>); kebab-case, not wsg-…
`,
  'help.guide': `
wsg guide [setup|advisor|teach|epic]
  Print a guide an agent follows.

  setup                the setup dialogue (default)
  advisor              the wsg-advisor's procedure
  teach                teaching a team role a practice (/wsg-teach)
  epic                 working in an epic: starting, closing and syncing its tasks
`,
  'help.install-skills': `
wsg install-skills [--uninstall]
  Install the wsg-new and wsg-teach skills and the wsg-advisor agent for Claude Code
  (~/.claude or $CLAUDE_CONFIG_DIR), and the wsg-advisor agent for Codex when it is
  there. Overwrites only files it wrote.

  --uninstall          remove only the files it wrote
`,
  'help.shell-init': `
wsg shell-init zsh
  Print the ws navigation function. Add to ~/.zshrc:
    eval "$(wsg shell-init zsh)"
`,
  'cli.shellUnsupported': 'the ws function is written in zsh; there is no version for {shell} yet.\n  wsg itself works in any shell.',
  'cli.cannotReadSettings': 'cannot read settings: {msg}',
  'cli.windows': 'Windows is not supported yet: POSIX-style git worktrees and symlinks are required.\n  Works in WSL.',
  'cli.unknownCommand': 'unknown command: {cmd} (see --help)',
  'cli.unknownArg': 'unknown argument: {arg} (see --help)',
  'cli.needsValue': '{arg} needs a value (see --help)',
  'cli.noValue': '{arg} takes no value',
  'cli.extraArg': 'unexpected argument: {arg} (see --help)',
  'cli.done': 'Done',
  'cli.next': 'Next:',
  'cli.cancelled': 'Cancelled, nothing created.',
  'cli.newSlug': 'specify the workspace slug: wsg new <slug>',
  'cli.badKind': '--kind is task, process or epic, not {kind}',
  'cli.skillForProcess': '--skill is only for --kind process',
  'cli.created': 'Created {ws}: a skeleton, no repositories yet',
  'cli.noEpic': 'no epic {ws}',
  'cli.epicOutsideRoot': '{ws} is not in WS_ROOT ({root}): a task of an epic is made only in an epic there',
  'cli.createdWithSources': 'Created {ws}',
  'cli.epicTaskNext': '  A task of epic {epic}, listed in its tasks.md.',
  'cli.epicAttached': '  From the epic: {list}.',
  'cli.epicAs.worktree': '{name} (a worktree on {branch})',
  'cli.epicAs.link': '{name} (a link)',
  'cli.epicAs.reference': '{name} (a reference)',
  'cli.epicNoGit': '  No git repository from the epic: attach one from the task with wsg add <name> (the epic\'s sources: {list})\n  or wsg add <path>; until a git repository is attached, wsg check says "setup not finished".',
  'cli.epicDefaultNeedsTicket': "the epic's source {name} is not taken: its branch template needs the task's ticket key, and the task has none. Give --ticket <KEY>, or attach it later with wsg add {name} --branch B",
  'cli.epicDefaultTicketNoKey': "the epic's source {name} is not taken: its branch template needs the task's ticket key, and the ticket given, {ticket}, has none wsg can use in a branch name (a key like PROJ-42). Give --ticket a key, or attach it later with wsg add {name} --branch B",
  'cli.sourcesNeedEpic': '--sources applies only with --epic: a task outside an epic gets its repositories with wsg add',
  'cli.noCodeKind': '--no-code is only for a task, not for --kind {kind}',
  'cli.noCodeSources': '--no-code takes no source of the epic: a task without code has no branch. Leave out --sources (or give --sources none); attach material to read later with wsg add <name> --link',
  'cli.noCodeNext': '  No code in this task: no repository, no branch. Material to read: wsg add <path> --link or --reference.',
  'cli.specKind': '--spec is only for a task, not for --kind {kind}',
  'cli.sourcesNone': '--sources none stands alone: either none or a list of the epic\'s sources',
  'cli.sourcesTwice': '--sources names {name} twice',
  'cli.epicUnreadable': 'the epic of this task can\'t be read, so it can\'t tell whether {name} is one of its sources: {msg}\n  Give a path (./{name}) to attach a directory of that name',
  'cli.launching': 'Starting {agent}…',
  'cli.launchFailed': 'could not start {agent}: {msg}',
  'cli.nextWs': '  ws {slug}        then type /wsg-setup',
  'cli.tellAgent': '  and tell the agent: Read SETUP.md and follow it',
  'cli.noAgent': '  no agent found: set WSG_AGENT in {file}, or start yours in the workspace',
  'cli.addPath': 'specify the source: wsg add <path>',
  'cli.oneMode': 'choose one of --worktree, --link, --reference',
  'cli.notInWorkspace': 'not inside a wsg workspace: run it from one, or pass --ws <slug|path>',
  'cli.noWorkspace': 'no workspace {ws}',
  'cli.notWorkspace': '{ws} is not a wsg workspace: it has no .claude/wsg.json. Create one with wsg new',
  'cli.legacyWorkspace': '{ws} was created by wsg 0.1: it has no .claude/wsg.json, so wsg cannot tell which parts are generated.\n  Attach sources there by hand, or create a new workspace with wsg new.',
  'cli.added': 'Attached {name}',
  'cli.restart': '  settings.json changed: restart the agent session in this workspace, so that {path} is readable',
  'cli.addNext': '  Next: wsg check',
  'cli.addCancelled': 'Cancelled, the workspace is as it was.',
  'cli.cancelledIncomplete': 'Cancelled, but the rollback hit errors (above): check the workspace.',
  'cli.cancelledKept': 'Cancelled. The workspace is as it was, except the files kept above: {list}',
  'cli.removeName': 'specify the source: wsg remove <name>',
  'cli.removed': 'Removed {name}',
  'cli.refreshed': 'Updated: {list}',
  'cli.refreshNone': 'The generated parts are up to date',
  'cli.refreshRestart': '  settings.json changed: restart the agent session in this workspace',
  'cli.refreshTasksEpic': '{ws} is a {kind} workspace: --tasks refreshes the tasks of an epic',
  'cli.refreshTasksInterrupted': 'Stopped. {epic} is refreshed; tasks not refreshed: {list} — run wsg refresh in each',
  'cli.branchKept': '  branch {branch} is kept in {path}',
  'cli.teamWritten': {
    one: 'Team {preset}: {n} file written',
    other: 'Team {preset}: {n} files written',
  },
  'cli.teamNone': 'The team is in place: nothing to write',
  'cli.teamKept': '  kept {file}: it exists, not overwritten',
  'cli.teamRestart': '  Start a new session before using the roles or /wsg-feature (ws {slug}, or claude in the workspace): a running one does not see them',
  'cli.teamNext': '  Next: run /wsg-feature <what to build> in Claude Code',
  'cli.teamNextProcess': '  Next: run /{skill} — it points to team/workflow.md',
  'cli.checkFailed': 'wsg check found {fails} errors and {warns} warnings',
  'list.empty': 'No workspaces in {root} yet: wsg new <slug> creates one.',
  'list.legacy': '(wsg 0.1: no .claude/wsg.json)',
  'list.unreadable': '(its state does not read: see wsg check)',
  'list.notEpicTask': 'inside epic {epic}, but its state does not link it to an epic',
  'list.checklistUnreadable': "checklist.md is there but can't be read ({why}): its items are not counted",
  'list.badSource': 'source #{n} is not a source: {value} — left out; fix .claude/wsg.json by hand',
  'list.orphanTask': 'its state names epic {epic}, but it is not inside an epic: see wsg check',
  'list.otherEpic': 'its state names epic {epic}: see wsg check',
  'list.forEpicPending': '(For the epic in notes.md not merged yet)',
  'cli.statusTask': 'name the task: wsg status <task> [open|review|done]',
  'cli.closeTask': 'name the task: wsg close <task>',
  'cli.badStatus': '{value} is not a status: one of {list}',
  'cli.statusArchived': 'archived is not set with wsg status: wsg archive <task> sets it (it removes the worktrees, the branches are kept)',
  'cli.statusEpic': '{ws} is an epic: it has no status, its tasks do — name one as <epic>/<task>',
  'cli.statusSet': '{task}: {previous} -> {status}',
  'cli.statusSame': '{task} is {status} already: nothing changed',
  'cli.statusTasksMd': 'Updated the tasks block of {file}',
  'cli.archivedWs': '{ws} is archived: its sources are in the archive record — wsg unarchive {name} first',
  'cli.epicArchivedAdd': 'the epic {epic} of this task is archived: its sources are detached — wsg unarchive {epic} first',
  'cli.expectNeedsDelete': '--expect-ignored only goes with --delete-ignored: it names the ignored files you agree to delete',
  'cli.expectUnreadable': '--expect-ignored: {file} does not read ({why})',
  'cli.archiveCancelled': 'Cancelled, nothing changed.',
  'cli.archived': 'Archived {name} ({date})',
  'cli.archivedFreed': '  worktrees removed: {n}, up to {size} freed (their apparent size: copy-on-write clones free less)',
  'cli.archiveSame': '{name} is archived already, since {date}: nothing to do',
  'cli.archiveBack': '  wsg unarchive {name} attaches the sources again on the same branches',
  'cli.archiveTaskFailed': 'task {task} could not be archived: {msg}',
  'cli.archivePartial': 'Archived by this run, and kept so: {list}. The epic is not archived yet: run the command again to go on',
  'cli.unarchived': 'Unarchived {name}: status {status}',
  'cli.unarchivedEpic': 'Unarchived {name} and {n} of its tasks',
  'cli.unarchivedWorktree': '  worktree {name} on {branch}',
  'cli.unarchiveSame': '{name} is not archived: nothing to do',
  'cli.unarchiveTaskFailed': 'task {task} could not be unarchived: {msg}',
  'cli.unarchivePartial': 'Unarchived by this run, and kept so: {list}. The epic is still archived: run the command again to go on',
  'cli.promoteSkill': 'specify the skill name: wsg promote [slug|path] --skill <name>',
  'cli.guideTopic': 'no guide {topic}: available — {topics}',
  'cli.skillWritten': 'installed {file}',
  'cli.skillUnchanged': 'up to date: {file}',
  'cli.skillRefused': '{file} exists and was not written by wsg (no "generated by wsg" marker): not overwriting.\n  Move it away, then run wsg install-skills again.',
  'cli.skillRemoved': 'removed {file}',
  'cli.skillAbsent': 'not installed: {file}',
  'cli.skillSkipped': '  skipped {file}: no Codex here (no CODEX_HOME, no ~/.codex, no codex on PATH)',
  'cli.skillNotOurs': '{file} was not written by wsg (no "generated by wsg" marker): kept',

  'validate.required': 'Required',
  'validate.kebab': 'Lowercase Latin letters, digits and hyphens only',
  'validate.skillPrefix': 'the wsg- prefix is reserved for the skills wsg writes itself',
  'validate.exists': '{path} already exists',
  'validate.branchInvalid': '{b} is not a valid branch name',
  'validate.branchBusy': '{b} is already checked out in another worktree',
  'validate.branchConflict': 'conflicts with existing branch {conflict}: git branches are paths',
  'validate.refNotFound': 'ref {ref} not found in {name}',

  'workspace.badSlug': 'slug {slug}: {why}',
  'workspace.badSkill': 'skill name {name}: {why}',
  'workspace.badSkillFromSlug': 'the process skill is named after the slug, and {name} won\'t do: {why}. Pass --skill <name>',
  'workspace.outside': 'slug {slug} leads outside {root}',
  'workspace.stateInvalid': 'cannot read {file}: {msg}',
  'workspace.notEpic': '{ws} is not an epic',
  'workspace.badKind': 'workspace kind {kind}: task, process or epic only',
  'workspace.epicTaskKind': 'only a task goes inside an epic, not kind {kind}',
  'workspace.childReserved': "a task of an epic can't be named {slug}: the epic uses the name itself",
  'workspace.childIsSource': "a task of an epic can't be named {slug}: the epic has a source by that name",

  'add.noPath': 'no source path given',
  'add.selfSource': '{path} is the workspace itself, not a source',
  'add.insideSource': '{path} is inside the workspace {ws}: a source lives outside it',
  'add.containsSource': '{path} contains the workspace {ws}: attaching it would link the workspace into itself',
  'add.multiline': '{flag} must be one line',
  'add.markerValue': "{flag} can't contain <!--: it would read as a wsg marker",
  'add.backtick': "{flag} can't contain a backtick: the command is shown in `code`",
  'add.badTarget': '--target {target} is not a valid branch name',
  'add.targetUnknown': '--target: {target} exists neither in {name} nor on origin — check the name',
  'add.renamed': 'will be named {name} in the workspace: spaces break imports',
  'add.duplicatePath': 'this source is already attached as {name}',
  'add.duplicateName': "name {name} is already taken by source {path}: a workspace can't hold two directories with the same name",
  'add.taken': '{name} already exists in the workspace',
  'add.notGit': '{path} is not under git. A source is a git repository; a directory with material for the task is attached with --reference',
  'add.referenceIsGit': '{path} is under git: attach it with --link or --worktree, --reference is for directories outside git',
  'add.subdirWorktree': 'a worktree is always of the whole repository: give its root {top}, or attach this directory with --link',
  'add.subdirLink': 'part of the git repository {top} — attached as a link; for a worktree, give the repository root',
  'add.processWorktree': 'a process has no permanent branch: its repositories are attached with --link, the skill makes a branch per run',
  'add.noCodeWorktree': 'no-code task: no branches. A repository is read through a link: --link (or --reference for a directory outside git)',
  'add.noCodeLink': 'no-code task: attached as a link — a task without code has no branch',
  'add.processLink': 'process: attached as a link — a process has no permanent branch',
  'add.worktreeOnly': '{flag} applies only to a worktree, and this source is a {mode}',
  'add.referenceFirst': 'no git repository is attached yet: the workspace is set up only with one',
  'add.branchRequired': 'a worktree needs a task branch: --branch <name>, following the repository naming convention',
  'add.attachAsIs': 'branch {branch} exists: attached as it is, its commits are kept',
  'add.diverged': 'branch {branch} and origin/{branch} differ: {ahead} commits only here, {behind} only on origin — nothing is merged',
  'add.continuing': 'continuing {remote}: the local branch starts there and tracks it',
  'add.baseWithExisting': '--base applies only to a new branch or with --reset-to-base: {branch} exists and is attached as is',
  'add.resetNew': '--reset-to-base applies to an existing branch, and {branch} is new here',
  'add.remoteBase': '{remote} exists: a new branch from {base} would leave its commits out.\n  Leave out --base to continue it, or add --reset-to-base to start over from {base}',
  'add.remoteReset': 'starting {branch} over from {base}: the commits of {remote} are not included',
  'add.branchReset': 'branch {branch} exists: it is reset to the base, the current head is saved in backup/…',
  'add.baseLocal': 'no origin/{target}: branching from the local {target}',
  'add.carryUnknown': '--carry: {file} is not among the untracked files that can be copied (see --dry-run)',
  'add.nmMissing': 'the main checkout has no node_modules to clone',
  'add.epicWorktree': "an epic has no branch of its own: its repositories are links, and each task gets its worktree. Leave out --worktree; --branch-template sets the tasks' branches",
  'add.branchInEpic': "{flag}: an epic has no branch of its own — its tasks' branches come from --branch-template",
  'add.taskDefaultsNeedTemplate': '{flag} describes the worktrees of the epic\'s tasks, so it needs --branch-template; without one the repository is linked into each task as is',
  'add.templateOnlyEpic': '--branch-template applies only in an epic, and this workspace is not one',
  'add.referenceIsGitEpic': '{path} is under git: in an epic attach it as a link — plain wsg add, or --link; --reference is for directories outside git',
  'add.templateNotRepo': '--branch-template needs a git repository, and this source is a {mode}',
  'add.templateSubdir': 'a task worktree is always of the whole repository: give its root {top} for --branch-template',
  'add.templateEmpty': '--branch-template is empty',
  'add.templateText': "--branch-template {template}: one line, no backtick and no <!--: it is shown in AGENTS.md",
  'add.templateUnknown': '--branch-template {template}: {name} is no placeholder — only {slug} and {ticket}',
  'add.templateNoPlaceholder': '--branch-template {template} has no {slug} or {ticket}: every task would get the same branch',
  'add.templateInvalid': '--branch-template {template}: a task\'s branch would be {sample}, which is not a valid branch name',
  'add.epicReserved': "a source of an epic can't be named {name}: its rule would replace the epic's .claude/rules/epic-knowledge.md",
  'add.epicSourceUnknown': 'the epic {epic} has no source {name} (its sources: {list})',
  'add.templateNeedsTicket': "the epic's branch template {template} needs the task's ticket key, and none was given: make the task with --ticket <KEY>, or attach the source later from the task with wsg add {name} --branch B",
  'add.templateTicketNoKey': "the epic's branch template {template} needs the task's ticket key, and the ticket given, {ticket}, has none wsg can use in a branch name (a key like PROJ-42): give --ticket a key, or attach the source later from the task with wsg add {name} --branch B",
  'add.templateTaskNoKey': "the epic's branch template {template} needs the task's ticket key, and this task has none in its state: give --branch B",
  'add.epicNoneReserved': "a source of an epic can't be named none: wsg new --sources none means no source",
  'add.epicCarryGone': "{list} from the epic's carry list is no longer in the main checkout: not copied",
  'add.epicLinkedIntoTasks': '{name} is linked into each task of the epic as is; to give tasks a worktree of it, attach it with --branch-template',

  'remove.unknown': 'no source {name} in this workspace (sources: {list})',
  'remove.dirty': 'worktree {name} has changes that exist nowhere else — commit, stash or remove them first:\n{list}',
  'remove.ignored': 'worktree {name} has ignored files that exist nowhere else (made there, or copied in by wsg and changed since), and git would delete them with it:\n{list}\n  Move out what you need, then run the command again with --delete-ignored',
  'expect.changed': 'the ignored files changed since you saw them; nothing was changed. They are now:\n{list}\n  Look at the list and run the command again',
  'expect.stampChanged': 'worktree {name}: the ignored files you agreed to changed after the check (a file in them made, edited or deleted), and git would delete them with it:\n{list}\n  Nothing was changed; run the command again',
  'expect.unverifiable': 'worktree {name}: something under its ignored files does not read, so wsg cannot check what you would agree to delete; nothing was changed. Fix the permissions (or move it out), then run the command again',
  'expect.none': '(none)',
  'expect.notJson': 'not JSON',
  'expect.notRemove': 'not {ignored, ignoredStamp}',
  'expect.bad': 'not the list --expect-ignored takes ({why})',
  'expect.notArray': 'not a JSON array',
  'expect.badEntry': 'entry {n} is not {task, source, files, stamp}',
  'expect.badFile': 'entry {n} is not a path',
  'remove.ignoredAppeared': 'worktree {name}: ignored files appeared after the check, and git would delete them with it:\n{list}\n  Nothing was changed; run the command again',
  'remove.listFailed': 'worktree {name}: git could not list its ignored files ({why}), and git would delete them with it unseen. Nothing was changed',
  'remove.statusFailed': 'worktree {name}: git could not list its changes ({why}), and they would be lost unseen. Nothing was changed',
  'remove.listTooLarge': 'worktree {name}: git lists more than 256 MiB of files there — too many to check, and git would delete them with it unseen. Nothing was changed.\n  Delete the build output in it by hand (move out what you need first), then run the command again',
  'remove.nmNotChecked': 'node_modules wsg cloned into {name} is not checked: changes made inside it are deleted with the worktree',
  'remove.more': '… and {n} more',
  'remove.asWorktree': 'its worktree',
  'remove.asLink': 'a link',
  'remove.epicTasksKeep': 'tasks of the epic that have a source {name} keep it as it is: {list}. Only new tasks stop getting it',
  'remove.worktreeFailed': 'git did not remove worktree {name}: {out}',
  'remove.notLink': '{name} is not the symlink wsg made — not removing it',
  'remove.ruleKept': '{file} was not written by wsg: kept',
  'remove.worktree': '  worktree {name} removed',
  'remove.symlink': '  symlink {name} removed',
  'remove.detached': 'worktree {name} is on a detached HEAD, commit {sha}, which no branch has: it would be lost with the worktree — put it on a branch there (git switch -c <branch>), then run the command again',

  'archive.notWorktree': '{name} is not a worktree of {repo}: wsg archive removes only the worktrees wsg made — move it out of the workspace by hand, then run the command again',
  'archive.half': 'the state says archived, but has no archive record (a half archive): set a status with wsg status first',
  'archive.unpushed': {
    one: '{name}: 1 commit of {branch} is not on {ref} — the branch keeps it; push it if it belongs elsewhere too',
    other: '{name}: {n} commits of {branch} are not on {ref} — the branch keeps them; push it if they belong elsewhere too',
  },
  'archive.unpushedUnknown': '{name}: could not tell whether the commits of {branch} are pushed (no upstream, no base to compare with) — the branch keeps them',
  'archive.taskUnreadable': 'task {task} of the epic: its state does not read — fix it first: archiving the epic takes every task in it',
  'archive.taskOtherEpic': '{task}/ names epic {epic} in its state — fix it or move it out first: archiving the epic takes every task in it',
  'archive.rollingBack': 'Archiving {ws} aborted. Rolling it back',
  'unarchive.taken': '{name} is taken in the workspace ({path}): move it away first, then run the command again',
  'unarchive.pathGone': '{name}: {path} is not there any more: put it back first, then run the command again',
  'unarchive.notRepo': '{name}: {path} is no git checkout any more: put it back first, then run the command again',
  'unarchive.branchGone': '{name}: branch {branch} is gone from {path}, so there is nothing to attach the worktree to — bring the branch back first',
  'unarchive.branchBusy': '{name}: branch {branch} is checked out in another worktree of {path}: free it first',
  'unarchive.cascadeGone': 'task {task}, which the archive of the epic took, is not there any more: skipped',
  'unarchive.stale': 'listed as attached, but not in the workspace (a run that stopped half-way): {list} — attached again',
  'unarchive.epicArchived': 'its epic {epic} is archived: a task of it comes back with the epic — wsg unarchive {epic}',
  'unarchive.rollingBack': 'Unarchiving {ws} aborted. Rolling it back',
  'reorder.needItem': 'name the task to move: wsg reorder <item> (--before X | --after X | --to N)',
  'reorder.needWhere': 'say where to move it: exactly one of --before X, --after X, --to N',
  'reorder.epicOnly': '{ws} is a {kind} workspace outside an epic: wsg reorder orders the tasks of an epic — name it with --ws <epic>',
  'reorder.archived': 'the epic {epic} is archived: wsg unarchive {epic} first',
  'reorder.unknown': '{item} is neither a task of the epic {epic} nor a tracker key under "## Other tasks" in its tasks.md (its tasks: {tasks})',
  'reorder.noTracker': '{item} looks like a tracker key, but {file} lists no tracker tasks under "## Other tasks" — sync them first (wsg guide epic → Syncing)',
  'reorder.crossGroup': '{item} and {target} are in different groups — a task directory and a tracker task: each group keeps its own order, a task moves only within its own',
  'reorder.self': '{item} is moved relative to itself: name another task',
  'reorder.badTo': '--to {to}: a position from 1 to {max}',
  'reorder.noSection': '{file} has no "## Other tasks" section: there are no tracker tasks to move',
  'reorder.table': '{file}, line {line}: "## Other tasks" holds a table — tracker tasks are moved as list items, one per task, key first (wsg guide epic → Syncing): rewrite it so',
  'reorder.text': '{file}, line {line}: "## Other tasks" holds text that is no list item — only list items, one per task, key first, with their indented lines (wsg guide epic → Syncing): move it out or indent it under its item',
  'reorder.keyless': '{file}, line {line}: an item under "## Other tasks" without a tracker key at its start — each item starts with its key (ACME-12, #12) (wsg guide epic → Syncing): add it, or move the line out of the section',
  'reorder.duplicate': '{file}, line {line}: {key} is listed twice under "## Other tasks" — one item per task: merge the two',
  'reorder.badSlug': 'left out of the order, their directory names are no slugs (renamed by hand?): {list}',
  'reorder.badSlugItem': '{item}: its directory name is no slug (lowercase Latin letters, digits, hyphens) — rename it back to its slug first',
  'reorder.unclosed': '{file}, line {line}: a comment or a fenced block opened under "## Other tasks" is not closed where the section ends — close it, so the items can be told apart',
  'reorder.rollingBack': 'Reordering in {ws} aborted. Rolling it back',
  'reorder.moved': 'Moved {item}: {from} → {to} of {n}',
  'reorder.same': '{item} is at {to} already: nothing to do',
  'reorder.trackerUpdated': 'Updated "## Other tasks" in {file}',
  'reorder.order': '  order: {list}',
  'remove.headFailed': 'worktree {name}: git could not tell where its HEAD is ({why}). Nothing was changed',
  'remove.refusalsFailed': 'worktree {name}: git could not list its locks and submodules ({why}). Nothing was changed',
  'remove.hidden': 'worktree {name} has edits git status does not show — files marked skip-worktree (S) or assume-unchanged (h) whose bytes or executable bit differ from the index (a clean filter, eol conversion or Git LFS can make an unedited file read so); they exist nowhere else:\n{list}\n  Clear the flag (git update-index --no-skip-worktree / --no-assume-unchanged <file>), commit or move them out, then run the command again',
  'remove.locked': 'worktree {name} is locked (git worktree lock: {why}): git would refuse to remove it — unlock it (git worktree unlock) if it may go, then run the command again',
  'remove.submodules': 'worktree {name} has submodules checked out, and git refuses to remove it without --force, which wsg never uses:\n{list}\n  Deinitialize them there (git submodule deinit --all), then run the command again',
  'remove.worktreeIsLink': '{name} is a symlink, not the worktree wsg made: git would remove what it points to — not removing it',
  'remove.reflogOnly': {
    one: '{name}: 1 commit only the worktree\'s HEAD reflog has, on no branch, goes with it (git may drop it later):\n{list}',
    other: '{name}: {n} commits only the worktree\'s HEAD reflog has, on no branch, go with it (git may drop them later):\n{list}',
  },

  'gen.cowApfsOnly': 'copy-on-write is only available on APFS',
  'gen.clonefileUnavailable': 'clonefile is unavailable',
  'gen.sourceMissing': '{path} does not exist',
  'gen.sourceNotDir': '{path} is not a directory: a source is a repository or a directory',
  'gen.sourceReserved': "a source can't be named {name}: the workspace creates its own {name}",
  'gen.branchConflict': 'name {branch} conflicts with branch {conflict}: git branches are paths',
  'gen.twoSources': 'two sources are named {name}',
  'gen.rollingBack': 'Creation aborted. Rolling back {ws}',
  'gen.addRollingBack': 'Attaching {name} aborted. Rolling back {ws}',
  'gen.undoFailed': 'Rollback step failed: {msg}',
  'gen.worktreeRemoveFailed': 'Failed to remove worktree {name}: {out}',
  'gen.branchLeftAtBase': 'Branch {name} left at the base, previous head is in {backup}: {out}',
  'gen.branchRestored': 'Branch {name} restored to its previous head',
  'gen.branchRestoredNoUpstream': 'Branch {name} restored to its previous head, but its upstream is still the base — check git branch -vv',
  'gen.branchKept': 'Branch {name} kept: it has commits on top of {base}',
  'gen.branchDeleted': 'Deleted created branch {name}',
  'gen.branchDeleteFailed': 'Branch {name} remains, failed to delete: {out}',
  'gen.rollbackDone': 'Rollback complete.',
  'gen.rollbackIncomplete': { one: 'Rollback finished with an error (above): the workspace may not be as it was — check it', other: 'Rollback finished with {n} errors (above): the workspace may not be as it was — check it' },
  'gen.restoreFailed': 'could not put back {file}: {msg}',
  'gen.rollbackDoneKept': 'Rollback complete, except the files kept as they changed during the run: {list}',
  'gen.creating': 'Creating {ws}',
  'gen.epicRulesKept': "AGENTS.md: the epic's Owner rules were not rendered: {why}. The <!-- wsg:epic-rules --> block is kept as it was",
  'gen.epicRulesPlaceholder': "AGENTS.md: the epic's Owner rules were not rendered: {why}. The <!-- wsg:epic-rules --> block points to ../AGENTS.md instead",
  'gen.epicContextKept': "AGENTS.md: the epic's context index was not rendered: {why}. The <!-- wsg:epic-context --> block is kept as it was",
  'gen.epicContextPlaceholder': "AGENTS.md: the epic's context index was not rendered: {why}. The <!-- wsg:epic-context --> block points to ../context/ instead",
  'fanout.done': 'done: not refreshed',
  'fanout.archived': 'archived: not refreshed',
  'fanout.otherEpic': 'its state names epic {epic}: not refreshed (see wsg check)',
  'fanout.interrupted': 'cancelled before this task was refreshed',
  'fanout.rollingBack': 'Refreshing task {task} aborted. Rolling it back',
  'gen.epicRulesNoSection': "AGENTS.md: the epic's AGENTS.md has no ## Owner rules section; the <!-- wsg:epic-rules --> block is kept as it was",
  'gen.epicRulesWhy.noAgentsMd': '{dir} has no AGENTS.md',
  'gen.epicRulesWhy.notWorkspace': '{dir} is no wsg workspace',
  'gen.epicRulesWhy.notEpic': '{dir} is a {kind} workspace, not an epic',
  'gen.epicRulesWhy.otherEpic': '{dir} is epic {found}, but this task\'s state names {slug}',
  'gen.epicRulesCopy': "AGENTS.md: the task's own ## Owner rules section repeats the epic's, which the <!-- wsg:epic-rules --> block now renders: delete the section",
  'gen.epicRulesOverlap': "AGENTS.md: {n} of {m} lines of the task's own ## Owner rules section are also the epic's, which the <!-- wsg:epic-rules --> block now renders: keep only the task's own rules there",
  'gen.ownerRulesWhy.marker': 'they hold a <!-- wsg:… --> marker, which would become a second generated block',
  'gen.ownerRulesWhy.fence': 'they leave a code fence open, which would swallow the rest of AGENTS.md',
  'gen.branchAppeared': 'branch {branch} appeared after the check: run wsg add again',
  'gen.branchGone': 'branch {branch} disappeared after the check: run wsg add again',
  'status.worktreeMissing': '{name}: the worktree is not there, so it was not checked',
  'status.dirty': '{name} has {n} uncommitted changes:\n{list}',
  'status.dirtyUnknown': '{name}: could not read its changes: {why}',
  'status.unpushed': '{name}: {n} commits are not on {ref}',
  'status.unpushedUnknown': '{name}: could not tell whether its commits are pushed: no upstream and no base to compare with',
  'status.checklistUnchecked': '{n} of {total} checklist items unchecked (checklist.md): show them to the owner',
  'status.forEpicPending': '"## For the epic" in notes.md still has entries: the epic has not merged them yet (wsg guide epic, Closing)',
  'status.doneFromTask': 'done is set by the epic session or the owner, not by the task\'s own session: you are inside {ws}',
  'status.siblingUnreadable': 'tasks.md has no line for {task}: its state does not read (see wsg check)',
  'cli.statusCancelled': 'Cancelled, nothing was changed.',
  'gen.statusRollingBack': 'Setting the status aborted. Rolling back {ws}',
  'gen.removeRollingBack': 'Removing {name} aborted. Rolling back {ws}',
  'gen.worktreeReadded': 'Worktree {name} is back on {branch}; files copied in at creation (.env, node_modules) are not',
  'gen.worktreeRestored': '  worktree {name}: the {n} tracked files deleted before the stop are back',
  'gen.worktreePartial': '  worktree {name} is left half-removed at {path}: the tracked files are on its branch {branch} — move what is left aside, then wsg add it again',
  'gen.worktreeReaddFailed': 'Failed to put worktree {name} back on {branch}: {out} — the branch is kept, add it again with wsg add',
  'gen.symlinkOnPath': '{path} in {ws} is a symlink: writing {file} would go outside the workspace — nothing was changed',
  'gen.ruleExists': '{file} exists and was not written by wsg: move your notes elsewhere, then run the command again',
  'gen.backupFailed': 'failed to save a backup of branch {branch} as {bk}: {out}\n  creation aborted to avoid resetting the existing branch',
  'gen.backup': '  backup of existing branch: {bk}',
  'gen.worktree': '  worktree {name} → {branch}',
  'gen.notCopied': '  not copied: {file} — {why}',
  'gen.copied': {
    one: '  untracked files copied: {n} of {total}',
    other: '  untracked files copied: {n} of {total}',
  },
  'gen.nmTracked': '  node_modules is tracked in git and already in the worktree — not cloning',
  'gen.nmCloning': '  cloning node_modules (copy-on-write)...',
  'gen.nmCloned': '  node_modules cloned, actual disk used: {mb} MB',
  'gen.nmVersions': '  versions match the main checkout; run install after switching branches',
  'gen.nmNotCopied': '  {reason} — node_modules not copied, run install',
  'gen.symlink': '  symlink {name} → {path}',
  'gen.repoNamed': 'a source is named repo — not creating the repo pointer, it would overwrite it',
  'gen.notAFile': '{path} in {ws} is not a regular file (a symlink?) — wsg would write outside it',
  'gen.markerBroken': '{file}: the <!-- wsg:{name} --> block has {opens} opening and {closes} closing markers, or they are out of order.\n  Leave exactly one pair (or delete both and wsg adds it back), then run the command again',
  'gen.markerIndented': '{file}: line {line} holds a <!-- wsg:{name} --> marker indented, and there is no pair at the start of a line. wsg writes its markers at column 0.\n  Move the pair back to the start of the line (or put an example in a code block), then run the command again',
  'gen.fenceOpen': '{file}: the code block opened on line {line} is never closed, and wsg markers after it would be taken for code.\n  Close it with {fence}, then run the command again',
  'gen.keptChanged': '{file} changed while wsg ran, so it is kept as it is now: check it, and run wsg refresh if its generated blocks are off',
  'gen.keptChangedSettings': '{file} changed while wsg ran, so it is kept as it is now: check permissions.additionalDirectories by hand, it may still list the directory of the source rolled back',
  'gen.keptChangedState': '{file} changed while wsg ran, so it is kept as it is now: it is the state the generated files are rendered from — check it by hand (wsg check reports what does not read)',
  'gen.keptChangedByHand': '{file} changed while wsg ran, so it is kept as it is now: check it by hand, and fix or delete what this run put there — wsg refresh does not touch it',
  'gen.markerRestored': '{file}: the <!-- wsg:{name} --> markers were missing — the block is added back',
  'gen.blockAdded': '{file}: added the <!-- wsg:{name} --> block (new in wsg {version})',
  'gen.fileMissing': '{file} is missing — its generated part is not updated',
  'gen.settingsInvalid': '{file} is not valid JSON ({msg}): fix it first, wsg does not overwrite it',

  'team.noPreset': 'specify the preset: wsg team <preset> (available: {presets})',
  'team.epic': 'wsg team does not run in an epic: its tasks load the epic\'s agents too. Run it in a task of the epic',
  'team.badPreset': 'no preset {preset}: available — {presets}',
  'team.badRole': '--without: no role {role}; the roles are {roles}',
  'team.noRoles': '--without leaves no role of {preset}',
  'team.stateInvalid': '{file}: "team" is not { preset, roles } with kebab-case role names — fix it by hand first',
  'team.notADir': '{path} in {ws} is not a directory: wsg team writes its files into it',
  'team.skillMissing': '{file} is missing — the pointer to team/workflow.md is not added',
  'team.rollingBack': 'Adding the team aborted. Rolling back {ws}',

  'context.noVerb': 'wsg context needs one of add, note, remove, list (see wsg help context)',
  'context.badVerb': 'unknown command: context {verb} — wsg context takes add, note, remove or list (see wsg help context)',
  'context.need.add': 'specify what to add: wsg context add <url|path>',
  'context.need.note': "specify the note's id: wsg context note <id> --text T",
  'context.need.remove': "specify the item's id: wsg context remove <id> (wsg context list shows them)",
  'context.epicOnly': '{ws} is a {kind} workspace: wsg context works on an epic in this version — name it with --ws <epic>',
  'context.noteSource': "give the note's text with exactly one of --text T, --from FILE or --from -",
  'context.noteRead': 'cannot read {from}: {msg}',
  'context.takenSource': 'context in {ws} is the source {name}: the epic keeps its context in context/ — remove the source (wsg remove {name}) and attach it under another name first',
  'context.takenLink': '{path} is a symlink: the epic keeps its context in context/, a directory of its own — move the link away first',
  'context.takenFile': '{path} is a file: the epic keeps its context in context/, a directory — move the file away first',
  'context.takenTask': '{path} is a task workspace: the epic keeps its context in context/ — move the task to another directory first',
  'context.badText': '{flag} must be one line of at most {max} characters',
  'context.badId': 'the id {id} is not kebab-case of at most {max} characters (a-z, 0-9, -)',
  'context.badUrl': 'only an http or https link can be added: {url}',
  'context.noFile': 'no such file: {path}',
  'context.isDir': '{path} is a directory: a directory is attached as a reference source — wsg add <path> --reference --ws <epic>',
  'context.notFile': '{path} is not a regular file',
  'context.badName': "the file name {name} can't be kept in context/: {why} — rename the file first",
  'context.listedAlready': '{path} is listed already, as {id}',
  'context.fileExists': '{path} exists already and is not listed: list it with wsg context add {path}, or move it away first',
  'context.tooLarge': '{what} is {size}, the ceiling is {max}: add a large file as a link, or a directory of them as a reference source (wsg add --reference)',
  'context.large': '{what} is {size}, above {warn}: an agent will read it only in parts',
  'context.blockTooLarge': 'the index block would be {bytes} B, the ceiling is {max}: every task pays it on every request — shorten titles and descriptions, or remove items',
  'context.blockLarge': 'the index block is {bytes} B, above {warn}: every task pays it on every request — keep titles and descriptions short',
  'context.idTaken': 'the id {id} is taken by a {type}: give another with --id',
  'context.idTakenDerived': 'the id {id}, made from the name, is taken by a {type}: give another with --id',
  'context.noteEmpty': 'the note is empty',
  'context.noteBinary': 'the note is not UTF-8 text: add a binary file with wsg context add <path>',
  'context.noteExists': 'note {id} exists: --replace rewrites it',
  'context.noNote': 'no note {id} to replace: without --replace a new one is written',
  'context.replaceNotNote': '{id} is a {type}, not a note: --replace rewrites only notes',
  'context.unknown': 'no item {id} in the context (items: {list})',
  'context.urlSecret': 'the link {url} may carry a secret (user info, or a token, key, password, auth or sig in the query): it is written into every task\'s AGENTS.md — add it without the secret if you can',
  'context.inNotes': '{path} is in context/notes/: listed as a file it would be a second copy of a note — move it out of context/ and write it with wsg context note <id> --from <file>',
  'context.inPlaceLink': '{path} is a symlink in context/: listed as it is, the index would point outside the epic — put the file itself there, or add the link\'s target from where it is (it is copied)',
  'context.edited': '{path} changed since wsg wrote it: --discard-edits loses those changes, or copy them out first',
  'context.unreadable': "{path} can't be read to tell whether it was edited since wsg wrote it: fix its permissions first",
  'context.overMax': 'more than {max}',
  'context.fileKept': '{path} was in context/ before it was listed: it is only unlisted, the file stays',
  'context.fanoutInterrupted': 'Stopped. The change of the context of {epic} is kept; tasks not refreshed: {list} — run wsg refresh in each (wsg check in the epic names them)',
  'context.fileGone': '{path} is gone already: only its line in the index is removed',
  'context.rollingBack': 'Changing the context aborted. Rolling back {ws}',
  'context.added': 'Added {type} {id} to the context of {epic}',
  'context.noted': 'Wrote note {id} in the context of {epic}',
  'context.replaced': 'Rewrote note {id} in the context of {epic}',
  'context.removed': 'Removed {type} {id} from the context of {epic}',
  'context.tasksRefreshed': 'Tasks refreshed: {list}',
  'context.tasksDone': 'Done tasks left as they are: {list}',
  'context.tasksArchived': 'Archived tasks left as they are: {list}',
  'context.taskNotRefreshed': 'task {task} was not refreshed: {reason} — run wsg refresh in it later',
  'context.restart': 'Sessions already running keep the index they started with; the files are readable at once.',
  'context.listEmpty': 'No context in {epic} yet: wsg context add <url|path>, wsg context note <id> --text T',
  'context.listBlock': '  the index block every task carries: {bytes} B (a warning above {warn}, refused above {max})',

  'status.reopenNotRendered': 'the epic\'s changes made while the task was done were not rendered into it ({why}): fix that, then run wsg refresh in it',
  'status.archived': '{task} is archived since {date}: its status is not changed while it is archived — wsg unarchive {task} brings it back with the status it had',
  'mcp.jsonInvalid': "{file} can't be read ({msg}): wsg renders the epic's MCP servers into it — fix it first, wsg does not overwrite it",
  'mcp.ownerEntry': '{file} has a server {name} that wsg did not put there: the epic\'s server would replace it — give the epic\'s another name, or rename or remove that one first',
  'mcp.settingsInvalid': '{file}: "{key}" is not a list: wsg renders the epic\'s MCP servers into it — fix it first, wsg does not overwrite it',

  'mcp.noVerb': 'wsg mcp needs one of add, remove, disable, enable, list (see wsg help mcp)',
  'mcp.badVerb': 'unknown command: mcp {verb} — wsg mcp takes add, remove, disable, enable or list (see wsg help mcp)',
  'mcp.need.add': "specify the server: wsg mcp add <name> -- <command> [args...], or wsg mcp add <name> --url URL",
  'mcp.need.remove': "specify the server's name: wsg mcp remove <name> (wsg mcp list shows them)",
  'mcp.need.disable': 'specify the global server to turn off: wsg mcp disable <name> (wsg mcp list shows the user-scope ones)',
  'mcp.need.enable': 'specify the server to turn on again: wsg mcp enable <name>',
  'mcp.codexNotYet': 'Codex MCP is not supported yet: wsg mcp renders servers for Claude Code only in this version (--agent claude)',
  'mcp.badAgent': 'unknown agent {agent}: --agent takes claude',
  'mcp.epicOnly': '{ws} is a {kind} workspace: wsg mcp works on an epic in this version — name it with --ws <epic>',
  'mcp.badName': 'the server name {name} must be letters, digits, - and _, at most {max} characters',
  'mcp.exists': 'the epic has a server {name} already: wsg mcp remove {name} first, or pick another name',
  'mcp.nameDisabled': '{name} is a global server the epic turns off: wsg mcp enable {name} first, or pick another name',
  'mcp.urlAndCommand': 'give either a command after -- or --url, not both',
  'mcp.needCommand': 'how is {name} started? wsg mcp add {name} -- <command> [args...], or wsg mcp add {name} --url URL',
  'mcp.envForStdio': '--env is for a server started by a command; an http server takes its token with --bearer-env VAR',
  'mcp.bearerForHttp': '--bearer-env is for an http server (--url); a command takes its variables with --env',
  'mcp.badUrl': 'only an http or https URL can be an MCP server: {url}',
  'mcp.badCommand': 'the command must be one line of text',
  'mcp.badArg': 'argument {n} must be one line of text',
  'mcp.badEnvName': '{name} is not a variable name (letters, digits and _, not starting with a digit)',
  'mcp.badEnvValue': 'the value of {name} must be one line of text',
  'mcp.envTwice': 'the variable {name} is given twice',
  'mcp.secretLiteral': '{name} looks like a secret: its value would be written into .mcp.json, which every task\'s agent can read — export {name} in your shell and give --env {name}, without a value: {server} gets it from the environment',
  'mcp.argSecret': 'argument {n} of {server} ({what}) may carry a secret: it is written into .mcp.json, which every task\'s agent can read — put it in a variable and write ${VAR} in the argument instead',
  'mcp.urlSecret': 'the URL of {server} may carry a secret in it: it is written into .mcp.json, which every task\'s agent can read — use --bearer-env VAR for a token',
  'mcp.shadowsGlobal': 'your user-scope Claude Code config has a server {name} too: in the epic and its tasks the epic\'s server takes its name',
  'mcp.unknown': 'the epic has no server {name} (servers: {list})',
  'mcp.badDeniedName': 'the name {name} must be one line of at most {max} characters',
  'mcp.disableOwn': '{name} is the epic\'s own server: wsg mcp remove {name} takes it out',
  'mcp.alreadyDisabled': '{name} is turned off already: nothing to change',
  'mcp.notGlobal': 'your user-scope Claude Code config has no server {name}: turned off anyway — a plugin\'s server is named plugin:<plugin>:<server>',
  'mcp.notDisabled': '{name} is not turned off in the epic: nothing to change',
  'mcp.rollingBack': 'Changing the MCP servers aborted. Rolling back {ws}',
  'mcp.fanoutInterrupted': 'Stopped. The change of the MCP servers of {epic} is kept; tasks not refreshed: {list} — run wsg refresh in each (wsg check in the epic names them)',
  'mcp.done.add': 'Added MCP server {name} to {epic}',
  'mcp.done.remove': 'Removed MCP server {name} from {epic}',
  'mcp.done.disable': 'Turned off {name} in {epic} and its tasks',
  'mcp.done.enable': 'Turned {name} on again in {epic} and its tasks',
  'mcp.unchanged': 'The MCP servers of {epic} stay as they were',
  'mcp.restart': 'Restart the agent sessions of the epic and its tasks: Claude Code reads MCP servers at start. In a terminal, the epic\'s servers stay "Pending approval" in a task until its folder is trusted — once per task directory.',
  'mcp.listEmpty': 'No MCP servers in {epic} yet: wsg mcp add <name> -- <command> [args...], or --url URL',
  'mcp.listDisabled': 'turned off (claude): {list}',
  'mcp.listGlobal': 'user scope (claude): {list}',
  'mcp.listPlugins': '  plugin servers and claude.ai connectors are not listed: turn a plugin\'s off by plugin:<plugin>:<server>',
  'mcp.listMissing': 'not set in this shell: {list} — the servers that read them start without them',

  'lock.busy': 'another wsg command is running in this workspace (pid {pid}, since {time}): wait for it to finish.\n  If it is not running, delete {file}',
  'lock.stale': 'stale lock {file} (pid {pid} is gone): taking it over',

  'promote.noWorkspace': 'no workspace {ws}',
  'promote.notWorkspace': '{ws} does not look like a wsg workspace: no .claude/ws-kind',
  'promote.epic': 'an epic is not promoted to a process',
  'promote.epicTask': 'a task of an epic is not promoted to a process yet',
  'promote.alreadyProcess': 'this is already a process',
  'promote.head': 'Task -> process: {ws}',
  'promote.intro': 'Sources, rules, and memory stay. A procedure skill and a run journal will appear.',
  'promote.symlink': '{path} in {ws} is a symlink — promote would write outside the workspace',
  'promote.skillExists': 'skill {skill} already exists — not overwriting',
  'promote.skillCreated': '  skill created: .claude/skills/{skill}/SKILL.md',
  'promote.journalExists': 'journal.md already exists — not overwriting',
  'promote.journalCreated': '  journal.md created with the first run',
  'promote.kindSwitched': '  kind switched to process',
  'promote.noCodeDropped': '  the task was without code (noCode): a process has no such mark — its repositories are attached with --link, and Verification asks for a command again',
  'promote.noCodeRuleRewritten': '  {file}: the read-only rule of the task without code is now the rule of a shared checkout',
  'promote.noCodeRuleEdited': '{file} was edited and still may say the repository is read only: a process changes code there — edit it by hand',
  'promote.specDropped': '  the task went through spec stages (spec): a process has none — spec.md, plan.md and checklist.md stay as plain files, and the Stages section of AGENTS.md is yours to generalize or remove',
  'promote.sectionAdded': '  added a "How it runs" section to AGENTS.md',
  'promote.hasWorktrees': 'the workspace has worktrees: {list}',
  'promote.worktreesHint': '  A process has no permanent branch — the skill creates a branch per run. You can keep\n  the worktree as a working copy, but check that its pinned branch does not get in the way.\n  To replace it with a symlink: git -C <repo> worktree remove <path> && ln -s <repo> <path>',
  'promote.team': '  The workspace has a team: run wsg team {preset} to point /{skill} to team/workflow.md.\n  .claude/skills/wsg-feature/ is kept; delete it if the process does not need it.',
  'promote.next': '  Fill in the steps in .claude/skills/{skill}/SKILL.md and the takeaways in journal.md.\n  From now on a run is invoked like this: /{skill} <what this run is about>',

  'ws.state.noBranch': '(no branch)',
  'ws.state.rebase': 'REBASE IN PROGRESS',
  'ws.state.detached': 'detached HEAD',
  'ws.noAgent': 'agent not configured: add the line WSG_AGENT="claude" (or your own command) to {WSG_CONFIG}',
  'ws.setup.question': 'Which command should start the agent in a workspace? Asked once and saved to {WSG_CONFIG}.',
  'ws.setup.custom': '  or type your own full command, e.g.: gemini --yolo',
  'ws.pick.noOption': 'no option {ans} — agent not started, will ask next time',
  'ws.pick.nothing': 'nothing selected — agent not started, will ask next time',
  'ws.saved': 'saved: WSG_AGENT={q} in {WSG_CONFIG}. To change: ws --agent',
  'ws.list.title': 'Task workspaces',
  'ws.list.process': 'process',
  'ws.list.task': 'task',
  'ws.list.epic': 'epic',
  'ws.list.sessions': 'sessions',
  'ws.list.runs': 'runs',
  'ws.list.shared': '(shared checkout)',
  'ws.list.create': 'create: wsg new <slug> · change the agent: ws --agent',
  'ws.jump.ambiguous': 'ambiguous: {list}',
  'ws.jump.none': "no workspace '{slug}'. List: ws",
  'ws.resume.recent': 'session {id} changed less than a minute ago: it may be open in another window or app',
  'ws.resume.failed': 'claude exited with {rc}; if the session did not open, ws {slug} --new starts a new one',
  'ws.agent.nothingToRun': 'WSG_AGENT in {WSG_CONFIG} has nothing to run',
};
