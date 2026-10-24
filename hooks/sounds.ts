import type { EngineInterface, On } from 'claude-code'

// Sounds:
//   ding.wav  Claude finished the whole reply
//   fail.wav  an API error ended the reply
//   ask.wav   Claude is waiting on a decision: a question with options, a plan
//             to approve, a publish to confirm, the desktop app's next-step
//             buttons, a permission prompt, an MCP server asking for input
// Subagents finishing, and replies the user stopped, stay silent; a reply that
// ends on a question chimes instead of dinging.

const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'PublishPlugin'])
const NEXT_STEP_TOOL = 'mcp__ccd_turn__wrap_up'
// The ding is left out when a chime played this close to the reply's end.
const CHIME_COVERS_MS = 60_000
const ASKING_NOTICES = new Set(['permission_prompt', 'elicitation_dialog'])
// A permission prompt is announced twice (PermissionRequest and Notification).
const QUIET_MS = 3000
let lastAsk = 0

// $.audio.play has no player on Windows, so there PowerShell's SoundPlayer plays the file.
async function play($: EngineInterface, asset: string) {
  if ((await $.env.get('OS')) === 'Windows_NT') {
    const path = `${$.plugin.root}/${asset}`.replace(/'/g, "''")
    await $.process
      .run(['powershell', '-NoProfile', '-Command', `(New-Object System.Media.SoundPlayer '${path}').PlaySync()`])
      .catch(() => {})
    return
  }
  await $.audio.play({ asset }).catch(() => {})
}

async function askSound($: EngineInterface) {
  const now = await $.clock.now()
  if (now - lastAsk < QUIET_MS) return
  lastAsk = now
  void play($, 'sounds/ask.wav')
}

export function registerSounds(on: On) {
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const isChimed = (await $.clock.now()) - lastAsk < CHIME_COVERS_MS

    if (e.agentId === undefined && (e.reason === 'error' || (e.reason === 'answer' && !isChimed))) {
      void play($, e.reason === 'answer' ? 'sounds/ding.wav' : 'sounds/fail.wav')
    }

    return done
  })

  // The question shows while the call waits, so the sound plays before it.
  on('tool.call', async ($, e, next) => {
    const asksNextStep = e.tool === NEXT_STEP_TOOL && Boolean((e as { ask?: unknown }).ask)
    if (ASKING_TOOLS.has(e.tool) || asksNextStep) await askSound($)

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
