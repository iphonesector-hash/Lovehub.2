// ===========================================================================
// scripts/phase5-tests.js — DOM-free logic tests for Phase 5 modules.
//
// Run:  node scripts/phase5-tests.js
//
// Covers:
//   * MusicPlayerService: queue add/remove/reorder/clear, transport state,
//     next/previous, volume clamp, seek bounds, snapshot shape.
//   * music-search.js: query sanitization, provider normalization, unavailable
//     (no playableUrl) handling, dedupe, fetch-failure fallback.
//
// Chat reactions / bookmarks ride the existing RPC layer (message_reactions +
// toggle_message_flag) which already runs in production; the UI additions are
// covered by the manual test checklist in the phase report.
// ===========================================================================

'use strict';

const fs = require('fs');
const vm = require('vm');

// ---- sandbox --------------------------------------------------------------

class FakeAudio {
    constructor() {
        this._listeners = {};
        this.currentTime = 0;
        this.duration = NaN;
        this.volume = 0.8;
        this.src = '';
        this.error = null;
        this.paused = true;
        this._playCount = 0;
    }
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
    removeEventListener(ev, fn) {
        const l = this._listeners[ev];
        if (l) { const i = l.indexOf(fn); if (i > -1) l.splice(i, 1); }
    }
    _fire(ev) { (this._listeners[ev] || []).slice().forEach((fn) => { try { fn.call(this); } catch (e) { /* ignore */ } }); }
    load() { this._fire('canplay'); }
    pause() { this.paused = true; this._fire('pause'); }
    async play() { this.paused = false; this._playCount++; this._fire('play'); return Promise.resolve(); }
}

const sandbox = {
    window: {},
    console,
    setTimeout,
    clearTimeout,
    fetch: () => Promise.reject(new Error('fetch not mocked')),
    AbortController,
    Audio: FakeAudio
};
sandbox.window = sandbox;
vm.createContext(sandbox);

vm.runInContext(fs.readFileSync('music-player.js', 'utf8'), sandbox);
vm.runInContext(fs.readFileSync('music-search.js', 'utf8'), sandbox);
// music-room.js guards its DOM construction (no document in this sandbox),
// so the pure utilities on window.LoveHubMusicRoomUtils load safely.
vm.runInContext(fs.readFileSync('music-room.js', 'utf8'), sandbox);

const Player = sandbox.window.MusicPlayerService;
const MusicSearch = sandbox.window.MusicSearch;
const sanitize = sandbox.window.MusicSearch.sanitizeQuery;
const normalizeQ = sandbox.window.MusicSearch.normalizeQuery;
const U = sandbox.window.LoveHubMusicRoomUtils;

let failures = 0;
let passes = 0;
function assert(cond, name) {
    if (cond) { passes++; console.log('  PASS', name); }
    else { failures++; console.error('  FAIL', name); }
}
async function test(name, fn) {
    try { await fn(); } catch (e) { failures++; console.error('  FAIL', name, '→', e && e.message); }
}

// ---- fixtures -------------------------------------------------------------

const T1 = { title: 'Yellow', artist: 'Coldplay', source: 'Internet Archive', playableUrl: 'https://x/a.mp3', dedupeKey: 'id1', duration: 210 };
const T2 = { title: 'T2', artist: 'B2', playableUrl: 'https://x/b.mp3', dedupeKey: 'id2' };
const T3 = { title: 'T3', artist: 'B3', playableUrl: 'https://x/c.mp3', dedupeKey: 'id3' };
const NO_URL = { title: 'Unavailable', artist: 'X', playableUrl: null, dedupeKey: 'id4' };

