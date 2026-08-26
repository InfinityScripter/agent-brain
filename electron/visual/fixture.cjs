const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const domains = [
  ['work', 'Work', 'Professional projects, operations, research, and team collaboration.', null],
  ['work.studio', 'Work · Studio', 'Client delivery, product operations, and shared engineering practice.', 'work'],
  ['personal', 'Personal', 'Personal responsibilities, learning, wellbeing, and independent decisions.', null],
  ['personal.software', 'Personal · Software', 'Independent software products, experiments, and open-source work.', 'personal'],
  ['creative', 'Creative', 'Ideation, writing, visual thinking, and exploration of new directions.', null],
  ['meta', 'Meta', 'Agent infrastructure, memory, skills, configuration, and quality systems.', null],
  ['meta.agent-system', 'Meta · Agent System', 'Codex, Claude, shared skills, hooks, and Agent Brain itself.', 'meta']
];

const projects = [
  {
    id: 'atlas-web', name: 'Atlas Web', path: 'work/atlas-web', domain: 'work.studio', kind: 'product',
    description: 'Customer-facing workspace for planning releases and reviewing delivery health.',
    instruction_files: ['AGENTS.md'], skill_roots: ['.agents/skills'],
    related_projects: [{ project: 'atlas-api', type: 'uses' }],
    workspace_rules: [{ root: 'worktrees', dynamic_child: true, project_path: 'atlas-web', kind: 'worktree' }]
  },
  {
    id: 'atlas-api', name: 'Atlas API', path: 'work/atlas-api', domain: 'work.studio', kind: 'service',
    description: 'Stable API contracts and background processing for the Atlas product.',
    instruction_files: ['CLAUDE.md'], skill_roots: ['.agents/skills'],
    related_projects: [{ project: 'atlas-web', type: 'serves' }], workspace_rules: []
  },
  {
    id: 'garden-notes', name: 'Garden Notes', path: 'personal/garden-notes', domain: 'personal.software', kind: 'project',
    description: 'A calm personal knowledge tool for ideas, references, and small experiments.',
    instruction_files: ['AGENTS.md'], skill_roots: ['.agents/skills'], related_projects: [], workspace_rules: []
  },
  {
    id: 'agent-lab', name: 'Agent Lab', path: 'meta/agent-lab', domain: 'meta.agent-system', kind: 'system',
    description: 'Reusable agent conventions, routing experiments, and quality checks.',
    instruction_files: ['AGENTS.md', 'CLAUDE.md'], skill_roots: ['.agents/skills'],
    related_projects: [{ project: 'atlas-web', type: 'supports' }], workspace_rules: []
  }
];

function domainManifest([id, name, description, parent]) {
  return { id, name, description, parent, color: '#4AA8FF', icon: 'circle' };
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeSkill(root, folder, name, description) {
  const directory = path.join(root, folder);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    'utf8'
  );
}

