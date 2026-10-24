import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderInput } from 'claude-code'

import type { Change, Day, Todo } from '../types'

// One Markdown checklist per day, shared with Codex:
//   ~/todo/2026-10-25.md
//   - [ ] 未完成
//   - [x] 已完成
// The file is the source of truth; the panel re-reads it every few seconds so
// edits from Codex (or by hand) show up, and every change re-reads before writing.

const POLL_MS = 3000
const ITEM = /^(\s*[-*]\s+\[)([ xX])(\]\s?)(.*)$/

const day = atom({ plugin: 'ai-quota-todo', key: 'day' } as const, null as Day | null)
// Counts items added from the pane. The new-item field's key carries it, so
// each Enter draws a fresh, empty field: the desktop app's typing events can
// arrive after Enter, and a value drawn back would put the text back in.
const entry = atom({ plugin: 'ai-quota-todo', key: 'entry' } as const, 0)
const showDone = atom({ plugin: 'ai-quota-todo', key: 'showDone' } as const, false)
// A remove or a clear waits for a second press: the row (or 'clear-done') asked about.
const confirming = atom({ plugin: 'ai-quota-todo', key: 'confirming' } as const, null as string | null)
const CLEAR_DONE = 'clear-done'
// The row drawn as a field for rewording it, if any.
const editing = atom({ plugin: 'ai-quota-todo', key: 'editing' } as const, null as string | null)

// Each change made from the pane, newest last, for 復原: the file before and
// after it. An undo writes `before` back only while the file still reads `after`.
const HISTORY = 20
const history = atom({ plugin: 'ai-quota-todo', key: 'history' } as const, [] as Change[])
// Why the last 復原 did nothing, until the next change from the pane.
const undoNote = atom({ plugin: 'ai-quota-todo', key: 'undoNote' } as const, '')

const rowId = (todo: Todo) => `${todo.line}:${todo.text}`
const short = (text: string) => (text.length > 12 ? `${text.slice(0, 12)}…` : text)

// Asks about one removal (or none), dropping any rewording in progress.
async function ask($: EngineInterface, id: string | null) {
  await update($, editing, () => null)
  await update($, confirming, () => id)
}

async function startEdit($: EngineInterface, todo: Todo) {
  await ask($, null)
  await update($, editing, () => rowId(todo))
}

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

// Re-reads the file, applies `edit` to its lines, writes it back, keeps the
// change for 復原 under `label`, and redraws.
async function editFile($: EngineInterface, label: string, edit: (lines: string[]) => string[]) {
  const current = await read($, day)
  if (!current?.path) return
  const path = current.path
  const before = await $.fs.read(path)
  const after = edit(before.split('\n')).join('\n')
  await update($, undoNote, () => '')
  if (after === before) return
  await $.fs.write(path, after)
  await update($, history, list => [...list, { path, before, after, label }].slice(-HISTORY))
  await refreshTodo($)
}

async function undo($: EngineInterface) {
  await ask($, null)
  const last = (await read($, history)).at(-1)
  if (!last) return
  await update($, history, list => list.slice(0, -1))
  if ((await $.fs.read(last.path)) !== last.after) {
    await update($, undoNote, () => `沒有復原「${last.label}」：檔案之後在別處改過了。`)
    await refreshTodo($)
    return
  }
  await $.fs.write(last.path, last.before)
  await refreshTodo($)
}

// The line still holds the item the panel drew, so a concurrent edit by Codex is not clobbered.
const sameItem = (raw: string | undefined, todo: Todo) => {
  const match = raw === undefined ? null : ITEM.exec(raw.replace(/\r$/, ''))

  return match !== null && (match[4] ?? '').trim() === todo.text
}

async function toggle($: EngineInterface, todo: Todo) {
  await ask($, null)
  return editFile($, `${todo.isDone ? '取消完成' : '完成'}「${short(todo.text)}」`, lines =>
    lines.map((raw, i) =>
      i === todo.line && sameItem(raw, todo)
        ? raw.replace(ITEM, (_, a, mark, b, rest) => `${a}${mark === ' ' ? 'x' : ' '}${b}${rest}`)
        : raw,
    ),
  )
}

async function remove($: EngineInterface, todo: Todo) {
  await ask($, null)
  return editFile($, `刪除「${short(todo.text)}」`, lines =>
    lines.filter((raw, i) => !(i === todo.line && sameItem(raw, todo))),
  )
}

