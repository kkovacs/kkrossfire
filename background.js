importScripts('config.js');

const MAX_STEPS = 30;
const RUN_JS_TIMEOUT_MS = 15000;
const RUN_JS_CDP_TIMEOUT_MS = RUN_JS_TIMEOUT_MS - 1000; // sync busy-loop watchdog; awaitPromise ignores it
const PAGE_HISTORY = 15; // context reads the last 15 visited pages; cap storage to match
const SETTINGS_KEYS = ['apiKey', 'model', 'apiUrl', 'systemPrompt'];

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Navigate the controlled tab to a URL (http/https only).',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full URL starting with https://' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_text',
      description: 'Extract readable text from the current page, or from an element matching an optional CSS selector. Returns URL, title, and up to ~8000 characters. Pass offset to read past the first chunk when truncated is true.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Optional CSS selector. Defaults to the main content (article/main), else the body.' },
          offset: { type: 'number', description: 'Optional character offset to start from, for paging through long text.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_in_page',
      description: 'Find rendered text in the current page. Returns matching text and a CSS selector for the containing element. Literal, case-insensitive, whitespace-normalized search; results are capped at 10 by default.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to find in the current page.' },
          max_results: { type: 'number', description: 'Optional maximum number of matching elements to return (default 10, maximum 20).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_links',
      description: 'Extract up to 40 links (text + URL) from the current page, optionally scoped to a CSS selector.',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string', description: 'Optional CSS selector to scope the search.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Click an element matching a CSS selector (first match, or pass index). Use for buttons, links, tabs, "load more", closing banners, etc. Prefer this over run_js for any click.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the element to click.' },
          index: { type: 'number', description: 'Optional 0-based match index when the selector matches several elements.' },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fill',
      description: 'Type text into a form field matching a CSS selector. Fires proper input/change events so React/Vue/SPA pages register the value. Works on text inputs, textareas, and selects. Prefer this over run_js.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the field.' },
          value: { type: 'string', description: 'Text to enter.' },
        },
        required: ['selector', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: 'Scroll the page by pixels in a direction ("down" default, or "up"). Returns scroll position and total page height, so you can loop to load lazy/infinite content before reading. Prefer this over run_js.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', description: '"down" (default) or "up".' },
          pixels: { type: 'number', description: 'How many pixels to scroll (default 800).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_js',
      description: 'LAST RESORT: run arbitrary JavaScript in the page. Prefer click, fill, scroll, extract_text, find_in_page, extract_links, and navigate. Use only when no other tool fits (e.g. mutate page state, read a data blob). The result is the value of a bare final expression (e.g. `1 + 1` or an IIFE) or an explicit "return <value>"; use "return await ..." for async values.',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: 'JavaScript to run. The last expression\'s value is returned; use return to return early.' } },
        required: ['code'],
      },
    },
  },
];

// ---- session state (mirrored in storage.session) ----
let port = null;   // side panel connection; also keeps the service worker alive
let state = null;

function freshState() {
  return {
    conversation: [],   // {role:'user'|'assistant'|'step', content} for the UI
    llmMessages: [],    // {role:'user'|'assistant'|'tool', ...} for the LLM
    pages: [],          // visited pages {url,title}
    workspaceTabId: null,
    running: false,
    stop: false,
    step: 0,
    phase: null,        // null | 'llm' (waiting on model) | 'tool' (executing a tool)
  };
}

function post(msg) {
  try { port && port.postMessage(msg); } catch (e) { /* panel closed */ }
}

async function loadSettings() {
  const st = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = (st[k] === undefined) ? DEFAULTS[k] : st[k];
  return out;
}

async function loadState() {
  if (state) return state;
  const st = await chrome.storage.session.get('state');
  state = st.state || freshState();
  if (state.running) { state.running = false; state.phase = null; } // SW restarted mid-run; the loop is dead
  return state;
}

async function saveState() {
  await chrome.storage.session.set({ state });
}

async function commit() {
  await saveState();
  await postState();
}

// Fail a run before it starts: release the claim, surface the error, and put the
// user's prompt back in the input so it survives the next Reset.
async function failStart(s, errorText, promptText) {
  s.running = false;
  post({ type: 'error', text: errorText });
  post({ type: 'restore_prompt', text: promptText });
  await postState();
}

