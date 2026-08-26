import json
import tempfile
import unittest
from pathlib import Path

import brain


def make_skill(name, level="global", **extra):
    skill = {
        "id": f"{level}.{name}",
        "name": name,
        "description": extra.pop("description", f"{name} skill"),
        "scope": {"level": level, "domain": extra.pop("domain", None), "project": extra.pop("project", None), "plugin": extra.pop("plugin", None)},
        "runtimes": ["claude"],
        "model_invocable": True,
        "source_path": f"/skills/{name}",
        "mount_count": 1,
        "usage": {"count": extra.pop("usage_count", 0), "last_used": None, "days_idle": None, "counter_key": None},
    }
    skill.update(extra)
    return skill


class HarnessInventoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        self.folder = self.home / "apps" / "shop"
        self.folder.mkdir(parents=True)
        self.inventory = {
            "generated_at": "2026-08-26T00:00:00+00:00",
            "domains": [{"id": "personal", "parent": None}],
            "projects": [],
            "workflows": [],
            "collisions": [],
            "skills": [
                make_skill("review"),
                make_skill("deploy", level="project", domain="personal", project="other"),
            ],
            "config": {"default_domain": "personal", "domain_path_rules": [], "active_plugins": []},
        }

    def write_settings(self, path, overrides=None, hooks=None):
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {}
        if overrides is not None:
            payload["skillOverrides"] = overrides
        if hooks is not None:
            payload["hooks"] = hooks
        path.write_text(json.dumps(payload), encoding="utf-8")

    def harness(self):
        return brain.harness_inventory(self.folder, self.inventory, home=self.home)

    def test_settings_chain_merges_project_over_user(self):
        self.write_settings(self.home / ".claude" / "settings.json", overrides={"review": "off"})
        self.write_settings(self.folder / ".claude" / "settings.json", overrides={"review": "on"})
        harness = self.harness()
        review = next(item for item in harness["skills"] if item["listed_name"] == "review")
        self.assertEqual(review["override"]["effective"], "on")
        self.assertEqual(review["override"]["level"], "project")

    def test_local_settings_beat_project(self):
        self.write_settings(self.folder / ".claude" / "settings.json", overrides={"review": "on"})
        self.write_settings(self.folder / ".claude" / "settings.local.json", overrides={"review": "off"})
        review = next(item for item in self.harness()["skills"] if item["listed_name"] == "review")
        self.assertEqual(review["override"]["effective"], "off")
        self.assertEqual(review["override"]["level"], "local")

    def test_skill_without_override_reports_none(self):
        review = next(item for item in self.harness()["skills"] if item["listed_name"] == "review")
        self.assertIsNone(review["override"]["effective"])
        self.assertTrue(review["active"])
        other_project = next(item for item in self.harness()["skills"] if item["listed_name"] == "deploy")
        self.assertFalse(other_project["active"])

    def test_rules_discovered_with_enabled_flags(self):
        user_rules = self.home / ".claude" / "rules"
        user_rules.mkdir(parents=True)
        (user_rules / "style.md").write_text("# Style rule\n\nKeep it short.\n", encoding="utf-8")
        (user_rules / "legacy.md.disabled").write_text("# Legacy\n", encoding="utf-8")
        folder_rules = self.folder / ".claude" / "rules"
        folder_rules.mkdir(parents=True)
        (folder_rules / "api.md").write_text("# API rule\n", encoding="utf-8")
        rules = self.harness()["rules"]
        by_name = {item["name"]: item for item in rules}
        self.assertTrue(by_name["style"]["enabled"])
        self.assertEqual(by_name["style"]["location"], "user")
        self.assertEqual(by_name["style"]["title"], "Style rule")
        self.assertFalse(by_name["legacy"]["enabled"])
        self.assertTrue(by_name["api"]["enabled"])
        self.assertEqual(by_name["api"]["location"], "folder")

    def test_instruction_chain_walks_up_to_home(self):
        (self.folder / "CLAUDE.md").write_text("# Shop\n", encoding="utf-8")
        (self.home / "apps" / "CLAUDE.md").write_text("# Apps umbrella\n", encoding="utf-8")
        (self.home / ".claude").mkdir(parents=True, exist_ok=True)
        (self.home / ".claude" / "CLAUDE.md").write_text("# User memo\n", encoding="utf-8")
        paths = [item["path"] for item in self.harness()["instructions"]]
        self.assertIn(str((self.folder / "CLAUDE.md").resolve()), paths)
        self.assertIn(str((self.home / "apps" / "CLAUDE.md").resolve()), paths)
        self.assertIn(str(self.home / ".claude" / "CLAUDE.md"), paths)

    def test_mcp_inventory_redacts_secrets(self):
        payload = {
            "mcpServers": {
                "tracker": {
                    "type": "stdio",
                    "command": "tracker-mcp",
                    "args": ["--token", "SECRET-VALUE"],
                    "env": {"API_KEY": "TOP-SECRET"},
                }
            }
        }
        (self.folder / ".mcp.json").write_text(json.dumps(payload), encoding="utf-8")
        harness = self.harness()
        server = next(item for item in harness["mcp"] if item["name"] == "tracker")
        self.assertEqual(server["transport"], "stdio")
        dumped = json.dumps(harness)
        self.assertNotIn("SECRET-VALUE", dumped)
        self.assertNotIn("TOP-SECRET", dumped)

    def test_explicit_on_override_makes_inactive_skill_visible(self):
        self.write_settings(self.folder / ".claude" / "settings.local.json", overrides={"deploy": "on"})
        deploy = next(item for item in self.harness()["skills"] if item["listed_name"] == "deploy")
        self.assertFalse(deploy["active"])
        self.assertTrue(deploy["visible"])

    def test_symlinked_rules_dir_is_not_recognized(self):
        outside = self.home / "documents"
        outside.mkdir(parents=True)
        (outside / "taxes.md").write_text("# Taxes\n\nvery-private-number\n", encoding="utf-8")
        claude = self.folder / ".claude"
        claude.mkdir(parents=True)
        (claude / "rules").symlink_to(outside)
        harness = self.harness()
        self.assertEqual(harness["rules"], [])
        self.assertNotIn("very-private-number", json.dumps(harness))
        self.assertEqual(brain.rule_dirs_for(self.folder, self.home), [])

    def test_symlinked_rule_file_is_skipped(self):
        rules = self.home / ".claude" / "rules"
        rules.mkdir(parents=True)
        secret = self.home / "secret.md"
        secret.write_text("# Secret\n\ntop-secret-token\n", encoding="utf-8")
        (rules / "leak.md").symlink_to(secret)
        harness = self.harness()
        self.assertEqual(harness["rules"], [])
        self.assertNotIn("top-secret-token", json.dumps(harness))

    def test_hooks_and_agents_reported(self):
        hooks = {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "check.sh"}]}]}
        self.write_settings(self.home / ".claude" / "settings.json", hooks=hooks)
        agents_dir = self.folder / ".claude" / "agents"
        agents_dir.mkdir(parents=True)
        (agents_dir / "reviewer.md").write_text("---\ndescription: Reviews code\n---\n", encoding="utf-8")
        harness = self.harness()
        user_settings = next(item for item in harness["settings_files"] if item["level"] == "user")
        self.assertEqual(user_settings["hooks"], {"PreToolUse": 1})
        agent = next(item for item in harness["agents"] if item["name"] == "reviewer")
        self.assertEqual(agent["location"], "folder")


class ToggleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.settings = self.root / ".claude" / "settings.local.json"
        self.inventory = {"skills": [make_skill("review")], "config": {}}

    def test_toggle_skill_off_merges_and_backs_up(self):
        self.settings.parent.mkdir(parents=True)
        self.settings.write_text(json.dumps({"skillOverrides": {"other": "on"}, "model": "opus"}), encoding="utf-8")
        brain.toggle_skill("review", "off", self.settings, self.inventory)
        data = json.loads(self.settings.read_text(encoding="utf-8"))
        self.assertEqual(data["skillOverrides"]["review"], "off")
        self.assertEqual(data["skillOverrides"]["other"], "on")
        self.assertEqual(data["model"], "opus")
        self.assertTrue(self.settings.with_name(self.settings.name + ".brain-backup").is_file())

    def test_toggle_skill_on_sets_explicit_on(self):
        brain.toggle_skill("review", "on", self.settings, self.inventory)
        data = json.loads(self.settings.read_text(encoding="utf-8"))
        self.assertEqual(data["skillOverrides"]["review"], "on")

    def test_toggle_skill_unknown_name_rejected(self):
        with self.assertRaises(ValueError):
            brain.toggle_skill("ghost", "off", self.settings, self.inventory)

    def test_toggle_rule_roundtrip(self):
        rules_dir = self.root / "rules"
        rules_dir.mkdir()
        (rules_dir / "style.md").write_text("# Style\n", encoding="utf-8")
        state = brain.toggle_rule("style", "off", [rules_dir])
        self.assertFalse(state["enabled"])
        self.assertTrue((rules_dir / "style.md.disabled").is_file())
        self.assertFalse((rules_dir / "style.md").exists())
        state = brain.toggle_rule("style", "on", [rules_dir])
        self.assertTrue(state["enabled"])
        self.assertTrue((rules_dir / "style.md").is_file())

    def test_toggle_rule_is_idempotent(self):
        rules_dir = self.root / "rules"
        rules_dir.mkdir()
        (rules_dir / "style.md").write_text("# Style\n", encoding="utf-8")
        brain.toggle_rule("style", "on", [rules_dir])
        self.assertTrue((rules_dir / "style.md").is_file())

    def test_toggle_rule_rejects_escape(self):
        rules_dir = self.root / "rules"
        rules_dir.mkdir()
        outside = self.root / "outside.md"
        outside.write_text("# Outside\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            brain.toggle_rule(str(outside), "off", [rules_dir])
        (rules_dir / "link.md").symlink_to(outside)
        with self.assertRaises(ValueError):
            brain.toggle_rule("link", "off", [rules_dir])

    def test_toggle_rule_unknown_rejected(self):
        rules_dir = self.root / "rules"
        rules_dir.mkdir()
        with self.assertRaises(ValueError):
            brain.toggle_rule("ghost", "off", [rules_dir])

    def test_toggle_skill_refuses_corrupt_settings(self):
        self.settings.parent.mkdir(parents=True)
        self.settings.write_text("{ broken json", encoding="utf-8")
        with self.assertRaises(ValueError):
            brain.toggle_skill("review", "off", self.settings, self.inventory)
        self.assertEqual(self.settings.read_text(encoding="utf-8"), "{ broken json")

    def test_toggle_rule_ambiguous_name_requires_path(self):
        first = self.root / "user-rules"
        second = self.root / "folder-rules"
        for directory in (first, second):
            directory.mkdir()
            (directory / "style.md").write_text("# Style\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            brain.toggle_rule("style", "off", [first, second])
        state = brain.toggle_rule(str((second / "style.md").resolve()), "off", [first, second])
        self.assertFalse(state["enabled"])
        self.assertTrue((first / "style.md").is_file())
        self.assertTrue((second / "style.md.disabled").is_file())

    def test_toggle_rule_path_must_be_markdown(self):
        rules_dir = self.root / "rules"
        rules_dir.mkdir()
        notes = rules_dir / "notes.txt"
        notes.write_text("just notes\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            brain.toggle_rule(str(notes), "off", [rules_dir])
        self.assertTrue(notes.is_file())


class RecommendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        self.folder = self.home / "apps" / "shop"
        self.folder.mkdir(parents=True)
        self.inventory = {
            "generated_at": "2026-08-26T00:00:00+00:00",
            "domains": [{"id": "personal", "parent": None}],
            "projects": [],
            "workflows": [],
            "collisions": [],
            "skills": [
                make_skill("react-best-practices", level="domain", domain="work", description="React component guidance"),
                make_skill("typescript-best-practices"),
                make_skill("unrelated-ops", level="project", domain="personal", project="other"),
            ],
            "config": {"default_domain": "personal", "domain_path_rules": [], "active_plugins": []},
        }

    def recommend(self):
        harness = brain.harness_inventory(self.folder, self.inventory, home=self.home)
        return brain.recommend_for_folder(harness)

    def test_react_signal_recommends_hidden_react_skill(self):
        (self.folder / "package.json").write_text(
            json.dumps({"dependencies": {"react": "19.0.0"}, "devDependencies": {"typescript": "5.5.0"}}),
            encoding="utf-8",
        )
        result = self.recommend()
        names = {item["listed_name"]: item for item in result["recommendations"]}
        self.assertIn("react-best-practices", names)
        self.assertEqual(names["react-best-practices"]["status"], "recommended")
        self.assertIn("package.json", names["react-best-practices"]["reasons"][0])
        self.assertIn("typescript-best-practices", names)
        self.assertEqual(names["typescript-best-practices"]["status"], "already-active")

    def test_recommendations_deduped_across_signals(self):
        (self.folder / "package.json").write_text(
            json.dumps({"dependencies": {"typescript": "5.5.0"}}), encoding="utf-8"
        )
        (self.folder / "tsconfig.json").write_text("{}", encoding="utf-8")
        result = self.recommend()
        listed = [item["listed_name"] for item in result["recommendations"]]
        self.assertEqual(len(listed), len(set(listed)))

    def test_gap_hint_for_missing_claude_md(self):
        result = self.recommend()
        self.assertTrue(any("CLAUDE.md" in gap for gap in result["gaps"]))
        (self.folder / "CLAUDE.md").write_text("# Shop\n", encoding="utf-8")
        result = self.recommend()
        self.assertFalse(any("CLAUDE.md" in gap for gap in result["gaps"]))


if __name__ == "__main__":
    unittest.main()
