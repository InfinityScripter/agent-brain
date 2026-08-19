#!/usr/bin/env python3
"""Agent Brain registry, context router, validator, and view generator.

The program only reads external agent configuration and skill directories. Its
engine is location-independent; user manifests and generated state live in a
separate registry directory selected by ``--registry`` or
``AGENT_BRAIN_HOME``.
"""

from __future__ import annotations

import argparse
import hashlib
import http.server
import json
import os
import re
import shutil
import socketserver
import sys
import tempfile
import threading
import webbrowser
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


ENGINE_DIR = Path(__file__).resolve().parent
DEFAULTS_DIR = ENGINE_DIR / "defaults"
DEFAULT_REGISTRY_DIR = (
    ENGINE_DIR
    if (ENGINE_DIR / "config" / "brain.json").is_file()
    else Path.home() / ".agent-brain"
)
REGISTRY_DIR = Path(
    os.environ.get("AGENT_BRAIN_HOME", str(DEFAULT_REGISTRY_DIR))
).expanduser()
CONFIG_PATH = REGISTRY_DIR / "config" / "brain.json"
DATA_PATH = REGISTRY_DIR / "data" / "inventory.json"
STATE_PATH = REGISTRY_DIR / "state" / "active-context.json"
TEMPLATE_PATH = ENGINE_DIR / "web" / "index.template.html"
VIEW_PATH = REGISTRY_DIR / "views" / "index.html"
CANVAS_PATH = REGISTRY_DIR / "views" / "agent-brain.canvas"
AUDIT_PATH = REGISTRY_DIR / "reports" / "audit.md"
RELATIONS_PATH = REGISTRY_DIR / "reports" / "relations.md"
ADAPTER_MARKER = "agent-brain:routing"
CLAUDE_STATE_PATH = Path.home() / ".claude.json"
CLAUDE_SETTINGS_PATH = Path.home() / ".claude" / "settings.json"
CLAUDE_PLUGINS_DIR = Path.home() / ".claude" / "plugins"
IDLE_DAYS_THRESHOLD = 30

IGNORED_SCAN_DIRS = {
    ".git",
    ".idea",
    ".vscode",
    "assets",
    "examples",
    "node_modules",
    "references",
    "scripts",
    "templates",
    "tests",
}

SCOPE_SCORE = {
    "archive": 0,
    "global": 10,
    "plugin": 15,
    "domain": 20,
    "project": 30,
}


def configure_paths(registry: Path) -> None:
    global REGISTRY_DIR, CONFIG_PATH, DATA_PATH, STATE_PATH, VIEW_PATH, CANVAS_PATH, AUDIT_PATH, RELATIONS_PATH
    REGISTRY_DIR = safe_resolve(registry.expanduser())
    CONFIG_PATH = REGISTRY_DIR / "config" / "brain.json"
    DATA_PATH = REGISTRY_DIR / "data" / "inventory.json"
    STATE_PATH = REGISTRY_DIR / "state" / "active-context.json"
    VIEW_PATH = REGISTRY_DIR / "views" / "index.html"
    CANVAS_PATH = REGISTRY_DIR / "views" / "agent-brain.canvas"
    AUDIT_PATH = REGISTRY_DIR / "reports" / "audit.md"
    RELATIONS_PATH = REGISTRY_DIR / "reports" / "relations.md"


def scopes_can_be_active_together(
    first: Dict[str, Optional[str]], second: Dict[str, Optional[str]]
) -> bool:
    """Return whether two equal-rank candidates can coexist in one context."""

    if first["level"] == "project" and second["level"] == "project":
        return first.get("project") == second.get("project")
    if first["level"] == "domain" and second["level"] == "domain":
        first_domain = first.get("domain") or ""
        second_domain = second.get("domain") or ""
        return (
            first_domain == second_domain
            or first_domain.startswith(second_domain + ".")
            or second_domain.startswith(first_domain + ".")
        )
    return True


def read_json(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"Expected object in {path}")
    return value


