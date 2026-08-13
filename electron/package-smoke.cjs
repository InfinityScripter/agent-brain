const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const plist = require('plist');

const repositoryRoot = path.resolve(__dirname, '..');
const candidates = [
  path.join(repositoryRoot, 'out', 'Agent Brain-darwin-universal', 'Agent Brain.app'),
  path.join(repositoryRoot, 'out', 'Agent Brain-darwin-arm64', 'Agent Brain.app')
];
const existingCandidates = candidates
  .filter((candidate) => fs.existsSync(candidate))
  .sort((first, second) => fs.statSync(second).mtimeMs - fs.statSync(first).mtimeMs);
const appPath = process.argv[2] ? path.resolve(process.argv[2]) : existingCandidates[0];
assert.ok(appPath && fs.existsSync(appPath), 'Packaged Agent Brain.app not found');

const resources = path.join(appPath, 'Contents', 'Resources');
const asarPath = path.join(resources, 'app.asar');
const infoPath = path.join(appPath, 'Contents', 'Info.plist');
assert.ok(fs.existsSync(asarPath), 'app.asar is missing');

const files = asar.listPackage(asarPath);
for (const forbidden of [
  '/.electron-cache',
  '/config/brain.json',
  '/projects/',
  '/domains/',
  '/workflows/',
  '/brain.py',
  '/out/',
  '/Open Agent Brain.command',
  '/electron/test/'
]) {
  assert.equal(files.some((file) => file === forbidden || file.startsWith(forbidden)), false, `Forbidden packaged path: ${forbidden}`);
}
for (const required of [
  '/desktop/index.html',
  '/desktop/renderer.js',
  '/electron/main.cjs',
  '/electron/preload.cjs'
]) {
  assert.ok(files.includes(required), `Required packaged path missing: ${required}`);
}
for (const requiredResource of [
  'brain.py',
  path.join('defaults', 'config', 'brain.json'),
  path.join('defaults', 'domains', 'work', 'domain.json'),
  path.join('web', 'index.template.html'),
  'agent-brain-app'
]) {
  assert.ok(fs.existsSync(path.join(resources, requiredResource)), `Required engine resource missing: ${requiredResource}`);
}
for (const architecture of ['arm64', 'x64']) {
  const python = path.join(resources, `python-${architecture}`, 'python', 'bin', 'python3');
  assert.ok(fs.existsSync(python), `Bundled Python runtime missing: ${architecture}`);
}

const info = plist.parse(fs.readFileSync(infoPath, 'utf8'));
assert.equal(info.CFBundleIdentifier, 'dev.agentbrain.desktop');
assert.equal(info.NSAppTransportSecurity.NSAllowsArbitraryLoads, false);
assert.ok(info.CFBundleIconFile, 'Custom icon is not configured');
assert.deepEqual(
  fs.readFileSync(path.join(resources, info.CFBundleIconFile)),
  fs.readFileSync(path.join(repositoryRoot, 'assets', 'agent-brain.icns')),
  'Packaged icon does not match the Agent Brain icon'
);
process.stdout.write(`Package smoke test passed: ${appPath}\n`);
