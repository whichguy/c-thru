#!/usr/bin/env bash
# Hermetic: cthru_chmod_tree_bins preserves 100644 libraries and restores
# tracked 100755 Node CLIs (advisors cycle-2 M2 / HEAD 2cda96a evidence-identity).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT/tools/c-thru-install-core.sh"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/c-thru-chmod-modes.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

cd "$TMP"
git init -q
git config user.email 'test@example.com'
git config user.name 'test'
mkdir -p tools

# Library: tracked 100644, not a CLI
printf '%s\n' 'module.exports = {};' > tools/lib-only.js
# CLI: tracked 100755 with shebang
printf '%s\n' '#!/usr/bin/env node' 'console.log("ok");' > tools/cli-entry.js
chmod 644 tools/lib-only.js
chmod 755 tools/cli-entry.js

git add tools/lib-only.js tools/cli-entry.js
git update-index --chmod=-x tools/lib-only.js
git update-index --chmod=+x tools/cli-entry.js
git commit -qm 'fixture modes'

# Simulate accidental strip of CLI bit and accidental +x on library
chmod a-x tools/cli-entry.js
chmod a+x tools/lib-only.js
[[ -x tools/lib-only.js ]] || { echo "FAIL  precond: lib should be executable before fix"; exit 1; }
[[ ! -x tools/cli-entry.js ]] || { echo "FAIL  precond: cli should be non-exec before fix"; exit 1; }

REPO_DIR="$TMP" CLAUDE_DIR="$TMP/claude" cthru_chmod_tree_bins "$TMP"

fail=0
if [[ -x tools/lib-only.js ]]; then
  echo "FAIL  tracked 100644 library still executable after cthru_chmod_tree_bins"
  fail=1
else
  echo "PASS  tracked 100644 library stripped of accidental +x"
fi
if [[ -x tools/cli-entry.js ]]; then
  echo "PASS  tracked 100755 CLI restored executable"
else
  echo "FAIL  tracked 100755 CLI not restored"
  fail=1
fi

# Bundle hook mode pin: plan-visibility must be executable in plugins mirror
if [[ -x "$ROOT/plugins/c-thru/hooks/c-thru-plan-visibility-hook.sh" ]]; then
  echo "PASS  plugins plan-visibility hook is executable"
else
  echo "FAIL  plugins plan-visibility hook not executable"
  fail=1
fi

# Git-less install: shebang Node CLIs still get +x; non-shebang libs untouched
GITLESS=$(mktemp -d "${TMPDIR:-/tmp}/c-thru-chmod-gitless.XXXXXX")
mkdir -p "$GITLESS/tools"
printf '%s\n' '#!/usr/bin/env node' 'console.log(1);' > "$GITLESS/tools/shebang-cli.js"
printf '%s\n' 'module.exports = {};' > "$GITLESS/tools/lib-noshebang.js"
# known launchers present so unconditional +x path is exercised
: > "$GITLESS/tools/c-thru"
: > "$GITLESS/tools/claude-proxy"
chmod 644 "$GITLESS/tools/shebang-cli.js" "$GITLESS/tools/lib-noshebang.js" \
  "$GITLESS/tools/c-thru" "$GITLESS/tools/claude-proxy"
REPO_DIR="$GITLESS" CLAUDE_DIR="$GITLESS/claude" cthru_chmod_tree_bins "$GITLESS"
if [[ -x "$GITLESS/tools/shebang-cli.js" ]]; then
  echo "PASS  git-less: shebang Node CLI promoted to +x"
else
  echo "FAIL  git-less: shebang Node CLI not executable"
  fail=1
fi
if [[ ! -x "$GITLESS/tools/lib-noshebang.js" ]]; then
  echo "PASS  git-less: non-shebang library left non-executable"
else
  echo "FAIL  git-less: non-shebang library wrongly +x"
  fail=1
fi
if [[ -x "$GITLESS/tools/c-thru" && -x "$GITLESS/tools/claude-proxy" ]]; then
  echo "PASS  git-less: known launchers +x"
else
  echo "FAIL  git-less: known launchers not executable"
  fail=1
fi
rm -rf "$GITLESS"

if [[ $fail -ne 0 ]]; then
  echo "install-core-chmod-modes: $fail failure(s)"
  exit 1
fi
echo "install-core-chmod-modes: ok"
exit 0
