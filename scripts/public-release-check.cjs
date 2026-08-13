const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const publicEntries = [
  '.github', '.gitignore', 'AGENTS.md', 'CONTRIBUTING.md', 'LICENSE', 'README.md',
  'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'Open Agent Brain.command', 'adapters', 'assets', 'bin', 'brain.py',
  'core', 'defaults', 'desktop', 'docs', 'electron', 'forge.config.cjs', 'package-lock.json',
  'package.json', 'registry', 'scripts', 'tests', 'web'
];
const privateRoots = ['.runtime-cache', 'config', 'data', 'domains', 'node_modules', 'out', 'projects', 'reports', 'state', 'views', 'workflows'];
const textExtensions = new Set(['', '.cjs', '.css', '.html', '.json', '.md', '.py', '.sh', '.toml', '.txt', '.yml', '.yaml']);
const forbiddenPatterns = [
  ['/Users' + '/', 'absolute macOS home path'],
  [Buffer.from('QkVHSU4gT1BFTlNTSCBQUklWQVRFIEtFWQ==', 'base64').toString(), 'private SSH key'],
  [Buffer.from('Z2hwXw==', 'base64').toString(), 'GitHub personal access token'],
  [Buffer.from('Z2l0aHViX3BhdF8=', 'base64').toString(), 'GitHub fine-grained token'],
  [Buffer.from('Z2hvXw==', 'base64').toString(), 'GitHub OAuth token'],
  [Buffer.from('Z2hzXw==', 'base64').toString(), 'GitHub app token'],
  [Buffer.from('bnBtLnlhbmRleC10ZWFt', 'base64').toString(), 'private npm registry'],
  [Buffer.from('dGFsYWxhZXYtbQ==', 'base64').toString(), 'developer username'],
  [Buffer.from('VEVGQ1JN', 'base64').toString(), 'private ticket prefix'],
  [Buffer.from('c3RlZmFuaWEtY29yZQ==', 'base64').toString(), 'private agent marker']
];

function walk(entry) {
  const absolute = path.join(root, entry);
  if (!fs.existsSync(absolute)) return [];
  if (fs.statSync(absolute).isFile()) return [entry];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((item) => {
    const child = path.join(entry, item.name);
    return item.isDirectory() ? walk(child) : [child];
  });
}

for (const entry of publicEntries) assert.ok(fs.existsSync(path.join(root, entry)), `Missing public entry: ${entry}`);
const gitAvailable = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root }).status === 0;
if (gitAvailable) {
  for (const entry of privateRoots) {
    const probe = path.join(entry, '.agent-brain-ignore-check');
    assert.equal(spawnSync('git', ['check-ignore', '--no-index', '-q', probe], { cwd: root }).status, 0, `Private/generated root is not ignored: ${entry}`);
  }
} else {
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/);
  for (const entry of privateRoots) {
    assert.ok(ignore.includes(`/${entry}/`), `Private/generated root is not ignored: ${entry}`);
  }
}

const listed = gitAvailable
  ? spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
  : null;
assert.ok(!listed || listed.status === 0, listed?.stderr || 'Could not list public Git files');
const files = listed
  ? listed.stdout.split('\0').filter(Boolean)
  : publicEntries.flatMap(walk);
for (const file of files) {
  if (!textExtensions.has(path.extname(file))) continue;
  const contents = fs.readFileSync(path.join(root, file), 'utf8');
  for (const [pattern, label] of forbiddenPatterns) {
    assert.equal(contents.includes(pattern), false, `${label} found in ${file}`);
  }
}

const lockfile = fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8');
assert.match(lockfile, /https:\/\/registry\.npmjs\.org\//, 'package-lock does not use the public npm registry');
assert.ok(fs.statSync(path.join(root, 'docs', 'screenshot.png')).size > 10_000, 'Public screenshot is missing or empty');
process.stdout.write(`Public release check passed: ${files.length} files scanned\n`);
