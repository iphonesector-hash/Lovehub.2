// ===========================================================================
// music-search.js — Phase 5.2 / 5.3: provider-based web music search.
//
// Design rules (from the phase spec):
//   * No SoundCloud/Spotify/Apple paid API is required. The default provider
//     searches the Internet Archive — a public, CORS-open library of mostly
//     public-domain / Creative-Commons audio — and returns direct stream URLs
//     the in-app player can play without leaving LoveHub.
//   * The UI never knows where a result came from: every provider returns
//     normalized { title, artist, source, pageUrl, playableUrl, artworkUrl,
//     duration }. Only playableUrl is used by the player.
//   * A result WITHOUT a playableUrl is surfaced as "not playable here" — we
//     never try to bypass DRM, paywalls, login walls or anti-bot protections,
//     and we never download or store third-party audio.
//   * All external metadata is UNTRUSTED. Consumers must render it with
//     textContent (or escapeHtml) — never innerHTML.
//
// Smart search layer (Phase 5.5 fix):
//   * normalizeMusicQuery() — robust Persian/Arabic + diacritic + zero-width
//     + whitespace/punctuation folding.
//   * transliteratePersian() — small deterministic Persian → Latin utility
//     (plus a tiny curated artist-alias map used ONLY for query expansion,
//     never as metadata claims).
//   * buildSearchVariants() — bounded set of query strings (original, Latin,
//     artist-hinted) so one user search stays cheap.
//   * scoreTrack() — field-aware relevance scoring (artist > title > album >
//     description), with heavy penalties for lectures/sermons/audiobooks and
//     for description-only incidental matches. Word-boundary matching, so
//     "ebi" never matches "abi waqas".
//   * looksPlayableUrl() / probePlayable() — a result is only listed as
//     playable when its URL is a supported audio format AND (for the top
//     candidates) the server actually answers with an audio content type.
//   * searchSmart() — variants → dedupe → rank → resolve metadata only for
//     the best candidates → validate playability. Returns
//     { results, state, rawCount, relevantCount, playableCount,
//       nonPlayableCount, query } where state ∈
//     'ok' | 'empty' | 'filtered' | 'noplayable' | 'error'.
//
// Adding a future API provider (e.g. Jamendo with an API key) is a matter of
// subclassing MusicSearchProvider and registering it in MusicSearchRegistry.
// ===========================================================================

