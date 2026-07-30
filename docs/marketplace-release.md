# Marketplace release checklist

Short checklist before tagging a plugin package for community submission.

## 1. Package integrity

```sh
tools/sync-plugin-bundle.sh --check
claude plugin validate --strict plugins/c-thru
claude plugin validate --strict .
node -e 'const p=require("./plugins/c-thru/.claude-plugin/plugin.json");const m=require("./.claude-plugin/marketplace.json");if(p.version!==m.plugins[0].version)process.exit(1)'
```

## 2. Version bump

Bump `plugins/c-thru/.claude-plugin/plugin.json` **and** matching
`.claude-plugin/marketplace.json` entry on every user-visible plugin change.

## 3. Smoke from published bytes

```sh
# clean tree only — not a dirty worktree
git archive HEAD | tar -x -C /tmp/c-thru-release
# install marketplace from that path in an isolated CLAUDE_CONFIG_DIR
```

Plugin-only status must not require `~/.claude/tools/c-thru`.

## 4. Tag + push

```sh
git tag -a vX.Y.Z -m "plugin package vX.Y.Z"
git push origin main vX.Y.Z
```

## 5. Community catalog

Submit/update via [Console](https://platform.claude.com/plugins/submit) or
[clau.de/plugin-directory-submission](https://clau.de/plugin-directory-submission).

Source path: `plugins/c-thru` on `https://github.com/whichguy/c-thru.git`.

## 6. Docs after listing

Flip README Quick start primary install to `c-thru@claude-community` when the
catalog lists the plugin.

See [SECURITY.md](../SECURITY.md) for uninstall / loopback base URL notes.
