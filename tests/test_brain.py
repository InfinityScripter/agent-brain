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


class ClaudePluginTests(unittest.TestCase):
    """Plugin skills installed by Claude Code under ~/.claude/plugins."""

    def test_plugin_identity_uses_plugin_name_not_marketplace(self):
        source = Path("/home/u/.claude/plugins/cache/thedotmack/claude-mem/13.12.4/skills/babysit")
        self.assertEqual(brain.plugin_identity(source), "claude-mem")

    def test_plugin_identity_handles_commit_sha_versions(self):
        source = Path("/home/u/.claude/plugins/cache/claude-plugins-official/frontend-design/5fd8350ff8ed/skills/x")
        self.assertEqual(brain.plugin_identity(source), "frontend-design")

    def test_codex_plugin_identity_is_unchanged(self):
        source = Path("/home/u/.codex/plugins/cache/superpowers/1.2.0/skills/brainstorming")
        self.assertEqual(brain.plugin_identity(source), "superpowers")

    def test_plugin_roots_point_at_installed_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            install = root / "cache" / "thedotmack" / "claude-mem" / "13.12.4"
            (install / "skills").mkdir(parents=True)
            (root / "installed_plugins.json").write_text(
                json.dumps(
                    {
                        "version": 2,
                        "plugins": {
                            "claude-mem@thedotmack": [{"scope": "user", "installPath": str(install)}],
                            "absent@somewhere": [{"scope": "user", "installPath": str(root / "missing")}],
                        },
                    }
                ),
                encoding="utf-8",
            )
            roots = brain.plugin_skill_roots(root)
        self.assertEqual(len(roots), 1)
        self.assertEqual(roots[0]["path"], str(install / "skills"))
        self.assertEqual(roots[0]["runtime"], "claude")

    def test_plugin_roots_skip_project_scoped_installs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            install = root / "cache" / "m" / "p" / "1.0.0"
            (install / "skills").mkdir(parents=True)
            (root / "installed_plugins.json").write_text(
                json.dumps({"plugins": {"p@m": [{"scope": "project", "installPath": str(install)}]}}),
                encoding="utf-8",
            )
            roots = brain.plugin_skill_roots(root)
        self.assertEqual(roots, [])

    def test_missing_plugin_registry_yields_no_roots(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(brain.plugin_skill_roots(Path(directory) / "absent"), [])

    def make_plugin(self, root: Path, manifest_skills, skill_names) -> Path:
        install = root / "cache" / "market" / "demo" / "1.0.0"
        (install / ".claude-plugin").mkdir(parents=True)
        for name in skill_names:
            skill_dir = install / "skills" / name
            skill_dir.mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text(f"---\nname: {name}\ndescription: d\n---\n", encoding="utf-8")
        manifest = {"name": "demo"}
        if manifest_skills is not None:
            manifest["skills"] = manifest_skills
        (install / ".claude-plugin" / "plugin.json").write_text(json.dumps(manifest), encoding="utf-8")
        (root / "installed_plugins.json").write_text(
            json.dumps({"plugins": {"demo@market": [{"scope": "user", "installPath": str(install)}]}}),
            encoding="utf-8",
        )
        return install

    def test_manifest_limits_root_to_declared_skills(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            install = self.make_plugin(root, ["./skills/wanted"], ["wanted", "leftover"])
            roots = brain.plugin_skill_roots(root)
        self.assertEqual(roots[0]["declared"], [str(install / "skills" / "wanted")])

    def test_plugin_without_manifest_list_declares_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.make_plugin(root, None, ["only"])
            roots = brain.plugin_skill_roots(root)
        self.assertNotIn("declared", roots[0])

    def test_undeclared_plugin_skill_is_not_collected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.make_plugin(root, ["./skills/wanted"], ["wanted", "leftover"])
            config = {"skill_roots": brain.plugin_skill_roots(root)}
            occurrences, _broken = brain.collect_skill_occurrences(config, [])
        self.assertEqual([item["logical_name"] for item in occurrences], ["wanted"])

    def test_scan_config_appends_plugin_roots_without_duplicates(self):
        discovered = [
            {"path": "/skills/shared", "runtime": "claude", "kind": "mount", "plugin": "dup"},
            {"path": "/plugins/mem/skills", "runtime": "claude", "kind": "mount", "plugin": "claude-mem"},
        ]
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "brain.json"
            config_path.write_text(
                json.dumps({"skill_roots": [{"path": "/skills/shared", "runtime": "shared", "kind": "canonical"}]}),
                encoding="utf-8",
            )
            with mock.patch.object(brain, "CONFIG_PATH", config_path), mock.patch.object(
                brain, "plugin_skill_roots", return_value=discovered
            ):
                config = brain.scan_config()
        self.assertEqual([item["path"] for item in config["skill_roots"]], ["/skills/shared", "/plugins/mem/skills"])

    def test_listing_limits_read_from_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            path.write_text(
                json.dumps({"skillListingMaxDescChars": 200, "skillListingBudgetFraction": 0.05}),
                encoding="utf-8",
            )
            limits = brain.read_listing_limits(path)
        self.assertEqual(limits, {"max_desc_chars": 200, "budget_fraction": 0.05})

    def test_listing_limits_absent_settings_are_empty(self):
        with tempfile.TemporaryDirectory() as directory:
            limits = brain.read_listing_limits(Path(directory) / "absent.json")
        self.assertEqual(limits, {"max_desc_chars": None, "budget_fraction": None})

    def test_enabled_plugins_drop_marketplace_suffix(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            path.write_text(
                json.dumps({"enabledPlugins": {"superpowers@official": True, "ponytail@ponytail": False}}),
                encoding="utf-8",
            )
            self.assertEqual(brain.read_enabled_plugins(path), ["superpowers"])


class ListingOverrideTests(unittest.TestCase):
    """Turning registry scope into skillOverrides the runtime understands."""

    def skill(self, name, level, **scope):
        skill = {
            "id": f"{level}.{name}",
            "name": name,
            "description": "d",
            "runtimes": scope.pop("runtimes", ["claude"]),
            "model_invocable": scope.pop("model_invocable", True),
        }
        if "loaded_runtimes" in scope:
            skill["loaded_runtimes"] = scope.pop("loaded_runtimes")
        skill["scope"] = {"level": level, "domain": None, "project": None, "plugin": None, **scope}
        return skill

    def overrides(self, skills, context):
        return brain.skill_listing_overrides({"skills": skills}, context)

    def test_skill_outside_context_is_hidden_from_model(self):
        skills = [self.skill("deploy", "domain", domain="work.company")]
        context = {"domain": "personal", "project": None}
        self.assertEqual(self.overrides(skills, context), {"deploy": "user-invocable-only"})

    def test_active_skill_is_left_alone(self):
        skills = [self.skill("deploy", "domain", domain="work.company")]
        context = {"domain": "work.company", "project": None}
        self.assertEqual(self.overrides(skills, context), {})

    def test_name_shared_with_an_active_skill_is_never_hidden(self):
        skills = [
            self.skill("review", "domain", domain="work.company"),
            self.skill("review", "global"),
        ]
        context = {"domain": "personal", "project": None}
        self.assertEqual(self.overrides(skills, context), {})

    def test_plugin_skill_outside_context_is_reported_not_written(self):
        # Claude Code ignores skillOverrides for plugin skills, so a key for one is dead weight.
        skill = self.skill("babysit", "domain", domain="work.company")
        skill["plugin_source"] = "claude-mem"
        context = {"domain": "personal", "project": None, "active_plugins": ["claude-mem"]}
        self.assertEqual(self.overrides([skill], context), {})
        self.assertEqual(brain.unhideable_plugin_skills({"skills": [skill]}, context), ["claude-mem:babysit"])

    def test_archived_name_without_an_active_copy_is_hidden(self):
        context = {"domain": "personal", "project": None}
        self.assertEqual(self.overrides([self.skill("old", "archive")], context), {"old": "user-invocable-only"})

    def test_archived_name_with_an_active_copy_stays_visible(self):
        skills = [self.skill("review", "archive"), self.skill("review", "global")]
        context = {"domain": "personal", "project": None}
        self.assertEqual(self.overrides(skills, context), {})

    def test_archived_plugin_copy_is_reported_as_unhideable(self):
        skill = dict(self.skill("tdd", "archive"), plugin_source="superpowers")
        context = {"domain": "personal", "project": None, "active_plugins": ["superpowers"]}
        self.assertEqual(self.overrides([skill], context), {})
        self.assertEqual(brain.unhideable_plugin_skills({"skills": [skill]}, context), ["superpowers:tdd"])

    def test_copy_claude_code_does_not_load_is_left_alone(self):
        snapshot = self.skill("typings", "archive", loaded_runtimes=[])
        context = {"domain": "personal", "project": None}
        self.assertEqual(self.overrides([snapshot], context), {})

    def test_plugin_scoped_skill_is_never_hidden_while_its_plugin_runs(self):
        skills = [self.skill("babysit", "plugin", plugin="claude-mem")]
        context = {"domain": "personal", "project": None, "active_plugins": ["claude-mem"]}
        self.assertEqual(self.overrides(skills, context), {})

    def test_enabled_plugin_skill_stays_visible(self):
        skills = [self.skill("brainstorming", "plugin", plugin="superpowers")]
        context = {"domain": "personal", "project": None, "active_plugins": ["superpowers"]}
        self.assertEqual(self.overrides(skills, context), {})

    def test_non_claude_and_disabled_plugin_skills_are_ignored(self):
        skills = [
            self.skill("codex-only", "domain", domain="work.company", runtimes=["codex"]),
            self.skill("hidden", "domain", domain="work.company", model_invocable=False),
            self.skill("off-plugin", "plugin", plugin="ponytail"),
            dict(self.skill("off-plugin-domain", "domain", domain="work.company"), plugin_source="ponytail"),
        ]
        context = {"domain": "personal", "project": None}
        self.assertEqual(self.overrides(skills, context), {})

    def test_write_replaces_profile_entries_but_keeps_manual_toggles(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            path.write_text(
                json.dumps({"model": "opus", "skillOverrides": {"manual": "off", "stale": "user-invocable-only"}}),
                encoding="utf-8",
            )
            brain.write_skill_overrides({"fresh": "user-invocable-only"}, path, previous={"stale"})
            written = json.loads(path.read_text(encoding="utf-8"))
            backup = json.loads((path.parent / "settings.json.brain-backup").read_text(encoding="utf-8"))
        self.assertEqual(written["model"], "opus")
        self.assertEqual(written["skillOverrides"], {"fresh": "user-invocable-only", "manual": "off"})
        self.assertEqual(backup["skillOverrides"], {"manual": "off", "stale": "user-invocable-only"})

    def test_manual_toggle_wins_over_profile_for_the_same_skill(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            path.write_text(json.dumps({"skillOverrides": {"deploy": "on"}}), encoding="utf-8")
            brain.write_skill_overrides({"deploy": "user-invocable-only"}, path)
            written = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(written["skillOverrides"], {"deploy": "on"})

    def test_empty_overrides_drop_profile_entries_but_keep_manual_toggles(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            path.write_text(
                json.dumps({"model": "opus", "skillOverrides": {"manual": "off", "stale": "user-invocable-only"}}),
                encoding="utf-8",
            )
            brain.write_skill_overrides({}, path, previous={"stale"})
            written = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(written["skillOverrides"], {"manual": "off"})
        self.assertEqual(written["model"], "opus")

    def test_empty_overrides_without_manual_toggles_drop_the_key(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            path.write_text(json.dumps({"model": "opus", "skillOverrides": {"stale": "user-invocable-only"}}), encoding="utf-8")
            brain.write_skill_overrides({}, path, previous={"stale"})
            written = json.loads(path.read_text(encoding="utf-8"))
        self.assertNotIn("skillOverrides", written)
        self.assertEqual(written["model"], "opus")

    def test_unreadable_settings_file_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.local.json"
            path.write_text('{"permissions": {"allow": []}, oops', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Cannot parse"):
                brain.write_skill_overrides({"fresh": "user-invocable-only"}, path)
            self.assertEqual(path.read_text(encoding="utf-8"), '{"permissions": {"allow": []}, oops')

    def test_hidden_entry_brain_did_not_write_survives(self):
        # The /skills menu writes the same value; brain removes only what it wrote itself.
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.local.json"
            path.write_text(json.dumps({"skillOverrides": {"menu-choice": "user-invocable-only"}}), encoding="utf-8")
            brain.write_skill_overrides({"fresh": "user-invocable-only"}, path)
            written = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(written["skillOverrides"], {"fresh": "user-invocable-only", "menu-choice": "user-invocable-only"})

    def test_missing_settings_file_is_created(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            brain.write_skill_overrides({"x": "user-invocable-only"}, path)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"skillOverrides": {"x": "user-invocable-only"}})


class SkillBundleTests(unittest.TestCase):
    """Named blocks that group related skills for reading the registry."""

    RULES = [
        {"id": "orchestrator", "title": "Оркестратор", "names": ["ququ-orchestrator-code-style", "tariff-editor"]},
        {"id": "ququ", "title": "QuQu", "name_prefix": "ququ-"},
        {"id": "arcanum", "title": "Аркадия", "names": ["arc", "arcanum-go"]},
    ]

    def skill(self, name, plugin=None, source="/skills/x"):
        return {
            "name": name,
            "source_path": source,
            "scope": {"level": "plugin" if plugin else "global", "domain": None, "project": None, "plugin": plugin},
            "plugin_source": plugin,
        }

    def test_prefix_rule_assigns_bundle(self):
        self.assertEqual(brain.classify_bundle(self.skill("ququ-solve"), self.RULES), "ququ")

    def test_explicit_name_wins_over_later_prefix_rule(self):
        self.assertEqual(brain.classify_bundle(self.skill("ququ-orchestrator-code-style"), self.RULES), "orchestrator")

    def test_name_list_rule_assigns_bundle(self):
        self.assertEqual(brain.classify_bundle(self.skill("arcanum-go"), self.RULES), "arcanum")

    def test_plugin_skill_falls_back_to_its_plugin(self):
        self.assertEqual(brain.classify_bundle(self.skill("babysit", plugin="claude-mem"), self.RULES), "claude-mem")

    def test_unmatched_skill_has_no_bundle(self):
        self.assertIsNone(brain.classify_bundle(self.skill("humanizer"), self.RULES))

    def test_source_pattern_rule_assigns_bundle(self):
        rules = [{"id": "tef", "title": "TEF", "source_pattern": "/junk/dev-user/"}]
        skill = self.skill("whatever", source="/home/u/junk/dev-user/ai/skills/whatever")
        self.assertEqual(brain.classify_bundle(skill, rules), "tef")

    def test_summary_counts_skills_and_idle_ones_per_bundle(self):
        skills = [
            dict(self.skill("ququ-solve"), bundle="ququ", description="d", runtimes=["claude"], model_invocable=True,
                 usage={"count": 3, "last_used": "2026-08-18", "days_idle": 1, "counter_key": "ququ-solve"}),
            dict(self.skill("ququ-design"), bundle="ququ", description="d", runtimes=["claude"], model_invocable=True,
                 usage={"count": 0, "last_used": None, "days_idle": None, "counter_key": None}),
            dict(self.skill("humanizer"), bundle=None, description="d", runtimes=["claude"], model_invocable=True,
                 usage={"count": 5, "last_used": "2026-08-19", "days_idle": 0, "counter_key": "humanizer"}),
        ]
        summary = brain.bundle_summary(skills, [{"id": "ququ", "title": "QuQu"}])
        self.assertEqual(summary[0]["id"], "ququ")
        self.assertEqual(summary[0]["title"], "QuQu")
        self.assertEqual(summary[0]["skill_count"], 2)
        self.assertEqual(summary[0]["never_used"], 1)
        self.assertEqual(summary[0]["invocations"], 3)

    def test_summary_counts_a_skill_mounted_twice_once(self):
        def member(source):
            return dict(self.skill("ququ-solve", source=source), bundle="ququ", description="d",
                        runtimes=["claude"], model_invocable=True,
                        usage={"count": 3, "last_used": "2026-08-18", "days_idle": 1, "counter_key": "ququ-solve"})

        summary = brain.bundle_summary([member("/a/x"), member("/b/x")], [{"id": "ququ", "title": "QuQu"}])
        self.assertEqual(summary[0]["skill_count"], 1)
        self.assertEqual(summary[0]["invocations"], 3)

    def test_summary_skips_bundles_without_skills(self):
        summary = brain.bundle_summary([], [{"id": "ququ", "title": "QuQu"}])
        self.assertEqual(summary, [])


class UsageReportTests(unittest.TestCase):
    """The audit report carries the usage numbers, not just the inventory."""

    def test_audit_reports_usage_and_idle_counts(self):
        inventory = {
            "generated_at": "2026-08-19T00:00:00+00:00",
            "instructions": [],
            "collisions": [],
            "broken_sources": [],
            "projects": [],
            "domains": [],
            "skills": [],
            "config": {"listing_limits": {"max_desc_chars": 200, "budget_fraction": 0.05}},
            "stats": {
                "skill_sources": 3, "skill_mounts": 3, "domain_count": 1, "project_count": 0,
                "workflow_count": 0, "collision_count": 0, "unresolved_collision_count": 0,
                "broken_count": 0,
                "usage": {"tracked": 3, "used": 2, "never_used": 1, "idle_over_30d": 1, "total_invocations": 12},
            },
        }
        report = brain.generate_audit(inventory)
        self.assertIn("## Usage", report)
        self.assertIn("Never invoked: **1**", report)
        self.assertIn("Idle over 30 days: **1**", report)
        self.assertIn("Total invocations: **12**", report)

    def test_audit_splits_never_invoked_into_turn_off_and_keep(self):
        def skill(name, domain=None):
            return {
                "id": name, "name": name, "description": "d", "runtimes": ["claude"], "model_invocable": True,
                "scope": {"level": "domain" if domain else "global", "domain": domain, "project": None, "plugin": None},
                "usage": {"count": 0},
            }

        inventory = {
            "generated_at": "2026-10-10T00:00:00+00:00",
            "instructions": [], "collisions": [], "broken_sources": [], "projects": [], "domains": [],
            "skills": [skill("draft"), skill("ququ-solve", domain="work")],
            "config": {},
            "stats": {
                "skill_sources": 2, "skill_mounts": 2, "domain_count": 1, "project_count": 0,
                "workflow_count": 0, "collision_count": 0, "unresolved_collision_count": 0, "broken_count": 0,
                "usage": {"tracked": 2, "used": 0, "never_used": 2, "idle_over_30d": 0, "total_invocations": 0},
            },
        }
        report = brain.generate_audit(inventory)
        self.assertIn("- `draft` — `brain skill off draft --settings user`", report)
        self.assertIn("- `work` (1): ququ-solve — `brain use work --dry-run`", report)

    def test_audit_lists_blocks_when_the_registry_has_them(self):
        inventory = {
            "generated_at": "2026-08-19T00:00:00+00:00",
            "instructions": [], "collisions": [], "broken_sources": [], "projects": [],
            "domains": [], "skills": [], "config": {},
            "bundles": [{"id": "ququ", "title": "QuQu", "skill_count": 23, "never_used": 14, "invocations": 36}],
            "stats": {
                "skill_sources": 1, "skill_mounts": 1, "domain_count": 1, "project_count": 0,
                "workflow_count": 0, "collision_count": 0, "unresolved_collision_count": 0,
                "broken_count": 0,
            },
        }
        report = brain.generate_audit(inventory)
        self.assertIn("## Blocks", report)
        self.assertIn("| QuQu | 23 | 14 | 36 |", report)

    def test_audit_survives_a_registry_without_usage_stats(self):
        inventory = {
            "generated_at": "2026-08-19T00:00:00+00:00",
            "instructions": [], "collisions": [], "broken_sources": [], "projects": [],
            "domains": [], "skills": [], "config": {},
            "stats": {
                "skill_sources": 1, "skill_mounts": 1, "domain_count": 1, "project_count": 0,
                "workflow_count": 0, "collision_count": 0, "unresolved_collision_count": 0,
                "broken_count": 0,
            },
        }
        self.assertNotIn("## Usage", brain.generate_audit(inventory))


class ModelVisibilityTests(unittest.TestCase):
    """Skills hidden from the model still cost nothing in the listing."""

    def parse(self, frontmatter: str) -> dict:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "SKILL.md"
            path.write_text(f"---\n{frontmatter}\n---\nbody\n", encoding="utf-8")
            return brain.parse_skill_metadata(path, "fallback")

    def test_plain_skill_is_model_invocable(self):
        self.assertTrue(self.parse("name: x\ndescription: d")["model_invocable"])

    def test_disable_model_invocation_hides_skill_from_model(self):
        self.assertFalse(self.parse("name: x\ndescription: d\ndisable-model-invocation: true")["model_invocable"])

    def test_false_flag_keeps_skill_visible(self):
        self.assertTrue(self.parse("name: x\ndescription: d\ndisable-model-invocation: false")["model_invocable"])


class SkillUsageTests(unittest.TestCase):
    """Usage counters that Claude Code maintains in ~/.claude.json."""

    def write_state(self, directory: str, usage: dict) -> Path:
        path = Path(directory) / "claude.json"
        path.write_text(json.dumps({"skillUsage": usage}), encoding="utf-8")
        return path

    def test_reads_counts_and_last_used_date(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_state(directory, {"review": {"usageCount": 27, "lastUsedAt": 1786543318694}})
            usage = brain.read_skill_usage(path)
        self.assertEqual(usage["review"]["count"], 27)
        self.assertEqual(usage["review"]["last_used"], "2026-08-12")

    def test_missing_state_file_yields_empty_usage(self):
        with tempfile.TemporaryDirectory() as directory:
            usage = brain.read_skill_usage(Path(directory) / "absent.json")
        self.assertEqual(usage, {})

    def test_unreadable_state_file_yields_no_usage_rather_than_zeros(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "claude.json"
            path.write_text('{"skillUsage": {"review": {"usageCount": 2', encoding="utf-8")
            self.assertIsNone(brain.read_skill_usage(path))

    def test_entry_without_timestamp_keeps_count(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_state(directory, {"solo": {"usageCount": 3}})
            usage = brain.read_skill_usage(path)
        self.assertEqual(usage["solo"]["count"], 3)
        self.assertIsNone(usage["solo"]["last_used"])

    def test_plugin_skill_matches_namespaced_counter(self):
        skills = [
            {
                "name": "brainstorming",
                "scope": {"level": "plugin", "domain": None, "project": None, "plugin": "superpowers"},
            }
        ]
        usage = {"superpowers:brainstorming": {"count": 86, "last_used": "2026-08-12"}}
        brain.attach_skill_usage(skills, usage, today="2026-08-19")
        self.assertEqual(skills[0]["usage"]["count"], 86)
        self.assertEqual(skills[0]["usage"]["counter_key"], "superpowers:brainstorming")
        self.assertEqual(skills[0]["usage"]["days_idle"], 7)

    def test_plain_skill_ignores_namespaced_counter_of_same_name(self):
        skills = [
            {
                "name": "test-driven-development",
                "scope": {"level": "global", "domain": None, "project": None, "plugin": None},
            }
        ]
        usage = {
            "test-driven-development": {"count": 1, "last_used": "2026-07-04"},
            "superpowers:test-driven-development": {"count": 6, "last_used": "2026-08-01"},
        }
        brain.attach_skill_usage(skills, usage, today="2026-08-19")
        self.assertEqual(skills[0]["usage"]["count"], 1)
        self.assertEqual(skills[0]["usage"]["counter_key"], "test-driven-development")

    def test_never_used_skill_reports_zero_without_idle_days(self):
        skills = [{"name": "unused", "scope": {"level": "global", "domain": None, "project": None, "plugin": None}}]
        brain.attach_skill_usage(skills, {}, today="2026-08-19")
        self.assertEqual(skills[0]["usage"]["count"], 0)
        self.assertIsNone(skills[0]["usage"]["last_used"])
        self.assertIsNone(skills[0]["usage"]["days_idle"])

    def test_usage_summary_counts_used_and_idle_skills(self):
        skills = [
            {"name": "hot", "scope": {"level": "global", "domain": None, "project": None, "plugin": None}},
            {"name": "cold", "scope": {"level": "global", "domain": None, "project": None, "plugin": None}},
            {"name": "dead", "scope": {"level": "global", "domain": None, "project": None, "plugin": None}},
            {"name": "kept", "scope": {"level": "archive", "domain": None, "project": None, "plugin": None}},
        ]
        usage = {
            "hot": {"count": 10, "last_used": "2026-08-18"},
            "cold": {"count": 2, "last_used": "2026-06-01"},
        }
        summary = brain.attach_skill_usage(skills, usage, today="2026-08-19")
        self.assertEqual(summary["tracked"], 3)
        self.assertEqual(summary["used"], 2)
        self.assertEqual(summary["never_used"], 1)
        self.assertEqual(summary["idle_over_30d"], 1)
        self.assertEqual(summary["total_invocations"], 12)

    def test_same_skill_in_several_roots_is_counted_once(self):
        skills = [
            {
                "name": "review",
                "source_path": "/a/review",
                "scope": {"level": "global", "domain": None, "project": None, "plugin": None},
            },
            {
                "name": "review",
                "source_path": "/b/review",
                "scope": {"level": "global", "domain": None, "project": None, "plugin": None},
            },
        ]
        summary = brain.attach_skill_usage(skills, {"review": {"count": 27, "last_used": "2026-08-18"}}, today="2026-08-19")
        self.assertEqual(summary["tracked"], 1)
        self.assertEqual(summary["used"], 1)
        self.assertEqual(summary["total_invocations"], 27)
        self.assertEqual(skills[1]["usage"]["count"], 27)

    def test_archived_skill_is_excluded_from_summary(self):
        skills = [{"name": "kept", "scope": {"level": "archive", "domain": None, "project": None, "plugin": None}}]
        summary = brain.attach_skill_usage(skills, {"kept": {"count": 5, "last_used": "2026-08-18"}}, today="2026-08-19")
        self.assertEqual(summary["tracked"], 0)
        self.assertEqual(skills[0]["usage"]["count"], 5)


class RuntimeLoadingTests(unittest.TestCase):
    """Claude Code reads a skill folder only at the top of a skill root."""

    def write_skill(self, folder, name):
        folder.mkdir(parents=True)
        (folder / "SKILL.md").write_text(f"---\nname: {name}\ndescription: d\n---\n", encoding="utf-8")

    def test_nested_snapshot_is_not_loaded_but_top_level_skill_is(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "skills"
            self.write_skill(root / "review", "review")
            self.write_skill(root / "review-workspace" / "skill-snapshots" / "typings", "typings")
            config = {"skill_roots": [{"path": str(root), "runtime": "claude", "kind": "mount"}]}
            occurrences, _ = brain.collect_skill_occurrences(config, [])
            skills, _ = brain.merge_skills(occurrences, config, [])
        loaded = {skill["name"]: skill["loaded_runtimes"] for skill in skills}
        self.assertEqual(loaded, {"review": ["claude"], "typings": []})


class SkillPreferenceTests(unittest.TestCase):
    """Which copy to take when several skills do the same job."""

    PREFERENCES = [
        {
            "task": "Баг, красный тест",
            "use": "systematic-debugging",
            "instead_of": ["superpowers:systematic-debugging", "mattpocock-skills:diagnosing-bugs"],
            "except_domains": ["personal.software"],
        },
        {
            "task": "Ревью PR в Аркадии",
            "use": "arcanum-review",
            "use_note": ", при высокой цене ошибки плюс `pr-council`",
            "instead_of": ["mattpocock-skills:code-review"],
            "instead_of_note": ", агент `code-reviewer`",
        },
        {
            "task": "Нянчить PR до мержа",
            "use": "babysit-arcanum-pr",
            "instead_of": ["claude-mem:babysit"],
            "instead_of_note": " — он про GitHub",
        },
    ]

    def skill(self, name, plugin=None):
        level = "plugin" if plugin else "global"
        return {
            "id": f"{level}.{plugin + '.' if plugin else ''}{name}",
            "name": name,
            "plugin_source": plugin,
            "scope": {"level": level, "domain": None, "project": None, "plugin": plugin},
            "source_path": f"/skills/{plugin or 'personal'}/{name}",
            "mount_count": 1,
        }

    def inventory(self, skills):
        return {
            "generated_at": "2026-10-10T00:00:00+00:00",
            "projects": [],
            "workflows": [],
            "collisions": [],
            "skills": skills,
            "config": {
                "default_domain": "work",
                "domain_path_rules": [],
                "active_plugins": ["superpowers", "mattpocock-skills"],
                "skill_preferences": self.PREFERENCES,
            },
        }

    def explain(self, query, skills, domain):
        inventory = self.inventory(skills)
        status = brain.context_status(Path("/tmp/brain-preferences"), inventory, explicit_domain=domain)
        return brain.select_skill(query, status, inventory)

    def test_markdown_table_matches_the_routing_rule(self):
        self.assertEqual(
            brain.preference_table(self.PREFERENCES, ["Задача", "Беру", "Не беру следом"]),
            "\n".join(
                [
                    "| Задача | Беру | Не беру следом |",
                    "|---|---|---|",
                    "| Баг, красный тест | `systematic-debugging` | `superpowers:systematic-debugging`, `mattpocock-skills:diagnosing-bugs` |",
                    "| Ревью PR в Аркадии | `arcanum-review`, при высокой цене ошибки плюс `pr-council` | `mattpocock-skills:code-review`, агент `code-reviewer` |",
                    "| Нянчить PR до мержа | `babysit-arcanum-pr` | `claude-mem:babysit` — он про GitHub |",
                ]
            ),
        )

    def test_personal_copy_beats_the_plugin_copy_of_the_same_name(self):
        skills = [self.skill("systematic-debugging"), self.skill("systematic-debugging", plugin="superpowers")]
        result = self.explain("systematic-debugging", skills, "work")
        self.assertEqual(result["selected"]["id"], "global.systematic-debugging")

    def test_preference_is_off_in_its_excepted_domain(self):
        skills = [self.skill("systematic-debugging"), self.skill("systematic-debugging", plugin="superpowers")]
        result = self.explain("systematic-debugging", skills, "personal.software")
        self.assertEqual(result["selected"]["id"], "plugin.superpowers.systematic-debugging")

    def test_explain_points_from_a_differently_named_copy_to_the_preferred_one(self):
        skills = [self.skill("systematic-debugging"), self.skill("diagnosing-bugs", plugin="mattpocock-skills")]
        result = self.explain("diagnosing-bugs", skills, "work")
        self.assertEqual(result["preferred_instead"], "systematic-debugging")

    def test_preference_without_use_does_not_crash_ranking(self):
        broken = [{"task": "x", "instead_of": ["superpowers:systematic-debugging"]}]
        self.assertEqual(brain.preference_rank(self.skill("systematic-debugging"), broken), 0)

    def test_collision_report_prefers_the_configured_copy(self):
        occurrences = []
        for plugin in (None, "superpowers"):
            skill = self.skill("systematic-debugging", plugin=plugin)
            occurrences.append(
                {
                    "top_level": True,
                    "logical_name": skill["name"],
                    "mount_name": skill["name"],
                    "description": "d",
                    "model_invocable": True,
                    "plugin_source": plugin,
                    "mount_path": skill["source_path"],
                    "source_path": skill["source_path"],
                    "package_fingerprint": skill["source_path"],
                    "scope": skill["scope"],
                    "skill_file": skill["source_path"] + "/SKILL.md",
                    "runtime": "claude",
                    "root_kind": "mount",
                    "is_symlink": False,
                }
            )
        _, collisions = brain.merge_skills(occurrences, {"skill_preferences": self.PREFERENCES}, [])
        self.assertEqual(collisions[0]["preferred_id"], "global.systematic-debugging")


class ProfileStalenessTests(unittest.TestCase):
    """A profile goes stale when skills change after brain use wrote it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        self.folder = self.home / "notes"
        self.folder.mkdir(parents=True)
        self.local = self.folder / ".claude" / "settings.local.json"
        patcher = mock.patch.object(brain, "PROFILES_PATH", Path(self.tmp.name) / "state" / "profiles.json")
        patcher.start()
        self.addCleanup(patcher.stop)

    def skill(self, name, domain=None):
        return {
            "id": f"{'domain.' + domain if domain else 'global'}.{name}",
            "name": name,
            "description": "d",
            "runtimes": ["claude"],
            "scope": {"level": "domain" if domain else "global", "domain": domain, "project": None, "plugin": None},
        }

    def inventory(self, skills):
        return {
            "projects": [],
            "skills": skills,
            "config": {"default_domain": "personal", "domain_path_rules": [], "active_plugins": []},
        }

    def apply(self, skills):
        inventory = self.inventory(skills)
        context = brain.resolve_context(self.folder, inventory, explicit_domain="personal")
        overrides = brain.skill_listing_overrides(inventory, context)
        brain.write_skill_overrides(overrides, self.local)
        brain.record_profile(self.local, "personal", self.folder, sorted(overrides))

    def status(self, skills):
        return brain.profile_status(self.folder, self.inventory(skills), home=self.home)

    def test_folder_without_a_profile_is_not_stale(self):
        status = self.status([self.skill("deploy", "work")])
        self.assertIsNone(status["applied"])
        self.assertFalse(status["stale"])
        self.assertEqual(status["domain"], "personal")

    def test_fresh_profile_is_not_stale(self):
        skills = [self.skill("deploy", "work")]
        self.apply(skills)
        status = self.status(skills)
        self.assertEqual(status["applied"]["domain"], "personal")
        self.assertFalse(status["stale"])

    def test_skill_installed_after_apply_makes_the_profile_stale(self):
        self.apply([self.skill("deploy", "work")])
        status = self.status([self.skill("deploy", "work"), self.skill("release", "work")])
        self.assertTrue(status["stale"])
        self.assertEqual(status["missing"], ["release"])

    def test_manual_on_is_not_reported_as_stale(self):
        self.apply([self.skill("deploy", "work")])
        brain.write_skill_overrides({"release": "on"}, self.local)
        status = self.status([self.skill("deploy", "work"), self.skill("release", "work")])
        self.assertFalse(status["stale"])

    def test_folder_profile_keeps_the_folders_own_project_skills(self):
        inventory = self.inventory([self.skill("deploy", "work"), dict(self.skill("cart"), scope={
            "level": "project", "domain": "personal", "project": "shop", "plugin": None})])
        inventory["projects"] = [{"id": "shop", "path": str(self.folder), "domain": "personal"}]
        context = brain.profile_context(self.folder, inventory, "personal", "local")
        self.assertEqual(brain.skill_listing_overrides(inventory, context), {"deploy": "user-invocable-only"})

    def test_folder_profile_must_use_the_folders_own_domain(self):
        with self.assertRaisesRegex(ValueError, "resolves to personal"):
            brain.profile_context(self.folder, self.inventory([]), "work", "local")

    def test_corrupt_profile_record_is_an_error_not_an_empty_one(self):
        brain.PROFILES_PATH.parent.mkdir(parents=True, exist_ok=True)
        brain.PROFILES_PATH.write_text("{not json", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "profiles.json"):
            brain.read_profiles()

    def test_skill_moved_out_of_its_domain_is_reported_as_wrongly_hidden(self):
        self.apply([self.skill("deploy", "work")])
        status = self.status([self.skill("deploy")])
        self.assertTrue(status["stale"])
        self.assertEqual(status["wrongly_hidden"], ["deploy"])


class UnusedReportTests(unittest.TestCase):
    """Never-invoked skills split as skills-routing.md asks: no domain vs a domain."""

    def skill(self, name, count=0, domain=None, plugin=None, level=None):
        return {
            "id": name,
            "name": name,
            "description": "d",
            "runtimes": ["claude"],
            "model_invocable": True,
            "plugin_source": plugin,
            "scope": {
                "level": level or ("domain" if domain else "plugin" if plugin else "global"),
                "domain": domain,
                "project": None,
                "plugin": plugin,
            },
            "usage": {"count": count},
        }

    def report(self, skills):
        return brain.unused_report({"skills": skills, "config": {"active_plugins": ["claude-mem", "jev"]}})

    def test_global_skill_without_calls_is_a_candidate_to_turn_off(self):
        report = self.report([self.skill("draft"), self.skill("busy", count=3)])
        self.assertEqual(report["turn_off"], [{"name": "draft", "id": "draft", "command": "brain skill off draft --settings user"}])

    def test_domain_skill_without_calls_is_kept_and_grouped_by_domain(self):
        report = self.report([self.skill("ququ-solve", domain="work"), self.skill("ququ-test", domain="work")])
        self.assertEqual(report["turn_off"], [])
        self.assertEqual(
            report["in_domain"],
            [{"domain": "work", "names": ["ququ-solve", "ququ-test"], "command": "brain use work --dry-run"}],
        )

    def test_plugin_skills_are_reported_per_plugin(self):
        report = self.report(
            [self.skill("a", plugin="claude-mem"), self.skill("b", count=1, plugin="claude-mem"), self.skill("x", plugin="jev")]
        )
        self.assertEqual(
            report["plugins"],
            [
                {"plugin": "claude-mem", "unused": ["claude-mem:a"], "total": 2, "command": None},
                {"plugin": "jev", "unused": ["jev:x"], "total": 1, "command": "claude plugin disable jev"},
            ],
        )

    def test_skill_already_hidden_is_not_offered_again(self):
        report = brain.unused_report(
            {"skills": [self.skill("draft"), self.skill("spyt-sql")], "config": {"active_plugins": []}},
            already_hidden={"spyt-sql"},
        )
        self.assertEqual([item["name"] for item in report["turn_off"]], ["draft"])

    def test_archived_skill_is_left_out(self):
        report = self.report([self.skill("old", level="archive")])
        self.assertEqual((report["turn_off"], report["in_domain"], report["plugins"]), ([], [], []))


class InventoryCacheTests(unittest.TestCase):
    def test_inventory_built_by_an_older_engine_is_rebuilt(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / "inventory.json"
            data.write_text(json.dumps({"schema_version": "agent-brain.registry.v1", "source_snapshot": {}}), encoding="utf-8")
            with mock.patch.object(brain, "DATA_PATH", data), mock.patch.object(
                brain, "source_snapshot", return_value={}
            ), mock.patch.object(brain, "build_outputs", return_value={"rebuilt": True}):
                self.assertEqual(brain.load_or_build_inventory(), {"rebuilt": True})


class RegistryHelpTests(unittest.TestCase):
    def test_help_names_the_registry_brain_actually_reads(self):
        with mock.patch.dict(os.environ, {"COLUMNS": "400"}):
            self.assertIn(str(brain.DEFAULT_REGISTRY_DIR), brain.create_parser().format_help())


if __name__ == "__main__":
    unittest.main()
