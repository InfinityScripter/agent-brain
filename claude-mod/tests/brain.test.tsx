import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const CWD = '/work/notes'
const INSPECT = {
  context: { domain: 'personal.software', source: 'path', chain: ['personal', 'personal.software'], project: null },
  root: CWD,
  skills: [
    { listed_name: 'ququ-review', scope_detail: null, usage: { count: 4 }, hideable: true, override: { effective: null, level: null } },
    { listed_name: 'ququ-review', scope_detail: 'work.yandex', usage: { count: 4 }, hideable: true, override: { effective: null, level: null } },
    { listed_name: 'arc', scope_detail: 'work.yandex', usage: { count: 9 }, hideable: true, override: { effective: 'user-invocable-only', level: 'local' } },
    { listed_name: 'zz-unlisted', scope_detail: 'work.yandex', usage: { count: 0 }, hideable: true, override: { effective: null, level: null } },
    { listed_name: 'superpowers:tdd', scope_detail: 'superpowers', usage: { count: 0 }, hideable: false, override: { effective: null, level: null } },
  ],
  warnings: [],
  advice: { recommendations: [], gaps: [] },
  rules: [{ enabled: true }, { enabled: false }],
  mcp: [{ name: 'yql' }],
  agents: [],
  instructions: [{ path: '/work/notes/CLAUDE.md' }],
}
const DRY_RUN = { hide: ['arc', 'ququ-review', 'zz-unlisted'], tokens: 90, unhideable_plugin_skills: ['superpowers:tdd'] }
const NOT_APPLIED = { domain: 'personal.software', applied: null, stale: false, missing: [], wrongly_hidden: [], command: null }
const STALE = {
  domain: 'personal.software',
  applied: { domain: 'personal.software', level: 'local' },
  stale: true,
  missing: ['ququ-review'],
  wrongly_hidden: [],
  command: `brain use personal.software --settings local --cwd ${CWD}`,
}
const STALE_USER = { ...STALE, applied: { domain: 'personal.software', level: 'user' }, command: 'brain use personal.software' }
const PREFS = {
  domain: 'personal.software',
  preferences: [
    { task: 'Тесты до кода', use: 'test-driven-development', instead_of: ['superpowers:tdd'], applies: true },
    { task: 'Баг', use: 'systematic-debugging', instead_of: ['superpowers:systematic-debugging'], applies: false },
    { task: 'Скилл', use: 'skill-conductor', instead_of: ['superpowers:writing-skills'], applies: true },
  ],
}
const LISTING = [
  'ququ-review', 'superpowers:tdd', 'superpowers:systematic-debugging', 'superpowers:writing-skills',
  'test-driven-development', 'systematic-debugging',
]
const PANE = {
  plugin: 'agent-brain',
  component: 'Pane',
  requestId: 'agent-brain',
  props: { title: 'Brain', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const
const RUN_BRAIN = { command: 'brain', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never

type World = { profile?: object; failing?: string; missingBrain?: boolean; brokenInspect?: boolean }

function brainWorld(on: On, world: World = {}) {
  const runs: string[][] = []
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const opened: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('env.get', () => ({ value: undefined }))
  on('fs.stat', (_$, e) =>
    world.missingBrain && e.path.endsWith('/bin/brain')
      ? { deny: 'no such file' }
      : ({ value: { realPath: '/repo/agent-brain/claude-mod' } } as never),
  )
  on('session.cwd', () => ({ value: CWD }))
  on('session.usage', () => ({
    value: {
      context: {
        breakdown: {
          skills: { totalSkills: 7, includedSkills: 5, skillFrontmatter: LISTING.map(name => ({ name })) },
        },
      },
    },
  }) as never)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('skill.prompt', (_$, e) => ({ text: e.text }))
  on('process.run', (_$, e) => {
    const args = e.argv.slice(1)
    runs.push(args)
    const replies: Record<string, unknown> = {
      inspect: INSPECT,
      profile: world.profile ?? NOT_APPLIED,
      prefs: PREFS,
      use: args.includes('--dry-run') ? DRY_RUN : null,
    }
    const reply = replies[args[0] ?? '']
    const fails = args[0] === world.failing
    const stdout = world.brokenInspect && args[0] === 'inspect' ? 'Traceback' : reply ? JSON.stringify(reply) : 'Hidden from the model: 2 skills'
    return {
      value: {
        exitCode: fails ? 1 : 0,
        stdout: fails ? '' : stdout,
        stderr: fails ? 'Traceback (most recent call last):\n  File "brain.py"\nValueError: boom' : '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  return { runs, toasts, statuses, opened }
}

test('a stale profile shows one toast at session start, off the start path', async ($, on) => {
  const clock = mock.clock(on)
  const world = brainWorld(on, { profile: STALE })

  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  expect(world.runs).toEqual([])
  await clock.settle()

  expect(world.toasts.length).toBe(1)
  expect(world.toasts[0]).toMatch(/устарел/)
  expect(world.opened).toEqual([])
})

test('a fresh or never applied profile stays silent, and a headless run is not checked', async ($, on) => {
  const clock = mock.clock(on)
  const world = brainWorld(on)

  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(world.toasts).toEqual([])
  expect(world.statuses).toEqual(['Brain: personal.software · /brain'])

  const headless = world.runs.length
  await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
  await clock.settle()
  expect(world.runs.length).toBe(headless)
})

test('applying the profile to the folder runs only after the person confirms', async ($, on) => {
  const clock = mock.clock(on)
  const world = brainWorld(on)
  const writes = () => world.runs.filter(args => args[0] === 'use' && !args.includes('--dry-run'))
  await $.command.run(RUN_BRAIN)
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /Видны, но вне этой области/ })).toBeDefined()
    expect(await ui.find({ text: /правил 2, выключено 1; MCP-серверов 1; агентов 0; файлов инструкций 1/ })).toBeDefined()
    expect(await ui.find({ text: /zz-unlisted/ })).toBeUndefined()
    expect(await ui.find({ text: /ququ-review · work\.yandex/ })).toBeDefined()
    await ui.press({ key: 'apply' })
    expect(writes()).toEqual([])
    expect(await ui.find({ text: /settings\.local\.json/ })).toBeDefined()
    await ui.press({ key: 'cancel' })
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'apply' })
  await ui.press({ key: 'confirm' })
  expect(writes()).toEqual([['use', 'personal.software', '--settings', 'local', '--cwd', CWD]])
  expect(await ui.find({ text: /Готово/ })).toBeDefined()
  await ui.unmount()
})

test('turning one skill off runs only after the person confirms', async ($, on) => {
  const clock = mock.clock(on)
  const world = brainWorld(on)
  const offs = () => world.runs.filter(args => args[0] === 'skill')
  await $.command.run(RUN_BRAIN)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'off-ququ-review' })
  expect(offs()).toEqual([])
  await ui.press({ key: 'confirm' })
  expect(offs()).toEqual([['skill', 'off', 'ququ-review', '--settings', 'local', '--cwd', CWD]])
  await ui.unmount()
})

