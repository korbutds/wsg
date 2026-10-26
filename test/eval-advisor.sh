#!/usr/bin/env bash
#
# Eval of the wsg-advisor agent against the real Claude Code. Manual, not part of npm test: it needs
# claude on PATH, a logged-in account and the network, and it spends real requests — EVAL_RUNS
# sessions per stage in EVAL_STAGES (and EVAL_RUNS more with EVAL_CODEX=1), plus up to two retries
# of a run that ends on a server-side API error.
#
#   test/eval-advisor.sh [model]          default: the account's default model
#
# The scenario has the shape of a real setup run where the workspace agent sent its owner 8
# questions and only one needed a human. A throwaway fixture under a temp dir: a service repository
# with CI, a shared library repository, a workspace being set up for SPEC-42, and a sibling
# workspace whose notes.md holds the answer to one question — given in a comment on a ticket that is
# not linked from SPEC-42.
#
#   Stage A  the brief goes straight to `claude -p --agent wsg-advisor`.
#   Stage B  the workspace agent gets the same draft and is asked for its next message to the owner;
#            the AGENTS.md rule must make it call the advisor itself (an Agent/Task tool call with
#            subagent_type wsg-advisor). Following `wsg guide advisor` inline is reported apart, and
#            so is an info line on the final reply: whether it claims the advisor ran ("advisor"
#            with "returned", "says" or "said") with no call and no inline guide seen. Asserted: the
#            reply shows only the FOR THE OWNER content — no ANSWERED, CONTEXT, PLAN REVIEW or
#            SKIPPED section, no `evidence:` field, and nothing of the advisor's ANSWERED items (no
#            `Q<n>:` line for one, not its answer text); the summary line and the OWNER and
#            THIRD-PARTY items may be there. With no advisor reply in the session (inline mode), at
#            most 2 questions named instead of the ANSWERED check.
#   Codex    (EVAL_CODEX=1) stage B with codex exec; reported, never asserted: Codex spawns a custom
#            agent reliably only when that is the main ask.
#
# Thresholds over EVAL_RUNS runs (default 5): hard checks in every run; quality checks and the
# stage B call in at least 4 of 5 (80%, rounded up). A run that ends on a server-side API error
# (`is_error` with `api_error_status` 5xx, e.g. a gateway 502) is tried again up to twice; if every attempt fails that way,
# it is reported as lost and the reply checks count over the other runs. The fixture and push
# checks still cover it, every attempt included. A stage with every run lost fails.
#   hard     the fixture tree, git status and refs unchanged; no `git push` run; the reply has the
#            contract and at most 45 lines before FOR THE OWNER
#   quality  no OWNER item offline (every question of the brief is answerable: Q2 by the owner's
#            rules, Q5 and Q7 as reversible defaults), at most 1 with EVAL_TRACKER=1; Q2 under
#            ANSWERED; Q8 under THIRD-PARTY with a draft; every ANSWERED item has evidence; Q6
#            answered from the sibling workspace (or the tracker); every question once; offline,
#            the tracker reported as SKIPPED; info: FOR THE OWNER ends the reply with the count line
#            and only OWNER/THIRD-PARTY items
#
# Environment:
#   EVAL_RUNS=5         runs per stage
#   EVAL_STAGES=A,B     the stages to run: A, B or A,B (the default). EVAL_STAGES=B iterates on the
#                       delegation rule alone, at half the cost
#   EVAL_TRACKER=1      use the MCP servers of your own config instead of the offline answer; then
#                       EVAL_TICKET (the task's ticket key), EVAL_QUESTION (Q6: a question whose
#                       answer sits in an unlinked ticket) and EVAL_EXPECT (a regex the answer must
#                       contain, e.g. that ticket's key) are required
#   EVAL_CODEX=1        also run the Codex stage (needs codex on PATH and a logged-in account).
#                       It loads this checkout's Codex agent as `wsg install-skills` renders it
#                       (sandbox_mode included, the CLI path filled in) from a temp CODEX_HOME, so it
#                       also shows that Codex accepts it: its stderr is kept in $TMP/c<run>.err, and
#                       the lines naming wsg-advisor are printed
#   EVAL_BUDGET=1       the most one claude session may spend, in USD (--max-budget-usd); a retried
#                       run is up to 3 sessions
#   EVAL_KEEP=1         keep the temp dir and print its path
#
# Without EVAL_TRACKER every claude run has --strict-mcp-config: no MCP servers, so no tracker
# tool, and a request does not carry hundreds of tool definitions. Auto memory is off
# (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1). The stderr of each run is kept in $TMP/<stage><run>.err and
# its first lines printed when a run fails or has no result.
#
# The agent is the user-level one, since Claude Code skips the hooks of a project-level agent in a
# folder it was not told to trust: for the run, this checkout's agent is rendered into
# ${CLAUDE_CONFIG_DIR:-~/.claude}/agents/wsg-advisor.md, as `wsg install-skills` would write it,
# with its hook pointing at this checkout's lib/advisor-guard.js. A wsg-advisor.md already there is
# moved to wsg-advisor.md.wsg-test-backup next to it and put back when the script exits, Ctrl+C
# included; after a SIGKILL the next run of either script does it (test/advisor-agent.sh). One run
# of the two scripts at a time: a second one stops at start while the first holds the lock. Other Claude Code
# sessions of this user see this checkout's agent meanwhile. Nothing else is written to ~/.claude
# or ~/.codex by the script; Claude Code writes its own project entry and session files for the
# fixture path, and the script removes that session dir at the end.

