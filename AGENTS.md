# AGENTS.md

Guidance for AI agents working on this project. LLMs can already program; these are the landmines.

## What this is

"KKrossfire" — a Chrome Manifest V3 extension: a side-panel chat that controls one browser tab through an agent loop (LLM ↔ tools), using OpenRouter.

## Architecture (stable decisions)

- **Two halves.** `sidepanel.html` / `sidepanel.js` is UI only (chat + settings). `background.js` (service worker) owns the agent loop, tool execution, and all OpenRouter calls.
- **Agent loop.** Call the LLM with tools → execute the returned tool calls in the workspace tab → append results as `tool` messages → repeat until the model replies with plain content (no tool calls) or `MAX_STEPS`. There is no `finish` tool; "no tool calls" *is* the stop signal. Tool results live in `llmMessages`, so the conversation history *is* the memory across navigations. Do not add a separate memory store.
- **Context block.** Every LLM call injects, right after `system` and ahead of the history: "Current tab: URL (title)", a page overview (description, heading outline, counts, nav links from `nav, [role="navigation"]`, suggested main-content selector), and the last 15 visited pages (`PAGE_HISTORY`). The overview is memoized in a module-level `overviewCache` keyed by `tab.url` and recomputed only when the URL changes — that covers first-turn-on-page, `navigate`, back, and manual navigation with no per-turn injection cost and no invalidation hooks in `navigate`/`reset`. `rememberPage` caps the visited-pages trail at `PAGE_HISTORY` and dedupes consecutive same-URL reads, so `extract_text` offsets and same-page tool runs don't churn the context. Content links (e.g. search results) are deliberately *not* in the overview; the model uses `extract_links`. Staleness hole marked `XXX`: a SPA that rewrites content without changing the URL.
- **Memory & prompt caching.** The full `llmMessages` history — every tool result included — is re-sent verbatim on every call; there is no pruning or summarization, so per-turn tokens grow with each step (bounded by `MAX_STEPS` and the ~8000-char `extract_text` cap). Because the context block sits ahead of the history and changes on `navigate`/`extract_text` turns, the cacheable prefix collapses to `system` on those turns. Deliberate: don't drop/shorten tool results to save tokens — cross-page recall is the product; if cost ever matters, the lossless lever is moving the context block to the *end* of the messages array, not compaction.
- **`extract_text` shape.** Defaults to the main content (`article, main, [role="main"], #content`, else `body`) so the ~8000-char cap isn't spent on nav/footer boilerplate; its `offset` param pages past the first chunk when `truncated` is true.
- **`run_js` result capture.** The tool returns the completion value of the last expression, not only an explicit `return`. User code is evaled as a block inside an async IIFE (`return eval('{ ' + code + ' }')`) so bare expressions, IIFEs, and promises resolve, and per-call `let`/`const`/`var` don't leak. A top-level `return` is a parse error, so it safely falls back to an async-IIFE function body (see landmine 1). Bare top-level `await` without `return` is a known gap — use `return await ...`.
- **Streaming.** `callLLMStream` reads the SSE response body, posts each content chunk to the panel as `{type:'delta'}`, and assembles fragmented tool-call deltas into full `tool_calls`. A `{type:'delta_cancel'}` discards the bubble if a preamble was streamed before tool calls. Only the final answer streams; tool steps show as static status lines.
- **Markdown rendering.** The panel's `format()` (`sidepanel.js`) turns assistant text into HTML: `**bold**`, `` `code` ``, and GFM tables. A table is a run of `|`-delimited rows whose second line is a separator (`| --- | :--: | ---: |`, with optional `:` for left/center/right); it renders as `<table>` as soon as the separator appears, so it works mid-stream, supports multiple tables per bubble, and pads ragged/malformed rows to the header width (all cell text HTML-escaped). Requires a leading `|` on rows (no pipe-less GFM). `Copy Markdown` copies raw `content`, so tables stay pasteable as text.
- **Workspace tab.** Pinned to the active tab at session start (first Send / "Reset"); all tools target it. This lets the user switch tabs without confusing the agent. Shown in the panel header. No visual badge marks the workspace; do not add per-tab side-panel sessions without a product decision.
- **State & messaging.** Session state is a module singleton in the SW, mirrored to `chrome.storage.session` (reset `running` to false on cold load). A long-lived `chrome.runtime.connect` port from the panel keeps the SW alive and carries all messages. State carries a `phase` field (`null` | `'llm'` | `'tool'`) that drives the panel's wait indicators.
- **Panel UI.** Settings is a compact gear beside the brand; `Reset` starts a fresh conversation and rebinds the workspace. The prompt stays editable during runs while Send remains disabled, and the prompt is focused when a run finishes. Send clears the prompt optimistically; if the SW can't start the run (closed workspace tab, no active tab) it replies `{type:'restore_prompt', text}` so the panel puts the message back in the input and it survives the following Reset. The header uses a grid so long workspace titles truncate before the controls.
- **Keyboard shortcuts.** Commands are registered in `manifest.json` and handled in `background.js` via `chrome.commands.onCommand`. `Ctrl+Shift+9` / `Cmd+Shift+9` toggles the side panel: if the port is connected the SW posts `{type:'close'}` and the panel calls `window.close()`; otherwise it opens the panel with `chrome.sidePanel.open()`. `Ctrl+Shift+0` / `Cmd+Shift+0` resets the session to the active tab and opens the panel if it was closed.
- **Settings.** `apiKey`, `model`, `apiUrl`, and `systemPrompt` live in `chrome.storage.local`; `config.js` holds defaults (`apiKey` is `''` — no bundled key; the user must set one). `model` defaults to `openrouter/auto`; `apiUrl` defaults to `https://openrouter.ai/api/v1` and is treated as a base URL (the agent appends `/chat/completions`); `systemPrompt` defaults to the built-in browsing prompt and, once saved, is used verbatim — even an empty value overrides the default.
- **The provider is NOT always OpenRouter.** `apiUrl` is any OpenAI-compatible base URL; the default merely happens to be OpenRouter. Never assume OpenRouter-specific behavior in code: no `/key` endpoint, no OpenRouter-only `/models` response fields (e.g. `architecture.input_modalities`), no OpenRouter-specific error bodies. Anything provider-specific must degrade gracefully on generic endpoints.
- **Test connection.** Sends the panel's current (unsaved) inputs to the SW and runs exactly one real `POST {apiUrl}/chat/completions` (`"This is a test. Just say 'OK'."`, `max_tokens: 10`) to validate the key and model on any OpenAI-compatible provider. Do not use `/models` to test the key (OpenRouter serves it tokenless) or `/key` (OpenRouter-specific, absent on generic providers).
- **Auto-scroll.** The chat follows the bottom only while the user is near it (within ~40px) or when forced (initial load, after Send). `scrollBottom()` implements the gate; full re-renders restore the prior `scrollTop` when the user has scrolled up, so streaming chunks and tool-state re-renders don't yank the view. The follow intent lives in an `isFollowing` flag (set true on force-scroll and whenever the user scrolls to the bottom; cleared only on a real scroll-up past the ~40px band), so it survives layout shifts that would otherwise fool a fresh `nearBottom()` probe. This matters because `run_js` attaches `chrome.debugger`, which makes Chrome show the "debugging this browser" infobar; that resizes the panel while preserving `scrollTop` in pixels, so the bottom content drifts and `nearBottom()` silently flips false — disarming the follow for the rest of the run. A `ResizeObserver` on the chat shifts `scrollTop` by the height delta on resize: if `isFollowing`, snap to the absolute bottom; otherwise glue the bottom content (top slides) so a scrolled-up reader's view isn't yanked.
- **Deliberate v1 choices.** Final answer streams; tool steps do not. `run_js` always enabled (no toggle). Chrome-only (Safari has no side-panel API).

