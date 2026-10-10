import type { Elements } from 'claude-code'

import type { BrainView } from '../types'
import { areaColor, areaKey, percentShares } from './charts'

export type Ui = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button'>

const INK = '#111318'
const DANGER = '#ff6b5f'
const MUTED = '#8c93a4'

export function Chip({ Box, Text }: Ui, color: string, text: string) {
  return (
    <Box alignSelf="flex-start" backgroundColor={color} paddingX={1}>
      <Text bold color={INK}>{text}</Text>
    </Box>
  )
}

export function AreaHeader(ui: Ui, view: BrainView) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column">
      {Chip(ui, areaColor(areaKey(view.domain)), view.domain)}
      <Text dimColor wrap="wrap">Почему: {view.domainReason}.</Text>
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        <Text dimColor>Цепочка:</Text>
        {view.chain.length === 0 && <Text dimColor>—</Text>}
        {view.chain.map(id => Chip(ui, areaColor(areaKey(id)), id))}
      </Box>
    </Box>
  )
}

export function ShareBar({ Box, Text }: Ui, view: BrainView) {
  const outside = view.visibleOutside.length
  const plugin = view.unhideable.length
  const parts = [
    { count: view.listedCount === null ? 0 : Math.max(0, view.listedCount - outside - plugin), color: areaColor(areaKey(view.domain)), label: 'в области' },
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

export function HarnessCards({ Box, Text }: Ui, harness: BrainView['harness']) {
  const cards = [
    { title: 'Правила', count: harness.rules, note: `выключено ${harness.rulesOff}` },
    { title: 'MCP-серверы', count: harness.mcp, note: null },
    { title: 'Агенты', count: harness.agents, note: null },
    { title: 'Файлы инструкций', count: harness.instructions, note: null },
  ]
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {cards.map(card => (
          <Box flexDirection="column" borderStyle="round" borderColor={areaColor('other')} paddingX={1}>
            <Text bold>{card.count}</Text>
            <Text>{card.title}</Text>
            {card.note && <Text dimColor>{card.note}</Text>}
          </Box>
        ))}
      </Box>
      <Text dimColor wrap="wrap">
        Здесь: правил {harness.rules}, выключено {harness.rulesOff}; MCP-серверов {harness.mcp}; агентов {harness.agents}; файлов инструкций {harness.instructions}.
      </Text>
    </Box>
  )
}