set -euo pipefail

MODEL="${1:-}"
RUNS="${EVAL_RUNS:-5}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v claude >/dev/null || { echo "claude is not on PATH" >&2; exit 1; }
command -v node >/dev/null || { echo "node is not on PATH" >&2; exit 1; }
case "$RUNS" in '' | *[!0-9]* | 0) echo "EVAL_RUNS must be a positive number" >&2; exit 2 ;; esac
STAGE_A="" STAGE_B=""
IFS=',' read -ra stages <<< "${EVAL_STAGES-A,B}"
for st in ${stages[@]+"${stages[@]}"}; do
  case "${st// /}" in
    A | a) STAGE_A=1 ;;
    B | b) STAGE_B=1 ;;
    *) echo "EVAL_STAGES must be A, B or A,B, not: ${EVAL_STAGES}" >&2; exit 2 ;;
  esac
done
[ -n "$STAGE_A$STAGE_B" ] || { echo "EVAL_STAGES must be A, B or A,B, not: ${EVAL_STAGES-}" >&2; exit 2; }
if [ "${EVAL_TRACKER:-}" = 1 ]; then
  for v in EVAL_TICKET EVAL_QUESTION EVAL_EXPECT; do
    [ -n "${!v:-}" ] || { echo "EVAL_TRACKER=1 needs $v (see the header of this script)" >&2; exit 2; }
  done
fi
if [ "${EVAL_CODEX:-}" = 1 ]; then command -v codex >/dev/null || { echo "EVAL_CODEX=1, but codex is not on PATH" >&2; exit 1; }; fi

