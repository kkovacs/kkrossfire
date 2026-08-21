const els = {
  chat: document.getElementById('chat'),
  prompt: document.getElementById('prompt'),
  send: document.getElementById('send'),
  stop: document.getElementById('stop'),
  busy: document.getElementById('busy'),
  reset: document.getElementById('resetBtn'),
  settingsBtn: document.getElementById('settingsBtn'),
  settings: document.getElementById('settings'),
  apiKey: document.getElementById('apiKey'),
  apiUrl: document.getElementById('apiUrl'),
  model: document.getElementById('model'),
  systemPrompt: document.getElementById('systemPrompt'),
  saveSettings: document.getElementById('saveSettings'),
  testConnection: document.getElementById('testConnection'),
  settingsStatus: document.getElementById('settingsStatus'),
  tabInfo: document.getElementById('tabInfo'),
};

let port = null;
let running = false;
let hasKey = false;
let lastSettings = null;
let streamingEl = null; // in-progress assistant bubble while the answer streams
let streamText = '';
let thinkingEl = null;  // typing-dots bubble while waiting on the model
let streaming = false;  // true once answer tokens start arriving
let phase = null;
let workspaceTabId = null;
let workspaceAway = true;
let firstRender = true; // initial load should land at the bottom
let forceScroll = false; // user just sent; follow the new message to the bottom

function connect() {
  port = chrome.runtime.connect({ name: 'kkiosk' });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 500); });
  port.postMessage({ type: 'get_state' });
}

function onMessage(msg) {
  if (msg.type === 'state') {
    render(msg);
  } else if (msg.type === 'workspace_status') {
    if (msg.workspaceTabId === workspaceTabId) {
      workspaceAway = !!msg.away;
      updateButtons();
    }
  } else if (msg.type === 'delta') {
    streamText += msg.text || '';
    if (!streamText.trim()) return;
    streaming = true;
    hideTyping();
    if (!streamingEl) {
      streamingEl = document.createElement('div');
      streamingEl.className = 'msg assistant';
      els.chat.appendChild(streamingEl);
    }
    // Measure "near bottom" BEFORE the chunk grows the bubble. scrollBottom()
    // re-checks after insertion, so a single delta taller than ~40px would see
    // itself as "not near the bottom" and permanently stop following.
    const stick = nearBottom();
    streamingEl.innerHTML = format(streamText.trim());
    if (stick) els.chat.scrollTop = els.chat.scrollHeight;
  } else if (msg.type === 'delta_cancel') {
    streaming = false;
    if (streamingEl) { streamingEl.remove(); streamingEl = null; }
    streamText = '';
  } else if (msg.type === 'close') {
    window.close();
  } else if (msg.type === 'error') {
    showToast('⚠️ ' + msg.text);
  } else if (msg.type === 'restore_prompt') {
    els.prompt.value = msg.text || '';
    updateButtons();
  } else if (msg.type === 'test_result') {
    showSettingsStatus(msg.result.ok
      ? '✓ Connected'
      : '✗ ' + escapeHtml(msg.result.error || ('HTTP ' + msg.result.status)),
      msg.result.ok ? 'ok' : 'error');
  }
}

function render(msg) {
  const wasRunning = running;
  if (msg.running !== undefined) running = !!msg.running;
  if (msg.phase !== undefined) phase = msg.phase;
  if (msg.workspaceTabId !== undefined) workspaceTabId = msg.workspaceTabId;
  if (msg.workspaceAway !== undefined) workspaceAway = !!msg.workspaceAway;
  if (msg.tab && msg.tab.url) {
    els.tabInfo.textContent = (msg.tab.title || msg.tab.url) + ' — ' + msg.tab.url;
  } else if (msg.tab) {
    els.tabInfo.textContent = 'no workspace tab';
  }
  if (msg.settings) {
    lastSettings = msg.settings;
    hasKey = !!(msg.settings.apiKey && msg.settings.apiKey.trim());
    if (!hasKey) {
      populateSettings();
      els.settings.hidden = false;
    }
  }
  updateButtons();
  if (Array.isArray(msg.conversation)) {
    const stick = nearBottom();
    const prevTop = els.chat.scrollTop;
    streamingEl = null;
    streamText = '';
    streaming = false;
    els.chat.innerHTML = '';
    msg.conversation.forEach((m, i) => appendMsg(m.role, m.content, i));
    if (forceScroll || firstRender || stick) {
      els.chat.scrollTop = els.chat.scrollHeight;
    } else {
      els.chat.scrollTop = prevTop; // keep the user's reading position across re-renders
    }
  }
  updateBusy();
  if (running && phase === 'llm' && !streaming) showTyping(); else hideTyping();
  if (firstRender && hasKey) els.prompt.focus(); // autofocus on panel open
  if (wasRunning && !running && hasKey) els.prompt.focus();
  firstRender = false;
  forceScroll = false;
}

