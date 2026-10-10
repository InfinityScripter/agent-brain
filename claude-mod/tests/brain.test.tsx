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

type World = {
  profile?: object
  failing?: string
  missingBrain?: boolean
  brokenInspect?: boolean
  inspect?: object
  dry?: object
  noListing?: boolean
}

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
    value: world.noListing
      ? { context: {} }
      : {
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
      inspect: world.inspect ?? INSPECT,
      profile: world.profile ?? NOT_APPLIED,
      prefs: PREFS,
      use: args.includes('--dry-run') ? (world.dry ?? DRY_RUN) : null,
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

const META_INSPECT = {
  ...INSPECT,
  context: {
    domain: 'meta.agent-system',
    source: 'project',
    chain: ['meta', 'meta.agent-system', 'project:agent-brain'],
    project: { id: 'agent-brain' },
  },
}
const FRESH = { domain: 'personal.software', applied: { domain: 'personal.software', level: 'local' }, stale: false, missing: [], wrongly_hidden: [], command: null }

test('the header shows the area and its chain as badges in the area colors, on every surface', async ($, on) => {
  const clock = mock.clock(on)
  brainWorld(on, { inspect: META_INSPECT })
  await $.command.run(RUN_BRAIN)
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const badges = (await ui.findAll({ type: 'Box' }))
      .filter(box => box.props.backgroundColor && box.text)
      .map(box => [box.text, box.props.backgroundColor])
    expect(badges.slice(0, 4)).toEqual([
      ['meta.agent-system', '#9c83ff'],
      ['meta', '#9c83ff'],
      ['meta.agent-system', '#9c83ff'],
      ['project:agent-brain', '#45c79a'],
    ])
    for (const type of ['Svg', 'Raster', 'Image']) expect(await ui.findAll({ type })).toEqual([])
    await ui.unmount()
  }
})

test('the bar splits what the model sees into whole percents that add up to 100, with a legend', async ($, on) => {
  const clock = mock.clock(on)
  brainWorld(on)
  await $.command.run(RUN_BRAIN)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const segments = (await ui.findAll({ type: 'Box' })).filter(box => box.props.backgroundColor && typeof box.props.width === 'string')
  expect(segments.map(box => [box.props.width, box.props.backgroundColor, box.props.minWidth])).toEqual([
    ['50%', '#f3b64b', 1],
    ['17%', '#ff6b5f', 1],
    ['17%', '#69d3c5', 1],
    ['16%', '#8c93a4', 1],
  ])
  for (const text of ['Модель видит 5', '3 в области', '1 вне области', '1 плагинные', '1 уже спрятаны вне области']) {
    expect(await ui.find({ type: 'Text', text })).toBeDefined()
  }
  await ui.unmount()
})

test('without the list of skills the model sees, the bar has no in-area part and says so', async ($, on) => {
  const clock = mock.clock(on)
  brainWorld(on, { noListing: true })
  await $.command.run(RUN_BRAIN)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const segments = (await ui.findAll({ type: 'Box' })).filter(box => box.props.backgroundColor && typeof box.props.width === 'string')
  expect(segments.map(box => [box.props.width, box.props.backgroundColor])).toEqual([
    ['50%', '#ff6b5f'],
    ['25%', '#69d3c5'],
    ['25%', '#8c93a4'],
  ])
  expect(await ui.find({ type: 'Text', text: 'Сколько скиллов видит модель, неизвестно' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2 вне области' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\d+ в области$/ })).toBeUndefined()
  await ui.unmount()
})

test('with nothing outside the area the bar keeps in-area and hidden, and the legend has no zeros', async ($, on) => {
  const clock = mock.clock(on)
  brainWorld(on, { dry: { hide: ['arc'], tokens: 90, unhideable_plugin_skills: [] } })
  await $.command.run(RUN_BRAIN)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const segments = (await ui.findAll({ type: 'Box' })).filter(box => box.props.backgroundColor && typeof box.props.width === 'string')
  expect(segments.map(box => [box.props.width, box.props.backgroundColor])).toEqual([
    ['83%', '#f3b64b'],
    ['17%', '#8c93a4'],
  ])
  expect(await ui.find({ type: 'Text', text: '5 в области' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1 уже спрятаны вне области' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^0 / })).toBeUndefined()
  await ui.unmount()
})

test('a profile that is not applied says how many skills it would hide and the tokens it would save', async ($, on) => {
  const clock = mock.clock(on)
  brainWorld(on, { dry: { ...DRY_RUN, tokens: 12415 } })
  await $.command.run(RUN_BRAIN)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Профиль спрячет 3 скиллов и сэкономит около 12,4 тыс\. токенов/ })).toBeDefined()
  await ui.unmount()
})

test('a fresh profile says how many skills it already hides and the tokens that is', async ($, on) => {
  const clock = mock.clock(on)
  brainWorld(on, { profile: FRESH })
  await $.command.run(RUN_BRAIN)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Профиль уже прячет 3 скиллов, это около 90 токенов/ })).toBeDefined()
  await ui.unmount()
})