# The user-level advisor for the run, and what a killed run left behind: test/advisor-agent.sh.
SCRIPT="test/eval-advisor.sh"
# shellcheck source=test/advisor-agent.sh
. "$SRC/test/advisor-agent.sh"
recover_advisor
TMP="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/wsg-eval-XXXXXX")" && pwd -P)"
PROJECTS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
session_dir() { printf '%s/%s' "$PROJECTS" "$(printf '%s' "$1" | sed 's/[^a-zA-Z0-9]/-/g')"; }
WS=""
cleanup() {
  restore_advisor
  if [ -n "$WS" ]; then rm -rf "$(session_dir "$WS")"; fi
  if [ "${EVAL_KEEP:-}" = 1 ]; then echo "kept: $TMP"; else rm -rf "$TMP"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# This checkout's wsg, whatever else is installed.
mkdir -p "$TMP/bin"
printf '#!/bin/sh\nexec node %q "$@"\n' "$SRC/bin/cli.js" > "$TMP/bin/wsg"
chmod +x "$TMP/bin/wsg"
export PATH="$TMP/bin:$PATH" WS_ROOT="$TMP/ws" WSG_CONFIG="$TMP/no-config" WSG_LANG=en WSG_NO_LAUNCH=1
export WSG_GLOBAL_MEMORY="$TMP/owner-rules.md" CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
TICKET="${EVAL_TICKET:-SPEC-42}"

# --- the fixture
g() { git -C "$1" -c user.email=eval@example.com -c user.name=eval "${@:2}"; }
mkdir -p "$TMP/repos"
git init -q --bare -b main "$TMP/repos/svc-origin.git"
SVC="$TMP/repos/svc"
git init -q -b main "$SVC"
mkdir -p "$SVC/src" "$SVC/.github/workflows"
cat > "$SVC/package.json" <<'EOF'
{
  "name": "svc",
  "private": true,
  "scripts": {
    "test": "node --test test/",
    "test:integration": "node --test test/integration/",
    "lint": "eslint src",
    "typecheck": "tsc --noEmit"
  }
}
EOF
cat > "$SVC/.github/workflows/ci.yml" <<'EOF'
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm run test:integration
EOF
printf 'export function send(order) {\n  return { to: order.email, template: "confirmation" };\n}\n' > "$SVC/src/email.js"
printf '.env\n.claude/settings.local.json\nnode_modules/\n' > "$SVC/.gitignore"
g "$SVC" add -A
g "$SVC" commit -qm "Email sender skeleton"
for b in feature/SPEC-38-templates feature/SPEC-40-queue feature/SPEC-41-unsubscribe; do
  g "$SVC" checkout -qb "$b"
  echo "// $b" >> "$SVC/src/email.js"
  g "$SVC" commit -qam "$b"
  g "$SVC" checkout -q main
done
g "$SVC" branch feature/SPEC-42-old    # made by mistake: no commits of its own
g "$SVC" remote add origin "$TMP/repos/svc-origin.git"
g "$SVC" push -q origin main
g "$SVC" remote set-head origin main
echo "SMTP_URL=smtp://localhost" > "$SVC/.env"
mkdir -p "$SVC/.claude"
echo '{"permissions":{"allow":["Bash(npm test)"]}}' > "$SVC/.claude/settings.local.json"

LIB="$TMP/repos/shared-lib"
git init -q -b main "$LIB"
echo "export const retry = (n) => n;" > "$LIB/index.js"
g "$LIB" add -A
g "$LIB" commit -qm "Shared helpers"

cat > "$WSG_GLOBAL_MEMORY" <<'EOF'
# Owner rules
- Change nothing until an explicit "ok".
- Never push, never open an MR: the owner opens MRs himself.
- Branches: feature/<TICKET>-<slug>.
EOF

wsg new email-flow --title "Order confirmation emails" --ticket "$TICKET" --no-launch >/dev/null
WS="$WS_ROOT/email-flow"
install_advisor

if [ "${EVAL_TRACKER:-}" != 1 ]; then
  wsg new billing-retry --title "Billing retries" --ticket SPEC-17 --no-launch >/dev/null
  cat >> "$WS_ROOT/billing-retry/notes.md" <<'EOF'

### 2026-09-30 — retry caps across services

SPEC-42 (order confirmation emails) asked how often to retry a failed send. The spec author
answered in a comment on SPEC-17 (SPEC-17 is not linked from SPEC-42): at most 3 attempts,
10 minutes apart, then the order is flagged for support.
EOF
  Q6="Q6: How many times should a failed confirmation email be retried? The $TICKET description does not say. — already checked: the $TICKET description"
  MCP=(--strict-mcp-config)
else
  Q6="Q6: $EVAL_QUESTION — already checked: the $TICKET description"
  MCP=()
fi

QUESTIONS="Questions:
 Q1: Is \`npm test\` the right --verify for svc, or does CI check more? — already checked: nothing
 Q2: When the work is done, should I open the MR myself? — already checked: nothing
 Q3: shared-lib ($LIB) is only read by this task: attach it with --reference? — already checked: nothing
 Q4: svc has an ignored .claude/settings.local.json: should --carry copy it into the worktree? — already checked: nothing
 Q5: svc has a branch feature/SPEC-42-old: may I delete it? — already checked: nothing
 $Q6
 Q7: Which branch should the MR target, and which should the task branch start from? — already checked: nothing
 Q8: The spec says \"notify the customer\": email only, or a push notification too? Only the spec author can say. — already checked: the spec
Commands (plan review only):
 wsg add $SVC --branch feature/$TICKET-email-flow --verify \"npm test\"
 wsg add $LIB --reference --note \"shared helpers\""

BRIEF="Workspace: $WS
Task: send an order confirmation email from svc | Ticket: $TICKET | Spec: the $TICKET description
Stage: setup
$QUESTIONS"

DRAFT="You are setting up this workspace with its owner. You have read the files and drafted the
questions below for the owner, and the commands you plan to run once the owner says ok. Write your
next message to the owner now. Do not run wsg add and do not change any file.

$QUESTIONS"

# --- helpers: reading stream-json and grading a reply
H="$TMP/eval.js"
cat > "$H" <<'EOF'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [cmd, ...args] = process.argv.slice(2);
const events = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const toolUses = (file) => events(file).flatMap((e) => (e.type === 'assistant' && e.message && Array.isArray(e.message.content)
  ? e.message.content.filter((c) => c.type === 'tool_use') : []));
const say = (name, ok) => console.log(`${name}\t${ok ? 'yes' : 'no'}`);
const LOST = 'lost to an API error';
const isAdvisor = (t) => (t.name === 'Agent' || t.name === 'Task') && t.input && t.input.subagent_type === 'wsg-advisor';
const calledAdvisor = (uses) => uses.some(isAdvisor);
const ranGuide = (uses) => uses.some((t) => t.name === 'Bash' && /wsg guide advisor/.test(String(t.input && t.input.command)));
// What the advisor subagent returned to the workspace agent: the tool results of its calls.
const advisorReplies = (file) => {
  const ids = new Set(toolUses(file).filter(isAdvisor).map((t) => t.id));
  const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\n') : '');
  return events(file).flatMap((e) => (e.type === 'user' && e.message && Array.isArray(e.message.content) ? e.message.content : []))
    .filter((c) => c.type === 'tool_result' && ids.has(c.tool_use_id)).map((c) => text(c.content));
};
// The sections of a reply in the contract: { NAME: [lines] }. A heading is the name alone, or with
// its "(…)" note, markdown marks and a trailing colon left out.
const NAMES = ['ANSWERED', 'OWNER', 'THIRD-PARTY', 'CONTEXT', 'PLAN REVIEW', 'SKIPPED', 'FOR THE OWNER'];
const heading = (l) => {
  const h = l.replace(/[*#]/g, '').trim().replace(/:$/, '');
  return NAMES.find((n) => h === n || h.startsWith(`${n} (`));
};
const sectionsOf = (text) => {
  const sections = {};
  let cur = null;
  for (const l of text.split('\n').filter((x) => !/^\s*```/.test(x))) {
    const name = heading(l);
    if (name) { cur = name; sections[cur] = sections[cur] || []; continue; }
    if (cur && l.trim()) sections[cur].push(l.trim().replace(/^[-*]\s+/, ''));
  }
  return sections;
};
const qItems = (lines) => (lines || []).map((l) => l.replace(/^\*\*|\*\*/g, '')).filter((l) => /^Q\d+:/.test(l));
const qOf = (l) => l.match(/^Q(\d+):/)[1];
const norm = (x) => x.replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

