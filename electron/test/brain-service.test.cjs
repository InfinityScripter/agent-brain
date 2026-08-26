const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBrainService, assertString, isWithin } = require('../brain-service.cjs');

const inventory = {
  schema_version: 'agent-brain.registry.v1',
  domains: [], projects: [], workflows: [], skills: [], collisions: [], instructions: [], stats: { scope_counts: {} }
};

async function temporaryBrain(script) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-brain-service-'));
  await fs.mkdir(path.join(root, 'data'));
  await fs.writeFile(path.join(root, 'brain.py'), script, 'utf8');
  return root;
}

test('assertString accepts bounded non-empty values', () => {
  assert.equal(assertString('work.company', 'domain'), 'work.company');
  assert.throws(() => assertString('', 'domain'), /non-empty string/);
  assert.throws(() => assertString('../'.repeat(2000), 'domain'), /shorter/);
});

test('isWithin rejects sibling and traversal paths', () => {
  const root = path.resolve('/tmp/agent-brain');
  assert.equal(isWithin(root, path.join(root, 'projects', 'one.json')), true);
  assert.equal(isWithin(root, path.resolve('/tmp/agent-brain-other')), false);
  assert.equal(isWithin(root, path.join(root, '..', 'secret')), false);
});

test('readInventory rebuilds syntactically valid invalid-shaped inventory once', async (context) => {
  const root = await temporaryBrain(`
import json, pathlib
root = pathlib.Path(__file__).parent
count = root / 'count'
count.write_text(str(int(count.read_text()) + 1) if count.exists() else '1')
(root / 'data' / 'inventory.json').write_text(json.dumps(${JSON.stringify(inventory)}))
`);
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'data', 'inventory.json'), '{}', 'utf8');
  const service = createBrainService(root);
  assert.deepEqual(await service.readInventory(), inventory);
  assert.equal(await fs.readFile(path.join(root, 'count'), 'utf8'), '1');
  service.stop();
});

test('simultaneous refresh calls coalesce into one build', async (context) => {
  const root = await temporaryBrain(`
import json, pathlib, time
root = pathlib.Path(__file__).parent
count = root / 'count'
count.write_text(str(int(count.read_text()) + 1) if count.exists() else '1')
time.sleep(.15)
(root / 'data' / 'inventory.json').write_text(json.dumps(${JSON.stringify(inventory)}))
`);
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createBrainService(root);
  const [first, second] = await Promise.all([service.refresh(), service.refresh()]);
  assert.deepEqual(first, inventory);
  assert.deepEqual(second, inventory);
  assert.equal(await fs.readFile(path.join(root, 'count'), 'utf8'), '1');
  service.stop();
});

test('subprocess timeout rejects a stalled refresh', async (context) => {
  const root = await temporaryBrain('import time\ntime.sleep(5)\n');
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createBrainService(root, { timeoutMs: 50 });
  await assert.rejects(service.refresh(), /timed out/);
  service.stop();
});

test('addProject passes validated arguments and returns the rebuilt inventory', async (context) => {
  const root = await temporaryBrain(`
import json, pathlib, sys
root = pathlib.Path(__file__).parent
(root / 'args.json').write_text(json.dumps(sys.argv[1:]))
(root / 'data' / 'inventory.json').write_text(json.dumps(${JSON.stringify(inventory)}))
`);
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createBrainService(root);
  assert.deepEqual(await service.addProject('/tmp/sample-project', {
    name: 'Sample',
    domain: 'personal.software',
    description: 'Example',
    kind: 'product'
  }), inventory);
  const args = JSON.parse(await fs.readFile(path.join(root, 'args.json'), 'utf8'));
  assert.deepEqual(args.slice(-11), [
    'project', 'add', '/tmp/sample-project', '--domain', 'personal.software',
    '--name', 'Sample', '--description', 'Example', '--kind', 'product'
  ]);
  service.stop();
});

test('project mutations pass bounded explicit CLI arguments', async (context) => {
  const root = await temporaryBrain(`
import json, pathlib, sys
root = pathlib.Path(__file__).parent
with (root / 'calls.jsonl').open('a') as handle: handle.write(json.dumps(sys.argv[1:]) + '\\n')
if 'dependencies' in sys.argv:
    print(json.dumps({'project': 'sample', 'incoming_relations': [], 'workflows': []}))
else:
    (root / 'data' / 'inventory.json').write_text(json.dumps(${JSON.stringify(inventory)}))
`);
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createBrainService(root);
  assert.deepEqual(await service.updateProject('sample', {
    name: 'Sample 2', domain: 'work', description: '', kind: 'product'
  }), inventory);
  assert.deepEqual(await service.projectDependencies('sample'), {
    project: 'sample', incoming_relations: [], workflows: []
  });
  assert.deepEqual(await service.deleteProject('sample', { cascade: true }), inventory);
  const calls = (await fs.readFile(path.join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0].slice(-11), [
    'project', 'update', 'sample', '--name', 'Sample 2', '--domain', 'work',
    '--description', '', '--kind', 'product'
  ]);
  assert.deepEqual(calls[1].slice(-4), ['project', 'dependencies', 'sample', '--json']);
  assert.deepEqual(calls[2].slice(-4), ['project', 'delete', 'sample', '--cascade']);
  await assert.rejects(service.updateProject('sample', {}), /At least one/);
  service.stop();
});

