import { chromium } from 'playwright';
import { rmSync, mkdirSync } from 'fs';
import path from 'node:path';
import { seedKey } from './seed.mjs';
import { getExtensionIds } from './test_helpers.mjs';

const EXT_PATH = path.resolve(import.meta.dir, '..'); // extension root (tests/ lives inside it)
const UDD = path.resolve(import.meta.dir, 'profile_indicators');

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
  const extId = ids[0];
  if (!extId) throw new Error('No extension loaded');

  const workspace = await context.newPage();
  await workspace.goto('https://example.com/');

  const panel = await context.newPage();
  panel.on('pageerror', (e) => console.log('[panel pageerror]', e.message));
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await seedKey(panel);

  await panel.fill('#prompt', 'Navigate to https://example.com, then run JavaScript to return the text of the h1 element, then tell me what it says.');
  await workspace.bringToFront();
  // Install transition observers before the run — a 40ms poll misses fast tool
  // phases (run_js can flip #busy visible for under 15ms).
  await panel.evaluate(() => {
    window.__sawTyping = false;
    window.__sawBusy = false;
    const snapshot = () => {
      if (!document.getElementById('busy').hidden) window.__sawBusy = true;
      if (document.querySelector('.msg.typing')) window.__sawTyping = true;
    };
    snapshot();
    new MutationObserver(snapshot).observe(document.body, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'],
    });
  });

  await panel.click('#send');

  // Wait for the run to actually start (Stop button becomes visible), then finish.
  await panel.waitForFunction(() => !document.getElementById('stop').hidden, null, { timeout: 30000 });
  await panel.waitForFunction(() => document.getElementById('stop').hidden, null, { timeout: 180000 });

  const [sawTyping, sawBusy] = await panel.evaluate(() => [window.__sawTyping, window.__sawBusy]);

  const final = await panel.evaluate(() => {
    const els = document.querySelectorAll('.msg.assistant');
    return els.length ? els[els.length - 1].innerText : '';
  });

  console.log('typing dots appeared during LLM wait:', sawTyping);
  console.log('busy spinner appeared during tool run:', sawBusy);
  console.log('final answer length:', final.length);

  const ok = sawTyping && sawBusy && final.length > 20;
  console.log(ok ? '\nINDICATORS TEST PASSED ✓' : '\nINDICATORS TEST FAILED ✗');
  process.exitCode = ok ? 0 : 1;
} finally {
  await context.close();
}
