# ai-quota-todo

A Claude Code side panel, opened with `/quota`, that shows:

- **AI 額度** — your Claude usage limits (5-hour and weekly, queried live for the signed-in account; other accounts you sign in with are remembered) and your ChatGPT plan limits (queried live with the Codex app's login in `~/.codex/auth.json`, falling back to the last Codex session log). Shown as "已用 X%", with a bar that turns yellow at 70% and red at 90%.
- **每日待辦** — a daily to-do list kept as a Markdown checklist in `~/todo/YYYY-MM-DD.md`, shared with Codex. Unfinished items carry over to the next day. Tick, delete or add items in the panel; Claude can also edit the list when asked.
- **提示音** — a ding when Claude finishes its whole reply (a sad sound if an API error ended it), and a two-note chime when Claude needs you to decide something: a question with options, a plan to approve, a permission prompt. Subagents and replies you stop stay silent.

Usage readings are shared with other tools through `~/.quota-sync/usage.json`, so each API is asked at most every few minutes.

Works on macOS and Windows. The ChatGPT reading needs the Codex app signed in with a ChatGPT account and uses an unofficial endpoint that may change.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install ai-quota-todo --marketplace roamertech/ai-quota-todo
```

(answer `y` to add the marketplace, then pick a scope.)

From a shell:

```bash
claude plugin install ai-quota-todo --marketplace roamertech/ai-quota-todo
```

In the Claude desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `roamertech/ai-quota-todo`, then **Add plugin**.

Then open a new conversation and type `/quota` to open the panel.
