const state = {
  inventory: null,
  view: 'portfolio',
  projectFilter: 'all',
  conflictFilter: 'all',
  selectedProject: null,
  selectedSkill: null,
  validation: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const rootDomain = (domain = 'meta') => domain.split('.')[0];
const colors = { work: '#4aa8ff', personal: '#f3b84b', creative: '#e76fae', meta: '#9c83ff' };
const icons = { work: 'W', personal: 'P', creative: 'I', meta: 'M' };
let simulationRequest = 0;
let validationPromise = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clear(node) { node.replaceChildren(); }
function projectById(id) { return state.inventory.projects.find((project) => project.id === id); }
function domainById(id) { return state.inventory.domains.find((domain) => domain.id === id); }
function projectSkills(id) { return state.inventory.skills.filter((skill) => skill.scope.project === id); }
function projectInstructions(id) { return state.inventory.instructions.filter((item) => item.project === id); }
function projectWorkflows(id) { return state.inventory.workflows.filter((workflow) => workflow.project === id); }
function projectsForRoot(root) { return state.inventory.projects.filter((project) => rootDomain(project.domain) === root); }
function domainsForRoot(root) { return state.inventory.domains.filter((domain) => rootDomain(domain.id) === root); }
function domainColor(domainId) { const root = rootDomain(domainId); return colors[root] || domainById(root)?.color || domainById(domainId)?.color || '#4aa8ff'; }
function domainIcon(domain) { return icons[rootDomain(domain.id)] || String(domain.icon || domain.name || '?').slice(0, 1).toUpperCase(); }

function showNotice(message, error = false) {
  const notice = $('#notice');
  notice.textContent = message;
  notice.classList.toggle('error', error);
  notice.hidden = false;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => { notice.hidden = true; }, 5000);
}

function setRuntimeStatus(status, label) {
  const card = $('.runtime-card');
  card.classList.remove('online', 'stale', 'offline');
  card.classList.add(status);
  $('#runtimeStatus').textContent = label;
}

function setView(view) {
  state.view = view;
  $$('.nav-item').forEach((item) => {
    const active = item.dataset.view === view;
    item.classList.toggle('active', active);
    item.setAttribute('aria-current', active ? 'page' : 'false');
  });
  $$('.view').forEach((item) => item.classList.toggle('active', item.id === `view-${view}`));
  const copy = {
    portfolio: ['CONTEXT PORTFOLIO', 'Your whole system — |in one place.'],
    projects: ['PROJECT REGISTRY', 'Projects and their |real relationships.'],
    graph: ['KNOWLEDGE GRAPH', 'From domain — |to action.'],
    simulator: ['CONTEXT RESOLVER', 'Resolve context |before launch.'],
    conflicts: ['COLLISION RADAR', 'Conflicts |without surprises.'],
    health: ['SYSTEM HEALTH', 'Trust, then |verify.']
  }[view];
  $('#viewEyebrow').textContent = copy[0];
  const title = $('#viewTitle');
  clear(title);
  const [plain, emphasis] = copy[1].split('|');
  title.append(document.createTextNode(plain), element('em', '', emphasis));
  if (view === 'graph') requestAnimationFrame(renderGraph);
  if (view === 'health' && !state.validation) runValidation();
}

function renderShell() {
  const { stats } = state.inventory;
  $('#sideSources').textContent = stats.skill_sources;
  $('#sideProjects').textContent = stats.project_count;
  $('#sideFlows').textContent = stats.workflow_count;
  $('#conflictBadge').textContent = stats.unresolved_collision_count;
}

function renderMetrics() {
  const stats = state.inventory.stats;
  const projectSkillCount = stats.scope_counts.project || 0;
  const items = [
    ['Projects', stats.project_count, `${state.inventory.projects.filter((p) => p.exists).length} paths available`],
    ['Skill sources', stats.skill_sources, `${stats.skill_mounts} runtime mounts`],
    ['Project skills', projectSkillCount, `${state.inventory.projects.filter((p) => p.coverage.skill_count).length} projects covered`],
    ['Collisions', stats.collision_count, `${stats.unresolved_collision_count} need attention`]
  ];
  const grid = $('#metricGrid'); clear(grid);
  for (const [label, value, note] of items) {
    const card = element('article', 'metric-card');
    card.append(element('span', '', label), element('strong', '', String(value)), element('small', '', note));
    grid.append(card);
  }
}

function renderDomains() {
  const top = state.inventory.domains.filter((domain) => !domain.parent);
  const grid = $('#domainGrid'); clear(grid);
  for (const domain of top) {
    const root = rootDomain(domain.id);
    const projects = projectsForRoot(root);
    const skills = state.inventory.skills.filter((skill) => skill.scope.domain && rootDomain(skill.scope.domain) === root);
    const card = element('article', 'domain-card');
    card.style.setProperty('--accent', domainColor(domain.id));
    const icon = element('span', 'domain-icon', domainIcon(domain));
    const title = element('h3', '', domain.name);
    const description = element('p', '', domain.description);
    const footer = element('footer');
    footer.append(element('span', '', `${projects.length} projects`), element('span', '', `${skills.length} domain skills`));
    const actions = element('span', 'domain-card-actions'); const edit = element('button', '', '···'); edit.type = 'button'; edit.setAttribute('aria-label', `Edit ${domain.name}`); actions.append(edit);
    edit.addEventListener('click', () => openDomainDialog(domain));
    const main = element('button', 'domain-card-main'); main.append(icon, title, description, footer);
    main.addEventListener('click', () => {
      state.projectFilter = root;
      syncFilterButtons('#projectFilters', root);
      renderProjects();
      setView('projects');
    });
    card.append(actions, main);
    const children = state.inventory.domains.filter((item) => item.parent === domain.id);
    if (children.length) { const childList = element('div', 'domain-children'); for (const child of children) { const button = element('button', 'domain-child', child.name); button.addEventListener('click', () => openDomainDialog(child)); childList.append(button); } card.append(childList); }
    grid.append(card);
  }
  if (!top.length) grid.append(element('div', 'empty-state', 'No domains have been described yet.'));
}

function renderCoverage() {
  const projects = state.inventory.projects;
  const metrics = [
    ['Instructions', projects.filter((p) => p.coverage.instruction_count > 0).length, '#4aa8ff'],
    ['Project skills', projects.filter((p) => p.coverage.skill_count > 0).length, '#4bd2a0'],
    ['Workflows', projects.filter((p) => p.coverage.workflow_count > 0).length, '#e76fae'],
    ['Relationships', projects.filter((p) => p.coverage.related_project_count > 0).length, '#f3b84b'],
    ['Worktree rules', projects.filter((p) => p.coverage.workspace_rule_count > 0).length, '#9c83ff']
  ];
  const list = $('#coverageList'); clear(list);
  for (const [label, count, color] of metrics) {
    const row = element('div', 'coverage-row');
    const bar = element('div', 'coverage-bar');
    const fill = element('i'); fill.style.setProperty('--width', `${projects.length ? Math.round(count / projects.length * 100) : 0}%`); fill.style.setProperty('--color', color); bar.append(fill);
    row.append(element('span', '', label), bar, element('b', '', `${count}/${projects.length}`)); list.append(row);
  }
  const total = metrics.reduce((sum, item) => sum + item[1], 0);
  $('#coverageScore').textContent = `${projects.length ? Math.round(total / (metrics.length * projects.length) * 100) : 0}%`;
}

function renderWorkflows() {
  $('#workflowCount').textContent = `${state.inventory.workflows.length} flows`;
  const list = $('#workflowList'); clear(list);
  for (const workflow of state.inventory.workflows) {
    const item = element('button', 'workflow-item');
    item.append(element('strong', '', workflow.name), element('span', '', workflow.steps.join(' → '))); list.append(item);
    item.addEventListener('click', () => openWorkflowDialog(workflow));
  }
  if (!state.inventory.workflows.length) list.append(element('div', 'empty-state', 'No workflows have been described yet.'));
}

