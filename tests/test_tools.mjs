import { chromium } from 'playwright';
import { rmSync, mkdirSync } from 'fs';
import http from 'node:http';
import path from 'node:path';
import { getExtensionIds } from './test_helpers.mjs';

const EXT_PATH = path.resolve(import.meta.dir, '..'); // extension root (tests/ lives inside it)
const UDD = path.resolve(import.meta.dir, 'profile_tools');

rmSync(UDD, { recursive: true, force: true });
mkdirSync(UDD, { recursive: true });

// Deterministic workspace DOM: elements that react to click/fill/scroll.
// Served over HTTP because chrome.scripting needs an http(s) host permission;
// data: URLs are not covered by the manifest.
const pageHtml = `
<h1 id="title">Hello</h1>
<p id="policy">Read our <span>cancellation</span> policy</p>
<a id="policy-link" href="#policy-link"><span>View the return policy</span></a>
<div id="hidden" style="display:none">secret cancellation policy</div>
<button id="btn" onclick="document.getElementById('result').textContent='clicked:btn'">Btn</button>
<button class="dup" onclick="document.getElementById('result').textContent='clicked:dup1'">Dup 1</button>
<button class="dup" onclick="document.getElementById('result').textContent='clicked:dup2'">Dup 2</button>
<input id="name" oninput="document.getElementById('result').textContent='input:'+this.value">
<textarea id="bio"></textarea>
<select id="role"><option value="a">A</option><option value="b">B</option></select>
<div id="result"></div>
<div id="tall" style="height:5000px"></div>
<a id="goto" href="/target">go</a>
`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(req.url === '/target' ? "<h1 id='target'>Target</h1>" : pageHtml);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext(UDD, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    '--no-sandbox',
    '--disable-infobars',
  ],
  viewport: { width: 1400, height: 900 },
});

