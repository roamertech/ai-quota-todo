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

  // 復原 brings the removed item back.
  expect((await ui.find({ type: 'Button', key: 'undo' }))?.text).toContain('刪除「買咖啡」')
  await $.ui.press({ plugin: 'ai-quota-todo', key: 'undo' })
  expect(files[PATH]).toContain('- [ ] 買咖啡')

  // ✎ turns the row into a field; Enter saves the new wording, 復原 puts the old one back.
  await $.ui.press({ plugin: 'ai-quota-todo', key: 'rename-2' })
  expect((await ui.find({ type: 'Input', key: 'edit-2' }))?.text).toBe('寫企劃')
  await $.ui.input({ plugin: 'ai-quota-todo', key: 'edit-2', text: '寫企劃書' })
  expect(files[PATH]).toContain('- [ ] 寫企劃書')
  expect(await ui.find({ type: 'Input', key: 'edit-2' })).toBeUndefined()
  await $.ui.press({ plugin: 'ai-quota-todo', key: 'undo' })
  expect(files[PATH]).toContain('- [ ] 寫企劃\n')

  await $.ui.press({ plugin: 'ai-quota-todo', key: 'show-done' })
  expect(await ui.find({ type: 'Button', text: /回信/ })).toBeDefined()

  await $.ui.press({ plugin: 'ai-quota-todo', key: 'clear-done' })
  expect(files[PATH]).toContain('回信')
  await $.ui.press({ plugin: 'ai-quota-todo', key: 'confirm-clear' })
  expect(files[PATH]).not.toContain('回信')
  expect(files[PATH]).toContain('- [ ] 寫企劃')

  // An edit made elsewhere since then is not overwritten by 復原.
  files[PATH] = `${files[PATH]}- [ ] 別處加的\n`
  await $.ui.press({ plugin: 'ai-quota-todo', key: 'undo' })
  expect(files[PATH]).not.toContain('回信')
  expect(files[PATH]).toContain('別處加的')
  expect((await ui.find({ type: 'Text', text: /沒有復原/ }))?.text).toContain('別處改過')
  await ui.unmount()

  for (const surface of ['terminal', 'vscode', 'mobile'] as const) {
    const other = await $.ui.mount({ ...PANE, surface })
    expect((await other.find({ type: 'Text', text: /完成/ }))?.text).toBe('完成 0/3')
    await other.unmount()
  }
})

test('items group under their ## / ### heading, a heading folds, new items stay above the headings', async ($, on) => {
  const files: Record<string, string> = {
    [PATH]: [
      '# 2026-10-25 每日待辦',
      '',
      '- [ ] 散的一項',
      '',
      '## 工作快照',
      '說明文字',
      '',
      '### 一、近期',
      '- [ ] 跟進報價',
      '- [ ] 寄簡報',
      '',
      '### 二、等待回覆',
      '- [ ] 等客戶回信',
      '- [x] 已寄出',
      '',
    ].join('\n'),
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

  // The ## heading holds no item of its own, so only the two ### show.
  expect(await ui.find({ type: 'Button', key: 'fold-工作快照' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'fold-一、近期' }))?.text).toContain('2 項')
  expect((await ui.find({ type: 'Button', key: 'fold-二、等待回覆' }))?.text).toContain('1 項')
  expect(await ui.find({ type: 'Button', text: /跟進報價/ })).toBeDefined()

  await $.ui.press({ plugin: 'ai-quota-todo', key: 'fold-一、近期' })
  expect(await ui.find({ type: 'Button', text: /跟進報價/ })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'fold-一、近期' }))?.text).toContain('▸')
  expect(await ui.find({ type: 'Button', text: /等客戶回信/ })).toBeDefined()
  await $.ui.press({ plugin: 'ai-quota-todo', key: 'fold-一、近期' })
  expect(await ui.find({ type: 'Button', text: /跟進報價/ })).toBeDefined()

  await $.ui.input({ plugin: 'ai-quota-todo', key: 'new-0', text: '新的一項' })
  expect(files[PATH]).toContain('- [ ] 散的一項\n- [ ] 新的一項\n\n## 工作快照')
  expect(files[PATH]?.trimEnd().endsWith('- [x] 已寄出')).toBe(true)
  await ui.unmount()
})