test('a stale shared profile is only named; the button applies the folder profile', async ($, on) => {
  const clock = mock.clock(on)
  const world = brainWorld(on, { profile: STALE_USER })
  await $.command.run(RUN_BRAIN)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /обновить его: brain use personal\.software\./ })).toBeDefined()
  await ui.press({ key: 'apply' })
  await ui.press({ key: 'confirm' })
  expect(world.runs.filter(args => args[0] === 'use' && !args.includes('--dry-run'))).toEqual([
    ['use', 'personal.software', '--settings', 'local', '--cwd', CWD],
  ])
  await ui.unmount()
})

test('a failed write says what failed instead of done', async ($, on) => {
  const clock = mock.clock(on)
  brainWorld(on, { failing: 'skill' })
  await $.command.run(RUN_BRAIN)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'off-ququ-review' })
  await ui.press({ key: 'confirm' })
  expect(await ui.find({ text: 'Не вышло: ValueError: boom' })).toBeDefined()
  await ui.unmount()
})

test('a broken or missing engine shows in the pane', async ($, on) => {
  const clock = mock.clock(on)
  brainWorld(on, { brokenInspect: true })
  await $.command.run(RUN_BRAIN)
  await clock.settle()
  const broken = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await broken.find({ text: /Brain не ответил: brain inspect ответил не JSON/ })).toBeDefined()
  await broken.unmount()
})

test('a missing brain is named in the pane', async ($, on) => {
  const clock = mock.clock(on)
  brainWorld(on, { missingBrain: true })
  await $.command.run(RUN_BRAIN)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /не найден brain: \/repo\/agent-brain\/bin\/brain/ })).toBeDefined()
  await ui.unmount()
})

test('the model is sent from a plugin duplicate to the preferred skill; typed and model calls are counted', async ($, on) => {
  const clock = mock.clock(on)
  brainWorld(on)
  on('tool.call', { tool: 'Skill' }, (_$, e) => ({ result: { success: true, commandName: e.skill } }) as never)
  const call = (skill: string) => $.tool.call({ tool: 'Skill', skill } as never)

  const redirected = await call('superpowers:tdd')
  const notHere = await call('superpowers:systematic-debugging')
  const preferredHidden = await call('superpowers:writing-skills')
  const other = await call('lavish')
  await $.prompt.submit({ text: '/superpowers:tdd please', origin: { kind: 'composer' }, wait: false } as never)
  await $.prompt.submit({ text: '/brain', origin: { kind: 'composer' }, wait: false } as never)

  expect(redirected.deny).toMatch(/Skill\("test-driven-development"\)/)
  expect(notHere.deny).toBeUndefined()
  expect(preferredHidden.deny).toBeUndefined()
  expect(other.deny).toBeUndefined()

  await $.command.run(RUN_BRAIN)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-calls' })
  expect(await ui.find({ text: 'superpowers:tdd: 2' })).toBeDefined()
  expect(await ui.find({ text: 'lavish: 1' })).toBeDefined()
  expect(await ui.find({ text: /^brain:/ })).toBeUndefined()
  await ui.unmount()
})
