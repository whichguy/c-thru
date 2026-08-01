#!/usr/bin/env bash
# Live brand-leaf / OSS identity probe via c-thru + proxy proof.
#
# Modes:
#   MODE=print   (default)  One independent `c-thru -p` subprocess per agent:
#                           prompt on STDIN; stdout/stderr captured.
#                           Proxy is OWNED by that c-thru and MUST die on exit
#                           (C_THRU_KEEP_PROXY=0). Invoke proof via per-agent
#                           CLAUDE_PROXY_JOURNAL under $OUT_ROOT/<agent>/journal.
#   MODE=direct  POST /v1/messages to a harness-owned proxy (not c-thru).
#                Ground truth for "is the OSS backend reachable?"
#   MODE=interactive  PTY + ask + /exit (lifecycle only)
#
# Usage:
#   AGENTS="deepseek qwen kimi glm" MODE=print STRICT_HOST=1 \
#     CLAUDE_LLM_MODE=best-cloud-oss bash test/c-thru-brand-identity-live.sh
#   MODE=direct AGENTS="deepseek qwen kimi glm" bash test/c-thru-brand-identity-live.sh
#
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CTHRU="${CTHRU:-$REPO_DIR/tools/c-thru}"
PROXY_JS="${PROXY_JS:-$REPO_DIR/tools/claude-proxy}"
MAP="${CLAUDE_MODEL_MAP_PATH:-$REPO_DIR/config/model-map.json}"
BRAND_JSON="$REPO_DIR/config/brand-agents.json"
OUT_ROOT="${OUT_ROOT:-${TMPDIR:-/tmp}/c-thru-brand-identity-$$}"
AGENTS="${AGENTS:-deepseek deepseek-flash qwen kimi glm gemma gpt-oss}"
TIMEOUT_S="${TIMEOUT_S:-300}"
REPLY_WAIT_S="${REPLY_WAIT_S:-120}"
MODE="${MODE:-print}"
LLM_MODE="${CLAUDE_LLM_MODE:-best-cloud-oss}"
STATS="${STATS:-1}"
STRICT_HOST="${STRICT_HOST:-1}"
QUESTION_SUFFIX='what is your model name & who is your maker? where were you born?'
IDENTITY_Q='what is your model name & who is your maker? where were you born? Answer in 1-3 short sentences as yourself only.'

mkdir -p "$OUT_ROOT"
SUMMARY="$OUT_ROOT/SUMMARY.md"
: >"$SUMMARY"

log_sum() { echo "$@" | tee -a "$SUMMARY"; }