(function () {
    'use strict';

    const DEFAULT_TIMEOUT_MS = 12000;
    const MAX_VARIANTS = 6;            // variants generated (bounded)
    const MAX_VARIANTS_SEARCHED = 4;   // provider searches per user query
    const MAX_DOCS = 40;               // identifier-level candidates kept
    const PRE_RESOLVE = 14;            // metadata resolved for best candidates
    const MAX_RESULTS = 20;            // results returned to the UI
    const PROBE_LIMIT = 4;             // playability probes per search
    const RELEVANCE_MIN = 55;          // minimum score to be "relevant"

    // Browser-playable audio formats. Anything else (or no extension) is
    // never offered as a playable stream.
    const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'webm', 'flac']);
    const BAD_EXT = /\.(html?|pdf|txt|xml|json|gif|jpe?g|png|svg|zip|tar|gz|7z|md5|sha1|ffp|log|m3u|m3u8|torrent|rar|exe)$/i;

    // Content that is almost never what a music search wants, unless the user
    // explicitly searches for it. Checked against title, description and
    // collection — never alone; a title like "Radioactive" must stay safe, so
    // title hits are penalized lightly and description/collection hits hard.
    const NON_MUSIC_TERMS = [
        'lecture', 'sermon', 'khutbah', 'khutba', 'khutbeh', 'tafsir', 'quran',
        'quranic', 'surah', 'sura', 'dua', 'duaa', 'dhikr', 'zikr', 'namaz',
        'worship', 'recitation', 'tilawat', 'naat', 'hamd', 'manqabat',
        'marsia', 'audiobook', 'audio book', 'podcast', 'documentary',
        'interview', 'speech', 'speeches', 'lesson', 'lessons', 'tutorial',
        'course', 'dars', 'waaz', 'waz', 'bayan', 'majlis', 'pravachan',
        'katha', 'bible', 'scripture', 'preaching', 'preach', 'debate',
        'radio show', 'radio program', 'talk show', 'tv show',
        'hadith', 'sunan', 'musnad', 'sahih', 'riyad', 'sunna', 'sunnah',
        'درس', 'محاضرة', 'خطبة', 'خطبه', 'تلاوت', 'قرآن', 'قران', 'سوره',
        'سورة', 'تفسیر', 'تفسير', 'دعاء', 'وعظ', 'نعت', 'منقبت', 'مقتل',
        'حدیث', 'حديث', 'سنن', 'صحیح', 'مسند', 'سیرت', 'سيرة'
    ];
    const NON_MUSIC_TOKEN_SET = new Set(NON_MUSIC_TERMS);
    const escapeReg = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const NON_MUSIC_RE = new RegExp('\\b(?:' + NON_MUSIC_TERMS.map(escapeReg).join('|') + ')\\b', 'i');

    // Strip control characters and cap length — the only "sanitization" the
    // search input needs (it is only ever passed to a URL query parameter,
    // never executed or rendered as HTML).
    function sanitizeQuery(q) {
        return String(q == null ? '' : q)
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);
    }

    // Robust query normalization: lowercase, fold Persian/Arabic alternate
    // spellings (ي/ى→ی, ك→ک, ة→ه, أ/إ/آ→ا), strip combining marks, Arabic
    // diacritics and zero-width/bidi controls, and collapse whitespace and
    // punctuation. Persian half-space (U+200C / ZWNJ) becomes a normal space
    // so "ستارههای" and "ستاره های" compare equal.
    function normalizeMusicQuery(q) {
        return String(q == null ? '' : q)
            .toLowerCase()
            .replace(/[\u200b\u200e-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
            // Fold precomposed Persian/Arabic variants BEFORE decomposition, so
            // أ/إ/آ become plain ا instead of alef + a combining hamza.
            .replace(/[يى]/g, 'ی')
            .replace(/ك/g, 'ک')
            .replace(/ة/g, 'ه')
            .replace(/[أإآ]/g, 'ا')
            .normalize('NFKD')
            // Strip Latin combining marks + Arabic diacritics (harakat, tanwin,
            // shadda, maddah…).
            .replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, '')
            // Persian half-space / joiner → space.
            .replace(/[\u200c\u200d]/g, ' ')
            .replace(/[.,،!؟?;:'"()\[\]{}«»“”‘’\u2013\u2014\-_/\\|~`@#$%^&*+=<>]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);
    }

    // Backwards-compatible alias used by earlier phases and tests.
    const normalizeQuery = normalizeMusicQuery;

    // Deterministic Persian → Latin transliteration (character map + a few
    // safe word rules). Only used to BUILD extra query strings and to match
    // artist/title fields on word boundaries. Never claims to be accurate
    // IPA — it is a conservative search aid. Word rules:
    //   * final ه → "e"  (silent -e, e.g. ستاره → stare)
    //   * initial ی → "y", otherwise ی → "i"
    //   * و → "v" at word start, otherwise "o" (e.g. چاوشی → chaoshi)
    //   * token "های" → "haye"
    const P2L = {
        'آ': 'a', 'ا': 'a', 'ب': 'b', 'پ': 'p', 'ت': 't', 'ث': 's', 'ج': 'j',
        'چ': 'ch', 'ح': 'h', 'خ': 'kh', 'د': 'd', 'ذ': 'z', 'ر': 'r', 'ز': 'z',
        'ژ': 'zh', 'س': 's', 'ش': 'sh', 'ص': 's', 'ض': 'z', 'ط': 't', 'ظ': 'z',
        'ع': '', 'غ': 'gh', 'ف': 'f', 'ق': 'gh', 'ک': 'k', 'گ': 'g', 'ل': 'l',
        'م': 'm', 'ن': 'n', 'و': 'v', 'ه': 'h', 'ی': 'i', 'ي': 'i', 'ئ': 'i', 'ء': ''
    };

    // Tiny curated Latin spellings for well-known artists — used ONLY as
    // query-expansion aliases, never as metadata claims.
    const KNOWN_ARTIST_LATIN = {
        'ابی': ['Ebi'],
        'محسن چاوشی': ['Mohsen Chavoshi'],
        'چاوشی': ['Chavoshi'],
        'گوگوش': ['Googoosh'],
        'داریوش': ['Dariush'],
        'همایون شجریان': ['Homayoun Shajarian'],
        'شجریان': ['Shajarian']
    };

    // A few well-established Latin spellings for common Persian words whose
    // unwritten short vowels the character map cannot recover (e.g. ستاره =
    // setareh, not "stare"). Used ONLY to build better query strings — never
    // as metadata claims.
    const P2L_WORD = {
        'ستاره': 'setareh',
        'سربی': 'sorbi',
        'عشق': 'eshgh',
        'شب': 'shab',
        'باران': 'baran',
        'دل': 'del'
    };

    function transliteratePersian(text) {
        const norm = normalizeMusicQuery(text);
        if (!norm || !/[\u0600-\u06ff]/.test(norm)) return [];
        const found = [];
        const push = (s) => {
            const c = String(s).replace(/\s+/g, ' ').trim();
            if (c && !found.some((x) => x.toLowerCase() === c.toLowerCase())) found.push(c);
        };
        // Curated aliases first (most reliable for famous artists).
        Object.keys(KNOWN_ARTIST_LATIN).forEach((k) => {
            if (norm.includes(k)) KNOWN_ARTIST_LATIN[k].forEach(push);
        });
        const words = norm.split(' ').filter(Boolean);
        const base = words.map((w) => {
            if (P2L_WORD[w]) return P2L_WORD[w];
            if (w === 'های') return 'haye';
            let out = '';
            for (let i = 0; i < w.length; i++) {
                const ch = w[i];
                let mapped = P2L[ch] !== undefined ? P2L[ch] : '';
                if (ch === 'و') mapped = i === 0 ? 'v' : 'o';
                else if (ch === 'ی' && i === 0) mapped = 'y';
                else if (ch === 'ه' && i === w.length - 1 && w.length > 1) mapped = 'e';
                out += mapped;
            }
            return out || 'a';
        }).filter(Boolean);
        if (!base.length) return found;
        const joined = base.join(' ');
        push(joined);
        // Compact form: the Persian plural "های" merges with the previous word
        // in common Latin spellings (ستاره های سربی → "setarehaye sorbi").
        // A doubled ه/ح collapses (setareh + haye → setarehaye).
        const compact = [];
        let merged = false;
        for (let i = 0; i < base.length; i++) {
            const w = base[i];
            if (w === 'haye' && compact.length) {
                const prev = compact[compact.length - 1];
                compact[compact.length - 1] = prev.endsWith('h') ? prev.slice(0, -1) + 'haye' : prev + 'haye';
                merged = true;
            } else {
                compact.push(w);
            }
        }
        if (merged) push(compact.join(' '));
        // Initial alif is frequently pronounced "e" in Persian — offer one
        // variant ("ابی" → "abi" and "ebi").
        if (base[0].startsWith('a')) {
            push('e' + base[0].slice(1) + (base.length > 1 ? ' ' + base.slice(1).join(' ') : ''));
        }
        // Word-final "i" is often written "y" in Latin transliterations.
        push(base.map((w) => (w.endsWith('i') && w.length > 1 ? w.slice(0, -1) + 'y' : w)).join(' '));
        return found;
    }

    // Bounded set of query strings for the provider. Preserves the original
    // query (providers may match it better than a normalized one).
    function buildSearchVariants(q) {
        const out = [];
        const push = (s) => {
            const c = sanitizeQuery(s);
            if (c && !out.some((x) => x.toLowerCase() === c.toLowerCase())) out.push(c);
        };
        push(q);
        push(normalizeMusicQuery(q));
        const translits = transliteratePersian(q);
        translits.forEach((t) => push(t));
        const isSingleWord = normalizeMusicQuery(q).split(' ').filter(Boolean).length === 1;
        if (translits.length) {
            push(translits[0] + ' Persian');
            push(translits[0] + ' singer');
        } else if (isSingleWord) {
            // Single-word Latin query — broaden slightly so more of the
            // artist's own items surface from the provider.
            push(q + ' singer');
            push(q + ' music');
        }
        return out.slice(0, MAX_VARIANTS);
    }

    function buildQueryContext(q) {
        const norm = normalizeMusicQuery(q);
        const tokens = norm ? norm.split(' ').filter(Boolean) : [];
        const hasPersian = /[\u0600-\u06ff]/.test(q);
        const translits = hasPersian ? transliteratePersian(q).map((t) => t.toLowerCase()) : [];
        const tokensAreNonMusic = tokens.some((t) => NON_MUSIC_TOKEN_SET.has(t));
        return { q, norm, tokens, hasPersian, translits, tokensAreNonMusic };
    }

    function fetchJson(url, timeoutMs) {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || DEFAULT_TIMEOUT_MS) : null;
        return fetch(url, { signal: ctrl ? ctrl.signal : undefined })
            .then((res) => {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .finally(() => { if (timer) clearTimeout(timer); });
    }

    // -----------------------------------------------------------------------
    // Playability validation
    // -----------------------------------------------------------------------

    // Synchronous, extension-based check. A URL is only playable when it is
    // http(s) and its path ends in a supported audio extension.
    function looksPlayableUrl(url) {
        if (!url || typeof url !== 'string') return false;
        if (!/^https?:\/\//i.test(url)) return false;
        // Pathname only (strip query/hash) — no URL global dependency so the
        // utility works in any JS environment.
        const path = String(url).split(/[?#]/, 1)[0];
        if (BAD_EXT.test(path)) return false;
        const m = path.match(/\.([a-z0-9]{2,5})$/i);
        if (!m) return false;
        return AUDIO_EXT.has(m[1].toLowerCase());
    }

    // Optional live check: HEAD the stream (fall back to a byte-range GET
    // whose body is immediately cancelled) and confirm the server answers
    // with a 2xx/416 status and an audio content type.
    // Returns { ok: true } | { ok: false, reason } | { ok: null, reason }
    // where ok:null means "could not verify" (network/CORS) — the caller then
    // keeps the extension-based decision instead of hiding a legit result.
    async function probePlayable(url, timeoutMs) {
        if (!looksPlayableUrl(url)) return { ok: false, reason: 'unsupported-extension' };
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || 5000) : null;
        const doFetch = (init) => fetch(url, Object.assign({ signal: ctrl ? ctrl.signal : undefined }, init));
        try {
            let res = await doFetch({ method: 'HEAD' });
            let usedRange = false;
            if (res.status === 405 || res.status === 400 || res.status === 403) {
                res = await doFetch({ headers: { Range: 'bytes=0-0' } });
                usedRange = true;
                if (res.body && res.body.cancel) res.body.cancel(); // stop the download early
            }
            const ct = (res.headers.get('content-type') || '').toLowerCase();
            if (res.status !== 200 && res.status !== 206 && res.status !== 416) {
                return { ok: false, reason: 'HTTP ' + res.status };
            }
            if (usedRange && res.status === 200) {
                return { ok: null, reason: 'no-range' }; // can't verify without downloading
            }
            if (ct && ct.indexOf('audio/') !== 0 && ct.indexOf('octet-stream') === -1) {
                return { ok: false, reason: 'content-type ' + ct };
            }
            return { ok: true, contentType: ct };
        } catch (e) {
            return { ok: null, reason: 'network' };
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    // -----------------------------------------------------------------------
    // Relevance scoring
    // -----------------------------------------------------------------------

    // Field-aware relevance. ctx comes from buildQueryContext(). Matching is
    // token/word-boundary based, so a query token never matches inside an
    // unrelated word ("ebi" ≠ "abi", "waqas", "debit"…).
    function scoreTrack(track, ctx) {
        const reasons = [];
        let score = 0;

        const title = normalizeMusicQuery(track.title || '');
        const artist = normalizeMusicQuery(track.artist || '');
        const desc = normalizeMusicQuery((track._description || []).join(' '));
        const coll = normalizeMusicQuery((track._collection || []).join(' '));
        const titleWords = title ? title.split(' ') : [];
        const artistWords = artist ? artist.split(' ') : [];
        const descWords = desc ? desc.split(' ') : [];
        const q = ctx.norm;
        const qTokens = ctx.tokens || [];
        const translits = ctx.translits || [];

        // --- non-music content --------------------------------------------
        // A deliberate query for such content disables the penalty.
        const nmTitle = !ctx.tokensAreNonMusic && NON_MUSIC_RE.test(title);
        const nmBody = !ctx.tokensAreNonMusic && NON_MUSIC_RE.test(desc + ' ' + coll);
        if (nmBody) { score -= 140; reasons.push('non-music content'); }
        if (nmTitle) { score -= 25; reasons.push('non-music title hint'); }

        // --- artist signals (strongest) ------------------------------------
        const allQInArtist = qTokens.length > 0 && qTokens.every((t) => artistWords.includes(t));
        const anyQInArtist = qTokens.some((t) => artistWords.includes(t));
        if (artist && artist === q) { score += 120; reasons.push('artist exact'); }
        else if (allQInArtist) { score += qTokens.length > 1 ? 95 : 85; reasons.push('artist full'); }
        else if (anyQInArtist) { score += 55; reasons.push('artist partial'); }
        // Transliteration matching. Single-word translits match a word
        // (exact, or a prefix within a couple of chars); multi-word translits
        // (e.g. "mohsen chavoshi") must match as a contiguous phrase.
        const trMatches = (words) => translits.some((tr) => {
            if (!tr) return false;
            const trWords = tr.split(' ');
            if (trWords.length === 1) {
                return words.some((w) =>
                    w === tr || (w.length >= tr.length && w.length <= tr.length + 2 && w.startsWith(tr))
                );
            }
            for (let i = 0; i + trWords.length <= words.length; i++) {
                let ok = true;
                for (let j = 0; j < trWords.length; j++) {
                    if (words[i + j] !== trWords[j]) { ok = false; break; }
                }
                if (ok) return true;
            }
            return false;
        });
        if (trMatches(artistWords)) { score += 60; reasons.push('artist translit'); }

        // --- title signals --------------------------------------------------
        const allQInTitle = qTokens.length > 0 && qTokens.every((t) => titleWords.includes(t));
        const anyQInTitle = qTokens.some((t) => titleWords.includes(t));
        if (title && title === q) { score += 100; reasons.push('title exact'); }
        else if (allQInTitle) { score += 65; reasons.push('title full'); }
        else if (anyQInTitle) { score += 30; reasons.push('title partial'); }
        if (trMatches(titleWords)) { score += 40; reasons.push('title translit'); }

        // Single-word artist-style queries need artist OR transliteration
        // evidence, or a title where the token anchors the title (first/last
        // word — "Ebi HEZARO YEK SHAB"). A lone token buried mid-phrase in an
        // Arabic/Persian title (e.g. "ابی" inside "سنن ابی داود") is weak
        // evidence of relevance and is penalized.
        const isSingleToken = qTokens.length === 1;
        if (isSingleToken && !anyQInArtist && !trMatches(artistWords) && !trMatches(titleWords) && !(title === q)) {
            const titleIdx = titleWords.indexOf(qTokens[0]);
            const anchored = titleWords.length > 0 && (titleIdx === 0 || titleIdx === titleWords.length - 1);
            if (!anchored) {
                score -= 60;
                reasons.push('no artist/translit evidence');
            }
        }

        // --- weak signals ---------------------------------------------------
        if (qTokens.length && qTokens.some((t) => coll.split(' ').includes(t))) {
            score += 12; reasons.push('collection');
        }
        // A query token found ONLY in the description is usually incidental
        // (e.g. "Ebi" mentioned in a show notes blurb) — penalize.
        const qInDescOnly = qTokens.filter((t) => descWords.includes(t)).length;
        if (qInDescOnly && !anyQInArtist && !anyQInTitle) {
            score -= 60; reasons.push('description-only match');
        }

        // --- audio / playability evidence -----------------------------------
        if (track.audioEvidence) { score += 15; reasons.push('audio evidence'); }
        if (track.playableUrl) {
            if (looksPlayableUrl(track.playableUrl)) { score += 12; reasons.push('playable'); }
            else { score -= 30; reasons.push('non-audio file'); }
        }

        // --- artist + title combo -------------------------------------------
        if (anyQInArtist && anyQInTitle) { score += 20; reasons.push('artist+title'); }

        return { score, reasons };
    }

    function dedupeTracks(list) {
        const seen = new Set();
        const out = [];
        for (const t of list) {
            if (!t) continue;
            const key = t.dedupeKey || t.playableUrl || t.pageUrl || t.title;
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(t);
        }
        return out;
    }

    // Pure pipeline: score → filter irrelevant → split playable → rank.
    // state ∈ 'ok' | 'empty' | 'filtered' | 'noplayable'.
    function rankAndFilter(tracks, queryOrCtx) {
        const ctx = typeof queryOrCtx === 'string' ? buildQueryContext(queryOrCtx) : queryOrCtx;
        tracks = dedupeTracks(tracks || []); // one stable identifier → one result
        const rawCount = tracks.length;
        const scored = tracks
            .map((t) => ({ track: t, ...scoreTrack(t, ctx) }))
            .sort((a, b) => b.score - a.score);
        const relevant = scored.filter((s) => s.score >= RELEVANCE_MIN);
        const playable = relevant.filter((s) => s.track.playableUrl && looksPlayableUrl(s.track.playableUrl));
        const results = playable.slice(0, MAX_RESULTS).map((s) => {
            if (s.track) s.track._score = Math.round(s.score);
            return s.track;
        });
        let state = 'ok';
        if (rawCount === 0) state = 'empty';
        else if (relevant.length === 0) state = 'filtered';
        else if (playable.length === 0) state = 'noplayable';
        return {
            results,
            state,
            rawCount,
            relevantCount: relevant.length,
            playableCount: playable.length,
            nonPlayableCount: relevant.length - playable.length,
            query: ctx.q
        };
    }

    // -----------------------------------------------------------------------
    // Base provider contract
    // -----------------------------------------------------------------------
    class MusicSearchProvider {
        constructor(name) {
            this.name = name || 'provider';
        }
        isAvailable() { return true; }
        async searchIdentifiers(query) { throw new Error('searchIdentifiers() not implemented'); }
        async resolveTrack(doc) { throw new Error('resolveTrack() not implemented'); }
    }

    // -----------------------------------------------------------------------
    // Internet Archive — keyless, CORS-open, legitimate public audio.
    // -----------------------------------------------------------------------
    class InternetArchiveProvider extends MusicSearchProvider {
        constructor() { super('Internet Archive'); }

        // Cheap identifier-level search: one advancedsearch request, no
        // metadata. Returns docs with title/creator/description/collection so
        // relevance can be judged before paying for metadata calls.
        async searchIdentifiers(query) {
            const q = sanitizeQuery(query);
            if (!q) return [];
            const nq = normalizeQuery(query);
            const searchUrl = 'https://archive.org/advancedsearch.php?q=' +
                encodeURIComponent((nq || q) + ' AND mediatype:(audio)') +
                '&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=description&fl[]=collection' +
                '&sort[]=downloads+desc&rows=24&page=1&output=json';
            const json = await fetchJson(searchUrl);
            return (json && json.response && json.response.docs) || [];
        }

        // Resolve one search hit into a normalized track. The metadata call
        // finds a concrete audio FILE (MP3 preferred, Ogg as fallback) whose
        // direct download URL is the playableUrl. No DRM/paywall bypass is
        // involved — these are openly downloadable files.
        async resolveTrack(doc) {
            const identifier = doc.identifier;
            if (!identifier) return null;

            let meta = null;
            try {
                meta = await fetchJson('https://archive.org/metadata/' + encodeURIComponent(identifier));
            } catch (e) { /* metadata is optional — the item may still be browsable */ }

            const files = (meta && meta.files) || [];
            const audio = files.filter((f) =>
                f && f.format && /MP3|Ogg Vorbis/.test(f.format) &&
                !BAD_EXT.test(f.name || '')
            );
            audio.sort((a, b) => {
                const aIsMp3 = /mp3/i.test(a.format || '');
                const bIsMp3 = /mp3/i.test(b.format || '');
                if (aIsMp3 !== bIsMp3) return aIsMp3 ? -1 : 1;
                return (a.size || 0) - (b.size || 0);
            });
            const pick = audio[0];

            const rawTitle = (doc.title || identifier || '').replace(/^.+:\s*/, '').trim().slice(0, 200);
            let creator = doc.creator || (meta && meta.metadata && meta.metadata.creator) || '';
            if (Array.isArray(creator)) creator = creator[0] || '';
            creator = String(creator).slice(0, 200);

            const duration = pick && pick.length ? Number(pick.length)
                : (meta && (Number(meta.d1) || Number(meta.d2))) || null;

            const description = doc.description;
            const metaColl = meta && meta.metadata && meta.metadata.collection;
            const docColl = Array.isArray(doc.collection) ? doc.collection : (doc.collection ? [doc.collection] : []);
            const metaCollArr = Array.isArray(metaColl) ? metaColl : (metaColl ? [metaColl] : []);
            const collArr = docColl.concat(metaCollArr);

            return {
                title: rawTitle || identifier,
                artist: creator || null,
                source: 'Internet Archive',
                pageUrl: 'https://archive.org/details/' + encodeURIComponent(identifier),
                playableUrl: pick
                    ? ('https://archive.org/download/' + encodeURIComponent(identifier) + '/' + encodeURIComponent(pick.name))
                    : null,
                artworkUrl: 'https://archive.org/services/img/' + encodeURIComponent(identifier),
                duration: isFinite(duration) ? duration : null,
                provider: this.name,
                dedupeKey: identifier,
                // internal signals used by scoring (never rendered)
                audioEvidence: audio.length > 0,
                _description: Array.isArray(description) ? description.slice(0, 3) : (description ? [description] : []),
                _collection: collArr.slice(0, 6),
                _fileExt: pick ? ((pick.name.match(/\.([a-z0-9]{2,5})$/i) || [])[1] || '').toLowerCase() : ''
            };
        }

        // Backwards-compatible full search used by the plain search() API.
        async search(query) {
            const docs = await this.searchIdentifiers(query);
            const settled = await Promise.allSettled(docs.slice(0, 10).map((d) => this.resolveTrack(d)));
            return settled
                .filter((r) => r.status === 'fulfilled')
                .map((r) => r.value)
                .filter(Boolean);
        }
    }

    // -----------------------------------------------------------------------
    // DirectAudioProvider — reserved for a future curated/direct-audio source.
    // Disabled until one is configured, so the registry never fails because
    // of it.
    // -----------------------------------------------------------------------
    class DirectAudioProvider extends MusicSearchProvider {
        constructor() { super('Direct Audio'); }
        isAvailable() { return false; }
        async search() { return []; }
    }

    // -----------------------------------------------------------------------
    // Registry — search variants, dedupe, relevance, playability.
    // -----------------------------------------------------------------------
    class MusicSearchRegistry {
        constructor() {
            this.providers = [
                new InternetArchiveProvider(),
                new DirectAudioProvider()
            ];
        }

        _available() { return this.providers.filter((p) => p.isAvailable()); }

        // Plain search — raw merged provider results, no filtering. Kept for
        // backward compatibility (and the provider contract tests).
        async search(query) {
            const q = sanitizeQuery(query);
            if (!q) return [];
            const settled = await Promise.allSettled(
                this._available().map((p) => p.search(q).catch((err) => {
                    console.warn('[MusicSearch] provider', p.name, 'failed:', err && err.message);
                    return [];
                }))
            );
            const merged = [];
            settled.forEach((r) => {
                if (r.status !== 'fulfilled') return;
                (r.value || []).forEach((t) => merged.push(t));
            });
            return dedupeTracks(merged);
        }

        // Smart search — the pipeline the UI uses:
        //   variants → identifier docs → dedupe → pre-rank → metadata for the
        //   best candidates → rank/filter → probe top streams → { results,
        //   state, … }.
        async searchSmart(query) {
            const q = sanitizeQuery(query);
            const emptyResp = {
                results: [], rawCount: 0, relevantCount: 0,
                playableCount: 0, nonPlayableCount: 0, query: q
            };
            if (!q) return Object.assign({ state: 'empty' }, emptyResp);

            const ctx = buildQueryContext(q);
            const variants = buildSearchVariants(q).slice(0, MAX_VARIANTS_SEARCHED);
            const providers = this._available();

            const seen = new Set();
            const docs = [];
            let failed = 0;
            for (const v of variants) {
                try {
                    for (const p of providers) {
                        const batch = (await p.searchIdentifiers(v)) || [];
                        for (const d of batch) {
                            if (!d || !d.identifier || seen.has(d.identifier)) continue;
                            seen.add(d.identifier);
                            docs.push(d);
                        }
                    }
                } catch (err) {
                    failed++;
                    console.warn('[MusicSearch] variant failed:', v, err && err.message);
                }
            }

            if (docs.length === 0) {
                return Object.assign({
                    state: (failed === variants.length && variants.length > 0) ? 'error' : 'empty'
                }, emptyResp);
            }
            if (docs.length > MAX_DOCS) docs.length = MAX_DOCS;

            // Pre-rank on identifier-level fields (no metadata cost yet).
            const light = docs.map((d) => ({
                title: d.title,
                artist: d.creator,
                _description: Array.isArray(d.description) ? d.description
                    : (d.description ? [d.description] : []),
                _collection: Array.isArray(d.collection) ? d.collection
                    : (d.collection ? [d.collection] : [])
            }));
            const pre = light
                .map((t, i) => ({ i, ...scoreTrack(t, ctx) }))
                .sort((a, b) => b.score - a.score)
                .slice(0, PRE_RESOLVE)
                .map((r) => docs[r.i]);

            // Resolve metadata only for the best candidates.
            const primary = providers[0];
            const tracks = [];
            if (primary && typeof primary.resolveTrack === 'function') {
                const settled = await Promise.allSettled(pre.map((d) => primary.resolveTrack(d)));
                settled.forEach((r) => { if (r.status === 'fulfilled' && r.value) tracks.push(r.value); });
            }

            const out = rankAndFilter(tracks, ctx);
            if (tracks.length === 0) out.state = 'empty';

            // Probe the top candidates so an item whose URL is not actually
            // audio is not offered with a Play button.
            if (out.results.length && typeof fetch === 'function') {
                const top = out.results.slice(0, PROBE_LIMIT);
                const probes = await Promise.allSettled(top.map((t) => probePlayable(t.playableUrl)));
                const bad = new Set();
                probes.forEach((r, i) => {
                    if (r.status === 'fulfilled' && r.value && r.value.ok === false) {
                        bad.add(top[i].dedupeKey || top[i].playableUrl);
                    }
                });
                if (bad.size) {
                    out.results = out.results.filter((t) => !bad.has(t.dedupeKey || t.playableUrl));
                    out.playableCount = out.results.length;
                    if (!out.results.length) out.state = 'noplayable';
                }
            }
            return out;
        }
    }

    window.MusicSearch = new MusicSearchRegistry();
    window.MusicSearch.sanitizeQuery = sanitizeQuery;
    window.MusicSearch.normalizeQuery = normalizeQuery;
    window.MusicSearch.normalizeMusicQuery = normalizeMusicQuery;
    window.MusicSearch.transliteratePersian = transliteratePersian;
    window.MusicSearch.buildSearchVariants = buildSearchVariants;
    window.MusicSearch.buildQueryContext = buildQueryContext;
    window.MusicSearch.looksPlayableUrl = looksPlayableUrl;
    window.MusicSearch.probePlayable = probePlayable;
    window.MusicSearch.scoreTrack = scoreTrack;
    window.MusicSearch.dedupeTracks = dedupeTracks;
    window.MusicSearch.rankAndFilter = rankAndFilter;
    window.MusicSearch.RELEVANCE_MIN = RELEVANCE_MIN;
    window.MusicSearch.InternetArchiveProvider = InternetArchiveProvider;
    window.MusicSearch.MusicSearchProvider = MusicSearchProvider;
    window.MusicSearch.DirectAudioProvider = DirectAudioProvider;
})();
