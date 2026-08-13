const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

function assertString(value, name, maxLength = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new TypeError(`${name} must be a non-empty string shorter than ${maxLength} characters`);
  }
  return value;
}

function isWithin(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function createBrainService(brainRoot, options = {}) {
  const root = path.resolve(brainRoot);
  const engineRoot = path.resolve(options.engineRoot || root);
  const brainScript = path.join(engineRoot, 'brain.py');
  const inventoryPath = path.join(root, 'data', 'inventory.json');
  const pythonExecutable = options.pythonExecutable || process.env.AGENT_BRAIN_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const serviceTimeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const activeChildren = new Set();
  let stopped = false;
  let refreshPromise = null;
  let refreshQueued = false;
  let mutationTail = Promise.resolve();

  function serializeMutation(task) {
    const guardedTask = () => {
      if (stopped) throw new Error('Agent Brain service has stopped');
      return task();
    };
    const operation = mutationTail.then(guardedTask, guardedTask);
    mutationTail = operation.catch(() => undefined);
    return operation;
  }

  async function runBrain(args, timeoutMs = serviceTimeoutMs) {
    if (stopped) throw new Error('Agent Brain service has stopped');
    if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) {
      throw new TypeError('Brain arguments must be a string array');
    }
    return new Promise((resolve, reject) => {
      const child = spawn(pythonExecutable, ['-B', brainScript, '--registry', root, ...args], {
        cwd: engineRoot,
        env: { ...process.env, AGENT_BRAIN_HOME: root, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      activeChildren.add(child);
      let stdout = '';
      let stderr = '';
      let size = 0;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        activeChildren.delete(child);
        callback(value);
      };
      const terminate = (message) => {
        if (settled) return;
        child.kill('SIGTERM');
        const forceTimer = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, 2_000);
        forceTimer.unref();
        finish(reject, new Error(message));
      };
      const timeout = setTimeout(() => terminate(`Agent Brain timed out after ${timeoutMs} ms`), timeoutMs);
      timeout.unref();
      const append = (current, chunk) => {
        size += chunk.length;
        if (size > MAX_OUTPUT_BYTES) {
          terminate('Agent Brain produced too much output');
          return current;
        }
        return current + chunk.toString('utf8');
      };
      child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
      child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
      child.on('error', (error) => finish(reject, error));
      child.on('close', (code) => {
        if (code === 0) finish(resolve, { stdout, stderr, code });
        else finish(reject, Object.assign(new Error(stderr.trim() || stdout.trim() || `Agent Brain exited with ${code}`), { code, stdout, stderr }));
      });
    });
  }

  async function parseInventory() {
      const inventory = JSON.parse(await fs.readFile(inventoryPath, 'utf8'));
      if (
        inventory?.schema_version !== 'agent-brain.registry.v1'
        || !Array.isArray(inventory.domains)
        || !Array.isArray(inventory.projects)
        || !Array.isArray(inventory.workflows)
        || !Array.isArray(inventory.skills)
        || !Array.isArray(inventory.collisions)
        || !Array.isArray(inventory.instructions)
        || !inventory.stats
        || typeof inventory.stats !== 'object'
        || !inventory.stats.scope_counts
        || typeof inventory.stats.scope_counts !== 'object'
      ) {
        throw new TypeError('Agent Brain inventory has an invalid shape');
      }
      return inventory;
  }

  async function readInventory() {
    try {
      return await parseInventory();
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
      return refresh();
    }
  }

  async function refresh() {
    if (refreshPromise) {
      refreshQueued = true;
      return refreshPromise;
    }
    refreshPromise = serializeMutation(async () => {
      let inventory;
      do {
        refreshQueued = false;
        await runBrain(['build']);
        inventory = await parseInventory();
      } while (refreshQueued);
      return inventory;
    });
    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  async function simulate(cwd) {
    const safeCwd = path.resolve(assertString(cwd, 'cwd'));
    const { stdout } = await runBrain(['status', '--cwd', safeCwd, '--json']);
    return JSON.parse(stdout);
  }

  async function validate() {
    return serializeMutation(async () => {
      try {
        const { stdout } = await runBrain(['validate', '--json']);
        return { validation: JSON.parse(stdout), inventory: await parseInventory() };
      } catch (error) {
        if (error.stdout) return { validation: JSON.parse(error.stdout), inventory: await parseInventory() };
        throw error;
      }
    });
  }

  async function explain(query, cwd) {
    const safeQuery = assertString(query, 'query', 256);
    const safeCwd = path.resolve(assertString(cwd, 'cwd'));
    try {
      const { stdout } = await runBrain(['explain', safeQuery, '--cwd', safeCwd, '--json']);
      return JSON.parse(stdout);
    } catch (error) {
      if (error.stdout) return JSON.parse(error.stdout);
      throw error;
    }
  }

  async function addProject(projectPath, options = {}) {
    const safePath = path.resolve(assertString(projectPath, 'project path'));
    const domain = assertString(options.domain || 'personal.software', 'domain', 128);
    const args = ['project', 'add', safePath, '--domain', domain];
    if (options.name) args.push('--name', assertString(options.name, 'project name', 128));
    if (options.description) args.push('--description', assertString(options.description, 'description', 512));
    return serializeMutation(async () => {
      await runBrain(args);
      return parseInventory();
    });
  }

  function stop() {
    stopped = true;
    refreshQueued = false;
    for (const child of activeChildren) child.kill('SIGTERM');
    activeChildren.clear();
  }

  return { root, readInventory, refresh, simulate, validate, explain, addProject, stop, isWithin };
}

module.exports = { createBrainService, assertString, isWithin };