async function getTabInfo(s) {
  if (s.workspaceTabId == null) return null;
  try { return await chrome.tabs.get(s.workspaceTabId); } catch (e) { return null; }
}

async function workspaceAway(s) {
  if (s.workspaceTabId == null) return true;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return !tab || tab.id !== s.workspaceTabId;
}

async function postWorkspaceStatus() {
  const s = await loadState();
  post({
    type: 'workspace_status',
    workspaceTabId: s.workspaceTabId,
    away: await workspaceAway(s),
  });
}

async function postState() {
  const s = await loadState();
  post({
    type: 'state',
    conversation: s.conversation,
    running: s.running,
    phase: s.phase,
    tab: await getTabInfo(s),
    workspaceTabId: s.workspaceTabId,
    workspaceAway: await workspaceAway(s),
    settings: await loadSettings(),
  });
}

async function pushStep(text) {
  const s = await loadState();
  s.phase = 'tool';
  s.conversation.push({ role: 'step', content: text });
  await commit();
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

function waitForLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(listener); resolve(); };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(done, timeoutMs);
  });
}

async function execInTab(tabId, func, args) {
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId }, func, args: args || [] });
    return res[0] ? res[0].result : null;
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// Attach the load listener before initiating navigation to avoid a race.
async function navigateTab(tabId, url, settleMs = 300) {
  const loaded = waitForLoad(tabId);
  await chrome.tabs.update(tabId, { url });
  await loaded;
  await new Promise((r) => setTimeout(r, settleMs));
}

async function ensureWebPage(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:/i.test(tab.url)) {
    await navigateTab(tabId, 'https://duckduckgo.com/');
  }
}

// ---- functions injected into pages (self-contained, serializable) ----
function extractText(sel, offset) {
  // Default to the main content area so the cap isn't spent on nav/footer boilerplate.
  const el = sel ? document.querySelector(sel) : (document.querySelector('article, main, [role="main"], #content') || document.body);
  if (!el) return { error: 'Selector matched nothing: ' + sel };
  const text = (el.innerText || '').replace(/\n{3,}/g, '\n\n');
  const MAX = 8000;
  const start = Math.max(0, (offset | 0) || 0);
  return {
    url: location.href,
    title: document.title,
    text: text.slice(start, start + MAX),
    truncated: text.length > start + MAX,
    totalChars: text.length,
    offset: start,
  };
}

function findInPage(query, maxResults) {
  const q = String(query == null ? '' : query).trim().replace(/\s+/g, ' ');
  if (!q) return { error: 'Query is required.' };
  const lowerQ = q.toLowerCase();
  const limit = Math.min(20, Math.max(1, (maxResults | 0) || 10));
  const actionable = 'a,button,input,textarea,select,label,summary,[role="button"],[role="link"]';
  const ignored = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  const selectorFor = (el) => {
    if (el.id) {
      const id = '#' + CSS.escape(el.id);
      if (document.querySelectorAll(id).length === 1) return id;
    }
    const parts = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      let index = 1;
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.tagName === node.tagName) index++;
      }
      part += ':nth-of-type(' + index + ')';
      parts.unshift(part);
      const selector = parts.join(' > ');
      if (document.querySelectorAll(selector).length === 1) return selector;
      if (node === document.body) break;
    }
    return parts.join(' > ');
  };
  const occurrences = (text) => {
    const lowerText = text.toLowerCase();
    let count = 0;
    let at = 0;
    while ((at = lowerText.indexOf(lowerQ, at)) !== -1) { count++; at += lowerQ.length; }
    return count;
  };
  const snippet = (text, at) => {
    const start = Math.max(0, at - 80);
    const end = Math.min(text.length, at + q.length + 80);
    return (start ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
  };
  const matches = [];
  const seen = new Set();
  let count = 0;
  const elements = [document.body, ...document.body.querySelectorAll('*')];
  for (const el of elements) {
    if (!el || ignored.has(el.tagName) || !visible(el)) continue;
    const text = normalize(el.innerText);
    const at = text.toLowerCase().indexOf(lowerQ);
    if (at < 0) continue;
    // Keep the smallest matching element unless the phrase spans child elements.
    let childMatches = false;
    for (const child of el.children) {
      if (normalize(child.innerText).toLowerCase().includes(lowerQ)) {
        childMatches = true;
        break;
      }
    }
    if (childMatches) continue;
    let target = el;
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (node.matches(actionable)) { target = node; break; }
    }
    if (seen.has(target)) continue;
    seen.add(target);
    const targetText = normalize(target.innerText);
    const targetAt = targetText.toLowerCase().indexOf(lowerQ);
    const found = occurrences(targetText);
    count++;
    if (matches.length < limit) {
      matches.push({
        text: targetText.slice(targetAt, targetAt + q.length),
        snippet: snippet(targetText, targetAt),
        selector: selectorFor(target),
        occurrences: found,
      });
    }
  }
  return {
    url: location.href,
    title: document.title,
    query: q,
    count,
    matches,
    truncated: matches.length < count,
  };
}

