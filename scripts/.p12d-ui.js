// Phase 12D — drive the REAL production Music Room rendering path and read the visible DOM.
// Uses the deployed page's own MusicRoom instance (doSearch -> searchSmart -> _renderResults).
// No auth is bypassed: we call the same methods the UI calls, then inspect #musicResults.
const { chromium } = require('/tmp/pw12c/node_modules/playwright-core');

const QUERIES = ['\u0627\u0628\u06CC', '\u06AF\u0648\u06AF\u0648\u0634', '\u0634\u0627\u062F\u0645\u0647\u0631', '\u0645\u062D\u0633\u0646 \u0686\u0627\u0648\u0634\u06CC', 'Ebi', 'Adele'];

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 150)); });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 150)));

  await page.goto('https://lovehub-gamma.vercel.app/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => window.MusicSearch && window.LoveHubMusicRoom && typeof window.LoveHubMusicRoom.doSearch === 'function', { timeout: 20000 });
  console.log('MusicSearch + LoveHubMusicRoom loaded ✓');

  for (const q of QUERIES) {
    const row = await page.evaluate(async (query) => {
      const room = window.LoveHubMusicRoom;
      const t0 = Date.now();
      await room.doSearch(query, true);
      const elapsed = Date.now() - t0;
      // wait a moment for any re-render to settle
      await new Promise(r => setTimeout(r, 300));

      const box = document.getElementById('musicResults');
      const rows = box ? Array.from(box.querySelectorAll('.music-result')) : [];
      const out = [];
      for (const r of rows) {
        const title = (r.querySelector('.music-result-title') || {}).textContent || '';
        const meta = (r.querySelector('.music-result-meta') || {}).textContent || '';
        const playBtn = r.querySelector('.music-result-play');
        const playable = playBtn ? !playBtn.classList.contains('disabled') : false;
        out.push({ title: title.slice(0, 40), meta: meta.slice(0, 90), playable });
      }
      return { elapsed, rendered: rows.length, results: out, state: room._searchState || null };
    }, q);
    console.log('\n== ' + q + ' | doSearch took ' + row.elapsed + 'ms | rendered rows: ' + row.rendered + ' | state=' + row.state);
    const labelCounts = {};
    for (const r of row.results) {
      // provider label sits in the meta line; extract the segment after artist
      const meta = r.meta;
      let label = 'unknown';
      if (/Radio Javan|RJavan|codebazan/i.test(meta)) label = 'Radio Javan';
      else if (/youtube|Video playback/i.test(meta)) label = 'YouTube';
      else if (/Deezer/i.test(meta)) label = 'Deezer';
      else if (/Telegram/i.test(meta)) label = 'Telegram';
      else if (/Internet Archive/i.test(meta)) label = 'Internet Archive';
      else if (/Audius/i.test(meta)) label = 'Audius';
      labelCounts[label] = (labelCounts[label] || 0) + 1;
    }
    console.log('  visible labels:', JSON.stringify(labelCounts));
    const sample = row.results.slice(0, 5).map(r => r.title + ' | ' + r.meta + ' | playable=' + r.playable);
    sample.forEach(s => console.log('  - ' + s));
  }

  // ---- cross-check: searchSmart direct provider field + playbackMode ----
  console.log('\n--- searchSmart direct cross-check (provider/playbackMode) ---');
  const cross = await page.evaluate(async () => {
    const out = {};
    for (const q of ['\u0645\u062D\u0633\u0646 \u0686\u0627\u0648\u0634\u06CC', 'Ebi', 'Adele']) {
      const res = await window.MusicSearch.searchSmart(q);
      const tracks = Array.isArray(res.results) ? res.results : [];
      const dist = {};
      for (const t of tracks) {
        const k = (t.provider || '?') + '/' + (t.playbackMode || '?') + '/' + (t.sourceType || '?') + '/' + (t.playable === true ? 'P' : 'np');
        dist[k] = (dist[k] || 0) + 1;
      }
      out[q] = { total: tracks.length, dist };
    }
    return out;
  });
  for (const q of Object.keys(cross)) console.log(q + ': ' + JSON.stringify(cross[q].dist));

  console.log('\n--- console errors (relevant, excluding known melobit) ---');
  const relevant = consoleErrors.filter(e => !/melobit/i.test(e) && !/Failed to load resource/i.test(e));
  console.log(relevant.length ? relevant.slice(0, 10) : 'none beyond known melobit/resource failures');
  await browser.close();
})().catch(e => { console.error('CRASH:', e.message); process.exit(1); });
