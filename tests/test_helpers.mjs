// Shared helpers for the Playwright harness.

// Discover the unpacked extension's real id from chrome://extensions (authoritative;
// deterministic from the absolute extension path). Walks shadow roots.
export async function getExtensionIds(context) {
  const p = await context.newPage();
  await p.goto('chrome://extensions/');
  await p.waitForSelector('extensions-manager', { timeout: 15000 });
  const ids = await p.evaluate(() => {
    const found = new Set();
    const re = /^[a-p]{32}$/;
    const walk = (el) => {
      if (el.id && re.test(el.id)) found.add(el.id);
      if (el.shadowRoot) el.shadowRoot.querySelectorAll('*').forEach(walk);
      el.querySelectorAll('*').forEach(walk);
    };
    walk(document.body);
    return [...found];
  });
  await p.close();
  return ids;
}

// Mock OpenAI-compatible provider + fixture web server for deterministic tests.
// POST /v1/chat/completions consumes one scripted reply per request:
//   {content}                 → plain answer
//   {tools:[{id,name,args}]}  → tool calls
//   {status, error}           → HTTP error with that body
//   {delayMs}                 → wait before replying (any of the above)
// Streams SSE when the request asks for it, else plain JSON. Every request is
// recorded as {method, path, headers, body}. Other GETs serve `pages[path]`
// ({html, headers}) or a small default fixture page.
export async function startMock({ pages = {} } = {}) {
  const http = await import('node:http');
  const script = [];
  const requests = [];
  const llmRequests = () => requests.filter((r) => r.path === '/v1/chat/completions');

  const reply = (res, body, r) => {
    if (r.status) {
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: r.error || 'mock error' } }));
      return;
    }
    const calls = (r.tools || []).map((t, index) => ({
      index, id: t.id, type: 'function',
      function: { name: t.name, arguments: JSON.stringify(t.args || {}) },
    }));
    if (!body || !body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: r.content || '', tool_calls: calls.length ? calls : undefined } }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta) => res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
    if (r.content) send({ content: r.content });
    for (const c of calls) send({ tool_calls: [c] });
    res.end('data: [DONE]\n\n');
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const path = req.url.split('?')[0];
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (e) { /* not JSON */ }
      requests.push({ method: req.method, path, headers: req.headers, body });
      if (req.method === 'POST' && path === '/v1/chat/completions') {
        const r = script.shift() || { content: 'UNSCRIPTED' };
        setTimeout(() => reply(res, body, r), r.delayMs || 0);
        return;
      }
      const page = pages[path] || { html: '<title>Fixture</title><main><h1>Fixture</h1><p>Some text.</p></main>' };
      res.writeHead(200, { 'Content-Type': 'text/html', ...(page.headers || {}) });
      res.end(page.html);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const waitLLMRequests = async (n, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (llmRequests().length < n) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for LLM request #${n}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  return {
    base,
    apiUrl: base + '/v1',
    script,
    requests,
    llmRequests,
    waitLLMRequests,
    close: () => new Promise((r) => server.close(r)),
  };
}

// Point the extension at a mock provider: writes settings, reloads the panel.
export async function seedMock(panel, mock, { apiKey = 'test-key', model = 'mock/model' } = {}) {
  await panel.evaluate(async (s) => { await chrome.storage.local.set(s); }, { apiKey, model, apiUrl: mock.apiUrl });
  await panel.reload();
  await panel.waitForFunction(() => {
    const el = document.getElementById('prompt');
    return el && !el.disabled;
  }, null, { timeout: 15000 });
}

// Tiny pass/fail recorder; call done() at the end to print and set the exit code.
export function checker(label) {
  let failed = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' — ' + JSON.stringify(detail)));
    if (!ok) failed++;
  };
  const done = () => {
    console.log(failed === 0 ? `\nAll ${label} cases passed.` : `\n${failed} ${label} case(s) failed.`);
    process.exitCode = failed === 0 ? 0 : 1;
  };
  return { check, done };
}

// Normalize a model reply for exact-ish comparison: trim, drop wrapping
// quotes/backticks/trailing period, collapse whitespace, lowercase.
export function norm(text) {
  return String(text || '').trim().replace(/^[`"'*]+|[`"'*.]+$/g, '').replace(/\s+/g, ' ').toLowerCase();
}

// Snapshot of the panel chat as [{role, text}] (role = class minus 'msg ').
export async function chatMessages(panel) {
  // Text excludes the .msgActions row (copy/delete buttons).
  return panel.$$eval('#chat .msg', (els) => els.map((e) => ({
    role: e.className.replace(/\bmsg\b/, '').trim(),
    text: [...e.childNodes]
      .filter((n) => !(n.classList && n.classList.contains('msgActions')))
      .map((n) => (n.innerText !== undefined ? n.innerText : n.textContent))
      .join('').trim(),
  })));
}
