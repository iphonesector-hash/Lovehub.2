// Phase 12D confirm — current state of شادمهر + unknown label source
const { chromium } = require('/tmp/pw12c/node_modules/playwright-core');

const Q = ['شادمهر', 'گوگوش'];

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('https://lovehub-gamma.vercel.app/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => window.MusicSearch && window.LoveHubMusicRoom, { timeout: 20000 });

  for (const q of Q) {
    const row = await page.evaluate(async (query) => {
      const t0 = Date.now();
      const res = await window.MusicSearch.searchSmart(query);
      const ms = Date.now() - t0;
      const tracks = Array.isArray(res.results) ? res.results : [];
      const dist = {};
      for (const t of tracks) {
        const k = (t && t.provider) || '?';
        dist[k] = (dist[k] || 0) + 1;
      }
      // find any track whose provider label would render 'unknown'
      const unlabeled = tracks
        .filter((t) => !(t && (t.providerLabel || t.providerName || t.name)))
        .slice(0, 3)
        .map((t) => ({ provider: t.provider, title: String(t.title || '').slice(0, 40), sourceType: t.sourceType }));
      const diag = {};
      for (const p of (res.providers || [])) {
        if (['codebazan-rjavan', 'deezer', 'youtube', 'telegram'].includes(p.id)) {
          diag[p.id] = { s: p.searches, f: p.failures, ms: p.lastLatencyMs, err: p.lastError ? String(p.lastError).slice(0, 40) : null, cool: p.coolingDown };
        }
      }
      return { total: tracks.length, state: res.state, ms, dist, unlabeled, diag };
    }, q);
    console.log('\n== ' + q + ' | ' + row.ms + 'ms | total=' + row.total + ' state=' + row.state);
    console.log('  dist: ' + JSON.stringify(row.dist));
    if (row.unlabeled && row.unlabeled.length) console.log('  no-label rows: ' + JSON.stringify(row.unlabeled));
    console.log('  diag: ' + JSON.stringify(row.diag));
  }

  // UI render path for گوگوش — read actual rendered labels
  const ui = await page.evaluate(async () => {
    const room = window.LoveHubMusicRoom;
    await room.doSearch('گوگوش', true);
    await new Promise((r) => setTimeout(r, 500));
    const rows = Array.from(document.querySelectorAll('#musicResults [data-track], #musicResults .result-row, #musicResults .music-row'));
    const labels = {};
    for (const el of rows) {
      const lab = (el.querySelector('.provider-label, .src-label, .source-label') || {}).textContent || 'none';
      labels[lab.trim()] = (labels[lab.trim()] || 0) + 1;
    }
    return { rendered: rows.length, labels };
  });
  console.log('\n== UI گوگوش rendered: ' + JSON.stringify(ui));
  await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
