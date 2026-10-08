// Deterministic wait-indicator test (no real LLM): the mock provider adds
// fixed latency and a slow run_js, so each phase lasts long enough to observe.
// Asserts the typing dots show during each model wait, the busy spinner during
// the tool, the order llm → tool → llm, and that everything clears at the end.
import { chromium } from 'playwright';
import { rmSync, mkdirSync } from 'fs';
import path from 'node:path';
import { getExtensionIds, startMock, seedMock, checker, chatMessages } from './test_helpers.mjs';

const EXT_PATH = path.resolve(import.meta.dir, '..'); // extension root (tests/ lives inside it)
const UDD = path.resolve(import.meta.dir, 'profile_indicators');

rmSync(UDD, { recursive: true, force: true });
mkdirSync(UDD, { recursive: true });

const mock = await startMock();

const context = await chromium.launchPersistentContext(UDD, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox', '--disable-infobars'],
  viewport: { width: 1400, height: 900 },
});

const { check, done } = checker('indicators');

try {
  const [extId] = await getExtensionIds(context);
  if (!extId) throw new Error('No extension loaded');

  const workspace = await context.newPage();
  await workspace.goto(mock.base + '/');

  const panel = await context.newPage();
  panel.on('pageerror', (e) => console.log('[panel pageerror]', e.message));
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await seedMock(panel, mock);

  mock.script.push(
    { delayMs: 700, tools: [{ id: 'i1', name: 'run_js', args: { code: 'return await new Promise((r) => setTimeout(() => r(document.title), 700))' } }] },
    { delayMs: 700, content: 'The title is Fixture.' },
  );

  // Record indicator transitions as a timeline of distinct states.
  await panel.evaluate(() => {
    window.__timeline = [];
    const snapshot = () => {
      const typing = !!document.querySelector('.msg.typing');
      const busy = !document.getElementById('busy').hidden;
      const state = busy ? 'busy' : typing ? 'typing' : 'none';
      if (window.__timeline[window.__timeline.length - 1] !== state) window.__timeline.push(state);
    };
    snapshot();
    new MutationObserver(snapshot).observe(document.body, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'],
    });
  });

  await workspace.bringToFront();
  await panel.fill('#prompt', 'What is the page title?');
  await panel.click('#send');
  await mock.waitLLMRequests(2);
  await panel.waitForFunction(() => !running, null, { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 200));

  const timeline = await panel.evaluate(() => window.__timeline);
  console.log('timeline:', timeline.join(' → '));
  const seq = timeline.filter((s) => s !== 'none');
  const iTyping = seq.indexOf('typing');
  const iBusy = seq.indexOf('busy', iTyping + 1);
  const iTyping2 = seq.indexOf('typing', iBusy + 1);
  check('typing dots during first model wait', iTyping >= 0, timeline);
  check('busy spinner during the tool', iBusy > iTyping, timeline);
  check('typing dots again during second model wait', iTyping2 > iBusy, timeline);

  const end = await panel.evaluate(() => ({
    typing: !!document.querySelector('.msg.typing'),
    busy: getComputedStyle(document.getElementById('busy')).display !== 'none',
    stop: getComputedStyle(document.getElementById('stop')).display !== 'none',
  }));
  check('indicators and Stop cleared at the end', !end.typing && !end.busy && !end.stop, end);

  const chat = await chatMessages(panel);
  const last = chat[chat.length - 1] || {};
  check('final answer rendered', last.role === 'assistant' && last.text === 'The title is Fixture.', chat);

  done();
} finally {
  await context.close();
  await mock.close();
}
