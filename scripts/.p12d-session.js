// Phase 12D — session-level: watch rjavan diagnostics across sequential queries
const { chromium } = require('/tmp/pw12c/node_modules/playwright-core');

const QUERIES = ['\u06AF\u0648\u06AF\u0648\u0634', '\u0634\u0627\u062F\u0645\u0647\u0631', 'Ebi', '\u0645\u062D\u0633\u0646 \u0686\u0627\u0648\u0634\u06CC'];

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('https://lovehub-gamma.vercel.app/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => window.MusicSearch, { timeout: 20000 });

  for (const q of QUERIES) {
    const d = await page.evaluate(async (query) => {
      const t0 = Date.now();
      const res = await window.MusicSearch.searchSmart(query);
      const ms = Date.now() - t0;
      const tracks = Array.isArray(res.results) ? res.results : [];
      const dist = {};
      for (const t of tracks) { const k = t.provider || '?'; dist[k] = (dist[k] || 0) + 1; }
      const diag = {};
      for (const p of (res.providers || [])) {
        if (p.id === 'codebazan-rjavan' || p.id === 'youtube' || p.id === 'telegram' || p.id === 'deezer') {
          diag[p.id] = { s: p.searches, f: p.failures, ms: p.lastLatencyMs, err: p.lastError ? String(p.lastError).slice(0, 55) : null, cool: p.coolingDown };
        }
      }
      return { ms, total: tracks.length, dist, diag };
    }, q);
    console.log(q + ' | ' + d.ms + 'ms | total=' + d.total + ' | ' + JSON.stringify(d.dist));
    for (const k of Object.keys(d.diag)) {
      const p = d.diag[k];
      console.log('    ' + k + ': s=' + p.s + ' f=' + p.f + ' ms=' + p.ms + ' cool=' + p.cool + (p.err ? ' err="' + p.err + '"' : ''));
    }
  }
  await browser.close();
})().catch(e => { console.error('CRASH:', e.message); process.exit(1); });