try {
  const [extId] = await getExtensionIds(context);
  if (!extId) throw new Error('No extension loaded — check launch args');

  const workspace = await context.newPage();
  await workspace.goto(BASE + '/');

  const panel = await context.newPage();
  panel.on('pageerror', (e) => console.log('[panel pageerror]', e.message));
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await panel.waitForSelector('#prompt', { timeout: 10000 });

  // Bind the SW's workspace tab to the workspace page.
  await workspace.bringToFront();
  await panel.evaluate(() => port.postMessage({ type: 'reset' }));
  await new Promise((r) => setTimeout(r, 300));

  // run_js via the existing debugger hook, parsed back to a raw value.
  async function runJs(code) {
    return await panel.evaluate(async (c) => {
      return await chrome.runtime.sendMessage({ type: 'run_js_test', code: c });
    }, code);
  }
  async function read(expr) {
    const r = await runJs(expr);
    if (!r.ok) throw new Error('read failed: ' + r.error);
    return JSON.parse(r.result);
  }
  // Drive a tool through the real executeTool dispatch + JSON arg parsing.
  async function tool(name, args) {
    return await panel.evaluate(async ({ n, a }) => {
      return await chrome.runtime.sendMessage({ type: 'tool_test', tool: n, args: a });
    }, { n: name, a: args });
  }

  let failed = 0;
  async function check(name, fn) {
    try {
      const r = await fn();
      if (r === true) console.log('✓', name);
      else { failed++; console.log('✗', name, '\n  got:', typeof r === 'string' ? r : JSON.stringify(r)); }
    } catch (e) {
      failed++; console.log('✗', name, '\n  threw:', e.message);
    }
  }

  // extract_text without an offset must not die on arg serialization (regression).
  await check('extract_text with no args', async () => {
    const r = await tool('extract_text', {});
    return (!r.error && /Hello/.test(r.text || '')) || r;
  });
  await check('extract_text with selector', async () => {
    const r = await tool('extract_text', { selector: '#title' });
    return (!r.error && /Hello/.test(r.text || '')) || r;
  });

  await check('find_in_page returns text and selector', async () => {
    const r = await tool('find_in_page', { query: 'cancellation policy' });
    return (r.count === 1 && r.matches.length === 1
      && r.matches[0].text.toLowerCase() === 'cancellation policy'
      && r.matches[0].selector === '#policy') || r;
  });
  await check('find_in_page prefers actionable ancestor', async () => {
    const r = await tool('find_in_page', { query: 'view the return policy' });
    return (r.count === 1 && r.matches[0].selector === '#policy-link') || r;
  });
  await check('find_in_page ignores hidden text', async () => {
    const r = await tool('find_in_page', { query: 'secret cancellation policy' });
    return (r.count === 0 && r.matches.length === 0) || r;
  });
  await check('find_in_page rejects empty query', async () => {
    const r = await tool('find_in_page', { query: '   ' });
    return /Query is required/.test(r.error || '') || r;
  });

  // scroll (run first so later clicks don't move the scroll position under it).
  await check('scroll down', async () => {
    const r = await tool('scroll', { direction: 'down', pixels: 800 });
    return (r.ok && r.scrollY === 800) || r;
  });
  await check('scroll up', async () => {
    const r = await tool('scroll', { direction: 'up', pixels: 400 });
    return (r.ok && r.scrollY === 400) || r;
  });
  await check('scroll default direction is down', async () => {
    const r = await tool('scroll', { pixels: 200 });
    return (r.ok && r.scrollY === 600) || r;
  });

  // click: selector, index, and the page-side handler actually firing.
  await check('click by selector', async () => {
    const r = await tool('click', { selector: '#btn' });
    if (!(r.ok && r.matches === 1 && r.clicked === 'Btn')) return r;
    const out = await read('document.getElementById("result").textContent');
    return out === 'clicked:btn' || { clicked: r.clicked, out };
  });
  await check('click by index', async () => {
    const r = await tool('click', { selector: '.dup', index: 1 });
    if (!(r.ok && r.matches === 2)) return r;
    const out = await read('document.getElementById("result").textContent');
    return out === 'clicked:dup2' || { clicked: r.clicked, out };
  });
  await check('click missing selector errors', async () => {
    const r = await tool('click', { selector: '#nope' });
    return /No element matches/.test(r.error || '') || r;
  });

  // fill: value lands via the native setter and input events reach page handlers.
  await check('fill text input + input event', async () => {
    const r = await tool('fill', { selector: '#name', value: 'Alice' });
    if (!(r.ok && r.tag === 'input')) return r;
    const v = await read('document.getElementById("name").value');
    const out = await read('document.getElementById("result").textContent');
    return (v === 'Alice' && out === 'input:Alice') || { v, out };
  });
  await check('fill textarea', async () => {
    const r = await tool('fill', { selector: '#bio', value: 'Line1\nLine2' });
    if (!(r.ok && r.tag === 'textarea')) return r;
    const v = await read('document.getElementById("bio").value');
    return v === 'Line1\nLine2' || v;
  });
  await check('fill select', async () => {
    const r = await tool('fill', { selector: '#role', value: 'b' });
    if (!(r.ok && r.tag === 'select')) return r;
    const v = await read('document.getElementById("role").value');
    return v === 'b' || v;
  });
  await check('fill non-fillable errors', async () => {
    const r = await tool('fill', { selector: '#btn', value: 'x' });
    return /Not a fillable field/.test(r.error || '') || r;
  });
  await check('fill missing selector errors', async () => {
    const r = await tool('fill', { selector: '#nope', value: 'x' });
    return /No element matches/.test(r.error || '') || r;
  });

  // click navigation: the tool settles and reports the new URL (must run last).
  await check('click navigates an anchor', async () => {
    const before = workspace.url();
    const r = await tool('click', { selector: '#goto' });
    if (!r.ok) return r;
    try { await workspace.waitForSelector('#target', { timeout: 5000 }); }
    catch (e) { return 'target never appeared (url=' + workspace.url() + ')'; }
    const t = await read('document.getElementById("target").textContent');
    return (r.url !== before && t === 'Target') || { url: r.url, before, t };
  });

  console.log(failed === 0 ? '\nAll tool cases passed.' : `\n${failed} tool case(s) failed.`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  await context.close();
  server.close();
}
