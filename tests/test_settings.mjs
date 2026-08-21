import { chromium } from 'playwright';
import { rmSync, mkdirSync } from 'fs';
import path from 'node:path';
import { seedKey } from './seed.mjs';
import { getExtensionIds } from './test_helpers.mjs';

const EXT_PATH = path.resolve(import.meta.dir, '..'); // extension root (tests/ lives inside it)
const UDD = path.resolve(import.meta.dir, 'profile2');

rmSync(UDD, { recursive: true, force: true });
mkdirSync(UDD, { recursive: true });

const context = await chromium.launchPersistentContext(UDD, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'],
  viewport: { width: 1400, height: 900 },
});

const [extId] = await getExtensionIds(context);
console.log('ext id:', extId);

const workspace = await context.newPage();
await workspace.goto('https://example.com/');

const panel = await context.newPage();
panel.on('pageerror', (e) => console.log('[panel pageerror]', e.message));
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
await panel.waitForSelector('#prompt', { timeout: 10000 });
await seedKey(panel); // settings starts closed only once a key exists

// Open settings and change model + key.
const settingsVisible = () => getComputedStyle(document.getElementById('settings')).display !== 'none';
const settingsHidden = () => getComputedStyle(document.getElementById('settings')).display === 'none';

await panel.click('#settingsBtn');
await panel.waitForFunction(settingsVisible, null, { timeout: 5000 });
console.log('settings visible after gear ✓');

// Gear should also close it again.
await panel.click('#settingsBtn');
await panel.waitForFunction(settingsHidden, null, { timeout: 5000 });
console.log('settings hidden after second gear click ✓');

await panel.click('#settingsBtn');
await panel.waitForFunction(settingsVisible, null, { timeout: 5000 });
await panel.fill('#model', 'openrouter/auto');
await panel.fill('#apiKey', process.env.OPENROUTER_API_KEY);
await panel.click('#saveSettings');

// Verify Save visually hid the settings, and the toast appeared.
await panel.waitForFunction(settingsHidden, null, { timeout: 5000 });
console.log('settings hidden after Save ✓');
await panel.waitForFunction(() => !document.getElementById('toast').hidden, null, { timeout: 5000 });
console.log('toast after save:', await panel.textContent('#toast'));

// Reopen to verify persistence.
await panel.click('#settingsBtn');
await panel.waitForFunction(settingsVisible, null, { timeout: 5000 });
console.log('model persisted:', await panel.inputValue('#model'));
console.log('key length persisted:', (await panel.inputValue('#apiKey')).length);

// Test the connection button.
await panel.click('#testConnection');
await panel.waitForFunction(() => {
  const t = document.getElementById('settingsStatus').textContent;
  return t && t !== 'Testing…';
}, null, { timeout: 20000 });
console.log('test connection result:', await panel.textContent('#settingsStatus'));

await panel.click('#settingsBtn'); // close again

// Send "test".
await workspace.bringToFront();
await panel.fill('#prompt', 'test');
await panel.click('#send');

await panel.waitForFunction(() => !document.getElementById('stop').hidden, null, { timeout: 30000 });
console.log('run started ✓');
await panel.waitForFunction(() => document.getElementById('stop').hidden, null, { timeout: 120000 });
console.log('run finished ✓');

const msgs = await panel.$$eval('.msg', (els) => els.map((e) => ({ cls: e.className, text: e.innerText })));
for (const m of msgs) console.log(`\n[${m.cls.replace('msg ', '')}]`, m.text);

await context.close();
