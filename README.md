# ai-quota-todo

A Claude Code side panel, opened with `/quota`, that shows:

- **AI 額度** — your Claude usage limits (5-hour and weekly, queried live for the signed-in account; other accounts you sign in with are remembered) and your ChatGPT plan limits (queried live with the Codex app's login in `~/.codex/auth.json`, falling back to the last Codex session log). Shown as "已用 X%", with a bar that turns yellow at 70% and red at 90%.
- **待辦清單** — one to-do list kept as a Markdown checklist in `~/todo/todo.md`, shared with Codex (on first run it starts from the newest `~/todo/YYYY-MM-DD.md` that versions before 0.11 kept, which stays as it was). Tick, add, reword (✎) or remove (✕, asked twice) items in the panel, group items under the file's `##`/`###` headings (each heading folds, remembered across sessions), fold away finished ones, and undo the panel's last changes with 復原; Claude can also edit the list when asked.
- **提示音** — a ding when Claude finishes its whole reply (a sad sound if an API error ended it), and a two-note chime when Claude needs you to decide something: a question with options, a plan to approve, a publish to confirm, the desktop app's next-step buttons, a permission prompt (a reply that ends on a question chimes instead of dinging). Subagents and replies you stop stay silent.

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
