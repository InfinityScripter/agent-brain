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
    description: 'Example'
  }), inventory);
  const args = JSON.parse(await fs.readFile(path.join(root, 'args.json'), 'utf8'));
  assert.deepEqual(args.slice(-9), [
    'project', 'add', '/tmp/sample-project', '--domain', 'personal.software',
    '--name', 'Sample', '--description', 'Example'
  ]);
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