async function main() {
    // ===========================================================================
    console.log('\n== MusicPlayerService: queue ==');

    await test('addToQueue appends + refuses non-playable', async () => {
        const p = new Player();
        assert(p.addToQueue(T1) === true, 'adds playable track');
        assert(p.addToQueue(NO_URL) === false, 'rejects track without playableUrl');
        assert(p.queue.length === 1, 'queue length is 1');
        p.destroy();
    });

    await test('removeFromQueue fixes index', async () => {
        const p = new Player();
        p.setQueue([T1, T2, T3], 1);
        p.removeFromQueue(0);
        assert(p.queue.length === 2 && p.queue[0].dedupeKey === 'id2', 'removes item');
        assert(p.index === 0, 'index adjusted down');
        p.destroy();
    });

    await test('moveInQueue reorders + keeps index consistent', async () => {
        const p = new Player();
        p.setQueue([T1, T2, T3], 1);
        p.moveInQueue(0, 2);
        assert(p.queue.map((t) => t.dedupeKey).join(',') === 'id2,id3,id1', 'reordered');
        assert(p.index === 0, 'index follows moved item');
        p.moveInQueue(2, 0);
        assert(p.queue.map((t) => t.dedupeKey).join(',') === 'id1,id2,id3', 'moved back');
        p.destroy();
    });

    await test('clearQueue empties + resets index', async () => {
        const p = new Player();
        p.setQueue([T1, T2], 0);
        p.clearQueue();
        assert(p.queue.length === 0 && p.index === -1, 'cleared');
        p.destroy();
    });

    await test('setQueue filters non-playable tracks', async () => {
        const p = new Player();
        p.setQueue([T1, NO_URL, T2], 0);
        assert(p.queue.length === 2, 'only playable kept');
        p.destroy();
    });

    // ===========================================================================
    console.log('\n== MusicPlayerService: transport ==');

    await test('loadTrack sets current + autoplays', async () => {
        const p = new Player();
        await p.loadTrack(T1);
        const s = p.snapshot();
        assert(s.current && s.current.dedupeKey === 'id1', 'current track set');
        assert(s.playing === true, 'playing after autoplay');
        assert(p._audio._playCount >= 1, 'audio.play() called');
        p.destroy();
    });

    await test('loadTrack rejects missing playableUrl with error state', async () => {
        const p = new Player();
        const res = await p.loadTrack(NO_URL);
        assert(res === false, 'returns false');
        assert(p.snapshot().error === 'This result has no playable stream', 'error surfaced');
        p.destroy();
    });

    await test('pause / toggle', async () => {
        const p = new Player();
        await p.loadTrack(T1);
        p.pause();
        assert(p.snapshot().playing === false, 'paused');
        await p.toggle();
        assert(p.snapshot().playing === true, 'toggled back to playing');
        p.destroy();
    });

    await test('seek clamps negative', async () => {
        const p = new Player();
        await p.loadTrack(T1);
        p.seek(-5);
        assert(p._audio.currentTime === 0, 'negative seek clamped to 0');
        p.destroy();
    });

    await test('setVolume clamps 0..1', async () => {
        const p = new Player();
        p.setVolume(1.7);
        assert(p.volume === 1, 'clamped high');
        p.setVolume(-0.2);
        assert(p.volume === 0, 'clamped low');
        p.setVolume(0.5);
        assert(p.volume === 0.5 && p._audio.volume === 0.5, 'applied to audio');
        p.destroy();
    });

    await test('next/previous walk the queue', async () => {
        const p = new Player();
        p.setQueue([T1, T2, T3], 0);
        await p.next();
        assert(p.index === 1, 'next → index 1');
        await p.previous();
        assert(p.index === 0, 'previous → index 0');
        await p.previous(); // at 0 with currentTime 0 → stay at 0 (no wrap)
        assert(p.index === 0, 'previous does not wrap below 0');
        p.destroy();
    });

    await test('retry reloads the current track', async () => {
        const p = new Player();
        await p.loadTrack(T1);
        p._audio._playCount = 0;
        await p.retry();
        assert(p._audio._playCount >= 1, 'retry triggered play');
        p.destroy();
    });

    await test('snapshot shape', async () => {
        const p = new Player();
        const s = p.snapshot();
        assert(typeof s.playing === 'boolean' && typeof s.duration === 'number', 'snapshot is well-formed');
        p.destroy();
    });

    // ===========================================================================
    console.log('\n== music-search: sanitization ==');

    await test('sanitizeQuery strips control chars + caps length', async () => {
        const clean = sanitize('  hello\u0000world \u0007 ! ');
        assert(clean === 'hello world !', 'control chars removed, trimmed');
        const long = sanitize('x'.repeat(500));
        assert(long.length === 120, 'capped at 120');
        assert(sanitize(null) === '' && sanitize('  ') === '', 'empty input → empty');
    });

    // ===========================================================================
    console.log('\n== music-search: Internet Archive provider (mocked fetch) ==');

    await test('normalizes docs into tracks with playable download URLs', async () => {
        sandbox.fetch = (url) => {
            if (String(url).includes('advancedsearch')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        response: { docs: [
                            { identifier: 'coldplay-yellow', title: 'Coldplay: Yellow', creator: 'Coldplay' },
                            { identifier: 'no-audio-item', title: 'Text Only', creator: 'Someone' }
                        ] }
                    })
                });
            }
            if (String(url).includes('/metadata/coldplay-yellow')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        metadata: { creator: 'Coldplay' },
                        files: [
                            { name: 'cover.jpg', format: 'JPEG' },
                            { name: 'yellow.mp3', format: 'VBR MP3', size: 5000, length: '210.5' },
                            { name: 'yellow.ogg', format: 'Ogg Vorbis', size: 8000 }
                        ],
                        d1: 210
                    })
                });
            }
            // item without playable audio
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ metadata: {}, files: [{ name: 'a.txt', format: 'Text' }] }) });
        };

        const results = await MusicSearch.search('yellow coldplay');
        const y = results.find((r) => r.dedupeKey === 'coldplay-yellow');
        assert(!!y, 'doc with audio resolved');
        // The provider strips the "Collection: " prefix so the track title is
        // the song name and the artist comes from the creator field.
        assert(y.title === 'Yellow', 'title normalized (prefix stripped)');
        assert(y.artist === 'Coldplay', 'artist normalized');
        assert(y.source === 'Internet Archive', 'source set');
        assert(y.playableUrl === 'https://archive.org/download/coldplay-yellow/yellow.mp3', 'MP3 preferred as playableUrl');
        assert(y.duration === 210.5, 'duration from file length');
        assert(y.pageUrl === 'https://archive.org/details/coldplay-yellow', 'pageUrl set');
        const noAudio = results.find((r) => r.dedupeKey === 'no-audio-item');
        assert(!!noAudio && noAudio.playableUrl === null, 'item without audio → unavailable (playableUrl null)');
        assert(results.filter((r) => r.playableUrl).length === 1, 'only playable items carry URLs');
    });

    await test('registry dedupes + provider failure does not fail search', async () => {
        sandbox.fetch = (url) => {
            if (String(url).includes('advancedsearch')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ response: { docs: [
                        { identifier: 'dup-a', title: 'Dup' },
                        { identifier: 'dup-b', title: 'Dup' }
                    ] } })
                });
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ metadata: {}, files: [{ name: 'x.mp3', format: 'VBR MP3', length: '10' }] }) });
        };
        const results = await MusicSearch.search('dup');
        assert(results.length === 2, 'two distinct identifiers kept');
        sandbox.fetch = () => Promise.reject(new Error('network down'));
        const empty = await MusicSearch.search('anything');
        assert(empty.length === 0, 'fetch failure → empty result, no throw');
    });

    // ===========================================================================
    console.log('\n== MusicPlayerService: shuffle & repeat (Phase 5 Premium) ==');

    await test('setShuffle builds a deterministic play order anchored at current', async () => {
        const p = new Player();
        p.setQueue([T1, T2, T3], 0);
        p.setShuffle(true, () => 0);
        assert(p.shuffle === true, 'shuffle flag on');
        // rng()=>0 gives order [anchor=0, 2, 1]
        assert(p._order.join(',') === '0,2,1', 'play order keeps current first, shuffles rest');
        p.setShuffle(false);
        assert(p._order.join(',') === '0,1,2', 'shuffle off → identity order');
        p.destroy();
    });

    await test('next() follows the shuffled order', async () => {
        const p = new Player();
        p.setQueue([T1, T2, T3], 0);
        p.setShuffle(true, () => 0);
        await p.next();
        assert(p.index === 2, 'next went to order position 1 (index 2)');
        p.destroy();
    });

    await test('cycleRepeat walks off → all → one → off', async () => {
        const p = new Player();
        assert(p.cycleRepeat() === 'all', 'off → all');
        assert(p.cycleRepeat() === 'one', 'all → one');
        assert(p.cycleRepeat() === 'off', 'one → off');
        p.destroy();
    });

    await test('repeat one: ended re-plays the same track', async () => {
        const p = new Player();
        p.setQueue([T1, T2], 0);
        p.setRepeat('one');
        await p.playIndex(0);
        const before = p._audio._playCount;
        p._audio._fire('ended');
        assert(p.index === 0, 'stays on the same track');
        assert(p.snapshot().playing === true, 'still playing');
        assert(p._audio._playCount > before, 'audio re-played');
        p.destroy();
    });

    await test('repeat all: ended wraps to the start of the order', async () => {
        const p = new Player();
        p.setQueue([T1, T2], 0);
        p.setRepeat('all');
        await p.playIndex(1);
        p._audio._fire('ended');
        assert(p.index === 0, 'wrapped to order head');
        p.destroy();
    });

    await test('repeat off: end of queue emits the end event and stops', async () => {
        const p = new Player();
        let ended = 0;
        p.on('end', () => { ended++; });
        p.setQueue([T1, T2], 0);
        await p.playIndex(1);
        p._audio._fire('ended');
        assert(ended === 1, 'end event emitted');
        assert(p.snapshot().playing === false, 'stopped at end');
        p.destroy();
    });

    await test('getAudioElement exposes the single audio + crossOrigin for analyser', async () => {
        const p = new Player();
        const a = p.getAudioElement();
        assert(a === p._audio, 'exposes the live audio element');
        assert(a.crossOrigin === 'anonymous', 'crossOrigin set for CORS-clean analysis');
        p.destroy();
    });

    // ===========================================================================
    console.log('\n== music-search: normalizeQuery (Phase 5 Premium) ==');

    await test('normalizeQuery folds Persian/Arabic alternate spellings + diacritics', async () => {
        assert(normalizeQ('Yellow') === 'yellow', 'lowercases');
        assert(normalizeQ('Café') === 'cafe', 'strips diacritics');
        assert(normalizeQ('دیوار') === 'دیوار', 'keeps Persian text');
        assert(normalizeQ('يوسف') === 'یوسف', 'ي → ی');
        assert(normalizeQ('كامل') === 'کامل', 'ك → ک');
        assert(normalizeQ('أحمد إبراهيم آدم') === 'احمد ابراهیم ادم', 'أ/إ/آ → ا + ي → ی');
        assert(normalizeQ('  Hello،  world! ') === 'hello world', 'punctuation → space, trimmed');
        assert(normalizeQ('x'.repeat(300)).length === 120, 'capped at 120');
    });

    // ===========================================================================
    console.log('\n== MusicRoom utils (Phase 5 Premium) ==');

    await test('pushRecent dedupes by key, newest first, capped', async () => {
        let list = U.pushRecent([], T1, 20);
        list = U.pushRecent(list, T1, 20);
        assert(list.length === 1, 'duplicate collapsed');
        list = U.pushRecent(list, T2, 2);
        list = U.pushRecent(list, T3, 2);
        assert(list.length === 2, 'capped at 2');
        assert(list[0].dedupeKey === 'id3', 'newest first');
        assert(list[0].playedAt > 0, 'playedAt stamped');
    });

    await test('upsertContinue updates the resume point in place', async () => {
        let list = U.upsertContinue([], T1, 30, 6);
        assert(list.length === 1 && list[0].resumeAt === 30, 'first entry');
        list = U.upsertContinue(list, T1, 75, 6);
        assert(list.length === 1 && list[0].resumeAt === 75, 'resume point updated in place');
        list = U.upsertContinue(list, T2, 10, 1);
        assert(list.length === 1 && list[0].dedupeKey === 'id2', 'limit applied');
    });

    await test('samplePalette returns dominant colors, skipping near-black/white', async () => {
        const px = new Uint8ClampedArray(48 * 48 * 4);
        for (let i = 0; i < px.length; i += 4) {
            px[i] = i % 8 === 0 ? 255 : 0;      // mostly red
            px[i + 1] = i % 3 === 0 ? 255 : 0;  // some green
            px[i + 2] = i % 13 === 0 ? 255 : 0; // some blue
            px[i + 3] = 255;
        }
        const pal = U.samplePalette(px, 48, 48, 3);
        assert(pal.length === 3, 'returns requested count');
        assert(pal[0][0] > pal[0][1] && pal[0][0] > pal[0][2], 'red dominates');
        const dark = new Uint8ClampedArray(48 * 48 * 4);
        dark.fill(0);
        const fallback = U.samplePalette(dark, 48, 48, 3);
        assert(fallback.length === 3, 'near-black input falls back gracefully');
    });

    await test('fmtTime / fmtRemaining formatting', async () => {
        assert(U.fmtTime(125) === '2:05', 'fmtTime m:ss');
        assert(U.fmtRemaining(185) === '−3:05', 'fmtRemaining minus-prefixed');
        assert(U.fmtRemaining(0) === '0:00', 'fmtRemaining zero');
    });

    // ===========================================================================
    // Music Room UI isolation (regression): the Music Room must never touch
    // global layout — no fixed overlays, no unscoped selectors, no
    // document.body/:root writes, and every overlay must be inside #musicPage.
    // ===========================================================================

    await test('music-room.css has no position:fixed overlays', async () => {
        const css = fs.readFileSync('music-room.css', 'utf8');
        assert(!css.includes('position: fixed'), 'no fixed positioning anywhere');
        assert(css.split('{').length === css.split('}').length, 'braces balanced');
    });

    await test('music-room.css selectors are all scoped', async () => {
        const css = fs.readFileSync('music-room.css', 'utf8');
        const bad = [];
        css.split('\n').forEach((line) => {
            const t = line.trim();
            if (!t || t.startsWith('@') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('//')) return;
            const open = t.indexOf('{');
            if (open < 0) return; // continuation / closing line
            t.slice(0, open).split(',').forEach((selRaw) => {
                const s = selRaw.trim();
                if (!s) return;
                if (/^\d/.test(s) || s === 'from' || s === 'to') return; // keyframe steps
                const m = s.match(/^([.#]?[a-zA-Z][\w-]*)/);
                const first = m ? m[1] : s;
                const ok = first.indexOf('.music') === 0 || first === '.mini-player' || first === '#musicPage' ||
                    s.startsWith('.page[data-page="music"]');
                if (!ok) bad.push(s);
            });
        });
        assert(bad.length === 0, 'unscoped selectors: ' + bad.slice(0, 5).join(' | '));
        assert(!/\.np-[a-z]/.test(css), 'no leftover .np- classes');
    });

    await test('music-room.js never writes to document.body / :root', async () => {
        const js = fs.readFileSync('music-room.js', 'utf8');
        assert(!js.includes('document.body.appendChild'), 'no body append');
        assert(!js.includes('document.body.style'), 'no body style writes');
        assert(!js.includes('document.documentElement.style'), 'no :root style writes');
        assert(js.includes('host.appendChild(menu)'), 'more menu mounts inside the page');
    });

    await test('index.html mounts all Music overlays inside #musicPage', async () => {
        const html = fs.readFileSync('index.html', 'utf8');
        const idx = (id) => html.indexOf('id="' + id + '"');
        assert(idx('musicPage') > -1, 'musicPage exists');
        const profile = html.indexOf('data-page="profile"');
        ['musicQueueSheet', 'musicNowPlaying', 'musicSleepSheet', 'musicEqSheet'].forEach((id) => {
            const i = idx(id);
            assert(i > idx('musicPage') && i < profile, id + ' must be inside #musicPage');
        });
        assert(!html.includes('class="np-'), 'no leftover np- classes in HTML');
    });

    // ===========================================================================
    console.log('\n== music-search: relevance, transliteration & playability (Phase 5.5 fix) ==');

    const normM = sandbox.window.MusicSearch.normalizeMusicQuery;
    const translit = sandbox.window.MusicSearch.transliteratePersian;
    const variants = sandbox.window.MusicSearch.buildSearchVariants;
    const looksPlay = sandbox.window.MusicSearch.looksPlayableUrl;
    const scoreT = sandbox.window.MusicSearch.scoreTrack;
    const rankF = sandbox.window.MusicSearch.rankAndFilter;
    const buildCtx = sandbox.window.MusicSearch.buildQueryContext;

    await test('normalizeMusicQuery: Persian variants, zero-width, diacritics', () => {
        assert(normM('\u200fابی\u200f') === 'ابی', 'strips bidi/zero-width around Persian');
        assert(normM('ابي') === 'ابی', 'ي → ی');
        assert(normM('كامل') === 'کامل', 'ك → ک');
        assert(normM('نشرة') === 'نشره', 'ة → ه');
        assert(normM('Hello, World!') === 'hello world', 'punctuation folded');
        assert(normM('Coldplay\u200cYellow') === 'coldplay yellow', 'ZWNJ → space');
        assert(normM('Delbar — Ebi') === 'delbar ebi', 'em dash → space');
        assert(normM('   A  B\tC  ') === 'a b c', 'whitespace collapsed');
        assert(normM('x'.repeat(300)).length === 120, 'capped at 120');
    });

    await test('transliteratePersian: ابی yields Ebi variants', () => {
        const t = translit('ابی');
        assert(t.some((x) => x.toLowerCase() === 'ebi'), 'contains Ebi: ' + t.join(','));
        assert(t.some((x) => x.toLowerCase() === 'abi'), 'contains abi variant');
        assert(translit('Coldplay').length === 0, 'Latin input → no transliteration');
    });

    await test('transliteratePersian: محسن چاوشی yields Mohsen Chavoshi alias', () => {
        const t = translit('محسن چاوشی');
        assert(t.some((x) => x.toLowerCase() === 'mohsen chavoshi'), 'alias present');
    });

    await test('transliteratePersian: ستاره های سربی yields compact setarehaye sorbi', () => {
        const t = translit('ستاره های سربی');
        assert(t.some((x) => x.toLowerCase() === 'setarehaye sorbi'), 'compact merged form present: ' + t.join(','));
        assert(t.some((x) => x.toLowerCase() === 'setareh haye sorbi'), 'spaced form present too');
    });

    await test('scoreTrack: Setarehaye Sorbi title matches Persian query via compact translit', () => {
        const ctx = buildCtx('ستاره های سربی');
        const s = scoreT({ title: 'Ebi - Setarehaye Sorbi', artist: 'Ebi', audioEvidence: true, playableUrl: 'https://x/s.mp3' }, ctx);
        assert(s.score >= 55, 'compact translit phrase matched title, got ' + s.score);
    });

    await test('buildSearchVariants: bounded, original first, Latin added for Persian', () => {
        const v = variants('ابی');
        assert(v[0] === 'ابی', 'original query first');
        assert(v.some((x) => x.toLowerCase() === 'ebi'), 'Latin variant added');
        assert(v.length <= 6, 'bounded at 6, got ' + v.length);
        assert(variants('Coldplay Yellow').length === 1, 'Latin query stays single variant');
    });

    await test('scoreTrack: "Ebi" + "Ebi - Delbar" scores very high', () => {
        const ctx = buildCtx('Ebi');
        const s = scoreT({ title: 'Delbar — Ebi', artist: 'Ebi', audioEvidence: true, playableUrl: 'https://x/ebi.mp3' }, ctx);
        assert(s.score >= 150, 'high relevance, got ' + s.score);
    });

    await test('scoreTrack: "Ebi" + "SA\'AD BIN ABI WAQAS" is irrelevant', () => {
        const ctx = buildCtx('Ebi');
        const s = scoreT({
            title: "SA' AD BIN ABI WAQAS", artist: 'Islam', audioEvidence: true,
            playableUrl: 'https://x/a.mp3', _description: ['islamic documentary']
        }, ctx);
        assert(s.score < 55, 'low relevance, got ' + s.score);
    });

    await test('scoreTrack: no false positives — "ebi" never matches "abi waqas"', () => {
        const ctx = buildCtx('ebi');
        const s = scoreT({ title: 'Life of Companions', artist: 'Abi Waqas', audioEvidence: true, playableUrl: 'https://x/a.mp3' }, ctx);
        assert(s.score < 55, 'word-boundary match only, got ' + s.score);
    });

    await test('scoreTrack: Persian query matches Persian artist/title', () => {
        const ctx = buildCtx('ابی');
        const s = scoreT({ title: 'ابی', artist: 'ابی', audioEvidence: true, playableUrl: 'https://x/b.mp3' }, ctx);
        assert(s.score >= 150, 'high score, got ' + s.score);
    });

    await test('scoreTrack: ستاره های سربی title match scores high', () => {
        const ctx = buildCtx('ستاره های سربی');
        const s = scoreT({ title: 'ستاره های سربی', artist: 'محسن چاوشی', audioEvidence: true, playableUrl: 'https://x/s.mp3' }, ctx);
        assert(s.score >= 100, 'high score, got ' + s.score);
    });

    await test('scoreTrack: Arabic lecture containing ابی is filtered out', () => {
        const ctx = buildCtx('ابی');
        const s = scoreT({
            title: 'محاضرة حول ابی واقص', artist: 'شيخ', audioEvidence: true,
            playableUrl: 'https://x/l.mp3', _description: ['islamic lecture']
        }, ctx);
        assert(s.score < 55, 'low score, got ' + s.score);
    });

    await test('scoreTrack: title-anchored token (Ebi HEZARO YEK SHAB) stays relevant', () => {
        const ctx = buildCtx('ebi');
        const s = scoreT({ title: 'Ebi HEZARO YEK SHAB', artist: null, audioEvidence: true, playableUrl: 'https://x/e.mp3' }, ctx);
        assert(s.score >= 55, 'kept (token anchors title start), got ' + s.score);
    });

    await test('scoreTrack: lone token buried mid-title (سنن ابی داود) is filtered', () => {
        const ctx = buildCtx('ابی');
        const s = scoreT({ title: 'سنن ابی داود', artist: null, audioEvidence: true, playableUrl: 'https://x/h.mp3' }, ctx);
        assert(s.score < 55, 'filtered (mid-phrase Arabic title), got ' + s.score);
    });

    await test('scoreTrack: Persian artist query matches Latin artist alias phrase', () => {
        const ctx = buildCtx('محسن چاوشی');
        const s = scoreT({ title: 'Peyman', artist: 'Mohsen Chavoshi', audioEvidence: true, playableUrl: 'https://x/m.mp3' }, ctx);
        assert(s.score >= 55, 'multi-word translit matched artist, got ' + s.score);
    });

    await test('rankAndFilter: dedupes same identifier from multiple variants', () => {
        const ctx = buildCtx('Ebi');
        const out = rankF([
            { title: 'Delbar', artist: 'Ebi', dedupeKey: 'item1', playableUrl: 'https://x/1.mp3', audioEvidence: true },
            { title: 'Delbar', artist: 'Ebi', dedupeKey: 'item1', playableUrl: 'https://x/1.mp3', audioEvidence: true },
            { title: 'Ebi Concert', artist: 'Ebi', dedupeKey: 'item2', playableUrl: 'https://x/2.mp3', audioEvidence: true }
        ], ctx);
        assert(out.results.filter((r) => r.dedupeKey === 'item1').length === 1, 'duplicate collapsed');
        assert(out.rawCount === 2 && out.relevantCount === 2, 'counts correct after dedupe (3 → 2 unique)');
    });

    await test('looksPlayableUrl: audio accepted, non-audio rejected', () => {
        assert(looksPlay('https://x/song.mp3') === true, 'mp3 ok');
        assert(looksPlay('https://x/song.m4a?token=1') === true, 'm4a with query ok');
        assert(looksPlay('https://x/song.ogg') === true, 'ogg ok');
        assert(looksPlay('https://x/notes.pdf') === false, 'pdf no');
        assert(looksPlay('https://x/readme.html') === false, 'html no');
        assert(looksPlay('https://x/a.txt') === false, 'txt no');
        assert(looksPlay(null) === false && looksPlay('') === false, 'missing url no');
    });

    await test('rankAndFilter: distinct states empty/filtered/noplayable/ok', () => {
        const ctx = buildCtx('Ebi');
        assert(rankF([], ctx).state === 'empty', 'no provider results');
        const junk = [{ title: 'Lecture on birds', artist: 'Z', playableUrl: 'https://x/a.mp3', audioEvidence: true, _description: ['lecture series'] }];
        assert(rankF(junk, ctx).state === 'filtered', 'found but none relevant');
        const noPlay = [{ title: 'Ebi Live', artist: 'Ebi', playableUrl: null, audioEvidence: false }];
        assert(rankF(noPlay, ctx).state === 'noplayable', 'relevant but none playable');
        const ok = [{ title: 'Delbar', artist: 'Ebi', playableUrl: 'https://x/1.mp3', audioEvidence: true }];
        assert(rankF(ok, ctx).state === 'ok', 'good result');
    });

    await test('probePlayable: confirms real audio via HEAD, rejects 404', async () => {
        const realFetch = sandbox.fetch;
        sandbox.fetch = (url, init) => {
            if (init && init.method === 'HEAD') {
                return Promise.resolve({ status: 206, headers: { get: () => 'audio/mpeg' } });
            }
            return Promise.resolve({ status: 200, headers: { get: () => 'text/html' } });
        };
        try {
            const ok = await sandbox.window.MusicSearch.probePlayable('https://x/a.mp3');
            assert(ok && ok.ok === true, 'audio HEAD accepted');
            sandbox.fetch = () => Promise.resolve({ status: 404, headers: { get: () => 'text/html' } });
            const bad = await sandbox.window.MusicSearch.probePlayable('https://x/missing.mp3');
            assert(bad && bad.ok === false, '404 rejected');
        } finally {
            sandbox.fetch = realFetch;
        }
    });

    // ===========================================================================
    // ===========================================================================
    console.log('\n== music-search: multi-provider manager (Phase 6) ==');

    const MusicProviderManager = sandbox.window.MusicSearch.MusicProviderManager;
    const buildSearchVariants = sandbox.window.MusicSearch.buildSearchVariants;
    const MusicSearchProvider = sandbox.window.MusicSearch.MusicSearchProvider;
    const normalizeTrack = sandbox.window.MusicSearch.normalizeTrack;
    const dedupeKeyFor = sandbox.window.MusicSearch.dedupeKeyFor;
    const nextPlayableSource = sandbox.window.MusicSearch.nextPlayableSource;

    const Mgr = () => new MusicProviderManager({ poolLimit: 3, cacheTtlMs: 60000, deadlineMs: 2000 });

    function fakeProvider(id, label, opts) {
        const o = opts || {};
        const p = new MusicSearchProvider(label, id);
        p.timeoutMs = o.timeoutMs || 200;
        p.preferredQueryKinds = o.kinds || ['original'];
        p.searchTracks = async (query) => {
            if (o.throwError) throw new Error(o.throwError);
            if (o.hang) return new Promise(() => { /* never resolves */ });
            const items = o.items ? (typeof o.items === 'function' ? o.items(query) : o.items) : [];
            return items.map((it) => normalizeTrack(it, { id, label }));
        };
        return p;
    }

    await test('normalizeTrack: common shape + legacy aliases', () => {
        const t = normalizeTrack(
            { id: 7, title: 'Delbar', artist: 'Ebi', audioUrl: 'https://x/delbar.mp3', cover: 'https://x/c.jpg', duration: 210 },
            { id: 'melobit', label: 'Melobit' }
        );
        assert(t.provider === 'melobit' && t.playableUrl === 'https://x/delbar.mp3', 'provider + legacy playableUrl');
        assert(t.audioUrl === t.streamUrl && t.playable === true && t.downloadable === true, 'audio/stream/download flags');
        assert(t.coverUrl === 'https://x/c.jpg' && t.artworkUrl === t.coverUrl, 'cover + legacy artworkUrl');
        assert(t.source === 'Melobit' && t.duration === 210, 'source label + duration');
        assert(t.audioEvidence === true && t.sources.length === 0, 'audio evidence + empty sources');
        const bad = normalizeTrack({ title: 'X' }, { id: 'x' });
        assert(bad.playable === false && bad.playableUrl === null, 'no URL → not playable, null URL');
    });

    await test('dedupeKeyFor: artist+title key, never provider id alone', () => {
        const a = dedupeKeyFor({ title: 'Delbar', artist: 'Ebi', provider: 'melobit', id: 'm1' });
        const b = dedupeKeyFor({ title: 'Delbar', artist: 'ebi', provider: 'internet-archive', id: 'ia1' });
        assert(a === b, 'same normalized artist+title → same key across providers');
        const c = dedupeKeyFor({ title: 'Delbar', artist: 'Googoosh', provider: 'melobit' });
        assert(a !== c, 'different artist → different key');
    });

    await test('manager: register/enable/disable/priority ordering', () => {
        const m = Mgr();
        m.registerProvider(fakeProvider('aa', 'AA', { items: [] }));
        m.registerProvider(fakeProvider('bb', 'BB', { items: [] }));
        m.setPriority('aa', 10);
        m.setPriority('bb', 90);
        assert(m.orderedProviders().map((p) => p.id).join(',') === 'bb,aa', 'priority desc order');
        m.disable('bb');
        assert(m.orderedProviders().map((p) => p.id).join(',') === 'aa', 'disabled provider excluded');
        m.enable('bb');
        assert(m.isEnabled('bb') && m.getProvider('bb') !== null, 're-enabled + lookup');
    });

    await test('manager: failure isolation — one provider failing never breaks others', async () => {
        const m = Mgr();
        m.registerProvider(fakeProvider('good', 'Good', { items: [{ title: 'Delbar', artist: 'Ebi', audioUrl: 'https://x/d.mp3' }] }));
        m.registerProvider(fakeProvider('bad', 'Bad', { throwError: 'boom' }));
        m.registerProvider(fakeProvider('good2', 'Good2', { items: [{ title: 'Sekke', artist: 'Ebi', audioUrl: 'https://x/s.mp3' }] }));
        const ctx = buildCtx('ebi');
        const out = await m.searchOthers('ebi', ctx, buildSearchVariants('ebi'), 'nope');
        assert(out.length === 2, '2 providers survived, got ' + out.length);
        const diag = m.diagnostics().find((d) => d.id === 'bad');
        assert(diag && diag.failures === 1 && diag.lastError === 'boom', 'failure recorded for bad provider');
    });

    await test('manager: provider timeout — hanging provider never blocks others', async () => {
        const m = new MusicProviderManager({ poolLimit: 3, cacheTtlMs: 60000, deadlineMs: 3000, timeoutMs: { hang: 80 } });
        m.registerProvider(fakeProvider('hang', 'Hang', { hang: true }));
        m.registerProvider(fakeProvider('fast', 'Fast', { items: [{ title: 'Delbar', artist: 'Ebi', audioUrl: 'https://x/d.mp3' }] }));
        const t0 = Date.now();
        const out = await m.searchOthers('ebi', buildCtx('ebi'), buildSearchVariants('ebi'), 'nope');
        const ms = Date.now() - t0;
        assert(out.length === 1, 'fast provider result returned');
        assert(ms < 2000, 'search finished quickly (' + ms + 'ms)');
        const d = m.diagnostics().find((x) => x.id === 'hang');
        assert(d && d.failures >= 1, 'hang provider recorded a failure');
    });

    await test('manager: malformed provider response is skipped, not fatal', async () => {
        const m = Mgr();
        m.registerProvider(fakeProvider('weird', 'Weird', { items: 'not-an-array' }));
        m.registerProvider(fakeProvider('ok', 'Ok', { items: [{ title: 'X', artist: 'Ebi', audioUrl: 'https://x/x.mp3' }] }));
        const out = await m.searchOthers('x', buildCtx('x'), buildSearchVariants('x'), 'nope');
        assert(out.length === 1, 'malformed provider dropped, good provider kept');
    });

    await test('manager: same track from 2 providers → 1 result with 2 sources', async () => {
        const m = Mgr();
        m.setPriority('ia', 100);
        m.setPriority('melo', 50);
        m.registerProvider(fakeProvider('ia', 'IA', { items: [{ title: 'Setarehaye Sorbi', artist: 'Ebi', audioUrl: 'https://ia/s.mp3' }] }));
        m.registerProvider(fakeProvider('melo', 'Melo', { items: [{ title: 'Setarehaye Sorbi', artist: 'Ebi', audioUrl: 'https://melo/s.mp3' }] }));
        const out = await m.searchOthers('sorbi', buildCtx('sorbi'), buildSearchVariants('sorbi'), 'nope');
        assert(out.length === 1, 'deduped to one result, got ' + out.length);
        assert(out[0].sources.length === 2, 'two sources kept, got ' + out[0].sources.length);
        assert(out[0].playableUrl === 'https://ia/s.mp3', 'primary source = highest priority (ia)');
    });

    await test('manager+rank: playable source beats metadata-only source for same track', async () => {
        const m = Mgr();
        m.registerProvider(fakeProvider('meta', 'Meta', { items: [{ title: 'Delbar', artist: 'Ebi' }] }));
        m.registerProvider(fakeProvider('play', 'Play', { items: [{ title: 'Delbar', artist: 'Ebi', audioUrl: 'https://x/d.mp3' }] }));
        const merged = await m.searchOthers('ebi', buildCtx('ebi'), buildSearchVariants('ebi'), 'nope');
        assert(merged.length === 1, 'merged to one result');
        assert(merged[0].playableUrl === 'https://x/d.mp3', 'playable source promoted to primary');
        const out = rankF(merged, buildCtx('ebi'));
        assert(out.results.length === 1 && out.state === 'ok', 'playable result survives ranking');
    });

    await test('rankAndFilter: exact artist outranks description-only match', () => {
        const ctx = buildCtx('ebi');
        const out = rankF([
            { title: 'Lecture series', artist: 'Someone', playableUrl: 'https://x/l.mp3', audioEvidence: true, _description: ['ebi is mentioned in this series'] },
            { title: 'Delbar', artist: 'Ebi', playableUrl: 'https://x/d.mp3', audioEvidence: true }
        ], ctx);
        assert(out.results.length === 1, 'only the artist match is relevant');
        assert(out.results[0].artist === 'Ebi', 'exact artist result first/only');
    });

    await test('nextPlayableSource: returns alternate source, then null', () => {
        const track = {
            playableUrl: 'https://a/1.mp3',
            sources: [
                { provider: 'ia', playable: true, audioUrl: 'https://a/1.mp3' },
                { provider: 'melo', playable: true, audioUrl: 'https://b/2.mp3' },
                { provider: 'codebazan', playable: false, audioUrl: 'https://c/3.mp3' }
            ]
        };
        assert(nextPlayableSource(track, 'https://a/1.mp3') === 'https://b/2.mp3', 'second source picked');
        assert(nextPlayableSource(track, new Set(['https://a/1.mp3', 'https://b/2.mp3'])) === null, 'exhausted → null');
        assert(nextPlayableSource({ playableUrl: 'https://a/1.mp3' }, 'https://a/1.mp3') === null, 'no sources → null');
    });

    await test('manager: cache avoids a second provider fetch within TTL', async () => {
        const m = Mgr();
        let calls = 0;
        m.registerProvider(fakeProvider('cached', 'Cached', {
            items: () => { calls += 1; return [{ title: 'Delbar', artist: 'Ebi', audioUrl: 'https://x/d.mp3' }]; }
        }));
        const ctx = buildCtx('ebi');
        await m.searchOthers('ebi', ctx, buildSearchVariants('ebi'), 'nope');
        await m.searchOthers('ebi', ctx, buildSearchVariants('ebi'), 'nope');
        assert(calls === 1, 'second search served from cache, calls=' + calls);
    });

    await test('manager: variants per provider preference (original vs latin)', async () => {
        let seen = [];
        const m = Mgr();
        const p = fakeProvider('v', 'V', { items: (q) => { seen.push(q); return []; } });
        m.registerProvider(p);
        const ctx = buildCtx('ابی');
        const variants = buildSearchVariants('ابی');
        await m.searchOthers('ابی', ctx, variants, 'nope');
        assert(seen.some((s) => s === 'ابی'), 'original variant used: ' + seen.join(','));
        seen = [];
        p.preferredQueryKinds = ['latin'];
        await m.searchOthers('ابی', ctx, variants, 'nope');
        assert(seen.length > 0 && !seen.some((s) => s === 'ابی') && /^[a-z]/i.test(seen[0]), 'latin variant used: ' + seen.join(','));
    });

    await test('registry: all seven providers registered with priority config', () => {
        const M = sandbox.window.MusicSearch;
        const ids = M.manager.providers.map((p) => p.id).sort();
        assert(ids.join(',') === 'ahangify,codebazan,codebazan-rjavan,direct-audio,internet-archive,melobit,melodify', 'registered: ' + ids.join(','));
        assert(M.manager.config.priority['codebazan-rjavan'] === 110 && M.manager.config.priority['internet-archive'] === 100 && M.manager.config.priority.melobit === 90, 'priority config present');
        assert(M.manager.isEnabled('codebazan-rjavan') && M.manager.isEnabled('melobit') && !M.manager.isEnabled('direct-audio'), 'enable flags default');
    });

    await test('searchSmart: all providers failing → graceful unavailable state', async () => {
        const out = await sandbox.window.MusicSearch.searchSmart('ebi');
        assert(out && typeof out.state === 'string', 'returns a state');
        assert(out.state === 'unavailable' || out.state === 'empty', 'graceful state, got ' + out.state);
        assert(Array.isArray(out.providers) && out.providers.length >= 5, 'diagnostics attached');
    });

    // ---------------------------------------------------------------------------
    console.log('\n== music-search: performance safeguards (Phase 6.5) ==');

    await test('manager: failure cooldown — recently failed provider is not re-queried', async () => {
        const m = new MusicProviderManager({ poolLimit: 3, cacheTtlMs: 60000, deadlineMs: 2000, cooldownMs: 60000 });
        m.registerProvider(fakeProvider('bad', 'Bad', { throwError: 'boom' }));
        m.registerProvider(fakeProvider('good', 'Good', { items: [{ title: 'Delbar', artist: 'Ebi', audioUrl: 'https://x/d.mp3' }] }));
        const ctx = buildCtx('ebi');
        const variants = buildSearchVariants('ebi');
        await m.searchOthers('ebi', ctx, variants, 'nope');
        const out2 = await m.searchOthers('ebi', ctx, variants, 'nope');
        assert(out2.length === 1, 'healthy provider still returns results');
        const d = m.diagnostics().find((x) => x.id === 'bad');
        assert(d.searches === 1, 'failed provider queried only once (cooldown), searches=' + d.searches);
        assert(d.failures === 1 && /cooling down/.test(d.lastError || ''), 'cooldown surfaced in diagnostics: ' + d.lastError);
        assert(d.coolingDown === true, 'coolingDown flag set');
    });

    await test('searchSmart: identical query served from short-lived cache', async () => {
        const realFetch = sandbox.fetch;
        let advCalls = 0;
        sandbox.fetch = (url, init) => {
            if (String(url).includes('advancedsearch')) {
                advCalls++;
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ response: { docs: [
                    { identifier: 'delbar-cache-track', title: 'Ebi: Delbar', creator: 'Ebi' }
                ] } }) });
            }
            if (String(url).includes('/metadata/')) {
                return Promise.resolve({ ok: true, json: () => Promise.resolve({
                    metadata: { creator: 'Ebi' },
                    files: [{ name: 'delbar.mp3', format: 'VBR MP3', size: 4000, length: '200.5' }]
                }) });
            }
            if (init && init.method === 'HEAD') {
                return Promise.resolve({ status: 206, headers: { get: () => 'audio/mpeg' } });
            }
            return Promise.reject(new Error('unexpected fetch: ' + String(url).slice(0, 80)));
        };
        try {
            const first = await sandbox.window.MusicSearch.searchSmart('delbar');
            assert(first.state === 'ok' && first.results.length >= 1, 'first search resolved, state=' + first.state);
            const afterFirst = advCalls;
            const second = await sandbox.window.MusicSearch.searchSmart('delbar');
            assert(advCalls === afterFirst, 'no re-fetch on cached query (adv=' + advCalls + ' vs ' + afterFirst + ')');
            assert(second.results.length === first.results.length, 'cached result shape matches');
        } finally {
            sandbox.fetch = realFetch;
        }
    });

    await test('searchSmart: IA variants fetched concurrently (bounded pool) + early stop', async () => {
        const realFetch = sandbox.fetch;
        const reg = sandbox.window.MusicSearch;
        const ia = reg.manager.getProvider('internet-archive');
        const realIds = ia.searchIdentifiers;
        const realResolve = ia.resolveTrack;
        let active = 0, maxActive = 0, calls = 0;
        ia.searchIdentifiers = async () => {
            active++; if (active > maxActive) maxActive = active;
            calls++;
            await new Promise((r) => setTimeout(r, 40));
            active--;
            return [{ identifier: 'c' + calls, title: 'Concqueries Track ' + calls, creator: 'Some Artist' }];
        };
        ia.resolveTrack = async (doc) => ({
            title: doc.title, artist: doc.creator, provider: 'Internet Archive',
            providerId: 'internet-archive', source: 'Internet Archive',
            playableUrl: 'https://x/' + doc.identifier + '.mp3', dedupeKey: doc.identifier,
            audioEvidence: true, _description: [], _collection: []
        });
        sandbox.fetch = (url, init) => {
            if (init && init.method === 'HEAD') return Promise.resolve({ status: 206, headers: { get: () => 'audio/mpeg' } });
            return Promise.reject(new Error('unexpected fetch: ' + String(url).slice(0, 60)));
        };
        try {
            const out = await reg.searchSmart('concqueries');
            assert(out.state === 'ok' && out.results.length >= 1, 'results produced, state=' + out.state);
            assert(calls >= 2 && calls <= 4, 'variant searches ran, calls=' + calls);
            assert(maxActive >= 2, 'variants overlapped (parallel), maxActive=' + maxActive);
            assert(maxActive <= 2, 'pool bounded at 2, maxActive=' + maxActive);
        } finally {
            ia.searchIdentifiers = realIds;
            ia.resolveTrack = realResolve;
            sandbox.fetch = realFetch;
        }
    });

    // ---------------------------------------------------------------------------
    console.log('\n== music-search: CodeBazan → Radio Javan provider (Phase 7) ==');

    const CodeBazanRjavanProvider = sandbox.window.MusicSearch.CodeBazanRjavanProvider;
    assert(typeof CodeBazanRjavanProvider === 'function', 'rjavan provider class exported');

    const rjSample = {
        id: 52642,
        title: 'Ebi - "Hamin Khoobe (Ft Shadmehr Aghili)"',
        artist: 'Ebi',
        song: 'Hamin Khoobe (Ft Shadmehr Aghili)',
        duration: 300.121,
        photo: 'https://assets.rjassets.com/static/mp3/x/65b035226b6171c.jpg',
        thumbnail: 'https://assets.rjassets.com/static/mp3/x/65b035226b6171c-thumb.jpg',
        link: 'https://host1.media-rj.com/media/mp3/mp3-256/52642-becdc8d090175a7.mp3',
        hls_link: 'https://host1.media-rj.com/media/hls/52642.m3u8',
        lq_link: 'https://host1.media-rj.com/media/mp3/mp3-128/52642.mp3',
        hq_link: 'https://host1.media-rj.com/media/mp3/mp3-320/52642.mp3',
        artist_farsi: 'ابی',
        song_farsi: 'همین خوبه شادمهر عقیلی',
        plays: '38,602,084',
        likes: '31,927'
    };

    function mockRjFetch(handler) {
        return (url, init) => {
            const u = String(url);
            if (u.indexOf('rjavan') !== -1) return handler(u, init);
            if (init && init.method === 'HEAD') return Promise.resolve({ status: 206, headers: { get: () => 'audio/mpeg' } });
            return Promise.reject(new Error('unexpected fetch: ' + u.slice(0, 80)));
        };
    }

    await test('rjavan: searchTracks normalizes real response into LoveHub shape', async () => {
        const realFetch = sandbox.fetch;
        sandbox.fetch = mockRjFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ mp3s: [rjSample] }) }));
        try {
            const p = new CodeBazanRjavanProvider();
            const tracks = await p.searchTracks('ebi');
            assert(tracks.length === 1, 'one track returned');
            const t = tracks[0];
            assert(t.provider === 'codebazan-rjavan' && t.providerId === 'codebazan-rjavan' && t.source === 'Radio Javan', 'provider ids');
            assert(t.title === 'Hamin Khoobe (Ft Shadmehr Aghili)', 'clean song title, got: ' + t.title);
            assert(t.artist === 'Ebi', 'artist');
            assert(t.duration === 300.121, 'duration');
            assert(t.coverUrl === rjSample.photo && t.artworkUrl === rjSample.photo, 'cover');
            assert(t.audioUrl === rjSample.link && t.playableUrl === rjSample.link, 'direct mp3 as audioUrl');
            assert(t.playable === true && t.sourceType === 'direct-audio', 'playable + sourceType');
            assert(t.downloadable === false, 'not advertised as downloadable');
            assert(t.metadata.artist_farsi === 'ابی' && t.metadata.song_farsi === 'همین خوبه شادمهر عقیلی', 'farsi metadata kept');
            assert(t.metadata.rjId === '52642' && /hls/.test(t.metadata.hls_link) && t.metadata.hq_link, 'extra metadata kept');
        } finally { sandbox.fetch = realFetch; }
    });

    await test('rjavan: getTrack(id) resolves via ?id= endpoint', async () => {
        const realFetch = sandbox.fetch;
        sandbox.fetch = mockRjFetch((u) => Promise.resolve({ ok: true, json: () => Promise.resolve(u.indexOf('id=') !== -1 ? rjSample : { mp3s: [] }) }));
        try {
            const p = new CodeBazanRjavanProvider();
            const t = await p.getTrack('52642');
            assert(t && t.id === '52642' && t.artist === 'Ebi' && t.playable === true, 'track resolved by id');
            const none = await p.getTrack(null);
            assert(none === null, 'null id → null');
        } finally { sandbox.fetch = realFetch; }
    });

    await test('rjavan: search works for required Persian/Latin queries (mocked)', async () => {
        const realFetch = sandbox.fetch;
        sandbox.fetch = mockRjFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ mp3s: [rjSample] }) }));
        try {
            const p = new CodeBazanRjavanProvider();
            const queries = ['ابی', 'Ebi', 'گوگوش', 'محسن چاوشی', 'mohsen chavoshi', 'ستاره های سربی'];
            for (const q of queries) {
                const tracks = await p.searchTracks(q);
                assert(tracks.length >= 1 && tracks[0].playable, q + ' → playable result');
            }
        } finally { sandbox.fetch = realFetch; }
    });

    await test('rjavan: Adele query does not rank Adel Esmaeilpour as an exact artist match', () => {
        const ctx = buildCtx('Adele');
        const adel = {
            title: 'Miras', artist: 'Adel Esmaeilpour',
            playableUrl: 'https://host2.media-rj.com/media/mp3/mp3-256/80427-93b10cbf568036f.mp3',
            audioEvidence: true
        };
        const s = scoreT(adel, ctx);
        assert(s.score < sandbox.window.MusicSearch.RELEVANCE_MIN, 'Adel Esmaeilpour below relevance threshold (' + s.score + ')');
        const out = rankF([adel, { title: 'Hello', artist: 'Adele', playableUrl: 'https://x/hello.mp3', audioEvidence: true }], ctx);
        assert(out.results.length === 1 && out.results[0].artist === 'Adele', 'only exact Adele match survives');
    });

    await test('rjavan: cross-provider dedupe — RJ + IA same song → one result, 2 sources, RJ primary', async () => {
        const realFetch = sandbox.fetch;
        sandbox.fetch = mockRjFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ mp3s: [Object.assign({}, rjSample, { song: 'Delbar', title: 'Ebi - "Delbar"', link: 'https://host1.media-rj.com/media/mp3/mp3-256/999-delbar.mp3' })] }) }));
        try {
            const m = new MusicProviderManager({ poolLimit: 3, cacheTtlMs: 60000, deadlineMs: 3000, timeoutMs: { 'codebazan-rjavan': 800 } });
            m.registerProvider(new CodeBazanRjavanProvider());
            m.registerProvider(fakeProvider('internet-archive', 'IA', { items: [{ title: 'Delbar', artist: 'Ebi', audioUrl: 'https://ia/delbar.mp3' }] }));
            const ctx = buildCtx('delbar');
            const out = await m.searchOthers('delbar', ctx, buildSearchVariants('delbar'), 'nope');
            assert(out.length === 1, 'deduped to one result, got ' + out.length);
            assert(out[0].sources.length === 2, 'two sources kept');
            assert(out[0].playableUrl === 'https://host1.media-rj.com/media/mp3/mp3-256/999-delbar.mp3', 'RJ primary (priority 110)');
            const next = nextPlayableSource(out[0], out[0].playableUrl);
            assert(next === 'https://ia/delbar.mp3', 'playback fallback → IA source');
        } finally { sandbox.fetch = realFetch; }
    });

    await test('rjavan: failure isolation — RJ timeout/500/malformed never breaks IA', async () => {
        const realFetch = sandbox.fetch;
        try {
            const modes = ['timeout', '500', 'malformed'];
            for (const mode of modes) {
                sandbox.fetch = (url, init) => {
                    const u = String(url);
                    if (u.indexOf('rjavan') !== -1) {
                        if (mode === 'timeout') return new Promise((res, rej) => setTimeout(() => rej(new Error('network timeout')), 40));
                        if (mode === '500') return Promise.resolve({ ok: false, status: 500 });
                        return Promise.resolve({ ok: true, json: () => Promise.resolve({ unexpected: true }) });
                    }
                    if (init && init.method === 'HEAD') return Promise.resolve({ status: 206, headers: { get: () => 'audio/mpeg' } });
                    return Promise.reject(new Error('unexpected fetch: ' + u.slice(0, 80)));
                };
                const m = new MusicProviderManager({ poolLimit: 3, cacheTtlMs: 60000, deadlineMs: 3000, timeoutMs: { 'codebazan-rjavan': 60 } });
                m.registerProvider(new CodeBazanRjavanProvider());
                m.registerProvider(fakeProvider('internet-archive', 'IA', { items: [{ title: 'Delbar', artist: 'Ebi', audioUrl: 'https://ia/d.mp3' }] }));
                const out = await m.searchOthers('delbar', buildCtx('delbar'), buildSearchVariants('delbar'), 'nope');
                assert(out.length >= 1 && out[0].playableUrl === 'https://ia/d.mp3', 'IA result survived rjavan ' + mode);
                if (mode !== 'malformed') {
                    const d = m.diagnostics().find((x) => x.id === 'codebazan-rjavan');
                    assert(d && d.failures >= 1, 'rjavan failure recorded for ' + mode);
                }
            }
        } finally { sandbox.fetch = realFetch; }
    });

    await test('rjavan: Persian query matches Farsi artist metadata (شادمهر case)', () => {
        // rjavan returns Latin artist + Farsi artist_farsi; the transliteration
        // 'shadmhr' does not match 'Shadmehr', so the Farsi field must provide
        // the artist evidence.
        const ctx = buildCtx('شادمهر');
        const t = {
            title: 'Mamnoon', artist: 'Shadmehr Aghili',
            artist_farsi: 'شادمهر عقیلی', song_farsi: 'ممنون',
            playableUrl: 'https://host2.media-rj.com/media/mp3/mp3-256/152298-x.mp3',
            audioEvidence: true
        };
        const s = scoreT(t, ctx);
        assert(s.score >= sandbox.window.MusicSearch.RELEVANCE_MIN, 'Farsi artist match is relevant (' + s.score + ')');
        const out = rankF([t], ctx);
        assert(out.results.length === 1 && out.state === 'ok', 'survives ranking');
    });

    await test('merge: higher-priority rjavan source becomes primary even when IA arrives first', async () => {
        const realFetch = sandbox.fetch;
        sandbox.fetch = mockRjFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ mp3s: [Object.assign({}, rjSample, { song: 'Delbar', title: 'Ebi - "Delbar"', link: 'https://host1.media-rj.com/media/mp3/mp3-256/999-delbar.mp3' })] }) }));
        try {
            const m = new MusicProviderManager({ poolLimit: 3, cacheTtlMs: 60000, deadlineMs: 3000, timeoutMs: { 'codebazan-rjavan': 800 } });
            m.registerProvider(new CodeBazanRjavanProvider());
            m.registerProvider(fakeProvider('internet-archive', 'IA', { items: [{ title: 'Delbar', artist: 'Ebi', audioUrl: 'https://ia/delbar.mp3' }] }));
            const ctx = buildCtx('delbar');
            const out = await m.searchOthers('delbar', ctx, buildSearchVariants('delbar'), 'nope');
            assert(out.length === 1 && out[0].sources.length === 2, 'merged result with both sources');
            assert(out[0].playableUrl === 'https://host1.media-rj.com/media/mp3/mp3-256/999-delbar.mp3', 'rjavan primary by priority');
            assert(out[0].artist_farsi === 'ابی' && out[0].song_farsi === 'همین خوبه شادمهر عقیلی', 'Farsi metadata folded into primary');
        } finally { sandbox.fetch = realFetch; }
    });

    // ---------------------------------------------------------------------------
    console.log('\n== Phase 8 QA: unified normalization + player transport ==');

    await test('IA resolveTrack emits the unified LoveHub track shape', async () => {
        const IA = sandbox.window.MusicSearch.InternetArchiveProvider;
        const realFetch = sandbox.fetch;
        sandbox.fetch = (url) => {
            const u = String(url);
            if (u.indexOf('advancedsearch') !== -1) {
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ response: { docs: [] } }) });
            }
            if (u.indexOf('/metadata/') !== -1) {
                return Promise.resolve({ ok: true, json: () => Promise.resolve({
                    metadata: { creator: 'Ebi' },
                    files: [{ name: 'delbar.mp3', format: 'VBR MP3', size: 4000, length: '200.5' }]
                }) });
            }
            return Promise.reject(new Error('unexpected fetch: ' + u.slice(0, 60)));
        };
        try {
            const p = new IA();
            const t = await p.resolveTrack({ identifier: 'ebi-delbar', title: 'Ebi: Delbar', creator: 'Ebi' });
            assert(t && t.provider === 'internet-archive' && t.providerId === 'internet-archive', 'provider ids');
            assert(t.playable === true && t.downloadable === true, 'unified playable/downloadable flags');
            assert(t.audioUrl === t.playableUrl && /delbar\.mp3$/.test(t.playableUrl), 'audioUrl + legacy playableUrl');
            assert(t.coverUrl === t.artworkUrl && /services\/img/.test(t.coverUrl), 'coverUrl + legacy artworkUrl');
            assert(t.sourceType === 'archive-stream' && t.metadata && t.metadata.label === 'Internet Archive', 'sourceType + metadata');
            assert(t.duration === 200.5 && t.streamUrl === t.audioUrl, 'duration + streamUrl');
            assert(t.title === 'Delbar' && t.artist === 'Ebi', 'title cleaned of Artist: prefix, artist kept');
        } finally { sandbox.fetch = realFetch; }
    });

    await test('player: resume continues from the same position', async () => {
        const p = new Player();
        await p.loadTrack(T1);
        p.pause();
        p._audio.currentTime = 42;
        await p.play();
        const s = p.snapshot();
        assert(s.playing === true, 'resumed playing');
        assert(s.time === 42, 'position preserved (' + s.time + ')');
        p.destroy();
    });

    await test('player: ended advances to the next track', async () => {
        const p = new Player();
        p.setQueue([T1, T2], 0);
        await p.loadTrack(T1);
        p._audio._fire('ended');
        assert(p.index === 1, 'index advanced to 1');
        assert(p.current && p.current.dedupeKey === 'id2', 'next track loaded');
        p.destroy();
    });

    await test('player: ended at queue end (repeat off) stops cleanly + emits end', async () => {
        const p = new Player();
        let endCount = 0;
        p.on('end', () => { endCount++; });
        p.setQueue([T1], 0);
        await p.loadTrack(T1);
        p._audio._fire('ended');
        assert(endCount === 1, 'end event emitted');
        assert(p.snapshot().playing === false, 'stopped (not playing)');
        p.destroy();
    });

    await test('player: repeat one replays the same track from the top', async () => {
        const p = new Player();
        p.setRepeat('one');
        await p.loadTrack(T1);
        p.seek(30);
        const before = p._audio._playCount;
        p._audio._fire('ended');
        assert(p.current && p.current.dedupeKey === 'id1', 'same track kept');
        assert(p._audio.currentTime === 0, 'seeked back to 0');
        assert(p._audio._playCount >= before + 1, 'replayed');
        p.destroy();
    });

    await test('player: playback error — one silent retry, then user-facing error (no loop)', async () => {
        const p = new Player();
        let errEvt = null;
        p.on('error', (e) => { errEvt = e; });
        await p.loadTrack(T1);
        p._audio.error = { code: 4 };
        p._audio._fire('error');
        assert(p._retried === 1, 'one silent retry attempted');
        assert(p._audio._playCount >= 1, 'retry re-issued play');
        p._audio._fire('error');
        assert(p._retried === 1, 'no second silent retry (cap reached)');
        assert(p.error === 'Stream unavailable', 'user-facing error state');
        assert(p.snapshot().playing === false, 'stopped');
        assert(errEvt && errEvt.retryable === true, 'retryable error event emitted');
        p.destroy();
    });

    console.log('\nResults:', passes, 'passed,', failures, 'failed');
    process.exit(failures ? 1 : 0);
}

main().catch((e) => {
    console.error('Test harness crashed:', e);
    process.exit(1);
});
