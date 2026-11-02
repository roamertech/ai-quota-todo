import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderInput, SessionUsage } from 'claude-code'

import type { AccountReading, ChatGptSnapshot, ClaudeAccount, QuotaSnapshot, QuotaWindow } from '../types'

const REFRESH_MS = 60_000
const ACCOUNTS_KEY = 'accounts'
const claude = atom({ plugin: 'ai-quota-todo', key: 'claude' } as const, { windows: [] } as QuotaSnapshot)
const account = atom({ plugin: 'ai-quota-todo', key: 'account' } as const, { key: '', label: '' } as ClaudeAccount)
const accounts = atom({ plugin: 'ai-quota-todo', key: 'accounts' } as const, {} as Record<string, AccountReading>)
const chatgpt = atom({ plugin: 'ai-quota-todo', key: 'chatgpt' } as const, { windows: [] } as ChatGptSnapshot)
const tick = atom({ plugin: 'ai-quota-todo', key: 'tick' } as const, 0)

const LABELS: Record<string, string> = {
  five_hour: '5 小時額度',
  seven_day: '7 天額度',
  seven_day_opus: '7 天 Opus',
  seven_day_sonnet: '7 天 Sonnet',
  seven_day_oauth_apps: '7 天 外部 App',
  '5小時': '5 小時額度',
  '本週': '本週額度',
  spend_limit: '花費上限',
}

const round1 = (n: number) => Math.round(n * 10) / 10

// ---------- Shared file with the HuskyPet desktop pet ----------
// ~/.quota-sync/usage.json: whoever read a provider within FRESH_MS serves the
// other, so the APIs are asked once between both; a failure never overwrites
// a good reading, and a write replaces only its own provider, atomically.

type Provider = 'claude' | 'chatgpt'
type SharedWindow = { label: string; used_percent: number; remaining_percent: number; resets_at: string | null }
type SharedProvider = {
  name: string
  // Claude only: whose limits these are (email|organization). One email can hold a Team and a Max seat,
  // and sessions on both may run at once; a reading without it, or for another account, is not used.
  account?: string
  updated_at: string
  error: string | null
  note: string | null
  windows: SharedWindow[]
}
type SharedFile = { updated_at?: string; writer?: string; providers?: Partial<Record<Provider, SharedProvider>> }

const FRESH_MS = 4 * 60_000
const MIN_ASK_MS = 5 * 60_000
const lastAsked: Record<Provider, number> = { claude: 0, chatgpt: 0 }

const SHARED_LABELS: Record<string, string> = { five_hour: '5小時', seven_day: '本週' }
const KIND_OF_LABEL: Record<string, string> = { '5小時': 'five_hour', '本週': 'seven_day' }

async function sharedPath($: EngineInterface): Promise<string | undefined> {
  const home = await homeDir($)
  return home ? `${home}/.quota-sync/usage.json` : undefined
}

async function readShared($: EngineInterface): Promise<SharedFile> {
  try {
    const path = await sharedPath($)
    if (!path || !(await $.fs.exists(path))) return {}
    return JSON.parse(await $.fs.read(path)) as SharedFile
  } catch {
    return {}
  }
}

function sharedToWindows(provider: Provider, entry: SharedProvider): QuotaWindow[] {
  return entry.windows.map(w => ({
    kind: provider === 'claude' ? (KIND_OF_LABEL[w.label] ?? w.label) : w.label,
    percentUsed: round1(w.used_percent),
    resetsAt: w.resets_at ? Date.parse(w.resets_at) : undefined,
  }))
}

// A reading another program made within FRESH_MS, or nothing.
async function freshShared($: EngineInterface, provider: Provider) {
  const entry = (await readShared($)).providers?.[provider]
  if (!entry || entry.error !== null || entry.windows.length === 0) return undefined
  if (provider === 'claude') {
    const mine = (await read($, account)).key
    if (!mine || entry.account !== mine) return undefined
  }
  const at = Date.parse(entry.updated_at)
  if (!(at > (await $.clock.now()) - FRESH_MS)) return undefined
  return { windows: sharedToWindows(provider, entry), at }
}

