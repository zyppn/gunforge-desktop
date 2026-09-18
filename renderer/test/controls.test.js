/* Drive the real settings panel in a real browser: click a control, press a key,
   confirm it binds, persists, swaps on conflict, and that RESET restores it. */
const { chromium } = require('playwright');
const path = require('path');

let fails = 0;
const check = (label, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  if (!ok) fails++;
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args:['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  const NET = /Failed to fetch|ERR_TUNNEL|ERR_NAME|net::|auth failed|Load failed/i;  // Supabase is not reachable offline
  page.on('pageerror', e => { if (!NET.test(e.message)) errors.push(e.message); });
  page.on('console', m => { if (m.type() === 'error' && !NET.test(m.text())) errors.push('console: ' + m.text()); });

  await page.goto('file://' + path.join(__dirname, '..', 'index.html'));
  await page.waitForTimeout(1200);

  check('page boots with no JS errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  const defaults = await page.evaluate(() => JSON.parse(JSON.stringify(BINDS)));
  console.log('\n  defaults: ' + JSON.stringify(defaults));
  check('ships with WASD + LMB/RMB',
    defaults.forward === 'KeyW' && defaults.fire === 'Mouse0' && defaults.ads === 'Mouse2');

  await page.evaluate(() => menuSettings());
  await page.waitForTimeout(150);
  const rows = await page.$$eval('.bindbtn', els => els.map(e => ({ id: e.id, txt: e.textContent })));
  console.log('  rows: ' + rows.map(r => r.id.replace('bind-', '') + '=' + r.txt).join(' '));
  check('all seven controls render as clickable buttons', rows.length === 7, 'got ' + rows.length);
  check('labels read as keys, not codes',
    rows.find(r => r.id === 'bind-forward').txt === 'W' &&
    rows.find(r => r.id === 'bind-ads').txt === 'RMB');

  // --- rebind ADS onto a key: the trackpad case this feature exists for ---
  await page.click('#bind-ads');
  const listening = await page.$eval('#bind-ads', e => e.textContent);
  check('clicking a row listens for input', /PRESS/.test(listening), listening);
  await page.keyboard.press('KeyQ');
  await page.waitForTimeout(100);
  check('ADS rebinds onto a keyboard key', (await page.evaluate(() => BINDS.ads)) === 'KeyQ');
  check('the button repaints to the new key',
    (await page.$eval('#bind-ads', e => e.textContent)) === 'Q');

  // --- a conflict must SWAP, never leave anything unbound ---
  await page.click('#bind-forward');
  await page.keyboard.press('KeyQ');            // already held by ADS
  await page.waitForTimeout(100);
  const after = await page.evaluate(() => JSON.parse(JSON.stringify(BINDS)));
  console.log('  after conflict: forward=' + after.forward + ' ads=' + after.ads);
  check('the conflicting action takes the freed key instead of going unbound',
    after.forward === 'KeyQ' && after.ads === 'KeyW');
  const values = Object.values(after);
  check('no action is left unbound', values.every(v => !!v) && new Set(values).size === values.length);

  // --- reserved keys ---
  await page.click('#bind-reload');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(100);
  check('TAB is refused (it is the scoreboard)', (await page.evaluate(() => BINDS.reload)) === 'KeyR');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  check('ESC cancels a pending rebind', (await page.evaluate(() => bindCapture)) === null);

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('gf:settings') || '{}'));
  check('bindings are written to disk', !!(saved && saved.binds && saved.binds.forward === 'KeyQ'),
    JSON.stringify(saved && saved.binds));

  // --- the game loop must actually read the new binding ---
  const moves = await page.evaluate(() => {
    keys['KeyQ'] = true;  const q = act('forward');
    keys['KeyQ'] = false; keys['KeyW'] = true; const w = act('forward');
    keys['KeyW'] = false;
    return { q, w };
  });
  check('movement follows the rebind, not the old key', moves.q === true && moves.w === false,
    'Q=' + moves.q + ' W=' + moves.w);

  // --- RESET TO DEFAULT restores the keys, not just the sliders ---
  await page.evaluate(() => resetSettingsAll());
  await page.waitForTimeout(150);
  const reset = await page.evaluate(() => JSON.parse(JSON.stringify(BINDS)));
  check('RESET TO DEFAULT restores every binding',
    JSON.stringify(reset) === JSON.stringify(defaults), JSON.stringify(reset));
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('gf:settings') || '{}'));
  check('the reset is persisted too', persisted.binds && persisted.binds.forward === 'KeyW');
  check('the panel repaints after reset',
    (await page.$eval('#bind-forward', e => e.textContent)) === 'W');

  // --- bindings survive a restart, and the on-screen hint follows them ---
  await page.evaluate(() => { BINDS.fire = 'KeyF'; SETTINGS.binds = BINDS; saveSettings(); });
  await page.reload();
  await page.waitForTimeout(1000);
  check('bindings survive a restart', (await page.evaluate(() => BINDS.fire)) === 'KeyF');
  const hint = await page.$eval('#ctlhint', e => e.textContent);
  console.log('  hint line: ' + hint.trim());
  check('the on-screen hint reflects the binding', /FIRE\s+HOLD F/.test(hint), hint.trim());

  // --- a corrupt save must not leave someone unable to move ---
  await page.evaluate(() => localStorage.setItem('gf:settings',
    JSON.stringify({ binds: { forward: { evil:1 }, fire: 'x'.repeat(99) } })));
  await page.reload();
  await page.waitForTimeout(1000);
  const recovered = await page.evaluate(() => JSON.parse(JSON.stringify(BINDS)));
  check('a corrupt save falls back to defaults rather than unbinding',
    recovered.forward === 'KeyW' && recovered.fire === 'Mouse0', JSON.stringify(recovered));

  check('no JS errors across the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log('\n' + (fails ? fails + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED'));
  process.exit(fails ? 1 : 0);
})();
