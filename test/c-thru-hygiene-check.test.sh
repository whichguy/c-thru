#!/usr/bin/env bash
# Regression test for tools/c-thru-hygiene-check.sh — was entirely uncovered.
# Builds a throwaway git repo (own origin/main ref, no real remote needed)
# and drives each finding class against it.
#
# Run: bash test/c-thru-hygiene-check.test.sh
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=test/helpers.sh
source "$REPO_DIR/test/helpers.sh"

TOOL="$REPO_DIR/tools/c-thru-hygiene-check.sh"
BASE=$(mktemp -d "${TMPDIR:-/tmp}/c-thru-hygiene-test.XXXXXX")
trap 'rm -rf "$BASE"' EXIT

# new_repo: a fresh git repo at $BASE/<name> with one commit on main and an
# origin/main ref pointing at it (a real remote isn't needed — check #5/#7
# only read the ref, never fetch).
new_repo() {
    local dir="$BASE/$1"
    mkdir -p "$dir"
    git -C "$dir" init -q -b main
    git -C "$dir" config user.email test@example.com
    git -C "$dir" config user.name "Test"
    echo "root" > "$dir/README.md"
    git -C "$dir" add README.md
    git -C "$dir" commit -q -m "initial"
    git -C "$dir" remote add origin "$dir/.git"
    git -C "$dir" update-ref refs/remotes/origin/main main
    printf '%s' "$dir"
}

# add_worktree <repo> <name> <branch> <age_days> [merge_to_main]
# Creates a worktree with a commit backdated $age_days ago. When merge_to_main
# is "merge", fast-forwards origin/main's ref to include that commit too
# (simulating an already-landed branch).
add_worktree() {
    local repo="$1" name="$2" branch="$3" age_days="$4" merge="${5:-}"
    local wt="$repo/.worktrees/$name"
    git -C "$repo" worktree add -q -b "$branch" "$wt" main >/dev/null 2>&1
    local ts
    ts="$(date -u -v-"${age_days}"d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
        || date -u -d "${age_days} days ago" +%Y-%m-%dT%H:%M:%SZ)"
    echo "change-$name" > "$wt/file-$name.txt"
    git -C "$wt" add "file-$name.txt"
    GIT_AUTHOR_DATE="$ts" GIT_COMMITTER_DATE="$ts" \
        git -C "$wt" commit -q -m "work on $name"
    if [ "$merge" = "merge" ]; then
        git -C "$repo" update-ref refs/remotes/origin/main "$branch"
    fi
    printf '%s' "$wt"
}

run_tool() {
    local dir="$1"
    STDOUT="$(bash "$TOOL" "$dir" 2>&1)"
    STATUS=$?
}

echo "1. clean repo — exit 0, no findings"
{
    repo=$(new_repo clean)
    run_tool "$repo"
    check "clean repo exits 0" "0" "$STATUS"
    check "clean repo reports clean" "yes" "$(echo "$STDOUT" | grep -q "clean (0 findings)" && echo yes || echo no)"
}

echo "2. untracked .bak file — flagged as stale temp file"
{
    repo=$(new_repo bakfile)
    echo "junk" > "$repo/leftover.bak"
    run_tool "$repo"
    check "bak file: exits 1" "1" "$STATUS"
    check "bak file: flagged" "yes" "$(echo "$STDOUT" | grep -q "stale temp file — leftover.bak" && echo yes || echo no)"
}

echo "3. old unmerged worktree — flagged stale, merged=no"
{
    repo=$(new_repo old_unmerged)
    add_worktree "$repo" wt1 feature-old 30 >/dev/null
    run_tool "$repo"
    check "old unmerged: exits 1" "1" "$STATUS"
    check "old unmerged: flagged" "yes" "$(echo "$STDOUT" | grep -q "stale worktree.*branch=feature-old.*merged_into_origin_main=no" && echo yes || echo no)"
}

echo "4. recent worktree — NOT flagged (below age threshold)"
{
    repo=$(new_repo recent)
    add_worktree "$repo" wt1 feature-fresh 1 >/dev/null
    run_tool "$repo"
    check "recent worktree: not flagged" "yes" "$(echo "$STDOUT" | grep -q "feature-fresh" && echo no || echo yes)"
}

echo "5. old MERGED worktree with dirty file — reports merged=yes and dirty count"
{
    repo=$(new_repo old_merged)
    wt=$(add_worktree "$repo" wt1 feature-landed 20 merge)
    echo "uncommitted" > "$wt/scratch.txt"
    run_tool "$repo"
    check "old merged: exits 1" "1" "$STATUS"
    check "old merged: reports merged=yes" "yes" "$(echo "$STDOUT" | grep -q "branch=feature-landed.*merged_into_origin_main=yes" && echo yes || echo no)"
    check "old merged: reports 1 dirty file" "yes" "$(echo "$STDOUT" | grep -q "1 dirty file(s)" && echo yes || echo no)"
}

echo ""
echo "$((PASS+FAIL)) tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