function extractLinks(sel) {
  const scope = sel ? document.querySelector(sel) : document;
  if (!scope) return { error: 'Selector matched nothing: ' + sel };
  const seen = new Set();
  const out = [];
  for (const a of scope.querySelectorAll('a[href]')) {
    const href = a.href;
    if (!/^https?:/i.test(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    const text = (a.innerText || a.title || '').trim().replace(/\s+/g, ' ');
    out.push({ text: text.slice(0, 140), href });
    if (out.length >= 40) break;
  }
  return { url: location.href, links: out };
}

// Interaction helpers — self-contained so chrome.scripting.executeScript can serialize them.
function clickElement(sel, index) {
  const els = document.querySelectorAll(sel);
  const el = els[(index | 0) || 0];
  if (!el) return { error: 'No element matches: ' + sel };
  const label = (el.innerText || el.getAttribute('aria-label') || el.title || '').trim().replace(/\s+/g, ' ').slice(0, 100);
  el.scrollIntoView({ block: 'center' });
  el.click();
  return { ok: true, clicked: label, matches: els.length };
}

function fillField(sel, value) {
  const el = document.querySelector(sel);
  if (!el) return { error: 'No element matches: ' + sel };
  const isText = el instanceof HTMLInputElement && !/^(checkbox|radio)$/i.test(el.type || '');
  if (!(isText || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
    return { error: 'Not a fillable field: ' + sel + ' (use click or run_js for checkboxes/radios)' };
  }
  el.scrollIntoView({ block: 'center' });
  // Native value setter + input/change events so React/Vue/SPA pages register the edit.
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, tag: el.tagName.toLowerCase(), value: String(value).slice(0, 120) };
}

function scrollPage(direction, pixels) {
  const amount = (pixels | 0) || 800;
  const dy = direction === 'up' ? -amount : amount;
  const before = window.scrollY;
  window.scrollBy(0, dy);
  return { ok: true, scrolled: window.scrollY - before, scrollY: window.scrollY, viewport: window.innerHeight, pageHeight: document.documentElement.scrollHeight };
}

// Compact page digest for orientation: what the page is and where its nav points.
function getPageOverview() {
  const q = (sel) => document.querySelector(sel);
  let desc = '';
  const md = q('meta[name="description"]');
  if (md && md.content) desc = md.content.trim().slice(0, 300);
  let mainSelector = null;
  for (const sel of ['article', 'main', '[role="main"]', '#content']) {
    if (q(sel)) { mainSelector = sel; break; }
  }
  const headings = [];
  for (const h of document.querySelectorAll('h1,h2,h3')) {
    const t = (h.innerText || '').trim().replace(/\s+/g, ' ');
    if (t) headings.push(h.tagName.toLowerCase() + ' ' + t.slice(0, 80));
    if (headings.length >= 20) break;
  }
  const navLinks = [];
  const seen = new Set();
  for (const scope of document.querySelectorAll('nav, [role="navigation"]')) {
    for (const a of scope.querySelectorAll('a[href]')) {
      const href = a.href;
      if (!/^https?:/i.test(href) || seen.has(href)) continue;
      seen.add(href);
      const text = (a.innerText || a.title || '').trim().replace(/\s+/g, ' ');
      navLinks.push({ text: text.slice(0, 60), href });
      if (navLinks.length >= 20) break;
    }
    if (navLinks.length >= 20) break;
  }
  return {
    url: location.href,
    title: document.title,
    desc,
    mainSelector,
    headings,
    navLinks,
    counts: {
      links: document.querySelectorAll('a[href]').length,
      inputs: document.querySelectorAll('input, textarea, select, button').length,
      tables: document.querySelectorAll('table').length,
      images: document.querySelectorAll('img').length,
    },
    textLen: ((document.body && document.body.innerText) || '').length,
  };
}

// ---- tools ----
async function toolNavigate(s, tabId, url) {
  if (!/^https?:\/\//i.test(url || '')) return { error: 'Only http/https URLs are allowed.' };
  await pushStep('🧭 Navigating to ' + url);
  await navigateTab(tabId, url);
  const tab = await chrome.tabs.get(tabId);
  rememberPage(s, tab.url, tab.title);
  await saveState();
  return { ok: true, url: tab.url, title: tab.title };
}

async function toolExtractText(s, tabId, selector, offset) {
  await pushStep('📄 Reading page' + (selector ? ' (' + selector + ')' : ''));
  const r = await execInTab(tabId, extractText, [selector || null, offset | 0]);
  if (r && r.url && !r.error) { rememberPage(s, r.url, r.title); await saveState(); }
  return r || { error: 'Failed to read page.' };
}

async function toolFindInPage(s, tabId, query, maxResults) {
  await pushStep('🔎 Finding in page');
  const r = await execInTab(tabId, findInPage, [query, maxResults == null ? 0 : maxResults | 0]);
  if (r && r.url && !r.error) { rememberPage(s, r.url, r.title); await saveState(); }
  return r || { error: 'Failed to search page.' };
}

async function toolExtractLinks(s, tabId, selector) {
  await pushStep('🔗 Extracting links' + (selector ? ' (' + selector + ')' : ''));
  const r = await execInTab(tabId, extractLinks, [selector || null]);
  return r || { error: 'Failed to extract links.' };
}

async function toolRunJs(s, tabId, code) {
  await pushStep('⚙️ Running JavaScript in page');
  return runJsViaDebugger(tabId, String(code || ''));
}

async function toolClick(s, tabId, selector, index) {
  await pushStep('🖱️ Clicking ' + selector);
  const before = (await chrome.tabs.get(tabId)).url;
  const r = await execInTab(tabId, clickElement, [selector || null, index | 0]);
  await new Promise((res) => setTimeout(res, 400)); // click may navigate; settle before the next read
  const after = await chrome.tabs.get(tabId);
  if (after.url !== before) { rememberPage(s, after.url, after.title); await saveState(); }
  return { ...(r || {}), url: after.url };
}

async function toolFill(s, tabId, selector, value) {
  await pushStep('⌨️ Filling ' + selector);
  const r = await execInTab(tabId, fillField, [selector || null, value == null ? '' : String(value)]);
  return r || { error: 'Failed to fill field.' };
}

async function toolScroll(s, tabId, direction, pixels) {
  await pushStep('📜 Scrolling ' + (direction || 'down'));
  const r = await execInTab(tabId, scrollPage, [direction || 'down', pixels | 0]);
  return r || { error: 'Failed to scroll.' };
}

// Run arbitrary JS via the DevTools protocol when the page's CSP blocks eval.
async function runJsViaDebugger(tabId, code) {
  let attached = false;
  const TIMEOUT = {};

  // CDP's evaluate timeout kills sync busy-loops, but is ignored while awaiting a promise.
  // The race deadline below covers async hangs; finally detaches to cancel the pending command.
  const evaluate = (expression, replMode = false) => {
    const cmd = chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      allowUnsafeEvalBlockedByCSP: true,
      timeout: RUN_JS_CDP_TIMEOUT_MS,
      replMode,
    });
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), RUN_JS_TIMEOUT_MS);
    });
    return Promise.race([cmd, deadline]).finally(() => clearTimeout(timer));
  };

  // Only these two parse errors mean the primary block wrapper can't run the code and the
  // async-function fallback can. Any other SyntaxError is a real error to surface as-is.
  const needsFunctionFallback = (res) => {
    const d = res && res.exceptionDetails;
    if (!d) return false;
    const text = d.text || '';
    const desc = (d.exception && d.exception.description) || '';
    return /Illegal return statement/.test(text) || /Illegal return statement/.test(desc)
      || /await is only valid in async functions/.test(text) || /await is only valid in async functions/.test(desc);
  };

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
    // Eval the code as a block inside an async IIFE so the block's completion value (the last
    // expression) is returned, while let/const/var stay scoped to this call. `return eval(...)`
    // resolves the IIFE to that value; a top-level `return` is a parse error, so nothing runs
    // and we can safely fall back to a function body.
    const primaryExpr = '(async () => { return eval(' + JSON.stringify('{ ' + code + '\n }') + '); })()';
    let res = await evaluate(primaryExpr);
    if (res === TIMEOUT) return { ok: false, error: 'run_js timed out after ' + RUN_JS_TIMEOUT_MS + 'ms' };
    if (needsFunctionFallback(res)) {
      res = await evaluate('(async () => {\n' + code + '\n})()');
    }
    if (res === TIMEOUT) return { ok: false, error: 'run_js timed out after ' + RUN_JS_TIMEOUT_MS + 'ms' };
    if (res.exceptionDetails) {
      const e = res.exceptionDetails;
      const desc = (e.exception && (e.exception.description || e.exception.value)) || e.text || 'JS error';
      return { ok: false, error: String(desc) };
    }
    const r = res.result || {};
    if (r.subtype === 'error') return { ok: false, error: r.description || 'JS error' };
    let out;
    if (r.value !== undefined) {
      try { out = JSON.stringify(r.value); } catch (e) { out = String(r.value); }
      if (out && out.length > 4000) out = out.slice(0, 4000) + '…(truncated)';
    } else {
      out = r.description || 'undefined';
    }
    return { ok: true, result: out };
  } catch (e) {
    return { ok: false, error: 'Debugger fallback failed: ' + ((e && e.message) || e) };
  } finally {
    if (attached) {
      try { await chrome.debugger.detach({ tabId }); } catch (e) { /* ignore */ }
    }
  }
}

