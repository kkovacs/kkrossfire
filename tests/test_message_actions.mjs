import { chromium } from 'playwright';
import { rmSync, mkdirSync } from 'fs';
import path from 'node:path';
import { getExtensionIds } from './test_helpers.mjs';

const EXT_PATH = path.resolve(import.meta.dir, '..');
const UDD = path.resolve(import.meta.dir, 'profile_message_actions');

rmSync(UDD, { recursive: true, force: true });
mkdirSync(UDD, { recursive: true });

const context = await chromium.launchPersistentContext(UDD, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    '--no-sandbox',
  ],
  viewport: { width: 1400, height: 900 },
});

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

try {
  const [extId] = await getExtensionIds(context);
  if (!extId) throw new Error('No extension loaded');

  // Seed a complete multi-turn history before the panel connects. Goes
  // through the SW's set_state hook (rather than writing storage.session
  // directly) because the SW caches state at module load and an external
  // write is shadowed by the cached value seen on get_state.
  const seed = await context.newPage();
  await seed.goto(`chrome-extension://${extId}/manifest.json`);
  await seed.evaluate(async () => {
    await chrome.storage.local.set({ apiKey: 'test-key' });
    await chrome.runtime.sendMessage({ type: 'set_state', state: {
      conversation: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: '**first answer**' },
        { role: 'step', content: 'Used a tool.' },
        { role: 'user', content: 'second question' },
        { role: 'assistant', content: '[second answer](https://example.com)' },
        { role: 'user', content: 'third question' },
        { role: 'assistant', content: 'third answer' },
      ],
      llmMessages: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: '**first answer**' },
        { role: 'user', content: 'second question' },
        { role: 'assistant', content: '[second answer](https://example.com)' },
        { role: 'user', content: 'third question' },
        { role: 'assistant', content: 'third answer' },
      ],
      pages: [], workspaceTabId: null, running: false, stop: false, step: 0, phase: null,
    } });
  });
  await seed.close();

  const panel = await context.newPage();
  panel.on('pageerror', (e) => console.log('[panel pageerror]', e.message));
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await panel.waitForFunction(() => document.querySelectorAll('.msg.user').length === 3, null, { timeout: 15000 });

  const userActions = panel.locator('.msg.user .msgActions button');
  const assistantActions = panel.locator('.msg.assistant .msgActions button');
  assert(await userActions.count() === 3, 'Each user message should have one delete button');
  assert(await assistantActions.count() === 3, 'Each assistant message should have one copy button');
  assert(await panel.locator('.msg.step .msgActions').count() === 0, 'Tool steps should have no actions');
  assert(await userActions.first().getAttribute('aria-label') === 'Delete from here', 'User action should delete');
  assert(await assistantActions.first().getAttribute('aria-label') === 'Copy Markdown', 'Assistant action should copy Markdown');
  assert(await panel.locator('.msg.user').first().evaluate((el) => getComputedStyle(el).paddingRight) === '10px', 'Bubbles should not reserve hidden action space');

  const assistant = panel.locator('.msg.assistant').first();
  const assistantAction = assistant.locator('.msgActions');
  assert(await assistantAction.evaluate((el) => getComputedStyle(el).opacity) === '0', 'Actions should start hidden');
  await assistant.hover();
  await panel.waitForFunction(() => {
    const el = document.querySelector('.msg.assistant .msgActions');
    return el && getComputedStyle(el).opacity === '1';
  }, null, { timeout: 1000 });

  // Verify the copy action uses the original Markdown, not rendered innerText.
  await panel.evaluate(() => {
    window.__copied = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => { window.__copied = text; } },
    });
  });
  await assistantActions.first().click();
  const copied = await panel.evaluate(() => window.__copied);
  assert(copied === '**first answer**', 'Copy should preserve Markdown source');

  // Deleting the middle user turn must remove that turn and all later history.
  const middleUser = panel.locator('.msg.user').nth(1);
  await middleUser.hover();
  await middleUser.locator('.msgActions button').click();
  await panel.waitForFunction(() => document.querySelectorAll('.msg.user').length === 1, null, { timeout: 5000 });
  const remaining = await panel.$$eval('.msg', (els) => els.map((el) => {
    const copy = el.cloneNode(true);
    copy.querySelector('.msgActions')?.remove();
    return copy.textContent.trim();
  }));
  assert(remaining.includes('first question'), 'Earlier history should remain');
  assert(!remaining.includes('second question') && !remaining.includes('third question'), 'Clicked and later turns should be removed');
  assert(!remaining.includes('second answer') && !remaining.includes('third answer'), 'Later assistant messages should be removed');

  const stored = await panel.evaluate(async () => (await chrome.storage.session.get('state')).state);
  assert(stored.conversation.length === 3, 'Conversation state should be truncated');
  assert(stored.llmMessages.length === 2, 'LLM history should be truncated at the matching user turn');

  console.log('\nMESSAGE ACTIONS TEST PASSED ✓');
  process.exitCode = 0;
} catch (e) {
  console.error('\nMESSAGE ACTIONS TEST FAILED ✗', e);
  process.exitCode = 1;
} finally {
  await context.close();
}
