export type AreaKey = 'work' | 'personal' | 'creative' | 'meta' | 'project' | 'plugin' | 'global' | 'other'

const COLORS: Record<AreaKey, string> = {
  work: '#46a7ff',
  personal: '#f3b64b',
  creative: '#e36fad',
  meta: '#9c83ff',
  project: '#45c79a',
  plugin: '#69d3c5',
  global: '#f2eddf',
  other: '#687080',
}

export const INK = '#111318'
export const DANGER = '#ff6b5f'
export const MUTED = '#8c93a4'
export const CALLS = '#cfc8b8'
export const CARD_BORDER = '#687080'

export function areaKey(id: string | null): AreaKey {
  const head = (id ?? '').split(/[.:]/)[0] ?? ''
  return Object.hasOwn(COLORS, head) ? (head as AreaKey) : 'other'
}

export function areaColor(key: AreaKey): string {
  return COLORS[key]
}

export function areaIdColor(id: string | null): string {
  return areaColor(areaKey(id))
}

export function groupColor(level: string | null, label: string): string {
  if (level === 'domain') return areaIdColor(label)
  if (level === 'project') return areaColor('project')
  if (level === 'plugin') return areaColor('plugin')
  return areaColor('global')
}

export function percentShares(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return values.map(() => 0)
  const exact = values.map(value => (value / total) * 100)
  const shares = exact.map(Math.floor)
  const byRemainder = exact.map((value, index) => ({ index, rest: value - Math.floor(value) })).sort((a, b) => b.rest - a.rest)
  const leftover = 100 - shares.reduce((sum, share) => sum + share, 0)
  for (const { index } of byRemainder.slice(0, leftover)) shares[index]!++
  values.forEach((value, index) => {
    if (value <= 0 || shares[index]! > 0) return
    shares[index] = 1
    shares[shares.indexOf(Math.max(...shares))]!--
  })
  return shares
}

export function percentOfMax(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0
  return Math.min(100, Math.max(1, Math.round((value / max) * 100)))
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  return `${String(Math.round(count / 100) / 10).replace('.', ',')} тыс.`
}