test('a stale profile keeps its own sentence and promises no savings', async ($, on) => {
  const clock = mock.clock(on)
  brainWorld(on, { profile: STALE })
  await $.command.run(RUN_BRAIN)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Профиль папки «personal\.software» устарел: 1 скиллов видны вне области, 0 спрятаны зря\./ })).toBeDefined()
  expect(await ui.find({ text: /сэкономит|уже прячет/ })).toBeUndefined()
  await ui.unmount()
})

test('four cards count rules, MCP servers, agents and instruction files, with the old line under them', async ($, on) => {
  const clock = mock.clock(on)
  brainWorld(on)
  await $.command.run(RUN_BRAIN)
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const cards = (await ui.findAll({ type: 'Box' })).filter(box => box.props.borderStyle === 'round')
    expect(cards.length).toBe(4)
    for (const title of ['Правила', 'MCP-серверы', 'Агенты', 'Файлы инструкций']) {
      expect(await ui.find({ type: 'Text', text: title })).toBeDefined()
    }
    expect(cards[0]?.text).toMatch(/выключено 1/)
    const row = (await ui.findAll({ type: 'Box' })).find(box => box.props.flexWrap === 'wrap' && box.children.length === 4)
    expect(row).toBeDefined()
    expect(
      await ui.find({ type: 'Text', text: 'Здесь: правил 2, выключено 1; MCP-серверов 1; агентов 0; файлов инструкций 1.' }),
    ).toBeDefined()
    await ui.unmount()
  }
})

test('with no earlier data an error shows alone; with earlier data the numbers stay beside the error', async ($, on) => {
  const clock = mock.clock(on)
  const world: World = { failing: 'inspect' }
  brainWorld(on, world)
  await $.command.run(RUN_BRAIN)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const drawn = async () => ({
    segments: (await ui.findAll({ type: 'Box' })).filter(box => box.props.backgroundColor && typeof box.props.width === 'string').length,
    cards: (await ui.findAll({ type: 'Box' })).filter(box => box.props.borderStyle === 'round').length,
  })
  expect(await ui.find({ text: /Brain не ответил: ValueError: boom/ })).toBeDefined()
  expect(await drawn()).toEqual({ segments: 0, cards: 0 })

  world.failing = undefined
  await ui.press({ key: 'reload' })
  await clock.settle()
  expect(await drawn()).toEqual({ segments: 4, cards: 4 })
  expect(await ui.find({ text: /Brain не ответил/ })).toBeUndefined()

  world.failing = 'inspect'
  await ui.press({ key: 'reload' })
  await clock.settle()
  expect(await drawn()).toEqual({ segments: 4, cards: 4 })
  expect(await ui.find({ text: /Brain не ответил: ValueError: boom/ })).toBeDefined()
  await ui.unmount()
})

const outsideSkills = (groups: [label: string | null, level: string, count: number][]) => {
  const skills = groups.flatMap(([label, level, count]) =>
    Array.from({ length: count }, (_, index) => ({
      listed_name: `${label ?? 'plain'}-${index}`,
      scope_level: level,
      scope_detail: label,
      usage: { count: 0 },
      hideable: true,
      override: { effective: null, level: null },
    })),
  )
  return {
    noListing: true,
    inspect: { ...INSPECT, skills },
    dry: { hide: skills.map(skill => skill.listed_name), tokens: 90, unhideable_plugin_skills: ['superpowers:tdd'] },
  }
}

const buttonKeys = async (ui: { findAll: (query: { type: string }) => Promise<{ key: string | undefined }[]> }, prefix: string) =>
  (await ui.findAll({ type: 'Button' })).map(button => button.key).filter(key => key?.startsWith(prefix))

