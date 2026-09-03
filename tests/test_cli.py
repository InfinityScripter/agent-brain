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

    def test_version_flag_matches_package_json(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            registry = home / ".agent-brain"
            result = self.run_brain(home, registry, "--version")
            self.assertEqual(result.returncode, 0, result.stderr)
            package_version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
            self.assertEqual(result.stdout.strip(), f"agent-brain {package_version}")

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

            inspected_text = self.run_brain(home, registry, "inspect", "--cwd", str(project))
            self.assertEqual(inspected_text.returncode, 0, inspected_text.stderr)
            self.assertIn("Folder: ", inspected_text.stdout)
            self.assertIn("react-best-practices", inspected_text.stdout)
            self.assertIn("Rules (1):", inspected_text.stdout)
            self.assertIn("[on ] style", inspected_text.stdout)

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

            recommended_text = self.run_brain(home, registry, "recommend", "--cwd", str(project))
            self.assertEqual(recommended_text.returncode, 0, recommended_text.stderr)
            self.assertIn("Detected in the code:", recommended_text.stdout)
            self.assertIn("Worth enabling here:", recommended_text.stdout)
            self.assertIn("react-best-practices", recommended_text.stdout)
            self.assertIn("Gap: ", recommended_text.stdout)

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

    def test_status_explain_use_and_domain_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            registry = home / ".agent-brain"
            project = home / "Projects" / "shop"
            skill = project / ".agents" / "skills" / "review"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text("---\nname: review\ndescription: Review\n---\n", encoding="utf-8")
            self.assertEqual(self.run_brain(home, registry, "init").returncode, 0)
            self.assertEqual(
                self.run_brain(home, registry, "project", "add", str(project), "--domain", "personal.software").returncode,
                0,
            )

            status_json = self.run_brain(home, registry, "status", "--cwd", str(project), "--json")
            self.assertEqual(status_json.returncode, 0, status_json.stderr)
            status = json.loads(status_json.stdout)
            self.assertEqual(status["context"]["domain"], "personal.software")
            self.assertEqual(status["context"]["project"]["id"], "shop")
            self.assertGreaterEqual(status["active_skill_count"], 1)

            status_text = self.run_brain(home, registry, "status", "--cwd", str(project))
            self.assertEqual(status_text.returncode, 0, status_text.stderr)
            self.assertIn("Agent Brain context", status_text.stdout)
            self.assertIn("domain:   personal.software", status_text.stdout)
            self.assertIn("project:  shop", status_text.stdout)

            unknown_status = self.run_brain(home, registry, "status", "--cwd", str(project), "--domain", "ghost")
            self.assertEqual(unknown_status.returncode, 2)
            self.assertIn("Unknown domain: ghost", unknown_status.stderr)

            explain_json = self.run_brain(home, registry, "explain", "review", "--cwd", str(project), "--json")
            self.assertEqual(explain_json.returncode, 0, explain_json.stderr)
            explanation = json.loads(explain_json.stdout)
            self.assertEqual(explanation["selected"]["id"], "project.shop.review")

            explain_text = self.run_brain(home, registry, "explain", "review", "--cwd", str(project))
            self.assertEqual(explain_text.returncode, 0, explain_text.stderr)
            self.assertIn("Selected: project.shop.review", explain_text.stdout)
            self.assertIn("Reason:", explain_text.stdout)
            self.assertIn("Candidates:", explain_text.stdout)

            explain_miss = self.run_brain(home, registry, "explain", "does-not-exist", "--cwd", str(project))
            self.assertEqual(explain_miss.returncode, 2)
            self.assertIn("No skill matches: does-not-exist", explain_miss.stdout)

            created_domain = self.run_brain(
                home, registry, "domain", "save", "research", "--name", "Research"
            )
            self.assertEqual(created_domain.returncode, 0, created_domain.stderr)
            second = home / "Projects" / "second"
            second.mkdir(parents=True)
            self.assertEqual(
                self.run_brain(home, registry, "project", "add", str(second), "--domain", "research").returncode, 0
            )
            workflow = self.run_brain(
                home, registry, "workflow", "save", "study", "--name", "Study",
                "--domain", "research", "--steps-json", "[]"
            )
            self.assertEqual(workflow.returncode, 0, workflow.stderr)

            dependencies = self.run_brain(home, registry, "domain", "dependencies", "research")
            self.assertEqual(dependencies.returncode, 0, dependencies.stderr)
            payload = json.loads(dependencies.stdout)
            self.assertEqual(payload["projects"], ["second"])
            self.assertEqual(payload["workflows"], ["study"])

            unknown_domain = self.run_brain(home, registry, "domain", "dependencies", "ghost")
            self.assertEqual(unknown_domain.returncode, 2)

            dry_run = self.run_brain(home, registry, "use", "research", "--cwd", str(project), "--dry-run")
            self.assertEqual(dry_run.returncode, 0, dry_run.stderr)
            self.assertIn("Would hide", dry_run.stdout)
            self.assertFalse((registry / "state" / "active-context.json").exists())

            used = self.run_brain(home, registry, "use", "research", "--cwd", str(project))
            self.assertEqual(used.returncode, 0, used.stderr)
            self.assertIn("Default domain override set to research.", used.stdout)
            self.assertIn("Hidden from the model", used.stdout)
            state = json.loads((registry / "state" / "active-context.json").read_text(encoding="utf-8"))
            self.assertEqual(state["domain"], "research")

            cleared = self.run_brain(home, registry, "use", "auto")
            self.assertEqual(cleared.returncode, 0, cleared.stderr)
            self.assertIn("Explicit domain override cleared", cleared.stdout)
            self.assertFalse((registry / "state" / "active-context.json").exists())

            unknown_use = self.run_brain(home, registry, "use", "ghost")
            self.assertEqual(unknown_use.returncode, 2)
            self.assertIn("Unknown domain: ghost", unknown_use.stderr)


if __name__ == "__main__":
    unittest.main()
