export type QuotaWindow = { kind: string; percentUsed: number; resetsAt?: number }
export type QuotaSnapshot = {
  windows: QuotaWindow[]
  contextPercent?: number
  costUsd?: number
  isLive?: boolean
}
export type AccountReading = { windows: QuotaWindow[]; seenAt: number; label?: string }
// key: email + organization, so a Team and a Max seat under one email stay apart; label: what the panel shows
export type ClaudeAccount = { key: string; label: string }
export type ChatGptSnapshot = {
  windows: QuotaWindow[]
  plan?: string
  seenAt?: number
  isLive?: boolean
  note?: string
}

export type Todo = { line: number; text: string; isDone: boolean; section?: string }
export type TodoFile = { path: string; todos: Todo[]; error?: string }
export type Change = { path: string; before: string; after: string; label: string }

declare module 'claude-code' {
  interface PluginState {
    'ai-quota-todo': {
      claude: QuotaSnapshot
      account: ClaudeAccount
      accounts: Record<string, AccountReading>
      chatgpt: ChatGptSnapshot
      tick: number
      file: TodoFile | null
      entry: number
      showDone: boolean
      confirming: string | null
      editing: string | null
      history: Change[]
      undoNote: string
      folded: string[]
    }
  }
}
