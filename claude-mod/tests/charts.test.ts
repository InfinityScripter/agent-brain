import { expect, test } from 'claude-code/testing'

import { CALLS, DANGER, MUTED, areaColor, areaIdColor, areaKey, formatTokens, groupColor, percentOfMax, percentShares } from '../hooks/charts'

test('the area key is the part of the id before the first dot or colon', () => {
  expect(areaKey('meta.agent-system')).toBe('meta')
  expect(areaKey('project:agent-brain')).toBe('project')
  expect(areaKey('work')).toBe('work')
  expect(areaKey('travel.rome')).toBe('other')
  expect(areaKey('constructor.x')).toBe('other')
  expect(areaKey(null)).toBe('other')
  expect(areaKey('')).toBe('other')
})

test('area and group colors follow the Agent Brain palette', () => {
  expect(areaColor('work')).toBe('#46a7ff')
  expect(areaColor('personal')).toBe('#f3b64b')
  expect(areaColor('creative')).toBe('#e36fad')
  expect(areaColor('meta')).toBe('#9c83ff')
  expect(areaColor('project')).toBe('#45c79a')
  expect(areaColor('plugin')).toBe('#69d3c5')
  expect(areaColor('global')).toBe('#f2eddf')
  expect(areaColor('other')).toBe('#687080')

  expect(groupColor('domain', 'work.yandex')).toBe('#46a7ff')
  expect(groupColor('domain', 'travel.rome')).toBe('#687080')
  expect(groupColor('project', 'tef-trigger-platform')).toBe('#45c79a')
  expect(groupColor('plugin', 'claude-mem')).toBe('#69d3c5')
  expect(groupColor('global', 'без области')).toBe('#f2eddf')
  expect(groupColor(null, 'без области')).toBe('#f2eddf')
})

test('the color by area id follows the first part of the id', () => {
  expect(areaIdColor('meta.agent-system')).toBe('#9c83ff')
  expect(areaIdColor('project:agent-brain')).toBe('#45c79a')
  expect(areaIdColor('travel.rome')).toBe('#687080')
  expect(areaIdColor(null)).toBe('#687080')
})

test('the calls bars have a color that no area and no share bar segment uses', () => {
  const taken = (['work', 'personal', 'creative', 'meta', 'project', 'plugin', 'global', 'other'] as const).map(areaColor)
  expect([...taken, DANGER, MUTED]).not.toContain(CALLS)
})

test('percent shares are whole numbers that add up to 100', () => {
  expect(percentShares([127, 147, 0, 20])).toEqual([43, 50, 0, 7])
  expect(percentShares([1, 1, 1])).toEqual([34, 33, 33])
  expect(percentShares([5])).toEqual([100])
})

test('a tiny share keeps one percent and a zero stays zero', () => {
  expect(percentShares([1, 1000])).toEqual([1, 99])
  expect(percentShares([0, 3, 0, 1000])).toEqual([0, 1, 0, 99])
  expect(percentShares([0, 0, 0, 0])).toEqual([0, 0, 0, 0])
  expect(percentShares([])).toEqual([])
})

test('a bar is proportional to the largest value and never empty for a positive one', () => {
  expect(percentOfMax(50, 100)).toBe(50)
  expect(percentOfMax(100, 100)).toBe(100)
  expect(percentOfMax(1, 343)).toBe(1)
  expect(percentOfMax(0, 100)).toBe(0)
  expect(percentOfMax(5, 0)).toBe(0)
})

test('tokens read as thousands with a decimal comma', () => {
  expect(formatTokens(12415)).toBe('12,4 тыс.')
  expect(formatTokens(1000)).toBe('1 тыс.')
  expect(formatTokens(999)).toBe('999')
  expect(formatTokens(0)).toBe('0')
})
