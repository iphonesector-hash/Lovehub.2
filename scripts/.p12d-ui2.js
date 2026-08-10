// Phase 12D — full cross-check + unknown label + telegram in UI
const { chromium } = require('/tmp/pw12c/node_modules/playwright-core');

const QUERIES = ['\u0627\u0628\u06CC', '\u06AF\u0648\u06AF\u0648\u0634', '\u0634\u0627\u062F\u0645\u0647\u0631', '\u0645\u062D\u0633\u0646 \u0686\u0627\u0648\u0634\u06CC', 'Ebi', 'Adele'];

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('https://lovehub-gamma.vercel.app/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => window.MusicSearch && window.LoveHubMusicRoom, { timeout: 20000 });

  // 1) searchSmart direct for all 6 queries
  const cross = await page.evaluate(async (qs) => {
    const out = {};
    for (const q of qs) {
      const res = await window.MusicSearch.searchSmart(q);
      const tracks = Array.isArray(res.results) ? res.results : [];
      const dist = {};
      for (const t of tracks) {
        const k = t.provider || '?';
        dist[k] = (dist[k] || 0) + 1;
      }
      out[q] = { total: tracks.length, state: res.state, raw: res.rawCount, relevant: res.relevantCount, playable: res.playableCount, dist };
    }
    return out;
  }, QUERIES);
  console.log('--- searchSmart cross-check (all 6) ---');
  for (const q of QUERIES) {
    console.log(q + ': total=' + cross[q].total + ' state=' + cross[q].state + ' raw=' + cross[q].raw + ' relevant=' + cross[q].relevant + ' playable=' + cross[q].playable + ' | ' + JSON.stringify(cross[q].dist));
  }

  // 2) the unknown label on گوگوش — dump every row's meta
  await page.evaluate(() => window.LoveHubMusicRoom.doSearch('\u06AF\u0648\u06AF\u0648\u0634', true));
  await new Promise(r => setTimeout(r, 250));
  const unknownRows = await page.evaluate(() => {
    const box = document.getElementById('musicResults');
    const rows = box ? Array.from(box.querySelectorAll('.music-result')) : [];
    const notRjavan = [];
    for (const r of rows) {
      const meta = (r.querySelector('.music-result-meta') || {}).textContent || '';
      if (!/Radio Javan/i.test(meta)) notRjavan.push(meta.slice(0, 110));
    }
    return { notRjavan };
  });
  console.log('\n--- گوگوش rows NOT labeled Radio Javan (' + unknownRows.notRjavan.length + ') ---');
  unknownRows.notRjavan.forEach(m => console.log('  - "' + m + '"'));

  // 3) telegram in the UI? query Shahrah + Taskhir via doSearch (telegram relay may be CDN-cached)
  for (const q of ['Shahrah', 'Taskhir Shode']) {
    const t = await page.evaluate(async (query) => {
      const t0 = Date.now();
      await window.LoveHubMusicRoom.doSearch(query, true);
      const ms = Date.now() - t0;
      const box = document.getElementById('musicResults');
      const rows = box ? Array.from(box.querySelectorAll('.music-result')) : [];
      const tg = [];
      for (const r of rows) {
        const meta = (r.querySelector('.music-result-meta') || {}).textContent || '';
        if (/Telegram/i.test(meta)) tg.push(meta.slice(0, 100));
      }
      return { ms, rendered: rows.length, telegramRows: tg };
    }, q);
    console.log('\n== ' + q + ' | doSearch ' + t.ms + 'ms | rendered=' + t.rendered + ' | telegram-labeled rows=' + t.telegramRows.length);
    t.telegramRows.slice(0, 3).forEach(m => console.log('  - "' + m + '"'));
  }

  await browser.close();
})().catch(e => { console.error('CRASH:', e.message); process.exit(1); });
