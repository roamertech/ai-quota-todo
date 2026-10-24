import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderInput } from 'claude-code'

import type { Day, Todo } from '../types'

// One Markdown checklist per day, shared with Codex:
//   ~/todo/2026-10-25.md
//   - [ ] 未完成
//   - [x] 已完成
// The file is the source of truth; the panel re-reads it every few seconds so
// edits from Codex (or by hand) show up, and every change re-reads before writing.

const POLL_MS = 3000
const ITEM = /^(\s*[-*]\s+\[)([ xX])(\]\s?)(.*)$/

const day = atom({ plugin: 'ai-quota-todo', key: 'day' } as const, null as Day | null)
// What the new-item field holds; emptied after Enter so the field clears.
const draft = atom({ plugin: 'ai-quota-todo', key: 'draft' } as const, '')
const showDone = atom({ plugin: 'ai-quota-todo', key: 'showDone' } as const, false)

const pad = (n: number) => String(n).padStart(2, '0')
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

// "2026-10-25" → "10/25（週日）"
function dayLabel(date: string) {
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) return date

  return `${m}/${d}（週${WEEKDAYS[new Date(y, m - 1, d).getDay()]}）`
}

async function today($: EngineInterface) {
  const now = new Date(await $.clock.now())

  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

async function todoDir($: EngineInterface) {
  return `${(await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '~'}/todo`
}

const parse = (text: string): Todo[] =>
  text.split('\n').flatMap((raw, line) => {
    const match = ITEM.exec(raw.replace(/\r$/, ''))

    return match ? [{ line, text: (match[4] ?? '').trim(), isDone: match[2] !== ' ' }] : []
  })

// Creates today's file on first use, carrying over what the latest earlier day left undone.
async function ensureToday($: EngineInterface, dir: string, date: string) {
  const path = `${dir}/${date}.md`
  if (await $.fs.exists(path)) return path

  const earlier = (await $.fs.list(dir).catch(() => []))
    .map(entry => entry.name)
    .filter(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name) && name < `${date}.md`)
    .sort()
    .pop()
  const carried = earlier
    ? parse(await $.fs.read(`${dir}/${earlier}`)).filter(todo => !todo.isDone)
    : []
  const lines = [`# ${date} 每日待辦`, '', ...carried.map(todo => `- [ ] ${todo.text}`)]
  await $.fs.write(path, `${lines.join('\n')}\n`)

  return path
}

export async function refreshTodo($: EngineInterface) {
  try {
    const date = await today($)
    const path = await ensureToday($, await todoDir($), date)
    const todos = parse(await $.fs.read(path))
    const before = await read($, day)
    if (before && before.path === path && !before.error && JSON.stringify(before.todos) === JSON.stringify(todos)) {
      return
    }
    await update($, day, () => ({ date, path, todos }))
  } catch (error) {
    await update($, day, old => ({ date: old?.date ?? '', path: old?.path ?? '', todos: old?.todos ?? [], error: String(error) }))
  }
}

// Re-reads the file, applies `edit` to its lines, writes it back and redraws.
async function editFile($: EngineInterface, edit: (lines: string[]) => string[]) {
  const current = await read($, day)
  if (!current?.path) return
  const lines = (await $.fs.read(current.path)).split('\n')
  await $.fs.write(current.path, edit(lines).join('\n'))
  await refreshTodo($)
}

// The line still holds the item the panel drew, so a concurrent edit by Codex is not clobbered.
const sameItem = (raw: string | undefined, todo: Todo) => {
  const match = raw === undefined ? null : ITEM.exec(raw.replace(/\r$/, ''))

  return match !== null && (match[4] ?? '').trim() === todo.text
}

function toggle($: EngineInterface, todo: Todo) {
  return editFile($, lines =>
    lines.map((raw, i) =>
      i === todo.line && sameItem(raw, todo)
        ? raw.replace(ITEM, (_, a, mark, b, rest) => `${a}${mark === ' ' ? 'x' : ' '}${b}${rest}`)
        : raw,
    ),
  )
}

