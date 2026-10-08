// Deterministic agent-loop history test (no real LLM): a mock OpenAI-compatible
// server scripts the model's replies and records every request body, so we can
// assert the llmMessages the SW sends are well-formed across Stop / Reset.
import { chromium } from 'playwright';
import { rmSync, mkdirSync } from 'fs';
import path from 'node:path';
import { getExtensionIds, startMock, seedMock, checker } from './test_helpers.mjs';

const EXT_PATH = path.resolve(import.meta.dir, '..');
const UDD = path.resolve(import.meta.dir, 'profile_history');

rmSync(UDD, { recursive: true, force: true });
mkdirSync(UDD, { recursive: true });

const mock = await startMock();
const { script } = mock;
const requests = mock.llmRequests; // () => recorded chat/completions requests ({body, headers, ...})

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SLOW_JS = 'return await new Promise((r) => setTimeout(() => r(1), 2000))';

// Structural check of one request's history (system first, context last):
// no back-to-back assistant messages, every tool_call answered by exactly one
// tool message right after it, and no orphan tool messages.
function historyProblems(body) {
  const msgs = body.messages.slice(1, -1);
  const problems = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'assistant' && msgs[i + 1] && msgs[i + 1].role === 'assistant') {
      problems.push(`consecutive assistant messages at ${i}`);
    }
    if (m.role === 'tool') {
      problems.push(`orphan tool message at ${i} (${m.tool_call_id})`);
    }
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      const want = m.tool_calls.map((tc) => tc.id);
      const got = [];
      while (msgs[i + 1] && msgs[i + 1].role === 'tool') got.push(msgs[++i].tool_call_id);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        problems.push(`tool_calls ${JSON.stringify(want)} answered by ${JSON.stringify(got)}`);
      }
    }
  }
  return problems;
}

const { check, done } = checker('history');

try {
  const [extId] = await getExtensionIds(context);
  if (!extId) throw new Error('No extension loaded');

  const workspace = await context.newPage();
  await workspace.goto(mock.base + '/');

  const panel = await context.newPage();
  panel.on('pageerror', (e) => console.log('[panel pageerror]', e.message));
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await seedMock(panel, mock);

  const post = (msg) => panel.evaluate((m) => port.postMessage(m), msg);
  const waitRequests = (n) => mock.waitLLMRequests(n);
  const waitIdle = () => panel.waitForFunction(() => !running, null, { timeout: 20000 });
  // The mock answers instantly, so `running` may already be false again by the
  // time we poll; a received request is the reliable "run started" signal.
  const run = async (text) => {
    const n = requests().length;
    await post({ type: 'run', text });
    await waitRequests(n + 1);
  };
  const chatSteps = () => panel.evaluate(() => [...document.querySelectorAll('#chat .msg')].map((e) => e.innerText));

  await workspace.bringToFront();
  await post({ type: 'reset' });
  await sleep(300);

  // 1) A final answer must be stored exactly once.
  script.push({ tools: [{ id: 't1', name: 'extract_text' }] }, { content: 'Answer one' });
  await run('q1');
  await waitIdle();
  script.push({ content: 'Answer two' });
  await run('q2');
  await waitIdle();
  const r2 = requests()[2].body;
  const ones = r2.messages.filter((m) => m.role === 'assistant' && m.content === 'Answer one').length;
  check('final answer stored once', ones === 1, { count: ones });
  check('history well-formed after a normal turn', historyProblems(r2).length === 0, historyProblems(r2));

  // 2) Stop mid-batch: the skipped tool_call still gets a result.
  script.push({ tools: [
    { id: 's1', name: 'run_js', args: { code: SLOW_JS } },
    { id: 's2', name: 'extract_text' },
  ] });
  await run('q3');
  await sleep(500);
  await post({ type: 'stop' });
  await waitIdle();
  script.push({ content: 'Answer four' });
  await run('q4');
  await waitIdle();
  const r4 = requests()[requests().length - 1].body;
  check('history well-formed after Stop mid-batch', historyProblems(r4).length === 0, historyProblems(r4));
  const s2 = r4.messages.find((m) => m.role === 'tool' && m.tool_call_id === 's2');
  check('skipped tool_call answered as stopped', !!s2 && /stopped/i.test(s2.content), s2);

  // 3) Reset during a tool: the old run must not write into the new session.
  script.push({ tools: [{ id: 'r1', name: 'run_js', args: { code: SLOW_JS } }] });
  await run('q5');
  const before = requests().length;
  await sleep(500);
  await workspace.bringToFront();
  await post({ type: 'reset' });
  await waitIdle();
  await sleep(2500); // let the slow tool finish; a stale run would write now
  const afterReset = await chatSteps();
  check('reset chat stays empty', afterReset.length === 0, afterReset);
  script.push({ content: 'Answer six' });
  await run('q6');
  await waitIdle();
  const r6 = requests()[requests().length - 1].body;
  const roles = r6.messages.map((m) => m.role);
  check('fresh session history is just the new prompt',
    JSON.stringify(roles) === JSON.stringify(['system', 'user', 'user']) && r6.messages[1].content === 'q6',
    roles);
  check('stale run made no extra LLM request', requests().length === before + 1, { before, now: requests().length });

  for (const [i, { body }] of requests().entries()) {
    const p = historyProblems(body);
    if (p.length) check(`request #${i} well-formed`, false, p);
  }

  done();
} finally {
  await context.close();
  await mock.close();
}