def write_text_atomic(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        text=True,
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def write_json(path: Path, value: Any) -> None:
    write_text_atomic(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def safe_resolve(path: Path) -> Path:
    try:
        return path.resolve(strict=False)
    except OSError:
        return path.absolute()


def is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def slug(value: str) -> str:
    normalized = re.sub(r"[^\w]+", "-", value.casefold(), flags=re.UNICODE).strip("-_")
    return normalized or "unnamed"


def first_paragraph(value: str, limit: int = 220) -> str:
    compact = re.sub(r"\s+", " ", value).strip()
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1].rstrip() + "…"


def parse_skill_metadata(skill_file: Path, fallback_name: str) -> Dict[str, Any]:
    """Read only frontmatter/name/description, never the full skill body."""

    try:
        with skill_file.open("r", encoding="utf-8", errors="replace") as handle:
            lines = []
            for index, line in enumerate(handle):
                if index >= 100:
                    break
                lines.append(line.rstrip("\n"))
    except OSError:
        return {"name": fallback_name, "description": "", "model_invocable": True}

    name = fallback_name
    description = ""
    model_invocable = True
    if lines and lines[0].strip() == "---":
        frontmatter: List[str] = []
        for line in lines[1:]:
            if line.strip() == "---":
                break
            frontmatter.append(line)

        collecting_description = False
        description_lines: List[str] = []
        for line in frontmatter:
            name_match = re.match(r"^name:\s*[\"']?(.*?)[\"']?\s*$", line)
            if name_match:
                name = name_match.group(1).strip() or fallback_name
                collecting_description = False
                continue
            invocation_match = re.match(r"^disable-model-invocation:\s*(\S+)\s*$", line)
            if invocation_match:
                model_invocable = invocation_match.group(1).strip("\"'").lower() != "true"
                collecting_description = False
                continue
            description_match = re.match(r"^description:\s*(.*)$", line)
            if description_match:
                raw = description_match.group(1).strip().strip("\"'")
                if raw not in {"|", ">", "|-", ">-"}:
                    description_lines.append(raw)
                collecting_description = True
                continue
            if collecting_description:
                if re.match(r"^[A-Za-z_][A-Za-z0-9_-]*:\s*", line):
                    collecting_description = False
                elif line.startswith("  "):
                    description_lines.append(line.strip())
        description = first_paragraph(" ".join(description_lines))

    return {"name": name, "description": description, "model_invocable": model_invocable}


def package_fingerprint(package_dir: Path) -> str:
    """Hash package structure/content without copying it into the inventory."""

    digest = hashlib.sha256()
    file_count = 0
    try:
        for current, dirnames, filenames in os.walk(str(package_dir), followlinks=False):
            dirnames[:] = sorted(
                name
                for name in dirnames
                if name not in {".git", "node_modules", "__pycache__"}
            )
            current_path = Path(current)
            for filename in sorted(filenames):
                path = current_path / filename
                try:
                    relative = path.relative_to(package_dir)
                    stat = path.stat()
                except OSError:
                    continue
                digest.update(str(relative).encode("utf-8", errors="replace"))
                digest.update(str(stat.st_size).encode("ascii"))
                if stat.st_size <= 2_000_000:
                    try:
                        with path.open("rb") as handle:
                            for chunk in iter(lambda: handle.read(65536), b""):
                                digest.update(chunk)
                    except OSError:
                        continue
                file_count += 1
    except OSError:
        pass
    digest.update(f"files:{file_count}".encode("ascii"))
    return digest.hexdigest()


def expand_path(value: str) -> Path:
    return Path(os.path.expandvars(value)).expanduser()


def load_domains() -> List[Dict[str, Any]]:
    domains = [read_json(path) for path in sorted((REGISTRY_DIR / "domains").glob("**/domain.json"))]
    return sorted(domains, key=lambda item: (item.get("id", "").count("."), item.get("id", "")))


def load_projects() -> List[Dict[str, Any]]:
    projects = [read_json(path) for path in sorted((REGISTRY_DIR / "projects").glob("*.json"))]
    for project in projects:
        project["path"] = str(expand_path(project["path"]))
        project["exists"] = expand_path(project["path"]).is_dir()
    return sorted(projects, key=lambda item: item["name"].lower())


def project_for_workspace_path(
    cwd: Path, projects: Sequence[Dict[str, Any]]
) -> Optional[Tuple[Dict[str, Any], Dict[str, Any], int]]:
    """Resolve an alternate checkout/worktree back to its canonical project."""

    matches: List[Tuple[int, Dict[str, Any], Dict[str, Any]]] = []
    for project in projects:
        for rule in project.get("workspace_rules", []):
            root = safe_resolve(expand_path(rule["root"]))
            if not is_relative_to(cwd, root):
                continue
            relative = cwd.relative_to(root)
            if rule.get("dynamic_child", False):
                if not relative.parts:
                    continue
                workspace_root = root / relative.parts[0]
                workspace_id = relative.parts[0]
            else:
                workspace_root = root
                workspace_id = rule.get("id") or root.name
            project_path = safe_resolve(workspace_root / rule.get("project_path", ""))
            if not is_relative_to(cwd, project_path):
                continue
            workspace = {
                "id": workspace_id,
                "name": workspace_id,
                "path": str(workspace_root),
                "project_path": str(project_path),
                "kind": rule.get("kind", "workspace"),
                "dynamic": bool(rule.get("dynamic_child", False)),
            }
            matches.append((len(project_path.parts), project, workspace))

    if not matches:
        return None
    score, project, workspace = max(matches, key=lambda item: item[0])
    return project, workspace, score


def load_workflows() -> List[Dict[str, Any]]:
    workflows = [read_json(path) for path in sorted((REGISTRY_DIR / "workflows").glob("**/*.json"))]
    return sorted(workflows, key=lambda item: item["id"])


def validate_source_manifests(base_dir: Optional[Path] = None) -> Dict[str, List[str]]:
    base_dir = base_dir or REGISTRY_DIR
    errors: List[str] = []
    warnings: List[str] = []

    def load(path: Path) -> Optional[Dict[str, Any]]:
        try:
            return read_json(path)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            errors.append(f"{path.relative_to(base_dir)}: invalid JSON object: {error}")
            return None

    def require_string(item: Dict[str, Any], key: str, path: Path) -> None:
        if not isinstance(item.get(key), str) or not item[key].strip():
            errors.append(f"{path.relative_to(base_dir)}: {key} must be a non-empty string")

    config_path = base_dir / "config" / "brain.json"
    config = load(config_path)
    if config is not None:
        require_string(config, "default_domain", config_path)
        for key in ("skill_roots", "instruction_files", "domain_path_rules"):
            if not isinstance(config.get(key), list):
                errors.append(f"{config_path.relative_to(base_dir)}: {key} must be an array")
        if not isinstance(config.get("active_plugins", []), list) or any(
            not isinstance(plugin, str) or not plugin.strip() for plugin in config.get("active_plugins", [])
        ):
            errors.append("config/brain.json: active_plugins must be an array of strings")
        for index, root in enumerate(config.get("skill_roots", []) if isinstance(config.get("skill_roots"), list) else []):
            if not isinstance(root, dict):
                errors.append(f"config/brain.json: skill_roots[{index}] must be an object")
                continue
            for key in ("path", "runtime", "kind"):
                require_string(root, key, config_path)
            if "optional" in root and not isinstance(root["optional"], bool):
                errors.append(f"config/brain.json: skill_roots[{index}].optional must be a boolean")
        for index, instruction in enumerate(config.get("instruction_files", []) if isinstance(config.get("instruction_files"), list) else []):
            if not isinstance(instruction, dict):
                errors.append(f"config/brain.json: instruction_files[{index}] must be an object")
                continue
            for key in ("path", "runtime", "scope"):
                require_string(instruction, key, config_path)
        for index, rule in enumerate(config.get("domain_path_rules", []) if isinstance(config.get("domain_path_rules"), list) else []):
            if not isinstance(rule, dict):
                errors.append(f"config/brain.json: domain_path_rules[{index}] must be an object")
                continue
            for key in ("path", "domain"):
                require_string(rule, key, config_path)
        for rule_name in ("skill_scope_rules", "source_priority_rules"):
            rules = config.get(rule_name, [])
            if not isinstance(rules, list):
                errors.append(f"config/brain.json: {rule_name} must be an array")
                continue
            for index, rule in enumerate(rules):
                if not isinstance(rule, dict):
                    errors.append(f"config/brain.json: {rule_name}[{index}] must be an object")
                    continue
                if rule_name == "skill_scope_rules":
                    if not rule.get("names") and not rule.get("source_pattern"):
                        errors.append(f"config/brain.json: {rule_name}[{index}] needs names or source_pattern")
                    if "names" in rule and (
                        not isinstance(rule["names"], list)
                        or any(not isinstance(name, str) or not name.strip() for name in rule["names"])
                    ):
                        errors.append(f"config/brain.json: {rule_name}[{index}].names must be an array of strings")
                    if rule.get("level") not in {"global", "domain", "project", "plugin", "archive"}:
                        errors.append(f"config/brain.json: {rule_name}[{index}].level is invalid")
                    if rule.get("level") == "domain" and not isinstance(rule.get("domain"), str):
                        errors.append(f"config/brain.json: {rule_name}[{index}].domain is required")
                    if rule.get("level") == "plugin" and not isinstance(rule.get("plugin"), str):
                        errors.append(f"config/brain.json: {rule_name}[{index}].plugin is required")
                    if rule.get("level") == "project" and not isinstance(rule.get("project"), str):
                        errors.append(f"config/brain.json: {rule_name}[{index}].project is required")
                else:
                    if not isinstance(rule.get("priority"), int):
                        errors.append(f"config/brain.json: {rule_name}[{index}].priority must be an integer")
                if "source_pattern" in rule:
                    if not isinstance(rule["source_pattern"], str) or not rule["source_pattern"]:
                        errors.append(f"config/brain.json: {rule_name}[{index}].source_pattern must be a non-empty string")
                    else:
                        try:
                            re.compile(rule["source_pattern"])
                        except re.error as error:
                            errors.append(f"config/brain.json: {rule_name}[{index}].source_pattern is invalid: {error}")

    for path in sorted((base_dir / "domains").glob("**/domain.json")):
        item = load(path)
        if item is None:
            continue
        for key in ("id", "name", "description"):
            require_string(item, key, path)
        if item.get("parent") is not None and not isinstance(item.get("parent"), str):
            errors.append(f"{path.relative_to(base_dir)}: parent must be a string or null")

    for path in sorted((base_dir / "projects").glob("*.json")):
        item = load(path)
        if item is None:
            continue
        for key in ("id", "name", "path", "domain"):
            require_string(item, key, path)
        for key in ("aliases", "instruction_files", "skill_roots", "related_projects", "workspace_rules"):
            if key in item and not isinstance(item[key], list):
                errors.append(f"{path.relative_to(base_dir)}: {key} must be an array")
        for key in ("aliases", "instruction_files", "skill_roots"):
            if isinstance(item.get(key, []), list):
                for index, value in enumerate(item.get(key, [])):
                    if not isinstance(value, str) or not value.strip():
                        errors.append(f"{path.relative_to(base_dir)}: {key}[{index}] must be a non-empty string")
        for index, relation in enumerate(item.get("related_projects", []) if isinstance(item.get("related_projects"), list) else []):
            if not isinstance(relation, dict):
                errors.append(f"{path.relative_to(base_dir)}: related_projects[{index}] must be an object")
                continue
            for key in ("project", "type"):
                if not isinstance(relation.get(key), str) or not relation[key].strip():
                    errors.append(f"{path.relative_to(base_dir)}: related_projects[{index}].{key} must be a non-empty string")
        for index, rule in enumerate(item.get("workspace_rules", []) if isinstance(item.get("workspace_rules"), list) else []):
            if not isinstance(rule, dict):
                errors.append(f"{path.relative_to(base_dir)}: workspace_rules[{index}] must be an object")
                continue
            require_string(rule, "root", path)
            if "project_path" in rule and not isinstance(rule["project_path"], str):
                errors.append(f"{path.relative_to(base_dir)}: workspace_rules[{index}].project_path must be a string")
            if "dynamic_child" in rule and not isinstance(rule["dynamic_child"], bool):
                errors.append(f"{path.relative_to(base_dir)}: workspace_rules[{index}].dynamic_child must be a boolean")

    for path in sorted((base_dir / "workflows").glob("**/*.json")):
        item = load(path)
        if item is None:
            continue
        for key in ("id", "name", "domain"):
            require_string(item, key, path)
        if item.get("project") is not None and not isinstance(item.get("project"), str):
            errors.append(f"{path.relative_to(base_dir)}: project must be a string or null")
        steps = item.get("steps")
        if not isinstance(steps, list) or any(not isinstance(step, str) or not step for step in steps):
            errors.append(f"{path.relative_to(base_dir)}: steps must be an array of non-empty strings")

    return {"errors": errors, "warnings": warnings}


def walk_skill_files(root: Path, max_depth: int = 5) -> Iterable[Tuple[Path, Path]]:
    """Yield ``(mount_dir, SKILL.md)`` while preserving top-level symlinks."""

    if not root.is_dir():
        return

    for child in sorted(root.iterdir(), key=lambda item: item.name.lower()):
        if child.name.startswith(".") and child.name != ".system":
            continue

        if child.is_symlink():
            resolved = safe_resolve(child)
            skill_file = resolved / "SKILL.md"
            if skill_file.is_file():
                yield child, skill_file
            continue

        if not child.is_dir():
            continue

        direct = child / "SKILL.md"
        if direct.is_file():
            yield child, direct
            continue

        child_parts = len(child.parts)
        for current, dirnames, filenames in os.walk(str(child), followlinks=False):
            current_path = Path(current)
            depth = len(current_path.parts) - child_parts
            dirnames[:] = [
                name
                for name in dirnames
                if name not in IGNORED_SCAN_DIRS and not name.startswith(".")
            ]
            if depth >= max_depth:
                dirnames[:] = []
            if "SKILL.md" in filenames:
                yield current_path, current_path / "SKILL.md"
                dirnames[:] = []


def plugin_identity(source: Path) -> Optional[str]:
    parts = source.parts
    try:
        cache_index = parts.index("cache")
    except ValueError:
        return None
    head = parts[:cache_index]
    tail = parts[cache_index + 1 :]
    if ".claude" not in head and ".codex" not in head:
        return None
    if not tail:
        return "unknown"
    if ".claude" in head:
        # cache/<marketplace>/<plugin>/<version>/skills/<name>
        return tail[1] if len(tail) >= 2 else tail[0]
    if len(tail) >= 2 and re.fullmatch(r"\d+(?:\.\d+)*(?:-[\w.-]+)?", tail[1]):
        return tail[0]
    if len(tail) >= 2:
        return f"{tail[0]}.{tail[1]}"
    return tail[0]


def plugin_skill_roots(plugins_dir: Optional[Path] = None) -> List[Dict[str, str]]:
    """Skill roots of the Claude Code plugins installed for this user."""

    directory = plugins_dir if plugins_dir is not None else CLAUDE_PLUGINS_DIR
    try:
        registry = read_json(directory / "installed_plugins.json").get("plugins")
    except (OSError, ValueError, json.JSONDecodeError):
        return []
    if not isinstance(registry, dict):
        return []
    roots: List[Dict[str, str]] = []
    seen: set = set()
    for identifier, installs in registry.items():
        if not isinstance(installs, list):
            continue
        for install in installs:
            if not isinstance(install, dict) or install.get("scope") != "user":
                continue
            install_path = install.get("installPath")
            if not isinstance(install_path, str):
                continue
            install_root = expand_path(install_path)
            path = install_root / "skills"
            if not path.is_dir() or str(path) in seen:
                continue
            seen.add(str(path))
            spec = {
                "path": str(path),
                "runtime": "claude",
                "kind": "mount",
                "plugin": identifier.split("@")[0],
            }
            declared = plugin_declared_skills(install_root)
            if declared is not None:
                spec["declared"] = declared
            roots.append(spec)
    return roots


def plugin_declared_skills(install_root: Path) -> Optional[List[str]]:
    """Skill directories a plugin manifest exports, or None when it exports all."""

    try:
        declared = read_json(install_root / ".claude-plugin" / "plugin.json").get("skills")
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(declared, list):
        return None
    return [str(install_root / str(item).lstrip("./")) for item in declared if isinstance(item, str)]


def scan_config() -> Dict[str, Any]:
    """Registry config extended with the skill roots of installed plugins.

    Plugin roots are discovered from the runtime rather than stored in the
    manifest: their paths carry a version and change on every plugin update.
    """

    config = read_json(CONFIG_PATH) if CONFIG_PATH.is_file() else {}
    roots = list(config.get("skill_roots", []))
    known = {
        str(safe_resolve(expand_path(item["path"])))
        for item in roots
        if isinstance(item, dict) and isinstance(item.get("path"), str)
    }
    for spec in plugin_skill_roots():
        resolved = str(safe_resolve(expand_path(spec["path"])))
        if resolved in known:
            continue
        known.add(resolved)
        roots.append(spec)
    config["skill_roots"] = roots
    return config


def read_enabled_plugins(settings_path: Optional[Path] = None) -> List[str]:
    """Plugins the runtime currently loads, by plugin name without marketplace."""

    path = settings_path if settings_path is not None else CLAUDE_SETTINGS_PATH
    try:
        enabled = read_json(path).get("enabledPlugins")
    except (OSError, ValueError, json.JSONDecodeError):
        return []
    if not isinstance(enabled, dict):
        return []
    return sorted({key.split("@")[0] for key, value in enabled.items() if value})


def classify_bundle(skill: Dict[str, Any], rules: Sequence[Dict[str, Any]]) -> Optional[str]:
    """Name the block a skill belongs to: first matching rule, else its plugin.

    Rules are ordered, so a skill named in one rule keeps that block even when a
    later rule matches its prefix — ``ququ-orchestrator-code-style`` belongs to
    the orchestrator block, not to ququ.
    """

    name = skill["name"]
    source = skill.get("source_path", "")
    for rule in rules:
        prefix = rule.get("name_prefix")
        pattern = rule.get("source_pattern")
        if name in rule.get("names", []):
            return rule["id"]
        if prefix and name.startswith(prefix):
            return rule["id"]
        if pattern and re.search(pattern, source):
            return rule["id"]
    return skill.get("plugin_source") or skill["scope"].get("plugin")


def bundle_summary(
    skills: Sequence[Dict[str, Any]], rules: Sequence[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """Per-block totals for the blocks that actually hold skills."""

    titles = {rule["id"]: rule.get("title", rule["id"]) for rule in rules}
    members: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    counted: set = set()
    for skill in skills:
        # One skill mounted in several roots is a single entry for the runtime.
        if not skill.get("bundle") or listing_name(skill) in counted:
            continue
        counted.add(listing_name(skill))
        members[skill["bundle"]].append(skill)

    summary = []
    for bundle_id, items in members.items():
        summary.append(
            {
                "id": bundle_id,
                "title": titles.get(bundle_id, bundle_id),
                "skill_count": len(items),
                "never_used": sum(1 for item in items if not item["usage"]["count"]),
                "invocations": sum(item["usage"]["count"] for item in items),
            }
        )
    return sorted(summary, key=lambda item: (-item["skill_count"], item["id"]))


def listing_name(skill: Dict[str, Any]) -> str:
    """The name the runtime lists a skill under, plugin prefix included.

    The prefix follows the source a skill was loaded from, not the scope the
    registry assigned it: moving a plugin skill into a domain does not rename
    it for the runtime.
    """

    plugin = skill.get("plugin_source") or skill["scope"].get("plugin")
    return f"{plugin}:{skill['name']}" if plugin else skill["name"]


def skill_listing_overrides(inventory: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, str]:
    """Hide out-of-context skills from the model while keeping /name working.

    Overrides are keyed by listed name, so a name shared with a skill that is
    active here stays untouched — hiding it would take the active one down too.
    """

    installed_plugins = set(context.get("active_plugins", []))
    listed: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for skill in inventory["skills"]:
        scope = skill["scope"]
        if scope["level"] == "archive" or not skill.get("model_invocable", True):
            continue
        if "claude" not in skill["runtimes"]:
            continue
        # A disabled plugin is already absent from the listing; overriding it is noise.
        plugin = skill.get("plugin_source") or scope.get("plugin")
        if plugin and plugin not in installed_plugins:
            continue
        listed[listing_name(skill)].append(skill)

    return {
        name: "user-invocable-only"
        for name, candidates in sorted(listed.items())
        if not any(skill_is_active(skill, context) for skill in candidates)
    }


def write_skill_overrides(overrides: Dict[str, str], settings_path: Optional[Path] = None) -> Path:
    """Replace the skillOverrides block of the runtime settings, backing it up."""

    path = settings_path if settings_path is not None else CLAUDE_SETTINGS_PATH
    try:
        settings = read_json(path)
    except (OSError, ValueError, json.JSONDecodeError):
        settings = {}
    else:
        write_text_atomic(path.with_name(path.name + ".brain-backup"), json.dumps(settings, ensure_ascii=False, indent=2) + "\n")
    if overrides:
        settings["skillOverrides"] = overrides
    else:
        settings.pop("skillOverrides", None)
    write_text_atomic(path, json.dumps(settings, ensure_ascii=False, indent=2) + "\n")
    return path


def read_listing_limits(settings_path: Optional[Path] = None) -> Dict[str, Optional[float]]:
    """Caps the runtime applies to the skill listing it puts in the prompt."""

    path = settings_path if settings_path is not None else CLAUDE_SETTINGS_PATH
    try:
        settings = read_json(path)
    except (OSError, ValueError, json.JSONDecodeError):
        settings = {}
    max_chars = settings.get("skillListingMaxDescChars")
    fraction = settings.get("skillListingBudgetFraction")
    return {
        "max_desc_chars": int(max_chars) if isinstance(max_chars, (int, float)) else None,
        "budget_fraction": float(fraction) if isinstance(fraction, (int, float)) else None,
    }


def find_project_for_path(source: Path, projects: Sequence[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    matches = []
    for project in projects:
        project_path = safe_resolve(expand_path(project["path"]))
        if is_relative_to(source, project_path):
            matches.append((len(project_path.parts), project))
    return max(matches, default=(0, None), key=lambda item: item[0])[1]


def classify_scope(
    name: str,
    source: Path,
    config: Dict[str, Any],
    projects: Sequence[Dict[str, Any]],
    declared_project: Optional[Dict[str, Any]] = None,
) -> Dict[str, Optional[str]]:
    source_text = str(source)
    for rule in config.get("skill_scope_rules", []):
        names = rule.get("names", [])
        source_pattern = rule.get("source_pattern")
        if (names and name in names) or (source_pattern and re.search(source_pattern, source_text)):
            return {
                "level": rule["level"],
                "domain": rule.get("domain"),
                "project": rule.get("project"),
                "plugin": rule.get("plugin"),
            }

    if "skill-snapshots" in source_text or "-workspace/skill-snapshot" in source_text:
        return {"level": "archive", "domain": None, "project": None, "plugin": None}

    project = find_project_for_path(source, projects)
    if project:
        return {
            "level": "project",
            "domain": project["domain"],
            "project": project["id"],
            "plugin": None,
        }

    if declared_project:
        return {
            "level": "project",
            "domain": declared_project["domain"],
            "project": declared_project["id"],
            "plugin": None,
        }

    plugin = plugin_identity(source)
    if plugin:
        return {"level": "plugin", "domain": None, "project": None, "plugin": plugin}

    return {"level": "global", "domain": None, "project": None, "plugin": None}


def skill_id(name: str, scope: Dict[str, Optional[str]]) -> str:
    suffix = slug(name)
    level = scope["level"]
    if level == "project":
        return f"project.{slug(scope.get('project') or 'unknown')}.{suffix}"
    if level == "domain":
        return f"domain.{scope.get('domain') or 'unknown'}.{suffix}"
    if level == "plugin":
        return f"plugin.{slug(scope.get('plugin') or 'unknown')}.{suffix}"
    if level == "archive":
        digest = hashlib.sha1(str(scope).encode("utf-8")).hexdigest()[:7]
        return f"archive.{suffix}.{digest}"
    return f"global.{suffix}"


def source_priority(
    name: str,
    source_path: str,
    scope: Dict[str, Optional[str]],
    config: Optional[Dict[str, Any]] = None,
) -> Tuple[int, str]:
    if scope["level"] == "archive":
        return 0, "archive"
    if scope["level"] == "project":
        return 200, "project canonical"
    for rule in (config or {}).get("source_priority_rules", []):
        if rule.get("name_prefix") and not name.startswith(rule["name_prefix"]):
            continue
        if rule.get("source_pattern") and not re.search(rule["source_pattern"], source_path):
            continue
        return rule["priority"], rule.get("role", "configured source")
    if "/.codex/plugins/cache/" in source_path:
        return 170, "plugin package"
    if "/.agents/skills/" in source_path:
        return 160, "shared canonical"
    if "/.codex/skills/" in source_path:
        return 140, "Codex runtime copy"
    if "/.claude/skills/" in source_path:
        return 130, "Claude runtime copy"
    return 100, "registered source"


def collect_skill_occurrences(
    config: Dict[str, Any], projects: Sequence[Dict[str, Any]]
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    roots = list(config.get("skill_roots", []))
    known_root_paths = {str(safe_resolve(expand_path(item["path"]))) for item in roots}
    for project in projects:
        for relative in project.get("skill_roots", []):
            path = safe_resolve(expand_path(project["path"]) / relative)
            if str(path) in known_root_paths or not path.is_dir():
                continue
            roots.append(
                {
                    "path": str(path),
                    "runtime": "project",
                    "kind": "canonical",
                    "project": project["id"],
                    "domain": project["domain"],
                }
            )
            known_root_paths.add(str(path))

    occurrences: List[Dict[str, Any]] = []
    broken: List[Dict[str, Any]] = []
    seen_mount_runtime: set = set()

    for root_spec in roots:
        root = expand_path(root_spec["path"])
        if not root.exists():
            if not root_spec.get("optional", False):
                broken.append({"kind": "missing_skill_root", "path": str(root)})
            continue
        declared = root_spec.get("declared")
        for mount_dir, skill_file in walk_skill_files(root):
            if declared is not None and str(mount_dir) not in declared:
                continue
            mount_key = (str(mount_dir), root_spec["runtime"])
            if mount_key in seen_mount_runtime:
                continue
            seen_mount_runtime.add(mount_key)
            source_dir = safe_resolve(skill_file.parent)
            metadata = parse_skill_metadata(skill_file, mount_dir.name)
            declared_project = next(
                (project for project in projects if project["id"] == root_spec.get("project")),
                None,
            )
            scope = classify_scope(metadata["name"], source_dir, config, projects, declared_project)
            occurrences.append(
                {
                    "logical_name": metadata["name"],
                    "mount_name": mount_dir.name,
                    "description": metadata["description"],
                    "model_invocable": metadata["model_invocable"],
                    "plugin_source": plugin_identity(source_dir),
                    "mount_path": str(mount_dir),
                    "source_path": str(source_dir),
                    "package_fingerprint": package_fingerprint(source_dir),
                    "scope": scope,
                    "skill_file": str(skill_file),
                    "runtime": root_spec["runtime"],
                    "root_kind": root_spec["kind"],
                    "is_symlink": mount_dir.is_symlink(),
                }
            )

    return occurrences, broken


def merge_skills(
    occurrences: Sequence[Dict[str, Any]],
    config: Dict[str, Any],
    projects: Sequence[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    by_source: Dict[Tuple[str, str], List[Dict[str, Any]]] = defaultdict(list)
    for occurrence in occurrences:
        scope_key = json.dumps(occurrence["scope"], ensure_ascii=True, sort_keys=True)
        by_source[(occurrence["package_fingerprint"], scope_key)].append(occurrence)

    skills: List[Dict[str, Any]] = []
    used_ids: Dict[str, int] = defaultdict(int)
    for (fingerprint, _scope_key), mounts in sorted(by_source.items()):
        preferred = sorted(
            mounts,
            key=lambda item: (
                item["root_kind"] != "canonical",
                item["runtime"] == "project",
                item["mount_path"],
            ),
        )[0]
        name = preferred["logical_name"] or preferred["mount_name"]
        scope = preferred["scope"]
        source_path = preferred["source_path"]
        priority, source_role = source_priority(name, source_path, scope, config)
        identifier = skill_id(name, scope)
        used_ids[identifier] += 1
        if used_ids[identifier] > 1:
            identifier = f"{identifier}.{hashlib.sha1(source_path.encode('utf-8')).hexdigest()[:7]}"

        runtimes = sorted({item["runtime"] for item in mounts})
        mount_paths = sorted({item["mount_path"] for item in mounts})
        skills.append(
            {
                "id": identifier,
                "name": name,
                "mount_names": sorted({item["mount_name"] for item in mounts}),
                "description": preferred["description"],
                "model_invocable": preferred.get("model_invocable", True),
                "plugin_source": preferred.get("plugin_source"),
                "scope": scope,
                "source_path": source_path,
                "alternate_sources": sorted({item["source_path"] for item in mounts if item["source_path"] != source_path}),
                "package_fingerprint": fingerprint,
                "source_priority": priority,
                "source_role": source_role,
                "mounts": mount_paths,
                "runtimes": runtimes,
                "mount_count": len(mount_paths),
                "symlink_mounts": sum(1 for item in mounts if item["is_symlink"]),
                "status": "archived" if scope["level"] == "archive" else "available",
            }
        )

    collisions: List[Dict[str, Any]] = []
    by_name: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for skill in skills:
        if skill["scope"]["level"] != "archive":
            by_name[skill["name"].casefold()].append(skill)

    for normalized, candidates in sorted(by_name.items()):
        if len(candidates) < 2:
            continue
        candidates = sorted(
            candidates,
            key=lambda item: (
                SCOPE_SCORE[item["scope"]["level"]],
                item.get("source_priority", 0),
                item["id"],
            ),
            reverse=True,
        )
        scope_levels = {item["scope"]["level"] for item in candidates}
        top_rank = (
            SCOPE_SCORE[candidates[0]["scope"]["level"]],
            candidates[0].get("source_priority", 0),
        )
        tied_top = [
            item
            for item in candidates
            if (
                SCOPE_SCORE[item["scope"]["level"]],
                item.get("source_priority", 0),
            ) == top_rank
        ]
        ambiguous_together = any(
            scopes_can_be_active_together(first["scope"], second["scope"])
            for index, first in enumerate(tied_top)
            for second in tied_top[index + 1 :]
        )
        collisions.append(
            {
                "name": candidates[0]["name"],
                "normalized_name": normalized,
                "severity": "high" if len(scope_levels) > 1 else "medium",
                "candidate_ids": [item["id"] for item in candidates],
                "source_paths": [item["source_path"] for item in candidates],
                "preferred_id": candidates[0]["id"],
                "status": "unresolved" if len(tied_top) > 1 and ambiguous_together else "resolved",
                "resolution": (
                    "mutually exclusive project scopes are resolved by active context"
                    if len(tied_top) > 1 and not ambiguous_together
                    else "project > domain > global > canonical source priority; unresolved ties require an explicit namespaced ID"
                ),
            }
        )

    return sorted(skills, key=lambda item: item["id"]), collisions


def instruction_inventory(
    config: Dict[str, Any], projects: Sequence[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    specs = list(config.get("instruction_files", []))
    for project in projects:
        for relative in project.get("instruction_files", []):
            candidate = expand_path(project["path"]) / relative
            specs.append(
                {
                    "path": str(candidate),
                    "runtime": "claude" if candidate.name == "CLAUDE.md" else "codex",
                    "scope": "project",
                    "project": project["id"],
                    "declared": True,
                }
            )

    inventory = []
    seen = set()
    for spec in specs:
        path = expand_path(spec["path"])
        if str(path) in seen:
            continue
        seen.add(str(path))
        item: Dict[str, Any] = dict(spec)
        item["exists"] = path.is_file()
        if path.is_file():
            raw = path.read_bytes()
            text = raw.decode("utf-8", errors="replace")
            item.update(
                {
                    "bytes": len(raw),
                    "lines": text.count("\n") + (0 if text.endswith("\n") else 1),
                    "sha256": hashlib.sha256(raw).hexdigest(),
                    "headings": re.findall(r"^#{1,3}\s+(.+)$", text, flags=re.MULTILINE)[:40],
                    "has_user_rules": "user:start" in text,
                    "has_agent_brain": ADAPTER_MARKER in text,
                }
            )
        inventory.append(item)
    return sorted(inventory, key=lambda item: item["path"])


def read_skill_usage(state_path: Optional[Path] = None) -> Dict[str, Dict[str, Any]]:
    """Read the skill invocation counters Claude Code keeps in ~/.claude.json."""

    path = state_path if state_path is not None else CLAUDE_STATE_PATH
    try:
        raw = read_json(path).get("skillUsage")
    except (OSError, ValueError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    usage: Dict[str, Dict[str, Any]] = {}
    for key, entry in raw.items():
        if not isinstance(entry, dict):
            continue
        timestamp = entry.get("lastUsedAt")
        last_used = None
        if isinstance(timestamp, (int, float)):
            last_used = datetime.fromtimestamp(timestamp / 1000, timezone.utc).date().isoformat()
        usage[key] = {"count": int(entry.get("usageCount") or 0), "last_used": last_used}
    return usage


def attach_skill_usage(
    skills: Sequence[Dict[str, Any]],
    usage: Dict[str, Dict[str, Any]],
    today: Optional[str] = None,
) -> Dict[str, int]:
    """Attach invocation counters to every skill and summarise the result.

    Counters are keyed by the name the runtime lists, so a plugin skill is
    looked up as ``plugin:name`` first and only then by its bare name. The
    summary counts each listed name once, because the same skill mounted in
    several roots is still a single entry for the runtime. Archived sources
    still receive their counters but stay out of the summary.
    """

    current = date.fromisoformat(today) if today else datetime.now(timezone.utc).date()
    summary = {"tracked": 0, "used": 0, "never_used": 0, "idle_over_30d": 0, "total_invocations": 0}
    counted: set = set()
    for skill in skills:
        plugin = skill["scope"].get("plugin")
        candidates = [f"{plugin}:{skill['name']}"] if plugin else []
        candidates.append(skill["name"])
        counter_key = next((key for key in candidates if key in usage), None)
        entry = usage[counter_key] if counter_key else None
        last_used = entry["last_used"] if entry else None
        skill["usage"] = {
            "count": entry["count"] if entry else 0,
            "last_used": last_used,
            "days_idle": (current - date.fromisoformat(last_used)).days if last_used else None,
            "counter_key": counter_key,
        }
        if skill["scope"]["level"] == "archive":
            continue
        listed_name = counter_key or candidates[0]
        if listed_name in counted:
            continue
        counted.add(listed_name)
        summary["tracked"] += 1
        summary["total_invocations"] += skill["usage"]["count"]
        if not skill["usage"]["count"]:
            summary["never_used"] += 1
            continue
        summary["used"] += 1
        days_idle = skill["usage"]["days_idle"]
        if days_idle is not None and days_idle > IDLE_DAYS_THRESHOLD:
            summary["idle_over_30d"] += 1
    return summary


def build_inventory() -> Dict[str, Any]:
    config = scan_config()
    domains = load_domains()
    projects = load_projects()
    workflows = load_workflows()
    occurrences, broken = collect_skill_occurrences(config, projects)
    skills, collisions = merge_skills(occurrences, config, projects)
    usage_summary = attach_skill_usage(skills, read_skill_usage())
    bundle_rules = config.get("skill_bundles", [])
    for skill in skills:
        skill["bundle"] = classify_bundle(skill, bundle_rules)
    instructions = instruction_inventory(config, projects)

    for project in projects:
        project_id = project["id"]
        project_instructions = [item for item in instructions if item.get("project") == project_id]
        project_skills = [item for item in skills if item["scope"].get("project") == project_id]
        project_workflows = [item for item in workflows if item.get("project") == project_id]
        project["coverage"] = {
            "instruction_count": sum(1 for item in project_instructions if item.get("exists")),
            "missing_instruction_count": sum(1 for item in project_instructions if not item.get("exists")),
            "skill_count": len(project_skills),
            "workflow_count": len(project_workflows),
            "related_project_count": len(project.get("related_projects", [])),
            "workspace_rule_count": len(project.get("workspace_rules", [])),
        }

    scope_counts: Dict[str, int] = defaultdict(int)
    runtime_counts: Dict[str, int] = defaultdict(int)
    for skill in skills:
        scope_counts[skill["scope"]["level"]] += 1
        for runtime in skill["runtimes"]:
            runtime_counts[runtime] += 1

    return {
        "schema_version": "agent-brain.registry.v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "home": str(Path.home()),
        "registry": str(REGISTRY_DIR),
        "config": {
            "default_domain": config.get("default_domain", "meta.agent-system"),
            "domain_path_rules": config.get("domain_path_rules", []),
            "skill_scope_rules": config.get("skill_scope_rules", []),
            "active_plugins": config.get("active_plugins") or read_enabled_plugins(),
            "listing_limits": read_listing_limits(),
        },
        "source_snapshot": source_snapshot(config, projects),
        "domains": domains,
        "projects": projects,
        "workflows": workflows,
        "skills": skills,
        "collisions": collisions,
        "broken_sources": broken,
        "instructions": instructions,
        "bundles": bundle_summary(skills, bundle_rules),
        "stats": {
            "skill_sources": len(skills),
            "skill_mounts": len(occurrences),
            "scope_counts": dict(sorted(scope_counts.items())),
            "runtime_counts": dict(sorted(runtime_counts.items())),
            "collision_count": len(collisions),
            "unresolved_collision_count": sum(1 for item in collisions if item["status"] == "unresolved"),
            "broken_count": len(broken),
            "project_count": len(projects),
            "domain_count": len(domains),
            "workflow_count": len(workflows),
            "usage": usage_summary,
        },
    }


def inventory_config(inventory: Dict[str, Any]) -> Dict[str, Any]:
    config = inventory.get("config")
    if isinstance(config, dict):
        return config
    return read_json(CONFIG_PATH)


def domain_matches(skill_domain: Optional[str], active_domain: str) -> bool:
    if not skill_domain:
        return False
    return active_domain == skill_domain or active_domain.startswith(skill_domain + ".")


def read_active_override() -> Optional[str]:
    if not STATE_PATH.is_file():
        return None
    try:
        value = read_json(STATE_PATH).get("domain")
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    return value if isinstance(value, str) else None


def resolve_context(
    cwd: Path,
    inventory: Dict[str, Any],
    config: Optional[Dict[str, Any]] = None,
    explicit_domain: Optional[str] = None,
) -> Dict[str, Any]:
    config = config or inventory_config(inventory)
    resolved_cwd = safe_resolve(cwd)
    project_matches: List[Tuple[int, Dict[str, Any]]] = []
    for project in inventory["projects"]:
        project_path = safe_resolve(expand_path(project["path"]))
        if is_relative_to(resolved_cwd, project_path):
            project_matches.append((len(project_path.parts), project))

    direct_score, project = max(project_matches, default=(0, None), key=lambda item: item[0])
    workspace = None
    workspace_match = project_for_workspace_path(resolved_cwd, inventory["projects"])
    if workspace_match:
        workspace_project, matched_workspace, workspace_score = workspace_match
        if workspace_score > direct_score:
            project = workspace_project
            workspace = matched_workspace
    domain = project["domain"] if project else None
    source = "workspace" if workspace else "project" if project else None

    if not domain:
        path_matches = []
        for rule in config.get("domain_path_rules", []):
            rule_path = safe_resolve(expand_path(rule["path"]))
            if is_relative_to(resolved_cwd, rule_path):
                path_matches.append((len(rule_path.parts), rule))
        if path_matches:
            _, matched_rule = max(path_matches, key=lambda item: item[0])
            domain = matched_rule["domain"]
            source = "path"
            if matched_rule.get("dynamic_project"):
                relative = resolved_cwd.relative_to(safe_resolve(expand_path(matched_rule["path"])))
                if relative.parts:
                    workspace = {
                        "id": relative.parts[0],
                        "name": relative.parts[0],
                        "path": str(safe_resolve(expand_path(matched_rule["path"])) / relative.parts[0]),
                        "kind": "worktree",
                        "dynamic": True,
                    }

    override = explicit_domain or read_active_override()
    if explicit_domain:
        project = None
        workspace = None
        domain = explicit_domain
        source = "explicit"
    elif not project and not domain and override:
        domain = override
        source = "override"
    elif not domain:
        domain = config.get("default_domain", "meta.agent-system")
        source = "default"

    chain = []
    parts = domain.split(".")
    for index in range(1, len(parts) + 1):
        chain.append(".".join(parts[:index]))
    if project:
        chain.append(f"project:{project['id']}")
    if workspace:
        chain.append(f"workspace:{workspace['id']}")

    return {
        "cwd": str(resolved_cwd),
        "domain": domain,
        "project": project,
        "workspace": workspace,
        "source": source,
        "chain": chain,
        "active_plugins": config.get("active_plugins", []),
    }


def skill_is_active(skill: Dict[str, Any], context: Dict[str, Any]) -> bool:
    scope = skill["scope"]
    level = scope["level"]
    if level == "global":
        return True
    if level == "plugin":
        return scope.get("plugin") in context.get("active_plugins", [])
    if level == "domain":
        return domain_matches(scope.get("domain"), context["domain"])
    if level == "project":
        return bool(context.get("project") and scope.get("project") == context["project"]["id"])
    return False


def context_status(cwd: Path, inventory: Dict[str, Any], explicit_domain: Optional[str] = None) -> Dict[str, Any]:
    context = resolve_context(cwd, inventory, explicit_domain=explicit_domain)
    active = [skill for skill in inventory["skills"] if skill_is_active(skill, context)]
    excluded = [skill for skill in inventory["skills"] if not skill_is_active(skill, context)]
    collision_names = {
        item["normalized_name"]
        for item in inventory["collisions"]
        if item.get("status") == "unresolved"
    }
    active_collisions = sorted(
        {
            skill["name"]
            for skill in active
            if skill["name"].casefold() in collision_names
        }
    )
    active_workflows = [
        workflow["id"]
        for workflow in inventory.get("workflows", [])
        if domain_matches(workflow.get("domain"), context["domain"])
        and (not workflow.get("project") or (context.get("project") and workflow["project"] == context["project"]["id"]))
    ]
    return {
        "context": context,
        "active_skill_count": len(active),
        "excluded_skill_count": len(excluded),
        "active_skills": [item["id"] for item in active],
        "active_collisions": active_collisions,
        "active_workflows": active_workflows,
        "registry_generated_at": inventory["generated_at"],
    }


def select_skill(query: str, status: Dict[str, Any], inventory: Dict[str, Any]) -> Dict[str, Any]:
    normalized = query.casefold()
    exact_candidates = [
        skill
        for skill in inventory["skills"]
        if normalized == skill["id"].casefold()
        or normalized == skill["name"].casefold()
    ]
    candidates = exact_candidates or [
        skill
        for skill in inventory["skills"]
        if normalized in skill["id"].casefold() or normalized in skill["name"].casefold()
    ]
    if not candidates:
        return {"query": query, "selected": None, "candidates": [], "reason": "no matching skill"}

    active_ids = set(status["active_skills"])
    ranked = sorted(
        candidates,
        key=lambda item: (
            item["id"] in active_ids,
            SCOPE_SCORE[item["scope"]["level"]],
            item.get("source_priority", 0),
            item["mount_count"],
            item["id"],
        ),
        reverse=True,
    )
    exact_id = next((item for item in candidates if normalized == item["id"].casefold()), None)
    selected = ranked[0] if ranked[0]["id"] in active_ids else None
    if exact_id and exact_id["scope"]["level"] != "archive":
        selected = exact_id
    elif selected:
        selected_score = SCOPE_SCORE[selected["scope"]["level"]]
        selected_priority = selected.get("source_priority", 0)
        equally_specific = [
            item
            for item in ranked
            if item["id"] in active_ids
            and SCOPE_SCORE[item["scope"]["level"]] == selected_score
            and item.get("source_priority", 0) == selected_priority
        ]
        if len(equally_specific) > 1:
            selected = None
    if selected:
        level = selected["scope"]["level"]
        reason = f"active {level} scope and canonical source priority"
        if normalized == selected["id"].casefold():
            reason = "explicit namespaced ID"
    elif exact_id and exact_id["scope"]["level"] == "archive":
        reason = "archived packages cannot be selected"
    elif any(item["id"] in active_ids for item in ranked):
        reason = "multiple equally specific active packages; use an explicit namespaced ID"
    else:
        reason = "matching skills exist, but all are outside the active context"
    return {
        "query": query,
        "selected": selected,
        "candidates": ranked,
        "reason": reason,
    }


def generate_audit(inventory: Dict[str, Any]) -> str:
    stats = inventory["stats"]
    instruction_without_adapter = [
        item["path"] for item in inventory["instructions"] if item.get("scope") == "global" and not item.get("has_agent_brain")
    ]
    lines = [
        "# Agent Brain audit",
        "",
        f"Generated: `{inventory['generated_at']}`",
        "",
        "## Executive verdict",
        "",
        "The runtime is usable, but capability ownership was previously implicit. "
        "Agent Brain now provides a deterministic scope registry; remaining same-name "
        "packages are reported rather than silently collapsed.",
        "",
        "## Inventory",
        "",
        f"- Canonical skill sources: **{stats['skill_sources']}**",
        f"- Runtime/project mounts: **{stats['skill_mounts']}**",
        f"- Domains: **{stats['domain_count']}**",
        f"- Projects: **{stats['project_count']}**",
        f"- Workflows: **{stats['workflow_count']}**",
        f"- Same-name source collisions: **{stats['collision_count']}**",
        f"- Unresolved same-name collisions: **{stats['unresolved_collision_count']}**",
        f"- Broken configured sources: **{stats['broken_count']}**",
        "",
    ]
    usage = stats.get("usage")
    if usage:
        config = inventory_config(inventory)
        running_plugins = set(config.get("active_plugins") or [])
        listed = [
            skill for skill in inventory["skills"]
            if skill["scope"]["level"] != "archive"
            and skill.get("model_invocable", True)
            and "claude" in skill["runtimes"]
            and (skill.get("plugin_source") or skill["scope"].get("plugin") or None) in running_plugins | {None}
        ]
        cap = (config.get("listing_limits") or {}).get("max_desc_chars")
        def listing_cost(items: Sequence[Dict[str, Any]]) -> int:
            chars = sum(
                min(len(item["description"]), cap or len(item["description"])) + len(item["name"]) + 12
                for item in items
            )
            return round(chars / 3)
        lines.extend(
            [
                "## Usage",
                "",
                f"- Skills with a usage counter: **{usage['tracked']}**",
                f"- Invoked at least once: **{usage['used']}**",
                f"- Never invoked: **{usage['never_used']}**",
                f"- Idle over 30 days: **{usage['idle_over_30d']}**",
                f"- Total invocations: **{usage['total_invocations']}**",
                f"- Listed to the model: **{len(listed)}** skills, about **{listing_cost(listed)}** tokens per session",
                f"- Of those never invoked: about **{listing_cost([item for item in listed if not item['usage']['count']])}** tokens",
                "",
            ]
        )
    bundles = inventory.get("bundles") or []
    if bundles:
        lines.extend(
            [
                "## Blocks",
                "",
                "| Block | Skills | Never used | Invocations |",
                "|---|---|---|---|",
                *(
                    f"| {bundle['title']} | {bundle['skill_count']} | {bundle['never_used']} | {bundle['invocations']} |"
                    for bundle in bundles
                ),
                "",
            ]
        )
    lines.extend(
        [
            "## Severity-ranked findings",
            "",
        ]
    )
    if inventory["collisions"]:
        lines.extend(
            [
                "### High — same display name can point to different skill packages",
                "",
                "The router resolves these by explicit namespaced ID and scope. They are "
                "kept visible because deleting one automatically could remove legitimate "
                "project specialization.",
                "",
            ]
        )
        for collision in inventory["collisions"]:
            ids = ", ".join(f"`{item}`" for item in collision["candidate_ids"])
            lines.append(f"- **{collision['name']}** ({collision['status']} → `{collision['preferred_id']}`): {ids}")
        lines.append("")
    else:
        lines.extend(["- No same-name source collisions.", ""])

    if instruction_without_adapter:
        lines.extend(
            [
                "### Medium — runtime instructions are not all connected to Agent Brain",
                "",
            ]
        )
        for path in instruction_without_adapter:
            lines.append(f"- `{path}`")
        lines.append("")
    else:
        lines.extend(
            [
                "### Resolved — runtime instructions contain the Agent Brain routing contract",
                "",
            ]
        )

    if inventory["broken_sources"]:
        lines.extend(["### High — configured sources are missing", ""])
        for item in inventory["broken_sources"]:
            lines.append(f"- `{item['path']}` ({item['kind']})")
        lines.append("")

    lines.extend(
        [
            "## Architecture diagnosis",
            "",
            "- System prompt: global identity and safety remain owned by the host runtime; "
            "  Agent Brain adds a narrow routing contract instead of copying that content.",
            "- Tool selection: mounted capability and active capability are now separate "
            "  concepts. The registry scope controls automatic selection.",
            "- Persistence: generated views are derived artifacts. JSON manifests and real "
            "  skill source paths are authoritative.",
            "- Rendering: the HTML dashboard and Obsidian Canvas are generated from the same "
            "  inventory used by `brain status` and `brain explain`.",
            "",
            "## Ordered operating procedure",
            "",
            "1. Run `bin/brain build` after installing, moving, or removing skills.",
            "2. Run `bin/brain status` when context selection is unclear.",
            "3. Run `bin/brain explain <skill>` before using a same-name candidate.",
            "4. Treat `bin/brain validate` failure as a routing/configuration defect.",
            "",
        ]
    )
    return "\n".join(lines)


def generate_relations(inventory: Dict[str, Any]) -> str:
    domains = inventory["domains"]
    projects = inventory["projects"]
    workflows = inventory["workflows"]
    domain_names = {item["id"]: item.get("name", item["id"]) for item in domains}
    project_names = {item["id"]: item.get("name", item["id"]) for item in projects}
    lines = [
        "# Agent Brain relations map",
        "",
        f"Generated: `{inventory['generated_at']}`",
        "",
        "This file is regenerated by `brain build`. Edit manifests, not this report.",
        "",
        "## Domains and projects",
        "",
    ]
    for domain in sorted(domains, key=lambda item: item["id"]):
        members = sorted(
            (item for item in projects if item.get("domain") == domain["id"]),
            key=lambda item: item["id"],
        )
        lines.append(f"- **{domain_names[domain['id']]}** (`{domain['id']}`)")
        for project in members:
            description = project.get("description") or ""
            suffix = f" — {description}" if description else ""
            lines.append(f"  - `{project['id']}`{suffix}")
    orphans = sorted(
        (item for item in projects if item.get("domain") not in domain_names),
        key=lambda item: item["id"],
    )
    for project in orphans:
        lines.append(f"- **(unknown domain `{project.get('domain')}`)**")
        lines.append(f"  - `{project['id']}`")
    lines.append("")

    edges = []
    for project in sorted(projects, key=lambda item: item["id"]):
        for relation in project.get("related_projects", []):
            edges.append((project["id"], relation.get("type", "related"), relation.get("project", "")))
    lines.extend(["## Project relations", ""])
    if edges:
        lines.extend(["```mermaid", "graph LR"])
        for source, relation_type, target in edges:
            lines.append(f"  {slug(source)} -- {relation_type} --> {slug(target)}")
        lines.extend(["```", ""])
        for source, relation_type, target in edges:
            target_name = project_names.get(target, target)
            lines.append(f"- `{source}` **{relation_type}** `{target}` ({target_name})")
    else:
        lines.append("- No project relations registered yet.")
    lines.append("")

    lines.extend(["## Workflows", ""])
    if workflows:
        for workflow in sorted(workflows, key=lambda item: item["id"]):
            steps = ", ".join(f"`{step}`" for step in workflow.get("steps", []))
            scope = workflow.get("project") or workflow.get("domain") or "global"
            lines.append(f"- `{workflow['id']}` ({scope}): {steps}")
    else:
        lines.append("- No workflows registered yet.")
    lines.append("")
    return "\n".join(lines)


def canvas_text(title: str, subtitle: str, color: str) -> str:
    return f"# {title}\n\n{subtitle}\n\n`{color}`"


def generate_canvas(inventory: Dict[str, Any]) -> Dict[str, Any]:
    nodes: List[Dict[str, Any]] = []
    edges: List[Dict[str, Any]] = []
    node_ids = set()

    def add_node(identifier: str, x: int, y: int, width: int, height: int, text: str, color: str) -> None:
        if identifier in node_ids:
            return
        node_ids.add(identifier)
        nodes.append(
            {
                "id": identifier,
                "type": "text",
                "x": x,
                "y": y,
                "width": width,
                "height": height,
                "text": text,
                "color": color,
            }
        )

    def add_edge(source: str, target: str, label: str) -> None:
        edges.append(
            {
                "id": f"edge-{len(edges) + 1}",
                "fromNode": source,
                "fromSide": "right",
                "toNode": target,
                "toSide": "left",
                "label": label,
            }
        )

    add_node("core", 0, 0, 320, 170, "# Global Core\n\nSafety · User invariants · Precedence", "6")
    domain_positions: Dict[str, Tuple[int, int]] = {}
    top_level = [item for item in inventory["domains"] if not item.get("parent")]
    top_offsets = {item["id"]: index * 390 - (len(top_level) - 1) * 195 for index, item in enumerate(top_level)}
    for domain in inventory["domains"]:
        depth = domain["id"].count(".")
        root = domain["id"].split(".")[0]
        x = 460 + depth * 390
        y = top_offsets.get(root, 0)
        if depth:
            siblings = [item for item in inventory["domains"] if item.get("parent") == domain.get("parent")]
            y += siblings.index(domain) * 190
        domain_positions[domain["id"]] = (x, y)
        node_id = f"domain-{slug(domain['id'])}"
        add_node(
            node_id,
            x,
            y,
            320,
            150,
            f"# {domain['name']}\n\n{domain['description']}",
            "4" if root == "work" else "3" if root == "personal" else "5" if root == "creative" else "6",
        )
        parent_id = f"domain-{slug(domain['parent'])}" if domain.get("parent") else "core"
        add_edge(parent_id, node_id, "inherits")

    project_groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for project in inventory["projects"]:
        project_groups[project["domain"]].append(project)
    for domain_id, projects in project_groups.items():
        base_x, base_y = domain_positions.get(domain_id, (850, 0))
        for index, project in enumerate(projects):
            node_id = f"project-{slug(project['id'])}"
            x = base_x + 410
            y = base_y + index * 170
            project_skills = [
                skill for skill in inventory["skills"] if skill["scope"].get("project") == project["id"]
            ]
            add_node(
                node_id,
                x,
                y,
                340,
                140,
                f"# {project['name']}\n\n{len(project_skills)} project skills\n{project['path']}",
                "2",
            )
            add_edge(f"domain-{slug(domain_id)}", node_id, "owns")

    if inventory["collisions"]:
        add_node(
            "collisions",
            0,
            520,
            360,
            170,
            f"# Conflict radar\n\n{len(inventory['collisions'])} same-name source collisions\nOpen views/index.html for details.",
            "1",
        )
        add_edge("core", "collisions", "diagnoses")

    workflow_y = 760
    for index, workflow in enumerate(inventory.get("workflows", [])):
        node_id = f"workflow-{slug(workflow['id'])}"
        add_node(
            node_id,
            0,
            workflow_y + index * 190,
            370,
            160,
            f"# {workflow['name']}\n\n{workflow['description']}\n\n" + " → ".join(workflow.get("steps", [])),
            "5",
        )
        source_id = f"project-{slug(workflow['project'])}" if workflow.get("project") else f"domain-{slug(workflow['domain'])}"
        if source_id in node_ids:
            add_edge(source_id, node_id, "orchestrates")

    return {"nodes": nodes, "edges": edges}


def build_outputs() -> Dict[str, Any]:
    inventory = build_inventory()
    write_json(DATA_PATH, inventory)
    write_text_atomic(AUDIT_PATH, generate_audit(inventory))
    write_text_atomic(RELATIONS_PATH, generate_relations(inventory))
    write_json(CANVAS_PATH, generate_canvas(inventory))

    if not TEMPLATE_PATH.is_file():
        raise FileNotFoundError(f"Missing dashboard template: {TEMPLATE_PATH}")
    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    embedded = json.dumps(inventory, ensure_ascii=False).replace("</", "<\\/")
    rendered = template.replace("__AGENT_BRAIN_DATA__", embedded)
    write_text_atomic(VIEW_PATH, rendered)
    return inventory


def source_snapshot(
    config: Optional[Dict[str, Any]] = None,
    projects: Optional[Sequence[Dict[str, Any]]] = None,
) -> Dict[str, int]:
    snapshot: Dict[str, int] = {}
    for path in [CONFIG_PATH, *REGISTRY_DIR.glob("domains/**/domain.json"), *REGISTRY_DIR.glob("projects/*.json"), *REGISTRY_DIR.glob("workflows/**/*.json")]:
        try:
            snapshot[str(path)] = path.stat().st_mtime_ns
        except OSError:
            continue
    if config is None:
        config = scan_config()
    if projects is None:
        projects = load_projects() if CONFIG_PATH.is_file() else []
    roots = [expand_path(item["path"]) for item in config.get("skill_roots", []) if isinstance(item, dict) and isinstance(item.get("path"), str)]
    for project in projects:
        roots.extend(expand_path(project["path"]) / item for item in project.get("skill_roots", []))
    for root in roots:
        try:
            snapshot[str(root)] = root.stat().st_mtime_ns
        except OSError:
            continue
        for mount_dir, skill_file in walk_skill_files(root):
            for candidate in (mount_dir, skill_file, safe_resolve(skill_file)):
                try:
                    snapshot[str(candidate)] = candidate.stat().st_mtime_ns
                except OSError:
                    continue
    return snapshot


def load_or_build_inventory() -> Dict[str, Any]:
    if DATA_PATH.is_file():
        try:
            inventory = read_json(DATA_PATH)
            if inventory.get("source_snapshot") == source_snapshot():
                return inventory
        except (OSError, ValueError, json.JSONDecodeError):
            pass
    return build_outputs()


def validation_report(inventory: Dict[str, Any]) -> Dict[str, List[str]]:
    errors: List[str] = []
    warnings: List[str] = []
    ids = [item["id"] for item in inventory["skills"]]
    if len(ids) != len(set(ids)):
        errors.append("skill IDs are not unique")
    domain_id_list = [item["id"] for item in inventory["domains"]]
    project_id_list = [item["id"] for item in inventory["projects"]]
    workflow_id_list = [item["id"] for item in inventory.get("workflows", [])]
    if len(domain_id_list) != len(set(domain_id_list)):
        errors.append("domain IDs are not unique")
    if len(project_id_list) != len(set(project_id_list)):
        errors.append("project IDs are not unique")
    if len(workflow_id_list) != len(set(workflow_id_list)):
        errors.append("workflow IDs are not unique")
    domain_ids = set(domain_id_list)
    project_ids = set(project_id_list)
    skill_ids = {item["id"] for item in inventory["skills"]}
    project_domains = {item["id"]: item["domain"] for item in inventory["projects"]}
    config = inventory_config(inventory)
    if config.get("default_domain") not in domain_ids:
        errors.append(f"config default_domain references unknown domain {config.get('default_domain')}")
    for rule in config.get("domain_path_rules", []):
        if rule.get("domain") not in domain_ids:
            errors.append(f"config path rule references unknown domain {rule.get('domain')}")
    for rule in config.get("skill_scope_rules", []):
        if rule.get("level") == "domain" and rule.get("domain") not in domain_ids:
            errors.append(f"config skill scope rule references unknown domain {rule.get('domain')}")
        if rule.get("level") == "project" and rule.get("project") not in project_ids:
            errors.append(f"config skill scope rule references unknown project {rule.get('project')}")
    for domain in inventory["domains"]:
        if domain.get("parent") and domain["parent"] not in domain_ids:
            errors.append(f"domain {domain['id']} references unknown parent {domain['parent']}")
    for project in inventory["projects"]:
        if project["domain"] not in domain_ids:
            errors.append(f"project {project['id']} references unknown domain {project['domain']}")
        if not project.get("exists"):
            warnings.append(f"project path is currently missing: {project['path']}")
        for relation in project.get("related_projects", []):
            if relation.get("project") not in project_ids:
                errors.append(
                    f"project {project['id']} references unknown related project {relation.get('project')}"
                )
        for rule in project.get("workspace_rules", []):
            if not expand_path(rule["root"]).is_dir():
                warnings.append(f"workspace root is currently missing: {rule['root']}")
    for item in inventory["broken_sources"]:
        errors.append(f"configured source missing: {item['path']}")
    for workflow in inventory.get("workflows", []):
        if workflow["domain"] not in domain_ids:
            errors.append(f"workflow {workflow['id']} references unknown domain {workflow['domain']}")
        if workflow.get("project") and workflow["project"] not in project_ids:
            errors.append(f"workflow {workflow['id']} references unknown project {workflow['project']}")
        elif workflow.get("project") and workflow["domain"] != project_domains[workflow["project"]]:
            errors.append(
                f"workflow {workflow['id']} domain {workflow['domain']} does not match "
                f"project {workflow['project']} domain {project_domains[workflow['project']]}"
            )
        for step in workflow.get("steps", []):
            if step not in skill_ids:
                warnings.append(f"workflow {workflow['id']} step is currently unresolved: {step}")
    for collision in inventory["collisions"]:
        if collision.get("status") == "unresolved":
            warnings.append(
                f"{collision['severity']} unresolved same-name collision {collision['name']}: "
                + ", ".join(collision["candidate_ids"])
            )
    for instruction in inventory["instructions"]:
        if instruction.get("scope") == "project" and instruction.get("declared") and not instruction.get("exists"):
            warnings.append(f"declared project instruction is missing: {instruction['path']}")
        if instruction.get("scope") == "global" and not instruction.get("has_agent_brain"):
            warnings.append(f"runtime adapter not connected: {instruction['path']}")
    if "__AGENT_BRAIN_DATA__" in VIEW_PATH.read_text(encoding="utf-8") if VIEW_PATH.is_file() else False:
        errors.append("dashboard still contains the unexpanded data placeholder")
    return {"errors": errors, "warnings": warnings}


def print_status(status: Dict[str, Any]) -> None:
    context = status["context"]
    project = context.get("project")
    print("Agent Brain context")
    print(f"  cwd:      {context['cwd']}")
    print(f"  domain:   {context['domain']} ({context['source']})")
    print(f"  project:  {project['id'] if project else 'none'}")
    print(f"  chain:    {' -> '.join(context['chain'])}")
    print(f"  skills:   {status['active_skill_count']} active, {status['excluded_skill_count']} excluded")
    if status["active_collisions"]:
        print(f"  warnings: {', '.join(status['active_collisions'])}")
    else:
        print("  warnings: none")


def command_build(_: argparse.Namespace) -> int:
    inventory = build_outputs()
    stats = inventory["stats"]
    print(
        f"Built Agent Brain: {stats['skill_sources']} skill sources, "
        f"{stats['project_count']} projects, {stats['collision_count']} collisions"
    )
    print(f"Dashboard: {VIEW_PATH}")
    print(f"Canvas:    {CANVAS_PATH}")
    print(f"Audit:     {AUDIT_PATH}")
    print(f"Relations: {RELATIONS_PATH}")
    return 0


def command_init(args: argparse.Namespace) -> int:
    if CONFIG_PATH.exists() and not args.force:
        print(f"Registry already exists: {REGISTRY_DIR}")
        print("Use --force only if you want to replace the starter files.", file=sys.stderr)
        return 2
    if not DEFAULTS_DIR.is_dir():
        print(f"Starter registry is missing: {DEFAULTS_DIR}", file=sys.stderr)
        return 1
    REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
    for source in sorted(DEFAULTS_DIR.rglob("*")):
        relative = source.relative_to(DEFAULTS_DIR)
        destination = REGISTRY_DIR / relative
        if source.is_dir():
            destination.mkdir(parents=True, exist_ok=True)
        elif args.force or not destination.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
    inventory = build_outputs()
    print(f"Initialized Agent Brain registry: {REGISTRY_DIR}")
    print(
        f"Discovered {inventory['stats']['skill_sources']} skills from "
        f"{inventory['stats']['skill_mounts']} runtime mounts."
    )
    print("Next: edit projects/*.json or use `brain project add /path/to/project`.")
    return 0


def command_project_add(args: argparse.Namespace) -> int:
    if not CONFIG_PATH.is_file():
        print(f"Registry is not initialized: {REGISTRY_DIR}. Run `brain init`.", file=sys.stderr)
        return 2
    project_path = safe_resolve(expand_path(args.path))
    if not project_path.is_dir():
        print(f"Project directory does not exist: {project_path}", file=sys.stderr)
        return 2
    domain_ids = {item["id"] for item in load_domains()}
    if args.domain not in domain_ids:
        print(f"Unknown domain: {args.domain}", file=sys.stderr)
        print("Known domains: " + ", ".join(sorted(domain_ids)), file=sys.stderr)
        return 2
    project_id = slug(args.id or project_path.name)
    destination = REGISTRY_DIR / "projects" / f"{project_id}.json"
    if destination.exists() and not args.force:
        print(f"Project already registered: {destination}", file=sys.stderr)
        return 2
    instruction_files = [name for name in ("AGENTS.md", "CLAUDE.md") if (project_path / name).is_file()]
    skill_roots = [name for name in (".agents/skills", ".codex/skills", ".claude/skills") if (project_path / name).is_dir()]
    manifest = {
        "id": project_id,
        "name": args.name or project_path.name.replace("-", " ").title(),
        "path": str(project_path),
        "domain": args.domain,
        "description": args.description or "",
        "kind": args.kind,
        "aliases": [],
        "instruction_files": instruction_files,
        "skill_roots": skill_roots,
        "related_projects": [],
        "workspace_rules": [],
    }
    write_json(destination, manifest)
    build_outputs()
    print(f"Registered project {project_id}: {destination}")
    return 0


def project_manifest(project_id: str) -> Tuple[Path, Dict[str, Any]]:
    for path in sorted((REGISTRY_DIR / "projects").glob("*.json")):
        project = read_json(path)
        if project.get("id") == project_id:
            return path, project
    raise ValueError(f"Unknown project: {project_id}")


def project_dependencies(project_id: str) -> Dict[str, Any]:
    incoming_relations = []
    for path in sorted((REGISTRY_DIR / "projects").glob("*.json")):
        project = read_json(path)
        for relation in project.get("related_projects", []):
            if relation.get("project") == project_id:
                incoming_relations.append(
                    {"project": project["id"], "type": relation.get("type", "related")}
                )
    workflows = [
        workflow["id"]
        for workflow in load_workflows()
        if workflow.get("project") == project_id
    ]
    return {
        "project": project_id,
        "incoming_relations": incoming_relations,
        "workflows": workflows,
    }


def command_project_dependencies(args: argparse.Namespace) -> int:
    try:
        project_manifest(args.id)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    dependencies = project_dependencies(args.id)
    if args.json:
        print(json.dumps(dependencies, ensure_ascii=False, indent=2))
    else:
        print(
            f"{args.id}: {len(dependencies['incoming_relations'])} incoming relations, "
            f"{len(dependencies['workflows'])} workflows"
        )
    return 0


def command_project_update(args: argparse.Namespace) -> int:
    try:
        destination, project = project_manifest(args.id)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    if args.domain is not None:
        domain_ids = {item["id"] for item in load_domains()}
        if args.domain not in domain_ids:
            print(f"Unknown domain: {args.domain}", file=sys.stderr)
            return 2
        project["domain"] = args.domain
    if args.name is not None:
        if not args.name.strip():
            print("Project name cannot be empty", file=sys.stderr)
            return 2
        project["name"] = args.name.strip()
    if args.description is not None:
        project["description"] = args.description.strip()
    if args.kind is not None:
        if not args.kind.strip():
            print("Project kind cannot be empty", file=sys.stderr)
            return 2
        project["kind"] = args.kind.strip()
    if args.relations_json is not None:
        try:
            relations = json.loads(args.relations_json)
        except json.JSONDecodeError as error:
            print(f"Invalid relations JSON: {error}", file=sys.stderr)
            return 2
        project_ids = {item["id"] for item in load_projects()}
        if not isinstance(relations, list):
            print("Related projects must be an array", file=sys.stderr)
            return 2
        seen_relations = set()
        for relation in relations:
            if not isinstance(relation, dict) or not all(
                isinstance(relation.get(key), str) and relation[key].strip()
                for key in ("project", "type")
            ):
                print("Every project relation needs non-empty project and type strings", file=sys.stderr)
                return 2
            if relation["project"] not in project_ids or relation["project"] == args.id:
                print(f"Invalid related project: {relation['project']}", file=sys.stderr)
                return 2
            key = (relation["project"], relation["type"])
            if key in seen_relations:
                print(f"Duplicate project relation: {relation['type']} {relation['project']}", file=sys.stderr)
                return 2
            seen_relations.add(key)
        project["related_projects"] = relations
    if args.workspace_rules_json is not None:
        try:
            workspace_rules = json.loads(args.workspace_rules_json)
        except json.JSONDecodeError as error:
            print(f"Invalid workspace rules JSON: {error}", file=sys.stderr)
            return 2
        if not isinstance(workspace_rules, list):
            print("Workspace rules must be an array", file=sys.stderr)
            return 2
        for rule in workspace_rules:
            if not isinstance(rule, dict) or not isinstance(rule.get("root"), str) or not rule["root"].strip():
                print("Every workspace rule needs a non-empty root", file=sys.stderr)
                return 2
            if "project_path" in rule and not isinstance(rule["project_path"], str):
                print("Workspace project_path must be a string", file=sys.stderr)
                return 2
            if "dynamic_child" in rule and not isinstance(rule["dynamic_child"], bool):
                print("Workspace dynamic_child must be a boolean", file=sys.stderr)
                return 2
            if "kind" in rule and (not isinstance(rule["kind"], str) or not rule["kind"].strip()):
                print("Workspace kind must be a non-empty string", file=sys.stderr)
                return 2
        project["workspace_rules"] = workspace_rules

    write_json(destination, project)
    if args.domain is not None:
        for workflow_path in sorted((REGISTRY_DIR / "workflows").glob("**/*.json")):
            workflow = read_json(workflow_path)
            if workflow.get("project") == args.id and workflow.get("domain") != args.domain:
                workflow["domain"] = args.domain
                write_json(workflow_path, workflow)
    build_outputs()
    print(f"Updated project {args.id}: {destination}")
    return 0


def command_project_delete(args: argparse.Namespace) -> int:
    try:
        destination, _project = project_manifest(args.id)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    dependencies = project_dependencies(args.id)
    if (dependencies["incoming_relations"] or dependencies["workflows"]) and not args.cascade:
        print(json.dumps(dependencies, ensure_ascii=False), file=sys.stderr)
        print("Project has dependencies; repeat with --cascade to remove their references", file=sys.stderr)
        return 2

    if args.cascade:
        for project_path in sorted((REGISTRY_DIR / "projects").glob("*.json")):
            project = read_json(project_path)
            relations = project.get("related_projects", [])
            filtered = [relation for relation in relations if relation.get("project") != args.id]
            if filtered != relations:
                project["related_projects"] = filtered
                write_json(project_path, project)
        for workflow_path in sorted((REGISTRY_DIR / "workflows").glob("**/*.json")):
            workflow = read_json(workflow_path)
            if workflow.get("project") == args.id:
                workflow_path.unlink()
    destination.unlink()
    build_outputs()
    print(f"Deleted project manifest {args.id}; external project files were not changed")
    return 0


def command_workflow_save(args: argparse.Namespace) -> int:
    domain_ids = {item["id"] for item in load_domains()}
    projects = {item["id"]: item for item in load_projects()}
    if args.domain not in domain_ids:
        print(f"Unknown domain: {args.domain}", file=sys.stderr)
        return 2
    if args.project and args.project not in projects:
        print(f"Unknown project: {args.project}", file=sys.stderr)
        return 2
    if args.project and projects[args.project]["domain"] != args.domain:
        print("Workflow domain must match its project domain", file=sys.stderr)
        return 2
    if not args.name.strip():
        print("Workflow name cannot be empty", file=sys.stderr)
        return 2
    try:
        steps = json.loads(args.steps_json)
    except json.JSONDecodeError as error:
        print(f"Invalid workflow steps JSON: {error}", file=sys.stderr)
        return 2
    if not isinstance(steps, list) or any(not isinstance(step, str) or not step.strip() for step in steps):
        print("Workflow steps must be an array of non-empty skill IDs", file=sys.stderr)
        return 2
    workflow_id = slug(args.id)
    existing = next(
        (
            path for path in sorted((REGISTRY_DIR / "workflows").glob("**/*.json"))
            if read_json(path).get("id") == workflow_id
        ),
        None,
    )
    destination = existing or REGISTRY_DIR / "workflows" / f"{workflow_id}.json"
    if existing and not args.force:
        print(f"Workflow already exists: {workflow_id}", file=sys.stderr)
        return 2
    write_json(destination, {
        "id": workflow_id,
        "name": args.name.strip(),
        "domain": args.domain,
        "project": args.project,
        "description": args.description.strip(),
        "steps": [step.strip() for step in steps],
    })
    build_outputs()
    print(f"Saved workflow {workflow_id}: {destination}")
    return 0


def command_workflow_delete(args: argparse.Namespace) -> int:
    workflow_id = slug(args.id)
    destination = next(
        (
            path for path in sorted((REGISTRY_DIR / "workflows").glob("**/*.json"))
            if read_json(path).get("id") == workflow_id
        ),
        None,
    )
    if destination is None:
        print(f"Unknown workflow: {args.id}", file=sys.stderr)
        return 2
    destination.unlink()
    build_outputs()
    print(f"Deleted workflow {args.id}")
    return 0


def domain_manifest(domain_id: str) -> Tuple[Path, Dict[str, Any]]:
    for path in sorted((REGISTRY_DIR / "domains").glob("**/domain.json")):
        domain = read_json(path)
        if domain.get("id") == domain_id:
            return path, domain
    raise ValueError(f"Unknown domain: {domain_id}")


def command_domain_save(args: argparse.Namespace) -> int:
    domain_ids = {item["id"] for item in load_domains()}
    domain_id = args.id.strip()
    if not re.fullmatch(r"[a-z0-9]+(?:[.-][a-z0-9]+)*", domain_id):
        print("Domain ID must contain lowercase letters, digits, dots, or hyphens", file=sys.stderr)
        return 2
    if not args.name.strip():
        print("Domain name cannot be empty", file=sys.stderr)
        return 2
    if not re.fullmatch(r"#[0-9A-Fa-f]{6}", args.color):
        print("Domain color must be a six-digit hex color", file=sys.stderr)
        return 2
    if not args.icon.strip():
        print("Domain icon cannot be empty", file=sys.stderr)
        return 2
    if args.parent and (args.parent not in domain_ids or args.parent == domain_id):
        print(f"Invalid parent domain: {args.parent}", file=sys.stderr)
        return 2
    if args.parent:
        parents = {item["id"]: item.get("parent") for item in load_domains()}
        cursor = args.parent
        while cursor:
            if cursor == domain_id:
                print("Domain parent would create a cycle", file=sys.stderr)
                return 2
            cursor = parents.get(cursor)
    try:
        destination, domain = domain_manifest(domain_id)
        if not args.force:
            print(f"Domain already exists: {domain_id}", file=sys.stderr)
            return 2
    except ValueError:
        destination = REGISTRY_DIR / "domains" / Path(*domain_id.split(".")) / "domain.json"
        domain = {"id": domain_id}
    domain.update({
        "name": args.name.strip(), "description": args.description.strip(),
        "parent": args.parent, "color": args.color, "icon": args.icon.strip()
    })
    write_json(destination, domain)
    build_outputs()
    print(f"Saved domain {domain_id}: {destination}")
    return 0


def command_domain_dependencies(args: argparse.Namespace) -> int:
    try:
        domain_manifest(args.id)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    config = read_json(CONFIG_PATH)
    config_references = []
    if config.get("default_domain") == args.id:
        config_references.append("default_domain")
    if any(rule.get("domain") == args.id for rule in config.get("domain_path_rules", [])):
        config_references.append("domain_path_rules")
    if any(rule.get("domain") == args.id for rule in config.get("skill_scope_rules", [])):
        config_references.append("skill_scope_rules")
    dependencies = {
        "domain": args.id,
        "children": [item["id"] for item in load_domains() if item.get("parent") == args.id],
        "projects": [item["id"] for item in load_projects() if item.get("domain") == args.id],
        "workflows": [item["id"] for item in load_workflows() if item.get("domain") == args.id],
        "config_references": config_references,
    }
    print(json.dumps(dependencies, ensure_ascii=False, indent=2))
    return 0


def command_domain_delete(args: argparse.Namespace) -> int:
    try:
        destination, _domain = domain_manifest(args.id)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    config = read_json(CONFIG_PATH)
    dependencies = {
        "children": [item["id"] for item in load_domains() if item.get("parent") == args.id],
        "projects": [item["id"] for item in load_projects() if item.get("domain") == args.id],
        "workflows": [item["id"] for item in load_workflows() if item.get("domain") == args.id],
        "config_references": [
            label for label, active in (
                ("default_domain", config.get("default_domain") == args.id),
                ("domain_path_rules", any(rule.get("domain") == args.id for rule in config.get("domain_path_rules", []))),
                ("skill_scope_rules", any(rule.get("domain") == args.id for rule in config.get("skill_scope_rules", []))),
            ) if active
        ],
    }
    if any(dependencies.values()):
        print(json.dumps(dependencies, ensure_ascii=False), file=sys.stderr)
        print("Move or delete dependent items before deleting this domain", file=sys.stderr)
        return 2
    destination.unlink()
    for parent in destination.parents:
        if parent == REGISTRY_DIR / "domains" or any(parent.iterdir()): break
        parent.rmdir()
    build_outputs()
    print(f"Deleted domain {args.id}")
    return 0


def command_skill_scope(args: argparse.Namespace) -> int:
    inventory = build_inventory()
    skill = next((item for item in inventory["skills"] if item["id"] == args.id), None)
    if skill is None:
        print(f"Unknown skill: {args.id}", file=sys.stderr)
        return 2
    if args.level == "domain" and args.domain not in {item["id"] for item in inventory["domains"]}:
        print(f"Unknown domain: {args.domain}", file=sys.stderr)
        return 2
    if args.level == "project" and args.project not in {item["id"] for item in inventory["projects"]}:
        print(f"Unknown project: {args.project}", file=sys.stderr)
        return 2
    if args.level == "plugin" and not args.plugin:
        print("Plugin ID is required for plugin scope", file=sys.stderr)
        return 2
    config = read_json(CONFIG_PATH)
    marker = "gui-source:" + hashlib.sha256(skill["source_path"].encode("utf-8")).hexdigest()[:16]
    rules = [
        rule for rule in config.get("skill_scope_rules", [])
        if rule.get("managed_by") != marker
        and not (
            isinstance(rule.get("managed_by"), str)
            and rule["managed_by"].startswith("gui-source:")
            and rule.get("source_pattern") == f"^{re.escape(skill['source_path'])}$"
        )
    ]
    if args.level != "auto":
        rule = {
            "source_pattern": f"^{re.escape(skill['source_path'])}$",
            "level": args.level,
            "managed_by": marker,
        }
        if args.level == "domain": rule["domain"] = args.domain
        if args.level == "project":
            project = next(item for item in inventory["projects"] if item["id"] == args.project)
            rule["project"] = args.project
            rule["domain"] = project["domain"]
        if args.level == "plugin": rule["plugin"] = args.plugin
        rules.insert(0, rule)
    config["skill_scope_rules"] = rules
    write_json(CONFIG_PATH, config)
    build_outputs()
    print(f"Updated scope for {args.id}")
    return 0


def command_status(args: argparse.Namespace) -> int:
    inventory = load_or_build_inventory()
    if args.domain and args.domain not in {item["id"] for item in inventory["domains"]}:
        print(f"Unknown domain: {args.domain}", file=sys.stderr)
        return 2
    status = context_status(Path(args.cwd), inventory, args.domain)
    if args.json:
        print(json.dumps(status, ensure_ascii=False, indent=2))
    else:
        print_status(status)
    return 0


def command_explain(args: argparse.Namespace) -> int:
    inventory = load_or_build_inventory()
    if args.domain and args.domain not in {item["id"] for item in inventory["domains"]}:
        print(f"Unknown domain: {args.domain}", file=sys.stderr)
        return 2
    status = context_status(Path(args.cwd), inventory, args.domain)
    result = select_skill(args.query, status, inventory)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["selected"] else 2
    if not result["candidates"]:
        print(f"No skill matches: {args.query}")
        return 2
    print(f"Query: {args.query}")
    if result["selected"]:
        selected = result["selected"]
        print(f"Selected: {selected['id']}")
        print(f"Reason:   {result['reason']}")
        print(f"Source:   {selected['source_path']}")
    else:
        print(f"Selected: none")
        print(f"Reason:   {result['reason']}")
    print("Candidates:")
    active_ids = set(status["active_skills"])
    for candidate in result["candidates"]:
        marker = "active" if candidate["id"] in active_ids else "excluded"
        print(f"  - {candidate['id']} [{marker}] -> {candidate['source_path']}")
    return 0 if result["selected"] else 2


def command_validate(_: argparse.Namespace) -> int:
    source_report = validate_source_manifests()
    if source_report["errors"]:
        payload = {
            "ok": False,
            "errors": source_report["errors"],
            "warnings": source_report["warnings"],
            "generated_at": None,
            "stats": {},
        }
        if getattr(_, "json", False):
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            print("Errors:")
            for error in payload["errors"]:
                print(f"  - {error}")
            print(f"Validation failed: {len(payload['errors'])} source errors")
        return 1
    inventory = build_outputs()
    report = validation_report(inventory)
    if getattr(_, "json", False):
        print(
            json.dumps(
                {
                    "ok": not report["errors"],
                    "errors": report["errors"],
                    "warnings": report["warnings"],
                    "generated_at": inventory["generated_at"],
                    "stats": inventory["stats"],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0 if not report["errors"] else 1
    if report["errors"]:
        print("Errors:")
        for error in report["errors"]:
            print(f"  - {error}")
    if report["warnings"]:
        print("Warnings:")
        for warning in report["warnings"]:
            print(f"  - {warning}")
    if report["errors"]:
        print(f"Validation failed: {len(report['errors'])} errors, {len(report['warnings'])} warnings")
        return 1
    print(f"Validation passed: {len(report['warnings'])} warnings")
    return 0


def report_listing_overrides(inventory: Dict[str, Any], overrides: Dict[str, str], applied: bool) -> None:
    limits = inventory_config(inventory).get("listing_limits") or {}
    cap = limits.get("max_desc_chars")
    hidden = [skill for skill in inventory["skills"] if listing_name(skill) in overrides]
    chars = sum(min(len(skill["description"]), cap or len(skill["description"])) + len(skill["name"]) + 12 for skill in hidden)
    verb = "Hidden from the model" if applied else "Would hide"
    print(f"{verb}: {len(overrides)} skills, about {round(chars / 3)} tokens per session. They stay available as /name.")


def command_use(args: argparse.Namespace) -> int:
    if args.domain == "auto":
        if STATE_PATH.exists():
            STATE_PATH.unlink()
        print("Explicit domain override cleared; context will be resolved automatically.")
        if args.skip_overrides or args.dry_run:
            return 0
        write_skill_overrides({})
        print("Skill listing restored: every skill is visible to the model again.")
        return 0
    domain_ids = {item["id"] for item in load_domains()}
    if args.domain not in domain_ids:
        print(f"Unknown domain: {args.domain}", file=sys.stderr)
        print("Known domains: " + ", ".join(sorted(domain_ids)), file=sys.stderr)
        return 2

    inventory = load_or_build_inventory()
    overrides = skill_listing_overrides(inventory, resolve_context(Path(args.cwd), inventory, explicit_domain=args.domain))
    if args.dry_run:
        report_listing_overrides(inventory, overrides, applied=False)
        for name in sorted(overrides):
            print(f"  {name}")
        return 0

    write_json(
        STATE_PATH,
        {
            "schema_version": "agent-brain.active-context.v1",
            "domain": args.domain,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    print(f"Default domain override set to {args.domain}.")
    if args.skip_overrides:
        return 0
    write_skill_overrides(overrides)
    report_listing_overrides(inventory, overrides, applied=True)
    return 0


def command_hook(args: argparse.Namespace) -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        return 0
    cwd = Path(payload.get("cwd") or os.getcwd())
    inventory = load_or_build_inventory()
    status = context_status(cwd, inventory)
    context = status["context"]
    project = context.get("project")
    project_text = project["id"] if project else "none"
    warning_text = ", ".join(status["active_collisions"][:5]) or "none"
    workflow_text = ", ".join(status["active_workflows"]) or "none"
    additional = (
        "## Agent Brain routing context\n\n"
        f"Runtime: {args.runtime}. Domain: `{context['domain']}`. "
        f"Project: `{project_text}`. Resolution source: `{context['source']}`.\n"
        f"Scope chain: `{' -> '.join(context['chain'])}`.\n"
        "Automatically select only global skills plus skills belonging to this "
        "domain/project. A runtime mount does not make a project skill global. "
        "An explicitly named user skill still wins unless it violates higher-level rules.\n"
        f"Active same-name ambiguities: {warning_text}. When ambiguous, run "
        "`brain explain <skill> --cwd \"$PWD\"` before acting.\n"
        f"Relevant registered workflows: {workflow_text}."
    )
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": additional,
                }
            },
            ensure_ascii=False,
        )
    )
    return 0


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


def command_serve(args: argparse.Namespace) -> int:
    build_outputs()
    url = f"http://{args.host}:{args.port}/index.html"
    handler = lambda *handler_args, **handler_kwargs: http.server.SimpleHTTPRequestHandler(  # noqa: E731
        *handler_args, directory=str(REGISTRY_DIR / "views"), **handler_kwargs
    )
    with ReusableTCPServer((args.host, args.port), handler) as server:
        print(f"Agent Brain dashboard: {url}")
        if args.open_browser:
            threading.Timer(0.25, lambda: webbrowser.open(url)).start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


def create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Agent Brain context registry")
    parser.add_argument(
        "--registry",
        default=os.environ.get("AGENT_BRAIN_HOME", str(DEFAULT_REGISTRY_DIR)),
        help="registry directory (default: ~/.agent-brain or AGENT_BRAIN_HOME)",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    build_parser = subparsers.add_parser("build", help="rebuild inventory and visualizations")
    build_parser.set_defaults(func=command_build)

    init_parser = subparsers.add_parser("init", help="initialize a portable registry with starter domains")
    init_parser.add_argument("--force", action="store_true", help="replace starter files that already exist")
    init_parser.set_defaults(func=command_init)

    project_parser = subparsers.add_parser("project", help="manage project manifests")
    project_subparsers = project_parser.add_subparsers(dest="project_command", required=True)
    project_add_parser = project_subparsers.add_parser("add", help="register an existing project directory")
    project_add_parser.add_argument("path")
    project_add_parser.add_argument("--id")
    project_add_parser.add_argument("--name")
    project_add_parser.add_argument("--domain", default="personal.software")
    project_add_parser.add_argument("--description")
    project_add_parser.add_argument("--kind", default="software-project")
    project_add_parser.add_argument("--force", action="store_true")
    project_add_parser.set_defaults(func=command_project_add)
    project_update_parser = project_subparsers.add_parser("update", help="update project metadata")
    project_update_parser.add_argument("id")
    project_update_parser.add_argument("--name")
    project_update_parser.add_argument("--domain")
    project_update_parser.add_argument("--description")
    project_update_parser.add_argument("--kind")
    project_update_parser.add_argument("--relations-json")
    project_update_parser.add_argument("--workspace-rules-json")
    project_update_parser.set_defaults(func=command_project_update)
    project_dependencies_parser = project_subparsers.add_parser("dependencies", help="show project dependencies")
    project_dependencies_parser.add_argument("id")
    project_dependencies_parser.add_argument("--json", action="store_true")
    project_dependencies_parser.set_defaults(func=command_project_dependencies)
    project_delete_parser = project_subparsers.add_parser("delete", help="delete a project manifest")
    project_delete_parser.add_argument("id")
    project_delete_parser.add_argument("--cascade", action="store_true")
    project_delete_parser.set_defaults(func=command_project_delete)

    workflow_parser = subparsers.add_parser("workflow", help="manage workflow manifests")
    workflow_subparsers = workflow_parser.add_subparsers(dest="workflow_command", required=True)
    workflow_save_parser = workflow_subparsers.add_parser("save", help="create or update a workflow")
    workflow_save_parser.add_argument("id")
    workflow_save_parser.add_argument("--name", required=True)
    workflow_save_parser.add_argument("--domain", required=True)
    workflow_save_parser.add_argument("--project")
    workflow_save_parser.add_argument("--description", default="")
    workflow_save_parser.add_argument("--steps-json", required=True)
    workflow_save_parser.add_argument("--force", action="store_true")
    workflow_save_parser.set_defaults(func=command_workflow_save)
    workflow_delete_parser = workflow_subparsers.add_parser("delete", help="delete a workflow")
    workflow_delete_parser.add_argument("id")
    workflow_delete_parser.set_defaults(func=command_workflow_delete)

    domain_parser = subparsers.add_parser("domain", help="manage domain manifests")
    domain_subparsers = domain_parser.add_subparsers(dest="domain_command", required=True)
    domain_save_parser = domain_subparsers.add_parser("save", help="create or update a domain")
    domain_save_parser.add_argument("id")
    domain_save_parser.add_argument("--name", required=True)
    domain_save_parser.add_argument("--description", default="")
    domain_save_parser.add_argument("--parent")
    domain_save_parser.add_argument("--color", default="#4AA8FF")
    domain_save_parser.add_argument("--icon", default="circle")
    domain_save_parser.add_argument("--force", action="store_true")
    domain_save_parser.set_defaults(func=command_domain_save)
    domain_dependencies_parser = domain_subparsers.add_parser("dependencies", help="show domain dependencies")
    domain_dependencies_parser.add_argument("id")
    domain_dependencies_parser.set_defaults(func=command_domain_dependencies)
    domain_delete_parser = domain_subparsers.add_parser("delete", help="delete an empty domain")
    domain_delete_parser.add_argument("id")
    domain_delete_parser.set_defaults(func=command_domain_delete)

    skill_parser = subparsers.add_parser("skill", help="manage skill ownership overrides")
    skill_subparsers = skill_parser.add_subparsers(dest="skill_command", required=True)
    skill_scope_parser = skill_subparsers.add_parser("scope", help="change a skill scope")
    skill_scope_parser.add_argument("id")
    skill_scope_parser.add_argument("--level", choices=["auto", "global", "domain", "project", "plugin", "archive"], required=True)
    skill_scope_parser.add_argument("--domain")
    skill_scope_parser.add_argument("--project")
    skill_scope_parser.add_argument("--plugin")
    skill_scope_parser.set_defaults(func=command_skill_scope)

    status_parser = subparsers.add_parser("status", help="resolve active context")
    status_parser.add_argument("--cwd", default=os.getcwd())
    status_parser.add_argument("--domain")
    status_parser.add_argument("--json", action="store_true")
    status_parser.set_defaults(func=command_status)

    explain_parser = subparsers.add_parser("explain", help="explain skill selection")
    explain_parser.add_argument("query")
    explain_parser.add_argument("--cwd", default=os.getcwd())
    explain_parser.add_argument("--domain")
    explain_parser.add_argument("--json", action="store_true")
    explain_parser.set_defaults(func=command_explain)

    validate_parser = subparsers.add_parser("validate", help="validate registry and generated outputs")
    validate_parser.add_argument("--json", action="store_true")
    validate_parser.set_defaults(func=command_validate)

    use_parser = subparsers.add_parser("use", help="set a default domain override and hide out-of-context skills")
    use_parser.add_argument("domain", help="domain ID or 'auto'")
    use_parser.add_argument("--cwd", default=str(Path.cwd()), help="workspace path used to resolve the project")
    use_parser.add_argument("--dry-run", action="store_true", help="list what would be hidden, change nothing")
    use_parser.add_argument("--skip-overrides", action="store_true", help="switch domain without touching runtime settings")
    use_parser.set_defaults(func=command_use)

    hook_parser = subparsers.add_parser("hook", help="emit UserPromptSubmit context")
    hook_parser.add_argument("--runtime", choices=["codex", "claude"], required=True)
    hook_parser.set_defaults(func=command_hook)

    serve_parser = subparsers.add_parser("serve", help="serve the dashboard locally")
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", type=int, default=8765)
    serve_parser.add_argument("--open-browser", action="store_true")
    serve_parser.set_defaults(func=command_serve)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = create_parser().parse_args(argv)
    configure_paths(Path(args.registry))
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
