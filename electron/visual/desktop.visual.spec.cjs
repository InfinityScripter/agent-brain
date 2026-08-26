const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test, expect, _electron: electron } = require('@playwright/test');
const { createVisualFixture } = require('./fixture.cjs');

const root = path.resolve(__dirname, '..', '..');
const screenshotFixtureRoot = '/private/tmp/agent-brain-visual-fixture';
let application;
let page;
let temporaryRoot;
let fixture;

async function normalizeFixturePaths(targetPage) {
  await targetPage.evaluate(({ actualRoot, displayRoot }) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      walker.currentNode.nodeValue = walker.currentNode.nodeValue.replaceAll(actualRoot, displayRoot);
    }
    for (const field of document.querySelectorAll('input, textarea')) {
      field.value = field.value.replaceAll(actualRoot, displayRoot);
    }
  }, { actualRoot: temporaryRoot, displayRoot: screenshotFixtureRoot });
}

async function expectView(name) {
  const view = page.locator(`#view-${name}`);
  await expect(view).toHaveClass(/active/);
  await normalizeFixturePaths(page);
  await expect(page).toHaveScreenshot(`${name}.png`, { animations: 'disabled', fullPage: true });
}

test.beforeAll(async () => {
  temporaryRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-brain-visual-fixture-')));
  fixture = await createVisualFixture(path.join(temporaryRoot, 'registry'));
  application = await electron.launch({
    args: [
      root,
      '--disable-gpu',
      '--force-device-scale-factor=1',
      `--user-data-dir=${path.join(temporaryRoot, 'profile')}`
    ],
    cwd: root,
    env: {
      ...process.env,
      HOME: fixture.home,
      AGENT_BRAIN_HOME: fixture.registry,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TZ: 'UTC'
    }
  });
  expect(await application.evaluate(({ app }) => app.getPath('userData')))
    .toBe(path.join(temporaryRoot, 'profile'));
  page = await application.firstWindow();
  await page.setViewportSize({ width: 1480, height: 960 });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
  await expect(page.locator('#loadingScreen')).toHaveClass(/hidden/);
  await expect(page.locator('#runtimeStatus')).toHaveText('Registry online');
  await application.evaluate(({ dialog }, projectPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [projectPath] });
  }, fixture.paths['garden-notes']);
});

