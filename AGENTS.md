# harness

One marketplace, `harness`, with several themed plugins under `plugins/`. Each plugin ships to both Claude Code and Codex from a single directory.

## Plugins

| Plugin | What belongs in it |
| --- | --- |
| `common` | Skills, MCP servers and hooks useful in any project |
| `frontend` | UI, React, web frontend |
| `backend` | Servers, APIs, databases |
| `rust` | Rust |
| `kotlin` | Kotlin |

## Layout

| Path | Read by | Purpose |
| --- | --- | --- |
| `.claude-plugin/marketplace.json` | Claude | Marketplace listing every plugin |
| `.agents/plugins/marketplace.json` | Codex | Marketplace listing every plugin |
| `plugins/<plugin>/.claude-plugin/plugin.json` | Claude | Manifest; components are auto-discovered |
| `plugins/<plugin>/.codex-plugin/plugin.json` | Codex | Manifest; points at the shared components |
| `plugins/<plugin>/skills/<name>/SKILL.md` | both | Skills, internal and external, flat |
| `plugins/<plugin>/.mcp.json` | both | MCP servers |
| `plugins/<plugin>/hooks/hooks.json` | both | Hooks; scripts go in `plugins/<plugin>/hooks/scripts/` |
| `external-skills.json` | sync script | External skills grouped by plugin: `{"<plugin>": [{name, repo, ref, path, exclude?}]}`. `path` may be `"."` for a skill at the repo root; `exclude` lists basename globs to skip |
| `external-skills.lock.json` | sync script | Resolved plugin and commit per external skill (generated) |

## Rules

- Put each skill, MCP server and hook in the plugin it belongs to. If it doesn't fit any themed plugin, use `common`.
- Skill names are unique across all plugins.
- **Internal skill**: create `plugins/<plugin>/skills/<name>/SKILL.md` by hand.
- **External skill**: add an entry to the plugin's list in `external-skills.json` (add the plugin key if it's missing), run `scripts/sync-external-skills.py`, then commit the vendored files and the lock file. Never edit a vendored skill in place, because the next sync overwrites it. To change one, fork it into an internal skill under a new name.
- To move an external skill to another plugin, move its entry to that plugin's list and re-sync. The script deletes the old copy.
- A skill is external if and only if its name is in `external-skills.lock.json`.
- **New plugin**: copy an existing plugin's skeleton (both manifests, `.mcp.json`, `hooks/hooks.json`, `skills/.gitkeep`), rename it in both manifests, and add it to both marketplace files.
- Within one plugin, keep `version` identical in its two `plugin.json` files. Bump it in every plugin whose content changed and that you want users to receive. Codex caches installed plugins by version.
- Don't add `skills`, `hooks` or `mcpServers` keys to a Claude manifest. The default locations are already loaded, and declaring them again loads them twice.
- In hook commands, reference files as `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/...`. Claude sets this variable, and Codex sets it too for compatibility.
- Use only hook events that exist in both tools, or make the script tolerate a missing event. Codex runs plugin hooks only for manually installed plugins, and only after the user trusts them.
- MCP: Claude expands `${CLAUDE_PLUGIN_ROOT}` in `.mcp.json`, but Codex documents no such variable. Prefer remote servers or package runners (`npx`, `uvx`) over scripts bundled in the plugin. If a server needs a bundled script, test it in Codex.

## Validate

```sh
claude plugin validate .
for p in plugins/*/; do claude plugin validate "$p"; done
CODEX_HOME=$(mktemp -d) sh -c 'codex plugin marketplace add "$PWD" && for p in plugins/*/; do codex plugin add "$(basename "$p")@harness"; done'
```