log_sum "# c-thru brand / OSS identity probe"
log_sum ""
log_sum "- started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log_sum "- out: \`$OUT_ROOT\`"
log_sum "- mode: \`$MODE\`  stats: \`$STATS\`  strict_host: \`$STRICT_HOST\`"
log_sum "- llm_mode: \`$LLM_MODE\`"
log_sum "- agents: $AGENTS"
log_sum ""

[[ -f "$CTHRU" ]] || { echo "fatal: no c-thru"; exit 2; }
command -v python3 >/dev/null || { echo "fatal: need python3"; exit 2; }
command -v curl >/dev/null || { echo "fatal: need curl"; exit 2; }
command -v node >/dev/null || { echo "fatal: need node"; exit 2; }

export C_THRU_NO_UPDATE=1
export C_THRU_NO_MARKETPLACE_UPDATE=1
export C_THRU_SKIP_PREPULL=1
export C_THRU_BRAND_REUSE_GATEWAY_PROXY=0
export CLAUDE_LLM_MODE="$LLM_MODE"
export CLAUDE_MODEL_MAP_PATH="$MAP"
if [[ "${C_THRU_BRAND_IDENTITY_ALLOW_API_KEY:-0}" != "1" ]]; then
  export C_THRU_ANTHROPIC_AUTH_MODE="${C_THRU_ANTHROPIC_AUTH_MODE:-subscription}"
fi

# ── Expected pins / family from brand-agents.json ───────────────────────────
expected_pin_for() {
  local agent="$1"
  node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const id=process.argv[2];
const a=(j.agents||[]).find(x=>x.id===id);
if(!a){process.exit(2)}
let pin=a.pin||"";
if(pin.startsWith("model:")) pin=pin.slice(6);
process.stdout.write(pin);
' "$BRAND_JSON" "$agent" 2>/dev/null || true
}

family_for() {
  local agent="$1"
  node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const id=process.argv[2];
const a=(j.agents||[]).find(x=>x.id===id);
if(!a){process.exit(2)}
process.stdout.write(a.family||a.id||"");
' "$BRAND_JSON" "$agent" 2>/dev/null || true
}

# ── Proxy lifecycle ─────────────────────────────────────────────────────────
# print: each c-thru owns its proxy (KEEP_PROXY=0) — do NOT prime a shared port.
# direct: harness-owned proxy for the matrix only; killed on harness exit.
if [[ "$MODE" == "direct" ]]; then
  if [[ -z "${CLAUDE_PROXY_PORT:-}" ]]; then
    CLAUDE_PROXY_PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
  fi
  export CLAUDE_PROXY_PORT
  log_sum "- proxy_port: \`$CLAUDE_PROXY_PORT\` (harness-owned for MODE=direct)"
elif [[ "$MODE" == "print" || "$MODE" == "interactive" ]]; then
  # Explicit: proxy must die with each c-thru subprocess.
  export C_THRU_KEEP_PROXY=0
  unset CLAUDE_PROXY_PORT || true
  log_sum "- proxy lifecycle: per-c-thru (C_THRU_KEEP_PROXY=0; no shared CLAUDE_PROXY_PORT)"
fi

proxy_base() {
  [[ -n "${CLAUDE_PROXY_PORT:-}" ]] || return 1
  printf 'http://127.0.0.1:%s' "$CLAUDE_PROXY_PORT"
}

wait_proxy() {
  local base tries=0
  base="$(proxy_base)" || return 1
  while (( tries < 120 )); do
    curl -sf --max-time 0.5 "$base/ping" >/dev/null 2>&1 && return 0
    sleep 0.25
    tries=$((tries + 1))
  done
  return 1
}

# Start proxy without a full chat if needed (direct mode + stats warm).
prime_proxy() {
  local base log ppid tries
  base="$(proxy_base)" || return 1
  if curl -sf --max-time 0.5 "$base/ping" >/dev/null 2>&1; then
    log_sum "- reusing live proxy on :$CLAUDE_PROXY_PORT"
    return 0
  fi
  # macOS mktemp: trailing X's only
  log="$(mktemp "${TMPDIR:-/tmp}/c-thru-prime.XXXXXX")"
  : >"$log"
  # Fixed port; keep pid for teardown/diagnosis. Don't disown until ready —
  # if node exits immediately we want to see it.
  env \
    CLAUDE_MODEL_MAP_PATH="$MAP" \
    CLAUDE_LLM_MODE="$LLM_MODE" \
    CLAUDE_PROXY_STARTUP_PROBE=0 \
    CLAUDE_PROXY_SKIP_OLLAMA_WARMUP=1 \
    node "$PROXY_JS" --port "$CLAUDE_PROXY_PORT" --config "$MAP" \
    >>"$log" 2>&1 </dev/null &
  ppid=$!
  PRIME_PROXY_PID="$ppid"
  tries=0
  while (( tries < 80 )); do
    if curl -sf --max-time 0.4 "$base/ping" >/dev/null 2>&1; then
      log_sum "- primed proxy pid $ppid on :$CLAUDE_PROXY_PORT (log $log)"
      return 0
    fi
    # node died?
    if ! kill -0 "$ppid" 2>/dev/null; then
      log_sum "- ERROR: proxy pid $ppid exited during prime (log $log)"
      log_sum "\`\`\`"
      tail -30 "$log" 2>/dev/null | while IFS= read -r line; do log_sum "$line"; done
      log_sum "\`\`\`"
      return 1
    fi
    sleep 0.25
    tries=$((tries + 1))
  done
  log_sum "- ERROR: prime proxy timeout after ${tries} polls (pid $ppid still alive? log $log)"
  tail -20 "$log" 2>/dev/null | while IFS= read -r line; do log_sum "$line"; done
  return 1
}

snapshot_status() {
  local dest="$1"
  local base
  base="$(proxy_base)" || { echo '{}' >"$dest"; return 1; }
  curl -sf --max-time 3 "$base/c-thru/status" >"$dest" 2>/dev/null || { echo '{}' >"$dest"; return 1; }
}

snapshot_recent() {
  local dest="$1"
  local base
  base="$(proxy_base)" || { echo '{"requests":[]}' >"$dest"; return 1; }
  curl -sf --max-time 3 "$base/c-thru/recent?n=40" >"$dest" 2>/dev/null || { echo '{"requests":[]}' >"$dest"; return 1; }
}

# T0-gated stats + expected pin match
analyze_stats() {
  # args: before after recent t0 expected_pin agent out_json
  python3 - "$@" <<'PY'
import json, sys, re
from pathlib import Path
from datetime import datetime, timezone

before_p, after_p, recent_p, t0_s, expected, agent, out_p = sys.argv[1:8]

def load(p):
    try: return json.loads(Path(p).read_text())
    except Exception: return {}

def parse_ts(s):
    if not s: return None
    try:
        if s.endswith("Z"): s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except Exception:
        return None

before, after, recent = load(before_p), load(after_p), load(recent_p)
t0 = parse_ts(t0_s) or datetime.now(timezone.utc)
bu = (before.get("usage") or {})
au = (after.get("usage") or {})
bbm, abm = bu.get("by_model") or {}, au.get("by_model") or {}

# only count models whose last_call >= T0 and calls increased
model_deltas = []
for m, av in abm.items():
    av = av or {}
    bc = int((bbm.get(m) or {}).get("calls") or 0)
    ac = int(av.get("calls") or 0)
    last = parse_ts(av.get("last_call"))
    if ac > bc and last and last >= t0:
        model_deltas.append({
            "model": m,
            "calls_before": bc, "calls_after": ac, "calls_delta": ac - bc,
            "input_delta": int(av.get("input") or 0) - int((bbm.get(m) or {}).get("input") or 0),
            "output_delta": int(av.get("output") or 0) - int((bbm.get(m) or {}).get("output") or 0),
            "last_call": av.get("last_call"),
        })
model_deltas.sort(key=lambda x: (-x["calls_delta"], x["model"]))

reqs = recent.get("requests") if isinstance(recent, dict) else []
if not isinstance(reqs, list): reqs = []
recent_after_t0 = []
for r in reqs:
    if not isinstance(r, dict): continue
    ts = parse_ts(r.get("ts") or r.get("time"))
    if ts and ts < t0: continue
    recent_after_t0.append({
        "model": r.get("model") or r.get("requested_model"),
        "served_by": r.get("served_by") or r.get("servedBy"),
        "backend": r.get("backend") or r.get("backend_id"),
        "status": r.get("status") or r.get("status_code"),
        "agent": r.get("agent") or r.get("agent_name"),
        "ts": r.get("ts") or r.get("time"),
    })

# expected pin match (substring, casefold). Prefer exact/substring on full pin.
# Never treat generic tags like "cloud" as a family token (false-matches every *:cloud).
_GENERIC_PARTS = {
    "cloud", "local", "pro", "flash", "plus", "mini", "base", "chat",
    "instruct", "latest", "free", "fast", "slow", "oss",
}
exp = (expected or "").strip()
exp_l = exp.lower()
matched = None
for r in recent_after_t0:
    sb = str(r.get("served_by") or "").lower()
    md = str(r.get("model") or "").lower()
    blob = f"{sb} {md}"
    if not exp_l:
        continue
    if exp_l in sb or exp_l in md or exp_l in blob:
        matched = r
        break
    # pin family without generic trailing tags (e.g. deepseek-v4-pro from deepseek-v4-pro:cloud)
    pin_core = exp_l.split(":")[0]
    if len(pin_core) >= 5 and (pin_core in sb or pin_core in md):
        matched = r
        break
# also accept first non-generic hyphen segment as family (deepseek, qwen, kimi, …)
if not matched and exp_l:
    fam = re.split(r"[-:]", exp_l)[0]
    if len(fam) >= 3 and fam not in _GENERIC_PARTS:
        for r in recent_after_t0:
            blob = f"{r.get('served_by')} {r.get('model')}".lower()
            if fam in blob:
                matched = r
                break

# by_model T0 delta for expected
model_hit = None
for d in model_deltas:
    ml = d["model"].lower()
    if not exp_l:
        continue
    if exp_l in ml or exp_l.split(":")[0] in ml:
        model_hit = d
        break
    fam = re.split(r"[-:]", exp_l)[0]
    if len(fam) >= 3 and fam not in _GENERIC_PARTS and fam in ml:
        model_hit = d
        break

invoke_ok = bool(matched) or bool(model_hit)
# empty before should not invent lifetime win
if not before.get("pid") and not before.get("usage"):
    # only trust recent_after_t0 / model_deltas with last_call >= T0 (already gated)
    pass

out = {
    "t0": t0_s,
    "expected_pin": exp,
    "agent": agent,
    "invoke_ok": invoke_ok,
    "matched_recent": matched,
    "matched_model_delta": model_hit,
    "model_deltas_t0": model_deltas[:15],
    "recent_after_t0": recent_after_t0[:20],
    "proxy_pid_before": before.get("pid"),
    "proxy_pid_after": after.get("pid"),
    "stats_before_empty": not bool(before.get("usage") or before.get("pid")),
}
Path(out_p).write_text(json.dumps(out, indent=2))
print(json.dumps(out, indent=2))
sys.exit(0 if invoke_ok else 1)
PY
}

build_prompt() {
  local agent="$1"
  local q="ask ${agent}: ${QUESTION_SUFFIX}"
  if [[ "$STRICT_HOST" != "1" ]]; then
    printf '%s' "$q"
    return 0
  fi
  cat <<EOF
HOST_DIRECTIVE (mandatory for this turn only):
You are ONLY a dispatcher. You MUST spawn Agent(subagent_type="${agent}") — no exceptions.
Do NOT answer the identity question yourself under any circumstances.
Do NOT invent, paraphrase, or role-label the leaf's self-description.
Do NOT emit <<<LEAF_BEGIN>>> with text YOU generated (that is a hard fail).
Do NOT use ask-opus, ask-fable, ask-ollama, grok-cc, /rescue, Skill(), or other skill wrappers.
Do NOT use slash commands for this turn — only the Agent tool with subagent_type="${agent}".
Spawn Agent(subagent_type="${agent}") with this exact agent user prompt:
  ${IDENTITY_Q}
When the Agent tool returns a real subagent result, copy that result VERBATIM into:

<<<LEAF_BEGIN agent=${agent}>>>
<raw agent response only — zero paraphrase, zero host analysis, zero identity rewrite>
<<<LEAF_END>>>

If spawn/auth fails OR the Agent tool is not used OR no subagent text is available:
<<<LEAF_FAIL agent=${agent} reason=<short>>>>
(Do not fill LEAF_BEGIN with a fabricated brand identity — LEAF_FAIL is the only valid non-spawn outcome.)

No follow-up questions outside the markers.

${q}
EOF
}

# Parse proxy port + pid from c-thru stderr banner.
extract_proxy_from_stderr() {
  local adir="$1"
  python3 - "$adir" <<'PY'
import re, sys
from pathlib import Path
adir = Path(sys.argv[1])
text = (adir / "stderr.txt").read_text(errors="replace") if (adir / "stderr.txt").exists() else ""
port = pid = ""
# "http://127.0.0.1:50088  pid 7407" or "proxy      http://127.0.0.1:N  pid M"
m = re.search(r"http://127\.0\.0\.1:(\d+)\s+pid\s+(\d+)", text)
if m:
    port, pid = m.group(1), m.group(2)
else:
    m2 = re.search(r"127\.0\.0\.1:(\d+)", text)
    if m2:
        port = m2.group(1)
(adir / "proxy_port.txt").write_text(port)
(adir / "proxy_pid.txt").write_text(pid)
print(f"{port}\t{pid}")
PY
}

# After c-thru exits, proxy on that port should be dead (KEEP_PROXY=0).
check_proxy_dead() {
  local adir="$1"
  local port dead=1
  port="$(cat "$adir/proxy_port.txt" 2>/dev/null || true)"
  if [[ -z "$port" ]]; then
    echo "unknown" >"$adir/proxy_dead.txt"
    return 0
  fi
  if curl -sf --max-time 0.5 "http://127.0.0.1:${port}/ping" >/dev/null 2>&1; then
    dead=0
    echo "alive" >"$adir/proxy_dead.txt"
  else
    echo "dead" >"$adir/proxy_dead.txt"
  fi
  return 0
}

# Journal-based invoke proof (survives proxy teardown). Uses shared pinMatches.
analyze_journal() {
  # args: journal_dir expected_pin agent out_json
  local jdir="$1" expected="$2" agent="$3" out_p="$4"
  node -e '
const fs = require("fs");
const path = require("path");
const { pinMatches } = require(process.argv[1]);
const jdir = process.argv[2];
const expected = process.argv[3];
const agent = process.argv[4];
const outP = process.argv[5];
const entries = [];
function walk(d) {
  if (!fs.existsSync(d)) return;
  for (const name of fs.readdirSync(d)) {
    const p = path.join(d, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (name.endsWith(".jsonl")) {
      for (const line of fs.readFileSync(p, "utf8").split(/\n/)) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch {}
      }
    }
  }
}
walk(jdir);
const hits = entries.filter((e) => {
  const req = e.request && typeof e.request === "object" ? e.request : {};
  return pinMatches(expected, { served_by: e.served_by, model: req.model || e.model });
});
const out = {
  invoke_ok: hits.length > 0,
  expected_pin: expected,
  agent,
  journal_entries: entries.length,
  matched_entries: hits.slice(0, 10).map((h) => ({
    served_by: h.served_by,
    model: (h.request && h.request.model) || null,
    ts_iso: h.ts_iso,
    endpoint: h.endpoint,
    latency_ms: h.latency_ms,
  })),
  all_served_by: [...new Set(entries.map((e) => String(e.served_by || "")).filter(Boolean))].sort(),
};
fs.writeFileSync(outP, JSON.stringify(out, null, 2));
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
process.exit(out.invoke_ok ? 0 : 1);
' "$REPO_DIR/tools/brand-identity-score.js" "$jdir" "$expected" "$agent" "$out_p"
}

# Identity text gate via shared tools/brand-identity-score.js
score_identity() {
  # args: agent family leaf_file out_json
  local agent="$1" family="$2" leaf_p="$3" out_p="$4"
  node -e '
const fs = require("fs");
const scorePath = process.argv[1];
const agent = process.argv[2];
const family = process.argv[3];
const leafP = process.argv[4];
const outP = process.argv[5];
const { scoreIdentity } = require(scorePath);
let text = "";
try { text = fs.readFileSync(leafP, "utf8"); } catch {}
const r = scoreIdentity({ agent, family, leafText: text });
const out = Object.assign({ agent, family, leaf_preview: text.slice(0, 300) }, r);
fs.writeFileSync(outP, JSON.stringify(out, null, 2));
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
process.exit(r.identity_ok ? 0 : 1);
' "$REPO_DIR/tools/brand-identity-score.js" "$agent" "$family" "$leaf_p" "$out_p"
}

run_print_mode() {
  local agent="$1" adir="$2"
  local prompt ec jdir settings_json
  prompt="$(build_prompt "$agent")"
  printf '%s\n' "$prompt" >"$adir/prompt.txt"
  jdir="$adir/journal"
  mkdir -p "$jdir"
  # Isolate from marketplace plugins that steal brand names (esp. grok-cc
  # shadowing fleet Agent(subagent_type="grok")). Caller --settings wins over
  # user enabledPlugins for this launch (cThruInjected does not re-set plugins).
  settings_json='{"enabledPlugins":{"grok-cc@grok-plugin-claude-code":false,"codex@openai-codex":false}}'
  printf '%s\n' "$settings_json" >"$adir/settings-isolate.json"
  # Independent c-thru subprocess per agent:
  #   - prompt on STDIN
  #   - C_THRU_KEEP_PROXY=0 so proxy dies with this process
  #   - journal under adir so invoke proof survives teardown
  set +e
  # Unset shared port so this c-thru spawns/owns a fresh proxy and kills it on EXIT.
  env -u CLAUDE_PROXY_PORT \
    C_THRU_KEEP_PROXY=0 \
    C_THRU_BRAND_REUSE_GATEWAY_PROXY=0 \
    CLAUDE_PROXY_JOURNAL=1 \
    CLAUDE_PROXY_JOURNAL_DIR="$jdir" \
    "$CTHRU" -p --dangerously-skip-permissions \
    --settings "$settings_json" \
    <"$adir/prompt.txt" \
    >"$adir/stdout.txt" \
    2>"$adir/stderr.txt"
  ec=$?
  set -e
  echo "$ec" >"$adir/exit_code.txt"
  extract_proxy_from_stderr "$adir" >/dev/null || true
  # brief settle then confirm proxy died
  sleep 0.4
  check_proxy_dead "$adir"
  {
    echo "launch: env C_THRU_KEEP_PROXY=0 CLAUDE_PROXY_JOURNAL=1 c-thru -p <prompt.txt"
    echo "stdin_bytes: $(wc -c <"$adir/prompt.txt" | tr -d ' ')"
    echo "stdout_bytes: $(wc -c <"$adir/stdout.txt" | tr -d ' ')"
    echo "stderr_bytes: $(wc -c <"$adir/stderr.txt" | tr -d ' ')"
    echo "exit_code: $ec"
    echo "C_THRU_KEEP_PROXY=0"
    echo "journal_dir: $jdir"
    echo "proxy_port: $(cat "$adir/proxy_port.txt" 2>/dev/null || true)"
    echo "proxy_pid: $(cat "$adir/proxy_pid.txt" 2>/dev/null || true)"
    echo "proxy_after_exit: $(cat "$adir/proxy_dead.txt" 2>/dev/null || true)"
  } >"$adir/launch.txt"
  { echo "===== LAUNCH ====="; cat "$adir/launch.txt"
    echo "===== STDOUT ====="; cat "$adir/stdout.txt"
    echo "===== STDERR ====="; cat "$adir/stderr.txt"
  } >"$adir/merged.txt"
  return "$ec"
}

run_direct_mode() {
  local agent="$1" adir="$2" pin="$3"
  local base body resp headers code
  # Thinking models (qwen/gemma/…) often burn a small budget on thinking only.
  local max_tok="${DIRECT_MAX_TOKENS:-1024}"
  base="$(proxy_base)" || return 1
  printf '%s\n' "DIRECT model=${pin} max_tokens=${max_tok}" >"$adir/prompt.txt"
  body="$(python3 -c 'import json,sys; print(json.dumps({
    "model": sys.argv[1],
    "max_tokens": int(sys.argv[3]),
    "messages": [{"role":"user","content": sys.argv[2]}],
  }))' "$pin" "$IDENTITY_Q" "$max_tok")"
  printf '%s\n' "$body" >"$adir/request.json"
  set +e
  # --connect-timeout: fail fast if proxy died mid-loop (don't burn TIMEOUT_S)
  resp="$(curl -sS --connect-timeout 3 --max-time "$TIMEOUT_S" \
    -D "$adir/response.headers" \
    -H 'content-type: application/json' \
    -H 'anthropic-version: 2023-06-01' \
    -H 'x-api-key: c-thru-live-probe' \
    -d "$body" \
    "$base/v1/messages" 2>"$adir/stderr.txt")"
  code=$?
  set -e
  printf '%s\n' "$resp" >"$adir/stdout.txt"
  echo "$code" >"$adir/exit_code.txt"
  # extract text (prefer text blocks; never fall back to raw JSON as "leaf")
  python3 - "$adir" <<'PY'
import json,sys
from pathlib import Path
adir=Path(sys.argv[1])
raw=(adir/"stdout.txt").read_text(errors="replace")
text_parts=[]
think_parts=[]
err_msg=""
stop_reason=""
try:
    j=json.loads(raw)
    stop_reason=str(j.get("stop_reason") or "")
    if j.get("type")=="error" or j.get("error"):
        err = j.get("error") if isinstance(j.get("error"), dict) else {}
        err_msg = str(err.get("message") or j.get("error") or raw)[:400]
    for b in j.get("content") or []:
        if not isinstance(b, dict):
            if isinstance(b, str):
                text_parts.append(b)
            continue
        t = b.get("type")
        if t == "text":
            text_parts.append(b.get("text") or "")
        elif t in ("thinking", "reasoning"):
            think_parts.append(b.get("thinking") or b.get("text") or b.get("reasoning") or "")
except Exception as e:
    err_msg = f"parse_error:{e}"
text="\n".join(text_parts).strip()
think="\n".join(think_parts).strip()
if text:
    leaf, cls = text, "leaf_raw"
elif think:
    # Model spent budget on thinking; surface last ~400 chars as weak leaf
    leaf, cls = think[-800:], "thinking_only"
elif err_msg:
    leaf, cls = err_msg, "error"
else:
    leaf, cls = "", "empty"
(adir/"leaf_only.txt").write_text(leaf)
(adir/"leaf_class.txt").write_text(cls)
(adir/"stop_reason.txt").write_text(stop_reason)
if think:
    (adir/"thinking.txt").write_text(think)
# headers
hdr=(adir/"response.headers").read_text(errors="replace") if (adir/"response.headers").exists() else ""
served=""
for line in hdr.splitlines():
    if line.lower().startswith("x-c-thru-served-by:"):
        served=line.split(":",1)[1].strip()
(adir/"served_by_header.txt").write_text(served)
print(f"class={cls} stop={stop_reason} text_len={len(text)} think_len={len(think)}")
print((leaf or "")[:500])
PY
  { echo "===== BODY ====="; cat "$adir/stdout.txt"; echo "===== HEADERS ====="; cat "$adir/response.headers" 2>/dev/null; echo "===== STDERR ====="; cat "$adir/stderr.txt"; } >"$adir/merged.txt"
  return 0
}

classify_stdout() {
  local adir="$1"
  python3 - "$adir" <<'PY'
import re, sys
from pathlib import Path
adir = Path(sys.argv[1])
text = (adir / "stdout.txt").read_text(errors="replace")
if (adir / "leaf_class.txt").exists() and (adir / "leaf_only.txt").exists():
    print((adir / "leaf_class.txt").read_text().strip() or "leaf_raw")
    raise SystemExit(0)
fail = re.search(r"<<<LEAF_FAIL\s+agent=([^\s>]+)\s+reason=([^>]+)>>>", text)
if fail:
    (adir / "leaf_class.txt").write_text("leaf_fail")
    (adir / "leaf_fail.txt").write_text(fail.group(0))
    print("leaf_fail"); raise SystemExit(0)
if "<<<LEAF_BEGIN" in text and "<<<LEAF_END>>>" in text:
    m = re.search(r"<<<LEAF_BEGIN[^>]*>>>\s*(.*?)\s*<<<LEAF_END>>>", text, re.S)
    body = (m.group(1).strip() if m else "")
    (adir / "leaf_only.txt").write_text(body)
    cls = "leaf_raw" if body else "leaf_empty"
    (adir / "leaf_class.txt").write_text(cls)
    print(cls); raise SystemExit(0)
host_signals = [
    r"relayed verbatim", r"answer came back", r"worth flagging",
    r"proxy logs reveal", r"Want me to", r"I can check",
    r"ask-opus", r"ask-fable", r"self-identified as", r"routing metadata",
    r"Here's what it said", r"agent returned",
]
if any(re.search(p, text, re.I) for p in host_signals):
    (adir / "leaf_class.txt").write_text("host_prose")
    print("host_prose"); raise SystemExit(0)
if len(text.strip()) < 40:
    (adir / "leaf_class.txt").write_text("empty")
    print("empty"); raise SystemExit(0)
(adir / "leaf_class.txt").write_text("ambiguous")
print("ambiguous")
PY
}

# ── Warm proxy (MODE=direct only — harness-owned) ───────────────────────────
T0=""
PRIME_PROXY_PID=""
if [[ "$MODE" == "direct" ]]; then
  if ! prime_proxy; then
    log_sum ""
    log_sum "## FATAL: proxy prime failed — aborting (MODE=direct needs a live proxy)"
    log_sum "Artifacts: \`$OUT_ROOT\`"
    exit 3
  fi
  if ! wait_proxy; then
    log_sum "## FATAL: proxy not answering /ping after prime"
    exit 3
  fi
  T0="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  sleep 0.5
  snapshot_status "$OUT_ROOT/stats_warm.json" || true
  printf '%s\n' "$T0" >"$OUT_ROOT/t0.txt"
  log_sum "- t0: \`$T0\`"
fi

PASS=0
FAIL=0
INVOKE_OK_N=0
IDENTITY_OK_N=0
PROXY_DEAD_N=0

for agent in $AGENTS; do
  log_sum ""
  log_sum "## agent: \`$agent\`"
  adir="$OUT_ROOT/$agent"
  mkdir -p "$adir"
  pin="$(expected_pin_for "$agent")"
  fam="$(family_for "$agent")"
  printf '%s\n' "$pin" >"$adir/expected_pin.txt"
  printf '%s\n' "$fam" >"$adir/family.txt"
  log_sum "- expected_pin: \`$pin\`  family: \`$fam\`"
  log_sum "- started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if [[ "$MODE" == "direct" ]]; then
    wait_proxy || true
    snapshot_status "$adir/stats_before.json" || true
  fi

  set +e
  case "$MODE" in
    direct) run_direct_mode "$agent" "$adir" "$pin" ;;
    interactive) run_print_mode "$agent" "$adir" ;;
    *) run_print_mode "$agent" "$adir" ;;
  esac
  run_ec=$?
  set -e

  # Invoke proof
  if [[ "$MODE" == "direct" ]]; then
    wait_proxy || true
    sleep 1.0
    snapshot_status "$adir/stats_after.json" || true
    snapshot_recent "$adir/recent_after.json" || true
    t0_use="${T0:-$(date -u +%Y-%m-%dT%H:%M:%S.000Z)}"
    set +e
    analyze_stats "$adir/stats_before.json" "$adir/stats_after.json" \
      "$adir/recent_after.json" "$t0_use" "$pin" "$agent" "$adir/stats_delta.json" \
      >"$adir/stats_delta.pretty.json"
    set -e
  else
    # print: journal survives proxy death
    set +e
    analyze_journal "$adir/journal" "$pin" "$agent" "$adir/stats_delta.json" \
      >"$adir/stats_delta.pretty.json"
    set -e
  fi

  leaf_class="$(classify_stdout "$adir" || echo classify_error)"
  invoke_ok="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("invoke_ok"))' "$adir/stats_delta.json" 2>/dev/null || echo null)"
  matched="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("matched_recent") or d.get("matched_entries") or d.get("matched_model_delta") or {})' "$adir/stats_delta.json" 2>/dev/null || echo {})"
  printf '%s\n' "$invoke_ok" >"$adir/invoke_ok.txt"

  # Identity score (leaf text)
  leaf_file="$adir/leaf_only.txt"
  [[ -f "$leaf_file" ]] || : >"$leaf_file"
  set +e
  score_identity "$agent" "$fam" "$leaf_file" "$adir/identity.json" >"$adir/identity.pretty.json"
  set -e
  identity_ok="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("identity_ok"))' "$adir/identity.json" 2>/dev/null || echo null)"
  identity_reason="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("reason") or "")' "$adir/identity.json" 2>/dev/null || true)"
  # Host fabrication: LEAF text claims brand without pin proof → not identity_ok
  if [[ "$invoke_ok" != "True" && "$invoke_ok" != "true" ]] && \
     [[ "$identity_ok" == "True" || "$identity_ok" == "true" ]]; then
    if [[ "$leaf_class" == "leaf_raw" ]]; then
      identity_ok="False"
      identity_reason="host_fabrication: brand leaf text without served_by pin proof"
      python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["identity_ok"]=False; d["reason"]=sys.argv[2]; d["host_fabrication"]=True; open(p,"w").write(json.dumps(d,indent=2))' \
        "$adir/identity.json" "$identity_reason"
      cp "$adir/identity.json" "$adir/identity.pretty.json"
    fi
  fi
  printf '%s\n' "$identity_ok" >"$adir/identity_ok.txt"

  proxy_dead="$(cat "$adir/proxy_dead.txt" 2>/dev/null || echo n/a)"
  log_sum "- leaf_class: \`$leaf_class\`"
  log_sum "- invoke_ok: \`$invoke_ok\`"
  log_sum "- identity_ok: \`$identity_ok\` — $identity_reason"
  log_sum "- proxy_after_exit: \`$proxy_dead\`"
  log_sum "- matched: \`$matched\`"

  echo "--- stats_delta ---"
  head -c 1500 "$adir/stats_delta.pretty.json" 2>/dev/null; echo
  echo "--- leaf_only ---"
  head -c 500 "$adir/leaf_only.txt" 2>/dev/null; echo
  echo "--- identity ---"
  cat "$adir/identity.pretty.json" 2>/dev/null | head -c 800; echo

  if [[ "$invoke_ok" == "True" || "$invoke_ok" == "true" ]]; then
    INVOKE_OK_N=$((INVOKE_OK_N + 1))
  fi
  if [[ "$identity_ok" == "True" || "$identity_ok" == "true" ]]; then
    IDENTITY_OK_N=$((IDENTITY_OK_N + 1))
  fi
  if [[ "$proxy_dead" == "dead" || "$MODE" == "direct" ]]; then
    PROXY_DEAD_N=$((PROXY_DEAD_N + 1))
  fi

  verdict="FAIL"
  reason=""
  if [[ "$invoke_ok" != "True" && "$invoke_ok" != "true" ]]; then
    reason="expected pin not proven ($pin)"
  fi
  if [[ "$MODE" == "print" && "$proxy_dead" == "alive" ]]; then
    reason="${reason:+$reason; }proxy still alive after c-thru exit (KEEP_PROXY leak?)"
  fi

  if [[ "$MODE" == "direct" ]]; then
    case "$leaf_class" in
      leaf_raw)
        if [[ -z "$reason" ]]; then
          if [[ "$identity_ok" == "True" || "$identity_ok" == "true" ]]; then verdict="PASS"
          else verdict="PASS_INVOKE"; reason="${reason:+$reason; }identity weak: $identity_reason"
          fi
        else verdict="FAIL"
        fi
        ;;
      thinking_only)
        if [[ -z "$reason" ]]; then verdict="PASS_THINK"; reason="thinking-only body"
        else verdict="FAIL"
        fi
        ;;
      *)
        if [[ -z "$reason" && -s "$adir/leaf_only.txt" ]]; then verdict="PASS_INVOKE"
        else verdict="FAIL"; reason="${reason:-direct class=$leaf_class}"
        fi
        ;;
    esac
  else
    # print path: require invoke + leaf markers + identity for full PASS
    if [[ "$leaf_class" == "leaf_fail" ]]; then
      verdict="FAIL"; reason="${reason:+$reason; }LEAF_FAIL"
    elif [[ "$leaf_class" != "leaf_raw" ]]; then
      if [[ -z "$reason" ]]; then
        verdict="PASS_INVOKE"; reason="class=$leaf_class"
      else
        verdict="FAIL"; reason="$reason; class=$leaf_class"
      fi
    elif [[ -n "$reason" ]]; then
      verdict="FAIL"
    elif [[ "$identity_ok" != "True" && "$identity_ok" != "true" ]]; then
      # invoke proven but brand identity wrong (e.g. leaf claims Claude)
      verdict="FAIL"; reason="identity: $identity_reason"
    else
      verdict="PASS"
    fi
  fi

  if [[ "$verdict" == PASS* ]]; then
    log_sum "- result: **$verdict**${reason:+ — $reason}"
    PASS=$((PASS + 1))
  else
    log_sum "- result: **FAIL** — $reason"
    FAIL=$((FAIL + 1))
  fi
done

# teardown harness-owned direct proxy only
if [[ "$MODE" == "direct" && -n "${CLAUDE_PROXY_PORT:-}" ]]; then
  if curl -sf --max-time 1 "http://127.0.0.1:${CLAUDE_PROXY_PORT}/ping" >/dev/null 2>&1; then
    pid="$(curl -sf --max-time 1 "http://127.0.0.1:${CLAUDE_PROXY_PORT}/ping" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("pid") or "")' 2>/dev/null || true)"
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
    log_sum "- tore down harness proxy pid ${pid:-?} on :$CLAUDE_PROXY_PORT"
  fi
fi

log_sum ""
log_sum "## totals"
log_sum "- pass_rows: $PASS  fail_rows: $FAIL  invoke_ok: $INVOKE_OK_N  identity_ok: $IDENTITY_OK_N  proxy_dead_ok: $PROXY_DEAD_N"
log_sum "- finished: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log_sum ""
log_sum "Artifacts: \`$OUT_ROOT\`"

echo ""
echo "Artifacts: $OUT_ROOT"
echo "Summary: $SUMMARY"

# Ship gate: invoke_ok on deepseek,qwen,kimi,glm when present
GATE_FAIL=0
for g in deepseek qwen kimi glm; do
  echo " $AGENTS " | grep -q " $g " || continue
  okf="$OUT_ROOT/$g/invoke_ok.txt"
  if [[ ! -f "$okf" ]] || ! grep -qi true "$okf"; then
    echo "SHIP_GATE miss: $g invoke_ok != true"
    GATE_FAIL=1
  else
    echo "SHIP_GATE ok: $g invoke"
  fi
  # print mode also requires proxy dead + identity_ok for full ship
  if [[ "$MODE" == "print" ]]; then
    if [[ "$(cat "$OUT_ROOT/$g/proxy_dead.txt" 2>/dev/null)" != "dead" ]]; then
      echo "SHIP_GATE miss: $g proxy not dead after c-thru"
      GATE_FAIL=1
    else
      echo "SHIP_GATE ok: $g proxy_dead"
    fi
    if [[ "$(cat "$OUT_ROOT/$g/identity_ok.txt" 2>/dev/null)" != "True" ]] && \
       [[ "$(cat "$OUT_ROOT/$g/identity_ok.txt" 2>/dev/null)" != "true" ]]; then
      echo "SHIP_GATE miss: $g identity_ok"
      GATE_FAIL=1
    else
      echo "SHIP_GATE ok: $g identity"
    fi
  fi
done

# Live aggregate protocol (exactly one outcome line for run_live_suite)
SUITE_ID="brand-identity-${MODE}"
STATUS="passed"
REASON="ship_ok_invoke=${INVOKE_OK_N}_identity=${IDENTITY_OK_N}_pass=${PASS}"
if [[ "$GATE_FAIL" -ne 0 ]]; then
  STATUS="failed"
  REASON="ship_gate_failed_fail_rows=${FAIL}"
elif [[ "$INVOKE_OK_N" -eq 0 && "$PASS" -eq 0 ]]; then
  STATUS="blocked"
  REASON="no_agents_invoked_check_ollama_or_keys"
fi
# reason must be delimiter-safe (no | or newlines)
REASON="$(printf '%s' "$REASON" | tr '|\n\r' '___')"
echo "C_THRU_LIVE_OUTCOME|provider=agent|suite=${SUITE_ID}|status=${STATUS}|reason=${REASON}"

if [[ "$GATE_FAIL" -ne 0 ]]; then
  exit 1
fi
if [[ "$STATUS" == "blocked" ]]; then
  exit 2
fi
[[ "$FAIL" -eq 0 || "$INVOKE_OK_N" -gt 0 ]]