test.afterAll(async () => {
  await application?.close();
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

test('portfolio overview', async () => {
  await page.getByRole('button', { name: /Portfolio/ }).click();
  await expectView('portfolio');
});

test('project registry and selected project detail', async () => {
  await page.getByRole('button', { name: /Projects/ }).click();
  await page.locator('#projectFilters').getByRole('button', { name: 'All' }).click();
  await page.getByRole('button', { name: /Atlas Web/ }).click();
  await expectView('projects');
});

test('add project dialog', async () => {
  await page.getByRole('button', { name: /Projects/ }).click();
  await page.getByRole('button', { name: 'Add project' }).click();
  await expect(page.locator('#projectDialog')).toBeVisible();
  await normalizeFixturePaths(page);
  await expect(page).toHaveScreenshot('add-project-dialog.png', { animations: 'disabled', fullPage: true });
  await page.getByRole('button', { name: 'Cancel' }).click();
});

test('edit project with relationships and worktrees', async () => {
  await page.getByRole('button', { name: /Projects/ }).click();
  await page.getByRole('button', { name: /Atlas Web/ }).click();
  await page.locator('#projectDetail').getByRole('button', { name: 'Edit' }).click();
  await expect(page.locator('#projectDialogTitle')).toHaveText('Edit project');
  await normalizeFixturePaths(page);
  await expect(page).toHaveScreenshot('edit-project-dialog.png', { animations: 'disabled', fullPage: true });
  await page.getByRole('button', { name: 'Cancel' }).click();
});

test('dependent project delete confirmation', async () => {
  await page.locator('#projectDetail').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('#deleteProjectDependencies')).toContainText('Release readiness');
  await expect(page).toHaveScreenshot('delete-project-dialog.png', { animations: 'disabled', fullPage: true });
  await page.locator('#deleteProjectDialog').getByRole('button', { name: 'Cancel' }).click();
});

test('workflow editor', async () => {
  await page.getByRole('button', { name: /Portfolio/ }).click();
  await page.locator('.workflow-item').filter({ hasText: 'Release readiness' }).click();
  await expect(page.locator('#workflowDialogTitle')).toHaveText('Edit workflow');
  await expect(page.locator('#workflowStepRows')).toContainText('frontend-review');
  await expect(page).toHaveScreenshot('workflow-dialog.png', { animations: 'disabled', fullPage: true });
  await page.locator('#workflowDialog').getByRole('button', { name: 'Cancel' }).click();
});

test('domain editor with dependency lock', async () => {
  await page.getByRole('button', { name: /Portfolio/ }).click();
  await page.getByRole('button', { name: 'Edit Work' }).click();
  await expect(page.locator('#domainDialogTitle')).toHaveText('Edit domain');
  await expect(page.locator('#deleteDomainButton')).toBeDisabled();
  await expect(page.locator('#domainDependencies')).toContainText('work.studio');
  await expect(page).toHaveScreenshot('domain-dialog.png', { animations: 'disabled', fullPage: true });
  await page.locator('#domainDialog').getByRole('button', { name: 'Cancel' }).click();
});

test('knowledge graph with selected skill inspector', async () => {
  await page.getByRole('button', { name: /Graph/ }).click();
  await page.locator('#graphDomain').selectOption('work');
  await page.locator('.graph-node.skill').filter({ hasText: 'frontend-review' }).click();
  await expect(page.locator('#skillInspector')).toBeVisible();
  await expectView('graph');
});

test('skill scope editor', async () => {
  await page.getByRole('button', { name: /Graph/ }).click();
  await page.locator('#graphDomain').selectOption('work');
  await page.locator('.graph-node.skill').filter({ hasText: 'frontend-review' }).click();
  await page.getByRole('button', { name: 'Change scope' }).click();
  await expect(page.locator('#skillScopeDialog')).toBeVisible();
  await expect(page.locator('#skillScopeLevel')).toHaveValue('auto');
  await normalizeFixturePaths(page);
  await expect(page).toHaveScreenshot('skill-scope-dialog.png', { animations: 'disabled', fullPage: true });
  await page.locator('#skillScopeDialog').getByRole('button', { name: 'Cancel' }).click();
});

test('graph project connection confirmation', async () => {
  await page.getByRole('button', { name: /Graph/ }).click();
  await page.locator('#graphDomain').selectOption('work');
  await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.graph-node.project')];
    const source = nodes.find((node) => node.dataset.projectId === 'atlas-web');
    const target = nodes.find((node) => node.dataset.projectId === 'atlas-api');
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.locator('#graphRelationDialog')).toBeVisible();
  await expect(page.locator('#graphRelationPreview')).toContainText('Atlas Web');
  await expect(page).toHaveScreenshot('graph-connection-dialog.png', { animations: 'disabled', fullPage: true });
  await page.locator('#graphRelationDialog').getByRole('button', { name: 'Cancel' }).click();
});

