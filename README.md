# KKrossfire

🧨 THIS IS EXTREMELY DANGEROUS. ONLY USE IF YOU KNOW WHAT YOU ARE DOING. 💥

A Chrome extension that gives AI full control (!) of a browser tab.

An AI that browses the web for you. Ask it to research, compare, or look something up — it drives one browser tab on its own and comes back with an answer.

Inspired by [badlogic's Sitegeist](https://github.com/badlogic/sitegeist), but simpler.

## Setup

1. Load the folder as an unpacked extension (`chrome://extensions` → Developer mode → **Load unpacked**).
2. Open the panel (toolbar icon, or `Ctrl+Shift+0` / `Cmd+Shift+0`).
3. Click the gear and paste any OpenAI-compatible API URL + KEY.

That's it. The model and API endpoint default to OpenRouter; point the endpoint at any OpenAI-compatible server if you prefer.

## Use

- Type what you want done. Hit **Send**.
- The AI pins the current tab as its workspace and does the legwork there — searches, opens pages, reads them.
- The final answer streams in as it's written; tool steps show as plain status lines.
- **Reset** starts a fresh conversation and rebinds the workspace to whichever tab is active.
- Hover a user message to delete it and everything after it; hover an assistant message to copy its Markdown.
- No history.

Web search isn't a special tool — the AI just browses. For text already in the open page, it can use `find_in_page`, which returns matching text and a CSS selector for where it was found. Tell it to "find the best noise-cancelling headphones under $200 and compare the top three" and it will.

## How it works

- **Two halves.** The side panel is pure UI. A background service worker runs the loop: call the LLM with tools → run the tool calls in the workspace tab → feed results back → repeat until the model answers.
- **Memory is the conversation.** Every page it read and every result is kept in the message history, so it can recall things across pages.
- **It can run code.** Tool calls can execute JavaScript in the tab via Chrome's debugger protocol, so it can fill forms, click around, and extract data — not just read text. The tool returns the value of the last expression (or an explicit `return`).