async function writeShared($: EngineInterface, provider: Provider, windows: QuotaWindow[]) {
  const path = await sharedPath($)
  if (!path || windows.length === 0) return
  const stamp = new Date(await $.clock.now()).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const file = await readShared($)
  const owner = provider === 'claude' ? (await read($, account)).key : undefined
  if (provider === 'claude' && !owner) return
  const entry: SharedProvider = {
    name: provider === 'claude' ? 'Claude' : 'ChatGPT',
    ...(owner ? { account: owner } : {}),
    updated_at: stamp,
    error: null,
    note: null,
    windows: windows.map(w => ({
      label: provider === 'claude' ? (SHARED_LABELS[w.kind] ?? LABELS[w.kind] ?? w.kind) : w.kind,
      used_percent: w.percentUsed,
      remaining_percent: round1(Math.max(0, 100 - w.percentUsed)),
      resets_at: w.resetsAt ? new Date(w.resetsAt).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
    })),
  }
  const next: SharedFile = { ...file, updated_at: stamp, writer: 'claude-quota', providers: { ...file.providers, [provider]: entry } }
  const tmp = `${path}.claude-quota.tmp`
  try {
    await $.fs.write(tmp, JSON.stringify(next, null, 2))
    const argv = (await isWindows($))
      ? ['powershell', '-NoProfile', '-Command', `Move-Item -Force -LiteralPath '${tmp.replace(/'/g, "''")}' -Destination '${path.replace(/'/g, "''")}'`]
      : ['mv', '-f', tmp, path]
    await $.process.run(argv)
  } catch {}
}

// Whether this mod may ask a provider's API itself now.
async function mayAsk($: EngineInterface, provider: Provider): Promise<boolean> {
  const now = await $.clock.now()
  if (now - lastAsked[provider] < MIN_ASK_MS) return false
  lastAsked[provider] = now
  return true
}

// ---------- Claude ----------

function fromMeasure(u: Pick<SessionUsage, 'rateLimits' | 'context' | 'cost'>): QuotaSnapshot {
  return {
    windows: u.rateLimits.map(w => ({
      kind: w.kind,
      percentUsed: w.percentUsed,
      resetsAt: w.resetsAt ? Date.parse(w.resetsAt) : undefined,
    })),
    contextPercent: u.context.percent,
    costUsd: u.cost?.usd,
  }
}

// The account's live limits, the same figures claude.ai's usage settings show.
async function fetchClaudeLive($: EngineInterface): Promise<QuotaWindow[] | undefined> {
  const auth = await $.session.authorize()
  if (!auth || auth.kind !== 'bearer') return undefined
  const res = await $.http.fetch('https://api.anthropic.com/api/oauth/usage', {
    auth: auth.handle,
    headers: { 'anthropic-beta': 'oauth-2025-04-20' },
  })
  if (!res.ok) return undefined
  const body = JSON.parse(res.text) as Record<string, { utilization?: number | null; resets_at?: string | null } | null>
  const windows: QuotaWindow[] = []
  for (const [kind, w] of Object.entries(body)) {
    if (!w || typeof w !== 'object' || typeof w.utilization !== 'number') continue
    windows.push({
      kind,
      percentUsed: round1(w.utilization),
      resetsAt: w.resets_at ? Date.parse(w.resets_at) : undefined,
    })
  }
  return windows.length > 0 ? windows : undefined
}

async function rememberAccount($: EngineInterface) {
  const who = await read($, account)
  const snap = await read($, claude)
  if (!who.key || snap.windows.length === 0) return
  const reading: AccountReading = { windows: snap.windows, seenAt: await $.clock.now(), label: who.label }
  await update($, accounts, all => ({ ...all, [who.key]: reading }))
  await $.store.set(ACCOUNTS_KEY, await read($, accounts))
}

// The plan as people say it, from the organization the server reports.
// The organization's type decides the name; the rate-limit tier only adds its multiple
// (a Team premium seat runs on a `..._max_5x` tier, and is still Team).
function planName(type: string | undefined, tier: string | undefined): string | undefined {
  const t = (type ?? '').toLowerCase()
  const times = /(\d+)x\b/.exec((tier ?? '').toLowerCase())?.[1]
  const plan = t.includes('team') ? 'Team'
    : t.includes('enterprise') ? 'Enterprise'
    : t.includes('max') ? 'Max'
    : t.includes('pro') ? 'Pro'
    : undefined
  if (!plan) return times ? `${times}x` : undefined
  if (plan === 'Max') return times ? `Max ${times}x` : 'Max'
  return times ? `${plan}（${times}x 額度）` : plan
}

// This session's own seat, asked once with its own sign-in (one email can hold several seats).
let planOf: { org: string; plan?: string } | undefined
let planAsked = { org: '', at: 0 }