async function executeTool(s, name, argsJson) {
  const tabId = s.workspaceTabId;
  if (tabId == null) return { error: 'No workspace tab.' };
  const args = safeParse(argsJson) || {};
  switch (name) {
    case 'navigate': return toolNavigate(s, tabId, args.url);
    case 'extract_text': return toolExtractText(s, tabId, args.selector, args.offset);
    case 'find_in_page': return toolFindInPage(s, tabId, args.query, args.max_results);
    case 'extract_links': return toolExtractLinks(s, tabId, args.selector);
    case 'click': return toolClick(s, tabId, args.selector, args.index);
    case 'fill': return toolFill(s, tabId, args.selector, args.value);
    case 'scroll': return toolScroll(s, tabId, args.direction, args.pixels);
    case 'run_js': return toolRunJs(s, tabId, args.code);
    default: return { error: 'Unknown tool: ' + name };
  }
}

// ---- LLM ----
let overviewCache = null;   // {url, digest} — memoized page overview, keyed by tab URL

function formatOverview(r) {
  const lines = [];
  if (r.desc) lines.push('Description: ' + r.desc);
  if (r.headings.length) {
    lines.push('Headings:');
    for (const h of r.headings) lines.push('  ' + h);
  }
  lines.push('Counts: ' + r.counts.links + ' links, ' + r.counts.inputs + ' inputs, ' + r.counts.tables + ' tables, ' + r.counts.images + ' images, ~' + r.textLen + ' chars text');
  if (r.mainSelector) lines.push('Main content selector: ' + r.mainSelector);
  if (r.navLinks.length) {
    lines.push('Nav links:');
    for (const l of r.navLinks) lines.push('  ' + l.text + ' — ' + l.href);
  }
  return lines.join('\n');
}