## Landmines

1. **`eval` / `new Function` is banned in MV3 — on every page, not just CSP-strict ones.** The isolated world uses the extension's own CSP (`script-src 'self'`, no `unsafe-eval`), and Chrome rejects adding `unsafe-eval` to `content_security_policy.extension_pages`. Injected scripts therefore cannot eval user code anywhere. `run_js` must go through `chrome.debugger` → `Runtime.evaluate` with `allowUnsafeEvalBlockedByCSP: true` (see `runJsViaDebugger()`).
2. **`chrome.debugger` consequences.** Needs the `debugger` permission; shows Chrome's "debugging this browser" infobar while attached (attach/detach per call, always in `finally`); fails if DevTools is already attached to that tab.
3. **`hidden` attribute vs CSS.** A `display: flex` rule silently overrides the `hidden` attribute. Keep the global `[hidden] { display: none !important; }` rule in `sidepanel.html`. When testing show/hide, assert computed visibility, never the attribute.
4. **Chat re-render wipes transient DOM.** The panel re-renders the whole conversation on every state message. Transient feedback (save confirmation, errors) must use the `#toast` element, not appended chat nodes. The typing-dots and streaming-answer bubbles are likewise transient: never stored in `conversation`, but re-created after each render from `phase` + the `streaming` flag.
5. **Search is composed, not a tool.** There is no `search` tool; the default system prompt (editable in Settings) tells the model to `navigate` to `https://html.duckduckgo.com/html/?q=<query>` and read results with `extract_links`/`extract_text`. Always use that HTML endpoint — `duckduckgo.com/?q=` is a JS SPA whose body is empty to `extract_text`. Google was removed: its `/sorry` CAPTCHA bot-blocks datacenter IPs and its `/url?q=` redirects needed bespoke decoding.
6. **`chrome.scripting.executeScript({ func })` serializes the function** via `toString()` — injected functions must be self-contained (no closures over SW variables).
7. **`innerText` on a detached node is `textContent`.** A `cloneNode` of the body is not rendered, so `innerText` on it silently drops `display:none`/layout filtering. To strip boilerplate, scope the read to the main-content element (or walk the live DOM) — never clone-then-`innerText`.
8. **`chrome.sidePanel.open()` must be called synchronously inside the command handler.** The call requires a user gesture; moving it into an async continuation (e.g. after `await resetSession()` or inside `.then()`) causes it to fail silently. Open first, then do async work, or call it synchronously before yielding the event loop.
9. **Side-panel input autofocus on reopen is not reliably achievable from the content script.** Chrome does not transfer focus to the side-panel frame on subsequent opens, and `window.focus()` / `input.focus()` from inside the panel are ignored. The HTML `autofocus` attribute plus first-render JS focus works only for the very first open after the page loads; do not add complexity chasing reopen autofocus.
   - *Failed experiments:* `window.focus()` + `input.focus()` with 50–150ms timeouts, `input.select()`, `document.visibilitychange`, posting `{type:'focus'}` from the service worker on `chrome.runtime.onConnect`, and `requestAnimationFrame`/`setTimeout` delays. None produced reliable focus on subsequent panel opens.