async function fetchPlan($: EngineInterface, org: string): Promise<string | undefined> {
  if (planOf?.org === org) return planOf.plan
  const now = await $.clock.now()
  if (planAsked.org === org && now - planAsked.at < MIN_ASK_MS) return undefined
  planAsked = { org, at: now }
  try {
    const auth = await $.session.authorize()
    if (!auth || auth.kind !== 'bearer') return undefined
    const res = await $.http.fetch('https://api.anthropic.com/api/oauth/profile', {
      auth: auth.handle,
      headers: { 'anthropic-beta': 'oauth-2025-04-20' },
    })
    if (!res.ok) return undefined
    const o = (JSON.parse(res.text) as { organization?: { organization_type?: string; rate_limit_tier?: string } })
      .organization
    planOf = { org, plan: planName(o?.organization_type, o?.rate_limit_tier) }
    return planOf.plan
  } catch {
    return undefined
  }
}

// The account this session is signed in with. The desktop app hands each session its
// organization and email; ~/.claude.json holds only the last sign-in on this computer.
async function detectAccount($: EngineInterface) {
  try {
    let mail = await $.env.get('CLAUDE_CODE_USER_EMAIL')
    let org = await $.env.get('CLAUDE_CODE_ORGANIZATION_UUID')
    let orgName: string | undefined
    const home = await homeDir($)
    if (home && (await $.fs.exists(`${home}/.claude.json`))) {
      const saved = JSON.parse(await $.fs.read(`${home}/.claude.json`))?.oauthAccount
      if (saved && (!org || saved.organizationUuid === org)) {
        mail = mail || saved.emailAddress
        org = org || saved.organizationUuid
        orgName = saved.organizationName
      }
    }
    if (!mail) return
    const key = `${mail}|${org ?? ''}`
    const plan = org ? await fetchPlan($, org) : undefined
    // The organization's name too: two seats under one email may share a plan name.
    const label = [mail, orgName, plan].filter(Boolean).join(' · ')
    const was = await read($, account)
    if (was.key !== key || was.label !== label) await update($, account, () => ({ key, label }))
  } catch {}
}

async function refreshClaude($: EngineInterface) {
  await detectAccount($)
  const shared = await freshShared($, 'claude')
  if (shared) {
    await update($, claude, s => ({ ...s, windows: shared.windows, isLive: true }))
  } else if (await mayAsk($, 'claude')) {
    try {
      const live = await fetchClaudeLive($)
      if (live) {
        await update($, claude, s => ({ ...s, windows: live, isLive: true }))
        await writeShared($, 'claude', live)
      }
    } catch {}
  }
  await rememberAccount($)
}

// ---------- ChatGPT ----------

type WhamWindow = { used_percent: number; limit_window_seconds?: number; reset_at?: number } | null
type CodexWindow = { used_percent: number; window_minutes?: number; resets_at?: number }
type CodexLimits = { primary?: CodexWindow | null; secondary?: CodexWindow | null; plan_type?: string }

function windowLabel(minutes: number | undefined): string {
  if (!minutes) return 'ChatGPT 額度'
  if (minutes === 300) return '5小時'
  if (minutes === 10080) return '本週'
  if (minutes % 1440 === 0) return `${minutes / 1440} 天額度`
  if (minutes % 60 === 0) return `${minutes / 60} 小時額度`
  return `${minutes} 分鐘額度`
}

async function homeDir($: EngineInterface): Promise<string | undefined> {
  return (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
}

async function isWindows($: EngineInterface): Promise<boolean> {
  return (await $.env.get('OS')) === 'Windows_NT'
}

// Asks chatgpt.com with the token the Codex app keeps in ~/.codex/auth.json.
async function fetchChatGptLive($: EngineInterface, home: string): Promise<ChatGptSnapshot> {
  const authPath = `${home}/.codex/auth.json`
  if (!(await $.fs.exists(authPath))) return { windows: [], note: '這台電腦沒有登入 Codex。' }
  const tokens = JSON.parse(await $.fs.read(authPath))?.tokens
  if (!tokens?.access_token) return { windows: [], note: 'Codex 沒有 ChatGPT 登入。' }
  const res = await $.http.fetch('https://chatgpt.com/backend-api/wham/usage', {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      ...(tokens.account_id ? { 'ChatGPT-Account-Id': tokens.account_id } : {}),
      'User-Agent': 'codex-cli',
    },
  })
  if (res.status === 401 || res.status === 403) {
    return { windows: [], note: 'Codex 登入已過期：打開一次 Codex App 就會恢復。' }
  }
  if (!res.ok) return { windows: [], note: `ChatGPT 查詢失敗（${res.status}）。` }
  const body = JSON.parse(res.text) as {
    plan_type?: string
    rate_limit?: { primary_window?: WhamWindow; secondary_window?: WhamWindow }
  }
  const windows = [body.rate_limit?.primary_window, body.rate_limit?.secondary_window]
    .filter((w): w is NonNullable<WhamWindow> => !!w)
    .map(w => ({
      kind: windowLabel(w.limit_window_seconds ? w.limit_window_seconds / 60 : undefined),
      percentUsed: round1(w.used_percent),
      resetsAt: w.reset_at ? w.reset_at * 1000 : undefined,
    }))
  return { windows, plan: body.plan_type, seenAt: await $.clock.now(), isLive: true }
}

