export type QuotaWindow = { kind: string; percentUsed: number; resetsAt?: number }
export type QuotaSnapshot = {
  windows: QuotaWindow[]
  contextPercent?: number
  costUsd?: number
  isLive?: boolean
}
export type AccountReading = { windows: QuotaWindow[]; seenAt: number }
export type ChatGptSnapshot = {
  windows: QuotaWindow[]
  plan?: string
  seenAt?: number
  isLive?: boolean
  note?: string
}

export type Todo = { line: number; text: string; isDone: boolean }
export type Day = { date: string; path: string; todos: Todo[]; error?: string }

declare module 'claude-code' {
  interface PluginState {
    'ai-quota-todo': {
      claude: QuotaSnapshot
      email: string
      accounts: Record<string, AccountReading>
      chatgpt: ChatGptSnapshot
      tick: number
      day: Day | null
    }
  }
}
