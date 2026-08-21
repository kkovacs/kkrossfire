import { chromium } from 'playwright';
import { rmSync, mkdirSync } from 'fs';
import path from 'node:path';
import { seedKey } from './seed.mjs';
import { getExtensionIds } from './test_helpers.mjs';

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

  const msgs = await panel.$$eval('.msg', (els) => els.map((e) => ({ cls: e.className, text: e.innerText })));
  console.log('\n===== CONVERSATION =====');
  for (const m of msgs) console.log(`\n[${m.cls.replace('msg ', '')}]`, m.text);
  console.log('\n========================');

  await panel.screenshot({ path: path.resolve(import.meta.dir, 'screenshot.png'), fullPage: true });
  console.log('screenshot saved to ' + path.resolve(import.meta.dir, 'screenshot.png'));
} finally {
  await context.close();
}
