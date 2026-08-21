import { chromium } from 'playwright';
import { rmSync, mkdirSync } from 'fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { getExtensionIds } from './test_helpers.mjs';

const EXT_PATH = path.resolve(import.meta.dir, '..'); // extension root (tests/ lives inside it)
const UDD = path.resolve(import.meta.dir, 'profile_runjs_cases');

rmSync(UDD, { recursive: true, force: true });
mkdirSync(UDD, { recursive: true });

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

  // Workspace tab with deterministic DOM for the DOM-reading cases.
  const workspace = await context.newPage();
  await workspace.goto('data:text/html,<h1 id="title">Hello</h1><button aria-label="A">A</button><button aria-label="B">B</button><button aria-label="C">C</button>');

  // Open the side panel as a tab (same extension origin, so chrome.* is available).
  const panel = await context.newPage();
  panel.on('pageerror', (e) => console.log('[panel pageerror]', e.message));
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await panel.waitForSelector('#prompt', { timeout: 10000 });

  // Make the workspace the active tab, then Reset so the SW binds its workspace tab id.
  await workspace.bringToFront();
  await panel.evaluate(() => port.postMessage({ type: 'reset' }));
  await new Promise((r) => setTimeout(r, 300));

  async function runJs(code) {
    return await panel.evaluate(async (c) => {
      return await chrome.runtime.sendMessage({ type: 'run_js_test', code: c });
    }, code);
  }

  const cases = [
    // Primary path: the completion value of the last expression is captured.
    { name: 'bare number', code: '1 + 1;', want: { ok: true, result: '2' } },
    { name: 'bare string', code: "'hi'", want: { ok: true, result: '"hi"' } },
    { name: 'sync IIFE result', code: "(() => { const info = []; return JSON.stringify(info); })()", want: { ok: true, result: '"[]"' } },
    { name: 'promise final expression', code: 'Promise.resolve(42)', want: { ok: true, result: '42' } },
    { name: 'async IIFE result', code: '(async () => 42)()', want: { ok: true, result: '42' } },
    { name: 'DOM read', code: "document.querySelectorAll('button').length", want: { ok: true, result: '3' } },
    { name: 'trailing line comment', code: '1 + 1; // comment', want: { ok: true, result: '2' } },

    // let/const/var stay scoped to one call.
    { name: 'const scoping first call', code: 'const x = 5; x * 2;', want: { ok: true, result: '10' } },
    { name: 'const scoping second call', code: 'const x = 9; x * 3;', want: { ok: true, result: '27' } },
    { name: 'var does not leak', code: 'var leakMe = 7; leakMe;', want: { ok: true, result: '7' } },
    { name: 'var scoped to call', code: 'typeof leakMe', want: { ok: true, result: '"undefined"' } },

    // Fallback path: top-level return needs a function body.
    { name: 'top-level return', code: 'return 1 + 1;', want: { ok: true, result: '2' } },
    { name: 'top-level return with var', code: 'var x = 42; return x;', want: { ok: true, result: '42' } },
    { name: 'return await', code: 'return await Promise.resolve(42);', want: { ok: true, result: '42' } },
    { name: 'conditional return', code: 'if (true) { return 9; }', want: { ok: true, result: '9' } },
    { name: 'top-level return trailing comment', code: 'return 1 + 1; // comment', want: { ok: true, result: '2' } },
    // Known gap: bare top-level await runs but its value is not captured.
    { name: 'bare top-level await', code: 'await Promise.resolve(42)', want: { ok: true, result: 'undefined' } },

    // Errors surface with ok:false.
    { name: 'runtime TypeError', code: 'null.foo', want: (r) => r.ok === false && /TypeError/.test(r.error) },
    { name: 'syntax error', code: '1 + )', want: (r) => r.ok === false && /SyntaxError/.test(r.error) },

    // Long results are truncated.
    { name: 'truncation', code: "'x'.repeat(5000)", want: (r) => r.ok === true && r.result.endsWith('…(truncated)') && r.result.length === 4012 },
  ];

  let failed = 0;
  for (const { name, code, want } of cases) {
    const got = await runJs(code);
    const pass = typeof want === 'function' ? want(got) : (got.ok === want.ok && got.result === want.result && got.error === want.error);
    if (pass) {
      console.log('✓', name);
    } else {
      failed++;
      console.log('✗', name, '\n  code:', code, '\n  want:', want, '\n  got:', got);
    }
  }

  console.log(failed === 0 ? '\nAll run_js cases passed.' : `\n${failed} run_js case(s) failed.`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  await context.close();
}
