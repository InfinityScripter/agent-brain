export type BrainTab = 'skills' | 'dupes' | 'calls' | 'advice'

export type BrainSkillRow = { name: string; detail: string | null; level: string | null; calls: number }

export type BrainGroup = { label: string; level: string | null; skills: BrainSkillRow[] }

export type BrainDupe = { task: string; use: string; insteadOf: string[]; applies: boolean }

export type BrainProfile = {
  domain: string | null
  level: string | null
  stale: boolean
  missing: string[]
  wronglyHidden: string[]
  command: string | null
}

export type BrainView = {
  status: 'loading' | 'ready' | 'error'
  hasData: boolean
  error: string | null
  cwd: string
  root: string
  domain: string
  domainReason: string
  chain: string[]
  listedCount: number | null
  listedTotal: number | null
  hideCount: number
  hideTokens: number
  visibleOutside: BrainSkillRow[]
  groups: BrainGroup[]
  hiddenAlready: number
  unhideable: { name: string; instead: string | null }[]
  profile: BrainProfile
  dupes: BrainDupe[]
  topCalls: { name: string; calls: number }[]
  recommended: { name: string; reason: string }[]
  gaps: string[]
  warnings: string[]
  harness: { rules: number; rulesOff: number; mcp: number; agents: number; instructions: number }
}

export type BrainAction = { title: string; args: string[]; explain: string }

declare module 'claude-code' {
  interface PluginState {
    'agent-brain': {
      view: BrainView | null
      tab: BrainTab
      pending: BrainAction | null
      notice: string | null
      calls: Record<string, number>
    }
  }
}
