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
    console.log('\nResults:', passes, 'passed,', failures, 'failed');
    process.exit(failures ? 1 : 0);
}

main().catch((e) => {
    console.error('Test harness crashed:', e);
    process.exit(1);
});