// URL-keyed cache: recompute only when the tab's URL changes (navigate, back, manual nav).
// XXX: goes stale if a SPA rewrites its content without changing the URL.
async function getOverview(tab) {
  if (overviewCache && overviewCache.url === tab.url) return overviewCache.digest;
  let digest = null;
  try {
    const r = await execInTab(tab.id, getPageOverview, []);
    if (r && !r.error) digest = formatOverview(r);
  } catch (e) { /* context is best-effort */ }
  overviewCache = { url: tab.url, digest };   // cache even on failure → no retry loop
  return digest;
}

// Append a visited page, keeping only the most recent PAGE_HISTORY in storage.
function rememberPage(s, url, title) {
  const last = s.pages[s.pages.length - 1];
  if (last && last.url === url) return; // same-URL read adds nothing to the trail
  s.pages.push({ url, title });
  if (s.pages.length > PAGE_HISTORY) s.pages = s.pages.slice(-PAGE_HISTORY);
}

async function buildContext(s, tab) {
  const parts = [];
  if (tab && tab.url) {
    parts.push('Current tab: ' + tab.url + (tab.title ? ' (' + tab.title + ')' : ''));
    const overview = await getOverview(tab);
    if (overview) parts.push('Page overview:\n' + overview);
  } else {
    parts.push('Current tab: (none)');
  }
  if (s.pages.length) {
    parts.push('Pages visited this session:');
    for (const p of s.pages) parts.push('- ' + p.url + (p.title ? ' — ' + p.title : ''));
  }
  return parts.join('\n');
}

