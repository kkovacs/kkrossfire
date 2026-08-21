// Markdown-table rendering: deterministic (no LLM / API key needed).
// sidepanel.js defines format() as a classic-script global; we call it
// directly in the panel page and assert on the produced HTML + live DOM.

import { chromium } from 'playwright';
import { rmSync, mkdirSync } from 'fs';
import path from 'node:path';
import { getExtensionIds } from './test_helpers.mjs';

const EXT_PATH = path.resolve(import.meta.dir, '..'); // extension root (tests/ lives inside it)
const UDD = path.resolve(import.meta.dir, 'profile_markdown_table');

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

  const panel = await context.newPage();
  panel.on('pageerror', (e) => console.log('[panel pageerror]', e.message));
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await panel.waitForSelector('#prompt', { timeout: 10000 }); // scripts loaded → format() global exists

  // format() is a global in the panel page; run it in-page.
  async function fmt(text) {
    return await panel.evaluate((t) => format(t), text);
  }
  const count = (s, sub) => s.split(sub).length - 1;

  const cases = [
    {
      name: 'basic table renders <table> with header + body',
      input: `| A | B |\n| --- | --- |\n| 1 | 2 |`,
      check: (h) =>
        h.includes('<table>') &&
        h.includes('<thead>') && h.includes('<th>A</th>') && h.includes('<th>B</th>') &&
        h.includes('<tbody>') && h.includes('<td>1</td>') && h.includes('<td>2</td>') &&
        count(h, '</th>') === 2 && count(h, '</td>') === 2,
    },
    {
      name: 'column alignment maps to text-align',
      input: `| L | C | R |\n| :-- | :--: | --: |\n| a | b | c |`,
      check: (h) =>
        h.includes('<th style="text-align:left">L</th>') &&
        h.includes('<th style="text-align:center">C</th>') &&
        h.includes('<th style="text-align:right">R</th>'),
    },
    {
      name: 'multiple tables in one bubble',
      input: `text before

| h1 | h2 |
| --- | --- |
| 1 | 2 |

text between

| a | b |
| --- | --- |
| 3 | 4 |

text after`,
      check: (h) =>
        count(h, '<table>') === 2 &&
        h.includes('text before') && h.includes('text between') && h.includes('text after') &&
        h.indexOf('text between') > h.indexOf('<table>') &&
        h.indexOf('text between') < h.lastIndexOf('<table>'),
    },
    {
      name: 'partial (header only, no separator) stays literal',
      input: `| a | b |\n| 1 | 2 |`,
      check: (h) => !h.includes('<table>') && h.includes('| a | b |'),
    },
    {
      name: 'prose with pipes but no separator is not a table',
      input: `pick a | b or c`,
      check: (h) => !h.includes('<table>') && h.includes('pick a | b or c'),
    },
    {
      name: 'malformed ragged rows pad to header width',
      input: `| h1 | h2 | h3 |\n| --- | --- |\n| only one |\n| a | b | c |`,
      check: (h) =>
        count(h, '<table>') === 1 &&
        count(h, '</th>') === 3 &&
        h.includes('<td>only one</td>') && h.includes('<td></td>'),
    },
    {
      name: 'html in cells is escaped (no injection)',
      input: `| x |\n| --- |\n| <img src=x onerror=alert(1)> |`,
      check: (h) => h.includes('&lt;img src=x onerror=alert(1)&gt;') && !h.includes('<img'),
    },
    {
      name: 'inline bold + code render inside cells',
      input: `| a | b |\n| --- | --- |\n| **bold** | \`code\` |`,
      check: (h) => h.includes('<td><b>bold</b></td>') && h.includes('<td><code>code</code></td>'),
    },
  ];

  let failed = 0;
  for (const { name, input, check } of cases) {
    const html = await fmt(input);
    let pass = false, err;
    try { pass = check(html); } catch (e) { err = e; }
    if (pass) {
      console.log('✓', name);
    } else {
      failed++;
      console.log('✗', name, '\n  html:', html, err ? '\n  ' + err.message : '');
    }
  }

  // DOM integration: output must mount as a real <table> inside .tableWrap,
  // and column count + alignment must survive into the live DOM (CSS contract).
  const domOk = await panel.evaluate(() => {
    const md = `| L | C | R |\n| :-- | :--: | --: |\n| a | b | c |`;
    const div = document.createElement('div');
    div.className = 'msg assistant';
    div.innerHTML = format(md);
    document.body.appendChild(div);
    const table = div.querySelector('.tableWrap table');
    const wraps = div.querySelectorAll('.tableWrap').length;
    const ths = div.querySelectorAll('thead th');
    const aligns = [...ths].map((th) => th.style.textAlign);
    div.remove();
    return !!table && wraps === 1 && ths.length === 3 &&
      aligns[0] === 'left' && aligns[1] === 'center' && aligns[2] === 'right';
  });
  if (domOk) {
    console.log('✓ dom integration (table mounts in .tableWrap, 3 cols, alignment applied)');
  } else {
    failed++;
    console.log('✗ dom integration');
  }

  console.log(failed === 0 ? '\nAll markdown-table cases passed.' : `\n${failed} markdown-table case(s) failed.`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  await context.close();
}