// Rewords the item, keeping its mark; an emptied field changes nothing.
async function rename($: EngineInterface, todo: Todo, text: string) {
  await ask($, null)
  const trimmed = text.trim()
  if (!trimmed || trimmed === todo.text) return
  return editFile($, `修改「${short(todo.text)}」`, lines =>
    lines.map((raw, i) =>
      i === todo.line && sameItem(raw, todo) ? raw.replace(ITEM, (_, a, mark, b) => `${a}${mark}${b}${trimmed}`) : raw,
    ),
  )
}

function add($: EngineInterface, text: string) {
  return editFile($, `新增「${short(text)}」`, lines => {
    const body = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines

    return [...body, `- [ ] ${text}`, '']
  })
}

async function clearDone($: EngineInterface, done: Todo[]) {
  await ask($, null)
  return editFile($, `清除 ${done.length} 項已完成`, lines =>
    lines.filter((raw, i) => !done.some(todo => todo.line === i && sameItem(raw, todo))),
  )
}

async function submit($: EngineInterface, text: string) {
  await ask($, null)
  await update($, entry, n => n + 1)
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
  const added = await read($, entry)
  const isShowingDone = await read($, showDone)
  const pending = await read($, confirming)
  const rewording = await read($, editing)
  const lastChange = (await read($, history)).at(-1)
  const note = await read($, undoNote)
  const todos = current?.todos ?? []
  const open = todos.filter(todo => !todo.isDone)
  const done = todos.filter(todo => todo.isDone)

  const row = (todo: Todo) =>
    Input && rewording === rowId(todo) ? (
      <Box key={`row-${todo.line}`} flexDirection="row" alignItems="center" gap={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Input
            key={`edit-${todo.line}`}
            value={todo.text}
            submitLabel="儲存"
            autoFocus
            onSubmit={text => void rename($, todo, text)}
          />
        </Box>
        <Button key={`cancel-edit-${todo.line}`} plain dimColor label="取消" onPress={() => ask($, null)} />
      </Box>
    ) : (
      <Box key={`row-${todo.line}`} flexDirection="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Button key={`toggle-${todo.line}`} plain onPress={() => toggle($, todo)}>
            {todo.isDone ? '☑' : '☐'} {todo.isDone ? <Text dimColor strikethrough>{todo.text}</Text> : todo.text}
          </Button>
        </Box>
        {pending === rowId(todo) ? (
          <Box flexDirection="row" gap={1}>
            <Text color="warning">刪除？</Text>
            <Button key={`confirm-${todo.line}`} plain label="確定刪除" onPress={() => remove($, todo)} />
            <Button key={`cancel-${todo.line}`} plain dimColor label="取消" onPress={() => ask($, null)} />
          </Box>
        ) : (
          <Box flexDirection="row" gap={1}>
            {Input && <Button key={`rename-${todo.line}`} plain dimColor label="✎" onPress={() => startEdit($, todo)} />}
            <Button key={`remove-${todo.line}`} plain dimColor label="✕" onPress={() => ask($, rowId(todo))} />
          </Box>
        )}
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
            key={`new-${added}`}
            placeholder="新增待辦，按 Enter"
            submitLabel="新增"
            value=""
            onSubmit={text => void submit($, text)}
          />
        </Box>
      )}
      {lastChange && lastChange.path === current?.path && (
        <Box marginTop={1}>
          <Button key="undo" plain dimColor onPress={() => undo($)}>
            ↶ 復原：{lastChange.label}
          </Button>
        </Box>
      )}
      {note && <Text color="warning">{note}</Text>}
      {done.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Button key="show-done" plain dimColor onPress={() => update($, showDone, shown => !shown)}>
              {isShowingDone ? '▾' : '▸'} 已完成 {done.length} 項
            </Button>
            {isShowingDone &&
              (pending === CLEAR_DONE ? (
                <Box flexDirection="row" gap={1}>
                  <Text color="warning">清除 {done.length} 項？</Text>
                  <Button key="confirm-clear" plain label="確定清除" onPress={() => clearDone($, done)} />
                  <Button key="cancel-clear" plain dimColor label="取消" onPress={() => ask($, null)} />
                </Box>
              ) : (
                <Button key="clear-done" plain dimColor label="清除已完成" onPress={() => ask($, CLEAR_DONE)} />
              ))}
          </Box>
          {isShowingDone && done.map(row)}
        </Box>
      )}
    </Box>
  )
}
