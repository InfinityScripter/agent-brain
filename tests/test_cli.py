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


if __name__ == "__main__":
    unittest.main()
