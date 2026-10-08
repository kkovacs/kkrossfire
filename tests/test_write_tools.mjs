import { chromium } from 'playwright';
import { rmSync, mkdirSync } from 'fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { getExtensionIds } from './test_helpers.mjs';

const EXT_PATH = path.resolve(import.meta.dir, '..'); // extension root (tests/ lives inside it)
const UDD = path.resolve(import.meta.dir, 'profile_write_tools');
const WRITE_FILE_MAX = 1 << 20; // mirror of background.js WRITE_FILE_MAX

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

  // Workspace tab: data: URL (hostname is empty → screenshot falls back to "page").
  const workspace = await context.newPage();
  await workspace.goto('data:text/html,<h1>Tall page</h1><div style="height:3000px"></div>');

  // Open the side panel as a tab (same extension origin, so chrome.* is available).
  const panel = await context.newPage();
  panel.on('pageerror', (e) => console.log('[panel pageerror]', e.message));
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await panel.waitForSelector('#prompt', { timeout: 10000 });

  // Make the workspace the active tab, then Reset so the SW binds its workspace tab id.
  await workspace.bringToFront();
  await panel.evaluate(() => port.postMessage({ type: 'reset' }));
  await new Promise((r) => setTimeout(r, 300));

  async function toolCall(tool, args) {
    return await panel.evaluate(async ({ tool, args }) => {
      return await chrome.runtime.sendMessage({ type: 'tool_test', tool, args });
    }, { tool, args });
  }

  // Confirm a download actually completed (state 'complete', not flagged) via
  // the downloads API, matching by id — Playwright's harness makes Chrome name
  // files with GUIDs, so the row's filename can't be matched by name here.
  async function waitForDownload(downloadId, timeoutMs = 10000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const row = await panel.evaluate(async (id) => {
        const items = await chrome.downloads.search({ id });
        return items[0] || null;
      }, downloadId);
      if (row && (row.state === 'complete' || row.error)) return row;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }

  const cases = [
    // write_file: happy path
    { name: 'write basic md', tool: 'user_write_file', args: { filename: 'tea-notes.md', content: '# Tea\n\nHoney.' },
      want: (r) => r.ok === true && r.downloadedAs === 'tea-notes.md' && r.bytes === 13 && /cannot read/i.test(r.note) },

    // Paths are forbidden: separators flatten, nothing escapes the fixed folder.
    { name: 'path flattening', tool: 'user_write_file', args: { filename: '../../etc/passwd.json', content: '{}' },
      want: (r) => r.ok === true && !r.downloadedAs.includes('/') && /^[A-Za-z0-9._-]+$/.test(r.downloadedAs) },

    // European filenames survive; emoji/whitespace flatten to '_'.
    { name: 'accented chars kept', tool: 'user_write_file', args: { filename: 'café-übersicht.md', content: 'x' },
      want: (r) => r.ok === true && r.downloadedAs === 'café-übersicht.md' },
    { name: 'emoji + spaces flatten', tool: 'user_write_file', args: { filename: 'my 🤯 notes.md', content: 'x' },
      want: (r) => r.ok === true && r.downloadedAs === 'my_notes.md' },
    { name: 'leading dots stripped', tool: 'user_write_file', args: { filename: '...hidden.md', content: 'x' },
      want: (r) => r.ok === true && r.downloadedAs === 'hidden.md' },
    { name: 'missing extension → .md', tool: 'user_write_file', args: { filename: 'export', content: 'x' },
      want: (r) => r.ok === true && r.downloadedAs === 'export.md' },
    { name: 'name capped, ext kept', tool: 'user_write_file', args: { filename: 'x'.repeat(100) + '.txt', content: 'x' },
      want: (r) => r.ok === true && r.downloadedAs === 'x'.repeat(56) + '.txt' },

    // Guardrail: oversized content fails fast, nothing is written.
    { name: 'content over cap rejected', tool: 'user_write_file', args: { filename: 'big.md', content: 'a'.repeat(WRITE_FILE_MAX + 10) },
      want: (r) => r.ok === undefined && /too large/i.test(r.error) },

    // Empty content is a legitimate (tiny) file, not an error.
    { name: 'empty content ok', tool: 'user_write_file', args: { filename: 'empty.md', content: '' },
      want: (r) => r.ok === true && r.bytes === 0 },

    // screenshot: full-page CDP capture downloads a timestamped JPEG.
    { name: 'screenshot downloads', tool: 'user_screenshot', args: {},
      want: (r) => r.ok === true && /^page-\d{8}-\d{6}-\d{3}\.jpeg$/.test(r.downloadedAs) && /cannot/i.test(r.note) },
  ];

  let failed = 0;
  for (const { name, tool, args, want } of cases) {
    const got = await toolCall(tool, args);
    const pass = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    if (pass) {
      console.log('✓', name);
    } else {
      failed++;
      console.log('✗', name, '\n  tool:', tool, '\n  args:', JSON.stringify(args).slice(0, 120), '\n  got:', JSON.stringify(got).slice(0, 300));
    }
  }

  // End-to-end: the two download-producing cases must reach disk as 'complete'
  // and un-flagged, matched by the download id the tools report back.
  const diskChecks = [['tea-notes.md', (await toolCall('user_write_file', { filename: 'tea-disk.md', content: 'disk check' })).downloadId]];
  const shot = await toolCall('user_screenshot', {});
  if (shot.ok) diskChecks.push([shot.downloadedAs, shot.downloadId]);
  else { failed++; console.log('✗ screenshot re-run for disk check:', JSON.stringify(shot).slice(0, 200)); }

  for (const [label, id] of diskChecks) {
    if (id == null) { failed++; console.log('✗ no downloadId for', label); continue; }
    const row = await waitForDownload(id);
    if (row && row.state === 'complete' && row.danger === 'safe') console.log('✓ download complete:', label);
    else { failed++; console.log('✗ download failed/flagged:', label, JSON.stringify(row)); }
  }

  console.log(failed === 0 ? '\nAll write-tools cases passed.' : `\n${failed} write-tools case(s) failed.`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  await context.close();
}
