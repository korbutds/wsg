'use strict';

// English UI strings — the source of truth: every other catalog has exactly these keys.
// {name} is a t() parameter. In ws.* strings {NAME} is a zsh variable instead (see renderShell).

module.exports = {
  'cli.usage': `
wsg — Workspace Generation: per-task workspaces for agents (Claude Code, Codex).

One directory per task: its own session history, its own agent memory, rules
loaded on demand, and repositories inside as git worktrees.

  wsg new <slug> [--title T] [--kind task|process] [--skill NAME] [--ticket X] [--no-launch]
      create a workspace and start the agent in it with /wsg-setup
  wsg add <path> [--worktree|--link|--reference] [--branch B] [--base REF] [--reset-to-base]
      [--target T] [--verify CMD] [--carry all|none|a,b] [--[no-]clone-node-modules]
      [--note TEXT] [--dry-run] [--ws SLUG|PATH]
      attach a source to the workspace (the one you are in by default)
  wsg remove <name> [--delete-ignored] [--dry-run] [--ws SLUG|PATH]
      detach a source: the worktree (only a clean one; its branch is kept) or the symlink
  wsg refresh [--dry-run] [--ws SLUG|PATH]
      bring the generated parts of a workspace up to date with this wsg
  wsg team <preset> [--without ROLE,...] [--dry-run] [--ws SLUG|PATH]
      add a team: role cards and a workflow, a subagent per role for Claude Code
      (preset: fullstack — pm, designer, frontend, backend, devops, reviewer)
  wsg check [path|slug]       check a workspace against the conventions
  wsg promote [slug|path] --skill NAME
                              turn a task into a process
  wsg guide [setup|advisor]   print a guide the agent follows: the setup, or the advisor's
  wsg install-skills [--uninstall]
                              install (or remove) the wsg-new skill and the wsg-advisor agent
                              for Claude Code and Codex
  wsg shell-init zsh          print the ws navigation function for eval
  wsg --where                 install directory (config.example lives there)
  wsg --version | --help

Workspace kind: "task" — one ticket and one branch, until merge;
"process" — a repeatable engineering procedure in a skill (a release, a dependency upgrade).

Exit codes: 0 ok; 1 the check found errors, or a step failed and was rolled back;
2 invalid input (nothing was changed); 130 cancelled with Ctrl+C (rolled back).

Settings: ~/.config/wsg/config (sample: config.example next to the install).
Language: WSG_LANG=en|ru in the config; without it, the locale.
Agent: WSG_AGENT in the config, used by wsg new and ws; ws --agent to choose it.
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
  'cli.badKind': '--kind is task or process, not {kind}',
  'cli.skillRequired': 'a process needs a skill name: --skill <name>',
  'cli.skillForProcess': '--skill is only for --kind process',
  'cli.created': 'Created {ws}: a skeleton, no repositories yet',
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
  'cli.removeName': 'specify the source: wsg remove <name>',
  'cli.removed': 'Removed {name}',
  'cli.refreshed': 'Updated: {list}',
  'cli.refreshNone': 'The generated parts are up to date',
  'cli.refreshRestart': '  settings.json changed: restart the agent session in this workspace',
  'cli.branchKept': '  branch {branch} is kept in {path}',
  'cli.teamWritten': {
    one: 'Team {preset}: {n} file written',
    other: 'Team {preset}: {n} files written',
  },
  'cli.teamNone': 'The team is in place: nothing to write',
  'cli.teamKept': '  kept {file}: it exists, not overwritten',
  'cli.teamRestart': '  .claude/agents/ or .claude/skills/ is new: restart the agent session in this workspace to see the roles',
  'cli.teamNext': '  Next: run /wsg-feature <what to build> in Claude Code',
  'cli.teamNextProcess': '  Next: run /{skill} — it points to team/workflow.md',
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
  'workspace.outside': 'slug {slug} leads outside {root}',
  'workspace.stateInvalid': 'cannot read {file}: {msg}',

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

  'remove.unknown': 'no source {name} in this workspace (sources: {list})',
  'remove.dirty': 'worktree {name} has changes that exist nowhere else — commit, stash or remove them first:\n{list}',
  'remove.ignored': 'worktree {name} has ignored files that exist nowhere else (made there, or copied in by wsg and changed since), and git would delete them with it:\n{list}\n  Move out what you need, then run the command again with --delete-ignored',
  'remove.ignoredAppeared': 'worktree {name}: ignored files appeared after the check, and git would delete them with it:\n{list}\n  Nothing was changed; run the command again',
  'remove.listFailed': 'worktree {name}: git could not list its ignored files ({why}), and git would delete them with it unseen. Nothing was changed',
  'remove.statusFailed': 'worktree {name}: git could not list its changes ({why}), and they would be lost unseen. Nothing was changed',
  'remove.listTooLarge': 'worktree {name}: git lists more than 256 MiB of files there — too many to check, and git would delete them with it unseen. Nothing was changed.\n  Delete the build output in it by hand (move out what you need first), then run the command again',
  'remove.nmNotChecked': 'node_modules wsg cloned into {name} is not checked: changes made inside it are deleted with the worktree',
  'remove.more': '… and {n} more',
  'remove.worktreeFailed': 'git did not remove worktree {name}: {out}',
  'remove.notLink': '{name} is not the symlink wsg made — not removing it',
  'remove.ruleKept': '{file} was not written by wsg: kept',
  'remove.worktree': '  worktree {name} removed',
  'remove.symlink': '  symlink {name} removed',

  'gen.cowApfsOnly': 'copy-on-write is only available on APFS',
  'gen.clonefileUnavailable': 'clonefile is unavailable',
  'gen.sourceMissing': '{path} does not exist',
  'gen.sourceNotDir': '{path} is not a directory: a source is a repository or a directory',
  'gen.sourceReserved': "a source can't be named {name}: the workspace creates its own {name}",
  'gen.branchConflict': 'name {branch} conflicts with branch {conflict}: git branches are paths',
  'gen.twoSources': 'two sources are named {name}',
  'gen.rollingBack': 'Creation aborted. Rolling back {ws}',
  'gen.addRollingBack': 'Attaching {name} aborted. Rolling back {ws} to what it was',
  'gen.undoFailed': 'Rollback step failed: {msg}',
  'gen.worktreeRemoveFailed': 'Failed to remove worktree {name}: {out}',
  'gen.branchLeftAtBase': 'Branch {name} left at the base, previous head is in {backup}: {out}',
  'gen.branchRestored': 'Branch {name} restored to its previous head',
  'gen.branchRestoredNoUpstream': 'Branch {name} restored to its previous head, but its upstream is still the base — check git branch -vv',
  'gen.branchKept': 'Branch {name} kept: it has commits on top of {base}',
  'gen.branchDeleted': 'Deleted created branch {name}',
  'gen.branchDeleteFailed': 'Branch {name} remains, failed to delete: {out}',
  'gen.rollbackDone': 'Rollback complete.',
  'gen.creating': 'Creating {ws}',
  'gen.branchAppeared': 'branch {branch} appeared after the check: run wsg add again',
  'gen.branchGone': 'branch {branch} disappeared after the check: run wsg add again',
  'gen.removeRollingBack': 'Removing {name} aborted. Rolling back {ws} to what it was',
  'gen.worktreeReadded': 'Worktree {name} is back on {branch}; files copied in at creation (.env, node_modules) are not',
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
  'gen.markerRestored': '{file}: the <!-- wsg:{name} --> markers were missing — the block is added back',
  'gen.blockAdded': '{file}: added the <!-- wsg:{name} --> block (new in wsg {version})',
  'gen.fileMissing': '{file} is missing — its generated part is not updated',
  'gen.settingsInvalid': '{file} is not valid JSON ({msg}): fix it first, wsg does not overwrite it',

  'team.noPreset': 'specify the preset: wsg team <preset> (available: {presets})',
  'team.badPreset': 'no preset {preset}: available — {presets}',
  'team.badRole': '--without: no role {role}; the roles are {roles}',
  'team.noRoles': '--without leaves no role of {preset}',
  'team.stateInvalid': '{file}: "team" is not { preset, roles } with kebab-case role names — fix it by hand first',
  'team.notADir': '{path} in {ws} is not a directory: wsg team writes its files into it',
  'team.skillMissing': '{file} is missing — the pointer to team/workflow.md is not added',
  'team.rollingBack': 'Adding the team aborted. Rolling back {ws} to what it was',

  'lock.busy': 'another wsg command is running in this workspace (pid {pid}, since {time}): wait for it to finish.\n  If it is not running, delete {file}',
  'lock.stale': 'stale lock {file} (pid {pid} is gone): taking it over',

  'promote.noWorkspace': 'no workspace {ws}',
  'promote.notWorkspace': '{ws} does not look like a wsg workspace: no .claude/ws-kind',
  'promote.alreadyProcess': 'this is already a process',
  'promote.head': 'Task -> process: {ws}',
  'promote.intro': 'Sources, rules, and memory stay. A procedure skill and a run journal will appear.',
  'promote.symlink': '{path} in {ws} is a symlink — promote would write outside the workspace',
  'promote.skillExists': 'skill {skill} already exists — not overwriting',
  'promote.skillCreated': '  skill created: .claude/skills/{skill}/SKILL.md',
  'promote.journalExists': 'journal.md already exists — not overwriting',
  'promote.journalCreated': '  journal.md created with the first run',
  'promote.kindSwitched': '  kind switched to process',
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
  'ws.list.sessions': 'sessions',
  'ws.list.runs': 'runs',
  'ws.list.shared': '(shared checkout)',
  'ws.list.create': 'create: wsg new <slug> · change the agent: ws --agent',
  'ws.jump.ambiguous': 'ambiguous: {list}',
  'ws.jump.none': "no workspace '{slug}'. List: ws",
  'ws.agent.nothingToRun': 'WSG_AGENT in {WSG_CONFIG} has nothing to run',
};
