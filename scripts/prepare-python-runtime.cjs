const crypto = require('node:crypto');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const https = require('node:https');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const cache = path.join(root, '.runtime-cache');
const version = '3.12.13+20260807';
const runtimes = {
  arm64: {
    asset: `cpython-${version}-aarch64-apple-darwin-install_only_stripped.tar.gz`,
    sha256: '25baa97c65b3f0aa90e21131b4f9e80aef8899e8144006db8a9d2c1ab9e807e3'
  },
  x64: {
    asset: `cpython-${version}-x86_64-apple-darwin-install_only_stripped.tar.gz`,
    sha256: '127053f1736f721e391ddb46f07585d05756e15bb8d757d3bbc0519738998ba1'
  }
};

function download(url, destination, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'agent-brain-build' } }, async (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects) {
        response.resume();
        resolve(download(response.headers.location, destination, redirects - 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Python runtime download failed with HTTP ${response.statusCode}`));
        return;
      }
      try {
        await pipeline(response, fs.createWriteStream(destination, { flags: 'wx' }));
        resolve();
      } catch (error) { reject(error); }
    }).on('error', reject);
  });
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

async function prepare(arch, spec) {
  const destination = path.join(cache, `python-${arch}`);
  const executable = path.join(destination, 'python', 'bin', 'python3');
  if (fs.existsSync(executable)) return;
  const archive = path.join(cache, spec.asset);
  if (!fs.existsSync(archive)) {
    await download(`https://github.com/astral-sh/python-build-standalone/releases/download/20260807/${encodeURIComponent(spec.asset)}`, archive);
  }
  if (await sha256(archive) !== spec.sha256) throw new Error(`Checksum mismatch for ${spec.asset}`);
  await fsPromises.mkdir(destination, { recursive: true });
  const extracted = spawnSync('tar', ['-xzf', archive, '-C', destination], { stdio: 'inherit' });
  if (extracted.status !== 0 || !fs.existsSync(executable)) throw new Error(`Could not extract ${spec.asset}`);
}

async function main() {
  if (process.platform !== 'darwin') return;
  await fsPromises.mkdir(cache, { recursive: true });
  await Promise.all(Object.entries(runtimes).map(([arch, spec]) => prepare(arch, spec)));
  process.stdout.write(`Prepared pinned Python ${version} runtimes\n`);
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