test('workflow, domain, and skill mutations use explicit bounded arguments', async (context) => {
  const root = await temporaryBrain(`
import json, pathlib, sys
root = pathlib.Path(__file__).parent
with (root / 'calls.jsonl').open('a') as handle: handle.write(json.dumps(sys.argv[1:]) + '\\n')
if 'dependencies' in sys.argv:
    print(json.dumps({'domain': 'research', 'children': [], 'projects': [], 'workflows': [], 'config_references': []}))
else:
    (root / 'data' / 'inventory.json').write_text(json.dumps(${JSON.stringify(inventory)}))
`);
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createBrainService(root);
  assert.deepEqual(await service.saveWorkflow({
    id: 'review', name: 'Review', domain: 'work', project: 'sample',
    description: '', steps: ['global.review']
  }), inventory);
  assert.deepEqual(await service.deleteWorkflow('review'), inventory);
  assert.deepEqual(await service.saveDomain({
    id: 'research', name: 'Research', description: '', color: '#123ABC', icon: 'R'
  }), inventory);
  assert.deepEqual(await service.domainDependencies('research'), {
    domain: 'research', children: [], projects: [], workflows: [], config_references: []
  });
  assert.deepEqual(await service.deleteDomain('research'), inventory);
  assert.deepEqual(await service.updateSkillScope({
    id: 'project.sample.review', level: 'project', project: 'sample'
  }), inventory);
  const calls = (await fs.readFile(path.join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0].slice(-13), [
    'workflow', 'save', 'review', '--name', 'Review', '--domain', 'work',
    '--description', '', '--steps-json', '["global.review"]', '--project', 'sample'
  ]);
  assert.deepEqual(calls[1].slice(-3), ['workflow', 'delete', 'review']);
  assert.deepEqual(calls[2].slice(-11), [
    'domain', 'save', 'research', '--name', 'Research', '--description', '',
    '--color', '#123ABC', '--icon', 'R'
  ]);
  assert.deepEqual(calls[3].slice(-3), ['domain', 'dependencies', 'research']);
  assert.deepEqual(calls[4].slice(-3), ['domain', 'delete', 'research']);
  assert.deepEqual(calls[5].slice(-7), [
    'skill', 'scope', 'project.sample.review', '--level', 'project', '--project', 'sample'
  ]);
  await assert.rejects(service.saveWorkflow({ id: 'bad', name: 'Bad', domain: 'work', description: 'x'.repeat(513) }), /description/);
  await assert.rejects(service.saveDomain({ id: 'bad', name: 'Bad', description: 42 }), /description/);
  service.stop();
});

test('folder inspector methods pass validated arguments', async (context) => {
  const root = await temporaryBrain(`
import json, pathlib, sys
root = pathlib.Path(__file__).parent
with (root / 'calls.jsonl').open('a') as handle: handle.write(json.dumps(sys.argv[1:]) + '\\n')
print(json.dumps({'root': 'stub'}))
`);
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createBrainService(root);
  const cwd = path.resolve('/tmp/apps/shop');
  assert.deepEqual(await service.inspectFolder(cwd), { root: 'stub' });
  assert.deepEqual(await service.toggleSkill({ name: 'react', action: 'off', cwd, settings: 'local' }), { root: 'stub' });
  assert.deepEqual(await service.toggleRule({ name: 'style', action: 'on', cwd }), { root: 'stub' });
  const calls = (await fs.readFile(path.join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0].slice(-4), ['inspect', '--cwd', cwd, '--json']);
  assert.deepEqual(calls[1].slice(-7), ['skill', 'off', 'react', '--cwd', cwd, '--settings', 'local']);
  assert.deepEqual(calls[2].slice(-4), ['inspect', '--cwd', cwd, '--json']);
  assert.deepEqual(calls[3].slice(-5), ['rule', 'on', 'style', '--cwd', cwd]);
  await assert.rejects(service.toggleSkill({ name: '--evil', action: 'off', cwd }), /must not start/);
  await assert.rejects(service.toggleSkill({ name: 'react', action: 'purge', cwd }), /action must be/);
  await assert.rejects(service.toggleSkill({ name: 'react', action: 'off', cwd, settings: 'enterprise' }), /settings must be/);
  await assert.rejects(service.toggleRule({ name: 'style', action: 'toggle', cwd }), /action must be/);
  service.stop();
});

test('stop rejects queued mutations and prevents later subprocesses', async (context) => {
  const root = await temporaryBrain(`
import json, pathlib, time
root = pathlib.Path(__file__).parent
time.sleep(.3)
(root / 'data' / 'inventory.json').write_text(json.dumps(${JSON.stringify(inventory)}))
`);
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createBrainService(root);
  const active = service.refresh();
  const queued = service.addProject('/tmp/sample-project');
  await new Promise((resolve) => setTimeout(resolve, 30));
  service.stop();
  await assert.rejects(active);
  await assert.rejects(queued, /service has stopped/);
  await assert.rejects(service.simulate('/tmp'), /service has stopped/);
});