function populateSettings() {
  if (!lastSettings) return;
  els.apiKey.value = lastSettings.apiKey || '';
  els.apiUrl.value = lastSettings.apiUrl || DEFAULTS.apiUrl;
  els.model.value = lastSettings.model || DEFAULTS.model;
  els.systemPrompt.value = lastSettings.systemPrompt ?? DEFAULTS.systemPrompt;
}

function updateButtons() {
  els.prompt.disabled = !hasKey;
  els.send.disabled = !hasKey || running || !els.prompt.value.trim();
  els.stop.hidden = !running;
  els.reset.disabled = running;
  els.reset.classList.toggle('away', workspaceAway);
}

function appendMsg(role, content, index) {
  const div = document.createElement('div');
  div.className = 'msg ' + (role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'step');
  div.innerHTML = role === 'step' ? escapeHtml(content) : format(content);
  if (role === 'user' && !running) {
    const actions = document.createElement('div');
    actions.className = 'msgActions';
    actions.appendChild(actionButton('×', 'Delete from here', () => {
      // Empty box: restore the deleted turn as a draft so it can be re-edited.
      if (els.prompt.value.trim() === '') {
        els.prompt.value = content;
        updateButtons();
        els.prompt.focus();
      }
      if (port) port.postMessage({ type: 'delete_from', index });
    }));
    div.appendChild(actions);
  } else if (role === 'assistant') {
    const actions = document.createElement('div');
    actions.className = 'msgActions';
    actions.appendChild(actionButton('⧉', 'Copy Markdown', () => copyMarkdown(content)));
    div.appendChild(actions);
  }
  els.chat.appendChild(div);
}

function actionButton(icon, label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = icon;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', onClick);
  return button;
}

async function copyMarkdown(content) {
  try {
    await navigator.clipboard.writeText(String(content || ''));
    showToast('Markdown copied ✓');
  } catch (e) {
    showToast('Could not copy Markdown');
  }
}

// Render assistant text: inline markdown (bold, code) plus GFM tables.
// A table is consecutive '|'-rows whose 2nd line is a separator; it renders
// as <table> as soon as the separator appears, so it works mid-stream.
function format(text) {
  const lines = String(text || '').split('\n');
  let out = '';
  let i = 0;
  while (i < lines.length) {
    if (isTableStart(lines, i)) {
      out += renderTable(lines, i);
      i += 2; // skip header + separator
      while (i < lines.length && isTableRow(lines[i])) i++; // skip data rows
    } else {
      // gather text up to the next table; render with the classic inline pass
      const start = i;
      while (i < lines.length && !isTableStart(lines, i)) i++;
      out += inlineBlock(lines.slice(start, i).join('\n'));
    }
  }
  return out;
}

// Inline pass for text: escape, then bold + code, then newlines to <br>.
function inlineBlock(s) {
  let t = escapeHtml(s);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  return t.replace(/\n/g, '<br>');
}

// Inline pass for a single table cell (no newline handling).
function inlineCell(s) {
  return inlineBlock(s == null ? '' : s);
}

function isTableRow(line) {
  return line.trimStart().startsWith('|'); // XXX: requires leading '|' (no pipe-less GFM)
}

