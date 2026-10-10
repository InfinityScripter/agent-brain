import type { Elements, RenderChildren } from 'claude-code'

import type { BrainDupe, BrainGroup, BrainView } from '../types'
import { CALLS, CARD_BORDER, DANGER, INK, MUTED, areaColor, areaIdColor, groupColor, percentOfMax, percentShares } from './charts'

export type Ui = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button'>

const ROWS_SHOWN = 25

export function Chip({ Box, Text }: Ui, color: string, text: string) {
  return (
    <Box alignSelf="flex-start" backgroundColor={color} paddingX={1}>
      <Text bold color={INK}>{text}</Text>
    </Box>
  )
}

export function Card({ Box }: Ui, direction: 'row' | 'column', ...children: RenderChildren[]) {
  const wrapped = direction === 'row' ? ({ flexWrap: 'wrap', gap: 1 } as const) : {}
  return (
    <Box flexDirection={direction} {...wrapped} borderStyle="round" borderColor={CARD_BORDER} paddingX={1}>
      {children}
    </Box>
  )
}

export function AreaHeader(ui: Ui, view: BrainView) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column">
      {Chip(ui, areaIdColor(view.domain), view.domain)}
      <Text dimColor wrap="wrap">Почему: {view.domainReason}.</Text>
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        <Text dimColor>Цепочка:</Text>
        {view.chain.length === 0 && <Text dimColor>—</Text>}
        {view.chain.map(id => Chip(ui, areaIdColor(id), id))}
      </Box>
    </Box>
  )
}

export function ShareBar({ Box, Text }: Ui, view: BrainView) {
  const outside = view.visibleOutside.length
  const plugin = view.unhideable.length
  const parts = [
    { count: view.listedCount === null ? 0 : Math.max(0, view.listedCount - outside - plugin), color: areaIdColor(view.domain), label: 'в области' },
    { count: outside, color: DANGER, label: 'вне области' },
    { count: plugin, color: areaColor('plugin'), label: 'плагинные' },
    { count: view.hiddenAlready, color: MUTED, label: 'уже спрятаны вне области' },
  ]
  const shares = percentShares(parts.map(part => part.count))
  const bars = parts.map((part, index) => ({ ...part, share: shares[index] ?? 0 })).filter(bar => bar.count > 0)

  return (
    <Box flexDirection="column">
      <Text bold>{view.listedCount === null ? 'Сколько скиллов видит модель, неизвестно' : `Модель видит ${view.listedCount}`}</Text>
      {bars.length > 0 && (
        <Box flexDirection="row" width="100%">
          {bars.map(bar => <Box width={`${bar.share}%`} minWidth={1} height={1} backgroundColor={bar.color} />)}
        </Box>
      )}
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {bars.map(bar => (
          <Box flexDirection="row" gap={1}>
            <Box width={2} height={1} backgroundColor={bar.color} />
            <Text>{bar.count} {bar.label}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

export function HarnessCards(ui: Ui, harness: BrainView['harness']) {
  const { Box, Text } = ui
  const cards = [
    { title: 'Правила', count: harness.rules, note: `выключено ${harness.rulesOff}` },
    { title: 'MCP-серверы', count: harness.mcp, note: null },
    { title: 'Агенты', count: harness.agents, note: null },
    { title: 'Файлы инструкций', count: harness.instructions, note: null },
  ]
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {cards.map(card =>
          Card(ui, 'column', <Text bold>{card.count}</Text>, <Text>{card.title}</Text>, card.note && <Text dimColor>{card.note}</Text>),
        )}
      </Box>
      <Text dimColor wrap="wrap">
        Здесь: правил {harness.rules}, выключено {harness.rulesOff}; MCP-серверов {harness.mcp}; агентов {harness.agents}; файлов инструкций {harness.instructions}.
      </Text>
    </Box>
  )
}

export function SkillGroups(
  { Box, Text, Button }: Ui,
  groups: BrainGroup[],
  open: string[],
  onToggle: (label: string) => void,
  onTurnOff: (name: string) => void,
) {
  const allOpen = groups.reduce((sum, group) => sum + group.skills.length, 0) <= 5
  return (
    <Box flexDirection="column">
      {groups.map(group => {
        const isOpen = allOpen || open.includes(group.label)
        const hidden = group.skills.length - ROWS_SHOWN
        return (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Box key={`color-${group.label}`} width={2} height={1} backgroundColor={groupColor(group.level, group.label)} />
              <Button
                key={`group-${group.label}`}
                variant={isOpen ? 'primary' : 'secondary'}
                label={`${group.label} · скиллов: ${group.skills.length}`}
                onPress={() => onToggle(group.label)}
              />
            </Box>
            {isOpen && (
              <Box flexDirection="column" paddingLeft={2}>
                {group.skills.slice(0, ROWS_SHOWN).map(row => (
                  <Box flexDirection="row" key={`row-${row.name}`}>
                    <Text wrap="truncate-end">
                      {row.name} <Text dimColor>· {row.detail ?? 'без области'} · вызовов {row.calls}</Text>
                    </Text>
                    <Button key={`off-${row.name}`} plain label="Выключить здесь" onPress={() => onTurnOff(row.name)} />
                  </Box>
                ))}
                {hidden > 0 && <Text dimColor>И ещё {hidden} в этой группе: их спрячет профиль одной кнопкой.</Text>}
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

export function CallsChart({ Box, Text }: Ui, title: string, rows: { name: string; calls: number }[], empty: string) {
  const shown = rows.slice(0, 8)
  const max = Math.max(0, ...shown.map(row => row.calls))
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {shown.length === 0 && <Text dimColor>{empty}</Text>}
      {shown.map(row => (
        <Box flexDirection="column">
          <Text>{row.name}: {row.calls}</Text>
          <Box flexDirection="row" width="100%">
            <Box width={`${percentOfMax(row.calls, max)}%`} minWidth={1} height={1} backgroundColor={CALLS} />
          </Box>
        </Box>
      ))}
    </Box>
  )
}

export function DupeCard(ui: Ui, row: BrainDupe) {
  const { Text } = ui
  return Card(
    ui,
    'row',
    <Text bold>{row.task}:</Text>,
    <Text>беру</Text>,
    Chip(ui, areaColor('project'), row.use),
    <Text>вместо</Text>,
    row.insteadOf.map(name => Chip(ui, areaColor('global'), name)),
    !row.applies && <Text dimColor>· в этой области не действует</Text>,
  )
}

export function AdviceCard(ui: Ui, item: BrainView['recommended'][number]) {
  const { Text } = ui
  return Card(
    ui,
    'row',
    <Text>Стоит включить</Text>,
    Chip(ui, areaColor('project'), item.name),
    <Text dimColor wrap="wrap">{item.reason}</Text>,
  )
}
