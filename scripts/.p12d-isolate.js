// Phase 12D — isolate whether _withTimeout/per-task timeouts actually fire in the real browser.
const { chromium } = require('/tmp/pw12c/node_modules/playwright-core');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('https://lovehub-gamma.vercel.app/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => window.MusicSearch, { timeout: 20000 });

  const result = await page.evaluate(async () => {
    const MS = window.MusicSearch;
    const out = {};

    // 1) Does _withTimeout fire? Register a provider whose searchTracks never resolves.
    const hangProvider = {
      id: 'hang-test', name: 'Hang', timeoutMs: 600,
      isAvailable: () => true,
      async searchTracks() { return new Promise(() => {}); } // never settles
    };
    const M = new MS.MusicProviderManager({ poolLimit: 2, deadlineMs: 10000, timeoutMs: { 'hang-test': 600 } });
    M.registerProvider(hangProvider);
    const t0 = Date.now();
    await M.searchOthers('ebi', MS.buildQueryContext ? MS.buildQueryContext('ebi') : { q: 'ebi', norm: 'ebi', tokens: ['ebi'], hasPersian: false, translits: [], tokensAreNonMusic: false }, MS.buildSearchVariants ? MS.buildSearchVariants('ebi') : ['ebi'], 'nope');
    out.hangElapsed = Date.now() - t0; // expect ~600ms if _withTimeout works

    // 2) Global deadline: 3 hang providers + 1 fast, pool 2, deadline 1500ms.
    const mkHang = (id) => ({
      id, name: id, timeoutMs: 30000,
      isAvailable: () => true,
      async searchTracks() { return new Promise(() => {}); }
    });
    const M2 = new MS.MusicProviderManager({ poolLimit: 2, deadlineMs: 1500, timeoutMs: {} });
    M2.registerProvider(mkHang('h1'));
    M2.registerProvider(mkHang('h2'));
    M2.registerProvider(mkHang('h3'));
    const fast = {
      id: 'fast1', name: 'Fast', timeoutMs: 2000,
      isAvailable: () => true,
      async searchTracks() {
        await new Promise((r) => setTimeout(r, 100));
        return [{ title: 'Fast Track', artist: 'F', provider: 'fast1', playableUrl: 'https://x.com/a.mp3', audioEvidence: true }];
      }
    };
    M2.registerProvider(fast);
    const t1 = Date.now();
    const res = await M2.searchOthers('ebi', { q: 'ebi' }, ['ebi'], 'nope');
    out.deadlineElapsed = Date.now() - t1; // expect ~1500ms (race) not ~30s
    out.deadlineTracks = (res || []).length; // expect >= 1 (fast provider's track present)

    return out;
  });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
