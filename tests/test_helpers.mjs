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
