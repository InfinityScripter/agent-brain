const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { createBrainService, assertString, isWithin } = require('./brain-service.cjs');

const registryRoot = process.env.AGENT_BRAIN_HOME
  ? path.resolve(process.env.AGENT_BRAIN_HOME)
  : app.isPackaged
    ? path.join(app.getPath('home'), '.agent-brain')
    : path.resolve(__dirname, '..');
const engineRoot = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
const desktopRoot = path.resolve(__dirname, '..', 'desktop');
const bundledPython = path.join(engineRoot, `python-${process.arch}`, 'python', 'bin', 'python3');
const pythonExecutable = process.env.AGENT_BRAIN_PYTHON
  || (app.isPackaged && fs.existsSync(bundledPython) ? bundledPython : process.platform === 'win32' ? 'python' : 'python3');
const brain = createBrainService(registryRoot, { engineRoot, pythonExecutable });
let mainWindow;
let watchTimer;
let shuttingDown = false;
const watchers = new Map();
const watcherRetryTimers = new Map();
let smokeScreenshotTaken = false;

function isTrustedSender(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
}

function sendInventoryUpdate(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('brain:inventory-updated', payload);
  }
}

function createWindow() {
  if (!fs.existsSync(path.join(engineRoot, 'brain.py'))) {
    dialog.showErrorBox(
      'Agent Brain core is missing',
      `The bundled Agent Brain engine was not found in ${engineRoot}.`
    );
    app.quit();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1060,
    minHeight: 720,
    backgroundColor: '#0d1014',
    title: 'Agent Brain',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  mainWindow.loadFile(path.join(desktopRoot, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.once('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
}

function registerIpc() {
  const trusted = (handler) => (event, ...args) => {
    if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
    return handler(...args);
  };
  ipcMain.handle('brain:snapshot', trusted(() => brain.readInventory()));
  ipcMain.handle('brain:refresh', trusted(() => brain.refresh()));
  ipcMain.handle('brain:validate', trusted(() => brain.validate()));
  ipcMain.handle('brain:simulate', trusted((cwd) => brain.simulate(cwd)));
  ipcMain.handle('brain:explain', trusted((payload) => {
    if (!payload || typeof payload !== 'object') throw new TypeError('Invalid explain payload');
    return brain.explain(payload.query, payload.cwd);
  }));
  ipcMain.handle('brain:add-project', trusted((payload) => {
    if (!payload || typeof payload !== 'object') throw new TypeError('Invalid project payload');
    return brain.addProject(payload.path, {
      name: payload.name,
      domain: payload.domain,
      description: payload.description,
      kind: payload.kind
    });
  }));
  ipcMain.handle('brain:update-project', trusted((payload) => {
    if (!payload || typeof payload !== 'object') throw new TypeError('Invalid project payload');
    return brain.updateProject(payload.id, {
      name: payload.name,
      domain: payload.domain,
      description: payload.description,
      kind: payload.kind,
      relatedProjects: payload.relatedProjects,
      workspaceRules: payload.workspaceRules
    });
  }));
  ipcMain.handle('brain:project-dependencies', trusted((projectId) => brain.projectDependencies(projectId)));
  ipcMain.handle('brain:delete-project', trusted((payload) => {
    if (!payload || typeof payload !== 'object') throw new TypeError('Invalid project delete payload');
    if (payload.cascade !== true) throw new TypeError('Project deletion must be explicitly confirmed');
    return brain.deleteProject(payload.id, { cascade: true });
  }));
  ipcMain.handle('brain:save-workflow', trusted((payload) => {
    if (!payload || typeof payload !== 'object') throw new TypeError('Invalid workflow payload');
    return brain.saveWorkflow(payload);
  }));
  ipcMain.handle('brain:delete-workflow', trusted((payload) => {
    if (!payload || typeof payload !== 'object' || payload.confirmed !== true) {
      throw new TypeError('Workflow deletion must be explicitly confirmed');
    }
    return brain.deleteWorkflow(payload.id);
  }));
  ipcMain.handle('brain:save-domain', trusted((payload) => {
    if (!payload || typeof payload !== 'object') throw new TypeError('Invalid domain payload');
    return brain.saveDomain(payload);
  }));
  ipcMain.handle('brain:domain-dependencies', trusted((domainId) => brain.domainDependencies(domainId)));
  ipcMain.handle('brain:delete-domain', trusted((payload) => {
    if (!payload || typeof payload !== 'object' || payload.confirmed !== true) {
      throw new TypeError('Domain deletion must be explicitly confirmed');
    }
    return brain.deleteDomain(payload.id);
  }));
  ipcMain.handle('brain:update-skill-scope', trusted((payload) => {
    if (!payload || typeof payload !== 'object') throw new TypeError('Invalid skill scope payload');
    return brain.updateSkillScope(payload);
  }));
  ipcMain.handle('brain:inspect-folder', trusted((cwd) => brain.inspectFolder(cwd)));
  ipcMain.handle('brain:toggle-skill', trusted((payload) => {
    if (!payload || typeof payload !== 'object') throw new TypeError('Invalid skill toggle payload');
    return brain.toggleSkill(payload);
  }));
  ipcMain.handle('brain:toggle-rule', trusted((payload) => {
    if (!payload || typeof payload !== 'object') throw new TypeError('Invalid rule toggle payload');
    return brain.toggleRule(payload);
  }));
  ipcMain.handle('system:choose-directory', trusted(async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a project or workspace folder',
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  }));
  ipcMain.handle('system:reveal-path', trusted(async (targetPath) => {
    const safePath = path.resolve(assertString(targetPath, 'path'));
    const inventory = await brain.readInventory();
    const registeredProject = inventory.projects.some((project) => isWithin(project.path, safePath));
    if (!isWithin(app.getPath('home'), safePath) && !isWithin(registryRoot, safePath) && !registeredProject) {
      throw new Error('Only registered project paths may be revealed');
    }
    if (!fs.existsSync(safePath)) throw new Error(`Path does not exist: ${safePath}`);
    shell.showItemInFolder(safePath);
    return true;
  }));
  ipcMain.on('brain:renderer-ready', async (event) => {
    if (!isTrustedSender(event) || !process.env.AGENT_BRAIN_SMOKE_SCREENSHOT || smokeScreenshotTaken) return;
    smokeScreenshotTaken = true;
    try {
      await new Promise((resolve) => setTimeout(resolve, 900));
      const image = await mainWindow.webContents.capturePage();
      const screenshotPath = path.resolve(process.env.AGENT_BRAIN_SMOKE_SCREENSHOT);
      await fsPromises.writeFile(screenshotPath, image.toPNG());
      process.stdout.write(`AGENT_BRAIN_SMOKE_OK ${screenshotPath}\n`);
      app.quit();
    } catch (error) {
      process.stderr.write(`AGENT_BRAIN_SMOKE_FAILED ${error.message}\n`);
      app.exit(1);
    }
  });
}

function queueRegistryRefresh() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(async () => {
    try {
      sendInventoryUpdate(await brain.refresh());
    } catch (error) {
      sendInventoryUpdate({ error: error.message });
    }
  }, 500);
}

function scheduleWatcherRetry(target) {
  if (shuttingDown || watcherRetryTimers.has(target)) return;
  const retryTimer = setTimeout(() => {
    watcherRetryTimers.delete(target);
    attachWatcher(target);
  }, 2_000);
  retryTimer.unref();
  watcherRetryTimers.set(target, retryTimer);
}

function attachWatcher(target) {
  if (shuttingDown || watchers.has(target)) return;
  const directory = path.join(registryRoot, target);
  if (!fs.existsSync(directory)) {
    scheduleWatcherRetry(target);
    return;
  }
  try {
    const watcher = fs.watch(directory, { recursive: true }, queueRegistryRefresh);
    watchers.set(target, watcher);
    watcher.on('error', (error) => {
      watcher.close();
      watchers.delete(target);
      sendInventoryUpdate({ error: `Watcher ${target}: ${error.message}` });
      scheduleWatcherRetry(target);
    });
  } catch (error) {
    sendInventoryUpdate({ error: `Watcher ${target}: ${error.message}` });
    scheduleWatcherRetry(target);
  }
}

function watchRegistry() {
  for (const target of ['config', 'domains', 'projects', 'workflows']) attachWatcher(target);
}

function stopBackgroundWork() {
  shuttingDown = true;
  clearTimeout(watchTimer);
  for (const watcher of watchers.values()) watcher.close();
  watchers.clear();
  for (const timer of watcherRetryTimers.values()) clearTimeout(timer);
  watcherRetryTimers.clear();
  brain.stop();
}

app.whenReady().then(() => {
  registerIpc();
  if (!fs.existsSync(path.join(registryRoot, 'config', 'brain.json'))) {
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(pythonExecutable, ['-B', path.join(engineRoot, 'brain.py'), '--registry', registryRoot, 'init'], {
      cwd: engineRoot,
      env: { ...process.env, AGENT_BRAIN_HOME: registryRoot, PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8'
    });
    if (result.status !== 0) {
      dialog.showErrorBox(
        'Could not initialize Agent Brain',
        result.error?.code === 'ENOENT'
          ? 'The bundled Python runtime is missing. Reinstall Agent Brain from the official release.'
          : result.error?.message || result.stderr || result.stdout || `Exit ${result.status}`
      );
      app.quit();
      return;
    }
  }
  createWindow();
  watchRegistry();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', stopBackgroundWork);