function syncFilterButtons(selector, value) {
  $$(selector + ' button').forEach((button) => {
    const active = button.dataset.filter === value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function renderProjectFilters() {
  const filters = $('#projectFilters');
  clear(filters);
  const roots = state.inventory.domains.filter((domain) => !domain.parent);
  for (const [id, label] of [['all', 'All'], ...roots.map((domain) => [domain.id, domain.name])]) {
    const button = element('button', '', label);
    button.dataset.filter = id;
    filters.append(button);
  }
  if (state.projectFilter !== 'all' && !roots.some((domain) => domain.id === state.projectFilter)) {
    state.projectFilter = 'all';
  }
  syncFilterButtons('#projectFilters', state.projectFilter);
}

function renderProjects() {
  const filtered = state.inventory.projects.filter((project) => state.projectFilter === 'all' || rootDomain(project.domain) === state.projectFilter);
  $('#projectCount').textContent = `${filtered.length} projects`;
  const list = $('#projectList'); clear(list);
  for (const project of filtered) {
    const row = element('button', 'project-row');
    row.style.setProperty('--accent', domainColor(project.domain));
    row.classList.toggle('active', state.selectedProject === project.id);
    const body = element('span'); body.append(element('strong', '', project.name), element('small', '', project.path));
    const dots = element('span', 'coverage-dots');
    for (const covered of [project.coverage.instruction_count, project.coverage.skill_count, project.coverage.workflow_count, project.coverage.related_project_count]) {
      dots.append(element('i', covered ? 'on' : ''));
    }
    row.append(body, dots);
    row.addEventListener('click', () => {
      state.selectedProject = project.id;
      renderProjects();
      renderProjectDetail(project);
      if (window.innerWidth <= 1180) $('#projectDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    list.append(row);
  }
  if (!filtered.length) list.append(element('div', 'empty-state', 'No projects in this domain yet.'));
  const selected = filtered.find((project) => project.id === state.selectedProject) || filtered[0];
  if (selected) { state.selectedProject = selected.id; renderProjectDetail(selected); }
  else { state.selectedProject = null; clear($('#projectDetail')); $('#projectDetail').append(element('div', 'empty-state', 'Add a project to connect instructions, skills, and workflows.')); }
}

function renderProjectDetail(project) {
  const detail = $('#projectDetail'); clear(detail);
  const header = element('header', 'project-detail-header');
  const copy = element('div'); copy.append(element('p', 'eyebrow', `${project.domain} · ${project.kind || 'project'}`), element('h2', '', project.name), element('p', '', project.description || 'No description has been added yet.'));
  const actions = element('div', 'project-detail-actions');
  const edit = element('button', '', 'Edit'); edit.addEventListener('click', () => openProjectEditor(project));
  const remove = element('button', 'delete-project', 'Delete'); remove.addEventListener('click', () => openDeleteProjectDialog(project));
  const reveal = element('button', 'reveal-button', '↗'); reveal.title = 'Reveal in Finder'; reveal.setAttribute('aria-label', 'Reveal project in Finder'); reveal.addEventListener('click', async () => {
    try { await window.agentBrain.revealPath(project.path); } catch (error) { showNotice(error.message, true); }
  });
  actions.append(edit, remove, reveal); header.append(copy, actions); detail.append(header, element('div', 'path-line', project.path));

  const c = project.coverage;
  const metrics = element('div', 'detail-metrics');
  for (const [value, label] of [[c.instruction_count, 'instructions'], [c.skill_count, 'skills'], [c.workflow_count, 'workflows'], [c.workspace_rule_count, 'workspaces']]) {
    const metric = element('div', 'detail-metric'); metric.append(element('b', '', String(value)), element('span', '', label)); metrics.append(metric);
  }
  detail.append(metrics);

  const instructions = projectInstructions(project.id);
  detail.append(detailSection('Instructions', instructions.map((item) => ({ label: `${item.runtime} · ${item.path.split('/').pop()}`, missing: !item.exists }))));
  detail.append(detailSection('Project skills', projectSkills(project.id).map((skill) => ({ label: skill.name }))));
  detail.append(detailSection('Workflows', projectWorkflows(project.id).map((flow) => ({ label: flow.name }))));

  const relations = element('section', 'detail-section'); relations.append(element('h3', '', 'Related projects'));
  const relationList = element('div', 'relation-list');
  for (const relation of project.related_projects || []) {
    const row = element('div', 'relation'); row.append(element('span', '', relation.type), element('b', '', projectById(relation.project)?.name || relation.project)); relationList.append(row);
  }
  if (!(project.related_projects || []).length) relationList.append(element('div', 'empty-state', 'No relationships described'));
  relations.append(relationList); detail.append(relations);
}

function detailSection(title, items) {
  const section = element('section', 'detail-section'); section.append(element('h3', '', title));
  const tags = element('div', 'tag-list');
  if (items.length) for (const item of items) tags.append(element('span', `tag${item.missing ? ' missing' : ''}`, item.label));
  else tags.append(element('span', 'tag missing', 'Not configured'));
  section.append(tags); return section;
}

const graphView = { pan: { x: 24, y: 24 }, zoom: 1, userAdjusted: false, positions: loadGraphPositions(), nodeIndex: new Map(), links: [], selectedEdge: null, inspected: null };

function loadGraphPositions() { try { return new Map(Object.entries(JSON.parse(localStorage.getItem('agentBrain.graphPositions') || '{}'))); } catch { return new Map(); } }
function saveGraphPositions() { try { localStorage.setItem('agentBrain.graphPositions', JSON.stringify(Object.fromEntries(graphView.positions))); } catch { /* positions are a view preference; losing them is acceptable */ } }

function applyGraphTransform() {
  $('#graphWorld').style.transform = `translate(${graphView.pan.x}px, ${graphView.pan.y}px) scale(${graphView.zoom})`;
  $('#graphZoomLevel').textContent = `${Math.round(graphView.zoom * 100)}%`;
  positionEdgeToolbar();
}

function clientToWorld(event) {
  const rect = $('#graphCanvas').getBoundingClientRect();
  return { x: (event.clientX - rect.left - graphView.pan.x) / graphView.zoom, y: (event.clientY - rect.top - graphView.pan.y) / graphView.zoom };
}

function setGraphZoom(zoom, centerX, centerY) {
  const rect = $('#graphCanvas').getBoundingClientRect();
  const cx = centerX ?? rect.width / 2; const cy = centerY ?? rect.height / 2;
  const next = Math.min(2.5, Math.max(.2, zoom));
  graphView.pan.x = cx - (cx - graphView.pan.x) * (next / graphView.zoom);
  graphView.pan.y = cy - (cy - graphView.pan.y) * (next / graphView.zoom);
  graphView.zoom = next;
  applyGraphTransform();
}

function fitGraphView() {
  const items = [...graphView.nodeIndex.values()]; if (!items.length) return;
  const rect = $('#graphCanvas').getBoundingClientRect();
  const minX = Math.min(...items.map((item) => item.x)); const minY = Math.min(...items.map((item) => item.y));
  const maxX = Math.max(...items.map((item) => item.x + item.w)); const maxY = Math.max(...items.map((item) => item.y + item.h));
  const zoom = Math.min(2.5, Math.max(.2, Math.min((rect.width - 80) / Math.max(1, maxX - minX), (rect.height - 80) / Math.max(1, maxY - minY), 1)));
  graphView.zoom = zoom;
  graphView.pan.x = (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom;
  graphView.pan.y = (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom;
  applyGraphTransform();
}

function attachNodePointer(node, id, kind, entity) {
  node.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('.port')) return;
    event.preventDefault(); event.stopPropagation();
    const item = graphView.nodeIndex.get(id);
    const start = { x: event.clientX, y: event.clientY }; const origin = { x: item.x, y: item.y }; let moved = false;
    const onMove = (move) => {
      if (!moved && Math.hypot(move.clientX - start.x, move.clientY - start.y) < 4) return;
      moved = true;
      item.x = origin.x + (move.clientX - start.x) / graphView.zoom;
      item.y = origin.y + (move.clientY - start.y) / graphView.zoom;
      node.style.left = `${item.x}px`; node.style.top = `${item.y}px`;
      drawGraphEdges();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp);
      if (moved) { graphView.positions.set(id, { x: Math.round(item.x), y: Math.round(item.y) }); saveGraphPositions(); }
      else if (kind === 'skill') selectSkill(entity.id);
      else inspectNode(kind, entity, id);
    };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
  });
  node.tabIndex = 0;
  node.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (kind === 'skill') selectSkill(entity.id); else inspectNode(kind, entity, id);
  });
}

function attachPorts(node, id, kind) {
  if (kind !== 'project' && kind !== 'domain') return;
  const input = element('span', 'port in'); input.title = 'Connection target'; node.append(input);
  if (kind !== 'project') return;
  const output = element('span', 'port out'); output.title = 'Drag to another project or domain';
  output.addEventListener('pointerdown', (event) => startConnect(event, id, node));
  node.append(output);
}

function startConnect(event, sourceId, sourceNode) {
  if (event.button !== 0) return;
  event.preventDefault(); event.stopPropagation();
  const live = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  live.classList.add('live'); $('#graphEdges').append(live);
  sourceNode.classList.add('connecting');
  const source = graphView.nodeIndex.get(sourceId);
  const sourceRaw = sourceId.slice(sourceId.indexOf(':') + 1);
  let target = null;
  const validTarget = (el) => {
    const hit = el?.closest?.('.graph-node'); if (!hit) return null;
    const id = hit.dataset.nodeId || ''; const item = graphView.nodeIndex.get(id); if (!item) return null;
    if (item.kind === 'project' && id !== sourceId) return { hit, id, kind: 'project' };
    if (item.kind === 'domain' && projectById(sourceRaw)?.domain !== item.entity.id) return { hit, id, kind: 'domain' };
    return null;
  };
  const onMove = (move) => {
    const point = clientToWorld(move);
    const x1 = source.x + source.w; const y1 = source.y + source.h / 2; const bend = Math.max(30, (point.x - x1) * .45);
    live.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${point.x - bend} ${point.y}, ${point.x} ${point.y}`);
    const next = validTarget(document.elementFromPoint(move.clientX, move.clientY));
    if (target && target.hit !== next?.hit) target.hit.classList.remove('drop-target');
    if (next) next.hit.classList.add('drop-target');
    target = next;
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp);
    live.remove(); sourceNode.classList.remove('connecting');
    if (!target) return;
    target.hit.classList.remove('drop-target');
    const targetRaw = target.id.slice(target.id.indexOf(':') + 1);
    if (target.kind === 'project') openGraphRelationDialog(sourceRaw, targetRaw);
    else openGraphMoveDialog(sourceRaw, targetRaw);
  };
  window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
}

function drawGraphEdges() {
  const edges = $('#graphEdges'); clear(edges); const relationText = $('#graphRelations'); clear(relationText);
  for (const [from, to, showVisual = true, label = ''] of graphView.links) {
    const a = graphView.nodeIndex.get(from); const b = graphView.nodeIndex.get(to); if (!a || !b) continue;
    relationText.append(element('li', '', `${from} → ${to}`));
    if (!showVisual) continue;
    const x1 = a.x + a.w; const y1 = a.y + a.h / 2; const x2 = b.x; const y2 = b.y + b.h / 2; const bend = Math.max(30, (x2 - x1) * .45);
    const d = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
    const pathNode = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathNode.setAttribute('d', d);
    edges.append(pathNode);
    if (label && from.startsWith('project:') && to.startsWith('project:')) {
      const key = `${from}|${to}|${label}`;
      pathNode.classList.add('relation-edge');
      pathNode.classList.toggle('selected', graphView.selectedEdge?.key === key);
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hit.setAttribute('d', d); hit.classList.add('edge-hit'); hit.dataset.key = key;
      hit.addEventListener('pointerdown', (event) => { event.stopPropagation(); selectEdge(key, from, to, label); });
      edges.append(hit);
    }
    if (label) {
      const textNode = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      textNode.setAttribute('x', String((x1 + x2) / 2)); textNode.setAttribute('y', String((y1 + y2) / 2 - 7)); textNode.setAttribute('text-anchor', 'middle'); textNode.textContent = label; edges.append(textNode);
    }
  }
  positionEdgeToolbar();
}

function selectEdge(key, source, target, type) {
  graphView.selectedEdge = { key, source, target, type };
  drawGraphEdges();
}

function clearEdgeSelection() {
  if (!graphView.selectedEdge) return;
  graphView.selectedEdge = null;
  drawGraphEdges();
}

function positionEdgeToolbar() {
  const toolbar = $('#edgeToolbar'); const selection = graphView.selectedEdge;
  if (!selection) { toolbar.hidden = true; return; }
  const a = graphView.nodeIndex.get(selection.source); const b = graphView.nodeIndex.get(selection.target);
  if (!a || !b) { toolbar.hidden = true; return; }
  const mx = (a.x + a.w + b.x) / 2; const my = (a.y + a.h / 2 + b.y + b.h / 2) / 2;
  toolbar.style.left = `${graphView.pan.x + mx * graphView.zoom}px`;
  toolbar.style.top = `${graphView.pan.y + my * graphView.zoom}px`;
  $('#edgeToolbarLabel').textContent = `${projectById(selection.source.slice(8))?.name || selection.source} · ${selection.type} · ${projectById(selection.target.slice(8))?.name || selection.target}`;
  toolbar.hidden = false;
}

function openDeleteRelationDialog(selection) {
  const dialog = $('#deleteEntityDialog');
  dialog.dataset.kind = 'relation'; dialog.dataset.id = selection.source.slice(8);
  dialog.dataset.target = selection.target.slice(8); dialog.dataset.relationType = selection.type;
  $('#deleteEntityTitle').textContent = 'Delete connection?';
  $('#deleteEntityCopy').textContent = `The "${selection.type}" connection from ${projectById(selection.source.slice(8))?.name || ''} to ${projectById(selection.target.slice(8))?.name || ''} will be removed.`;
  dialog.showModal(); $('#confirmDeleteEntity').focus();
}

function renderGraph() {
  const selected = $('#graphDomain').value || 'all';
  const domains = selected === 'all' ? state.inventory.domains : domainsForRoot(rootDomain(selected));
  const projects = state.inventory.projects.filter((project) => selected === 'all' || rootDomain(project.domain) === rootDomain(selected));
  const workflows = state.inventory.workflows.filter((workflow) => selected === 'all' || rootDomain(workflow.domain) === rootDomain(selected));
  const allGraphSkills = state.inventory.skills.filter((skill) => {
    if (skill.scope.level === 'archive') return false;
    const pluginActive = skill.scope.level !== 'plugin' || (state.inventory.config?.active_plugins || []).includes(skill.scope.plugin);
    if (!pluginActive) return false;
    if (selected === 'all') return ['global', 'plugin'].includes(skill.scope.level);
    if (skill.scope.level === 'global' || skill.scope.level === 'plugin') return true;
    return skill.scope.domain && rootDomain(skill.scope.domain) === rootDomain(selected);
  });
  let skills = allGraphSkills.slice(0, 36);
  const selectedSkill = state.inventory.skills.find((skill) => skill.id === state.selectedSkill);
  if (selectedSkill && !skills.some((skill) => skill.id === selectedSkill.id)) skills = [...skills.slice(0, 35), selectedSkill];
  const nodes = $('#graphNodes'); clear(nodes);
  graphView.nodeIndex = new Map();
  const saved = graphView.positions;
  const addNode = (id, title, subtitle, x, y, color, kind = 'core', entity = null) => {
    const override = saved.get(id); if (override) { x = override.x; y = override.y; }
    const node = element('article', `graph-node ${kind === 'core' ? '' : kind}`.trim());
    node.style.left = `${x}px`; node.style.top = `${y}px`; node.style.setProperty('--node-color', color);
    node.dataset.nodeId = id;
    node.append(element('strong', '', title), element('small', '', subtitle));
    nodes.append(node);
    graphView.nodeIndex.set(id, { x, y, w: kind === 'skill' ? 245 : 220, h: 68, node, kind, entity });
    attachNodePointer(node, id, kind, entity); attachPorts(node, id, kind);
    return node;
  };
  addNode('core', 'Global Core', 'safety · precedence · global skills', 32, 35, '#f2eee4');
  const top = domains.filter((domain) => !domain.parent);
  top.forEach((domain, index) => { const node = addNode(`domain:${domain.id}`, domain.name, domain.id, 300, 35 + index * 150, domainColor(domain.id), 'domain', domain); node.dataset.domainId = domain.id; });
  const children = domains.filter((domain) => domain.parent);
  children.forEach((domain, index) => { const node = addNode(`domain:${domain.id}`, domain.name, domain.id, 565, 35 + index * 135, domainColor(domain.id), 'domain', domain); node.dataset.domainId = domain.id; });
  projects.forEach((project, index) => {
    const node = addNode(`project:${project.id}`, project.name, `${project.coverage.skill_count} skills · ${project.coverage.related_project_count} links`, 830, 25 + index * 100, domainColor(project.domain), 'project', project);
    node.draggable = true; node.dataset.projectId = project.id;
    node.addEventListener('dragstart', (event) => { event.dataTransfer.setData('text/plain', project.id); event.dataTransfer.effectAllowed = 'linkMove'; });
  });
  workflows.forEach((workflow, index) => addNode(`flow:${workflow.id}`, workflow.name, `${workflow.steps.length} steps`, 1110, 25 + index * 110, '#e76fae', 'flow', workflow));
  skills.forEach((skill, index) => {
    const node = addNode(`skill:${skill.id}`, skill.name, skill.id, 1400, 25 + index * 84, '#f3b84b', 'skill', skill);
    node.classList.toggle('selected', skill.id === state.selectedSkill);
  });
  const links = [];
  top.forEach((domain) => links.push(['core', `domain:${domain.id}`]));
  children.forEach((domain) => links.push([`domain:${domain.parent}`, `domain:${domain.id}`]));
  projects.forEach((project) => links.push([`domain:${project.domain}`, `project:${project.id}`]));
  workflows.forEach((workflow) => links.push([workflow.project ? `project:${workflow.project}` : `domain:${workflow.domain}`, `flow:${workflow.id}`]));
  projects.forEach((project) => (project.related_projects || []).forEach((relation) => links.push([`project:${project.id}`, `project:${relation.project}`, true, relation.type])));
  skills.forEach((skill) => {
    let owner = 'core';
    if (skill.scope.project) owner = `project:${skill.scope.project}`;
    else if (skill.scope.domain) owner = `domain:${skill.scope.domain}`;
    links.push([owner, `skill:${skill.id}`, skill.id === state.selectedSkill]);
  });
  const graphHeight = Math.max(720, 110 + Math.max(top.length * 2, children.length, projects.length, workflows.length, skills.length) * 100);
  const graphCanvas = $('#graphCanvas');
  graphCanvas.style.setProperty('--graph-height', `${graphHeight}px`);
  graphCanvas.style.setProperty('--graph-width', '1700px');
  graphView.links = links;
  if (graphView.selectedEdge && !graphView.links.some(([from, to, , label]) => `${from}|${to}|${label}` === graphView.selectedEdge.key)) graphView.selectedEdge = null;
  drawGraphEdges();
  if (graphView.inspected) graphView.nodeIndex.get(graphView.inspected)?.node.classList.add('inspected');
  if (graphView.userAdjusted) applyGraphTransform(); else fitGraphView();
  $('#graphCanvas').setAttribute('aria-label', `Graph: ${domains.length} domains, ${projects.length} projects, ${workflows.length} workflows, showing ${skills.length} of ${allGraphSkills.length} skills`);
  for (const node of $$('.graph-node.project')) {
    node.addEventListener('dragover', (event) => { if (event.dataTransfer.types.includes('text/plain')) { event.preventDefault(); node.classList.add('drop-target'); } });
    node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
    node.addEventListener('drop', (event) => {
      event.preventDefault(); node.classList.remove('drop-target');
      const source = event.dataTransfer.getData('text/plain'); const target = node.dataset.projectId;
      if (source && target && source !== target) openGraphRelationDialog(source, target);
    });
  }
  for (const node of $$('.graph-node.domain')) {
    const domain = domainById(node.dataset.domainId); if (!domain) continue;
    node.addEventListener('dragover', (event) => { event.preventDefault(); node.classList.add('drop-target'); });
    node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
    node.addEventListener('drop', async (event) => {
      event.preventDefault(); node.classList.remove('drop-target'); const projectId = event.dataTransfer.getData('text/plain'); const project = projectById(projectId);
      if (!project || project.domain === domain.id) return;
      openGraphMoveDialog(project.id, domain.id);
    });
  }
}

function openGraphRelationDialog(sourceId, targetId) {
  $('#graphRelationMode').value = 'relation';
  $('#graphRelationSource').value = sourceId; $('#graphRelationTarget').value = targetId;
  const preview = $('#graphRelationPreview'); clear(preview); preview.append(element('strong', '', projectById(sourceId).name), element('span', '', '→'), element('strong', '', projectById(targetId).name));
  $('#graphRelationTitle').textContent = 'Create project link'; $('#graphRelationTypeField').hidden = false; $('#graphRelationType').required = true;
  $('#graphRelationCopy').textContent = 'The connection is directional: source → target. You can edit or remove it later in the source project.'; $('#saveGraphRelation').textContent = 'Create connection';
  $('#graphRelationType').value = 'uses'; $('#graphRelationDialog').showModal(); $('#graphRelationType').focus();
}

function openGraphMoveDialog(projectId, domainId) {
  $('#graphRelationMode').value = 'move'; $('#graphRelationSource').value = projectId; $('#graphRelationTarget').value = domainId;
  const preview = $('#graphRelationPreview'); clear(preview); preview.append(element('strong', '', projectById(projectId).name), element('span', '', '→'), element('strong', '', domainById(domainId).name));
  $('#graphRelationTitle').textContent = 'Move project to domain'; $('#graphRelationTypeField').hidden = true; $('#graphRelationType').required = false;
  $('#graphRelationCopy').textContent = 'The project and each of its workflows will move together. Files on disk stay in place.'; $('#saveGraphRelation').textContent = 'Move project';
  $('#graphRelationDialog').showModal(); $('#saveGraphRelation').focus();
}

async function createGraphRelation(event) {
  event.preventDefault(); const source = projectById($('#graphRelationSource').value); const targetId = $('#graphRelationTarget').value;
  if ($('#graphRelationMode').value === 'move') {
    const button = $('#saveGraphRelation'); button.disabled = true;
    try {
      const inventory = await window.agentBrain.updateProject({ id: source.id, name: source.name, domain: targetId, description: source.description || '', kind: source.kind || 'project', relatedProjects: source.related_projects || [], workspaceRules: source.workspace_rules || [] });
      $('#graphRelationDialog').close(); replaceInventory(inventory); setView('graph'); showNotice('Project moved to a new domain.');
    } catch (error) { showNotice(error.message, true); } finally { button.disabled = false; }
    return;
  }
  const relation = { project: targetId, type: $('#graphRelationType').value.trim() };
  if ((source.related_projects || []).some((item) => item.project === relation.project && item.type === relation.type)) { showNotice('This project connection already exists.', true); return; }
  const button = $('#graphRelationForm button[type="submit"]'); button.disabled = true;
  try {
    const inventory = await window.agentBrain.updateProject({ id: source.id, name: source.name, domain: source.domain, description: source.description || '', kind: source.kind || 'project', relatedProjects: [...(source.related_projects || []), relation], workspaceRules: source.workspace_rules || [] });
    $('#graphRelationDialog').close(); replaceInventory(inventory); setView('graph'); showNotice('Project connection created.');
  } catch (error) { showNotice(error.message, true); } finally { button.disabled = false; }
}

function inspectorShell(title, code, badge) {
  const inspector = $('#skillInspector'); clear(inspector); inspector.hidden = false;
  const copy = element('div'); copy.append(element('h3', '', title), element('code', '', code));
  const actions = element('div', 'skill-inspector-actions'); actions.append(element('span', 'tag', badge));
  inspector.append(copy, actions);
  return { inspector, actions };
}

function clearInspectedNode() {
  graphView.inspected = null;
  $$('.graph-node.inspected').forEach((node) => node.classList.remove('inspected'));
}

function selectSkill(id) {
  const skill = state.inventory.skills.find((item) => item.id === id);
  if (!skill) return;
  state.selectedSkill = id;
  clearInspectedNode();
  const { inspector, actions } = inspectorShell(skill.name, skill.id, skill.scope.level);
  const editScope = element('button', '', 'Change scope'); editScope.addEventListener('click', () => openSkillScopeDialog(skill)); actions.append(editScope);
  inspector.append(element('p', '', skill.description || 'No description has been added.'));
  const tags = element('div', 'tag-list');
  tags.append(element('span', 'tag', `runtime: ${skill.runtimes.join(', ')}`), element('span', 'tag', `mounts: ${skill.mount_count}`), element('span', 'tag', skill.source_path));
  inspector.append(tags);
  setView('graph');
  inspector.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function inspectNode(kind, entity, nodeId) {
  state.selectedSkill = null;
  clearInspectedNode();
  graphView.inspected = nodeId;
  graphView.nodeIndex.get(nodeId)?.node.classList.add('inspected');
  if (kind === 'domain') {
    const { inspector, actions } = inspectorShell(entity.name, entity.id, 'domain');
    const edit = element('button', '', 'Edit domain'); edit.addEventListener('click', () => openDomainDialog(entity)); actions.append(edit);
    inspector.append(element('p', '', entity.description || 'No description has been added.'));
    const directProjects = state.inventory.projects.filter((project) => project.domain === entity.id);
    const domainSkills = state.inventory.skills.filter((skill) => skill.scope.domain === entity.id);
    const tags = element('div', 'tag-list');
    tags.append(element('span', 'tag', `projects: ${directProjects.length}`), element('span', 'tag', `domain skills: ${domainSkills.length}`), element('span', 'tag', entity.parent ? `parent: ${entity.parent}` : 'root domain'));
    inspector.append(tags);
  } else if (kind === 'project') {
    const { inspector, actions } = inspectorShell(entity.name, entity.id, 'project');
    const edit = element('button', '', 'Edit'); edit.addEventListener('click', () => openProjectEditor(entity)); actions.append(edit);
    const open = element('button', '', 'Open in Projects'); open.addEventListener('click', () => { state.projectFilter = 'all'; state.selectedProject = entity.id; syncFilterButtons('#projectFilters', 'all'); renderProjects(); setView('projects'); }); actions.append(open);
    const remove = element('button', '', 'Delete'); remove.addEventListener('click', () => openDeleteProjectDialog(entity)); actions.append(remove);
    inspector.append(element('p', '', entity.description || 'No description has been added.'));
    const c = entity.coverage;
    const tags = element('div', 'tag-list');
    tags.append(element('span', 'tag', entity.path), element('span', 'tag', `domain: ${entity.domain}`), element('span', 'tag', `instructions: ${c.instruction_count}`), element('span', 'tag', `skills: ${c.skill_count}`), element('span', 'tag', `workflows: ${c.workflow_count}`), element('span', 'tag', `links: ${c.related_project_count}`));
    inspector.append(tags);
  } else if (kind === 'flow') {
    const { inspector, actions } = inspectorShell(entity.name, entity.id, 'workflow');
    const edit = element('button', '', 'Edit workflow'); edit.addEventListener('click', () => openWorkflowDialog(entity)); actions.append(edit);
    inspector.append(element('p', '', entity.description || 'No description has been added.'));
    const tags = element('div', 'tag-list');
    tags.append(element('span', 'tag', `owner: ${entity.project || entity.domain}`));
    entity.steps.forEach((step, index) => tags.append(element('span', 'tag', `${index + 1}. ${step}`)));
    inspector.append(tags);
  } else {
    const { inspector } = inspectorShell('Global Core', 'core', 'system');
    inspector.append(element('p', '', 'Safety rules, precedence policy, and global skills that apply to every context.'));
    const globalSkills = state.inventory.skills.filter((skill) => skill.scope.level === 'global');
    const tags = element('div', 'tag-list');
    tags.append(element('span', 'tag', `global skills: ${globalSkills.length}`), element('span', 'tag', `domains: ${state.inventory.domains.filter((domain) => !domain.parent).length}`));
    inspector.append(tags);
  }
  $('#skillInspector').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function runSimulation() {
  if ($('#simulateButton').disabled) return;
  const cwd = $('#simulatorPath').value.trim(); if (!cwd) return;
  const request = ++simulationRequest;
  const button = $('#simulateButton'); button.disabled = true; button.textContent = 'Resolving…';
  try {
    const result = await window.agentBrain.simulate(cwd);
    if (request === simulationRequest) renderSimulation(result);
  } catch (error) {
    if (request === simulationRequest) showNotice(error.message, true);
  } finally {
    if (request === simulationRequest) {
      button.disabled = false;
      button.textContent = 'Resolve';
    }
  }
}

function renderSimulation(result) {
  const host = $('#simulationResult'); clear(host); host.className = 'simulation-result';
  const chain = element('div', 'context-chain');
  result.context.chain.forEach((item, index) => { if (index) chain.append(element('i', '', '→')); chain.append(element('span', '', item)); }); host.append(chain);
  const cards = element('div', 'context-summary');
  const workspace = result.context.workspace?.id || '—'; const project = result.context.project?.name || '—';
  for (const [label, value] of [['Domain', result.context.domain], ['Project', project], ['Workspace', workspace], ['Source', result.context.source]]) { const card = element('article', 'context-card'); card.append(element('span', '', label), element('strong', '', value)); cards.append(card); }
  host.append(cards);
  const skillBox = element('section', 'active-skill-box'); const header = element('header'); header.append(element('h3', '', 'Active context'), element('span', '', `${result.active_skill_count} active · ${result.excluded_skill_count} excluded`)); skillBox.append(header);
  const workflows = element('div', 'tag-list'); (result.active_workflows || []).forEach((flow) => workflows.append(element('span', 'tag', flow))); if (!result.active_workflows.length) workflows.append(element('span', 'tag missing', 'No project workflow')); skillBox.append(workflows);
  const activeSkills = element('div', 'tag-list active-skill-list');
  for (const id of result.active_skills || []) activeSkills.append(element('button', 'tag', id));
  activeSkills.addEventListener('click', (event) => { const target = event.target.closest('button'); if (target) selectSkill(target.textContent); });
  skillBox.append(activeSkills);
  if ((result.active_collisions || []).length) { const collisions = element('section', 'collision-summary'); collisions.append(element('h4', '', 'Active collisions')); const tags = element('div', 'tag-list'); result.active_collisions.forEach((name) => tags.append(element('span', 'tag missing', name))); collisions.append(tags); skillBox.append(collisions); }
  host.append(skillBox);
}

function renderConflicts() {
  const filtered = state.inventory.collisions.filter((item) => state.conflictFilter === 'all' || item.status === state.conflictFilter);
  $('#conflictCount').textContent = `${filtered.length} collisions`;
  const list = $('#conflictList'); clear(list);
  for (const conflict of filtered) {
    const card = element('article', `conflict-card ${conflict.status}`); const head = element('div', 'conflict-head'); head.append(element('strong', '', conflict.name), element('span', '', `${conflict.severity.toUpperCase()} · ${conflict.status === 'resolved' ? 'RESOLVED BY CONTEXT' : 'EXPLICIT ID REQUIRED'}`)); card.append(head);
    const candidates = element('div', 'candidate-list'); conflict.candidate_ids.forEach((id) => candidates.append(element('code', id === conflict.preferred_id ? 'preferred' : '', `${id}${id === conflict.preferred_id ? ' · preferred' : ''}`))); card.append(candidates);
    card.append(element('p', 'conflict-resolution', conflict.resolution));
    const sources = element('div', 'source-list'); (conflict.source_paths || []).forEach((source) => sources.append(element('code', '', source))); card.append(sources); list.append(card);
  }
  if (!filtered.length) list.append(element('div', 'empty-state', state.conflictFilter === 'unresolved' ? 'No unresolved conflicts.' : 'No conflicts in this filter.'));
}

async function runValidation() {
  if (validationPromise) return validationPromise;
  const generation = state.inventory?.generated_at;
  let discarded = false;
  $('#runHealth').disabled = true;
  validationPromise = window.agentBrain.validate();
  try {
    const result = await validationPromise;
    if (state.inventory?.generated_at !== generation) { discarded = true; return null; }
    state.inventory = result.inventory;
    state.validation = result.validation;
    renderAll();
    renderHealth();
    return state.validation;
  } catch (error) {
    if (state.inventory?.generated_at !== generation) { discarded = true; return null; }
    $('#healthTitle').textContent = 'Validation did not run';
    $('#healthSummary').textContent = error.message;
    $('.health-ring').style.borderColor = 'var(--red)';
    showNotice(error.message, true);
    return null;
  } finally {
    validationPromise = null;
    $('#runHealth').disabled = false;
    if (discarded && state.view === 'health') queueMicrotask(runValidation);
  }
}

function renderHealth() {
  const result = state.validation; if (!result) return;
  const errors = result.errors || []; const warnings = result.warnings || []; const score = Math.max(0, 100 - errors.length * 20 - warnings.length * 2);
  $('#healthScore').textContent = score; $('#healthTitle').textContent = result.ok ? 'Core is healthy' : 'Blocking errors found'; $('#healthSummary').textContent = `${errors.length} errors · ${warnings.length} warnings · ${result.stats.project_count} projects`;
  $('.health-ring').style.borderColor = errors.length ? 'var(--red)' : warnings.length ? 'var(--yellow)' : 'var(--green)';
  $('#errorCount').textContent = errors.length; $('#warningCount').textContent = warnings.length;
  renderIssues($('#errorList'), errors, 'No blocking errors.'); renderIssues($('#warningList'), warnings, 'No warnings.');
}

function renderIssues(host, issues, emptyText) { clear(host); if (!issues.length) host.append(element('div', 'issue empty', emptyText)); else issues.forEach((issue) => host.append(element('div', 'issue', issue))); }

function renderSearch(query) {
  if (!state.inventory) return;
  const overlay = $('#searchOverlay'); const host = $('#searchResults'); clear(host); const normalized = query.trim().toLowerCase();
  if (!normalized) { overlay.hidden = true; return; }
  const projectResults = state.inventory.projects.filter((item) => `${item.id} ${item.name} ${item.path}`.toLowerCase().includes(normalized)).slice(0, 8).map((item) => ({ type: 'project', title: item.name, subtitle: item.id, item }));
  const skillResults = state.inventory.skills.filter((item) => `${item.id} ${item.name}`.toLowerCase().includes(normalized)).slice(0, 12).map((item) => ({ type: 'skill', title: item.name, subtitle: item.id, item }));
  const results = [...projectResults, ...skillResults].slice(0, 16); overlay.hidden = false;
  if (!results.length) host.append(element('div', 'empty-state', 'No matches found'));
  for (const result of results) {
    const row = element('button', 'search-result'); row.append(element('strong', '', result.title), element('span', '', `${result.type} · ${result.subtitle}`));
    row.addEventListener('click', () => {
      if (result.type === 'project') {
        state.projectFilter = 'all'; state.selectedProject = result.item.id; syncFilterButtons('#projectFilters', 'all'); renderProjects(); setView('projects');
      } else {
        selectSkill(result.item.id);
      }
      overlay.hidden = true; $('#globalSearch').value = '';
    });
    host.append(row);
  }
}

function populateGraphFilter(previous = 'all') {
  const select = $('#graphDomain'); clear(select); select.append(new Option('Whole system', 'all'));
  for (const domain of state.inventory.domains.filter((item) => !item.parent)) select.append(new Option(domain.name, domain.id));
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  select.onchange = renderGraph;
}

function populateProjectDomains(selected = 'personal.software') {
  const select = $('#projectDomain');
  clear(select);
  for (const domain of state.inventory.domains) {
    select.append(new Option(`${domain.name} · ${domain.id}`, domain.id));
  }
  if ([...select.options].some((option) => option.value === selected)) {
    select.value = selected;
  }
}

function addProjectRelationRow(relation = {}) {
  const row = element('div', 'form-row relation-edit-row');
  const typeLabel = element('label', '', 'Type');
  const type = document.createElement('input'); type.maxLength = 64; type.required = true; type.placeholder = 'uses'; type.value = relation.type || '';
  typeLabel.append(type);
  const projectLabel = element('label', '', 'Project');
  const project = document.createElement('select'); project.required = true;
  const currentId = $('#projectId').value;
  for (const item of state.inventory.projects.filter((candidate) => candidate.id !== currentId)) {
    project.append(new Option(`${item.name} · ${item.id}`, item.id));
  }
  if (relation.project) project.value = relation.project;
  projectLabel.append(project);
  const remove = element('button', 'form-row-remove', 'Remove'); remove.type = 'button'; remove.addEventListener('click', () => row.remove());
  row.append(typeLabel, projectLabel, remove); $('#projectRelationRows').append(row);
}

function addWorkspaceRuleRow(rule = {}) {
  const row = element('div', 'form-row workspace-row');
  const rootLabel = element('label', '', 'Root'); const root = document.createElement('input'); root.required = true; root.placeholder = '~/worktrees'; root.value = rule.root || ''; rootLabel.append(root);
  const pathLabel = element('label', '', 'Project path'); const projectPath = document.createElement('input'); projectPath.placeholder = 'my-project'; projectPath.value = rule.project_path || ''; pathLabel.append(projectPath);
  const kindLabel = element('label', '', 'Kind'); const kind = document.createElement('input'); kind.required = true; kind.placeholder = 'worktree'; kind.value = rule.kind || 'worktree'; kindLabel.append(kind);
  const dynamicLabel = element('label', 'checkbox-field'); const dynamic = document.createElement('input'); dynamic.type = 'checkbox'; dynamic.checked = Boolean(rule.dynamic_child); dynamicLabel.append(dynamic, document.createTextNode('Dynamic child'));
  const remove = element('button', 'form-row-remove', 'Remove'); remove.type = 'button'; remove.addEventListener('click', () => row.remove());
  row.append(rootLabel, pathLabel, kindLabel, dynamicLabel, remove); $('#workspaceRuleRows').append(row);
}

function readProjectRelations() {
  return $$('.relation-edit-row').map((row) => ({
    type: row.querySelector('input').value.trim(),
    project: row.querySelector('select').value
  }));
}

function readWorkspaceRules() {
  return $$('.workspace-row').map((row) => {
    const inputs = row.querySelectorAll('input');
    return {
      root: inputs[0].value.trim(),
      project_path: inputs[1].value.trim(),
      kind: inputs[2].value.trim(),
      dynamic_child: inputs[3].checked
    };
  });
}

function populateWorkflowOwners(domain = 'meta.agent-system', project = '') {
  const domainSelect = $('#workflowDomain'); clear(domainSelect);
  for (const item of state.inventory.domains) domainSelect.append(new Option(`${item.name} · ${item.id}`, item.id));
  if ([...domainSelect.options].some((option) => option.value === domain)) domainSelect.value = domain;
  const projectSelect = $('#workflowProject'); clear(projectSelect); projectSelect.append(new Option('Domain-level workflow', ''));
  for (const item of state.inventory.projects.filter((candidate) => candidate.domain === domainSelect.value)) {
    projectSelect.append(new Option(`${item.name} · ${item.id}`, item.id));
  }
  if ([...projectSelect.options].some((option) => option.value === project)) projectSelect.value = project;
}

function addWorkflowStepRow(skillId = '') {
  const row = element('div', 'form-row workflow-step-row');
  const select = document.createElement('select'); select.required = true;
  select.append(new Option('Choose a skill…', ''));
  for (const skill of state.inventory.skills.filter((item) => item.scope.level !== 'archive')) select.append(new Option(`${skill.name} · ${skill.id}`, skill.id));
  if (skillId) { if (![...select.options].some((option) => option.value === skillId)) select.append(new Option(`${skillId} · unresolved`, skillId)); select.value = skillId; }
  const actions = element('div', 'step-actions');
  const up = element('button', '', '↑'); up.type = 'button'; up.title = 'Move up'; up.addEventListener('click', () => { if (row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling); });
  const down = element('button', '', '↓'); down.type = 'button'; down.title = 'Move down'; down.addEventListener('click', () => { if (row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row); });
  const remove = element('button', 'remove-step', 'Remove'); remove.type = 'button'; remove.addEventListener('click', () => row.remove());
  actions.append(up, down, remove); row.append(select, actions); $('#workflowStepRows').append(row);
}

function openWorkflowDialog(workflow = null) {
  $('#workflowOriginalId').value = workflow?.id || '';
  $('#workflowId').value = workflow?.id || '';
  $('#workflowId').readOnly = Boolean(workflow);
  $('#workflowName').value = workflow?.name || '';
  $('#workflowDescription').value = workflow?.description || '';
  clear($('#workflowStepRows')); (workflow?.steps || []).forEach(addWorkflowStepRow);
  $('#workflowDialogTitle').textContent = workflow ? 'Edit workflow' : 'Add workflow';
  $('#deleteWorkflowButton').hidden = !workflow;
  populateWorkflowOwners(workflow?.domain, workflow?.project || '');
  $('#workflowDialog').showModal();
  (workflow ? $('#workflowName') : $('#workflowId')).focus();
}

async function saveWorkflow(event) {
  event.preventDefault();
  const button = $('#workflowForm button[type="submit"]'); button.disabled = true;
  try {
    const force = Boolean($('#workflowOriginalId').value);
    const inventory = await window.agentBrain.saveWorkflow({
      id: $('#workflowId').value.trim(), name: $('#workflowName').value.trim(),
      domain: $('#workflowDomain').value, project: $('#workflowProject').value || undefined,
      description: $('#workflowDescription').value.trim(),
      steps: $$('#workflowStepRows select').map((select) => select.value).filter(Boolean), force
    });
    $('#workflowDialog').close(); replaceInventory(inventory); showNotice(force ? 'Workflow updated.' : 'Workflow created.');
  } catch (error) { showNotice(error.message, true); } finally { button.disabled = false; }
}

async function deleteWorkflow() {
  const workflow = state.inventory.workflows.find((item) => item.id === $('#workflowOriginalId').value);
  if (!workflow) return;
  $('#workflowDialog').close();
  openDeleteEntityDialog('workflow', workflow.id, workflow.name);
}

async function openDomainDialog(domain = null) {
  $('#domainOriginalId').value = domain?.id || '';
  $('#domainId').value = domain?.id || '';
  $('#domainId').readOnly = Boolean(domain);
  $('#domainName').value = domain?.name || '';
  $('#domainDescription').value = domain?.description || '';
  $('#domainColor').value = /^#[0-9a-f]{6}$/i.test(domain?.color || '') ? domain.color : '#4aa8ff';
  $('#domainIcon').value = domain?.icon || 'circle';
  const parent = $('#domainParent'); clear(parent); parent.append(new Option('Root domain', ''));
  for (const item of state.inventory.domains.filter((candidate) => candidate.id !== domain?.id)) parent.append(new Option(`${item.name} · ${item.id}`, item.id));
  parent.value = domain?.parent || '';
  $('#domainDialogTitle').textContent = domain ? 'Edit domain' : 'Add domain';
  $('#deleteDomainButton').hidden = !domain;
  const host = $('#domainDependencies'); clear(host);
  if (domain) {
    try {
      const dependencies = await window.agentBrain.domainDependencies(domain.id);
      for (const [label, values] of [['Child', dependencies.children], ['Project', dependencies.projects], ['Workflow', dependencies.workflows], ['Config', dependencies.config_references]]) {
        for (const value of values) { const row = element('div', 'dependency-item'); row.append(element('span', '', label), element('strong', '', value)); host.append(row); }
      }
      $('#deleteDomainButton').disabled = Boolean(host.children.length);
    } catch (error) { showNotice(error.message, true); return; }
  }
  $('#domainDialog').showModal();
}

async function saveDomain(event) {
  event.preventDefault(); const button = $('#domainForm button[type="submit"]'); button.disabled = true;
  try {
    const force = Boolean($('#domainOriginalId').value);
    const inventory = await window.agentBrain.saveDomain({
      id: $('#domainId').value.trim(), name: $('#domainName').value.trim(),
      parent: $('#domainParent').value || undefined, color: $('#domainColor').value,
      icon: $('#domainIcon').value.trim(), description: $('#domainDescription').value.trim(), force
    });
    $('#domainDialog').close(); replaceInventory(inventory); showNotice(force ? 'Domain updated.' : 'Domain created.');
  } catch (error) { showNotice(error.message, true); } finally { button.disabled = false; }
}

async function deleteDomain() {
  const domain = domainById($('#domainOriginalId').value); if (!domain) return;
  $('#domainDialog').close();
  openDeleteEntityDialog('domain', domain.id, domain.name);
}

function openDeleteEntityDialog(kind, id, name) {
  const dialog = $('#deleteEntityDialog'); dialog.dataset.kind = kind; dialog.dataset.id = id;
  $('#deleteEntityTitle').textContent = `Delete ${name}?`;
  $('#deleteEntityCopy').textContent = kind === 'workflow'
    ? 'The ordered workflow will be removed from the registry.'
    : 'The empty domain will be removed from the registry.';
  dialog.showModal(); $('#confirmDeleteEntity').focus();
}

async function confirmEntityDelete(event) {
  event.preventDefault(); const dialog = $('#deleteEntityDialog'); const button = $('#confirmDeleteEntity'); button.disabled = true;
  try {
    if (dialog.dataset.kind === 'relation') {
      const source = projectById(dialog.dataset.id);
      const relatedProjects = (source.related_projects || []).filter((item) => !(item.project === dialog.dataset.target && item.type === dialog.dataset.relationType));
      const inventory = await window.agentBrain.updateProject({ id: source.id, name: source.name, domain: source.domain, description: source.description || '', kind: source.kind || 'project', relatedProjects, workspaceRules: source.workspace_rules || [] });
      dialog.close(); graphView.selectedEdge = null; replaceInventory(inventory); showNotice('Project connection deleted.');
      return;
    }
    const payload = { id: dialog.dataset.id, confirmed: true };
    const inventory = dialog.dataset.kind === 'workflow'
      ? await window.agentBrain.deleteWorkflow(payload)
      : await window.agentBrain.deleteDomain(payload);
    dialog.close(); replaceInventory(inventory); showNotice(dialog.dataset.kind === 'workflow' ? 'Workflow deleted.' : 'Domain deleted.');
  } catch (error) { showNotice(error.message, true); } finally { button.disabled = false; }
}

function syncSkillScopeFields() {
  const level = $('#skillScopeLevel').value;
  $('#skillScopeDomainField').hidden = level !== 'domain';
  $('#skillScopeProjectField').hidden = level !== 'project';
  $('#skillScopePluginField').hidden = level !== 'plugin';
}

function openSkillScopeDialog(skill) {
  $('#skillScopeId').value = skill.id; $('#skillScopeTitle').textContent = skill.name;
  $('#skillScopeCopy').textContent = skill.source_path;
  const override = (state.inventory.config.skill_scope_rules || []).find((rule) => {
    if (!String(rule.managed_by || '').startsWith('gui-source:') || !rule.source_pattern) return false;
    try { return new RegExp(rule.source_pattern).test(skill.source_path); } catch { return false; }
  });
  $('#skillScopeLevel').value = override?.level || 'auto';
  const domains = $('#skillScopeDomain'); clear(domains); state.inventory.domains.forEach((item) => domains.append(new Option(`${item.name} · ${item.id}`, item.id))); domains.value = skill.scope.domain || domains.value;
  const projects = $('#skillScopeProject'); clear(projects); state.inventory.projects.forEach((item) => projects.append(new Option(`${item.name} · ${item.id}`, item.id))); projects.value = skill.scope.project || projects.value;
  $('#skillScopePlugin').value = override?.plugin || skill.scope.plugin || '';
  syncSkillScopeFields(); $('#skillScopeDialog').showModal();
}

async function saveSkillScope(event) {
  event.preventDefault(); const button = $('#skillScopeForm button[type="submit"]'); button.disabled = true;
  try {
    const level = $('#skillScopeLevel').value;
    const inventory = await window.agentBrain.updateSkillScope({
      id: $('#skillScopeId').value, level,
      domain: level === 'domain' ? $('#skillScopeDomain').value : undefined,
      project: level === 'project' ? $('#skillScopeProject').value : undefined,
      plugin: level === 'plugin' ? $('#skillScopePlugin').value.trim() : undefined
    });
    $('#skillScopeDialog').close(); state.selectedSkill = null; replaceInventory(inventory); setView('graph'); showNotice('Skill scope updated.');
  } catch (error) { showNotice(error.message, true); } finally { button.disabled = false; }
}

async function openProjectDialog() {
  const projectPath = await window.agentBrain.chooseDirectory();
  if (!projectPath) return;
  $('#projectId').value = '';
  $('#projectPath').value = projectPath;
  $('#projectName').value = projectPath.split('/').filter(Boolean).pop().replaceAll('-', ' ');
  $('#projectDescription').value = '';
  $('#projectKind').value = 'software-project';
  clear($('#projectRelationRows')); clear($('#workspaceRuleRows'));
  $('#projectAdvancedFields').hidden = true; $('#projectWorkspaceFields').hidden = true;
  $('#projectDialogTitle').textContent = 'Add a project';
  $('#projectDialogCopy').textContent = 'Agent Brain will detect AGENTS.md, CLAUDE.md, and local skill folders automatically.';
  $('#saveProjectButton').textContent = 'Add project';
  populateProjectDomains();
  $('#projectDialog').showModal();
  $('#projectName').focus();
}

function openProjectEditor(project) {
  $('#projectId').value = project.id;
  $('#projectPath').value = project.path;
  $('#projectName').value = project.name;
  $('#projectDescription').value = project.description || '';
  $('#projectKind').value = project.kind || 'project';
  clear($('#projectRelationRows')); clear($('#workspaceRuleRows'));
  (project.related_projects || []).forEach(addProjectRelationRow);
  (project.workspace_rules || []).forEach(addWorkspaceRuleRow);
  $('#projectAdvancedFields').hidden = false; $('#projectWorkspaceFields').hidden = false;
  $('#projectDialogTitle').textContent = 'Edit project';
  $('#projectDialogCopy').textContent = 'Update registry metadata. Moving domains also keeps project workflows in the same domain.';
  $('#saveProjectButton').textContent = 'Save changes';
  populateProjectDomains(project.domain);
  $('#projectDialog').showModal();
  $('#projectName').focus();
}

async function saveProject(event) {
  event.preventDefault();
  const submit = $('#projectForm button[type="submit"]');
  submit.disabled = true;
  try {
    const id = $('#projectId').value;
    const fields = {
      name: $('#projectName').value.trim(),
      domain: $('#projectDomain').value,
      kind: $('#projectKind').value.trim(),
      description: $('#projectDescription').value.trim(),
      relatedProjects: id ? readProjectRelations() : undefined,
      workspaceRules: id ? readWorkspaceRules() : undefined
    };
    const inventory = id
      ? await window.agentBrain.updateProject({ id, ...fields })
      : await window.agentBrain.addProject({ path: $('#projectPath').value, ...fields });
    $('#projectDialog').close();
    replaceInventory(inventory);
    state.projectFilter = 'all';
    state.selectedProject = id || inventory.projects.find((project) => project.path === $('#projectPath').value)?.id || null;
    syncFilterButtons('#projectFilters', 'all');
    renderProjects();
    setView('projects');
    showNotice(id ? 'Project updated.' : 'Project added to the registry.');
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    submit.disabled = false;
  }
}

async function openDeleteProjectDialog(project) {
  try {
    const dependencies = await window.agentBrain.projectDependencies(project.id);
    $('#deleteProjectDialog').dataset.projectId = project.id;
    $('#deleteProjectTitle').textContent = `Remove ${project.name}?`;
    $('#deleteProjectCopy').textContent = 'This removes the project manifest from Agent Brain.';
    const host = $('#deleteProjectDependencies'); clear(host);
    for (const relation of dependencies.incoming_relations) {
      const row = element('div', 'dependency-item'); row.append(element('span', '', `Incoming · ${relation.type}`), element('strong', '', projectById(relation.project)?.name || relation.project)); host.append(row);
    }
    for (const workflow of dependencies.workflows) {
      const name = state.inventory.workflows.find((item) => item.id === workflow)?.name || workflow;
      const row = element('div', 'dependency-item'); row.append(element('span', '', 'Workflow'), element('strong', '', name)); host.append(row);
    }
    if (host.children.length) $('#deleteProjectCopy').textContent = 'The following registry references will also be removed:';
    $('#deleteProjectDialog').showModal();
  } catch (error) {
    showNotice(error.message, true);
  }
}

async function deleteProject(event) {
  event.preventDefault();
  const button = $('#confirmDeleteProject'); button.disabled = true;
  try {
    const id = $('#deleteProjectDialog').dataset.projectId;
    const inventory = await window.agentBrain.deleteProject({ id, cascade: true });
    $('#deleteProjectDialog').close();
    state.selectedProject = null;
    replaceInventory(inventory);
    setView('projects');
    showNotice('Project removed from the registry. External files were preserved.');
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderAll() { const graphFilter = $('#graphDomain').value || 'all'; renderShell(); renderMetrics(); renderDomains(); renderCoverage(); renderWorkflows(); renderProjectFilters(); renderProjects(); renderConflicts(); populateGraphFilter(graphFilter); syncFilterButtons('#conflictFilters', state.conflictFilter); setView(state.view); if (state.validation) renderHealth(); }

function replaceInventory(inventory) {
  state.inventory = inventory;
  state.validation = null;
  renderAll();
  if (state.view === 'health') runValidation();
}

function bindGraphEvents() {
  const canvas = $('#graphCanvas');
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('.graph-node, .graph-controls, .edge-toolbar')) return;
    clearEdgeSelection();
    graphView.userAdjusted = true;
    const start = { x: event.clientX, y: event.clientY }; const origin = { ...graphView.pan };
    canvas.classList.add('panning');
    const onMove = (move) => { graphView.pan.x = origin.x + move.clientX - start.x; graphView.pan.y = origin.y + move.clientY - start.y; applyGraphTransform(); };
    const onUp = () => { canvas.classList.remove('panning'); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
  });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    graphView.userAdjusted = true;
    if (event.ctrlKey || event.metaKey) {
      const rect = canvas.getBoundingClientRect();
      setGraphZoom(graphView.zoom * Math.exp(-event.deltaY * .01), event.clientX - rect.left, event.clientY - rect.top);
    } else {
      graphView.pan.x -= event.deltaX; graphView.pan.y -= event.deltaY; applyGraphTransform();
    }
  }, { passive: false });
  $('#graphZoomIn').addEventListener('click', () => { graphView.userAdjusted = true; setGraphZoom(graphView.zoom * 1.2); });
  $('#graphZoomOut').addEventListener('click', () => { graphView.userAdjusted = true; setGraphZoom(graphView.zoom / 1.2); });
  $('#graphZoomReset').addEventListener('click', () => { graphView.userAdjusted = true; graphView.zoom = 1; graphView.pan = { x: 24, y: 24 }; applyGraphTransform(); });
  $('#graphZoomFit').addEventListener('click', () => { graphView.userAdjusted = true; fitGraphView(); });
  $('#edgeDeleteButton').addEventListener('click', () => { if (graphView.selectedEdge) openDeleteRelationDialog(graphView.selectedEdge); });
}

function bindEvents() {
  bindGraphEvents();
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  $('#projectFilters').addEventListener('click', (event) => { const button = event.target.closest('button'); if (!button) return; state.projectFilter = button.dataset.filter; syncFilterButtons('#projectFilters', state.projectFilter); renderProjects(); });
  $('#conflictFilters').addEventListener('click', (event) => { const button = event.target.closest('button'); if (!button) return; state.conflictFilter = button.dataset.filter; syncFilterButtons('#conflictFilters', state.conflictFilter); renderConflicts(); });
  $('#choosePath').addEventListener('click', async () => { const path = await window.agentBrain.chooseDirectory(); if (path) { $('#simulatorPath').value = path; runSimulation(); } });
  $('#addProjectButton').addEventListener('click', openProjectDialog);
  $('#projectForm').addEventListener('submit', saveProject);
  $('#closeProjectDialog').addEventListener('click', () => $('#projectDialog').close());
  $('#cancelProjectDialog').addEventListener('click', () => $('#projectDialog').close());
  $('#deleteProjectForm').addEventListener('submit', deleteProject);
  $('#closeDeleteProjectDialog').addEventListener('click', () => $('#deleteProjectDialog').close());
  $('#cancelDeleteProject').addEventListener('click', () => $('#deleteProjectDialog').close());
  $('#addProjectRelation').addEventListener('click', () => addProjectRelationRow());
  $('#addWorkspaceRule').addEventListener('click', () => addWorkspaceRuleRow());
  $('#addWorkflowButton').addEventListener('click', () => openWorkflowDialog());
  $('#workflowForm').addEventListener('submit', saveWorkflow);
  $('#workflowDomain').addEventListener('change', () => populateWorkflowOwners($('#workflowDomain').value));
  $('#deleteWorkflowButton').addEventListener('click', deleteWorkflow);
  $('#closeWorkflowDialog').addEventListener('click', () => $('#workflowDialog').close());
  $('#cancelWorkflowDialog').addEventListener('click', () => $('#workflowDialog').close());
  $('#addWorkflowStep').addEventListener('click', () => addWorkflowStepRow());
  $('#addDomainButton').addEventListener('click', () => openDomainDialog());
  $('#domainForm').addEventListener('submit', saveDomain);
  $('#deleteDomainButton').addEventListener('click', deleteDomain);
  $('#closeDomainDialog').addEventListener('click', () => $('#domainDialog').close());
  $('#cancelDomainDialog').addEventListener('click', () => $('#domainDialog').close());
  $('#skillScopeLevel').addEventListener('change', syncSkillScopeFields);
  $('#skillScopeForm').addEventListener('submit', saveSkillScope);
  $('#closeSkillScopeDialog').addEventListener('click', () => $('#skillScopeDialog').close());
  $('#cancelSkillScopeDialog').addEventListener('click', () => $('#skillScopeDialog').close());
  $('#graphRelationForm').addEventListener('submit', createGraphRelation);
  $('#closeGraphRelationDialog').addEventListener('click', () => $('#graphRelationDialog').close());
  $('#cancelGraphRelation').addEventListener('click', () => $('#graphRelationDialog').close());
  $('#deleteEntityForm').addEventListener('submit', confirmEntityDelete);
  $('#closeDeleteEntityDialog').addEventListener('click', () => $('#deleteEntityDialog').close());
  $('#cancelDeleteEntity').addEventListener('click', () => $('#deleteEntityDialog').close());
  $('#simulateButton').addEventListener('click', runSimulation); $('#simulatorPath').addEventListener('keydown', (event) => { if (event.key === 'Enter') runSimulation(); });
  $('#runHealth').addEventListener('click', runValidation); $('#validateButton').addEventListener('click', () => { const alreadyValidated = Boolean(state.validation); setView('health'); if (alreadyValidated) runValidation(); });
  $('#refreshButton').addEventListener('click', async () => { const button = $('#refreshButton'); button.classList.add('busy'); button.disabled = true; try { replaceInventory(await window.agentBrain.refresh()); setRuntimeStatus('online', 'Registry online'); showNotice('Registry refreshed.'); } catch (error) { setRuntimeStatus(state.inventory ? 'stale' : 'offline', state.inventory ? 'Registry stale' : 'Registry offline'); showNotice(error.message, true); } finally { button.classList.remove('busy'); button.disabled = false; } });
  $('#globalSearch').addEventListener('input', (event) => renderSearch(event.target.value));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { $('#searchOverlay').hidden = true; clearEdgeSelection(); } if (!state.inventory) return; if (event.metaKey && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#globalSearch').focus(); } if (!event.metaKey && !event.ctrlKey && !event.altKey && /^[1-6]$/.test(event.key) && document.activeElement.tagName !== 'INPUT') { setView(['portfolio','projects','graph','simulator','conflicts','health'][Number(event.key)-1]); } });
  window.agentBrain.onInventoryUpdated((inventory) => { if (inventory.error) { setRuntimeStatus(state.inventory ? 'stale' : 'offline', state.inventory ? 'Registry stale' : 'Registry offline'); showNotice(inventory.error, true); } else { replaceInventory(inventory); setRuntimeStatus('online', 'Registry online'); showNotice('Manifest changes were loaded automatically.'); } });
}

async function loadInitialSnapshot() {
  const loading = $('#loadingScreen');
  const message = $('#loadingMessage');
  const retry = $('#loadingRetry');
  loading.classList.remove('hidden', 'failed');
  message.textContent = 'Building Agent Brain…';
  retry.hidden = true;
  try {
    replaceInventory(await window.agentBrain.snapshot());
    setRuntimeStatus('online', 'Registry online');
    loading.classList.add('hidden');
    window.agentBrain.reportReady();
  } catch (error) {
    setRuntimeStatus('offline', 'Registry offline');
    loading.classList.add('failed');
    message.textContent = `Could not load the registry: ${error.message}`;
    retry.hidden = false;
  }
}

function init() {
  bindEvents();
  $('#loadingRetry').addEventListener('click', loadInitialSnapshot);
  loadInitialSnapshot();
}

init();
