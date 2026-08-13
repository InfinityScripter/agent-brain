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
    if (options.kind) args.push('--kind', assertString(options.kind, 'project kind', 128));
    return serializeMutation(async () => {
      await runBrain(args);
      return parseInventory();
    });
  }

  async function updateProject(projectId, options = {}) {
    const safeId = assertString(projectId, 'project id', 128);
    const args = ['project', 'update', safeId];
    if (options.name !== undefined) args.push('--name', assertString(options.name, 'project name', 128));
    if (options.domain !== undefined) args.push('--domain', assertString(options.domain, 'domain', 128));
    if (options.description !== undefined) {
      if (typeof options.description !== 'string' || options.description.length > 512) {
        throw new TypeError('description must be a string shorter than 512 characters');
      }
      args.push('--description', options.description);
    }
    if (options.kind !== undefined) args.push('--kind', assertString(options.kind, 'project kind', 128));
    if (options.relatedProjects !== undefined) {
      if (!Array.isArray(options.relatedProjects)) throw new TypeError('related projects must be an array');
      const value = JSON.stringify(options.relatedProjects);
      if (value.length > 65_536) throw new TypeError('related projects are too large');
      args.push('--relations-json', value);
    }
    if (options.workspaceRules !== undefined) {
      if (!Array.isArray(options.workspaceRules)) throw new TypeError('workspace rules must be an array');
      const value = JSON.stringify(options.workspaceRules);
      if (value.length > 65_536) throw new TypeError('workspace rules are too large');
      args.push('--workspace-rules-json', value);
    }
    if (args.length === 3) throw new TypeError('At least one project field must be updated');
    return serializeMutation(async () => {
      await runBrain(args);
      return parseInventory();
    });
  }

  async function projectDependencies(projectId) {
    const safeId = assertString(projectId, 'project id', 128);
    const { stdout } = await runBrain(['project', 'dependencies', safeId, '--json']);
    return JSON.parse(stdout);
  }

  async function deleteProject(projectId, options = {}) {
    const safeId = assertString(projectId, 'project id', 128);
    const args = ['project', 'delete', safeId];
    if (options.cascade === true) args.push('--cascade');
    return serializeMutation(async () => {
      await runBrain(args);
      return parseInventory();
    });
  }

  async function saveWorkflow(payload = {}) {
    const id = assertString(payload.id, 'workflow id', 128);
    const description = payload.description ?? '';
    if (typeof description !== 'string' || description.length > 512) {
      throw new TypeError('workflow description must be a string no longer than 512 characters');
    }
    const steps = Array.isArray(payload.steps) ? payload.steps : [];
    const stepsJson = JSON.stringify(steps);
    if (stepsJson.length > 64 * 1024) throw new TypeError('workflow steps are too large');
    const args = [
      'workflow', 'save', id,
      '--name', assertString(payload.name, 'workflow name', 128),
      '--domain', assertString(payload.domain, 'workflow domain', 128),
      '--description', description,
      '--steps-json', stepsJson
    ];
    if (payload.project) args.push('--project', assertString(payload.project, 'workflow project', 128));
    if (payload.force === true) args.push('--force');
    return serializeMutation(async () => { await runBrain(args); return parseInventory(); });
  }

  async function deleteWorkflow(workflowId) {
    const id = assertString(workflowId, 'workflow id', 128);
    return serializeMutation(async () => { await runBrain(['workflow', 'delete', id]); return parseInventory(); });
  }

  async function saveDomain(payload = {}) {
    const id = assertString(payload.id, 'domain id', 128);
    const description = payload.description ?? '';
    if (typeof description !== 'string' || description.length > 512) {
      throw new TypeError('domain description must be a string no longer than 512 characters');
    }
    const args = [
      'domain', 'save', id,
      '--name', assertString(payload.name, 'domain name', 128),
      '--description', description,
      '--color', assertString(payload.color || '#4AA8FF', 'domain color', 32),
      '--icon', assertString(payload.icon || 'circle', 'domain icon', 64)
    ];
    if (payload.parent) args.push('--parent', assertString(payload.parent, 'parent domain', 128));
    if (payload.force === true) args.push('--force');
    return serializeMutation(async () => { await runBrain(args); return parseInventory(); });
  }

  async function domainDependencies(domainId) {
    const id = assertString(domainId, 'domain id', 128);
    const { stdout } = await runBrain(['domain', 'dependencies', id]);
    return JSON.parse(stdout);
  }

  async function deleteDomain(domainId) {
    const id = assertString(domainId, 'domain id', 128);
    return serializeMutation(async () => { await runBrain(['domain', 'delete', id]); return parseInventory(); });
  }

  async function updateSkillScope(payload = {}) {
    const args = [
      'skill', 'scope', assertString(payload.id, 'skill id', 256),
      '--level', assertString(payload.level, 'scope level', 32)
    ];
    if (payload.domain) args.push('--domain', assertString(payload.domain, 'scope domain', 128));
    if (payload.project) args.push('--project', assertString(payload.project, 'scope project', 128));
    if (payload.plugin) args.push('--plugin', assertString(payload.plugin, 'plugin id', 128));
    return serializeMutation(async () => { await runBrain(args); return parseInventory(); });
  }

  function stop() {
    stopped = true;
    refreshQueued = false;
    for (const child of activeChildren) child.kill('SIGTERM');
    activeChildren.clear();
  }

  return {
    root, readInventory, refresh, simulate, validate, explain, addProject,
    updateProject, projectDependencies, deleteProject, saveWorkflow, deleteWorkflow,
    saveDomain, domainDependencies, deleteDomain, updateSkillScope, stop, isWithin
  };
}

module.exports = { createBrainService, assertString, isWithin };