test('graph project move confirmation', async () => {
  await page.getByRole('button', { name: /Graph/ }).click();
  await page.locator('#graphDomain').selectOption('all');
  await page.evaluate(() => {
    const source = document.querySelector('[data-project-id="atlas-web"]');
    const target = document.querySelector('[data-domain-id="personal.software"]');
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.locator('#graphRelationDialog')).toBeVisible();
  await expect(page.locator('#graphRelationTitle')).toHaveText('Move project to domain');
  await expect(page).toHaveScreenshot('graph-move-dialog.png', { animations: 'disabled', fullPage: true });
  await page.locator('#graphRelationDialog').getByRole('button', { name: 'Cancel' }).click();
});

test('graph connection persists and can be removed in the project editor', async () => {
  await page.getByRole('button', { name: /Graph/ }).click();
  await page.locator('#graphDomain').selectOption('all');
  await page.evaluate(() => {
    const source = document.querySelector('[data-project-id="atlas-web"]');
    const target = document.querySelector('[data-project-id="garden-notes"]');
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await page.locator('#graphRelationType').fill('supports');
  await page.locator('#graphRelationDialog').getByRole('button', { name: 'Create connection' }).click();
  await page.getByRole('button', { name: /Projects/ }).click();
  await page.locator('#projectFilters').getByRole('button', { name: 'All' }).click();
  await page.getByRole('button', { name: /Atlas Web/ }).click();
  await expect(page.locator('#projectDetail')).toContainText('Garden Notes');
  await page.locator('#projectDetail').getByRole('button', { name: 'Edit' }).click();
  await page.locator('.relation-edit-row').evaluateAll((rows) => {
    const row = rows.find((item) => item.querySelector('select')?.value === 'garden-notes');
    row?.querySelector('button')?.click();
  });
  await page.locator('#projectDialog').getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('#projectDetail')).not.toContainText('Garden Notes');
});

test('project editor persists metadata and restores it', async () => {
  await page.getByRole('button', { name: /Projects/ }).click();
  await page.locator('#projectFilters').getByRole('button', { name: 'All' }).click();
  await page.getByRole('button', { name: /Atlas Web/ }).click();
  await page.locator('#projectDetail').getByRole('button', { name: 'Edit' }).click();
  const original = await page.locator('#projectDescription').inputValue();
  await page.locator('#projectDescription').fill('Edited from the visual registry.');
  await page.getByRole('button', { name: '+ Add', exact: true }).last().click();
  const newWorkspace = page.locator('.workspace-row').last();
  await newWorkspace.locator('input').nth(0).fill(path.join(temporaryRoot, 'extra-worktrees'));
  await newWorkspace.locator('input').nth(1).fill('atlas-web');
  await page.locator('#projectDialog').getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('#projectDetail')).toContainText('Edited from the visual registry.');
  await expect(page.locator('#projectDetail .detail-metric').filter({ hasText: 'workspaces' })).toContainText('2');
  await page.locator('#projectDetail').getByRole('button', { name: 'Edit' }).click();
  await page.locator('#projectDescription').fill(original);
  await page.locator('.workspace-row').last().getByRole('button', { name: 'Remove' }).click();
  await page.locator('#projectDialog').getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('#projectDetail')).toContainText(original);
  await expect(page.locator('#projectDetail .detail-metric').filter({ hasText: 'workspaces' })).toContainText('1');
});

test('project editor registers and removes a project without deleting its folder', async () => {
  const projectPath = path.join(temporaryRoot, 'temporary-project');
  await fs.mkdir(projectPath, { recursive: true });
  await application.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
  }, projectPath);
  await page.getByRole('button', { name: /Projects/ }).click();
  await page.getByRole('button', { name: 'Add project' }).click();
  await page.locator('#projectName').fill('Temporary Project');
  await page.locator('#projectDomain').selectOption('personal.software');
  await page.locator('#projectDialog').getByRole('button', { name: 'Add project' }).click();
  await expect(page.getByRole('button', { name: /Temporary Project/ })).toBeVisible();
  await page.getByRole('button', { name: /Temporary Project/ }).click();
  await page.locator('#projectDetail').getByRole('button', { name: 'Delete' }).click();
  await page.locator('#deleteProjectDialog').getByRole('button', { name: 'Remove from registry' }).click();
  await expect(page.getByRole('button', { name: /Temporary Project/ })).toHaveCount(0);
  await expect(fs.stat(projectPath)).resolves.toBeTruthy();
  await application.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
  }, fixture.paths['garden-notes']);
});

