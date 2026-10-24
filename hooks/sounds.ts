import type { EngineInterface, On } from 'claude-code'

// Sounds:
//   ding.wav  Claude finished the whole reply
//   fail.wav  an API error ended the reply
//   ask.wav   Claude is waiting on a decision: a question with options, a plan
//             to approve, a permission prompt, an MCP server asking for input
// Subagents finishing, and replies the user stopped, stay silent.

const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
const ASKING_NOTICES = new Set(['permission_prompt', 'elicitation_dialog'])
// A permission prompt is announced twice (PermissionRequest and Notification).
const QUIET_MS = 3000
let lastAsk = 0

function play($: EngineInterface, asset: string) {
  void $.audio.play({ asset }).catch(() => {})
}

async function askSound($: EngineInterface) {
  const now = await $.clock.now()
  if (now - lastAsk < QUIET_MS) return
  lastAsk = now
  play($, 'sounds/ask.wav')
}

export function registerSounds(on: On) {
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId === undefined && (e.reason === 'answer' || e.reason === 'error')) {
      play($, e.reason === 'answer' ? 'sounds/ding.wav' : 'sounds/fail.wav')
    }

    return done
  })

  // The question shows while the call waits, so the sound plays before it.
  on('tool.call', async ($, e, next) => {
    if (ASKING_TOOLS.has(e.tool)) await askSound($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', async ($, e, next) => {
    await askSound($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    if (ASKING_NOTICES.has(e.notification_type)) await askSound($)

    return next(e)
  }).catch(($, e, next) => next(e))
}