10. **The browser Back/Forward buttons silently skip agent navigations.** When the agent `navigate`s the workspace tab via `chrome.tabs.update`, those entries are created *without user activation*, so Chromium's History Manipulation Intervention (see Links) tags them `should_skip_on_back_forward_ui_ = true`. Symptom: a single Back click does nothing (if every reachable entry is skippable, `CanGoBack()` returns false and the button is enabled-but-inert), yet **holding** the Back button shows all the sites in the long-press dropdown (that path ignores the skip flag). This is a browser security feature, *not* a bug in our code, and `navigateTab` has used `chrome.tabs.update` unchanged since the initial commit. It only affects the Back/Forward **buttons** — the JS `history.back()` / `history.forward()` APIs bypass it, but `chrome.tabs.goBack()` does **not** (it is implemented as a UI navigation and honors the skip). The agent's navigation memory is unaffected: it lives in `llmMessages` + the injected `PAGE_HISTORY`, fully decoupled from browser history — that's why the LLM still "sees" the pages even though your manual Back is dead. Do **not** try to "fix" the real browser Back button; an extension cannot grant synthetic user activation and there is no API to clear the skip flag. If manual back/forward is wanted, inject `history.back()` / `history.forward()` into the workspace tab (bypasses the intervention) — that is also the only correct primitive if a `back`/`forward` agent tool is ever added.

## Testing

For a quick build validation, run:

```bash
bun build background.js --target browser --outdir /tmp/kkiosk-check
```

Harness lives in `/persist/kkrossfire/tests/` (Playwright + Chromium + Xvfb). Run headed under `xvfb-run`:

```bash
cd /persist/kkrossfire/tests

# deterministic run_js cases — no LLM/API key needed
xvfb-run -a node test_runjs_cases.mjs

# deterministic markdown-table rendering — no LLM/API key needed
xvfb-run -a node test_markdown_table.mjs

# LLM-backed tests — need OPENROUTER_API_KEY in tests/.env
xvfb-run -a node test_runjs.mjs

# CSP test — start the fixture first (serves http://127.0.0.1:8099/)
python3 csp_server.py &
xvfb-run -a node test_csp.mjs
```

Other `test_*.mjs` files (`test_settings`, `test_stream`, `test_indicators`) follow the same `node` pattern.

- Tests read the throwaway API key from `OPENROUTER_API_KEY` in `tests/.env` (gitignored); `seed.mjs` (`seedKey`) writes it into extension storage and `test_helpers.mjs` provides `getExtensionIds(context)`.
- `test_runjs_cases.mjs` is deterministic (no LLM): it drives the SW's `run_js` directly via the `{type:'run_js_test', code}` runtime-message hook and asserts the primary eval/fallback paths.
- `test_markdown_table.mjs` is deterministic (no LLM): it opens `sidepanel.html` as a tab and calls the global `format()` directly, asserting on the produced table HTML and the live-DOM mount.
- Load the extension with `--disable-extensions-except=<dir> --load-extension=<dir>` in a `launchPersistentContext`.
- The real side-panel chrome UI can't be driven headlessly; open `chrome-extension://<id>/sidepanel.html` as a tab instead (same `chrome.*` access and message path).
- Unpacked extension ID is deterministic from the absolute path: `sha256(path)` first 32 hex chars, mapped `0–f → a–p`.
- Playwright passes `--disable-infobars`, so the debugger infobar won't appear in tests.

## Links

- Side panel API: https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- Runtime messaging (`chrome.runtime.connect` / `sendMessage`): https://developer.chrome.com/docs/extensions/reference/api/runtime
- CDP `Runtime.evaluate`: https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-evaluate
- Action API: https://developer.chrome.com/docs/extensions/reference/api/action
- Tabs API: https://developer.chrome.com/docs/extensions/reference/api/tabs
- scripting.executeScript: https://developer.chrome.com/docs/extensions/reference/api/scripting
- debugger API: https://developer.chrome.com/docs/extensions/reference/api/debugger
- commands API: https://developer.chrome.com/docs/extensions/reference/api/commands
- MV3 CSP: https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy
- Chromium History Manipulation Intervention (why the Back button skips extension-driven navigations): https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/history_manipulation_intervention.md
- OpenRouter API: https://openrouter.ai/docs/api-reference/overview
- OpenRouter prompt caching: https://openrouter.ai/docs/features/prompt-caching
- Playwright: https://playwright.dev/docs/intro
