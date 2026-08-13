import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import brain


class AgentBrainTests(unittest.TestCase):
    def setUp(self):
        self.inventory = {
            "generated_at": "2026-08-12T00:00:00+00:00",
            "domains": [
                {"id": "work", "parent": None},
                {"id": "work.company", "parent": "work"},
                {"id": "personal", "parent": None},
                {"id": "meta", "parent": None},
                {"id": "meta.agent-system", "parent": "meta"},
            ],
            "projects": [
                {
                    "id": "alpha",
                    "name": "Alpha",
                    "path": "/tmp/brain-tests/alpha",
                    "domain": "work.company",
                }
            ],
            "skills": [
                {
                    "id": "global.review",
                    "name": "review",
                    "scope": {"level": "global", "domain": None, "project": None, "plugin": None},
                    "source_path": "/skills/global-review",
                    "mount_count": 1,
                },
                {
                    "id": "domain.work.company.vcs",
                    "name": "vcs",
                    "scope": {"level": "domain", "domain": "work.company", "project": None, "plugin": None},
                    "source_path": "/skills/vcs",
                    "mount_count": 1,
                },
                {
                    "id": "project.alpha.review",
                    "name": "review",
                    "scope": {"level": "project", "domain": "work.company", "project": "alpha", "plugin": None},
                    "source_path": "/skills/alpha-review",
                    "mount_count": 1,
                },
                {
                    "id": "archive.review.deadbee",
                    "name": "review",
                    "scope": {"level": "archive", "domain": None, "project": None, "plugin": None},
                    "source_path": "/skills/archive-review",
                    "mount_count": 1,
                },
            ],
            "collisions": [
                {"normalized_name": "review", "name": "review"}
            ],
        }
        self.config = {
            "default_domain": "meta.agent-system",
            "domain_path_rules": [
                {"path": "/tmp/brain-tests", "domain": "work.company"}
            ],
        }
        self.inventory["config"] = self.config

    def test_project_context_wins_over_path_domain(self):
        context = brain.resolve_context(
            Path("/tmp/brain-tests/alpha/src"),
            self.inventory,
            config=self.config,
        )
        self.assertEqual(context["domain"], "work.company")
        self.assertEqual(context["project"]["id"], "alpha")
        self.assertEqual(context["source"], "project")
        self.assertEqual(context["chain"], ["work", "work.company", "project:alpha"])

    def test_dynamic_workspace_resolves_to_canonical_project(self):
        self.inventory["projects"][0]["workspace_rules"] = [
            {
                "root": "/tmp/brain-worktrees",
                "dynamic_child": True,
                "project_path": "services/alpha",
                "kind": "worktree",
            }
        ]
        context = brain.resolve_context(
            Path("/tmp/brain-worktrees/TASK-42/services/alpha/src"),
            self.inventory,
            config=self.config,
        )
        self.assertEqual(context["project"]["id"], "alpha")
        self.assertEqual(context["workspace"]["id"], "TASK-42")
        self.assertEqual(context["source"], "workspace")
        self.assertEqual(
            context["chain"],
            ["work", "work.company", "project:alpha", "workspace:TASK-42"],
        )

    def test_unmatched_worktree_is_workspace_not_project(self):
        config = {
            "default_domain": "meta.agent-system",
            "domain_path_rules": [
                {
                    "path": "/tmp/brain-worktrees",
                    "domain": "work.company",
                    "dynamic_project": True,
                }
            ],
        }
        context = brain.resolve_context(
            Path("/tmp/brain-worktrees/UNKNOWN/path"),
            self.inventory,
            config=config,
        )
        self.assertIsNone(context["project"])
        self.assertEqual(context["workspace"]["id"], "UNKNOWN")
        self.assertEqual(context["chain"], ["work", "work.company", "workspace:UNKNOWN"])

    def test_explicit_domain_overrides_project_context(self):
        context = brain.resolve_context(
            Path("/tmp/brain-tests/alpha/src"),
            self.inventory,
            config=self.config,
            explicit_domain="personal",
        )
        self.assertEqual(context["domain"], "personal")
        self.assertIsNone(context["project"])
        self.assertIsNone(context["workspace"])
        self.assertEqual(context["source"], "explicit")

    def test_dynamic_workspace_expands_home_directory(self):
        config = {
            "default_domain": "meta.agent-system",
            "domain_path_rules": [
                {"path": "~/Projects", "domain": "personal", "dynamic_project": True}
            ],
        }
        with mock.patch.dict(os.environ, {"HOME": "/tmp/brain-home"}):
            context = brain.resolve_context(
                Path("/tmp/brain-home/Projects/sample/src"),
                self.inventory,
                config=config,
            )
        self.assertEqual(context["workspace"]["path"], str(Path("/tmp/brain-home/Projects/sample").resolve()))

    def test_project_skill_is_excluded_outside_project(self):
        context = {
            "domain": "work.company",
            "project": None,
        }
        project_skill = self.inventory["skills"][2]
        self.assertFalse(brain.skill_is_active(project_skill, context))
        self.assertTrue(brain.skill_is_active(self.inventory["skills"][1], context))

    def test_plugin_skill_requires_explicit_activation(self):
        plugin_skill = {
            "scope": {"level": "plugin", "plugin": "review-pack", "domain": None, "project": None}
        }
        context = {"domain": "personal", "project": None, "active_plugins": []}
        self.assertFalse(brain.skill_is_active(plugin_skill, context))
        context["active_plugins"] = ["review-pack"]
        self.assertTrue(brain.skill_is_active(plugin_skill, context))

    def test_unicode_project_slugs_remain_distinct(self):
        self.assertEqual(brain.slug("мой-проект"), "мой-проект")
        self.assertEqual(brain.slug("日本語"), "日本語")
        self.assertNotEqual(brain.slug("мой-проект"), brain.slug("日本語"))

    def test_project_skill_outranks_global_same_name(self):
        status = {
            "active_skills": ["global.review", "domain.work.company.vcs", "project.alpha.review"]
        }
        result = brain.select_skill("review", status, self.inventory)
        self.assertEqual(result["selected"]["id"], "project.alpha.review")

    def test_equal_scope_collision_requires_explicit_id(self):
        duplicate = dict(self.inventory["skills"][0])
        duplicate["id"] = "global.review.other"
        duplicate["source_path"] = "/skills/global-review-other"
        self.inventory["skills"].append(duplicate)
        status = {"active_skills": ["global.review", "global.review.other"]}
        result = brain.select_skill("review", status, self.inventory)
        self.assertIsNone(result["selected"])
        self.assertIn("equally specific", result["reason"])

    def test_same_name_in_different_projects_is_contextually_resolved(self):
        first_scope = {"level": "project", "domain": "work.company", "project": "alpha", "plugin": None}
        second_scope = {"level": "project", "domain": "work.company", "project": "beta", "plugin": None}
        self.assertFalse(brain.scopes_can_be_active_together(first_scope, second_scope))

    def test_explicit_namespaced_id_is_selected(self):
        status = {"active_skills": ["global.review", "project.alpha.review"]}
        result = brain.select_skill("global.review", status, self.inventory)
        self.assertEqual(result["selected"]["id"], "global.review")
        self.assertEqual(result["reason"], "explicit namespaced ID")

    def test_explicit_namespaced_id_overrides_automatic_context(self):
        status = {"active_skills": ["global.review"]}
        result = brain.select_skill("domain.work.company.vcs", status, self.inventory)
        self.assertEqual(result["selected"]["id"], "domain.work.company.vcs")
        self.assertEqual(result["reason"], "explicit namespaced ID")

    def test_archived_namespaced_id_cannot_be_selected(self):
        status = {"active_skills": ["global.review"]}
        result = brain.select_skill("archive.review.deadbee", status, self.inventory)
        self.assertIsNone(result["selected"])
        self.assertEqual(result["reason"], "archived packages cannot be selected")

    def test_exact_name_does_not_include_substring_matches(self):
        other = dict(self.inventory["skills"][0])
        other["id"] = "global.review-helper"
        other["name"] = "review-helper"
        self.inventory["skills"].append(other)
        status = {"active_skills": ["global.review", "global.review-helper"]}
        result = brain.select_skill("review", status, self.inventory)
        self.assertNotIn("global.review-helper", [item["id"] for item in result["candidates"]])

    def test_archive_is_never_active(self):
        context = {"domain": "work.company", "project": {"id": "alpha"}}
        self.assertFalse(brain.skill_is_active(self.inventory["skills"][3], context))

    def test_package_fingerprint_changes_with_content(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory)
            skill = package / "SKILL.md"
            skill.write_text("name: one\n", encoding="utf-8")
            first = brain.package_fingerprint(package)
            skill.write_text("name: two\n", encoding="utf-8")
            second = brain.package_fingerprint(package)
        self.assertNotEqual(first, second)

    def test_symlinked_project_skill_keeps_project_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "project"
            external = root / "external-skill"
            mount_root = project / ".agents" / "skills"
            mount_root.mkdir(parents=True)
            external.mkdir()
            (external / "SKILL.md").write_text("---\nname: linked\ndescription: linked\n---\n", encoding="utf-8")
            (mount_root / "linked").symlink_to(external, target_is_directory=True)
            config = {"skill_roots": []}
            projects = [{"id": "sample", "domain": "personal.software", "path": str(project), "skill_roots": [".agents/skills"]}]
            occurrences, broken = brain.collect_skill_occurrences(config, projects)
        self.assertEqual(broken, [])
        self.assertEqual(occurrences[0]["scope"]["level"], "project")
        self.assertEqual(occurrences[0]["scope"]["project"], "sample")

    def test_source_snapshot_changes_when_skill_content_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            skill_root = root / "skills"
            skill = skill_root / "sample" / "SKILL.md"
            skill.parent.mkdir(parents=True)
            skill.write_text("---\nname: sample\n---\nfirst\n", encoding="utf-8")
            config = {"skill_roots": [{"path": str(skill_root)}]}
            first = brain.source_snapshot(config, [])
            skill.write_text("---\nname: sample\n---\nsecond\n", encoding="utf-8")
            second = brain.source_snapshot(config, [])
        self.assertNotEqual(first, second)

    def test_configured_canonical_source_outranks_checkout_copy(self):
        scope = {"level": "domain", "domain": "work.company", "project": None, "plugin": None}
        config = {
            "source_priority_rules": [
                {"source_pattern": "/opt/company/canonical/", "priority": 980, "role": "canonical"},
                {"source_pattern": "/opt/company/checkouts/", "priority": 520, "role": "checkout"},
            ]
        }
        primary, _ = brain.source_priority("vcs", "/opt/company/canonical/vcs", scope, config)
        copy, _ = brain.source_priority("vcs", "/opt/company/checkouts/vcs", scope, config)
        self.assertGreater(primary, copy)

    def test_hook_emits_compact_routing_context(self):
        hook_inventory = dict(self.inventory)
        hook_inventory["collisions"] = []
        with mock.patch.object(brain, "load_or_build_inventory", return_value=hook_inventory), mock.patch.object(
            brain, "read_active_override", return_value=None
        ), mock.patch("sys.stdin.read", return_value=json.dumps({"cwd": "/tmp/brain-tests/alpha"})), mock.patch(
            "builtins.print"
        ) as output:
            args = type("Args", (), {"runtime": "codex"})()
            result = brain.command_hook(args)
        self.assertEqual(result, 0)
        payload = json.loads(output.call_args.args[0])
        context = payload["hookSpecificOutput"]["additionalContext"]
        self.assertIn("work.company", context)
        self.assertIn("project:alpha", context)

    def test_validation_checks_project_relations_and_workflow_project(self):
        inventory = dict(self.inventory)
        inventory.update(
            {
                "broken_sources": [],
                "instructions": [],
                "workflows": [
                    {
                        "id": "workflow.bad",
                        "domain": "work.company",
                        "project": "missing-project",
                        "steps": [],
                    }
                ],
            }
        )
        inventory["projects"][0]["related_projects"] = [
            {"project": "missing-related", "type": "uses"}
        ]
        report = brain.validation_report(inventory)
        self.assertIn(
            "project alpha references unknown related project missing-related",
            report["errors"],
        )
        self.assertIn(
            "workflow workflow.bad references unknown project missing-project",
            report["errors"],
        )

    def test_validation_rejects_duplicate_project_ids_and_unknown_domain_parent(self):
        inventory = dict(self.inventory)
        inventory.update({"broken_sources": [], "instructions": [], "workflows": []})
        inventory["projects"] = [self.inventory["projects"][0], dict(self.inventory["projects"][0])]
        inventory["domains"] = [*self.inventory["domains"], {"id": "orphan", "parent": "missing"}]
        report = brain.validation_report(inventory)
        self.assertIn("project IDs are not unique", report["errors"])
        self.assertIn("domain orphan references unknown parent missing", report["errors"])

    def test_source_validation_reports_malformed_containers_without_crashing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "config").mkdir()
            (root / "projects").mkdir()
            (root / "config" / "brain.json").write_text(
                json.dumps(
                    {
                        "default_domain": "meta",
                        "skill_roots": None,
                        "instruction_files": [],
                        "domain_path_rules": [],
                    }
                ),
                encoding="utf-8",
            )
            (root / "projects" / "bad.json").write_text(
                json.dumps(
                    {
                        "id": "bad",
                        "name": "Bad",
                        "path": "/tmp/bad",
                        "domain": "meta",
                        "instruction_files": [1],
                        "skill_roots": [2],
                        "related_projects": None,
                        "workspace_rules": None,
                    }
                ),
                encoding="utf-8",
            )
            report = brain.validate_source_manifests(root)
        self.assertIn("config/brain.json: skill_roots must be an array", report["errors"])
        self.assertIn("projects/bad.json: instruction_files[0] must be a non-empty string", report["errors"])
        self.assertIn("projects/bad.json: related_projects must be an array", report["errors"])

    def test_source_validation_requires_complete_skill_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "config").mkdir()
            (root / "config" / "brain.json").write_text(
                json.dumps(
                    {
                        "default_domain": "meta",
                        "skill_roots": [{"path": "/tmp/skills"}],
                        "instruction_files": [],
                        "domain_path_rules": [],
                    }
                ),
                encoding="utf-8",
            )
            report = brain.validate_source_manifests(root)
        self.assertIn("config/brain.json: runtime must be a non-empty string", report["errors"])
        self.assertIn("config/brain.json: kind must be a non-empty string", report["errors"])

    def test_source_validation_reports_malformed_json(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "config").mkdir()
            (root / "config" / "brain.json").write_text("{broken", encoding="utf-8")
            report = brain.validate_source_manifests(root)
        self.assertEqual(len(report["errors"]), 1)
        self.assertIn("config/brain.json: invalid JSON object", report["errors"][0])

    def test_source_validation_rejects_invalid_scope_regex(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "config").mkdir()
            (root / "config" / "brain.json").write_text(
                json.dumps(
                    {
                        "default_domain": "meta",
                        "skill_roots": [],
                        "instruction_files": [],
                        "domain_path_rules": [],
                        "skill_scope_rules": [
                            {"source_pattern": "[", "level": "domain", "domain": "work"}
                        ],
                    }
                ),
                encoding="utf-8",
            )
            report = brain.validate_source_manifests(root)
        self.assertTrue(any("source_pattern is invalid" in error for error in report["errors"]))


if __name__ == "__main__":
    unittest.main()