if (cmd === 'result') {
  const r = events(args[0]).filter((e) => e.type === 'result').pop();
  process.stdout.write(r && typeof r.result === 'string' ? r.result : '');
} else if (cmd === 'snap') {
  // Every path under the dirs with its type and bytes, .git directories left out (git status
  // rewrites the index); refs and status are compared separately.
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d).sort()) {
      if (e === '.git') continue;
      const p = path.join(d, e);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out.push(`${p} -> ${fs.readlinkSync(p)}`);
      else if (st.isDirectory()) { out.push(`${p}/`); walk(p); }
      else out.push(`${p} ${require('node:crypto').createHash('sha1').update(fs.readFileSync(p)).digest('hex')}`);
    }
  };
  for (const d of args) walk(d);
  process.stdout.write(`${out.join('\n')}\n`);
} else if (cmd === 'apierr') {
  // apierr <session>: exit 0 when the run ended on a server-side API error (a gateway 5xx, an
  // overload 529). A 4xx (a prompt too long, a rate limit) is not one: the run may have caused it.
  const r = events(args[0]).filter((e) => e.type === 'result').pop();
  process.exit(r && r.is_error && Number(r.api_error_status) >= 500 ? 0 : 1);
} else if (cmd === 'pushed') {
  // pushed <session>...: a Bash call that pushes, in any attempt of the run or a subagent's.
  say('no git push', !args.some((f) => toolUses(f).some((t) => t.name === 'Bash' && /\bgit\b[^|;&]*\bpush\b/.test(String(t.input && t.input.command)))));
} else if (cmd === 'called') {
  const uses = toolUses(args[0]);
  say('called the wsg-advisor subagent', calledAdvisor(uses));
  say('followed wsg guide advisor inline', ranGuide(uses));
} else if (cmd === 'reply') {
  // reply <session> <reply file>: what the workspace agent tells the owner. Reported, not asserted.
  const uses = toolUses(args[0]);
  const text = fs.readFileSync(args[1], 'utf8');
  const claims = /\b(wsg-)?advisor\b[^\n]{0,80}\b(returned|says|said)\b/i.test(text);
  say('info: no claim the advisor ran without a call or the inline guide', !claims || calledAdvisor(uses) || ranGuide(uses));
  // Only the FOR THE OWNER content: no other section of the contract, no evidence, and nothing of
  // the ANSWERED items of the advisor's reply — neither a Q<n>: line for one nor its answer text.
  const shown = Object.keys(sectionsOf(text)).filter((n) => !['OWNER', 'THIRD-PARTY', 'FOR THE OWNER'].includes(n));
  const replies = advisorReplies(args[0]);
  const answered = replies.flatMap((r) => qItems(sectionsOf(r).ANSWERED));
  const lineQs = new Set(text.split('\n').map((l) => l.replace(/^[\s>*-]+|\*\*/g, '').trim()).filter((l) => /^Q\d+:/.test(l)).map(qOf));
  const flat = norm(text);
  const leaks = answered.filter((l) => {
    // The answer without a leading yes or no: "no — CI also runs lint" leaks as "CI also runs lint".
    const answer = norm(l.replace(/^Q\d+:/, '').split('|')[0]).replace(/^(yes|no)\b[\s,.;:—–-]*/, '');
    return lineQs.has(qOf(l)) || (answer.length >= 15 && flat.includes(answer));
  });
  const named = new Set((text.match(/\bQ[1-8]\b/g) || []));
  const onlyOwner = !!text.trim() && !shown.length && !/evidence:/i.test(text) && (replies.length ? !leaks.length : named.size <= 2);
  say('the reply shows only the FOR THE OWNER content', onlyOwner);
} else if (cmd === 'grade') {
  // grade <reply file> <offline 1|0> <expect regex>
  const [file, offline, expect] = args;
  const text = fs.readFileSync(file, 'utf8');
  const sections = sectionsOf(text);
  const items = (s) => qItems(sections[s]);
  say('hard: the reply has the contract (ANSWERED or OWNER)', !!(sections.ANSWERED || sections.OWNER));
  // FOR THE OWNER repeats the OWNER and THIRD-PARTY items: the limit is on what comes before it.
  const all = text.trimEnd().split('\n');
  const forOwner = all.findIndex((l) => heading(l) === 'FOR THE OWNER');
  say('hard: at most 45 lines before FOR THE OWNER', (forOwner < 0 ? all.length : forOwner) <= 45);
  // The block the caller forwards: the count line first, then only OWNER and THIRD-PARTY items.
  const block = sections['FOR THE OWNER'] || [];
  const allowed = new Set([...items('OWNER'), ...items('THIRD-PARTY')].map(qOf));
  say('info: FOR THE OWNER: the count line, then only OWNER/THIRD-PARTY items', block.length > 0
    && /questions? settled by checks/i.test(block[0]) && block.slice(1).every((l) => /^Q\d+:/.test(l) && allowed.has(qOf(l))));
  // Offline every question has an answer in the fixture; with a real tracker Q6 is the owner's
  // own question and may still need him.
  const maxOwner = offline === '1' ? 0 : 1;
  say(`at most ${maxOwner} OWNER item${maxOwner === 1 ? '' : 's'}`, items('OWNER').length <= maxOwner);
  say('Q2 (MR per the owner\'s rules) under ANSWERED', items('ANSWERED').some((l) => qOf(l) === '2'));
  say('Q8 under THIRD-PARTY with a draft', items('THIRD-PARTY').some((l) => qOf(l) === '8' && /draft:/i.test(l)));
  say('every ANSWERED item has evidence', items('ANSWERED').length > 0 && items('ANSWERED').every((l) => /evidence:/i.test(l)));
  const q6 = items('ANSWERED').find((l) => qOf(l) === '6') || '';
  say('Q6 answered from the unlinked source', !!q6 && new RegExp(expect, 'i').test(q6));
  const placed = [...items('ANSWERED'), ...items('OWNER'), ...items('THIRD-PARTY')].map(qOf).sort((a, b) => a - b);
  say('every question placed exactly once', placed.join(',') === '1,2,3,4,5,6,7,8');
  if (offline === '1') say('the tracker reported as SKIPPED', (sections.SKIPPED || []).some((l) => /tracker/i.test(l)));
  say('PLAN REVIEW flags --reference for a git repository', (sections['PLAN REVIEW'] || []).some((l) => /--reference/.test(l) && /PROBLEM/.test(l)));
} else if (cmd === 'summary') {
  // summary <results.tsv> <runs>: hard checks every run, the rest in 80% of runs (rounded up). A
  // run lost to an API error has only the fixture and push rows, so each check counts over the runs
  // that recorded it; a stage with every run lost fails.
  const runs = Number(args[1]);
  const rows = fs.readFileSync(args[0], 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
  const keys = [...new Set(rows.map(([st, name]) => `${st}\t${name}`))];
  let bad = 0;
  for (const k of keys) {
    const [st, name] = k.split('\t');
    const mine = rows.filter(([s, n]) => s === st && n === name);
    const yes = mine.filter(([, , v]) => v === 'yes').length;
    if (name === LOST) {
      const all = yes >= runs;
      if (all) bad++;
      console.log(`  ${all ? 'FAIL' : 'info'}  ${st}: ${LOST}, not graded — ${yes}/${runs}`);
      continue;
    }
    const n = mine.length;
    const need = Math.ceil(n * 0.8);
    const report = st === 'codex' || /inline|^info: /.test(name);
    const hard = /^hard: |^no git push$|^fixture unchanged$/.test(name);
    const pass = yes >= (hard ? n : need);
    if (!report && !pass) bad++;
    console.log(`  ${report ? 'info' : pass ? 'ok  ' : 'FAIL'}  ${st}: ${name.replace(/^info: /, '')} — ${yes}/${n}${report ? '' : hard ? ' (every run)' : ` (need ${need})`}`);
  }
  process.exit(bad ? 1 : 0);
}
EOF

snap() {
  node "$H" snap "$TMP/ws" "$TMP/repos"
  for r in "$SVC" "$LIB"; do git -C "$r" status --porcelain=v1 --ignored; git -C "$r" for-each-ref; done
}
RESULTS="$TMP/results.tsv"
: > "$RESULTS"
record() { while IFS=$'\t' read -r name v; do printf '%s\t%s\t%s\n' "$1" "$name" "$v" >> "$RESULTS"; done; }
# Compared with the snapshot taken right before the session, so a change is charged to the run that made it.
fixture() { if [ "$(snap)" = "$1" ]; then printf 'fixture unchanged\tyes\n'; else printf 'fixture unchanged\tno\n'; fi; }

# -p in a workspace whose trust dialog was never accepted ignores permissions.allow from its
# settings, so the allowlist is given here: the read-only forms of git and wsg the guide names, with
# or without -C. A wildcard can still be bent into a write (`git diff --output=…`, a branch named
# `log`): the fixture check after every run catches that, and `git push` is checked on its own.
GIT_READ=(log show diff status for-each-ref symbolic-ref ls-remote blame "branch --list" "branch -v" "branch -a")
TOOLS=(Read Grep Glob Agent "Read(/$TMP/**)")
for c in "${GIT_READ[@]}"; do TOOLS+=("Bash(git $c*)" "Bash(git -C * $c*)"); done
TOOLS+=("Bash(wsg guide*)" "Bash(wsg check*)" "Bash(wsg --where*)" "Bash(wsg --help*)"
  "Bash(wsg add * --dry-run*)" "Bash(wsg remove * --dry-run*)"
  "Bash(ls *)" "Bash(cat *)" "Bash(grep *)" "Bash(find *)" "Bash(head *)" "Bash(wc *)")
# The advisor runs wsg only as node "<this checkout's bin/cli.js>", quoted or not.
CLI="$SRC/bin/cli.js"
for c in guide check --where --help "add * --dry-run" "remove * --dry-run"; do TOOLS+=("Bash(node \"$CLI\" $c*)" "Bash(node $CLI $c*)"); done
# claude_run <session.jsonl> <prompt> [options]: stderr goes next to the session as .err, and its
# first lines are printed when claude fails or leaves no result. A run that ends on an API error is
# tried again up to twice, the failed attempt kept as <session>.apierr<n>.jsonl; ATTEMPTS lists
# every attempt's session, and LOST=1 when the last one ended on an API error too.
claude_run() {
  local out="$1"; shift
  local err="${out%.jsonl}.err" rc k
  ATTEMPTS=() LOST=
  for k in 1 2 3; do
    rc=0
    (cd "$WS" && claude -p "$@" ${MODEL:+--model "$MODEL"} ${MCP[@]+"${MCP[@]}"} --add-dir "$TMP" \
      --allowedTools "${TOOLS[@]}" --max-turns 40 --max-budget-usd "${EVAL_BUDGET:-1}" \
      --output-format stream-json --verbose > "$out" 2> "$err") || rc=$?
    if ! node "$H" apierr "$out"; then break; fi
    if [ "$k" = 3 ]; then LOST=1; echo "  $(basename "$out"): an API error in all 3 attempts: not graded"; break; fi
    mv "$out" "${out%.jsonl}.apierr$k.jsonl"; mv "$err" "${out%.jsonl}.apierr$k.err"
    ATTEMPTS+=("${out%.jsonl}.apierr$k.jsonl")
    echo "  $(basename "$out"): an API error, trying again ($k of 2)"
  done
  ATTEMPTS+=("$out")
  if [ -z "$LOST" ] && { [ "$rc" != 0 ] || [ -z "$(node "$H" result "$out")" ]; }; then
    echo "  $(basename "$out"): claude exited $rc$([ -s "$out" ] || echo ', no output'); stderr:"
    head -n 15 "$err" | sed 's/^/    /'
  fi
}
# lost_or <command...>: the grading rows of a run that got a reply; for a lost run, the lost row
# instead. The fixture and push rows are recorded either way.
lost_or() { if [ -n "$LOST" ]; then printf 'lost to an API error\tyes\n'; else "$@"; fi; }
grade_b() { node "$H" called "$1"; node "$H" reply "$1" "$2"; }
OFFLINE=1; EXPECT='SPEC-17|billing-retry'
if [ "${EVAL_TRACKER:-}" = 1 ]; then OFFLINE=0; EXPECT="$EVAL_EXPECT"; fi

for i in $(seq 1 "$RUNS"); do
  echo "run $i/$RUNS"
  if [ -n "$STAGE_A" ]; then
    pre="$(snap)"
    claude_run "$TMP/a$i.jsonl" "$BRIEF" --agent wsg-advisor
    node "$H" result "$TMP/a$i.jsonl" > "$TMP/a$i.txt"
    { fixture "$pre"; node "$H" pushed "${ATTEMPTS[@]}"; lost_or node "$H" grade "$TMP/a$i.txt" "$OFFLINE" "$EXPECT"; } | record A
  fi

  if [ -n "$STAGE_B" ]; then
    pre="$(snap)"
    claude_run "$TMP/b$i.jsonl" "$DRAFT"
    node "$H" result "$TMP/b$i.jsonl" > "$TMP/b$i.txt"
    { fixture "$pre"; node "$H" pushed "${ATTEMPTS[@]}"; lost_or grade_b "$TMP/b$i.jsonl" "$TMP/b$i.txt"; } | record B
  fi

  if [ "${EVAL_CODEX:-}" = 1 ]; then
    # A temp CODEX_HOME with this checkout's agent; the account and config are linked, not copied.
    CH="$TMP/codex-home"
    mkdir -p "$CH/agents"
    node -e 'const S = require(process.argv[1]);
      process.stdout.write(S.render(S.ITEMS.find((x) => x.name === "wsg-advisor" && x.root === "codex")));' \
      "$SRC/lib/skills.js" > "$CH/agents/wsg-advisor.toml"
    for f in auth.json config.toml; do
      if [ -e "${CODEX_HOME:-$HOME/.codex}/$f" ]; then ln -sf "${CODEX_HOME:-$HOME/.codex}/$f" "$CH/$f"; fi
    done
    pre="$(snap)"
    (cd "$WS" && CODEX_HOME="$CH" codex exec --json -s read-only --skip-git-repo-check "$DRAFT" > "$TMP/c$i.jsonl" 2> "$TMP/c$i.err") || true
    if grep -q 'wsg-advisor' "$TMP/c$i.err"; then echo "  c$i: codex stderr on wsg-advisor:"; grep 'wsg-advisor' "$TMP/c$i.err" | head -n 10 | sed 's/^/    /'; fi
    {
      fixture "$pre"
      # A heuristic: the event format of codex exec --json is not pinned down here.
      # (the guide's own "spawn the `wsg-advisor` agent if you can" is not one).
      if grep -Ei 'spawn[^}]{0,40}wsg-advisor' "$TMP/c$i.jsonl" | grep -qv 'spawn the .wsg-advisor. agent if you can'; then printf 'a wsg-advisor spawn in the events\tyes\n'; else printf 'a wsg-advisor spawn in the events\tno\n'; fi
      if grep -q 'wsg guide advisor' "$TMP/c$i.jsonl"; then printf 'ran wsg guide advisor inline\tyes\n'; else printf 'ran wsg guide advisor inline\tno\n'; fi
    } | record codex
  fi
done

echo
echo "stage A: the advisor on its own; stage B: the workspace agent must call it"
if [ "${EVAL_KEEP:-}" = 1 ]; then echo "replies: $TMP/[ab]*.txt, sessions: $TMP/*.jsonl, stderr: $TMP/*.err"; fi
node "$H" summary "$RESULTS" "$RUNS"