test('workflow editor creates and deletes a workflow', async () => {
  await page.getByRole('button', { name: /Portfolio/ }).click();
  await page.getByRole('button', { name: '+ Add', exact: true }).click();
  await page.locator('#workflowId').fill('visual-smoke');
  await page.locator('#workflowName').fill('Visual smoke');
  await page.locator('#workflowDomain').selectOption('personal.software');
  await page.locator('#workflowProject').selectOption('garden-notes');
  await page.getByRole('button', { name: '+ Add step' }).click();
  await page.locator('#workflowStepRows select').selectOption('project.garden-notes.idea-capture');
  await page.locator('#workflowDialog').getByRole('button', { name: 'Save workflow' }).click();
  await expect(page.locator('.workflow-item').filter({ hasText: 'Visual smoke' })).toBeVisible();
  await page.locator('.workflow-item').filter({ hasText: 'Visual smoke' }).click();
  await page.locator('#workflowDialog').getByRole('button', { name: 'Delete workflow' }).click();
  await expect(page.locator('#deleteEntityDialog')).toBeVisible();
  await page.locator('#deleteEntityDialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.workflow-item').filter({ hasText: 'Visual smoke' })).toHaveCount(0);
});

test('domain editor creates and deletes a root domain', async () => {
  await page.getByRole('button', { name: /Portfolio/ }).click();
  await page.getByRole('button', { name: '+ Add domain' }).click();
  await page.locator('#domainId').fill('research');
  await page.locator('#domainName').fill('Research');
  await page.locator('#domainDescription').fill('Temporary visual editor verification.');
  await page.locator('#domainDialog').getByRole('button', { name: 'Save domain' }).click();
  await expect(page.getByRole('button', { name: 'Edit Research' })).toBeVisible();
  await page.getByRole('button', { name: /Projects/ }).click();
  await expect(page.locator('#projectFilters').getByRole('button', { name: 'Research' })).toBeVisible();
  await page.getByRole('button', { name: /Portfolio/ }).click();
  await page.getByRole('button', { name: 'Edit Research' }).click();
  await page.locator('#domainDialog').getByRole('button', { name: 'Delete domain' }).click();
  await page.locator('#deleteEntityDialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('button', { name: 'Edit Research' })).toHaveCount(0);
});

test('skill scope editor persists an override and restores automatic ownership', async () => {
  await page.getByRole('button', { name: /Graph/ }).click();
  await page.locator('#graphDomain').selectOption('work');
  await page.locator('.graph-node.skill').filter({ hasText: 'frontend-review' }).click();
  await page.getByRole('button', { name: 'Change scope' }).click();
  await page.locator('#skillScopeLevel').selectOption('domain');
  await page.locator('#skillScopeDomain').selectOption('work.studio');
  await page.locator('#skillScopeDialog').getByRole('button', { name: 'Save scope' }).click();
  await expect(page.locator('[data-node-id="skill:domain.work.studio.frontend-review"]')).toBeVisible();
  await page.locator('.graph-node.skill').filter({ hasText: 'frontend-review' }).click();
  await expect(page.locator('#skillInspector code')).toContainText('domain.work.studio.frontend-review');
  await page.getByRole('button', { name: 'Change scope' }).click();
  await expect(page.locator('#skillScopeLevel')).toHaveValue('domain');
  await page.locator('#skillScopeLevel').selectOption('auto');
  await page.locator('#skillScopeDialog').getByRole('button', { name: 'Save scope' }).click();
  await expect(page.locator('[data-node-id="skill:project.atlas-web.frontend-review"]')).toBeVisible();
  await page.locator('.graph-node.skill').filter({ hasText: 'frontend-review' }).click();
  await expect(page.locator('#skillInspector code')).toContainText('project.atlas-web.frontend-review');
});

test('graph move persists a project domain and can be reversed', async () => {
  await page.getByRole('button', { name: /Graph/ }).click();
  await page.locator('#graphDomain').selectOption('all');
  const dragProjectToDomain = async (domainId) => page.evaluate((targetDomainId) => {
    const source = document.querySelector('[data-project-id="atlas-web"]');
    const target = document.querySelector(`[data-domain-id="${targetDomainId}"]`);
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, domainId);
  await dragProjectToDomain('personal.software');
  await page.locator('#graphRelationDialog').getByRole('button', { name: 'Move project' }).click();
  await page.getByRole('button', { name: /Projects/ }).click();
  await page.locator('#projectFilters').getByRole('button', { name: 'Personal' }).click();
  await page.getByRole('button', { name: /Atlas Web/ }).click();
  await expect(page.locator('#projectDetail')).toContainText('personal.software');
  await page.getByRole('button', { name: /Graph/ }).click();
  await page.locator('#graphDomain').selectOption('all');
  await dragProjectToDomain('work.studio');
  await page.locator('#graphRelationDialog').getByRole('button', { name: 'Move project' }).click();
  await page.getByRole('button', { name: /Projects/ }).click();
  await page.locator('#projectFilters').getByRole('button', { name: 'Work' }).click();
  await page.getByRole('button', { name: /Atlas Web/ }).click();
  await expect(page.locator('#projectDetail')).toContainText('work.studio');
});

test('resolved project context simulation', async () => {
  await page.getByRole('button', { name: /Simulator/ }).click();
  await page.locator('#simulatorPath').fill(fixture.paths['atlas-web']);
  await page.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.locator('#simulationResult')).toContainText('Atlas Web');
  await expectView('simulator');
});

test('collision radar', async () => {
  await page.getByRole('button', { name: /Conflicts/ }).click();
  await expect(page.locator('#conflictList')).toContainText('inspect');
  await expectView('conflicts');
});

test('health validation', async () => {
  await page.getByRole('button', { name: /Health/ }).click();
  await expect(page.locator('#healthTitle')).toHaveText('Core is healthy');
  await expectView('health');
});

test('global search overlay', async () => {
  await page.getByRole('button', { name: /Health/ }).click();
  await expect(page.locator('#healthTitle')).toHaveText('Core is healthy');
  await page.getByLabel('Find a project or skill').fill('atlas');
  await expect(page.locator('#searchOverlay')).toBeVisible();
  await normalizeFixturePaths(page);
  await expect(page).toHaveScreenshot('global-search.png', { animations: 'disabled', fullPage: true });
  await page.keyboard.press('Escape');
});

test('project registry at minimum supported window size', async () => {
  await page.setViewportSize({ width: 1060, height: 720 });
  await page.getByRole('button', { name: /Projects/ }).click();
  await expect(page.locator('#view-projects')).toHaveClass(/active/);
  await normalizeFixturePaths(page);
  await expect(page).toHaveScreenshot('projects-minimum-window.png', { animations: 'disabled', fullPage: true });
  await page.setViewportSize({ width: 1480, height: 960 });
});

test('registry unavailable recovery screen', async () => {
  const unavailableRegistry = path.join(temporaryRoot, 'unavailable-registry');
  await fs.mkdir(path.join(unavailableRegistry, 'config'), { recursive: true });
  await fs.writeFile(
    path.join(unavailableRegistry, 'config', 'brain.json'),
    `${JSON.stringify({
      schema_version: 'agent-brain.config.v1',
      owner: 'visual-tests',
      default_domain: 'meta',
      skill_roots: [],
      instruction_files: [],
      domain_path_rules: [],
      skill_scope_rules: [],
      active_plugins: [],
      source_priority_rules: []
    }, null, 2)}\n`,
    'utf8'
  );
  const unavailableApplication = await electron.launch({
    args: [
      root,
      '--disable-gpu',
      '--force-device-scale-factor=1',
      `--user-data-dir=${path.join(temporaryRoot, 'unavailable-profile')}`
    ],
    cwd: root,
    env: {
      ...process.env,
      AGENT_BRAIN_HOME: unavailableRegistry,
      AGENT_BRAIN_PYTHON: '/usr/bin/false',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TZ: 'UTC'
    }
  });
  try {
    expect(await unavailableApplication.evaluate(({ app }) => app.getPath('userData')))
      .toBe(path.join(temporaryRoot, 'unavailable-profile'));
    const unavailablePage = await unavailableApplication.firstWindow();
    await unavailablePage.setViewportSize({ width: 1480, height: 960 });
    await unavailablePage.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await expect(unavailablePage.locator('#loadingScreen')).toHaveClass(/failed/);
    await expect(unavailablePage.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(unavailablePage).toHaveScreenshot('registry-unavailable.png', {
      animations: 'disabled',
      fullPage: true
    });
  } finally {
    await unavailableApplication.close();
  }
});

test('graph canvas pans with the pointer and zooms with the controls', async () => {
  await page.getByRole('button', { name: /Graph/ }).click();
  await page.locator('#graphDomain').selectOption('all');
  await page.locator('#graphZoomReset').click();
  const before = await page.locator('#graphWorld').evaluate((world) => world.style.transform);
  const canvas = await page.locator('#graphCanvas').boundingBox();
  await page.mouse.move(canvas.x + 294, canvas.y + 400);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 214, canvas.y + 330, { steps: 5 });
  await page.mouse.up();
  const after = await page.locator('#graphWorld').evaluate((world) => world.style.transform);
  expect(after).not.toBe(before);
  await page.locator('#graphZoomIn').click();
  await expect(page.locator('#graphZoomLevel')).toHaveText('120%');
  await page.locator('#graphZoomOut').click();
  await expect(page.locator('#graphZoomLevel')).toHaveText('100%');
  await page.locator('#graphZoomReset').click();
  await expect(page.locator('#graphWorld')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 24, 24)');
});

test('graph node drags freely and keeps its position across re-renders', async () => {
  await page.getByRole('button', { name: /Graph/ }).click();
  await page.locator('#graphDomain').selectOption('all');
  await page.locator('#graphZoomReset').click();
  const node = page.locator('[data-project-id="atlas-web"]');
  const beforeLeft = await node.evaluate((el) => el.style.left);
  const box = await node.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 14);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + 14 + 70, { steps: 6 });
  await page.mouse.up();
  const afterLeft = await node.evaluate((el) => el.style.left);
  expect(afterLeft).not.toBe(beforeLeft);
  await page.locator('#graphDomain').selectOption('work');
  await page.locator('#graphDomain').selectOption('all');
  const persisted = await page.locator('[data-project-id="atlas-web"]').evaluate((el) => el.style.left);
  expect(Math.abs(parseFloat(persisted) - parseFloat(afterLeft))).toBeLessThanOrEqual(1);
  const moved = await page.locator('[data-project-id="atlas-web"]').boundingBox();
  await page.mouse.move(moved.x + moved.width / 2, moved.y + 14);
  await page.mouse.down();
  await page.mouse.move(moved.x + moved.width / 2 - 90, moved.y + 14 - 70, { steps: 6 });
  await page.mouse.up();
});

