const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentBrain', Object.freeze({
  snapshot: () => ipcRenderer.invoke('brain:snapshot'),
  refresh: () => ipcRenderer.invoke('brain:refresh'),
  validate: () => ipcRenderer.invoke('brain:validate'),
  simulate: (cwd) => ipcRenderer.invoke('brain:simulate', cwd),
  explain: (query, cwd) => ipcRenderer.invoke('brain:explain', { query, cwd }),
  addProject: (payload) => ipcRenderer.invoke('brain:add-project', payload),
  updateProject: (payload) => ipcRenderer.invoke('brain:update-project', payload),
  projectDependencies: (projectId) => ipcRenderer.invoke('brain:project-dependencies', projectId),
  deleteProject: (payload) => ipcRenderer.invoke('brain:delete-project', payload),
  saveWorkflow: (payload) => ipcRenderer.invoke('brain:save-workflow', payload),
  deleteWorkflow: (payload) => ipcRenderer.invoke('brain:delete-workflow', payload),
  saveDomain: (payload) => ipcRenderer.invoke('brain:save-domain', payload),
  domainDependencies: (domainId) => ipcRenderer.invoke('brain:domain-dependencies', domainId),
  deleteDomain: (payload) => ipcRenderer.invoke('brain:delete-domain', payload),
  updateSkillScope: (payload) => ipcRenderer.invoke('brain:update-skill-scope', payload),
  chooseDirectory: () => ipcRenderer.invoke('system:choose-directory'),
  revealPath: (targetPath) => ipcRenderer.invoke('system:reveal-path', targetPath),
  reportReady: () => ipcRenderer.send('brain:renderer-ready'),
  onInventoryUpdated: (callback) => {
    const listener = (_event, inventory) => callback(inventory);
    ipcRenderer.on('brain:inventory-updated', listener);
    return () => ipcRenderer.removeListener('brain:inventory-updated', listener);
  }
}));
