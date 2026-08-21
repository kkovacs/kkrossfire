// Seed the OpenRouter key from tests/.env into the extension's storage.
// The sidepanel page must already be open; this writes storage directly and
// reloads the panel so hasKey flips true and the prompt becomes enabled.
export async function seedKey(panel) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY missing — add it to tests/.env');
  await panel.evaluate(async (k) => {
    await chrome.storage.local.set({ apiKey: k });
  }, key);
  await panel.reload();
  await panel.waitForFunction(() => {
    const el = document.getElementById('prompt');
    return el && !el.disabled;
  }, null, { timeout: 15000 });
}
