import { chromium } from 'playwright';
import { rmSync, mkdirSync } from 'fs';
import path from 'node:path';
import { seedKey } from './seed.mjs';
import { getExtensionIds } from './test_helpers.mjs';

const EXT_PATH = path.resolve(import.meta.dir, '..'); // extension root (tests/ lives inside it)
const UDD = path.resolve(import.meta.dir, 'profile_stream');

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

  // A pure-knowledge prompt: no tools needed, answer streams straight away.
  const prompt = 'Explain how a jet engine works, in about 250 words. Answer directly in prose, no lists.';
  await panel.fill('#prompt', prompt);
  await workspace.bringToFront();
  await panel.click('#send');

  // Sample the growing assistant bubble every 60ms until the run ends.
  const samples = [];
  const t0 = Date.now();
  const deadline = t0 + 180000;
  while (Date.now() < deadline) {
    const len = await panel.evaluate(() => {
      const els = document.querySelectorAll('.msg.assistant');
      const last = els[els.length - 1];
      return last ? last.innerText.length : 0;
    });
    samples.push({ t: Date.now() - t0, len });
    const done = await panel.evaluate(() => document.getElementById('stop').hidden);
    if (done && len > 0) break;
    await new Promise((r) => setTimeout(r, 60));
  }

  // Final answer integrity: read the completed message from the re-rendered chat.
  const finalText = await panel.evaluate(() => {
    const els = document.querySelectorAll('.msg.assistant');
    const last = els[els.length - 1];
    return last ? last.innerText : '';
  });

  const lengths = samples.map((s) => s.len);
  const growths = lengths.filter((l, i) => i > 0 && l > lengths[i - 1]).length;

  console.log('samples taken:', samples.length);
  console.log('distinct length values:', new Set(lengths).size);
  console.log('strict-growth events:', growths);
  console.log('first length:', lengths[0], 'last length:', lengths[lengths.length - 1]);
  console.log('final assistant length:', finalText.length);
  console.log('---- first 120 chars ----');
  console.log(finalText.slice(0, 120));

  const ok =
    new Set(lengths).size >= 5 &&      // length changed many times → progressive
    finalText.length > 200 &&          // full answer intact
    finalText.toLowerCase().includes('jet'); // sane content
  console.log(ok ? '\nSTREAMING TEST PASSED ✓' : '\nSTREAMING TEST FAILED ✗');
  process.exitCode = ok ? 0 : 1;
} finally {
  await context.close();
}
