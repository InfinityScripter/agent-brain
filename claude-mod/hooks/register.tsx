import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { BrainAction, BrainTab, BrainView } from '../types'
import { formatTokens } from './charts'
import { AreaHeader, HarnessCards, ShareBar } from './panel'
import {
  applyProfileAction,
  buildView,
  commandLine,
  preferredInstead,
  redirectText,
  staleLine,
  turnOffAction,
} from './view'
import type { DryRunJson, InspectJson, Listing, PrefsJson, ProfileJson } from './view'

const PANE = 'agent-brain'
const ROWS_SHOWN = 25

const view = atom({ plugin: 'agent-brain', key: 'view' } as const, null)
const tab = atom({ plugin: 'agent-brain', key: 'tab' } as const, 'skills')
const pending = atom({ plugin: 'agent-brain', key: 'pending' } as const, null)
const notice = atom({ plugin: 'agent-brain', key: 'notice' } as const, null)
const calls = atom({ plugin: 'agent-brain', key: 'calls' } as const, {})

type Dollar = Parameters<Hook<'session.start'>>[0]

let brainPath: string | null = null
let prefsCache: PrefsJson | null = null
let listedCache: string[] | null = null
let generation = 0
let isRunning = false

function lastLine(text: string): string {
  return text.trim().split('\n').filter(Boolean).at(-1) ?? ''
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function engine($: Dollar): Promise<string> {
  if (brainPath === null) {
    const { realPath } = await $.fs.stat($.plugin.root, { resolve: true })
    // Installed from a clone, the mod sits in claude-mod/ beside bin/brain; anywhere else AGENT_BRAIN_BIN says where brain is.
    const candidate =
      (await $.env.get('AGENT_BRAIN_BIN')) || `${(realPath ?? $.plugin.root).replace(/\/[^/]+\/?$/, '')}/bin/brain`
    try {
      await $.fs.stat(candidate)
    } catch {
      throw new Error(`не найден brain: ${candidate}. Поставь мод из клона Agent Brain или задай путь в AGENT_BRAIN_BIN.`)
    }
    brainPath = candidate
  }
  return brainPath
}

async function runBrain($: Dollar, args: string[], timeoutMs = 120_000): Promise<{ ok: boolean; text: string }> {
  const result = await $.process.run([await engine($), ...args], { timeoutMs })
  const ok = result.exitCode === 0
  return { ok, text: ok ? result.stdout : (result.stderr || result.stdout).trim() || `brain exited with ${result.exitCode}` }
}

async function brainJson<T>($: Dollar, args: string[], timeoutMs?: number): Promise<T> {
  const { ok, text } = await runBrain($, args, timeoutMs)
  if (!ok) throw new Error(lastLine(text))
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`brain ${args[0]} ответил не JSON: ${text.slice(0, 120)}`)
  }
}

async function listedSkills($: Dollar): Promise<Listing | null> {
  const skills = (await $.session.usage({ breakdown: 'summary' })).context.breakdown?.skills
  return skills
    ? { names: skills.skillFrontmatter.map(skill => skill.name), included: skills.includedSkills, total: skills.totalSkills }
    : null
}

async function listedNames($: Dollar): Promise<string[] | null> {
  listedCache ??= (await listedSkills($))?.names ?? null
  return listedCache
}

async function countCall($: Dollar, skill: string): Promise<void> {
  await update($, calls, counts => ({ ...counts, [skill]: (counts[skill] ?? 0) + 1 }))
}

async function preferences($: Dollar): Promise<PrefsJson> {
  if (prefsCache === null) {
    try {
      const prefs = await brainJson<PrefsJson>($, ['prefs', '--cwd', await $.session.cwd(), '--json'], 15_000)
      if (!Array.isArray(prefs.preferences)) throw new Error('brain prefs: неожиданный ответ')
      prefsCache = prefs
    } catch (error) {
      prefsCache = { preferences: [] }
      $.ui.log(`agent-brain: preferences unavailable, no redirects this session: ${errorText(error)}`, { to: 'debug' })
    }
  }
  return prefsCache
}

