import type { BrainAction, BrainDupe, BrainGroup, BrainProfile, BrainSkillRow, BrainView } from '../types'

type Override = { effective: string | null; level: string | null }

export type InspectJson = {
  context: { domain: string; source: string; chain: string[]; project: { id: string } | null }
  root: string
  skills: {
    listed_name: string
    scope_level: string
    scope_detail: string | null
    usage: { count: number }
    hideable: boolean
    override: Override
  }[]
  warnings: string[]
  advice: { recommendations: { listed_name: string; status: string; reasons: string[] }[]; gaps: string[] }
  rules: { enabled: boolean }[]
  mcp: unknown[]
  agents: unknown[]
  instructions: unknown[]
}

export type DryRunJson = { hide: string[]; tokens: number; unhideable_plugin_skills: string[] }

export type ProfileJson = {
  domain: string
  applied: { domain: string; level: string } | null
  stale: boolean
  missing: string[]
  wrongly_hidden: string[]
  command: string | null
}

export type PrefsJson = { preferences: { task: string; use: string; instead_of?: string[]; applies: boolean }[] }

export type Listing = { names: string[]; included: number; total: number }

const REASONS: Record<string, string> = {
  project: 'папка зарегистрированного проекта',
  workspace: 'рабочая копия зарегистрированного проекта',
  path: 'правило для этой папки в реестре',
  override: 'область выбрана вручную через brain use',
  default: 'область по умолчанию: другие правила не подошли',
  explicit: 'область указана явно',
}

const HIDDEN = new Set(['off', 'user-invocable-only'])
const NO_AREA = 'без области'

export function preferredInstead(prefs: PrefsJson | null, name: string): string | null {
  const row = prefs?.preferences.find(item => item.applies && (item.instead_of ?? []).includes(name))
  return row?.use ?? null
}

export function buildView(
  cwd: string,
  inspect: InspectJson,
  dry: DryRunJson,
  profile: ProfileJson,
  prefs: PrefsJson,
  listed: Listing | null,
): BrainView {
  // Several copies share a listed name; the one that names a domain says more.
  const byName = new Map<string, InspectJson['skills'][number]>()
  for (const skill of inspect.skills) {
    if (!byName.get(skill.listed_name)?.scope_detail) byName.set(skill.listed_name, skill)
  }
  const isHidden = (name: string) => HIDDEN.has(byName.get(name)?.override.effective ?? '')
  const outside = dry.hide.filter(name => !isHidden(name) && (listed === null || listed.names.includes(name)))
  const calls = new Map<string, number>()
  for (const skill of inspect.skills) calls.set(skill.listed_name, Math.max(calls.get(skill.listed_name) ?? 0, skill.usage.count))
  const visibleOutside = outside.map(
    (name): BrainSkillRow => ({
      name,
      detail: byName.get(name)?.scope_detail ?? null,
      level: byName.get(name)?.scope_level ?? null,
      calls: calls.get(name) ?? 0,
    }),
  )
  const context = inspect.context

  return {
    status: 'ready',
    hasData: true,
    error: null,
    cwd,
    root: inspect.root,
    domain: context.domain,
    domainReason: (REASONS[context.source] ?? context.source) + (context.project ? `: ${context.project.id}` : ''),
    chain: context.chain,
    listedCount: listed?.included ?? null,
    listedTotal: listed?.total ?? null,
    hideCount: dry.hide.length,
    hideTokens: dry.tokens,
    visibleOutside,
    groups: groupSkills(visibleOutside),
    hiddenAlready: dry.hide.filter(isHidden).length,
    unhideable: dry.unhideable_plugin_skills.map(name => ({ name, instead: preferredInstead(prefs, name) })),
    profile: toProfile(profile),
    dupes: prefs.preferences.map(
      (row): BrainDupe => ({ task: row.task, use: row.use, insteadOf: row.instead_of ?? [], applies: row.applies }),
    ),
    topCalls: [...calls.entries()]
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, calls: count })),
    recommended: inspect.advice.recommendations
      .filter(item => item.status === 'recommended')
      .map(item => ({ name: item.listed_name, reason: item.reasons[0] ?? '' })),
    gaps: inspect.advice.gaps,
    warnings: inspect.warnings,
    harness: {
      rules: inspect.rules.length,
      rulesOff: inspect.rules.filter(rule => !rule.enabled).length,
      mcp: inspect.mcp.length,
      agents: inspect.agents.length,
      instructions: inspect.instructions.length,
    },
  }
}

function groupSkills(rows: BrainSkillRow[]): BrainGroup[] {
  const byLabel = new Map<string, BrainGroup>()
  for (const row of rows) {
    const label = row.detail ?? NO_AREA
    const group = byLabel.get(label) ?? { label, level: row.level, skills: [] }
    group.skills.push(row)
    byLabel.set(label, group)
  }
  return [...byLabel.values()].sort((a, b) => Number(a.label === NO_AREA) - Number(b.label === NO_AREA) || b.skills.length - a.skills.length)
}

function toProfile(profile: ProfileJson): BrainProfile {
  return {
    domain: profile.applied?.domain ?? null,
    level: profile.applied?.level ?? null,
    stale: profile.stale,
    missing: profile.missing,
    wronglyHidden: profile.wrongly_hidden,
    command: profile.command,
  }
}

export function staleLine(profile: ProfileJson): string | null {
  if (!profile.stale || !profile.applied) return null
  const parts = []
  if (profile.missing.length) parts.push(`${profile.missing.length} новых скиллов видны модели вне области`)
  if (profile.wrongly_hidden.length) parts.push(`${profile.wrongly_hidden.length} спрятаны зря`)
  return `Brain: профиль «${profile.applied.domain}» устарел, ${parts.join(', ')}. Открыть: /brain`
}

export function redirectText(skill: string, use: string): string {
  return (
    `Скилл ${skill} заменён личным скиллом ${use} (Agent Brain, skill_preferences в config/brain.json). ` +
    `Вызови Skill("${use}") и работай по нему.`
  )
}

export function applyProfileAction(view: BrainView): BrainAction {
  const isRefresh = view.profile.stale && view.profile.level === 'local'
  return {
    title: `${isRefresh ? 'Обновить' : 'Применить'} профиль области «${view.domain}» в этой папке?`,
    args: ['use', view.domain, '--settings', 'local', '--cwd', view.cwd],
    explain:
      `Спрячет от модели скиллы вне области, сейчас их ${view.hideCount}, около ${view.hideTokens} токенов. ` +
      `Запишется в ${view.cwd}/.claude/settings.local.json и подействует в новых сессиях из этой папки. ` +
      'Через /имя они по-прежнему вызываются.',
  }
}

export function turnOffAction(view: BrainView, name: string): BrainAction {
  return {
    title: `Выключить ${name} в этой папке?`,
    args: ['skill', 'off', name, '--settings', 'local', '--cwd', view.cwd],
    explain:
      `Запишется в ${view.root}/.claude/settings.local.json и подействует в новых сессиях оттуда. ` +
      `Скилл пропадёт и для модели, и из меню /: вызвать его по имени тоже будет нельзя. Вернуть: brain skill on ${name}.`,
  }
}

export function commandLine(args: string[]): string {
  return ['brain', ...args].map(arg => (/\s/.test(arg) ? `'${arg}'` : arg)).join(' ')
}
