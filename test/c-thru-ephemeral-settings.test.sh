#!/usr/bin/env bash
# Regression tests for write_ephemeral_settings in tools/c-thru.
# Run: bash test/c-thru-ephemeral-settings.test.sh

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CTHRU="$SCRIPT_DIR/../tools/c-thru"
[[ -f "$CTHRU" ]] || { echo "fatal: cannot find $CTHRU" >&2; exit 1; }

# The builder only needs these fixture globals and its nested find_tool_path.
# Extracting it avoids starting a proxy or reading the invoking user's profile.
eval "$(awk '/^write_ephemeral_settings\(\) \{/,/^\}$/' "$CTHRU")"
eval "$(awk '/^build_ephemeral_agents\(\) \{/,/^\}$/' "$CTHRU")"
eval "$(awk '/^cthru_flag_width\(\) \{/,/^\}$/' "$CTHRU")"
eval "$(awk '/^build_forwarded_args\(\) \{/,/^\}$/' "$CTHRU")"
eval "$(awk '/^setup_ephemeral_session\(\) \{/,/^\}$/' "$CTHRU")"

PASS=0
FAIL=0
FIXTURE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/c-thru-ephemeral-settings.XXXXXX")
PROFILE_DIR="$FIXTURE_DIR/profile"
SESSION_DIR="$FIXTURE_DIR/session"
TOOLS_DIR="$SCRIPT_DIR/../tools"
mkdir -p "$PROFILE_DIR" "$SESSION_DIR"
trap 'rm -rf "$FIXTURE_DIR"' EXIT
RUN_PAYLOADS=()

assert() {
  local label="$1"
  shift
  if "$@"; then
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label" >&2
    FAIL=$((FAIL + 1))
  fi
}