async function createVisualFixture(registry) {
  // A fake HOME keeps the fixture hermetic: with the real one, brain.py picks
  // up the machine's installed plugins, enabled-plugin settings, and usage
  // counters, and the inventory (and every screenshot) drifts with them.
  const home = path.join(path.dirname(registry), 'home');
  const homeRules = path.join(home, '.claude', 'rules');
  await fs.mkdir(homeRules, { recursive: true });
  await fs.writeFile(path.join(homeRules, 'tone.md'), '# Tone of voice\n\nShort sentences, no fluff.\n', 'utf8');
  const fixtureRoot = path.join(registry, 'fixture');
  const absoluteProjects = projects.map((project) => ({
    ...project,
    path: path.join(fixtureRoot, project.path),
    workspace_rules: project.workspace_rules.map((rule) => ({ ...rule, root: path.join(fixtureRoot, rule.root) }))
  }));
  const sharedSkills = path.join(fixtureRoot, 'shared-skills');

  await writeJson(path.join(registry, 'config', 'brain.json'), {
    schema_version: 'agent-brain.config.v1',
    owner: 'visual-tests',
    default_domain: 'meta.agent-system',
    skill_roots: [{ path: sharedSkills, runtime: 'shared', kind: 'canonical' }],
    instruction_files: [], domain_path_rules: [],
    skill_scope_rules: [{ names: ['release-review'], level: 'domain', domain: 'work.studio' }],
    active_plugins: [], source_priority_rules: []
  });
  for (const domain of domains) {
    await writeJson(path.join(registry, 'domains', ...domain[0].split('.'), 'domain.json'), domainManifest(domain));
  }
  for (const project of absoluteProjects) {
    await fs.mkdir(project.path, { recursive: true });
    for (const instruction of project.instruction_files) await fs.writeFile(path.join(project.path, instruction), '# Visual fixture\n', 'utf8');
    for (const skillRoot of project.skill_roots) await fs.mkdir(path.join(project.path, skillRoot), { recursive: true });
    await writeJson(path.join(registry, 'projects', `${project.id}.json`), project);
  }
  for (const [folder, name, description] of [
    ['research', 'research', 'Evidence-first research with source comparison.'],
    ['writing', 'writing', 'Clear technical writing for humans and agents.'],
    ['release-review', 'release-review', 'Review a release across code, product, and operational evidence.'],
    ['review', 'review', 'General-purpose review.'],
    ['inspect-a', 'inspect', 'First equally ranked inspection package.'],
    ['inspect-b', 'inspect', 'Second equally ranked inspection package.']
  ]) await writeSkill(sharedSkills, folder, name, description);
  for (const [projectId, folder, name, description] of [
    ['atlas-web', 'frontend-review', 'frontend-review', 'Review Atlas UI changes against its local contracts.'],
    ['atlas-web', 'copy-check', 'copy-check', 'Check interface copy for clarity and consistency.'],
    ['atlas-web', 'review', 'review', 'Atlas-specific review with project conventions.'],
    ['atlas-api', 'contract-review', 'contract-review', 'Validate API changes and compatibility.'],
    ['garden-notes', 'idea-capture', 'idea-capture', 'Turn a rough thought into a connected note.'],
    ['agent-lab', 'routing-audit', 'routing-audit', 'Audit scope, precedence, and capability ownership.']
  ]) {
    const project = absoluteProjects.find((item) => item.id === projectId);
    await writeSkill(path.join(project.path, '.agents', 'skills'), folder, name, description);
  }
  await fs.mkdir(path.join(fixtureRoot, 'worktrees'), { recursive: true });
  await writeJson(path.join(registry, 'workflows', 'release.json'), {
    id: 'release-readiness', name: 'Release readiness', domain: 'work.studio', project: 'atlas-web',
    description: 'Prepare, review, verify, and ship a safe release.',
    steps: ['project.atlas-web.frontend-review', 'domain.work.studio.release-review']
  });
  await writeJson(path.join(registry, 'workflows', 'knowledge.json'), {
    id: 'knowledge-garden', name: 'Knowledge garden', domain: 'personal.software', project: 'garden-notes',
    description: 'Capture, connect, and revisit an idea.', steps: ['project.garden-notes.idea-capture', 'global.writing']
  });

  const build = spawnSync(
    process.env.AGENT_BRAIN_PYTHON || 'python3',
    ['-B', path.join(__dirname, '..', '..', 'brain.py'), '--registry', registry, 'build'],
    {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, HOME: home, PYTHONDONTWRITEBYTECODE: '1' }
    }
  );
  if (build.error) throw new Error(`Could not build visual fixture: ${build.error.message}`);
  if (build.status !== 0) throw new Error(build.stderr || build.stdout || 'Could not build visual fixture');
  return { registry, home, paths: Object.fromEntries(absoluteProjects.map((project) => [project.id, project.path])) };
}

module.exports = { createVisualFixture };