// Shared OpenAI-compatible request target: chat URL + auth headers.
function openAiRequest(settings) {
  const base = String(settings.apiUrl || DEFAULTS.apiUrl).replace(/\/+$/, '');
  return {
    url: base + '/chat/completions',
    headers: {
      'Authorization': 'Bearer ' + settings.apiKey,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://kkrossfire.local/',
      'X-Title': 'KKrossfire',
    },
  };
}

// Stream an SSE response, accumulating content and tool-call deltas.
// Returns {content, tool_calls}. onDelta(text) fires per content chunk.
async function callLLMStream(settings, s, onDelta) {
  const tab = await getTabInfo(s);
  const body = {
    model: settings.model,
    messages: [
      { role: 'system', content: settings.systemPrompt },
      { role: 'user', content: await buildContext(s, tab) },
      ...s.llmMessages,
    ],
    tools: TOOLS,
    stream: true,
  };

  const controller = new AbortController();
  const stopTimer = setInterval(() => { if (s.stop) controller.abort(); }, 200);

  let resp;
  try {
    const { url, headers } = openAiRequest(settings);
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearInterval(stopTimer);
    if (s.stop) throw e;
    throw new Error('Could not reach the API (' + ((e && e.message) || e) + '). Check your network/VPN/firewall and that your API URL loads in a normal tab.');
  }
  if (!resp.ok) {
    clearInterval(stopTimer);
    const t = await resp.text();
    throw new Error('API HTTP ' + resp.status + ': ' + t.slice(0, 400));
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  const toolCalls = []; // assembled {id, function:{name, arguments}}

  const processLine = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let obj;
    try { obj = JSON.parse(payload); } catch (e) { return; }
    const delta = obj && obj.choices && obj.choices[0] && obj.choices[0].delta;
    if (!delta) return;
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      if (onDelta) onDelta(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const i = tc.index || 0;
        if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.type) toolCalls[i].type = tc.type;
        if (tc.id) toolCalls[i].id = tc.id;
        if (tc.function) {
          if (tc.function.name) toolCalls[i].function.name += tc.function.name;
          if (tc.function.arguments) toolCalls[i].function.arguments += tc.function.arguments;
        }
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        processLine(line);
      }
    }
    buf += decoder.decode();
    // A final `data:` line may lack a trailing newline (e.g. a stream that ends
    // without a `[DONE]` sentinel). Without this, the last content/arguments
    // fragment would sit unparsed in `buf` and be dropped.
    if (buf.trim()) processLine(buf.trim());
  } finally {
    clearInterval(stopTimer);
  }

  return { content, tool_calls: toolCalls.filter((tc) => tc && tc.function && tc.function.name) };
}