run_builder() {
  EPHEMERAL_SESSION_DIR="$SESSION_DIR"
  ORIGINAL_CLAUDE_PROFILE_DIR="$PROFILE_DIR"
  CTHRU_SELF_DIR="$TOOLS_DIR"
  EPHEMERAL_SETTINGS_JSON=""
  CALLER_SETTINGS_PAYLOADS=()
  if [[ ${#RUN_PAYLOADS[@]} -gt 0 ]]; then
    CALLER_SETTINGS_PAYLOADS=("${RUN_PAYLOADS[@]}")
  fi
  write_ephemeral_settings
  BUILT_JSON="$EPHEMERAL_SETTINGS_JSON"
}

run_agents_builder() {
  EPHEMERAL_SESSION_DIR="$SESSION_DIR"
  ORIGINAL_CLAUDE_PROFILE_DIR="$PROFILE_DIR"
  CTHRU_REPO_ROOT="$FIXTURE_DIR/agent-fleet"
  EPHEMERAL_AGENTS_JSON=""
  CALLER_AGENTS_PARSEABLE=()
  CALLER_AGENTS_PAYLOADS=()
  if [[ ${#RUN_PAYLOADS[@]} -gt 0 ]]; then
    CALLER_AGENTS_PAYLOADS=("${RUN_PAYLOADS[@]}")
  fi
  build_ephemeral_agents
  BUILT_AGENTS_JSON="$EPHEMERAL_AGENTS_JSON"
}

run_forwarder() {
  local desired_model="${1:-}"
  FORWARDED_ARGS=()
  CLAUDE_PROXY_BYPASS=1
  C_THRU_SKIP_INFO_INJECTION=1
  EPHEMERAL_AGENTS_JSON=""
  # The production launcher does not enable nounset; keep the extracted
  # forwarding helper in that same shell mode while it initializes arrays.
  set +u
  while IFS= read -r -d '' arg; do
    FORWARDED_ARGS+=("$arg")
  done < <(build_forwarded_args "$desired_model")
  set -u
}

run_phase1_scan() (
  TEST_ORIG_ARGS=("$@")
  # Keep the production scanner intact, replacing only its command-line source
  # so this focused harness can exercise collection and its early exits.
  eval "$(awk '/^# ── Phase 1: Argument Pre-Parsing/,/^# ── Per-Process Ephemeral Session Control/' "$CTHRU" | sed 's|ORIG_ARGS=("$@")|ORIG_ARGS=("${TEST_ORIG_ARGS[@]}")|')"
  printf '%s\n' "${CALLER_SETTINGS_PAYLOADS[@]}"
)

run_agents_phase1_scan() (
  TEST_ORIG_ARGS=("$@")
  eval "$(awk '/^# ── Phase 1: Argument Pre-Parsing/,/^# ── Per-Process Ephemeral Session Control/' "$CTHRU" | sed 's|ORIG_ARGS=("$@")|ORIG_ARGS=("${TEST_ORIG_ARGS[@]}")|')"
  printf '%s\n' "${CALLER_AGENTS_PAYLOADS[@]-}"
)

assert_json_case() {
  local case_name="$1" json="$2"
  node - "$case_name" "$json" <<'NODE'
const [caseName, json] = process.argv.slice(2);
const settings = JSON.parse(json);
const fail = message => { console.error(message); process.exit(1); };
const hasInjectedCore = () =>
  settings.mcpServers?.['llm-capabilities'] &&
  Array.isArray(settings.hooks?.SessionStart) && settings.hooks.SessionStart.length > 0 &&
  Array.isArray(settings.permissions?.allow) &&
  settings.permissions.allow.includes('mcp__llm-capabilities__*');

if (caseName === 'preferences') {
  if (settings.showClearContextOnPlanAccept !== true) fail('showClearContextOnPlanAccept was not passed through');
  if (settings.tui !== 'fullscreen') fail('tui was not passed through');
  if ('model' in settings) fail('user model was not denied');
  if ('env' in settings) fail('user env was not denied');
  if (!JSON.stringify(settings.hooks).includes('user-settings-hook')) fail('novel user hooks were not preserved');
  if (!hasInjectedCore()) fail('c-thru injected core settings are missing');
} else if (caseName === 'missing') {
  const keys = Object.keys(settings).sort().join(',');
  if (keys !== 'hooks,mcpServers,permissions,statusLine') fail(`missing-file baseline leaked keys: ${keys}`);
  if (!hasInjectedCore()) fail('c-thru injected core settings are missing');
} else if (caseName === 'corrupt') {
  if (!hasInjectedCore()) fail('c-thru injected core settings are missing after corrupt user settings');
} else {
  fail(`unknown case ${caseName}`);
}
NODE
}

echo "1. Preferences pass through while routing/auth/hook keys are denied"
printf '%s\n' '{"showClearContextOnPlanAccept":true,"tui":"fullscreen","model":"x","env":{"A":"B"},"hooks":{"SessionStart":[{"hooks":[{"command":"user-settings-hook"}]}]}}' > "$PROFILE_DIR/settings.json"
run_builder
BUILDER_STATUS=$?
assert "preference settings builder exits 0" test "$BUILDER_STATUS" -eq 0
assert "preference passthrough and denylist behavior" assert_json_case preferences "$BUILT_JSON"

echo
echo "2. Missing settings.json retains the c-thru-only baseline"
rm -f "$PROFILE_DIR/settings.json"
run_builder
BUILDER_STATUS=$?
assert "missing settings builder exits 0" test "$BUILDER_STATUS" -eq 0
assert "missing settings file succeeds with the prior baseline shape" assert_json_case missing "$BUILT_JSON"
BASELINE_JSON="$BUILT_JSON"

echo
echo "2a. User preferences without hooks or permissions retain the c-thru baseline"
printf '%s\n' '{"tui":"compact"}' > "$PROFILE_DIR/settings.json"
run_builder
assert "no-hook/no-permission settings builder exits 0" test "$?" -eq 0
assert "no-hook/no-permission fixture preserves the baseline hook and permission subtrees" node - "$BUILT_JSON" "$BASELINE_JSON" <<'NODE'
const [actual, baseline] = process.argv.slice(2).map(JSON.parse);
process.exit(actual.tui === 'compact' && JSON.stringify(actual.hooks) === JSON.stringify(baseline.hooks) &&
  JSON.stringify(actual.permissions) === JSON.stringify(baseline.permissions) ? 0 : 1);
NODE

echo
echo "3. Corrupt settings.json warns but does not block launch"
printf '%s\n' '{oops' > "$PROFILE_DIR/settings.json"
WARN_FILE="$FIXTURE_DIR/corrupt-warning"
run_builder 2>"$WARN_FILE"
BUILDER_STATUS=$?
assert "corrupt settings builder exits 0" test "$BUILDER_STATUS" -eq 0
assert "corrupt settings file still produces c-thru settings" assert_json_case corrupt "$BUILT_JSON"
assert "corrupt settings file emits the expected warning" grep -q '^c-thru: ignoring unparseable user settings.json:' "$WARN_FILE"

echo
echo "4. Hooks and permissions merge additively without double-firing"
LINKED_SESSION="$FIXTURE_DIR/session-link.sh"
DANGLING_LINK="$FIXTURE_DIR/dangling-link.sh"
ln -sf "$TOOLS_DIR/c-thru-session-start.sh" "$LINKED_SESSION"
ln -sf "$FIXTURE_DIR/no-such-hook.sh" "$DANGLING_LINK"
node - "$PROFILE_DIR/settings.json" "$TOOLS_DIR" "$LINKED_SESSION" "$DANGLING_LINK" <<'NODE'
const fs = require('fs');
const [file, tools, linkedSession, dangling] = process.argv.slice(2);
const tool = name => `${tools}/${name}.sh`;
fs.writeFileSync(file, JSON.stringify({
  showClearContextOnPlanAccept: true,
  hooks: {
    SessionStart: [
      { hooks: [{ type: 'command', command: linkedSession, timeout: 999 }] },
      { matcher: '', hooks: [{ type: 'command', command: tool('c-thru-session-start') }] },
      { hooks: [{ type: 'command', command: dangling }] },
    ],
    PostToolUse: [
      { matcher: 'Write|Edit', hooks: [
        { type: 'command', command: tool('c-thru-map-changed'), timeout: 99 },
        { type: 'command', command: '/foreign/mixed-hook.sh', timeout: 180 },
      ] },
      { matcher: 'ExitPlanMode', timeout: 5, hooks: [{ type: 'command', command: '/foreign/post-hook.sh' }] },
    ],
    PreToolUse: [
      { matcher: 'ExitPlanMode', timeout: 180, hooks: [{ type: 'command', command: '/foreign/pre-hook.sh' }] },
      { matcher: 'Prompt', hooks: [{ type: 'prompt', prompt: 'keep this verbatim' }] },
      { matcher: 'Args', hooks: [{ command: '/foreign/with-args.sh --flag value' }] },
    ],
  },
  permissions: {
    allow: ['mcp__llm-capabilities__*', 'B'],
    deny: ['mcp__llm-capabilities__*', 'D'],
    ask: ['A'], defaultMode: 'acceptEdits', additionalDirectories: ['/tmp/extra'],
  },
}));
NODE
RUN_PAYLOADS=()
run_builder
assert "additive merge builder exits 0" test "$?" -eq 0
assert "symlink, matcher, foreign-hook, and permissions merge behavior" node - "$BUILT_JSON" "$TOOLS_DIR" "$DANGLING_LINK" <<'NODE'
const [json, tools, dangling] = process.argv.slice(2);
const settings = JSON.parse(json);
const fail = m => { console.error(m); process.exit(1); };
const entries = (event, matcher) => (settings.hooks[event] || []).filter(e => (e.matcher ?? '*') === matcher);
const commands = (event, matcher) => entries(event, matcher).flatMap(e => e.hooks);
const session = `${tools}/c-thru-session-start.sh`;
if (commands('SessionStart', '*').filter(h => h.command === session).length !== 1) fail('symlink/missing/empty matcher duplicates did not collapse to one injected SessionStart hook');
const mixed = commands('PostToolUse', 'Write|Edit');
if (!mixed.some(h => h.command === '/foreign/mixed-hook.sh') || mixed.some(h => h.timeout === 99)) fail('mixed entry did not retain only its novel command');
if (!commands('SessionStart', '*').some(h => h.command === dangling)) fail('dangling symlink hook did not survive');
const foreignEntry = (event, matcher, command) => entries(event, matcher).find(e =>
  e.hooks.some(h => h.command === command));
const preForeign = foreignEntry('PreToolUse', 'ExitPlanMode', '/foreign/pre-hook.sh');
const postForeign = foreignEntry('PostToolUse', 'ExitPlanMode', '/foreign/post-hook.sh');
if (preForeign?.timeout !== 180 || postForeign?.timeout !== 5) fail('foreign entry attributes were not preserved');
if (!commands('PreToolUse', 'Prompt').some(h => h.type === 'prompt' && h.prompt === 'keep this verbatim')) fail('non-command hook was not preserved');
if (!commands('PreToolUse', 'Args').some(h => h.command === '/foreign/with-args.sh --flag value')) fail('command with arguments was not preserved');
const p = settings.permissions;
if (p.allow.filter(x => x === 'mcp__llm-capabilities__*').length !== 1 || !p.allow.includes('B')) fail('permissions allow was not union-deduped');
if (!p.deny.includes('mcp__llm-capabilities__*') || !p.deny.includes('D') || !p.ask.includes('A') || p.defaultMode !== 'acceptEdits' || p.additionalDirectories?.[0] !== '/tmp/extra') fail('permissions pass-through was incomplete');
NODE

echo
echo "5. Malformed user shapes warn and retain the injected core"
for malformed in \
  '{"hooks":null}' \
  '{"permissions":"oops"}' \
  '{"hooks":{"SessionStart":"oops"}}' \
  '{"hooks":{"SessionStart":[{"matcher":"*"}]}}' \
  '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","timeout":5}]}]}}' \
  '{"hooks":{"SessionStart":[{"hooks":[{"timeout":5}]}]}}'; do
  printf '%s\n' "$malformed" > "$PROFILE_DIR/settings.json"
  WARN_FILE="$FIXTURE_DIR/malformed-warning-$RANDOM"
  RUN_PAYLOADS=()
  run_builder 2>"$WARN_FILE"
  assert "malformed shape still builds settings" test "$?" -eq 0
  assert "malformed shape emits a warning" grep -q '^c-thru: ignoring malformed user ' "$WARN_FILE"
  assert "malformed shape retains injected hooks and permissions" node - "$BUILT_JSON" <<'NODE'
const settings = JSON.parse(process.argv[2]);
process.exit(settings.hooks?.SessionStart?.length && settings.permissions?.allow?.includes('mcp__llm-capabilities__*') ? 0 : 1);
NODE
done

echo
echo "6. Caller --settings payloads merge, filter proxy keys, and preserve invalid flags"
printf '%s\n' '{"userPreference":"user","callerWinner":"user"}' > "$PROFILE_DIR/settings.json"
CALLER_FILE="$FIXTURE_DIR/caller-settings.json"
printf '%s\n' '{"filePreference":true,"callerWinner":"file"}' > "$CALLER_FILE"
CALLER_HOOK_PAYLOAD="$(node - "$TOOLS_DIR" <<'NODE'
const tools = process.argv[2];
process.stdout.write(JSON.stringify({
  equalsPreference: true, callerWinner: 'equals',
  hooks: { SessionStart: [{ matcher: '*', hooks: [{ command: `${tools}/c-thru-session-start.sh`, timeout: 999 }] }] },
  permissions: { allow: ['mcp__llm-capabilities__*', 'caller'] },
}));
NODE
)"
RUN_PAYLOADS=('{"jsonPreference":true,"callerWinner":"json","env":{"BAD":1}}' "$CALLER_FILE" "$CALLER_HOOK_PAYLOAD")
WARN_FILE="$FIXTURE_DIR/caller-warning"
run_builder 2>"$WARN_FILE"
assert "caller payload builder exits 0" test "$?" -eq 0
assert "caller payload precedence and all forms merge" node - "$BUILT_JSON" <<'NODE'
const s = JSON.parse(process.argv[2]);
process.exit(s.userPreference === 'user' && s.jsonPreference && s.filePreference && s.equalsPreference && s.callerWinner === 'equals' &&
  !('env' in s) && s.permissions.allow.includes('caller') && s.permissions.allow.filter(x => x === 'mcp__llm-capabilities__*').length === 1 &&
  s.hooks.SessionStart.flatMap(e => e.hooks).filter(h => h.command.endsWith('/c-thru-session-start.sh')).length === 1 &&
  s.hooks.SessionStart[0].hooks[0].timeout === 5 ? 0 : 1);
NODE
assert "caller proxy-owned key warning is exact" grep -qx 'c-thru: --settings key "env" is proxy-owned, ignored' "$WARN_FILE"

ORIG_ARGS=(--settings '{"jsonPreference":true}' --settings "$CALLER_FILE" "--settings=$CALLER_HOOK_PAYLOAD")
run_forwarder
assert "successful caller --settings flags are replaced by the merged injection" node - "${FORWARDED_ARGS[@]}" <<'NODE'
const args = process.argv.slice(2);
const settingsFlags = args.reduce((n, a) => n + (a === '--settings' || a.startsWith('--settings=')), 0);
process.exit(settingsFlags === 1 && JSON.parse(args[args.indexOf('--settings') + 1]).equalsPreference === true ? 0 : 1);
NODE

RUN_PAYLOADS=('not-json')
WARN_FILE="$FIXTURE_DIR/invalid-caller-warning"
run_builder 2>"$WARN_FILE"
assert "unparseable caller payload warns" grep -q '^c-thru: ignoring unparseable --settings payload:' "$WARN_FILE"
ORIG_ARGS=(--settings not-json)
run_forwarder
assert "unparseable caller --settings is forwarded verbatim" node - "${FORWARDED_ARGS[@]}" <<'NODE'
const args = process.argv.slice(2);
const i = args.lastIndexOf('--settings');
process.exit(i >= 0 && args[i + 1] === 'not-json' ? 0 : 1);
NODE

ORIG_ARGS=(-- --settings '{"afterTerminator":true}' --mode offline)
CALLER_SETTINGS_PARSEABLE=()
run_forwarder
assert "tokens after -- remain untouched by the forwarded-arg scanner" node - "${FORWARDED_ARGS[@]}" <<'NODE'
const args = process.argv.slice(2);
const i = args.indexOf('--');
process.exit(i >= 0 && JSON.stringify(args.slice(i)) === JSON.stringify(['--', '--settings', '{"afterTerminator":true}', '--mode', 'offline']) ? 0 : 1);
NODE

PHASE_WARN="$FIXTURE_DIR/phase-settings-warning"
run_phase1_scan --settings >"$FIXTURE_DIR/phase-settings-output" 2>"$PHASE_WARN"
PHASE_STATUS=$?
assert "Phase-1 rejects a missing two-token --settings value" test "$PHASE_STATUS" -ne 0
assert "Phase-1 missing-value error text is exact" grep -qx 'c-thru: --settings requires a value' "$PHASE_WARN"
PHASE_PAYLOADS="$(run_phase1_scan --settings '{"first":true}' '--settings={"second":true}' -- --settings '{"after":true}')"
assert "Phase-1 collects two-token and equals --settings values in order and stops at --" test "$PHASE_PAYLOADS" = $'{"first":true}\n{"second":true}'

echo
echo "7. Realistic mirrored inventory dedupes while preserving user preferences"
REAL_LINK="$FIXTURE_DIR/real-session-link.sh"
ln -sf "$TOOLS_DIR/c-thru-session-start.sh" "$REAL_LINK"
REAL_EXPECTED="$FIXTURE_DIR/real-expected.json"
node - "$PROFILE_DIR/settings.json" "$TOOLS_DIR" "$REAL_LINK" "$REAL_EXPECTED" <<'NODE'
const fs = require('fs');
const [file, tools, link, expectedFile] = process.argv.slice(2);
const tool = n => `${tools}/${n}.sh`;
const mirrors = {
  SessionStart: [{ matcher: '*', hooks: [{ command: link, timeout: 90 }] }],
  PreCompact: [{ matcher: '*', hooks: [{ command: tool('c-thru-postcompact-context'), timeout: 90 }] }],
  UserPromptSubmit: [{ matcher: '*', hooks: [{ command: tool('c-thru-proxy-health') }, { command: tool('c-thru-classify') }] }],
  PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ command: tool('c-thru-map-changed') }] }, { matcher: 'ExitPlanMode', timeout: 5, hooks: [{ command: '/foreign/post-real.sh' }] }],
  PreToolUse: ['Agent', 'WebSearch', 'WebFetch', 'Monitor', 'Plan'].map(matcher => ({ matcher, hooks: [{ command: tool('c-thru-agent-router-hook') }] }))
    .concat([{ matcher: 'EnterPlanMode', hooks: [{ command: tool('c-thru-enter-plan-hook') }] }, { matcher: 'ExitPlanMode', timeout: 180, hooks: [{ command: '/foreign/pre-real.sh' }] }]),
};
fs.writeFileSync(file, JSON.stringify({ hooks: mirrors, permissions: { allow: ['user-allow'], defaultMode: 'acceptEdits' }, showClearContextOnPlanAccept: true }));
const expected = [];
for (const [event, entries] of Object.entries(mirrors)) {
  for (const entry of entries) for (const hook of entry.hooks) {
    try {
      const canonical = fs.realpathSync(hook.command);
      if (canonical.startsWith(tools)) expected.push({ event, matcher: entry.matcher ?? '*', canonical });
    } catch (_) {}
  }
}
fs.writeFileSync(expectedFile, JSON.stringify(expected));
NODE
RUN_PAYLOADS=()
run_builder
assert "realistic settings fixture builds" test "$?" -eq 0
assert "realistic mirrored inventory has one injected survivor per fixture registration" node - "$BUILT_JSON" "$REAL_EXPECTED" <<'NODE'
const [json, expectedFile] = process.argv.slice(2); const fs = require('fs'); const s = JSON.parse(json);
const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
for (const { event, matcher, canonical } of expected) {
  const count = (s.hooks[event] || []).filter(e => (e.matcher ?? '*') === matcher).flatMap(e => e.hooks).filter(h => {
    try { return fs.realpathSync(h.command) === canonical; } catch (_) { return h.command === canonical; }
  }).length;
  if (count !== 1) { console.error(`${event}/${matcher}/${canonical}: got ${count}`); process.exit(1); }
}
const findForeign = (event, matcher, command) => (s.hooks[event] || []).find(e => e.matcher === matcher && e.hooks.some(h => h.command === command));
if (findForeign('PreToolUse', 'ExitPlanMode', '/foreign/pre-real.sh')?.timeout !== 180 || findForeign('PostToolUse', 'ExitPlanMode', '/foreign/post-real.sh')?.timeout !== 5 || !s.permissions.allow.includes('user-allow') || s.showClearContextOnPlanAccept !== true) process.exit(1);
NODE

echo
echo "8. settings.local.json is filtered, merged, and excluded from the session shadow"
printf '%s\n' '{"tui":"compact"}' > "$PROFILE_DIR/settings.json"
printf '%s\n' '{"localOnlyPreference":true,"tui":"fullscreen","model":"x","env":{"A":"B"}}' > "$PROFILE_DIR/settings.local.json"
RUN_PAYLOADS=()
run_builder
assert "settings.local builder exits 0" test "$?" -eq 0
assert "settings.local preference, denylist, and precedence behavior" node - "$BUILT_JSON" <<'NODE'
const settings = JSON.parse(process.argv[2]);
process.exit(settings.localOnlyPreference === true && settings.tui === 'fullscreen' &&
  !('model' in settings) && !('env' in settings) ? 0 : 1);
NODE

CLAUDE_PROXY_BYPASS=0
ORIGINAL_CLAUDE_PROFILE_DIR="$PROFILE_DIR"
CTHRU_REPO_ROOT="$FIXTURE_DIR/nonexistent-repo"
NO_AGENTS=1
setup_ephemeral_session
assert "settings.local is excluded from the ephemeral session shadow" test ! -e "$EPHEMERAL_SESSION_DIR/settings.local.json" -a ! -L "$EPHEMERAL_SESSION_DIR/settings.local.json"
rm -rf "$EPHEMERAL_SESSION_DIR"
EPHEMERAL_SESSION_DIR=""

echo
echo "9. Matching foreign hooks across caller payloads dedupe to one registration"
printf '%s\n' '{}' > "$PROFILE_DIR/settings.json"
rm -f "$PROFILE_DIR/settings.local.json"
RUN_PAYLOADS=(
  '{"hooks":{"SessionStart":[{"matcher":"*","hooks":[{"command":"/foreign/shared-across-payloads.sh"}]}]}}'
  '{"hooks":{"SessionStart":[{"matcher":"*","hooks":[{"command":"/foreign/shared-across-payloads.sh"}]}]}}'
)
run_builder
assert "cross-payload hook builder exits 0" test "$?" -eq 0
assert "cross-payload foreign hook has one surviving registration" node - "$BUILT_JSON" <<'NODE'
const settings = JSON.parse(process.argv[2]);
const commands = (settings.hooks.SessionStart || [])
  .filter(entry => (entry.matcher ?? '*') === '*')
  .flatMap(entry => entry.hooks)
  .filter(hook => hook.command === '/foreign/shared-across-payloads.sh');
process.exit(commands.length === 1 ? 0 : 1);
NODE

echo
echo "============================================="
echo
echo "10. Caller --agents payloads merge with ephemeral agent inventory"
AGENT_FLEET_DIR="$FIXTURE_DIR/agent-fleet/agents"
mkdir -p "$AGENT_FLEET_DIR" "$PROFILE_DIR/agents" "$SESSION_DIR/agents"
printf '%s\n' $'---\ndescription: fleet collision\nmodel: fleet-model\ntier_budget: 1\n---\nfleet prompt' > "$AGENT_FLEET_DIR/collision.md"
printf '%s\n' $'---\ndescription: profile collision\nmodel: profile-model\ntier_budget: 2\n---\nprofile prompt' > "$PROFILE_DIR/agents/collision.md"
NO_AGENTS=0
RUN_PAYLOADS=()
rm -rf "$SESSION_DIR/agents"
run_agents_builder
assert "profile wins fleet basename collision before caller reconciliation" node - "$BUILT_AGENTS_JSON" <<'NODE'
const agents = JSON.parse(process.argv[2]);
process.exit(agents.collision?.description === 'profile collision' ? 0 : 1);
NODE
RUN_PAYLOADS=('{"collision":{"description":"caller collision"}}')
rm -rf "$SESSION_DIR/agents"
run_agents_builder
assert "caller --agents wins profile and fleet collisions" node - "$BUILT_AGENTS_JSON" <<'NODE'
const agents = JSON.parse(process.argv[2]);
process.exit(agents.collision?.description === 'caller collision' ? 0 : 1);
NODE

PHASE_AGENT_PAYLOADS="$(run_agents_phase1_scan '--agents={"equals":{"description":"e"}}' --agents '{"space":{"description":"s"}}')"
assert "Phase-1 collects equals and two-token --agents payloads in order" test "$PHASE_AGENT_PAYLOADS" = $'{"equals":{"description":"e"}}\n{"space":{"description":"s"}}'
RUN_PAYLOADS=()
while IFS= read -r payload; do
  RUN_PAYLOADS+=("$payload")
done < <(run_agents_phase1_scan '--agents={"equals-valid":{"description":"e"}}' --agents not-json)
rm -rf "$SESSION_DIR/agents"
run_agents_builder
assert "equals-form valid and two-token invalid --agents payloads retain aligned parseability" test "${CALLER_AGENTS_PARSEABLE[*]}" = "1 0"
RUN_PAYLOADS=('{"valid":{"description":"yes"}}' 'not-json' '[{"array":true}]' '1')
rm -rf "$SESSION_DIR/agents"
run_agents_builder
assert "mixed valid and invalid caller --agents payloads retain one parseability bit each" test "${CALLER_AGENTS_PARSEABLE[*]}" = "1 0 0 0"
assert "non-object caller --agents payloads are ignored" node - "$BUILT_AGENTS_JSON" <<'NODE'
const agents = JSON.parse(process.argv[2]);
process.exit(agents.valid?.description === 'yes' && !('array' in agents) ? 0 : 1);
NODE
PHASE_AGENT_WARN="$FIXTURE_DIR/phase-agents-warning"
run_agents_phase1_scan --agents >"$FIXTURE_DIR/phase-agents-output" 2>"$PHASE_AGENT_WARN"
PHASE_AGENT_STATUS=$?
assert "Phase-1 rejects a missing two-token --agents value" test "$PHASE_AGENT_STATUS" -ne 0
assert "Phase-1 missing --agents error text is exact" grep -qx 'c-thru: --agents requires a value' "$PHASE_AGENT_WARN"
PHASE_AGENT_TERMINATED="$(run_agents_phase1_scan -- --agents '{"after":true}')"
assert "Phase-1 leaves --agents after -- untouched" test -z "$PHASE_AGENT_TERMINATED"

REAL_PROFILE_AGENT="$PROFILE_DIR/agents/remove-me.md"
printf '%s\n' 'profile agent must remain unchanged' > "$REAL_PROFILE_AGENT"
cp "$REAL_PROFILE_AGENT" "$FIXTURE_DIR/remove-me-before"
rm -rf "$SESSION_DIR/agents"
mkdir -p "$SESSION_DIR/agents"
ln -s "$REAL_PROFILE_AGENT" "$SESSION_DIR/agents/remove-me.md"
RUN_PAYLOADS=('{"remove-me":{"description":"caller override"}}')
NO_AGENTS=0
run_agents_builder
assert "caller agent collision removes only the ephemeral symlink" test ! -e "$SESSION_DIR/agents/remove-me.md" -a ! -L "$SESSION_DIR/agents/remove-me.md"
assert "caller agent collision does not modify the symlink target" cmp -s "$REAL_PROFILE_AGENT" "$FIXTURE_DIR/remove-me-before"

echo
echo "11. Agent color frontmatter parses, normalizes, validates, and rides only the c-thru fleet"
# Fleet agents live in $CTHRU_REPO_ROOT/agents (= $FIXTURE_DIR/agent-fleet/agents, set by run_agents_builder).
# Use fresh names so they never collide with the §10 collision/profile fixtures.
write_color_fixture() {
  local file="$1" color_line="$2"
  printf '%s\n' "---" "description: color fixture agent that does useful work for matching" \
    "model: $file" "tier_budget: 999999" "$color_line" "---" "fixture prompt body" > "$AGENT_FLEET_DIR/$file.md"
}
write_color_fixture color-ok       'color: purple'
write_color_fixture color-mixed    'color: Purple'
write_color_fixture color-upper    'color: RED'
write_color_fixture color-bad      'color: teal'
write_color_fixture color-empty    'color: '
write_color_fixture color-none     ''
rm -rf "$SESSION_DIR/agents"; rm -rf "$PROFILE_DIR/agents"; mkdir -p "$PROFILE_DIR/agents"
NO_AGENTS=0
RUN_PAYLOADS=()
COLOR_WARN="$FIXTURE_DIR/color-warn"
run_agents_builder 2>"$COLOR_WARN"
assert "color builder exits 0" test "$?" -eq 0
assert "valid color passes through verbatim (lowercase)" node - "$BUILT_AGENTS_JSON" <<'NODE'
const a = JSON.parse(process.argv[2]); process.exit(a['color-ok']?.color === 'purple' ? 0 : 1);
NODE
assert "mixed-case value is normalized to lowercase (Purple -> purple)" node - "$BUILT_AGENTS_JSON" <<'NODE'
const a = JSON.parse(process.argv[2]); process.exit(a['color-mixed']?.color === 'purple' ? 0 : 1);
NODE
assert "uppercase value is normalized to lowercase (RED -> red)" node - "$BUILT_AGENTS_JSON" <<'NODE'
const a = JSON.parse(process.argv[2]); process.exit(a['color-upper']?.color === 'red' ? 0 : 1);
NODE
assert "invalid color (teal) omits the key" node - "$BUILT_AGENTS_JSON" <<'NODE'
const a = JSON.parse(process.argv[2]); process.exit(!('color' in (a['color-bad'] || {})) ? 0 : 1);
NODE
assert "empty color omits the key" node - "$BUILT_AGENTS_JSON" <<'NODE'
const a = JSON.parse(process.argv[2]); process.exit(!('color' in (a['color-empty'] || {})) ? 0 : 1);
NODE
assert "missing color line omits the key" node - "$BUILT_AGENTS_JSON" <<'NODE'
const a = JSON.parse(process.argv[2]); process.exit(!('color' in (a['color-none'] || {})) ? 0 : 1);
NODE
assert "invalid color emits the pinned stderr warning" grep -q '^c-thru: ignoring invalid agent color "teal" on color-bad (allowed: red|blue|green|yellow|purple|orange|pink|cyan)$' "$COLOR_WARN"
assert "empty color is treated as invalid and warns with an empty raw value" grep -q '^c-thru: ignoring invalid agent color "" on color-empty (allowed: red|blue|green|yellow|purple|orange|pink|cyan)$' "$COLOR_WARN"

# §4 c-thru-only: NO_AGENTS=1 baseline invents no agents at all (no color, no entries).
NO_AGENTS=1
rm -rf "$SESSION_DIR/agents"
run_agents_builder
assert "NO_AGENTS=1 baseline builds an empty agent map" node - "$BUILT_AGENTS_JSON" <<'NODE'
const a = JSON.parse(process.argv[2]); const keys = Object.keys(a);
process.exit(keys.length === 0 ? 0 : 1);
NODE

echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
