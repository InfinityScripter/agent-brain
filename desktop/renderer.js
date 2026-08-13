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
    const card = element('button', 'domain-card');
    card.style.setProperty('--accent', colors[root]);
    const icon = element('span', 'domain-icon', icons[root]);
    const title = element('h3', '', domain.name);
    const description = element('p', '', domain.description);
    const footer = element('footer');
    footer.append(element('span', '', `${projects.length} projects`), element('span', '', `${skills.length} domain skills`));
    card.append(icon, title, description, footer);
    card.addEventListener('click', () => {
      state.projectFilter = root;
      syncFilterButtons('#projectFilters', root);
      renderProjects();
      setView('projects');
    });
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
    const item = element('article', 'workflow-item');
    item.append(element('strong', '', workflow.name), element('span', '', workflow.steps.join(' → '))); list.append(item);
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

function renderProjects() {
  const filtered = state.inventory.projects.filter((project) => state.projectFilter === 'all' || rootDomain(project.domain) === state.projectFilter);
  $('#projectCount').textContent = `${filtered.length} projects`;
  const list = $('#projectList'); clear(list);
  for (const project of filtered) {
    const row = element('button', 'project-row');
    row.style.setProperty('--accent', colors[rootDomain(project.domain)]);
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
  const reveal = element('button', 'reveal-button', '↗'); reveal.title = 'Reveal in Finder'; reveal.addEventListener('click', async () => {
    try { await window.agentBrain.revealPath(project.path); } catch (error) { showNotice(error.message, true); }
  });
  header.append(copy, reveal); detail.append(header, element('div', 'path-line', project.path));

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
  const nodes = $('#graphNodes'); clear(nodes); const edges = $('#graphEdges'); clear(edges); const relationText = $('#graphRelations'); clear(relationText);
  const positions = new Map();
  const addNode = (id, title, subtitle, x, y, color, kind = '') => {
    const node = element(kind === 'skill' ? 'button' : 'article', `graph-node ${kind}`.trim()); node.style.left = `${x}px`; node.style.top = `${y}px`; node.style.setProperty('--node-color', color); node.append(element('strong', '', title), element('small', '', subtitle)); nodes.append(node); positions.set(id, { x, y, w: kind === 'skill' ? 245 : 220, h: 68 }); return node;
  };
  addNode('core', 'Global Core', 'safety · precedence · global skills', 32, 35, '#f2eee4');
  const top = domains.filter((domain) => !domain.parent);
  top.forEach((domain, index) => addNode(`domain:${domain.id}`, domain.name, domain.id, 300, 35 + index * 150, colors[rootDomain(domain.id)]));
  const children = domains.filter((domain) => domain.parent);
  children.forEach((domain, index) => addNode(`domain:${domain.id}`, domain.name, domain.id, 565, 35 + index * 135, colors[rootDomain(domain.id)]));
  projects.forEach((project, index) => addNode(`project:${project.id}`, project.name, `${project.coverage.skill_count} skills · ${project.coverage.related_project_count} links`, 830, 25 + index * 100, colors[rootDomain(project.domain)]));
  workflows.forEach((workflow, index) => addNode(`flow:${workflow.id}`, workflow.name, `${workflow.steps.length} steps`, 1110, 25 + index * 110, '#e76fae'));
  skills.forEach((skill, index) => {
    const node = addNode(`skill:${skill.id}`, skill.name, skill.id, 1400, 25 + index * 84, '#f3b84b', 'skill');
    node.classList.toggle('selected', skill.id === state.selectedSkill);
    node.addEventListener('click', () => selectSkill(skill.id));
  });
  const links = [];
  top.forEach((domain) => links.push(['core', `domain:${domain.id}`]));
  children.forEach((domain) => links.push([`domain:${domain.parent}`, `domain:${domain.id}`]));
  projects.forEach((project) => links.push([`domain:${project.domain}`, `project:${project.id}`]));
  workflows.forEach((workflow) => links.push([workflow.project ? `project:${workflow.project}` : `domain:${workflow.domain}`, `flow:${workflow.id}`]));
  projects.forEach((project) => (project.related_projects || []).forEach((relation) => links.push([`project:${project.id}`, `project:${relation.project}`])));
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
  nodes.style.width = '1700px'; nodes.style.height = `${graphHeight}px`;
  for (const [from, to, showVisual = true] of links) {
    const a = positions.get(from); const b = positions.get(to); if (!a || !b) continue;
    if (showVisual) {
      const pathNode = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const x1 = a.x + a.w; const y1 = a.y + a.h / 2; const x2 = b.x; const y2 = b.y + b.h / 2; const bend = Math.max(30, (x2 - x1) * .45);
      pathNode.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`); edges.append(pathNode);
    }
    relationText.append(element('li', '', `${from} → ${to}`));
  }
  $('#graphCanvas').setAttribute('aria-label', `Graph: ${domains.length} domains, ${projects.length} projects, ${workflows.length} workflows, showing ${skills.length} of ${allGraphSkills.length} skills`);
}

function selectSkill(id) {
  const skill = state.inventory.skills.find((item) => item.id === id);
  if (!skill) return;
  state.selectedSkill = id;
  const inspector = $('#skillInspector'); clear(inspector); inspector.hidden = false;
  const copy = element('div'); copy.append(element('h3', '', skill.name), element('code', '', skill.id));
  inspector.append(copy, element('span', 'tag', skill.scope.level), element('p', '', skill.description || 'No description has been added.'));
  const tags = element('div', 'tag-list');
  tags.append(element('span', 'tag', `runtime: ${skill.runtimes.join(', ')}`), element('span', 'tag', `mounts: ${skill.mount_count}`), element('span', 'tag', skill.source_path));
  inspector.append(tags);
  setView('graph');
  inspector.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

function populateProjectDomains() {
  const select = $('#projectDomain');
  clear(select);
  for (const domain of state.inventory.domains) {
    select.append(new Option(`${domain.name} · ${domain.id}`, domain.id));
  }
  if ([...select.options].some((option) => option.value === 'personal.software')) {
    select.value = 'personal.software';
  }
}

async function openProjectDialog() {
  const projectPath = await window.agentBrain.chooseDirectory();
  if (!projectPath) return;
  $('#projectPath').value = projectPath;
  $('#projectName').value = '';
  $('#projectDescription').value = '';
  populateProjectDomains();
  $('#projectDialog').showModal();
  $('#projectName').focus();
}

async function addProject(event) {
  event.preventDefault();
  const submit = $('#projectForm button[type="submit"]');
  submit.disabled = true;
  try {
    const inventory = await window.agentBrain.addProject({
      path: $('#projectPath').value,
      name: $('#projectName').value.trim() || undefined,
      domain: $('#projectDomain').value,
      description: $('#projectDescription').value.trim() || undefined
    });
    $('#projectDialog').close();
    replaceInventory(inventory);
    state.projectFilter = 'all';
    state.selectedProject = inventory.projects.find((project) => project.path === $('#projectPath').value)?.id || null;
    syncFilterButtons('#projectFilters', 'all');
    renderProjects();
    setView('projects');
    showNotice('Project added to the registry.');
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    submit.disabled = false;
  }
}

function renderAll() { const graphFilter = $('#graphDomain').value || 'all'; renderShell(); renderMetrics(); renderDomains(); renderCoverage(); renderWorkflows(); renderProjects(); renderConflicts(); populateGraphFilter(graphFilter); syncFilterButtons('#projectFilters', state.projectFilter); syncFilterButtons('#conflictFilters', state.conflictFilter); setView(state.view); if (state.validation) renderHealth(); }

function replaceInventory(inventory) {
  state.inventory = inventory;
  state.validation = null;
  renderAll();
  if (state.view === 'health') runValidation();
}

function bindEvents() {
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  $('#projectFilters').addEventListener('click', (event) => { const button = event.target.closest('button'); if (!button) return; state.projectFilter = button.dataset.filter; syncFilterButtons('#projectFilters', state.projectFilter); renderProjects(); });
  $('#conflictFilters').addEventListener('click', (event) => { const button = event.target.closest('button'); if (!button) return; state.conflictFilter = button.dataset.filter; syncFilterButtons('#conflictFilters', state.conflictFilter); renderConflicts(); });
  $('#choosePath').addEventListener('click', async () => { const path = await window.agentBrain.chooseDirectory(); if (path) { $('#simulatorPath').value = path; runSimulation(); } });
  $('#addProjectButton').addEventListener('click', openProjectDialog);
  $('#projectForm').addEventListener('submit', addProject);
  $('#closeProjectDialog').addEventListener('click', () => $('#projectDialog').close());
  $('#cancelProjectDialog').addEventListener('click', () => $('#projectDialog').close());
  $('#simulateButton').addEventListener('click', runSimulation); $('#simulatorPath').addEventListener('keydown', (event) => { if (event.key === 'Enter') runSimulation(); });
  $('#runHealth').addEventListener('click', runValidation); $('#validateButton').addEventListener('click', () => { const alreadyValidated = Boolean(state.validation); setView('health'); if (alreadyValidated) runValidation(); });
  $('#refreshButton').addEventListener('click', async () => { const button = $('#refreshButton'); button.classList.add('busy'); button.disabled = true; try { replaceInventory(await window.agentBrain.refresh()); setRuntimeStatus('online', 'Registry online'); showNotice('Registry refreshed.'); } catch (error) { setRuntimeStatus(state.inventory ? 'stale' : 'offline', state.inventory ? 'Registry stale' : 'Registry offline'); showNotice(error.message, true); } finally { button.classList.remove('busy'); button.disabled = false; } });
  $('#globalSearch').addEventListener('input', (event) => renderSearch(event.target.value));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') $('#searchOverlay').hidden = true; if (!state.inventory) return; if (event.metaKey && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#globalSearch').focus(); } if (!event.metaKey && !event.ctrlKey && !event.altKey && /^[1-6]$/.test(event.key) && document.activeElement.tagName !== 'INPUT') { setView(['portfolio','projects','graph','simulator','conflicts','health'][Number(event.key)-1]); } });
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