async function load($: Dollar): Promise<void> {
  const mine = ++generation
  let cwd = ''
  try {
    cwd = await $.session.cwd()
    await update($, view, current => (current ? { ...current, status: 'loading' as const } : null))
    const inspect = await brainJson<InspectJson>($, ['inspect', '--cwd', cwd, '--json'])
    const [profile, prefs, dry] = await Promise.all([
      brainJson<ProfileJson>($, ['profile', '--cwd', cwd, '--json']),
      brainJson<PrefsJson>($, ['prefs', '--cwd', cwd, '--json']),
      brainJson<DryRunJson>($, ['use', inspect.context.domain, '--settings', 'local', '--cwd', cwd, '--dry-run', '--json']),
    ])
    const listed = await listedSkills($)
    if (mine !== generation) return
    prefsCache = prefs
    listedCache = listed?.names ?? null
    await update($, view, () => buildView(cwd, inspect, dry, profile, prefs, listed))
  } catch (error) {
    if (mine !== generation) return
    const message = errorText(error)
    await update($, view, current => (current ? { ...current, status: 'error' as const, error: message } : errorView(cwd, message)))
  }
}

function errorView(cwd: string, message: string): BrainView {
  return {
    status: 'error', hasData: false, error: message, cwd, root: cwd, domain: '—', domainReason: 'неизвестно', chain: [],
    listedCount: null, listedTotal: null, hideCount: 0, hideTokens: 0, visibleOutside: [], groups: [], hiddenAlready: 0,
    unhideable: [], profile: { domain: null, level: null, stale: false, missing: [], wronglyHidden: [], command: null },
    dupes: [], topCalls: [], recommended: [], gaps: [], warnings: [],
    harness: { rules: 0, rulesOff: 0, mcp: 0, agents: 0, instructions: 0 },
  }
}

async function execute($: Dollar, action: BrainAction): Promise<void> {
  if (isRunning) return
  isRunning = true
  await update($, pending, () => null)
  await update($, notice, () => `Выполняю: ${commandLine(action.args)}`)
  try {
    const { ok, text } = await runBrain($, action.args)
    await update($, notice, () => `${ok ? 'Готово' : 'Не вышло'}: ${lastLine(text)}`)
  } catch (error) {
    await update($, notice, () => `Не вышло: ${errorText(error)}`)
  } finally {
    isRunning = false
  }
  await load($)
}

