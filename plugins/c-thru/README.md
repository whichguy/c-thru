# c-thru — Claude Code plugin (Shape C)

**Private marketplace package.** Discovers c-thru and **bootstraps the CLI**
(`cthru` / `c-thru`). Full routing + agent fleet require launching with **`cthru`**,
not plain `claude`.

Product source: [whichguy/c-thru](https://github.com/whichguy/c-thru). Family
catalog [claude-craft](https://github.com/whichguy/claude-craft) points here via
git-subdir — do not install both identities.

## Install (pick one identity)

```
/plugin marketplace add whichguy/c-thru
/plugin install c-thru@c-thru
```

Or: `whichguy/claude-craft` → `c-thru@claude-craft`.

### What happens next

1. First SessionStart runs `tools/c-thru-plugin-bootstrap.sh`.
2. Clones/updates `~/.claude/c-thru-src` (full tree) and symlinks tools into
   `~/.claude/tools` (same core as `bash install.sh`).
3. Writes stamp `~/.claude/.c-thru-cli-installed`.
4. **You run `cthru`** for day-to-day work.

```bash
cthru
cthru --mode best-cloud-oss
```

Verify (namespaced plugin command uses proxy HTTP; optional after CLI works):

```
/c-thru:c-thru-status
```

## What this plugin is for

| Surface | Role |
|---|---|
| Bootstrap | Install CLI tools via symlinks |
| `/c-thru:c-thru-status` | Proxy status via HTTP + plugin-root tools |
| Hooks | Bootstrap + optional lite mode only (`C_THRU_PLUGIN_LITE=1`) |

Full multi-agent `/cplan` waves need the CLI fleet (`cthru` injects `--agents`).

## Developer path

```sh
git clone https://github.com/whichguy/c-thru.git
cd c-thru
bash install.sh
cthru
```

## Removing c-thru

1. `pkill -f claude-proxy`
2. `bash uninstall.sh` (from a checkout) or manual loopback `ANTHROPIC_BASE_URL` scrub
3. `/plugin uninstall c-thru@c-thru`

See [SECURITY.md](../../SECURITY.md).

## Bundle maintenance

```sh
tools/sync-plugin-bundle.sh
tools/sync-plugin-bundle.sh --check
```
