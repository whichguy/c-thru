#!/usr/bin/env bash
# c-thru-hygiene-check — surface working-tree hazards before starting new work.
#
# Findings printed to stdout, one per line. Exit code:
#   0 = clean
#   1 = warnings (review before continuing)
#   2 = critical issues (cross-user paths, secrets-shaped strings, etc.)
#
# Run from repo root, or pass repo dir as $1. Read-only — never mutates anything.

set -euo pipefail

REPO_DIR="${1:-$(pwd)}"
cd "$REPO_DIR"

if [[ ! -d .git ]]; then
  echo "hygiene: not a git repo (no .git dir found at $REPO_DIR)" >&2
  exit 2
fi

WARN=0
CRIT=0
FINDINGS=()

note_warn() { FINDINGS+=("WARN  $1"); WARN=$((WARN+1)); }
note_crit() { FINDINGS+=("CRIT  $1"); CRIT=$((CRIT+1)); }

# 1. Cross-user home paths in tracked files. /Users/<other> outside this repo's
#    user. Catches the .gemini/settings.json class of leak.
THIS_HOME="${HOME:-/Users/$(whoami)}"
THIS_USER="$(basename "$THIS_HOME")"
# Search tracked files only (no node_modules, .git, etc.).
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  note_crit "cross-user path in tracked file — $line"
done < <(
  git grep -nE '/Users/[a-zA-Z0-9_-]+' -- ':(exclude)*.lock' ':(exclude)*.log' 2>/dev/null \
    | grep -v -E "/Users/${THIS_USER}([/:]|$)" \
    | head -20
)

# 2. Broken symlinks among tracked files. ln -s without -e check.
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if [[ -L "$f" && ! -e "$f" ]]; then
    note_crit "broken symlink (tracked) — $f"
  fi
done < <(git ls-files 2>/dev/null)

# 3. Untracked dirs that look like accumulated experiment artifacts.
#    Heuristic: top-level untracked dirs with hidden-prefix names containing
#    'spike', 'results', 'tmp', 'scratch', 'experiment', or .DS_Store droppings.
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  case "$f" in
    *.DS_Store|*~|*.bak)
      note_warn "stale temp file — $f" ;;
    *spike*|*scratch*|*experiment*|*results*|*.tmp/|*tmp.*/)
      note_warn "untracked artifact-shaped path — $f" ;;
  esac
done < <(git status --porcelain 2>/dev/null | awk '/^\?\?/ {print $2}')

# 4. Files that look like secrets — keys, tokens, credentials. Pattern-match
#    common shapes; cheap and won't flag legitimate config docs.
while IFS= read -r m; do
  [[ -z "$m" ]] && continue
  # Skip our own deprecation list and headers reference (the words "AKIA"
  # and "ghp_" don't appear there but be defensive).
  case "$m" in
    *docs/headers.md*|*GEMINI_DEPRECATED_DEFAULTS*) continue ;;
  esac
  note_crit "secret-shaped string in tracked file — $m"
done < <(
  git grep -nE '(AKIA[A-Z0-9]{16}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{32,}|AIza[0-9A-Za-z_-]{35})' 2>/dev/null \
    | head -10
)

# 5. Local commits ahead of origin/main — hint the user to push before
#    spawning isolated worktree agents (which branch from origin/main HEAD,
#    not local HEAD — see CLAUDE.md "Bash sharp edges for contributors").
if git remote get-url origin >/dev/null 2>&1; then
  AHEAD="$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)"
  if [[ "$AHEAD" -gt 0 ]]; then
    note_warn "$AHEAD local commit(s) ahead of origin/main — push before isolated-worktree agents"
  fi
fi

# 6. Modified-but-uncommitted file count above threshold (suggests stale WIP).
DIRTY="$(git status --porcelain 2>/dev/null | grep -cE '^[ MARC]M' || true)"
if [[ "${DIRTY:-0}" -gt 10 ]]; then
  note_warn "$DIRTY modified files in working tree — consider committing/stashing before new task"
fi

# Output
if [[ ${#FINDINGS[@]} -eq 0 ]]; then
  echo "hygiene: clean (0 findings) at $REPO_DIR"
  exit 0
fi

echo "hygiene: $CRIT critical / $WARN warning finding(s) at $REPO_DIR"
for f in "${FINDINGS[@]}"; do echo "  $f"; done

if [[ $CRIT -gt 0 ]]; then exit 2; fi
exit 1
