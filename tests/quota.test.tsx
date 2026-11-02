import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/u'
const SYNC = `${HOME}/.quota-sync/usage.json`
const norm = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
const PANE = {
  plugin: 'ai-quota-todo',
  component: 'Pane',
  requestId: 'ai-quota-todo',
  props: {
    title: 'AI 額度 · 待辦',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const
const NOW = Date.UTC(2026, 10, 2, 14, 45)
const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

test('the seat this session holds is named with its plan, and another seat\'s shared reading is not used', async ($, on) => {
  const files: Record<string, string> = {
    // The last sign-in on this computer was the Max seat; this session runs on the Team seat.
    [`${HOME}/.claude.json`]: JSON.stringify({
      oauthAccount: { emailAddress: 'a@b.com', organizationUuid: 'org-max', organizationName: 'Personal' },
    }),
    // A Max-seat session read its limits a minute ago.
    [SYNC]: JSON.stringify({
      providers: {
        claude: {
          name: 'Claude', account: 'a@b.com|org-max', updated_at: stamp(NOW - 60_000), error: null, note: null,
          windows: [{ label: '本週', used_percent: 35, remaining_percent: 65, resets_at: null }],
        },
      },
    }),
  }
  const asked: string[] = []
  mock.env(on, { HOME, CLAUDE_CODE_USER_EMAIL: 'a@b.com', CLAUDE_CODE_ORGANIZATION_UUID: 'org-team' })
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('fs.exists', (_, e) => ({ value: norm(e.path) in files }))
  on('fs.read', (_, e) => (norm(e.path) in files ? { value: files[norm(e.path)] ?? '' } : { deny: 'no such file' }))
  on('fs.write', (_, e) => {
    files[norm(e.path)] = e.text
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { stdout: '', stderr: '', code: 0 } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.authorize', () => ({ value: { kind: 'bearer', handle: 'h' } }))
  on('http.fetch', (_, e) => {
    asked.push(e.url)
    if (e.url.endsWith('/api/oauth/profile')) {
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ organization: { organization_type: 'claude_team' } }) } }
    }
    if (e.url.endsWith('/api/oauth/usage')) {
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ seven_day: { utilization: 12, resets_at: null } }) } }
    }
    return { deny: 'offline' }
  })

  await $.command.run({ command: 'quota', args: '', origin: 'user' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /這個對話的帳號/ }))?.text).toContain('a@b.com · Team')
  // The Max seat's 35% was not taken; this seat asked for its own.
  expect(asked.some(u => u.endsWith('/api/oauth/usage'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /已用 12%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /已用 35%/ })).toBeUndefined()
})

test('planName reads Max tiers', async ($, on) => {
  mock.env(on, { HOME, CLAUDE_CODE_USER_EMAIL: 'a@b.com', CLAUDE_CODE_ORGANIZATION_UUID: 'org-max' })
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.authorize', () => ({ value: { kind: 'bearer', handle: 'h' } }))
  on('http.fetch', (_, e) =>
    e.url.endsWith('/api/oauth/profile')
      ? { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' } }) } }
      : { deny: 'offline' })

  await $.command.run({ command: 'quota', args: '', origin: 'user' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /這個對話的帳號/ }))?.text).toContain('a@b.com · Max 20x')
})
