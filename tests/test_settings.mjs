// Deterministic settings test (no real LLM): gear toggle, Save/persist, and
// Test connection against a mock OpenAI-compatible provider — asserting the
// exact request it sends (one POST /chat/completions, unsaved inputs, never
// /models or /key), plus the error path and a run using the saved settings.
import { chromium } from 'playwright';
import { rmSync, mkdirSync } from 'fs';
import path from 'node:path';
import { getExtensionIds, startMock, seedMock, checker, chatMessages } from './test_helpers.mjs';

const EXT_PATH = path.resolve(import.meta.dir, '..'); // extension root (tests/ lives inside it)
const UDD = path.resolve(import.meta.dir, 'profile_settings');

rmSync(UDD, { recursive: true, force: true });
mkdirSync(UDD, { recursive: true });

const mock = await startMock();

const context = await chromium.launchPersistentContext(UDD, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox', '--disable-infobars'],
  viewport: { width: 1400, height: 900 },
});

const { check, done } = checker('settings');

try {
  const [extId] = await getExtensionIds(context);
  if (!extId) throw new Error('No extension loaded');

  const workspace = await context.newPage();
  await workspace.goto(mock.base + '/');

  const panel = await context.newPage();
  panel.on('pageerror', (e) => console.log('[panel pageerror]', e.message));
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await seedMock(panel, mock); // settings starts closed only once a key exists

  // Computed visibility, never the attribute (landmine 3).
  const visible = () => panel.evaluate(() => getComputedStyle(document.getElementById('settings')).display !== 'none');
  const until = async (fn, timeout = 5000) => {
    try { await panel.waitForFunction(fn, null, { timeout }); return true; } catch (e) { return false; }
  };
  const settingsShown = () => getComputedStyle(document.getElementById('settings')).display !== 'none';
  const settingsGone = () => getComputedStyle(document.getElementById('settings')).display === 'none';
  const statusSettled = () => {
    const t = document.getElementById('settingsStatus').textContent;
    return t && t !== 'Testing…';
  };

  check('settings closed on load with a key', !(await visible()));
  await panel.click('#settingsBtn');
  check('gear opens settings', await until(settingsShown));
  await panel.click('#settingsBtn');
  check('gear closes settings', await until(settingsGone));

  // Save + persist.
  await panel.click('#settingsBtn');
  await until(settingsShown);
  check('apiUrl field shows the saved value', (await panel.inputValue('#apiUrl')) === mock.apiUrl, await panel.inputValue('#apiUrl'));
  await panel.fill('#model', 'mock/saved');
  await panel.fill('#apiKey', 'saved-key');
  await panel.click('#saveSettings');
  check('Save hides settings', await until(settingsGone));
  check('Save shows toast', await until(() => !document.getElementById('toast').hidden));
  check('toast text', (await panel.textContent('#toast')) === 'Settings saved ✓', await panel.textContent('#toast'));
  await new Promise((r) => setTimeout(r, 300)); // let save_settings land in storage
  const stored = await panel.evaluate(() => chrome.storage.local.get(['model', 'apiKey', 'apiUrl']));
  check('settings persisted to storage', stored.model === 'mock/saved' && stored.apiKey === 'saved-key' && stored.apiUrl === mock.apiUrl, stored);
  await panel.reload();
  await panel.click('#settingsBtn');
  await until(settingsShown);
  check('settings survive reload',
    (await panel.inputValue('#model')) === 'mock/saved' && (await panel.inputValue('#apiKey')) === 'saved-key',
    { model: await panel.inputValue('#model') });

  // Test connection uses the unsaved inputs and sends exactly one chat request.
  await panel.fill('#model', 'mock/unsaved');
  await panel.fill('#apiKey', 'unsaved-key');
  mock.script.push({ content: 'OK' });
  let mark = mock.requests.length;
  await panel.click('#testConnection');
  await until(statusSettled, 10000);
  check('Test connection succeeds', (await panel.textContent('#settingsStatus')).includes('✓ Connected'), await panel.textContent('#settingsStatus'));
  const sent = mock.requests.slice(mark);
  check('Test connection sends exactly one request', sent.length === 1, sent.map((r) => r.method + ' ' + r.path));
  const t = sent[0] || { headers: {}, body: {} };
  check('…a POST to /chat/completions', t.method === 'POST' && t.path === '/v1/chat/completions', t.method + ' ' + t.path);
  check('…with the unsaved key', t.headers.authorization === 'Bearer unsaved-key', t.headers.authorization);
  check('…and the unsaved model, non-streaming', t.body && t.body.model === 'mock/unsaved' && t.body.stream === false, t.body);
  const after = await panel.evaluate(() => chrome.storage.local.get(['model', 'apiKey']));
  check('Test connection does not save', after.model === 'mock/saved' && after.apiKey === 'saved-key', after);

  // Error path: the provider's error body is surfaced.
  mock.script.push({ status: 401, error: 'mock: invalid key' });
  await panel.click('#testConnection');
  await until(statusSettled, 10000);
  const errStatus = await panel.textContent('#settingsStatus');
  check('Test connection reports provider error', errStatus.startsWith('✗') && errStatus.includes('mock: invalid key'), errStatus);

  // Close without saving, then run: the saved settings are what get used.
  await panel.click('#settingsBtn');
  await until(settingsGone);
  await workspace.bringToFront();
  mock.script.push({ content: 'Hello from mock' });
  mark = mock.llmRequests().length;
  await panel.fill('#prompt', 'test');
  await panel.click('#send');
  await mock.waitLLMRequests(mark + 1);
  await panel.waitForFunction(() => !running, null, { timeout: 15000 });
  const run = mock.llmRequests()[mark];
  check('run uses saved key and model', run.headers.authorization === 'Bearer saved-key' && run.body.model === 'mock/saved',
    { auth: run.headers.authorization, model: run.body.model });
  const chat = await chatMessages(panel);
  check('run shows prompt and answer', chat.length === 2 && chat[0].text === 'test' && chat[1].role === 'assistant' && chat[1].text === 'Hello from mock', chat);

  const offPath = mock.requests.filter((r) => /\/(models|key)$/.test(r.path));
  check('never calls /models or /key', offPath.length === 0, offPath.map((r) => r.path));

  done();
} finally {
  await context.close();
  await mock.close();
}
