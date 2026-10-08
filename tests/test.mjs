import { chromium } from 'playwright';
import { rmSync, mkdirSync } from 'fs';
import path from 'node:path';
import { seedKey } from './seed.mjs';
import { getExtensionIds, checker, chatMessages } from './test_helpers.mjs';

const EXT_PATH = path.resolve(import.meta.dir, '..'); // extension root (tests/ lives inside it)
const COMPUTED_ID = 'lahfjinkdcpahcannnghbemolialipfc';
const UDD = path.resolve(import.meta.dir, 'profile');

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

try {
  const ids = await getExtensionIds(context);
  console.log('extension ids found:', ids);
  const extId = ids[0];
  if (!extId) throw new Error('No extension loaded — check launch args');
  if (extId !== COMPUTED_ID) console.log('WARN: computed id', COMPUTED_ID, 'differs from real id', extId);

  // A real web page to act as the workspace tab (the side panel itself must NOT be it).
  const workspace = await context.newPage();
  await workspace.goto('https://example.com/');

  // Open the side panel page as a tab (same origin, full chrome.* access).
  const panel = await context.newPage();
  panel.on('pageerror', (e) => console.log('[panel pageerror]', e.message));
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);

  await panel.waitForSelector('#prompt', { timeout: 10000 });
  console.log('panel title:', await panel.title());

  // Seed the API key from .env into extension storage.
  await seedKey(panel);
  console.log('prompt enabled → API key present ✓');

  const prompt = process.argv[2] ||
    'Go to https://example.com and summarize what the page is about in one sentence.';
  console.log('PROMPT:', prompt);
  await panel.fill('#prompt', prompt);

  // Make the normal page the active tab, so the agent uses IT as the workspace tab.
  await workspace.bringToFront();
  await panel.click('#send');

  // Wait for the run to start (stop button appears), then finish (it disappears).
  await panel.waitForFunction(() => !document.getElementById('stop').hidden, null, { timeout: 30000 });
  console.log('run started ✓');
  await panel.waitForFunction(() => document.getElementById('stop').hidden, null, { timeout: 300000 });
  console.log('run finished ✓');

  const msgs = await chatMessages(panel);
  console.log('\n===== CONVERSATION =====');
  for (const m of msgs) console.log(`\n[${m.role}]`, m.text);
  console.log('\n========================');

  // End-to-end smoke: a real answer, no error lines. Content check only for the default prompt.
  const { check, done } = checker('smoke (LLM)');
  const last = msgs[msgs.length - 1] || {};
  check('ends with an assistant answer', last.role === 'assistant' && last.text.length > 20, last);
  check('no error steps', !msgs.some((m) => m.role === 'step' && /⚠️|Reached max steps/.test(m.text)), msgs);
  if (!process.argv[2]) check('answer is about example.com', /example|domain|illustrat|documentation/i.test(last.text || ''), last);
  done();

  await panel.screenshot({ path: path.resolve(import.meta.dir, 'screenshot.png'), fullPage: true });
  console.log('screenshot saved to ' + path.resolve(import.meta.dir, 'screenshot.png'));
} finally {
  await context.close();
}