test('port drag draws a live edge and opens the connection dialog', async () => {
  await page.getByRole('button', { name: /Graph/ }).click();
  await page.locator('#graphDomain').selectOption('all');
  await page.locator('#graphZoomReset').click();
  const port = await page.locator('[data-project-id="atlas-web"] .port.out').boundingBox();
  const target = await page.locator('[data-project-id="garden-notes"]').boundingBox();
  await page.mouse.move(port.x + port.width / 2, port.y + port.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await expect(page.locator('#graphEdges path.live')).toHaveCount(1);
  await expect(page.locator('[data-project-id="garden-notes"]')).toHaveClass(/drop-target/);
  await page.mouse.up();
  await expect(page.locator('#graphRelationDialog')).toBeVisible();
  await expect(page.locator('#graphRelationTitle')).toHaveText('Create project link');
  await page.locator('#graphRelationDialog').getByRole('button', { name: 'Cancel' }).click();
});

test('edge click selects a relation and deletes it from the canvas', async () => {
  await page.getByRole('button', { name: /Graph/ }).click();
  await page.locator('#graphDomain').selectOption('all');
  await page.locator('#graphZoomReset').click();
  const port = await page.locator('[data-project-id="atlas-web"] .port.out').boundingBox();
  const target = await page.locator('[data-project-id="garden-notes"]').boundingBox();
  await page.mouse.move(port.x + port.width / 2, port.y + port.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.locator('#graphRelationType').fill('supports');
  await page.locator('#graphRelationDialog').getByRole('button', { name: 'Create connection' }).click();
  const newEdge = page.locator('#graphEdges path.edge-hit[data-key="project:atlas-web|project:garden-notes|supports"]');
  await expect(newEdge).toHaveCount(1);
  await newEdge.dispatchEvent('pointerdown', { button: 0 });
  await expect(page.locator('#edgeToolbar')).toBeVisible();
  await expect(page.locator('#edgeToolbarLabel')).toContainText('supports');
  await page.locator('#edgeDeleteButton').click();
  await expect(page.locator('#deleteEntityTitle')).toHaveText('Delete connection?');
  await page.locator('#deleteEntityDialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('#graphEdges path.edge-hit[data-key="project:atlas-web|project:garden-notes|supports"]')).toHaveCount(0);
});

test('node inspector opens for domain, project, workflow, and core nodes', async () => {
  await page.getByRole('button', { name: /Graph/ }).click();
  await page.locator('#graphDomain').selectOption('all');
  await page.locator('#graphZoomFit').click();
  await page.locator('.graph-node.domain').filter({ hasText: 'Work' }).first().click();
  await expect(page.locator('#skillInspector')).toContainText('Edit domain');
  await normalizeFixturePaths(page);
  await expect(page.locator('#skillInspector')).toHaveScreenshot('graph-node-inspector.png', { animations: 'disabled' });
  await page.locator('[data-project-id="garden-notes"]').click();
  await expect(page.locator('#skillInspector')).toContainText('Open in Projects');
  await page.locator('.graph-node.flow').first().click();
  await expect(page.locator('#skillInspector')).toContainText('Edit workflow');
  await page.locator('[data-node-id="core"]').click();
  await expect(page.locator('#skillInspector')).toContainText('global skills');
});

test('folder inspector shows the harness and toggles a skill', async () => {
  await page.getByRole('button', { name: /Folder/ }).click();
  await page.locator('#inspectorPath').fill(fixture.paths['atlas-web']);
  await page.locator('#inspectButton').click();
  await expect(page.locator('#inspectorResult .context-card').first()).toContainText('Domain');
  await expect(page.locator('.harness-panel').filter({ hasText: 'Instruction files' })).toContainText('AGENTS.md');

  const skillRow = () => page.locator('.harness-row').filter({ hasText: 'frontend-review' }).first();
  await expect(skillRow()).toBeVisible();
  await skillRow().getByRole('button', { name: 'Off' }).click();
  await expect(skillRow()).toContainText('off @ local');

  const settingsPath = path.join(fixture.paths['atlas-web'], '.claude', 'settings.local.json');
  const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  expect(settings.skillOverrides['frontend-review']).toBe('off');

  await skillRow().getByRole('button', { name: 'On' }).click();
  await expect(skillRow()).toContainText('on @ local');
  const restored = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  expect(restored.skillOverrides['frontend-review']).toBe('on');

  const ruleRow = () => page.locator('.harness-row').filter({ hasText: 'Tone of voice' }).first();
  await expect(ruleRow()).toContainText('user');
  await ruleRow().getByRole('button', { name: 'Off' }).click();
  await expect(ruleRow().getByRole('button', { name: 'On' })).toBeVisible();
  const rulePath = path.join(fixture.home, '.claude', 'rules', 'tone.md');
  await expect(async () => {
    await fs.access(`${rulePath}.disabled`);
  }).toPass();
  await ruleRow().getByRole('button', { name: 'On' }).click();
  await expect(ruleRow().getByRole('button', { name: 'Off' })).toBeVisible();
  await fs.access(rulePath);
});
