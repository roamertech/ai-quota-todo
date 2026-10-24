import { expect, mock, test } from 'claude-code/testing'

const DIR = '/home/u/todo'
const PATH = `${DIR}/2026-10-25.md`
// The engine hands fs hooks absolute host paths (C:\home\u\... on Windows).
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

test('open items first, the field clears after Enter, finished items fold away', async ($, on) => {
  const files: Record<string, string> = {
    [PATH]: '# 2026-10-25 每日待辦\n\n- [ ] 寫企劃\n- [x] 回信\n',
  }
  mock.env(on, { HOME: '/home/u' })
  mock.clock(on, { now: new Date(2026, 9, 25, 9).getTime() })
  mock.store(on)
  on('fs.exists', (_, e) => ({ value: norm(e.path) in files || norm(e.path) === DIR }))
  on('fs.read', (_, e) => (norm(e.path) in files ? { value: files[norm(e.path)] ?? '' } : { deny: 'no such file' }))
  on('fs.write', (_, e) => {
    files[norm(e.path)] = e.text
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('http.fetch', () => ({ deny: 'offline' }))
  on('session.authorize', () => ({ value: undefined }))

  await $.command.run({ command: 'quota', args: '', origin: 'user' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /10\/25（週日）/ }))?.text).toContain('每日待辦')
  expect((await ui.find({ type: 'Text', text: /完成/ }))?.text).toBe('完成 1/2')
  expect(await ui.find({ type: 'Button', text: /回信/ })).toBeUndefined()

  // Enter with no change events before it, as the desktop app may send them late.
  await $.ui.input({ plugin: 'ai-quota-todo', key: 'new-0', text: '買咖啡' })
  expect(files[PATH]).toContain('- [ ] 買咖啡')
  expect(await ui.find({ type: 'Input', key: 'new-0' })).toBeUndefined()
  expect((await ui.find({ type: 'Input', key: 'new-1' }))?.text ?? '').toBe('')

  // ✕ only asks; the item goes on the second press, and 取消 keeps it.
  await $.ui.press({ plugin: 'ai-quota-todo', key: 'remove-4' })
  expect(files[PATH]).toContain('買咖啡')
  await $.ui.press({ plugin: 'ai-quota-todo', key: 'cancel-4' })
  expect(await ui.find({ type: 'Button', key: 'confirm-4' })).toBeUndefined()
  expect(files[PATH]).toContain('買咖啡')
  await $.ui.press({ plugin: 'ai-quota-todo', key: 'remove-4' })
  await $.ui.press({ plugin: 'ai-quota-todo', key: 'confirm-4' })
  expect(files[PATH]).not.toContain('買咖啡')

  await $.ui.press({ plugin: 'ai-quota-todo', key: 'show-done' })
  expect(await ui.find({ type: 'Button', text: /回信/ })).toBeDefined()

  await $.ui.press({ plugin: 'ai-quota-todo', key: 'clear-done' })
  expect(files[PATH]).toContain('回信')
  await $.ui.press({ plugin: 'ai-quota-todo', key: 'confirm-clear' })
  expect(files[PATH]).not.toContain('回信')
  expect(files[PATH]).toContain('- [ ] 寫企劃')
  await ui.unmount()

  for (const surface of ['terminal', 'vscode', 'mobile'] as const) {
    const other = await $.ui.mount({ ...PANE, surface })
    expect((await other.find({ type: 'Text', text: /完成/ }))?.text).toBe('完成 0/1')
    await other.unmount()
  }
})
