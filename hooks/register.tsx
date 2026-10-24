import type { Register } from 'claude-code'

import { quotaSection, refreshQuota, registerQuota, startQuota } from './quota.tsx'
import { registerSounds } from './sounds.ts'
import { refreshTodo, registerTodo, startTodo, todoSection } from './todo.tsx'

// One side panel: AI usage on top, today's to-dos beneath; /quota opens it.
// A ding plays when Claude finishes a reply.
const PANE = 'ai-quota-todo'
const TITLE = 'AI 額度 · 待辦'

export const register: Register = on => {
  registerQuota(on)
  registerTodo(on)
  registerSounds(on)

  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await $.command.register({ name: 'quota', description: '打開面板：AI 額度（Claude + ChatGPT）和每日待辦' })
    void $.ui.open({ id: PANE, title: TITLE })
    await Promise.all([startQuota($), startTodo($)])

    return ran
  })

  on('command.run', { command: 'quota' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await Promise.all([refreshQuota($), refreshTodo($)])

    return { text: '已打開並更新面板（AI 額度 + 每日待辦）。' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {await quotaSection($, e)}
        <Box marginTop={1} flexDirection="column">
          {await todoSection($, e)}
        </Box>
      </Box>
    )
  })
}
