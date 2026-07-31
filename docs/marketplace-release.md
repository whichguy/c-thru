# Marketplace release checklist (private catalog)

c-thru is distributed from **your** marketplace(s), not Anthropic’s public
plugin directories.

## Canonical Shape C story

1. **Install:** private marketplace → `c-thru@c-thru` (or one family identity).  
2. **Bootstrap:** run **`/c-thru:install-cli`** (blocking; not SessionStart — hook
   timeout is too short for `git clone`). That runs `c-thru-plugin-bootstrap.sh` →
   durable pin clone `~/.claude/c-thru-src` + symlinks into `~/.claude/tools` +
   stamp `.c-thru-cli-installed` (fields: `version`, `source_root`, `source_ref`,
   `source_sha`). Loopback `ANTHROPIC_BASE_URL` residue is scrubbed on stamp.  
3. **Runtime:** always **`cthru`** / `c-thru` (launch-time inject + fleet). Plugin
   lifecycle hooks set `C_THRU_PLUGIN_HOOK=1` and **no-op** under `cthru` / after
   stamp (avoid double-fire).  
4. **Dev path:** clone + `bash install.sh` = same core as install-cli.  
5. **Remove:** `pkill` proxy → `uninstall.sh` (stamp + tools; optional
   `--purge-src` for `c-thru-src`) → then `/plugin uninstall`.  
6. **One identity:** never both `@c-thru` and `@claude-craft`.

| Catalog | Install id | Role |
|---|---|---|
| **whichguy/c-thru** (this repo) | `c-thru@c-thru` | Primary private/product marketplace |
| **whichguy/claude-craft** | `c-thru@claude-craft` | Family discovery; **git-subdir** → this repo `plugins/c-thru` |

Product code lives only here. Family catalog **points** at this repo; do not vendor a copy.

## 1. Package integrity

```sh
tools/sync-plugin-bundle.sh --check
claude plugin validate --strict plugins/c-thru
claude plugin validate --strict .
node -e 'const p=require("./plugins/c-thru/.claude-plugin/plugin.json");const m=require("./.claude-plugin/marketplace.json");if(p.version!==m.plugins[0].version)process.exit(1)'
```

## 2. Version bump

Bump `plugins/c-thru/.claude-plugin/plugin.json` **and** matching
`.claude-plugin/marketplace.json` on every user-visible plugin change.
If the family catalog mirrors a version string, bump claude-craft’s entry too.

**Pin fail-closed:** Shape C bootstrap clones `v{plugin.version}` into
`~/.claude/c-thru-src`. **Always `git tag -a vX.Y.Z` and push the tag** before
telling users to run `/c-thru:install-cli`. Without the tag, install fails
unless `C_THRU_ALLOW_UNPINNED=1` (which stamps the actual default-branch SHA).

## 3. Smoke from published bytes

```sh
git archive HEAD | tar -x -C /tmp/c-thru-release
export CLAUDE_CONFIG_DIR="$(mktemp -d)"
claude plugin marketplace add /tmp/c-thru-release
claude plugin install c-thru@c-thru
```

Plugin-only status must not require `~/.claude/tools/c-thru`.
Use `/c-thru:c-thru-status` (namespaced).

## 4. Tag + push (this repo)

```sh
git tag -a vX.Y.Z -m "plugin package vX.Y.Z"
git push origin main vX.Y.Z
```

## 5. Family catalog (optional)

In `claude-craft` `.claude-plugin/marketplace.json`, keep:

```json
{
  "name": "c-thru",
  "version": "X.Y.Z",
  "source": {
    "source": "git-subdir",
    "url": "https://github.com/whichguy/c-thru.git",
    "path": "plugins/c-thru",
    "ref": "main"
  }
}
```

Never copy `plugins/c-thru` into claude-craft.

## 6. Team auto-prompt (private marketplaces)

Projects can prompt collaborators to add your catalog via
`.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "c-thru": {
      "source": {
        "source": "github",
        "repo": "whichguy/c-thru"
      }
    }
  }
}
```

For a **private** GitHub repo, users need git credentials that can clone it
(SSH agent or HTTPS helper). See Claude Code docs on private marketplaces.

## 7. Install (end users)

```text
/plugin marketplace add whichguy/c-thru
/plugin install c-thru@c-thru
```

Pick **one** identity (`c-thru@c-thru` **or** `c-thru@claude-craft`), never both.
Prefer **plugin or CLI inject**, not both (hooks double-fire).

See [SECURITY.md](../SECURITY.md) for uninstall / loopback `ANTHROPIC_BASE_URL`.
