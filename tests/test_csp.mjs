// Deterministic CSP test (no real LLM): run_js must work on a page whose CSP
// blocks eval (landmine 1). The strict fixture page is served by the mock
// server itself, so there is nothing to start by hand.
import { chromium } from 'playwright';
import { rmSync, mkdirSync } from 'fs';
import path from 'node:path';
import { getExtensionIds, startMock, seedMock, checker, chatMessages } from './test_helpers.mjs';

const EXT_PATH = path.resolve(import.meta.dir, '..'); // extension root (tests/ lives inside it)
const UDD = path.resolve(import.meta.dir, 'profile_csp');

rmSync(UDD, { recursive: true, force: true });
mkdirSync(UDD, { recursive: true });

const CSP = { 'Content-Security-Policy': "script-src 'self'" };
const mock = await startMock({
  pages: {
    '/csp': {
      headers: CSP,
      html: `<!doctype html><title>csp-test</title>
<button id="b">click me</button>
<div id="out">before</div>
<script src="/app.js"></script>`,
    },
    '/app.js': {
      headers: { ...CSP, 'Content-Type': 'application/javascript' },
      html: "document.getElementById('b').addEventListener('click', function(){ document.getElementById('out').innerText = 'clicked'; });",
    },
  },
});

const CODE = "document.getElementById('b').click(); return document.getElementById('out').innerText;";

const context = await chromium.launchPersistentContext(UDD, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox', '--disable-infobars'],
  viewport: { width: 1400, height: 900 },
});

const { check, done } = checker('CSP');

try {
  const [extId] = await getExtensionIds(context);
  if (!extId) throw new Error('No extension loaded');

  const workspace = await context.newPage();
  const resp = await workspace.goto(mock.base + '/csp');
  check('fixture sends strict CSP', resp.headers()['content-security-policy'] === "script-src 'self'", resp.headers());
  // Playwright's evaluate bypasses page CSP, so probe enforcement with an inline
  // <script> (blocked by the same script-src as eval) instead of calling eval here.
  const inlineRan = await workspace.evaluate(async () => {
    const el = document.createElement('script');
    el.textContent = 'window.__inlineRan = true';
    document.head.append(el);
    await new Promise((r) => setTimeout(r, 50));
    return !!window.__inlineRan;
  });
  check('fixture CSP is enforced (inline script blocked)', inlineRan === false, inlineRan);

  const panel = await context.newPage();
  panel.on('pageerror', (e) => console.log('[panel pageerror]', e.message));
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await seedMock(panel, mock);
  await workspace.bringToFront();
  await panel.evaluate(() => port.postMessage({ type: 'reset' }));
  await new Promise((r) => setTimeout(r, 300));

  // 1) run_js directly through the SW hook.
  const direct = await panel.evaluate((c) => chrome.runtime.sendMessage({ type: 'run_js_test', code: c }), CODE);
  check('run_js works under strict CSP', direct.ok && JSON.parse(direct.result) === 'clicked', direct);

  // 2) The same through the full agent loop: model asks for run_js, sees the result.
  await workspace.reload();
  mock.script.push(
    { tools: [{ id: 'c1', name: 'run_js', args: { code: CODE } }] },
    { content: 'clicked' },
  );
  await panel.evaluate(() => port.postMessage({ type: 'run', text: 'click it' }));
  await mock.waitLLMRequests(2);
  await panel.waitForFunction(() => !running, null, { timeout: 30000 });
  const toolMsg = mock.llmRequests()[1].body.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c1');
  check('agent loop gets run_js result', !!toolMsg && /clicked/.test(toolMsg.content), toolMsg);
  const chat = await chatMessages(panel);
  check('chat shows run_js step', chat.some((m) => m.role === 'step' && /Running JavaScript/.test(m.text)), chat);
  check('chat shows final answer', chat.length > 0 && chat[chat.length - 1].role === 'assistant' && chat[chat.length - 1].text === 'clicked', chat);

  done();
} finally {
  await context.close();
  await mock.close();
}