function lastLimits(text: string): CodexLimits | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (!line.includes('"rate_limits":{')) continue
    try {
      const limits = JSON.parse(line)?.payload?.rate_limits
      if (limits && (limits.primary || limits.secondary)) return limits
    } catch {}
  }
  return undefined
}

async function newestSessionFiles($: EngineInterface, root: string, want: number) {
  const files: { path: string; mtimeMs: number }[] = []
  const dirsDesc = async (path: string) =>
    (await $.fs.list(path)).filter(d => d.kind === 'dir').map(d => d.name).sort().reverse()
  for (const year of await dirsDesc(root)) {
    for (const month of await dirsDesc(`${root}/${year}`)) {
      for (const day of await dirsDesc(`${root}/${year}/${month}`)) {
        const dir = `${root}/${year}/${month}/${day}`
        const logs = (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.jsonl'))
        logs.sort((a, b) => b.mtimeMs - a.mtimeMs)
        for (const f of logs) files.push({ path: `${dir}/${f.name}`, mtimeMs: f.mtimeMs })
        if (files.length >= want) return files.slice(0, want)
      }
    }
  }
  return files
}

async function readTail($: EngineInterface, path: string): Promise<string> {
  try {
    return await $.fs.read(path)
  } catch {
    // Over the 4 MiB read bound: only the end of the log matters.
    const argv = (await isWindows($))
      ? ['powershell', '-NoProfile', '-Command', `Get-Content -LiteralPath '${path.replace(/'/g, "''")}' -Tail 300`]
      : ['tail', '-c', '1000000', path]
    const { stdout } = await $.process.run(argv)
    return stdout
  }
}

// Fallback: the limits the last local Codex session recorded.
async function loadChatGptLocal($: EngineInterface, home: string): Promise<ChatGptSnapshot | undefined> {
  const root = `${home}/.codex/sessions`
  if (!(await $.fs.exists(root))) return undefined
  for (const file of await newestSessionFiles($, root, 5)) {
    const limits = lastLimits(await readTail($, file.path))
    if (!limits) continue
    const windows = [limits.primary, limits.secondary]
      .filter((w): w is CodexWindow => !!w)
      .map(w => ({
        kind: windowLabel(w.window_minutes),
        percentUsed: round1(w.used_percent),
        resetsAt: w.resets_at ? w.resets_at * 1000 : undefined,
      }))
    return { windows, plan: limits.plan_type, seenAt: file.mtimeMs }
  }
  return undefined
}

async function refreshChatGpt($: EngineInterface) {
  const home = await homeDir($)
  if (!home) return
  const shared = await freshShared($, 'chatgpt')
  if (shared) {
    await update($, chatgpt, s => ({ ...s, windows: shared.windows, seenAt: shared.at, isLive: true, note: undefined }))
    return
  }
  if (!(await mayAsk($, 'chatgpt'))) return
  let snap: ChatGptSnapshot
  try {
    snap = await fetchChatGptLive($, home)
  } catch {
    snap = { windows: [], note: 'ChatGPT 暫時查不到（網路？）。' }
  }
  if (snap.windows.length > 0) await writeShared($, 'chatgpt', snap.windows)
  if (snap.windows.length === 0) {
    const local = await loadChatGptLocal($, home).catch(() => undefined)
    if (local) snap = { ...local, note: snap.note }
  }
  await update($, chatgpt, () => snap)
}

// ---------- Drawing ----------

// Filled for what is used; the rest drawn in the same block, dimmed.
function bar(percentUsed: number, width: number): [string, string] {
  const filled = Math.round((Math.min(100, Math.max(0, percentUsed)) / 100) * width)
  return ['█'.repeat(filled), '█'.repeat(width - filled)]
}

function tone(percent: number): string {
  return percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success'
}

function span(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  return `${d > 0 ? `${d}天 ` : ''}${d > 0 || h > 0 ? `${h}小時 ` : ''}${m}分`
}

export async function refreshQuota($: EngineInterface) {
  await Promise.all([refreshClaude($), refreshChatGpt($)])
}

// Called from the plugin's one session.start hook.
export async function startQuota($: EngineInterface) {
  const saved = (await $.store.get(ACCOUNTS_KEY)) as Record<string, AccountReading> | undefined
  // Readings from 0.11.0 were filed under a bare email, which cannot say which seat they were.
  if (saved) await update($, accounts, () => Object.fromEntries(Object.entries(saved).filter(([k]) => k.includes('|'))))
  const usage = await $.session.usage()
  await update($, claude, () => fromMeasure(usage))
  await refreshQuota($)
  $.clock.every(REFRESH_MS, () => {
    void refreshQuota($)
    void update($, tick, n => n + 1)
  })
}

export function registerQuota(on: On) {
  on('session.measure', async ($, e, next) => {
    await update($, claude, s => {
      const measured = fromMeasure(e)
      // A live reading covers every window; the response headers only some.
      return s.isLive ? { ...s, contextPercent: measured.contextPercent, costUsd: measured.costUsd } : measured
    })
    if (e.changed.includes('rateLimits')) void refreshClaude($)

    return next(e)
  })
}

// The AI usage half of the panel.
export async function quotaSection($: EngineInterface, e: RenderInput) {
  const { Box, Text } = $.ui.resolve(e)
  await read($, tick)
  const c = await read($, claude)
  const who = await read($, account)
  const all = await read($, accounts)
  const g = await read($, chatgpt)
  const now = await $.clock.now()
  const width = Math.max(8, Math.min(16, Math.floor((e.viewport?.columns ?? 30) / 2) - 4))
  const others = Object.entries(all).filter(([key]) => key !== who.key)

  const windowRow = (w: QuotaWindow, label: string) => {
    const isPast = w.resetsAt !== undefined && w.resetsAt <= now
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          {label}　<Text bold color={isPast ? 'inactive' : tone(w.percentUsed)}>已用 {w.percentUsed}%</Text>
        </Text>
        <Text>
          <Text color={isPast ? 'inactive' : tone(w.percentUsed)}>{bar(w.percentUsed, width)[0]}</Text>
          <Text color="subtle">{bar(w.percentUsed, width)[1]}</Text>
        </Text>
        {w.resetsAt !== undefined && (
          <Text dimColor>{isPast ? '已重置' : `${span(w.resetsAt - now)}後重置`}</Text>
        )}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text bold color="claude">Claude{who.label ? ` · ${who.label}` : ''}（這個對話的帳號）</Text>
      {c.windows.length === 0 && <Text dimColor>送出一則訊息後就會顯示（僅限訂閱帳號）。</Text>}
      {c.windows.map(w => windowRow(w, LABELS[w.kind] ?? w.kind))}
      {c.contextPercent !== undefined && <Text dimColor>本對話上下文：{c.contextPercent}%</Text>}
      {c.costUsd !== undefined && <Text dimColor>本對話花費：${c.costUsd.toFixed(2)}</Text>}

      {others.map(([key, reading]) => (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="claude">Claude · {reading.label ?? key.split('|')[0]}</Text>
          {reading.windows.map(w => windowRow(w, LABELS[w.kind] ?? w.kind))}
          <Text dimColor>登入這個帳號時記下的，{span(now - reading.seenAt)}前</Text>
        </Box>
      ))}

      <Box marginTop={1} flexDirection="column">
        <Text bold>ChatGPT{g.plan ? `（${g.plan}）` : ''}</Text>
        {g.windows.length === 0 && !g.note && <Text dimColor>查詢中…</Text>}
        {g.windows.map(w => windowRow(w, LABELS[w.kind] ?? w.kind))}
        {g.seenAt !== undefined && !g.isLive && (
          <Text dimColor>取自本機 Codex 紀錄，{span(now - g.seenAt)}前</Text>
        )}
        {g.note && <Text color="warning">{g.note}</Text>}
      </Box>
    </Box>
  )
}