function remove($: EngineInterface, todo: Todo) {
  return editFile($, lines => lines.filter((raw, i) => !(i === todo.line && sameItem(raw, todo))))
}

function add($: EngineInterface, text: string) {
  return editFile($, lines => {
    const body = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines

    return [...body, `- [ ] ${text}`, '']
  })
}

function clearDone($: EngineInterface, done: Todo[]) {
  return editFile($, lines => lines.filter((raw, i) => !done.some(todo => todo.line === i && sameItem(raw, todo))))
}

async function submit($: EngineInterface, text: string) {
  await update($, draft, () => '')
  const trimmed = text.trim()
  if (trimmed) await add($, trimmed)
}

// Called from the plugin's one session.start hook.
export async function startTodo($: EngineInterface) {
  await refreshTodo($)
  $.clock.every(POLL_MS, () => refreshTodo($))
}

export function registerTodo(on: On) {
  // Lets Claude add or tick items when asked, the same file Codex uses.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const dir = await todoDir($)
    const text =
      `The user's daily to-do list is a Markdown checklist at ${dir}/YYYY-MM-DD.md (one file per local date, ` +
      '"- [ ] item" / "- [x] item"), shared with Codex and shown in a side pane. ' +
      "When the user asks to add, finish or list to-dos, edit today's file, keeping that format."

    return { sections: [...composed.sections, { id: 'daily-todo:file', text, scope: 'session' }] }
  })
}

// The to-do half of the panel: open items, the new-item field, then the
// finished ones folded under a toggle.
export async function todoSection($: EngineInterface, e: RenderInput) {
  const ui = $.ui.resolve(e)
  const { Box, Text, Button } = ui
  // The mobile app draws no field yet.
  const Input = 'Input' in ui ? ui.Input : undefined
  const current = await read($, day)
  const typed = await read($, draft)
  const isShowingDone = await read($, showDone)
  const todos = current?.todos ?? []
  const open = todos.filter(todo => !todo.isDone)
  const done = todos.filter(todo => todo.isDone)

  const row = (todo: Todo) => (
    <Box key={`row-${todo.line}`} flexDirection="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
      <Box flexGrow={1} flexShrink={1}>
        <Button key={`toggle-${todo.line}`} plain onPress={() => toggle($, todo)}>
          {todo.isDone ? '☑' : '☐'} {todo.isDone ? <Text dimColor strikethrough>{todo.text}</Text> : todo.text}
        </Button>
      </Box>
      <Button key={`remove-${todo.line}`} plain dimColor label="✕" onPress={() => remove($, todo)} />
    </Box>
  )

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Text bold>每日待辦 · {current?.date ? dayLabel(current.date) : '…'}</Text>
        <Text dimColor>
          完成 {done.length}/{todos.length}
        </Text>
      </Box>
      {current?.error && (
        <Text color="error">
          讀不到 {current.path}：{current.error}
        </Text>
      )}
      {open.length === 0 && (
        <Text dimColor>{todos.length === 0 ? '今天還沒有待辦，下面輸入一項吧。' : '今天的待辦都完成了。'}</Text>
      )}
      {open.map(row)}
      {Input && (
        <Box marginTop={1}>
          <Input
            key="new"
            placeholder="新增待辦，按 Enter"
            submitLabel="新增"
            value={typed}
            onInput={text => void update($, draft, () => text)}
            onSubmit={text => void submit($, text)}
          />
        </Box>
      )}
      {done.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Button key="show-done" plain dimColor onPress={() => update($, showDone, shown => !shown)}>
              {isShowingDone ? '▾' : '▸'} 已完成 {done.length} 項
            </Button>
            {isShowingDone && <Button key="clear-done" plain dimColor label="清除已完成" onPress={() => clearDone($, done)} />}
          </Box>
          {isShowingDone && done.map(row)}
        </Box>
      )}
    </Box>
  )
}
