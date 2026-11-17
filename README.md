# harness

Маркетплейс плагинов для Claude Code и Codex. Каждый плагин содержит скиллы (внутренние и внешние), MCP-серверы и хуки для своей области.

| Плагин | Для чего |
| --- | --- |
| `common` | Общее, для любого проекта |
| `frontend` | UI, React, веб |
| `backend` | Серверы, API, базы данных |
| `rust` | Rust |
| `kotlin` | Kotlin |

## Установка

Ставьте только нужные плагины.

**Claude Code**

```sh
claude plugin marketplace add <owner>/harness   # или локальный путь к репозиторию
claude plugin install common@harness
claude plugin install frontend@harness
```

**Codex**

```sh
codex plugin marketplace add <owner>/harness    # или локальный путь к репозиторию
codex plugin add common@harness
codex plugin add frontend@harness
```

## Скиллы

- **Внутренние** пишутся прямо в `plugins/<plugin>/skills/<name>/SKILL.md`.
- **Внешние** описываются в `external-skills.json`, сгруппированные по плагинам, и копируются в нужный плагин скриптом:

```json
{
  "common": [
    {
      "name": "skill-creator",
      "repo": "https://github.com/anthropics/skills.git",
      "ref": "main",
      "path": "skills/skill-creator"
    }
  ]
}
```

```sh
scripts/sync-external-skills.py            # синхронизировать все
scripts/sync-external-skills.py <name>     # синхронизировать один
```

Скрипт фиксирует в `external-skills.lock.json` плагин и коммит каждого внешнего скилла. Скиллы, убранные из конфига, он удаляет. Если запись скилла перенесли в список другого плагина, скрипт переносит скилл туда. Внутренние скиллы он не трогает. Имена скиллов должны быть уникальны во всех плагинах.

Соглашения по структуре, версиям, хукам и MCP описаны в [AGENTS.md](AGENTS.md).
