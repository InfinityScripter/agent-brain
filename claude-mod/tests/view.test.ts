import { expect, test } from 'claude-code/testing'

import { buildView } from '../hooks/view'
import type { InspectJson } from '../hooks/view'

const skill = (listed_name: string, scope_level: string, scope_detail: string | null, effective: string | null = null) => ({
  listed_name,
  scope_level,
  scope_detail,
  usage: { count: 0 },
  hideable: true,
  override: { effective, level: null },
})

const INSPECT: InspectJson = {
  context: { domain: 'meta.agent-system', source: 'project', chain: ['meta'], project: null },
  root: '/work/notes',
  skills: [
    skill('solo', 'project', 'dogs-teacher'),
    skill('nothing-a', 'global', null),
    skill('nothing-b', 'global', null),
    skill('nothing-c', 'global', null),
    skill('nothing-d', 'global', null),
    skill('yandex-a', 'domain', 'work.yandex'),
    skill('yandex-b', 'domain', 'work.yandex'),
    skill('yandex-c', 'domain', 'work.yandex'),
    skill('tef-a', 'project', 'tef-trigger-platform'),
    skill('tef-b', 'project', 'tef-trigger-platform'),
    skill('already-off', 'domain', 'work.yandex', 'off'),
  ],
  warnings: [],
  advice: { recommendations: [], gaps: [] },
  rules: [],
  mcp: [],
  agents: [],
  instructions: [],
}
const DRY_RUN = {
  hide: ['solo', 'nothing-a', 'nothing-b', 'nothing-c', 'nothing-d', 'yandex-a', 'yandex-b', 'yandex-c', 'tef-a', 'tef-b', 'already-off'],
  tokens: 500,
  unhideable_plugin_skills: [],
}
const PROFILE = { domain: 'meta.agent-system', applied: null, stale: false, missing: [], wrongly_hidden: [], command: null }

test('skills outside the area are grouped by label, the biggest group first, no label last', () => {
  const view = buildView('/work/notes', INSPECT, DRY_RUN, PROFILE, { preferences: [] }, null)

  expect(view.groups.map(group => [group.label, group.level, group.skills.length])).toEqual([
    ['work.yandex', 'domain', 3],
    ['tef-trigger-platform', 'project', 2],
    ['dogs-teacher', 'project', 1],
    ['без области', 'global', 4],
  ])
  expect(view.groups[0]?.skills.map(row => [row.name, row.level])).toEqual([
    ['yandex-a', 'domain'],
    ['yandex-b', 'domain'],
    ['yandex-c', 'domain'],
  ])
})

test('the groups hold exactly the skills of the flat list outside the area', () => {
  const view = buildView('/work/notes', INSPECT, DRY_RUN, PROFILE, { preferences: [] }, null)

  expect(view.visibleOutside.map(row => row.name)).toEqual([
    'solo', 'nothing-a', 'nothing-b', 'nothing-c', 'nothing-d', 'yandex-a', 'yandex-b', 'yandex-c', 'tef-a', 'tef-b',
  ])
  expect(view.groups.flatMap(group => group.skills.map(row => row.name)).sort()).toEqual(
    view.visibleOutside.map(row => row.name).sort(),
  )
  expect(view.hiddenAlready).toBe(1)
})