async function finishRun(s, answer, note) {
  if (answer != null && answer.trim() !== '') {
    s.conversation.push({ role: 'assistant', content: answer.trim() });
    s.llmMessages.push({ role: 'assistant', content: answer });
  } else if (note) {
    s.conversation.push({ role: 'step', content: note });
  }
  s.running = false;
  s.phase = null;
  await commit();
}

async function runAgent(prompt) {
  const s = await loadState();
  const settings = await loadSettings();
  if (!settings.apiKey) {
    s.running = false;
    await commit();
    post({ type: 'error', text: 'Set your API key in settings first.' });
    return;
  }
  s.running = true;
  s.stop = false;
  s.step = 0;
  s.phase = 'llm';
  s.conversation.push({ role: 'user', content: prompt });
  s.llmMessages.push({ role: 'user', content: prompt });
  await commit();
  try {
    while (s.step < MAX_STEPS && !s.stop) {
      if (!(await getTabInfo(s))) { // workspace tab closed mid-run → fail fast, don't let the model retry
        await finishRun(s, null, 'Workspace tab was closed.');
        return;
      }
      s.step++;
      s.phase = 'llm';
      await commit();
      const choice = await callLLMStream(settings, s, (chunk) => post({ type: 'delta', text: chunk }));
      if (choice.tool_calls && choice.tool_calls.length) {
        post({ type: 'delta_cancel' }); // discard the streamed bubble; show the text as a static message below
        if (choice.content && choice.content.trim()) {
          s.conversation.push({ role: 'assistant', content: choice.content.trim() });
        }
        s.llmMessages.push({ role: 'assistant', content: choice.content || '', tool_calls: choice.tool_calls });
        for (const tc of choice.tool_calls) {
          if (s.stop) break;
          const result = await executeTool(s, tc.function.name, tc.function.arguments);
          s.llmMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
          await saveState();
        }
      } else {
        const answer = (choice.content || '').trim();
        s.llmMessages.push({ role: 'assistant', content: answer });
        if (answer) await finishRun(s, answer);
        else await finishRun(s, null, '⚠️ Model returned an empty response.');
        return;
      }
    }
    if (s.stop) await finishRun(s, null, 'Stopped.');
    else await finishRun(s, null, 'Reached max steps (' + MAX_STEPS + ').');
  } catch (e) {
    if (s.stop) await finishRun(s, null, 'Stopped.');
    else await finishRun(s, null, '⚠️ Error: ' + ((e && e.message) || e));
  }
}

// ---- messaging with the side panel ----
chrome.runtime.onConnect.addListener((p) => {
  if (p.name !== 'kkrossfire') return;
  port = p;
  p.onDisconnect.addListener(() => { if (port === p) port = null; });
  p.onMessage.addListener(onMessage);
});

// Test hooks: let the Playwright harness exercise run_js and the tool layer
// deterministically without the LLM or an API key.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'run_js_test') {
    loadState()
      .then((s) => {
        if (s.workspaceTabId == null) throw new Error('No workspace tab.');
        return runJsViaDebugger(s.workspaceTabId, String(msg.code || ''));
      })
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async response
  }
  if (msg.type === 'tool_test') {
    loadState()
      .then((s) => executeTool(s, String(msg.tool || ''), JSON.stringify(msg.args || {})))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async response
  }
  if (msg.type === 'set_state') {
    // Test-only hook: replace the SW's in-memory + persisted state with the
    // provided snapshot. Lets the harness seed a conversation fixture without
    // racing the SW's loadState cache (which fires on tabs.onActivated when
    // chrome://extensions is navigated). Do not call from production code.
    state = (msg.state && typeof msg.state === 'object') ? msg.state : freshState();
    saveState()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async response
  }
});

async function resetSession() {
  const s = await loadState();
  s.conversation = [];
  s.llmMessages = [];
  s.pages = [];
  s.stop = true;
  s.phase = null;
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  s.workspaceTabId = t ? t.id : null;
  await commit();
}

