#!/usr/bin/env python3
"""Vendor external skills into plugins/<plugin>/skills/.

Reads external-skills.json, an object mapping each plugin name to a list of
skills ({name, repo, ref, path, exclude?}). `path` may be "." for a skill at
the repo root; `exclude` is an optional list of glob patterns matched against
file and directory basenames (".git" is always excluded). Fetches each skill from its git repo at the
given ref, copies it to plugins/<plugin>/skills/<name>/ and records the
resolved commit and target plugin in external-skills.lock.json. Skill names
are unique across all plugins. Skills removed from external-skills.json are deleted, and
skills whose plugin changed are moved. Directories not listed in the lock file
are internal skills and are never touched.

Usage: scripts/sync-external-skills.py [name ...]
"""

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "external-skills.json"
LOCK = ROOT / "external-skills.lock.json"
PLUGINS_DIR = ROOT / "plugins"


def skill_dir(plugin: str, name: str) -> Path:
    return PLUGINS_DIR / plugin / "skills" / name


def git(*args: str, cwd: Path) -> str:
    result = subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    )
    return result.stdout.strip()


def fetch(entry: dict, workdir: Path) -> tuple[Path, str]:
    """Sparse-fetch one path from a repo at a ref (branch, tag or commit)."""
    repo_dir = workdir / entry["name"]
    repo_dir.mkdir()
    git("init", "-q", cwd=repo_dir)
    git("remote", "add", "origin", entry["repo"], cwd=repo_dir)
    if entry["path"] not in ("", "."):
        git("sparse-checkout", "set", "--no-cone", entry["path"], cwd=repo_dir)
    git("fetch", "-q", "--depth", "1", "--filter=blob:none", "origin",
        entry.get("ref", "HEAD"), cwd=repo_dir)
    git("checkout", "-q", "FETCH_HEAD", cwd=repo_dir)
    commit = git("rev-parse", "HEAD", cwd=repo_dir)
    source = repo_dir / entry["path"]
    if not (source / "SKILL.md").is_file():
        raise SystemExit(f"{entry['name']}: no SKILL.md at {entry['path']} in {entry['repo']}")
    return source, commit


def load_config() -> list[dict]:
    """Flatten {"<plugin>": [skill, ...]} into skill entries tagged with their plugin."""
    config = json.loads(CONFIG.read_text())
    if not isinstance(config, dict):
        raise SystemExit("external-skills.json: expected an object keyed by plugin name")
    entries = []
    for plugin, skills in config.items():
        if not (PLUGINS_DIR / plugin / ".claude-plugin" / "plugin.json").is_file():
            raise SystemExit(f"external-skills.json: unknown plugin {plugin!r} (no plugins/{plugin}/)")
        if not isinstance(skills, list):
            raise SystemExit(f"external-skills.json: {plugin!r} must be a list of skills")
        entries.extend({**skill, "plugin": plugin} for skill in skills)
    names = [e["name"] for e in entries]
    duplicates = sorted({n for n in names if names.count(n) > 1})
    if duplicates:
        raise SystemExit(f"external-skills.json: duplicate skill names: {', '.join(duplicates)}")
    return entries


def main() -> None:
    entries = load_config()
    lock = json.loads(LOCK.read_text()) if LOCK.exists() else {}
    only = set(sys.argv[1:])

    unknown = only - {e["name"] for e in entries}
    if unknown:
        raise SystemExit(f"not in external-skills.json: {', '.join(sorted(unknown))}")

    # Prune skills that were external but are no longer configured.
    if not only:
        for name in sorted(set(lock) - {e["name"] for e in entries}):
            shutil.rmtree(skill_dir(lock[name]["plugin"], name), ignore_errors=True)
            del lock[name]
            print(f"removed {name}")

    with tempfile.TemporaryDirectory() as tmp:
        for entry in entries:
            name, plugin = entry["name"], entry["plugin"]
            if only and name not in only:
                continue
            if name not in lock:
                clash = sorted(PLUGINS_DIR.glob(f"*/skills/{name}"))
                if clash:
                    rel = clash[0].relative_to(ROOT)
                    raise SystemExit(f"{name}: an internal skill with this name already exists at {rel}")
            source, commit = fetch(entry, Path(tmp))
            old_plugin = lock.get(name, {}).get("plugin")
            if old_plugin and old_plugin != plugin:
                shutil.rmtree(skill_dir(old_plugin, name), ignore_errors=True)
                print(f"moved {name}: {old_plugin} -> {plugin}")
            target = skill_dir(plugin, name)
            shutil.rmtree(target, ignore_errors=True)
            exclude = entry.get("exclude", [])
            shutil.copytree(source, target, ignore=shutil.ignore_patterns(".git", *exclude))
            lock[name] = {
                "plugin": plugin,
                "repo": entry["repo"],
                "path": entry["path"],
                "ref": entry.get("ref", "HEAD"),
                "commit": commit,
            }
            if exclude:
                lock[name]["exclude"] = exclude
            print(f"synced {name} -> {plugin} @ {commit[:12]}")

    LOCK.write_text(json.dumps(dict(sorted(lock.items())), indent=2) + "\n")


if __name__ == "__main__":
    main()