async function staleCheck($: Dollar, cwd: string): Promise<void> {
  try {
    const profile = await brainJson<ProfileJson>($, ['profile', '--cwd', cwd, '--json'])
    $.ui.status(`Brain: ${profile.domain} · /brain`)
    const line = staleLine(profile)
    if (line) $.ui.toast(line, { timeoutMs: 15_000 })
  } catch (error) {
    $.ui.log(`agent-brain: profile check failed: ${errorText(error)}`, { to: 'debug' })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'brain',
      description: 'Agent Brain: область этой папки, какие скиллы видит модель, дубли и вызовы',
    })
    // Off the start's path: the session must not wait for the engine.
    if (e.isInteractive) $.clock.after(0, () => void staleCheck($, e.cwd))
    return next(e)
  })

  on('command.run', { command: 'brain' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Brain', focus: true, closeOnEscape: true })
    $.clock.after(0, () => void load($))
    return { text: opened.isPlaced ? 'Agent Brain: панель открыта.' : `Agent Brain: панель не открылась: ${opened.reason}` }
  })

  // A skill the person types as /name never reaches the Skill tool: it is counted here and never redirected.
  on('prompt.submit', async ($, e, next) => {
    const typed = e.origin.kind === 'composer' ? /^\/([\w-]+(?::[\w-]+)?)(?=\s|$)/.exec(e.text.trim()) : null
    if (typed?.[1] && (await listedNames($))?.includes(typed[1])) await countCall($, typed[1])
    return next(e)
  }).catch(($, e, next) => next(e))

  // On the Skill tool, not skill.prompt: under managed settings the built-in security plugin bypasses a user mod's skill.prompt.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    await countCall($, e.skill)
    const use = preferredInstead(await preferences($), e.skill)
    // A preferred skill the profile hides here cannot be called by the model: keep the duplicate.
    if (!use || !(await listedNames($))?.includes(use)) return next(e)
    return { deny: redirectText(e.skill, use) }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const current = await read($, view)
    const shownTab = await read($, tab)
    const action = await read($, pending)
    const message = await read($, notice)
    const sessionCalls = await read($, calls)
    const setTab = (next: BrainTab) => () => update($, tab, () => next)
    const ask = (next: BrainAction) => () => update($, pending, () => next)

    if (current === null) return <Text dimColor>Загружаю данные Agent Brain…</Text>

    const status = (
      <Box flexDirection="column">
        {current.status === 'loading' && <Text dimColor>Обновляю…</Text>}
        {current.status === 'error' && <Text color="error" wrap="wrap">Brain не ответил: {current.error}</Text>}
        {current.warnings.map(text => <Text color="warning" wrap="wrap">{text}</Text>)}
      </Box>
    )

    if (!current.hasData) {
      return (
        <Box flexDirection="column" gap={1}>
          {status}
          <Button key="reload" label="Обновить" onPress={() => load($)} />
        </Box>
      )
    }

    const header = (
      <Box flexDirection="column">
        {AreaHeader(ui, current)}
        {status}
      </Box>
    )

    if (action) {
      return (
        <Box flexDirection="column">
          {header}
          <Text> </Text>
          <Text bold wrap="wrap">{action.title}</Text>
          <Text dimColor wrap="wrap">{commandLine(action.args)}</Text>
          <Text wrap="wrap">{action.explain}</Text>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            <Button key="confirm" variant="primary" label="Выполнить" onPress={() => execute($, action)} />
            <Button key="cancel" autoFocus label="Отмена" onPress={() => update($, pending, () => null)} />
          </Box>
        </Box>
      )
    }

    const isShared = current.profile.level === 'user'
    const tokens = formatTokens(current.hideTokens)
    const profileLine = current.profile.stale
      ? `${isShared ? 'Общий профиль' : 'Профиль папки'} «${current.profile.domain}» устарел: ${current.profile.missing.length} скиллов видны вне области, ${current.profile.wronglyHidden.length} спрятаны зря.` +
        (isShared ? ` Общий профиль меняет все сессии, обновить его: ${current.profile.command}.` : '')
      : current.profile.domain
        ? `${isShared ? 'Общий профиль' : 'Профиль папки'} «${current.profile.domain}» применён и свежий. Профиль уже прячет ${current.hideCount} скиллов, это около ${tokens} токенов.`
        : `Профиль не применён. Профиль спрячет ${current.hideCount} скиллов и сэкономит около ${tokens} токенов.`
    const canApply = (current.profile.level !== 'local' || current.profile.stale) && current.hideCount > 0
    const overflow =
      current.listedTotal !== null && current.listedCount !== null && current.listedTotal > current.listedCount
        ? ` Ещё ${current.listedTotal - current.listedCount} не влезли в бюджет списка.`
        : ''

    return (
      <Box flexDirection="column">
        {header}
        <Box flexDirection="column" marginTop={1}>
          {ShareBar(ui, current)}
          <Text wrap="wrap">{profileLine}</Text>
          {canApply && (
            <Button key="apply" variant="primary" label={current.profile.stale && !isShared ? 'Обновить профиль папки…' : 'Применить к этой папке…'} onPress={ask(applyProfileAction(current))} />
          )}
        </Box>
        {message && <Text dimColor wrap="wrap">{message}</Text>}
        <Box flexDirection="column" marginTop={1}>
          {HarnessCards(ui, current.harness)}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
          <Button key="tab-skills" label="Скиллы" variant={shownTab === 'skills' ? 'primary' : 'secondary'} onPress={setTab('skills')} />
          <Button key="tab-dupes" label="Дубли" variant={shownTab === 'dupes' ? 'primary' : 'secondary'} onPress={setTab('dupes')} />
          <Button key="tab-calls" label="Вызовы" variant={shownTab === 'calls' ? 'primary' : 'secondary'} onPress={setTab('calls')} />
          <Button key="tab-advice" label="Советы" variant={shownTab === 'advice' ? 'primary' : 'secondary'} onPress={setTab('advice')} />
          <Button key="reload" label="Обновить" onPress={() => load($)} />
        </Box>

        {shownTab === 'skills' && (
          <Box flexDirection="column">
            <Text wrap="wrap">
              Модель видит сейчас: {current.listedCount ?? 'неизвестно'}.{overflow} Вне области и видны: {current.visibleOutside.length}. Уже спрятаны: {current.hiddenAlready}. Плагинных не спрятать: {current.unhideable.length}.
            </Text>
            <Text bold>Видны, но вне этой области</Text>
            {current.visibleOutside.length === 0 && <Text dimColor>Таких нет.</Text>}
            {current.visibleOutside.slice(0, ROWS_SHOWN).map(row => (
              <Box flexDirection="row" key={`row-${row.name}`}>
                <Text wrap="truncate-end">
                  {row.name} <Text dimColor>· {row.detail ?? 'без области'} · вызовов {row.calls}</Text>
                </Text>
                <Button key={`off-${row.name}`} plain label="Выключить здесь" onPress={ask(turnOffAction(current, row.name))} />
              </Box>
            ))}
            {current.visibleOutside.length > ROWS_SHOWN && (
              <Text dimColor>И ещё {current.visibleOutside.length - ROWS_SHOWN}: их спрячет профиль одной кнопкой выше.</Text>
            )}
            <Text bold>Скиллы плагинов: по одному не спрятать</Text>
            {current.unhideable.length === 0 && <Text dimColor>Таких нет.</Text>}
            {current.unhideable.map(item => (
              <Text wrap="truncate-end">
                {item.name} <Text dimColor>{item.instead ? `· вместо него ${item.instead}, мод перенаправляет` : '· Claude Code прячет плагин только целиком'}</Text>
              </Text>
            ))}
          </Box>
        )}

        {shownTab === 'dupes' && (
          <Box flexDirection="column">
            {current.dupes.length === 0 && <Text dimColor>Предпочтений нет: добавь skill_preferences в config/brain.json.</Text>}
            {current.dupes.map(row => (
              <Text wrap="wrap">
                <Text bold>{row.task}</Text>: беру {row.use} вместо {row.insteadOf.join(', ')}
                <Text dimColor>{row.applies ? '' : ' · в этой области не действует'}</Text>
              </Text>
            ))}
          </Box>
        )}

        {shownTab === 'calls' && (
          <Box flexDirection="column">
            <Text bold>В этой сессии</Text>
            {Object.keys(sessionCalls).length === 0 && <Text dimColor>Скиллы ещё не вызывались.</Text>}
            {Object.entries(sessionCalls)
              .sort((a, b) => b[1] - a[1])
              .map(([name, count]) => <Text>{name}: {count}</Text>)}
            <Text bold>За всё время, во всех папках</Text>
            {current.topCalls.map(item => <Text>{item.name}: {item.calls}</Text>)}
          </Box>
        )}

        {shownTab === 'advice' && (
          <Box flexDirection="column">
            {current.recommended.length === 0 && current.gaps.length === 0 && <Text dimColor>Советов нет.</Text>}
            {current.recommended.map(item => (
              <Text wrap="wrap">Стоит включить {item.name}: <Text dimColor>{item.reason}</Text></Text>
            ))}
            {current.gaps.map(text => <Text wrap="wrap">{text}</Text>)}
          </Box>
        )}
      </Box>
    )
  })
}