async function onMessage(msg) {
  const s = await loadState();
  switch (msg.type) {
    case 'get_state':
      await postState();
      break;
    case 'run': {
      if (s.running) { post({ type: 'error', text: 'Already running.' }); break; }
      s.running = true; // claim synchronously so the guard is atomic across the awaits below
      if (s.workspaceTabId == null) {
        const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
        s.workspaceTabId = t ? t.id : null;
      }
      if (s.workspaceTabId == null) {
        await failStart(s, 'No active tab found.', msg.text);
        break;
      }
      try {
        await ensureWebPage(s.workspaceTabId);
        await saveState();
      } catch (e) {
        const text = String((e && e.message) || e);
        await failStart(s, text.includes('No tab with id')
          ? 'Workspace tab was closed. Click Reset to choose a new tab.'
          : text, msg.text);
        break;
      }
      runAgent(msg.text).catch((e) => post({ type: 'error', text: String((e && e.message) || e) }));
      break;
    }
    case 'stop':
      s.stop = true;
      break;
    case 'delete_from': {
      if (s.running) break;
      const index = msg.index;
      if (!Number.isInteger(index) || !s.conversation[index] || s.conversation[index].role !== 'user') break;

      let turn = 0;
      for (let i = 0; i <= index; i++) {
        if (s.conversation[i].role === 'user') turn++;
      }
      let llmIndex = -1;
      let seen = 0;
      for (let i = 0; i < s.llmMessages.length; i++) {
        if (s.llmMessages[i].role === 'user' && ++seen === turn) {
          llmIndex = i;
          break;
        }
      }
      if (llmIndex < 0) break;
      s.conversation.length = index;
      s.llmMessages.length = llmIndex;
      await commit();
      break;
    }
    case 'reset':
      await resetSession();
      break;
    case 'save_settings': {
      const cur = await loadSettings();
      for (const k of SETTINGS_KEYS) {
        if (msg.settings && msg.settings[k] !== undefined) cur[k] = msg.settings[k];
      }
      await chrome.storage.local.set(cur);
      await postState();
      break;
    }
    case 'test_connection': {
      const cur = await loadSettings();
      // Test the values currently in the panel inputs, not the saved ones.
      if (msg.settings) {
        for (const k of SETTINGS_KEYS.filter((k) => k !== 'systemPrompt')) {
          if (msg.settings[k] !== undefined) cur[k] = msg.settings[k];
        }
      }
      let out;
      try {
        const { url, headers } = openAiRequest(cur);
        // A real completion validates both the key and the model on any OpenAI-compatible provider.
        const chatResp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: cur.model,
            messages: [{ role: 'user', content: "This is a test. Just say 'OK'." }],
            max_tokens: 10,
            stream: false,
          }),
        });
        if (!chatResp.ok) {
          out = { ok: false, status: chatResp.status, error: (await chatResp.text()).slice(0, 300) };
        } else {
          out = { ok: true, status: chatResp.status };
        }
      } catch (e) {
        out = { ok: false, status: 0, error: 'Network error (' + ((e && e.message) || e) + '). openrouter.ai may be unreachable from this browser.' };
      }
      post({ type: 'test_result', result: out });
      break;
    }
  }
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Keyboard shortcut → sidePanel.open(). The user gesture must be consumed
// synchronously, so track the focused window and call open() with no await.
let activeWindowId = null;

chrome.windows.getLastFocused((win) => { if (win) activeWindowId = win.id; });
chrome.tabs.onActivated.addListener(() => { postWorkspaceStatus(); });
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) activeWindowId = windowId;
  postWorkspaceStatus();
});

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'open-panel') {
    if (port) { post({ type: 'close' }); return; } // toggle: panel already open → ask it to close
    if (activeWindowId == null) return; // SW just started; next press works
    chrome.sidePanel.open({ windowId: activeWindowId }).catch(() => {});
  } else if (cmd === 'reset') {
    // Open synchronously while we still have the keyboard gesture;
    // reset state in parallel. The panel will fetch the fresh state on connect.
    if (!port && activeWindowId != null) {
      chrome.sidePanel.open({ windowId: activeWindowId }).catch(() => {});
    }
    resetSession().catch(() => {});
  }
});