function isSeparator(line) {
  if (!isTableRow(line)) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

function isTableStart(lines, i) {
  return isTableRow(lines[i]) && i + 1 < lines.length && isSeparator(lines[i + 1]);
}

// Split a '|'-delimited row into trimmed cells, tolerating missing edge pipes.
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function alignOf(cell) {
  const c = cell.trim();
  const left = c.startsWith(':');
  const right = c.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return '';
}

function alignAttr(a) {
  return a ? ` style="text-align:${a}"` : '';
}

function renderTable(lines, i) {
  const header = splitRow(lines[i]);
  const aligns = splitRow(lines[i + 1]).map(alignOf);
  let j = i + 2;
  const body = [];
  while (j < lines.length && isTableRow(lines[j])) {
    body.push(splitRow(lines[j]));
    j++;
  }
  let html = '<div class="tableWrap"><table><thead><tr>';
  header.forEach((c, k) => {
    html += `<th${alignAttr(aligns[k])}>${inlineCell(c)}</th>`;
  });
  html += '</tr></thead><tbody>';
  body.forEach((row) => {
    html += '<tr>';
    // pad/truncate to header width so columns stay stable on malformed input
    for (let k = 0; k < header.length; k++) {
      html += `<td${alignAttr(aligns[k])}>${inlineCell(row[k])}</td>`;
    }
    html += '</tr>';
  });
  return html + '</tbody></table></div>';
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function nearBottom() {
  return els.chat.scrollHeight - els.chat.scrollTop - els.chat.clientHeight < 40;
}

function scrollBottom() {
  if (nearBottom()) els.chat.scrollTop = els.chat.scrollHeight;
}

function showTyping() {
  hideTyping();
  thinkingEl = document.createElement('div');
  thinkingEl.className = 'msg assistant typing';
  thinkingEl.innerHTML = '<span></span><span></span><span></span>';
  els.chat.appendChild(thinkingEl);
  scrollBottom();
}

function hideTyping() {
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
}

function updateBusy() {
  els.busy.hidden = !(running && phase === 'tool');
}

// Local slash-commands; never sent to the LLM.
function handleCommand(text) {
  if (text === '/new') {
    els.prompt.value = '';
    updateButtons();
    if (!running && port) port.postMessage({ type: 'reset' }); // Reset is disabled mid-run
    els.prompt.focus();
    return true;
  }
  if (text === '/q' || text === '/quit') {
    window.close();
    return true;
  }
  return false;
}

function send() {
  const text = els.prompt.value.trim();
  if (!text) return;
  if (handleCommand(text)) return;
  if (running || !port) return;
  els.prompt.value = '';
  running = true;
  forceScroll = true;
  updateButtons();
  port.postMessage({ type: 'run', text });
}

function saveSettings() {
  if (!port) return;
  port.postMessage({
    type: 'save_settings',
    settings: {
      apiKey: els.apiKey.value.trim(),
      apiUrl: els.apiUrl.value.trim() || DEFAULTS.apiUrl,
      model: els.model.value.trim() || DEFAULTS.model,
      systemPrompt: els.systemPrompt.value.trim(),
    },
  });
  els.settingsStatus.textContent = '';
  showToast('Settings saved ✓');
  els.settings.hidden = true;
}

let toastTimer = null;
function showToast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2000);
}

function showSettingsStatus(html, cls) {
  els.settingsStatus.className = cls || '';
  els.settingsStatus.innerHTML = html;
}

els.send.addEventListener('click', send);
els.prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
els.prompt.addEventListener('input', updateButtons);
els.stop.addEventListener('click', () => { port && port.postMessage({ type: 'stop' }); });
els.reset.addEventListener('click', () => {
  if (!port) return;
  port.postMessage({ type: 'reset' });
  els.prompt.focus();
});
els.settingsBtn.addEventListener('click', () => { populateSettings(); els.settings.hidden = !els.settings.hidden; });
els.saveSettings.addEventListener('click', saveSettings);
els.testConnection.addEventListener('click', () => {
  if (!port) return;
  showSettingsStatus('Testing…');
  port.postMessage({
    type: 'test_connection',
    settings: {
      apiKey: els.apiKey.value.trim(),
      apiUrl: els.apiUrl.value.trim() || DEFAULTS.apiUrl,
      model: els.model.value.trim() || DEFAULTS.model,
    },
  });
});

connect();
