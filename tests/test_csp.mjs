import { chromium } from 'playwright';
import { rmSync, mkdirSync } from 'fs';
import path from 'node:path';
import { seedKey } from './seed.mjs';
import { getExtensionIds } from './test_helpers.mjs';

const EXT_PATH = path.resolve(import.meta.dir, '..'); // extension root (tests/ lives inside it)
const UDD = path.resolve(import.meta.dir, 'profile_csp');

rmSync(UDD, { recursive: true, force: true });
mkdirSync(UDD, { recursive: true });

const context = await chromium.launchPersistentContext(UDD, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'],
  viewport: { width: 1400, height: 900 },
});

const [extId] = await getExtensionIds(context);
console.log('ext id:', extId);

// Workspace tab on the CSP-strict local page.
const workspace = await context.newPage();
await workspace.goto('http://127.0.0.1:8099/');

const panel = await context.newPage();
panel.on('pageerror', (e) => console.log('[panel pageerror]', e.message));
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
await panel.waitForSelector('#prompt', { timeout: 10000 });
await seedKey(panel);

const prompt = "Execute this JavaScript in the page: document.getElementById('b').click(); return document.getElementById('out').innerText;  Then reply with exactly the returned value and nothing else.";
console.log('PROMPT:', prompt);
await panel.fill('#prompt', prompt);
await workspace.bringToFront();
await panel.click('#send');

await panel.waitForFunction(() => !document.getElementById('stop').hidden, null, { timeout: 30000 });
console.log('run started ✓');
await panel.waitForFunction(() => document.getElementById('stop').hidden, null, { timeout: 180000 });
console.log('run finished ✓');

const msgs = await panel.$$eval('.msg', (els) => els.map((e) => ({ cls: e.className, text: e.innerText })));
for (const m of msgs) console.log(`\n[${m.cls.replace('msg ', '')}]`, m.text);

await context.close();