test('more than five skills outside the area come as collapsed groups with a counter and a color mark', async ($, on) => {
  const clock = mock.clock(on)
  brainWorld(on, outsideSkills([['work.yandex', 'domain', 3], ['tef-trigger-platform', 'project', 2], [null, 'global', 3]]))
  await $.command.run(RUN_BRAIN)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await buttonKeys(ui, 'off-')).toEqual([])
  const headers = (await ui.findAll({ type: 'Button' })).filter(button => button.key?.startsWith('group-'))
  expect(headers.map(button => [button.key, button.props.label])).toEqual([
    ['group-work.yandex', 'work.yandex · скиллов: 3'],
    ['group-tef-trigger-platform', 'tef-trigger-platform · скиллов: 2'],
    ['group-без области', 'без области · скиллов: 3'],
  ])
  expect((await ui.find({ key: 'color-work.yandex' }))?.props.backgroundColor).toBe('#46a7ff')
  expect((await ui.find({ key: 'color-tef-trigger-platform' }))?.props.backgroundColor).toBe('#45c79a')
  expect((await ui.find({ key: 'color-без области' }))?.props.backgroundColor).toBe('#f2eddf')

  const tree = JSON.stringify(await ui.drawn())
  expect(tree.indexOf('Видны, но вне этой области')).toBeGreaterThan(-1)
  expect(tree.indexOf('group-work.yandex')).toBeGreaterThan(tree.indexOf('Видны, но вне этой области'))
  await ui.unmount()
})

test('pressing a group header shows its rows with turn-off buttons, pressing it again hides them', async ($, on) => {
  const clock = mock.clock(on)
  brainWorld(on, outsideSkills([['work.yandex', 'domain', 3], ['tef-trigger-platform', 'project', 2], [null, 'global', 3]]))
  await $.command.run(RUN_BRAIN)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'group-work.yandex' })
  expect(await buttonKeys(ui, 'off-')).toEqual(['off-work.yandex-0', 'off-work.yandex-1', 'off-work.yandex-2'])
  expect(await ui.find({ text: 'work.yandex-1 · work.yandex · вызовов 0' })).toBeDefined()
  expect(await ui.find({ text: 'Скиллы плагинов: по одному не спрятать' })).toBeDefined()
  expect(await ui.find({ text: /superpowers:tdd/ })).toBeDefined()

  await ui.press({ key: 'group-work.yandex' })
  expect(await buttonKeys(ui, 'off-')).toEqual([])
  await ui.unmount()
})

test('an open group shows at most 25 rows and says how many more the profile hides', async ($, on) => {
  const clock = mock.clock(on)
  brainWorld(on, outsideSkills([['work.yandex', 'domain', 27]]))
  await $.command.run(RUN_BRAIN)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'group-work.yandex' })
  const keys = await buttonKeys(ui, 'off-')
  expect(keys.length).toBe(25)
  expect(keys.at(-1)).toBe('off-work.yandex-24')
  expect(await ui.find({ type: 'Text', text: 'И ещё 2 в этой группе: их спрячет профиль одной кнопкой' })).toBeDefined()
  await ui.unmount()
})

test('five skills outside the area come as open groups, six come collapsed', async ($, on) => {
  const clock = mock.clock(on)
  const world: World = outsideSkills([['work.yandex', 'domain', 3], ['tef-trigger-platform', 'project', 2]])
  brainWorld(on, world)
  await $.command.run(RUN_BRAIN)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await buttonKeys(ui, 'group-')).toEqual(['group-work.yandex', 'group-tef-trigger-platform'])
  expect((await buttonKeys(ui, 'off-')).length).toBe(5)

  Object.assign(world, outsideSkills([['work.yandex', 'domain', 4], ['tef-trigger-platform', 'project', 2]]))
  await ui.press({ key: 'reload' })
  await clock.settle()
  expect(await buttonKeys(ui, 'group-')).toEqual(['group-work.yandex', 'group-tef-trigger-platform'])
  expect(await buttonKeys(ui, 'off-')).toEqual([])
  await ui.unmount()
})

test('an opened group stays open after a refresh and after a finished action, and turning a skill off still asks first', async ($, on) => {
  const clock = mock.clock(on)
  const world = brainWorld(on, outsideSkills([['work.yandex', 'domain', 3], ['tef-trigger-platform', 'project', 2], [null, 'global', 3]]))
  const offs = () => world.runs.filter(args => args[0] === 'skill')
  await $.command.run(RUN_BRAIN)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'group-tef-trigger-platform' })
  await ui.press({ key: 'reload' })
  await clock.settle()
  expect(await buttonKeys(ui, 'off-')).toEqual(['off-tef-trigger-platform-0', 'off-tef-trigger-platform-1'])

  await ui.press({ key: 'off-tef-trigger-platform-0' })
  expect(offs()).toEqual([])
  await ui.press({ key: 'confirm' })
  await clock.settle()
  expect(offs()).toEqual([['skill', 'off', 'tef-trigger-platform-0', '--settings', 'local', '--cwd', CWD]])
  expect(await ui.find({ text: /Готово/ })).toBeDefined()
  expect(await buttonKeys(ui, 'off-')).toEqual(['off-tef-trigger-platform-0', 'off-tef-trigger-platform-1'])
  await ui.unmount()
})
