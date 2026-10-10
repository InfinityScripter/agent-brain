import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BRAIN = ROOT / "brain.py"


class AgentBrainCliTests(unittest.TestCase):
    def run_brain(self, home: Path, registry: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(BRAIN), "--registry", str(registry), *args],
            cwd=ROOT,
            env={**os.environ, "HOME": str(home)},
            check=False,
            capture_output=True,
            text=True,
        )

    def test_clean_init_validate_and_project_add(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            registry = home / ".agent-brain"
            project = home / "Projects" / "sample-app"
            project.mkdir(parents=True)
            (project / "AGENTS.md").write_text("# Sample agent rules\n", encoding="utf-8")
            skill = project / ".agents" / "skills" / "sample"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text("---\nname: sample\ndescription: Example skill\n---\n", encoding="utf-8")

            initialized = self.run_brain(home, registry, "init")
            self.assertEqual(initialized.returncode, 0, initialized.stderr)
            self.assertTrue((registry / "config" / "brain.json").is_file())

            added = self.run_brain(home, registry, "project", "add", str(project), "--domain", "personal.software")
            self.assertEqual(added.returncode, 0, added.stderr)
            manifest = (registry / "projects" / "sample-app.json").read_text(encoding="utf-8")
            self.assertIn('"AGENTS.md"', manifest)
            self.assertIn('".agents/skills"', manifest)

            validated = self.run_brain(home, registry, "validate", "--json")
            self.assertEqual(validated.returncode, 0, validated.stdout + validated.stderr)
            self.assertIn('"ok": true', validated.stdout)

            safe_id = self.run_brain(
                home,
                registry,
                "project",
                "add",
                str(project),
                "--id",
                "../../safe-id",
                "--domain",
                "personal.software",
                "--force",
            )
            self.assertEqual(safe_id.returncode, 0, safe_id.stderr)
            self.assertTrue((registry / "projects" / "safe-id.json").is_file())

    def test_project_update_dependencies_and_safe_delete(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            registry = home / ".agent-brain"
            first = home / "Projects" / "first"
            second = home / "Projects" / "second"
            first.mkdir(parents=True)
            second.mkdir(parents=True)
            self.assertEqual(self.run_brain(home, registry, "init").returncode, 0)
            self.assertEqual(self.run_brain(home, registry, "project", "add", str(first), "--domain", "personal.software").returncode, 0)
            self.assertEqual(self.run_brain(home, registry, "project", "add", str(second), "--domain", "personal.software").returncode, 0)

            second_manifest = registry / "projects" / "second.json"
            second_data = json.loads(second_manifest.read_text(encoding="utf-8"))
            second_data["related_projects"] = [{"project": "first", "type": "uses"}]
            second_manifest.write_text(json.dumps(second_data), encoding="utf-8")
            workflow = registry / "workflows" / "first.json"
            workflow.write_text(json.dumps({
                "id": "first-flow", "name": "First flow", "domain": "personal.software",
                "project": "first", "description": "", "steps": []
            }), encoding="utf-8")

            dependencies = self.run_brain(home, registry, "project", "dependencies", "first", "--json")
            self.assertEqual(dependencies.returncode, 0, dependencies.stderr)
            self.assertIn('"project": "second"', dependencies.stdout)
            self.assertIn('"first-flow"', dependencies.stdout)

            blocked = self.run_brain(home, registry, "project", "delete", "first")
            self.assertEqual(blocked.returncode, 2)
            self.assertTrue((registry / "projects" / "first.json").is_file())

            updated = self.run_brain(
                home, registry, "project", "update", "first", "--name", "First Product",
                "--domain", "work", "--description", "Moved to work"
            )
            self.assertEqual(updated.returncode, 0, updated.stderr)
            updated_data = json.loads((registry / "projects" / "first.json").read_text(encoding="utf-8"))
            self.assertEqual(updated_data["name"], "First Product")
            self.assertEqual(updated_data["domain"], "work")
            workflow_data = json.loads(workflow.read_text(encoding="utf-8"))
            self.assertEqual(workflow_data["domain"], "work")

            deleted = self.run_brain(home, registry, "project", "delete", "first", "--cascade")
            self.assertEqual(deleted.returncode, 0, deleted.stderr)
            self.assertFalse((registry / "projects" / "first.json").exists())
            self.assertTrue(first.is_dir())
            self.assertFalse(workflow.exists())
            second_data = json.loads(second_manifest.read_text(encoding="utf-8"))
            self.assertEqual(second_data["related_projects"], [])

    def test_inspect_toggle_and_recommend(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            registry = home / ".agent-brain"
            project = home / "Projects" / "shop"
            project.mkdir(parents=True)
            (project / "package.json").write_text(
                json.dumps({"dependencies": {"react": "19.0.0"}}), encoding="utf-8"
            )
            rules = home / ".claude" / "rules"
            rules.mkdir(parents=True)
            (rules / "style.md").write_text("# Style rule\n\nKeep it short.\n", encoding="utf-8")
            skill = home / ".claude" / "skills" / "react-best-practices"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text(
                "---\nname: react-best-practices\ndescription: React guidance\n---\n", encoding="utf-8"
            )

            initialized = self.run_brain(home, registry, "init")
            self.assertEqual(initialized.returncode, 0, initialized.stderr)
            added = self.run_brain(home, registry, "project", "add", str(project), "--domain", "personal.software")
            self.assertEqual(added.returncode, 0, added.stderr)

            inspected = self.run_brain(home, registry, "inspect", "--cwd", str(project), "--json")
            self.assertEqual(inspected.returncode, 0, inspected.stderr)
            harness = json.loads(inspected.stdout)
            react = next(item for item in harness["skills"] if item["listed_name"] == "react-best-practices")
            self.assertTrue(react["active"])
            self.assertIsNone(react["override"]["effective"])
            style = next(item for item in harness["rules"] if item["name"] == "style")
            self.assertTrue(style["enabled"])
            self.assertEqual(style["location"], "user")

            toggled = self.run_brain(home, registry, "skill", "off", "react-best-practices", "--cwd", str(project))
            self.assertEqual(toggled.returncode, 0, toggled.stderr)
            local_settings = json.loads(
                (project / ".claude" / "settings.local.json").read_text(encoding="utf-8")
            )
            self.assertEqual(local_settings["skillOverrides"]["react-best-practices"], "off")

            inspected = self.run_brain(home, registry, "inspect", "--cwd", str(project), "--json")
            harness = json.loads(inspected.stdout)
            react = next(item for item in harness["skills"] if item["listed_name"] == "react-best-practices")
            self.assertEqual(react["override"], {"effective": "off", "level": "local"})

            rule_off = self.run_brain(home, registry, "rule", "off", "style", "--cwd", str(project))
            self.assertEqual(rule_off.returncode, 0, rule_off.stderr)
            self.assertTrue((rules / "style.md.disabled").is_file())
            rule_on = self.run_brain(home, registry, "rule", "on", "style", "--cwd", str(project))
            self.assertEqual(rule_on.returncode, 0, rule_on.stderr)
            self.assertTrue((rules / "style.md").is_file())

            recommended = self.run_brain(home, registry, "recommend", "--cwd", str(project), "--json")
            self.assertEqual(recommended.returncode, 0, recommended.stderr)
            advice = json.loads(recommended.stdout)
            react_advice = next(
                item for item in advice["recommendations"] if item["listed_name"] == "react-best-practices"
            )
            self.assertEqual(react_advice["status"], "recommended")
            self.assertTrue(any("react" in reason for reason in react_advice["reasons"]))
            self.assertTrue(any("CLAUDE.md" in gap for gap in advice["gaps"]))

            unknown = self.run_brain(home, registry, "skill", "off", "ghost", "--cwd", str(project))
            self.assertEqual(unknown.returncode, 2)

    def test_build_generates_relations_map(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            registry = home / ".agent-brain"
            first = home / "Projects" / "first"
            second = home / "Projects" / "second"
            first.mkdir(parents=True)
            second.mkdir(parents=True)
            self.assertEqual(self.run_brain(home, registry, "init").returncode, 0)
            self.assertEqual(self.run_brain(home, registry, "project", "add", str(first), "--domain", "personal.software").returncode, 0)
            self.assertEqual(self.run_brain(home, registry, "project", "add", str(second), "--domain", "personal.software").returncode, 0)
            related = self.run_brain(
                home, registry, "project", "update", "second",
                "--relations-json", '[{"project": "first", "type": "uses"}]'
            )
            self.assertEqual(related.returncode, 0, related.stderr)
            workflow = self.run_brain(
                home, registry, "workflow", "save", "release", "--name", "Release",
                "--domain", "personal.software", "--steps-json", '["global.review"]'
            )
            self.assertEqual(workflow.returncode, 0, workflow.stderr)

            built = self.run_brain(home, registry, "build")
            self.assertEqual(built.returncode, 0, built.stderr)
            relations = (registry / "reports" / "relations.md").read_text(encoding="utf-8")
            self.assertIn("second -- uses --> first", relations)
            self.assertIn("- `second` **uses** `first`", relations)
            self.assertIn("(`personal.software`)", relations)
            self.assertIn("`first`", relations)
            self.assertIn("(personal.software): `global.review`", relations)

    def test_domain_workflow_and_skill_scope_crud(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            registry = home / ".agent-brain"
            project = home / "Projects" / "sample"
            skill = project / ".agents" / "skills" / "review"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text("---\nname: review\ndescription: Review\n---\n", encoding="utf-8")
            self.assertEqual(self.run_brain(home, registry, "init").returncode, 0)

            created_domain = self.run_brain(
                home, registry, "domain", "save", "work.studio", "--name", "Studio",
                "--description", "Studio work", "--parent", "work", "--color", "#123456"
            )
            self.assertEqual(created_domain.returncode, 0, created_domain.stderr)
            self.assertEqual(self.run_brain(home, registry, "project", "add", str(project), "--domain", "work.studio").returncode, 0)

            created_workflow = self.run_brain(
                home, registry, "workflow", "save", "delivery", "--name", "Delivery",
                "--domain", "work.studio", "--project", "sample", "--steps-json", "[]"
            )
            self.assertEqual(created_workflow.returncode, 0, created_workflow.stderr)
            updated_workflow = self.run_brain(
                home, registry, "workflow", "save", "delivery", "--name", "Delivery 2",
                "--domain", "work.studio", "--project", "sample", "--steps-json", "[]", "--force"
            )
            self.assertEqual(updated_workflow.returncode, 0, updated_workflow.stderr)
            workflows = list((registry / "workflows").glob("*.json"))
            self.assertEqual(len(workflows), 1)
            self.assertEqual(json.loads(workflows[0].read_text(encoding="utf-8"))["name"], "Delivery 2")

            scope = self.run_brain(
                home, registry, "skill", "scope", "project.sample.review",
                "--level", "domain", "--domain", "work.studio"
            )
            self.assertEqual(scope.returncode, 0, scope.stderr)
            inventory = json.loads((registry / "data" / "inventory.json").read_text(encoding="utf-8"))
            self.assertTrue(any(item["id"] == "domain.work.studio.review" for item in inventory["skills"]))
            automatic = self.run_brain(
                home, registry, "skill", "scope", "domain.work.studio.review", "--level", "auto"
            )
            self.assertEqual(automatic.returncode, 0, automatic.stderr)
            inventory = json.loads((registry / "data" / "inventory.json").read_text(encoding="utf-8"))
            self.assertTrue(any(item["id"] == "project.sample.review" for item in inventory["skills"]))

            blocked_domain = self.run_brain(home, registry, "domain", "delete", "work.studio")
            self.assertEqual(blocked_domain.returncode, 2)
            self.assertEqual(self.run_brain(home, registry, "workflow", "delete", "delivery").returncode, 0)
            self.assertEqual(self.run_brain(home, registry, "project", "delete", "sample", "--cascade").returncode, 0)
            self.assertEqual(self.run_brain(home, registry, "domain", "delete", "work.studio").returncode, 0)

    def test_folder_profile_apply_check_and_reset(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            registry = home / ".agent-brain"
            notes = home / "notes"
            notes.mkdir()
            local = notes / ".claude" / "settings.local.json"
            for name in ("deploy", "release"):
                (home / ".claude" / "skills" / name).mkdir(parents=True)
            (home / ".claude" / "skills" / "deploy" / "SKILL.md").write_text("---\nname: deploy\ndescription: d\n---\n", encoding="utf-8")
            self.assertEqual(self.run_brain(home, registry, "init").returncode, 0)
            config_path = registry / "config" / "brain.json"
            config = json.loads(config_path.read_text(encoding="utf-8"))
            config["skill_scope_rules"] = [{"names": ["deploy", "release"], "level": "domain", "domain": "work"}]
            config["domain_path_rules"].append({"path": str(notes), "domain": "personal"})
            config_path.write_text(json.dumps(config), encoding="utf-8")

            foreign = self.run_brain(home, registry, "use", "work", "--settings", "local", "--cwd", str(notes))
            self.assertEqual(foreign.returncode, 2)
            self.assertIn("resolves to personal", foreign.stderr)
            dry = self.run_brain(home, registry, "use", "personal", "--settings", "local", "--cwd", str(notes), "--dry-run", "--json")
            self.assertEqual(dry.returncode, 0, dry.stderr)
            self.assertEqual(json.loads(dry.stdout)["hide"], ["deploy"])
            self.assertFalse(local.exists())

            applied = self.run_brain(home, registry, "use", "personal", "--settings", "local", "--cwd", str(notes))
            self.assertEqual(applied.returncode, 0, applied.stderr)
            self.assertEqual(json.loads(local.read_text(encoding="utf-8"))["skillOverrides"], {"deploy": "user-invocable-only"})
            self.assertFalse((registry / "state" / "active-context.json").exists())
            fresh = self.run_brain(home, registry, "profile", "--cwd", str(notes))
            self.assertEqual((fresh.returncode, fresh.stdout), (0, ""), fresh.stderr)

            (home / ".claude" / "skills" / "release" / "SKILL.md").write_text("---\nname: release\ndescription: d\n---\n", encoding="utf-8")
            stale = self.run_brain(home, registry, "profile", "--cwd", str(notes))
            self.assertEqual(stale.returncode, 0, stale.stderr)
            self.assertEqual(len(stale.stdout.splitlines()), 1)
            self.assertIn(f"brain use personal --settings local --cwd {notes.resolve()}", stale.stdout)
            self.assertTrue(json.loads(self.run_brain(home, registry, "profile", "--cwd", str(notes), "--json").stdout)["stale"])

            reset = self.run_brain(home, registry, "use", "auto", "--settings", "local", "--cwd", str(notes))
            self.assertEqual(reset.returncode, 0, reset.stderr)
            self.assertNotIn("skillOverrides", json.loads(local.read_text(encoding="utf-8")))
            self.assertIsNone(json.loads(self.run_brain(home, registry, "profile", "--cwd", str(notes), "--json").stdout)["applied"])

    def test_use_auto_dry_run_and_unrecorded_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            registry = home / ".agent-brain"
            notes = home / "notes"
            notes.mkdir()
            self.assertEqual(self.run_brain(home, registry, "init").returncode, 0)
            settings = home / ".claude" / "settings.json"
            settings.parent.mkdir(parents=True)
            settings.write_text(json.dumps({"skillOverrides": {"menu-choice": "user-invocable-only"}}), encoding="utf-8")
            self.assertEqual(self.run_brain(home, registry, "use", "personal").returncode, 0)
            state = registry / "state" / "active-context.json"
            self.assertTrue(state.exists())

            dry = self.run_brain(home, registry, "use", "auto", "--dry-run")
            self.assertEqual(dry.returncode, 0, dry.stderr)
            self.assertTrue(state.exists())

            reset = self.run_brain(home, registry, "use", "auto")
            self.assertIn("1 hidden entries brain has no record of writing stay", reset.stdout)
            self.assertEqual(json.loads(settings.read_text(encoding="utf-8"))["skillOverrides"], {"menu-choice": "user-invocable-only"})

            untouched = self.run_brain(home, registry, "use", "auto", "--settings", "local", "--cwd", str(notes))
            self.assertEqual(untouched.returncode, 0, untouched.stderr)
            self.assertFalse((notes / ".claude").exists())

    def test_prefs_prints_the_table_and_marks_where_each_row_applies(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            registry = home / ".agent-brain"
            self.assertEqual(self.run_brain(home, registry, "init").returncode, 0)
            config_path = registry / "config" / "brain.json"
            config = json.loads(config_path.read_text(encoding="utf-8"))
            config["skill_preference_headers"] = ["Задача", "Беру", "Не беру следом"]
            config["skill_preferences"] = [
                {"task": "Тесты до кода", "use": "test-driven-development", "instead_of": ["superpowers:test-driven-development"], "except_domains": ["personal"]},
            ]
            config_path.write_text(json.dumps(config), encoding="utf-8")

            table = self.run_brain(home, registry, "prefs")
            scoped = self.run_brain(home, registry, "prefs", "--json", "--domain", "personal")

            self.assertEqual(table.returncode, 0, table.stderr)
            self.assertIn("| Тесты до кода | `test-driven-development` | `superpowers:test-driven-development` |", table.stdout)
            self.assertEqual(scoped.returncode, 0, scoped.stderr)
            payload = json.loads(scoped.stdout)
            self.assertEqual(payload["domain"], "personal")
            self.assertEqual([row["applies"] for row in payload["preferences"]], [False])

    def test_archived_skill_scope_is_reset_by_its_listed_name(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            registry = home / ".agent-brain"
            skill = home / ".claude" / "skills" / "drafts"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text("---\nname: drafts\ndescription: d\n---\n", encoding="utf-8")
            self.assertEqual(self.run_brain(home, registry, "init").returncode, 0)
            archived = self.run_brain(home, registry, "skill", "scope", "global.drafts", "--level", "archive")
            self.assertEqual(archived.returncode, 0, archived.stderr)

            restored = self.run_brain(home, registry, "skill", "scope", "drafts", "--level", "auto")

            self.assertEqual(restored.returncode, 0, restored.stderr)
            inventory = json.loads((registry / "data" / "inventory.json").read_text(encoding="utf-8"))
            self.assertTrue(any(item["id"] == "global.drafts" for item in inventory["skills"]))


if __name__ == "__main__":
    unittest.main()
