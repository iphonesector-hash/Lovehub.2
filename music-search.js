// ===========================================================================
// music-search.js — Phase 5.2 / 5.3 / 5.5 / 6: provider-based web music search.
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
// Smart search layer (Phase 5.5 fix — PRESERVED VERBATIM):
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
//       nonPlayableCount, query, providers } where state ∈
//     'ok' | 'empty' | 'filtered' | 'noplayable' | 'unavailable' | 'error'.
//
// Multi-provider layer (Phase 6 — ADDITIVE, nothing above was changed):
//   * normalizeTrack() / dedupeKeyFor() — every provider result becomes the
//     common LoveHub shape { id, provider, title, artist, album, coverUrl,
//     duration, audioUrl, streamUrl, externalUrl, playable, downloadable,
//     sourceType, metadata, score, sources } plus the legacy aliases the UI
//     consumes (playableUrl, artworkUrl, pageUrl, source, dedupeKey).
//   * MusicSearchProvider — the base contract now also exposes searchTracks()
//     (normalized results), optional getTrack/getArtist/getAlbum, per-provider
//     timeout, preferred query kinds and an honest `legal` status record.
//   * MelobitProvider / CodeBazanProvider / AhangifyProvider / MelodifyProvider
//     — additional sources. Legal status is always documented and never
//     overstated; blocked/offline providers fail in isolation.
//   * MusicProviderManager — priority + enable/disable config, bounded
//     concurrency pool, per-provider timeouts, a short TTL search cache,
//     cross-provider dedupe (normalized artist+title, never provider ID),
//     merged sources[] for playback fallback, diagnostics and request
//     cancellation via the search deadline.
//   * searchSmart() merges the Internet Archive pipeline (exact Phase 5.5
//     behavior) with the other providers and keeps the same result shape.
// ===========================================================================

(function () {
    'use strict';

    const DEFAULT_TIMEOUT_MS = 12000;
    const MAX_VARIANTS = 6;            // variants generated (bounded)
    const MAX_VARIANTS_SEARCHED = 4;   // provider searches per user query
    const MAX_DOCS = 40;               // identifier-level candidates kept
    const PRE_RESOLVE = 14;            // metadata resolved for best candidates
    const MAX_RESULTS = 50;            // results returned to the UI (Phase 10 hotfix)
    const PROBE_LIMIT = 4;             // playability probes per search
    const RELEVANCE_MIN = 55;          // minimum score to be "relevant"

    // Phase 6 — multi-provider management.
    const PROVIDER_TIMEOUT_MS = 8000;      // per-provider network timeout
    const MANAGER_DEADLINE_MS = 15000;     // searchOthers overall deadline (ms). Raised in Phase 12 so Telegram/Apify sync runs (~5-15s) can complete; the provider pool is concurrent (fast providers are never delayed) and relay CDN + provider/searchSmart caches keep repeat searches fast.
    const POOL_LIMIT = 3;                  // bounded provider concurrency
    const CACHE_TTL_MS = 60000;            // provider search cache TTL (ms)
    const CACHE_MAX = 200;                 // provider search cache entry cap
    const PROVIDER_COOLDOWN_MS = 30000;      // skip a provider that just failed (session safety)
    const IA_VARIANT_CONCURRENCY = 2;        // parallel IA variant searches (bounded, polite)
    const IA_STOP_DOCS = 14;                 // stop variant searches once enough candidates found
    const SMART_CACHE_TTL_MS = 30000;        // searchSmart result cache TTL (repeated searches)
    const SMART_CACHE_MAX = 50;              // searchSmart result cache entry cap
    const MAX_PROVIDER_VARIANTS = 2;       // variants a provider may receive
    const DEFAULT_PROVIDER_PRIORITY = {
        'codebazan-rjavan': 110,
        'audius': 105,
        'internet-archive': 100,
        'deezer': 98,
        'youtube': 95,
        'telegram': 94,
        'melobit': 90,
        'ahangify': 80,
        'melodify': 70,
        'codebazan': 60
    };
    const DEFAULT_PROVIDER_ENABLED = {
        'codebazan-rjavan': true,
        'audius': true,
        'internet-archive': true,
        'deezer': true,
        'youtube': true,
        'telegram': true,
        'melobit': true,
        'ahangify': true,
        'melodify': true,
        'codebazan': true
    };

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
        // Audius official stream endpoint (no file extension; live-verified
        // audio/mpeg + Range 206 + CORS *).
        if (/\/v1\/tracks\/[^/]+\/stream$/.test(path)) return true;
        const m = path.match(/\.([a-z0-9]{2,5})$/i);
        if (!m) return false;
        return AUDIO_EXT.has(m[1].toLowerCase());
    }

    // A result is "playable" if it has a real audio URL OR is a YouTube embed
    // track (playbackMode 'youtube-embed' with a valid videoId) — the player
    // switches to YouTube's official IFrame mode for those. A bare
    // metadata-only item is never treated as playable.
    function isTrackPlayable(t) {
        if (!t) return false;
        if (t.playableUrl && looksPlayableUrl(t.playableUrl)) return true;
        if (t.playbackMode === 'youtube-embed'
            && t.metadata && t.metadata.youtube && t.metadata.youtube.videoId) return true;
        return false;
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
        // Persian (Farsi) metadata fields — providers like Radio Javan return
        // artist_farsi / song_farsi; a Persian query token matching the Farsi
        // artist/title is direct field evidence (no transliteration needed).
        const artistFa = normalizeMusicQuery(track.artist_farsi || '');
        const titleFa = normalizeMusicQuery(track.song_farsi || track.title_farsi || '');
        const artistFaWords = artistFa ? artistFa.split(' ') : [];
        const titleFaWords = titleFa ? titleFa.split(' ') : [];
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
        const allQInArtist = qTokens.length > 0 && qTokens.every((t) => artistWords.includes(t) || artistFaWords.includes(t));
        const anyQInArtist = qTokens.some((t) => artistWords.includes(t) || artistFaWords.includes(t));
        if ((artist && artist === q) || (artistFa && artistFa === q)) { score += 120; reasons.push('artist exact'); }
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
        const allQInTitle = qTokens.length > 0 && qTokens.every((t) => titleWords.includes(t) || titleFaWords.includes(t));
        const anyQInTitle = qTokens.some((t) => titleWords.includes(t) || titleFaWords.includes(t));
        if ((title && title === q) || (titleFa && titleFa === q)) { score += 100; reasons.push('title exact'); }
        else if (allQInTitle) { score += 65; reasons.push('title full'); }
        else if (anyQInTitle) { score += 30; reasons.push('title partial'); }
        if (trMatches(titleWords)) { score += 40; reasons.push('title translit'); }

        // Single-word artist-style queries need artist OR transliteration
        // evidence, or a title where the token anchors the title (first/last
        // word — "Ebi HEZARO YEK SHAB"). A lone token buried mid-phrase in an
        // Arabic/Persian title (e.g. "ابی" inside "سنن ابی داود") is weak
        // evidence of relevance and is penalized.
        const isSingleToken = qTokens.length === 1;
        if (isSingleToken && !anyQInArtist && !trMatches(artistWords) && !trMatches(titleWords) && !(title === q)
            && !artistFaWords.includes(qTokens[0]) && !titleFaWords.includes(qTokens[0])) {
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

    // -----------------------------------------------------------------------
    // Normalized track layer (Phase 6 — multi-provider).
    //
    // Every provider result is converted to one common LoveHub shape:
    //   { id, provider, title, artist, album, coverUrl, duration, audioUrl,
    //     streamUrl, externalUrl, playable, downloadable, sourceType,
    //     metadata, score, sources }
    // plus the legacy aliases the Music Room UI already consumes
    // (playableUrl, artworkUrl, pageUrl, source, dedupeKey, audioEvidence)
    // so nothing downstream has to change.
    // -----------------------------------------------------------------------

    // Map an internal provider id → user-visible label (and back).
    const PROVIDER_LABELS = {
        'codebazan-rjavan': 'Radio Javan',
        'audius': 'Audius',
        'internet-archive': 'Internet Archive',
        'deezer': 'Deezer',
        'youtube': 'YouTube',
        'telegram': 'Telegram',
        'melobit': 'Melobit',
        'ahangify': 'Ahangify',
        'melodify': 'Melodify',
        'codebazan': 'CodeBazan'
    };
    const LABEL_TO_ID = {};
    Object.keys(PROVIDER_LABELS).forEach((k) => { LABEL_TO_ID[PROVIDER_LABELS[k]] = k; });

    function providerIdOf(track) {
        if (!track) return null;
        if (track.providerId) return track.providerId;
        if (track.provider && LABEL_TO_ID[track.provider]) return LABEL_TO_ID[track.provider];
        if (track.provider) return String(track.provider).toLowerCase().replace(/\s+/g, '-');
        if (track.source && LABEL_TO_ID[track.source]) return LABEL_TO_ID[track.source];
        return null;
    }

    // Deterministic cross-provider dedupe key: normalized artist + normalized
    // title (never provider ID alone — different providers have different
    // IDs). Falls back to the playable URL / provider key when artist or
    // title is missing.
    function dedupeKeyFor(track) {
        if (!track) return null;
        const art = normalizeMusicQuery(track.artist || '');
        const tit = normalizeMusicQuery(track.title || '');
        if (art && tit) return 't:' + art + '|' + tit;
        if (track.playableUrl || track.audioUrl) return 'u:' + (track.playableUrl || track.audioUrl);
        if (track.dedupeKey) return 'k:' + String(track.dedupeKey);
        return null;
    }

    // Convert a provider-specific item into the common LoveHub track shape.
    // Never invents data: unknown fields become null. `meta` carries the
    // provider identity ({ id, label, sourceType, downloadable }).
    function normalizeTrack(raw, meta) {
        const m = meta || {};
        raw = raw || {};
        const title = String(raw.title || raw.name || '').trim().slice(0, 200);
        const artist = String(raw.artist || raw.singer || raw.creator || '').trim().slice(0, 200) || null;
        const audioUrl = raw.audioUrl || raw.streamUrl || raw.playableUrl || raw.mp3 || raw.mp3_128 || raw.mp3_320 || raw.link || raw.download || null;
        const coverUrl = raw.coverUrl || raw.artworkUrl || raw.cover
            || (raw.image && (raw.image.medium || raw.image.cover || raw.image.thumbnail))
            || (raw.thumbnail && (raw.thumbnail.medium || raw.thumbnail.url)) || null;
        const externalUrl = raw.externalUrl || raw.pageUrl || raw.shareUrl || null;
        const duration = isFinite(Number(raw.duration)) && Number(raw.duration) > 0 ? Number(raw.duration) : null;
        const playable = !!(audioUrl && looksPlayableUrl(audioUrl));
        return {
            id: String(raw.id != null ? raw.id : (audioUrl || title)),
            provider: m.id || null,
            title: title || String(raw.identifier || 'Untitled'),
            artist,
            album: raw.album || null,
            coverUrl,
            duration,
            audioUrl,
            streamUrl: audioUrl,
            externalUrl,
            playable,
            downloadable: playable && m.downloadable !== false,
            sourceType: m.sourceType || 'stream',
            playbackMode: m.playbackMode || 'html5-audio',
            metadata: m,
            score: null,
            sources: [],
            // Legacy aliases consumed by the Music Room UI (unchanged contract).
            playableUrl: audioUrl,
            artworkUrl: coverUrl,
            pageUrl: externalUrl,
            source: m.label || m.id || null,
            dedupeKey: raw.dedupeKey || raw.identifier || (raw.id != null ? String(raw.id) : null) || null,
            audioEvidence: playable,
            providerId: m.id || null,
            _description: Array.isArray(raw._description) ? raw._description
                : (raw.description ? (Array.isArray(raw.description) ? raw.description : [raw.description]) : []),
            _collection: Array.isArray(raw._collection) ? raw._collection
                : (raw.collection ? (Array.isArray(raw.collection) ? raw.collection : [raw.collection]) : [])
        };
    }

    // Pick the next fallback source URL for a track whose current source
    // failed to play. `exclude` is a URL string or a Set of already-tried
    // URLs. Returns null when no alternate source remains.
    function nextPlayableSource(track, exclude) {
        const sources = (track && track.sources) || [];
        const skip = (exclude && typeof exclude.has === 'function') ? exclude : (exclude ? new Set([exclude]) : new Set());
        for (const s of sources) {
            if (s && s.playable && s.audioUrl && !skip.has(s.audioUrl)) return s.audioUrl;
        }
        return null;
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
        const playable = relevant.filter((s) => isTrackPlayable(s.track));
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
        constructor(name, id) {
            this.name = name || 'provider';
            this.id = id || String(name || 'provider').toLowerCase().replace(/\s+/g, '-');
            this.timeoutMs = PROVIDER_TIMEOUT_MS;
            // Which buildSearchVariants() entries this provider handles best.
            // kinds: 'original' | 'normalized' | 'latin' | 'artist'
            this.preferredQueryKinds = ['original'];
            // Honest legal / terms record. Never claims licensing that was
            // not verified; unverifiable sources are marked 'unknown'.
            this.legal = {
                status: 'unknown',   // 'public' | 'unknown' | 'blocked'
                authRequired: false,
                keyEnv: null,
                docsUrl: null,
                notes: ''
            };
        }
        isAvailable() { return true; }
        async searchIdentifiers(query) { throw new Error('searchIdentifiers() not implemented'); }
        async resolveTrack(doc) { throw new Error('resolveTrack() not implemented'); }
        // Provider-independent normalized search: returns an array of LoveHub
        // tracks, or throws on failure (the manager isolates failures).
        async searchTracks(query) { return null; }
        // Optional entity lookups — not every provider implements them yet.
        async getTrack(id) { throw new Error('getTrack() not implemented'); }
        async getArtist(id) { throw new Error('getArtist() not implemented'); }
        async getAlbum(id) { throw new Error('getAlbum() not implemented'); }
        // Plain search used by the legacy search() API.
        async search(query) {
            const tracks = await this.searchTracks(query);
            return tracks || [];
        }
    }

    // -----------------------------------------------------------------------
    // Internet Archive — keyless, CORS-open, legitimate public audio.
    // -----------------------------------------------------------------------
    class InternetArchiveProvider extends MusicSearchProvider {
        constructor() { super('Internet Archive', 'internet-archive'); this.preferredQueryKinds = ['original', 'normalized', 'latin', 'artist']; }

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

            // Phase 8 — emit the SAME unified LoveHub track shape as every
            // other provider (id/provider/title/artist/album/coverUrl/duration/
            // audioUrl/streamUrl/externalUrl/playable/downloadable/sourceType/
            // metadata/score/sources + the legacy aliases the UI consumes).
            const _fileExt = pick ? ((pick.name.match(/\.([a-z0-9]{2,5})$/i) || [])[1] || '').toLowerCase() : '';
            const t = normalizeTrack({
                id: identifier,
                title: rawTitle || identifier,
                artist: creator || null,
                album: null,
                duration: isFinite(duration) ? duration : null,
                cover: 'https://archive.org/services/img/' + encodeURIComponent(identifier),
                audioUrl: pick
                    ? ('https://archive.org/download/' + encodeURIComponent(identifier) + '/' + encodeURIComponent(pick.name))
                    : null,
                externalUrl: 'https://archive.org/details/' + encodeURIComponent(identifier),
                dedupeKey: identifier,
                audioEvidence: audio.length > 0,
                _description: Array.isArray(description) ? description.slice(0, 3) : (description ? [description] : []),
                _collection: collArr.slice(0, 6)
            }, { id: this.id, label: this.name, sourceType: 'archive-stream', downloadable: true });
            if (t) t._fileExt = _fileExt;
            return t;
        }

        // Phase 6 — normalized search (identifiers → resolved tracks).
        async searchTracks(query) {
            const docs = await this.searchIdentifiers(query);
            const settled = await Promise.allSettled(docs.slice(0, 10).map((d) => this.resolveTrack(d)));
            return settled
                .filter((r) => r.status === 'fulfilled')
                .map((r) => r.value)
                .filter(Boolean);
        }
    }

    // -----------------------------------------------------------------------
    // Melobit — Persian music streaming API (no key for the public search
    // endpoint). NOTE: the community-documented hosts were offline /
    // domain-parked when verified (Aug 2026); the provider stays registered
    // and failure-isolated so it can contribute automatically if the API
    // returns. Legal status: unofficial, unverifiable → 'unknown'.
    // -----------------------------------------------------------------------
    class MelobitProvider extends MusicSearchProvider {
        constructor() {
            super('Melobit', 'melobit');
            this.preferredQueryKinds = ['original', 'latin'];
            this.legal = {
                status: 'unknown',
                authRequired: false,
                keyEnv: null,
                docsUrl: 'https://melobit.app',
                notes: 'Unofficial consumer-app API; no published developer terms. Do not treat as licensed.'
            };
        }
        async searchTracks(query) {
            const q = sanitizeQuery(query);
            if (!q) return [];
            const url = 'https://api.melobit.com/api/v1/search/song?query=' + encodeURIComponent(q);
            const json = await fetchJson(url, this.timeoutMs);
            const results = (json && (json.data && json.data.results)) || (json && json.results) || (Array.isArray(json) ? json : []);
            return results.map((s) => normalizeTrack({
                id: s.id,
                title: s.title || s.name,
                artist: Array.isArray(s.artists)
                    ? s.artists.map((a) => a && (a.name || a.fullName)).filter(Boolean).join(', ')
                    : (s.artist && (s.artist.name || s.artist)) || null,
                album: (s.album && s.album.name) || null,
                duration: Number(s.duration) || null,
                cover: (s.image && (s.image.medium || s.image.cover || s.image.thumbnail))
                    || (s.cover && (s.cover.medium || s.cover.cover)) || null,
                audioUrl: (s.audio && (s.audio['320'] || s.audio['128'] || s.audio.high || s.audio.medium))
                    || (s.sources && (s.sources['320'] || s.sources['128']))
                    || s.streamUrl || null,
                externalUrl: s.shareUrl || s.pageUrl || null
            }, { id: this.id, label: this.name, sourceType: 'stream' }));
        }
    }

    // -----------------------------------------------------------------------
    // CodeBazan Music API — free, keyless Persian music search that aggregates
    // several third-party sources. Provided "as-is" for educational use.
    // NOTE: unreachable from this environment (timeout) when verified
    // (Aug 2026); registered and failure-isolated — it may work from
    // in-region networks. Legal status: aggregator of third-party music,
    // terms not verifiable → 'unknown'.
    // -----------------------------------------------------------------------
    class CodeBazanProvider extends MusicSearchProvider {
        constructor() {
            super('CodeBazan', 'codebazan');
            this.preferredQueryKinds = ['original', 'latin'];
            this.legal = {
                status: 'unknown',
                authRequired: false,
                keyEnv: null,
                docsUrl: 'https://codebazan.ir',
                notes: 'Free public API; aggregates third-party music sources; terms not verifiable.'
            };
        }
        async searchTracks(query) {
            const q = sanitizeQuery(query);
            if (!q) return [];
            const url = 'https://api.codebazan.ir/music/?type=search&query=' + encodeURIComponent(q) + '&page=1';
            const json = await fetchJson(url, this.timeoutMs);
            const arr = Array.isArray(json) ? json : (json && (json.result || json.results || json.data)) || [];
            return arr.map((item) => normalizeTrack({
                id: item.id != null ? item.id : (item.title || null),
                title: item.title || item.name,
                artist: item.artist || item.singer || item.reader || null,
                album: item.album || null,
                duration: Number(item.duration || item.time) || null,
                cover: item.cover || item.image || item.poster || null,
                audioUrl: item.mp3_320 || item.mp3_128 || item.mp3 || item.link_320 || item.link_128 || item.download || item.stream || null,
                externalUrl: item.link || item.page || null
            }, { id: this.id, label: this.name, sourceType: 'stream' }));
        }
    }

    // -----------------------------------------------------------------------
    // Vercel CORS relay for the Radio Javan search API (api/rjavan.js). The
    // upstream API sends no Access-Control-Allow-Origin, so browsers cannot
    // read it directly; the relay forwards ?query=/?id= only and returns the
    // JSON unchanged with allowlisted CORS. Audio URLs in the response stay
    // provider-direct (never proxied/cached by the relay).
    // Same-origin relay when served from the Vercel production host;
    // absolute relay URL from any other origin (GitHub Pages, previews, Node
    // tests). The relays allowlist the LoveHub frontend origins.
    function relayBase(route) {
        const host = (typeof window !== 'undefined' && window.location && window.location.host) || '';
        if (/lovehub-gamma\.vercel\.app$/i.test(host)) return route;
        return 'https://lovehub-gamma.vercel.app' + route;
    }
    function rjavanRelayBase() { return relayBase('/api/rjavan'); }
    function deezerRelayBase() { return relayBase('/api/deezer'); }
    function youtubeRelayBase() { return relayBase('/api/youtube'); }
    function telegramRelayBase() { return relayBase('/api/telegram'); }

    // -----------------------------------------------------------------------
    // CodeBazan → Radio Javan — keyless, CORS-open search that returns direct
    // MP3 links (host*.media-rj.com). Live-verified (Aug 2026): 22/22 queries
    // HTTP 200, ~600ms latency, direct-browser-audio compatible at HTTP level
    // (audio/mpeg, Range 206, ACAO *). Direct streaming only — the audio URL
    // stays the provider URL; LoveHub never proxies/caches/redistributes it.
    // Legal status: unofficial proxy of third-party media -> 'unknown'.
    // -----------------------------------------------------------------------
    class CodeBazanRjavanProvider extends MusicSearchProvider {
        constructor() {
            super('Radio Javan', 'codebazan-rjavan');
            this.preferredQueryKinds = ['original', 'latin'];
            this.legal = {
                status: 'unknown',
                authRequired: false,
                keyEnv: null,
                docsUrl: 'https://codebazan.ir',
                notes: 'CodeBazan search proxy exposing Radio Javan media (host*.media-rj.com). Use for direct browser streaming only; do not proxy, cache or redistribute the files. Terms not verifiable.'
            };
        }

        async searchTracks(query) {
            const q = sanitizeQuery(query);
            if (!q) return [];
            const json = await fetchJson(
                this._relayUrl('query', q),
                this.timeoutMs
            );
            const mp3s = (json && Array.isArray(json.mp3s)) ? json.mp3s : [];
            return mp3s.map((s) => this._toTrack(s)).filter(Boolean);
        }

        async getTrack(id) {
            if (id == null) return null;
            const json = await fetchJson(
                this._relayUrl('id', String(id)),
                this.timeoutMs
            );
            if (!json || json.id == null) return null;
            return this._toTrack(json);
        }

        // Build the relay URL for a given kind ('query' | 'id') and value.
        _relayUrl(kind, value) {
            return rjavanRelayBase() + '?' + kind + '=' + encodeURIComponent(String(value));
        }

        // Map one Radio Javan mp3 entry into the unified LoveHub track shape.
        // Never invents data: unknown fields stay null. Persian labels are
        // preserved inside metadata and mirrored on top-level aliases.
        _toTrack(s) {
            if (!s || typeof s !== 'object') return null;
            const artist = String(s.artist || '').trim() || null;
            const titleRaw = String(s.title || '').trim();
            const songRaw = String(s.song || '').trim();
            // Titles arrive as Artist - Song; prefer the clean song name
            // (also improves cross-provider dedupe keys).
            let title = songRaw || titleRaw || 'Untitled';
            if (!songRaw && titleRaw && artist) {
                const prefix = artist + ' - ';
                if (titleRaw.toLowerCase().startsWith(prefix.toLowerCase())) {
                    title = titleRaw.slice(prefix.length);
                }
            }
            title = String(title).replace(/^[\u0022\u0027\u201c\u201d]+|[\u0022\u0027\u201c\u201d]+$/g, '').trim().slice(0, 200) || 'Untitled';
            const link = s.link || null;
            const duration = Number(s.duration);
            const t = normalizeTrack({
                id: s.id != null ? String(s.id) : null,
                title,
                artist,
                album: s.album || null,
                duration: isFinite(duration) && duration > 0 ? duration : null,
                cover: s.photo || s.thumbnail || null,
                audioUrl: link,
                streamUrl: link,
                externalUrl: s.share_link || s.permlink || null
            }, { id: this.id, label: this.name, sourceType: 'direct-audio', downloadable: false });
            if (t) {
                t.metadata = Object.assign(t.metadata || {}, {
                    rjId: s.id != null ? String(s.id) : null,
                    artist_farsi: s.artist_farsi || null,
                    song_farsi: s.song_farsi || null,
                    plays: s.plays || null,
                    likes: s.likes || null,
                    hls_link: s.hls_link || null,
                    lq_link: s.lq_link || null,
                    hq_link: s.hq_link || null
                });
                t.artist_farsi = s.artist_farsi || null;
                t.song_farsi = s.song_farsi || null;
            }
            return t;
        }
    }

    // -----------------------------------------------------------------------
    // Ahangify — blocked: no official developer API; the only known
    // integrations need a user session and route through unofficial proxies.
    // Registered (per the priority config) but never queried.
    // -----------------------------------------------------------------------
    class AhangifyProvider extends MusicSearchProvider {
        constructor() {
            super('Ahangify', 'ahangify');
            this.preferredQueryKinds = ['original'];
            this.legal = {
                status: 'blocked',
                authRequired: true,
                keyEnv: null,
                docsUrl: 'https://ahangify.ir',
                notes: 'No official developer API; unofficial proxies require account sessions.'
            };
        }
        isAvailable() { return false; }
        async searchTracks() { throw new Error('Ahangify: no public API — blocked'); }
    }

    // -----------------------------------------------------------------------
    // Melodify — blocked: private API behind account authentication
    // (phone/social login). Registered but never queried.
    // -----------------------------------------------------------------------
    class MelodifyProvider extends MusicSearchProvider {
        constructor() {
            super('Melodify', 'melodify');
            this.preferredQueryKinds = ['original'];
            this.legal = {
                status: 'blocked',
                authRequired: true,
                keyEnv: null,
                docsUrl: 'https://melodify.ir',
                notes: 'Client apps authenticate via phone/social login; no public API.'
            };
        }
        isAvailable() { return false; }
        async searchTracks() { throw new Error('Melodify: requires account authentication — blocked'); }
    }

    // -----------------------------------------------------------------------
    // DirectAudioProvider — reserved for a future curated/direct-audio source.
    // Disabled until one is configured, so the registry never fails because
    // of it.
    // -----------------------------------------------------------------------
    class DirectAudioProvider extends MusicSearchProvider {
        constructor() { super('Direct Audio', 'direct-audio'); }
        isAvailable() { return false; }
        async searchTracks() { return []; }
    }

    // -----------------------------------------------------------------------
    // Audius — keyless official API (api.audius.co/v1). Live-verified
    // (Aug 2026): search + stream return HTTP 200, CORS *, audio/mpeg with
    // Range 206. No relay needed — direct browser calls. Stream URLs point
    // at Audius discovery nodes; LoveHub never proxies/caches/redistributes
    // audio. Legal status: public read API, terms not independently verified.
    // -----------------------------------------------------------------------
    class AudiusProvider extends MusicSearchProvider {
        constructor() {
            super('Audius', 'audius');
            this.preferredQueryKinds = ['original', 'latin'];
            this.legal = {
                status: 'unknown',
                authRequired: false,
                keyEnv: null,
                docsUrl: 'https://docs.audius.org/api',
                notes: 'Official Audius read API (api.audius.co). Keyless; direct browser streaming only; do not proxy, cache or redistribute audio. Terms not independently verified.'
            };
        }

        async searchTracks(query) {
            const q = sanitizeQuery(query);
            if (!q) return [];
            const json = await fetchJson(
                'https://api.audius.co/v1/tracks/search?query=' + encodeURIComponent(q) + '&app_name=LoveHub&limit=50',
                this.timeoutMs
            );
            const data = (json && Array.isArray(json.data)) ? json.data : [];
            return data.map((s) => this._toTrack(s)).filter(Boolean);
        }

        async getTrack(id) {
            if (id == null) return null;
            const json = await fetchJson(
                'https://api.audius.co/v1/tracks/' + encodeURIComponent(String(id)) + '?app_name=LoveHub',
                this.timeoutMs
            );
            const data = (json && json.data) || null;
            if (!data) return null;
            return this._toTrack(data);
        }

        // Map one Audius track into the unified LoveHub track shape. Never
        // invents data: unknown fields stay null. Original Audius metadata is
        // preserved inside metadata.
        _toTrack(s) {
            if (!s || typeof s !== 'object') return null;
            const id = s.id != null ? String(s.id) : (s.track_id != null ? String(s.track_id) : null);
            if (!id) return null;
            const artist = (s.user && s.user.name) ? String(s.user.name).trim().slice(0, 200) : null;
            const rawTitle = String(s.title || '').trim();
            // Audius titles arrive as 'Artist - Title'; prefer the clean song
            // name (also improves cross-provider dedupe keys).
            let title = rawTitle || 'Untitled';
            if (artist) {
                const prefix = artist + ' - ';
                if (title.toLowerCase().startsWith(prefix.toLowerCase())) title = title.slice(prefix.length);
            }
            title = String(title).replace(/^[\u0022\u0027\u201c\u201d]+|[\u0022\u0027\u201c\u201d]+$/g, '').trim().slice(0, 200) || 'Untitled';
            const art = (s.artwork && typeof s.artwork === 'object') ? s.artwork : {};
            const cover = art['480x480'] || art['1000x1000'] || art['150x150'] || null;
            const duration = Number(s.duration);
            const stream = 'https://api.audius.co/v1/tracks/' + encodeURIComponent(id) + '/stream';
            const t = normalizeTrack({
                id,
                title,
                artist,
                album: null,
                duration: isFinite(duration) && duration > 0 ? duration : null,
                cover,
                audioUrl: stream,
                streamUrl: stream,
                externalUrl: (s.permalink || s.slug) ? 'https://audius.co/' + encodeURIComponent(String(s.slug || '')) : null
            }, { id: this.id, label: this.name, sourceType: 'stream', downloadable: false });
            if (t) {
                t.metadata = Object.assign(t.metadata || {}, {
                    audiusId: id,
                    genre: s.genre || null,
                    mood: s.mood || null,
                    playCount: s.play_count != null ? s.play_count : null,
                    favoriteCount: s.favorite_count != null ? s.favorite_count : null,
                    releaseDate: s.release_date || null,
                    isDownloadable: !!s.is_downloadable,
                    isOriginalAvailable: !!s.is_original_available,
                    artist_handle: (s.user && s.user.handle) || null,
                    artist_farsi: null,
                    song_farsi: null
                });
                // Phase 11B — nested Audius-specific metadata (flat keys above
                // stay for backward compatibility). Null when unavailable.
                t.metadata.audius = {
                    trackId: id,
                    userId: (s.user && s.user.id != null) ? String(s.user.id) : null,
                    permalink: s.permalink || s.slug || null,
                    artwork: cover,
                    genre: s.genre || null,
                    releaseDate: s.release_date || null,
                    playCount: s.play_count != null ? s.play_count : null
                };
            }
            return t;
        }
    }


    // -----------------------------------------------------------------------
    // Deezer — official public API (api.deezer.com) via the same-origin Vercel
    // relay (api/deezer.js). Keyless. Search metadata is CORS-blocked in the
    // browser (api.deezer.com sends no Access-Control-Allow-Origin), so the
    // JSON goes through the relay; the returned `preview` URLs are 30-second
    // CDN samples (cdns-preview-*.dzcdn.net) served with ACAO * + Range 206
    // and play directly in the browser — they are NEVER proxied, cached or
    // redistributed by LoveHub. sourceType: 'preview' (30s, not full track).
    // Legal status: 'unknown' (previews only, per Deezer API terms).
    // -----------------------------------------------------------------------
    class DeezerProvider extends MusicSearchProvider {
        constructor() {
            super('Deezer', 'deezer');
            this.preferredQueryKinds = ['original', 'normalized', 'latin'];
            this.legal = {
                status: 'unknown',
                authRequired: false,
                keyEnv: null,
                docsUrl: 'https://developers.deezer.com/api/search',
                notes: 'Official Deezer public API via same-origin Vercel relay (JSON metadata only). 30s previews stream directly from Deezer CDN; never proxy/cache/redistribute audio. Terms not independently verified.'
            };
        }

        async searchTracks(query) {
            const q = sanitizeQuery(query);
            if (!q) return [];
            const json = await fetchJson(
                deezerRelayBase() + '?query=' + encodeURIComponent(q) + '&limit=50',
                this.timeoutMs
            );
            const data = (json && Array.isArray(json.data)) ? json.data : [];
            return data.map((s) => this._toTrack(s)).filter(Boolean);
        }

        async getTrack(id) {
            if (id == null) return null;
            const json = await fetchJson(
                deezerRelayBase() + '?id=' + encodeURIComponent(String(id)),
                this.timeoutMs
            );
            if (!json || json.id == null) return null;
            return this._toTrack(json);
        }

        // Map one Deezer track into the unified LoveHub track shape. Unknown
        // fields stay null; original Deezer metadata is preserved in
        // metadata.deezer (plus flat keys for backward compatibility).
        _toTrack(s) {
            if (!s || typeof s !== 'object') return null;
            const id = s.id != null ? String(s.id) : null;
            if (!id) return null;
            const title = String(s.title || s.title_short || '').trim().slice(0, 200) || 'Untitled';
            const artist = (s.artist && s.artist.name) ? String(s.artist.name).trim().slice(0, 200) : null;
            const album = (s.album && s.album.title) ? String(s.album.title).trim().slice(0, 200) : null;
            const cover = (s.album && (s.album.cover_medium || s.album.cover_big || s.album.cover)) || null;
            const preview = String(s.preview || '').trim() || null;
            const duration = Number(s.duration);
            const t = normalizeTrack({
                id,
                title,
                artist,
                album,
                duration: isFinite(duration) && duration > 0 ? duration : null,
                cover,
                audioUrl: preview,
                streamUrl: preview,
                externalUrl: s.link || null
            }, { id: this.id, label: this.name, sourceType: 'preview', downloadable: false });
            if (t) {
                t.metadata = Object.assign(t.metadata || {}, {
                    deezerId: id,
                    rank: s.rank != null ? s.rank : null,
                    explicitLyrics: !!s.explicit_lyrics,
                    artistId: (s.artist && s.artist.id != null) ? s.artist.id : null,
                    albumId: (s.album && s.album.id != null) ? s.album.id : null,
                    previewUrl: preview,
                    artist_farsi: null,
                    song_farsi: null
                });
                t.metadata.deezer = {
                    trackId: id,
                    artistId: (s.artist && s.artist.id != null) ? String(s.artist.id) : null,
                    albumId: (s.album && s.album.id != null) ? String(s.album.id) : null,
                    rank: s.rank != null ? s.rank : null,
                    explicitLyrics: !!s.explicit_lyrics,
                    preview: preview,
                    link: s.link || null,
                    playbackMode: 'html5-audio',
                    sourceType: 'preview'
                };
            }
            return t;
        }
    }

    // -----------------------------------------------------------------------
    // YouTube — official YouTube Data API v3 via the same-origin Vercel relay
    // (api/youtube.js). The YOUTUBE_API_KEY stays server-side; until it is
    // configured the relay returns 503 YOUTUBE_API_KEY_NOT_CONFIGURED, which
    // this provider surfaces as a normal per-provider failure (recorded in
    // diagnostics, isolated from every other provider).
    //
    // The official API returns METADATA ONLY — no audio URLs. Results are
    // marked sourceType 'youtube' / playbackMode 'youtube-embed' and are NOT
    // playable through YouTube's own IFrame player (embed UI mode).
    // Never ripped, proxied or downloaded. Legal status: 'unknown'
    // (metadata + official embed only).
    // -----------------------------------------------------------------------
    class YouTubeProvider extends MusicSearchProvider {
        constructor() {
            super('YouTube', 'youtube');
            this.preferredQueryKinds = ['original', 'latin'];
            this.legal = {
                status: 'unknown',
                authRequired: true,
                keyEnv: 'YOUTUBE_API_KEY',
                docsUrl: 'https://developers.google.com/youtube/v3/docs/search/list',
                notes: 'Official YouTube Data API v3 (search/metadata only). YOUTUBE_API_KEY lives server-side in the Vercel relay. No audio extraction or ripping — playback uses YouTube\'s official IFrame embed (playbackMode youtube-embed).'
            };
        }

        async searchTracks(query) {
            const q = sanitizeQuery(query);
            if (!q) return [];
            const json = await fetchJson(
                youtubeRelayBase() + '?query=' + encodeURIComponent(q) + '&maxResults=25',
                this.timeoutMs
            );
            const items = (json && Array.isArray(json.items)) ? json.items : [];
            return items.map((s) => this._toTrack(s)).filter(Boolean);
        }

        async getTrack(id) {
            if (id == null) return null;
            const json = await fetchJson(
                youtubeRelayBase() + '?id=' + encodeURIComponent(String(id)),
                this.timeoutMs
            );
            const item = (json && Array.isArray(json.items) && json.items[0]) || null;
            return item ? this._toTrack(item) : null;
        }

        // Map one YouTube video into the unified LoveHub track shape. Metadata
        // only by design — never a fake audio URL.
        _toTrack(s) {
            if (!s || typeof s !== 'object') return null;
            const videoId = s.videoId || s.id || null;
            if (!videoId) return null;
            const videoUrl = 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId);
            const duration = Number(s.durationSeconds);
            const rawTitle = String(s.title || '').trim();
            // Parse "Artist — Title" style titles so artist/title match
            // other providers (cross-provider dedupe + relevance).
            const parsed = rawTitle.match(/^(.+?)\s+[\u2013\u2014\u2015-]\s+(.+)$/);
            let artist = null;
            let title = rawTitle;
            if (parsed) {
                artist = String(parsed[1]).trim().slice(0, 200) || null;
                title = String(parsed[2]).trim();
            } else if (s.channelTitle) {
                artist = String(s.channelTitle).trim().slice(0, 200);
            }
            // Strip descriptive tags like "(Official Video)" / "[Lyrics]" for
            // cleaner titles and cross-provider dedupe keys.
            title = title.replace(/\s*[\(\[]([^)\]]*)[\)\]]\s*$/, '').trim().slice(0, 200) || 'Untitled';
            const t = normalizeTrack({
                id: videoId,
                title,
                artist,
                album: null,
                duration: isFinite(duration) && duration > 0 ? duration : null,
                cover: s.thumbnail || null,
                audioUrl: null,
                streamUrl: null,
                externalUrl: videoUrl
            }, { id: this.id, label: this.name, sourceType: 'youtube', downloadable: false, playbackMode: 'youtube-embed' });
            if (t) {
                // Playable through YouTube's official IFrame player (not as an
                // <audio> stream) once the embed UI mode is active.
                t.playable = true;
                t.playbackMode = 'youtube-embed';
                t.metadata = Object.assign(t.metadata || {}, {
                    youtubeId: videoId,
                    channelId: s.channelId || null,
                    channelTitle: s.channelTitle || artist,
                    publishedAt: s.publishedAt || null,
                    kind: s.kind || 'youtube#video',
                    artist_farsi: null,
                    song_farsi: null
                });
                t.metadata.youtube = {
                    videoId,
                    channelId: s.channelId || null,
                    channelTitle: s.channelTitle || artist,
                    publishedAt: s.publishedAt || null,
                    thumbnail: s.thumbnail || null,
                    kind: s.kind || 'youtube#video',
                    playbackMode: 'youtube-embed',
                    sourceType: 'youtube'
                };
            }
            return t;
        }
    }

    // -----------------------------------------------------------------------
    // MusicProviderManager — central registry, priorities, timeouts, cache,
    // failure isolation, cross-provider dedupe and playback fallback.
    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
    // Telegram — public Persian-music channels via the hosted Apify actor
    // (crawlerbros/telegram-public-channels-scraper), reached through the
    // same-origin Vercel relay (api/telegram.js). The APIFY_API_TOKEN stays
    // server-side; until it is configured the relay returns 503
    // APIFY_API_TOKEN_NOT_CONFIGURED (isolated per-provider failure).
    //
    // The actor searches WITHIN a curated list of verified public channels
    // (no global Telegram search exists). Only audio attachments are kept;
    // their URLs are Telegram's own signed CDN URLs (cdn*.telesco.pe/file/
    // ...?token=...) — temporary, intended for immediate HTML5 playback,
    // NEVER proxied, cached, re-hosted or permanently stored by LoveHub.
    // sourceType 'telegram-media', playbackMode 'html5-audio'.
    // Legal status: 'unknown' (indexes public posts from official channels;
    // audio stays provider-direct).
    // -----------------------------------------------------------------------
    class TelegramMusicProvider extends MusicSearchProvider {
        constructor() {
            super('Telegram', 'telegram');
            this.preferredQueryKinds = ['original'];
            this.legal = {
                status: 'unknown',
                authRequired: true,
                keyEnv: 'APIFY_API_TOKEN',
                docsUrl: 'https://apify.com/crawlerbros/telegram-public-channels-scraper',
                notes: 'Hosted Apify Telegram scraper via same-origin Vercel relay (JSON metadata only). Searches verified public Persian-music channels; audio stays on Telegram CDN (telesco.pe, signed temporary URLs) — never proxy/cache/re-host. Terms not independently verified.'
            };
        }

        async searchTracks(query) {
            const q = sanitizeQuery(query);
            if (!q) return [];
            const json = await fetchJson(
                telegramRelayBase() + '?query=' + encodeURIComponent(q),
                this.timeoutMs
            );
            const items = (json && Array.isArray(json.items)) ? json.items : [];
            return items.map((s) => this._toTrack(s)).filter(Boolean);
        }

        // No direct track lookup exists for Telegram (the actor is
        // search-only) — the contract method returns null rather than
        // inventing an unsupported API.
        async getTrack() { return null; }

        // Audio-only filtering: keep attachments that are explicitly audio,
        // carry an audio/* mime type, or end in a known audio extension.
        _isAudioAttachment(a) {
            if (!a || typeof a !== 'object') return false;
            const type = String(a.type || '').toLowerCase();
            const mime = String(a.mimeType || a.mime_type || '').toLowerCase();
            if (type === 'audio') return true;
            if (mime && mime.indexOf('audio/') === 0) return true;
            const m = String(a.url || a.fileUrl || '').match(/\.([a-z0-9]{2,5})(?:[?#]|$)/);
            return !!(m && AUDIO_EXT.has(m[1]));
        }

        // First non-empty line of the post caption becomes the title; a
        // leading "Artist — Title" pattern is parsed for clean dedupe.
        _titleFromText(text, channel, msgId) {
            const line = String(text || '').split('\n')[0].trim();
            if (line) return line.slice(0, 200);
            return (channel ? channel : 'Telegram') + ' audio' + (msgId ? ' #' + msgId : '');
        }

        // Map one Apify post into the unified LoveHub track shape. Preserves
        // the original signed Telegram CDN URL untouched. Unknown fields stay
        // null; original post metadata is kept in metadata.telegram.
        _toTrack(item) {
            if (!item || typeof item !== 'object') return null;
            const atts = Array.isArray(item.mediaAttachments) ? item.mediaAttachments : [];
            const audio = atts.find((a) => this._isAudioAttachment(a));
            if (!audio) return null;
            const url = String(audio.url || audio.fileUrl || audio.mediaUrl || '').trim();
            if (!/^https?:\/\//i.test(url)) return null;
            const channel = String(item.channel || item.channelUsername || '').trim() || null;
            const msgId = item.id != null ? String(item.id)
                : (item.messageId != null ? String(item.messageId) : null);
            const text = String(item.text || item.caption || '').trim();
            const title = this._titleFromText(text, channel, msgId);
            let artist = null;
            const parsed = text.match(/^(.+?)\s+[\u2013\u2014\u2015-]\s+(.+)$/);
            if (parsed) artist = String(parsed[1]).trim().slice(0, 200);
            const published = item.publishedAt || item.date || item.published_at || null;
            const t = normalizeTrack({
                id: msgId ? (channel ? channel + '/' + msgId : msgId) : url,
                title,
                artist,
                album: null,
                duration: null,
                cover: null,
                audioUrl: url,
                streamUrl: url,
                externalUrl: (channel && msgId) ? 'https://t.me/' + encodeURIComponent(channel) + '/' + encodeURIComponent(msgId) : null
            }, { id: this.id, label: this.name, sourceType: 'telegram-media', downloadable: false, playbackMode: 'html5-audio' });
            if (t) {
                t.metadata = Object.assign(t.metadata || {}, {
                    telegramId: msgId,
                    channel,
                    text,
                    publishedAt: published,
                    fileName: audio.fileName || audio.name || null,
                    mimeType: audio.mimeType || audio.mime_type || null,
                    mediaType: audio.type || null,
                    artist_farsi: null,
                    song_farsi: null
                });
                t.metadata.telegram = {
                    channel,
                    messageId: msgId,
                    publishedAt: published,
                    text,
                    fileName: audio.fileName || audio.name || null,
                    mimeType: audio.mimeType || audio.mime_type || null
                };
            }
            return t;
        }
    }

    class MusicProviderManager {
        constructor(config) {
            const cfg = config || {};
            this.config = {
                deadlineMs: cfg.deadlineMs || MANAGER_DEADLINE_MS,
                poolLimit: cfg.poolLimit || POOL_LIMIT,
                cacheTtlMs: cfg.cacheTtlMs || CACHE_TTL_MS,
                cacheMax: cfg.cacheMax || CACHE_MAX,
                timeoutMs: Object.assign({ default: PROVIDER_TIMEOUT_MS }, cfg.timeoutMs),
                cooldownMs: cfg.cooldownMs || PROVIDER_COOLDOWN_MS,
                priority: Object.assign({}, DEFAULT_PROVIDER_PRIORITY, cfg.priority),
                enabled: Object.assign({}, DEFAULT_PROVIDER_ENABLED, cfg.enabled)
            };
            this.providers = [];
            this._cache = new Map();
            this._diag = new Map();
        }

        registerProvider(p) {
            if (!p || !p.id) return this;
            if (!this.providers.some((x) => x.id === p.id)) this.providers.push(p);
            if (!this._diag.has(p.id)) {
                this._diag.set(p.id, {
                    searches: 0, failures: 0, totalMs: 0, lastLatencyMs: null, lastError: null,
                    blocked: p.isAvailable() ? null : ((p.legal && p.legal.notes) || 'blocked')
                });
            }
            return this;
        }

        unregisterProvider(id) {
            this.providers = this.providers.filter((p) => p.id !== id);
            this._diag.delete(id);
            return this;
        }

        enable(id) { this.config.enabled[id] = true; return this; }
        disable(id) { this.config.enabled[id] = false; return this; }
        isEnabled(id) { return this.config.enabled[id] !== false; }
        setPriority(id, n) { this.config.priority[id] = n; return this; }
        getProvider(id) { return this.providers.find((p) => p.id === id) || null; }

        // Enabled + available providers, highest priority first (stable).
        orderedProviders() {
            return this.providers
                .filter((p) => this.isEnabled(p.id) && p.isAvailable())
                .sort((a, b) => (this.config.priority[b.id] || 0) - (this.config.priority[a.id] || 0));
        }

        // ---- short-lived search cache (never private data) ----

        _cacheGet(key) {
            const e = this._cache.get(key);
            if (!e) return null;
            if (Date.now() - e.at > this.config.cacheTtlMs) { this._cache.delete(key); return null; }
            return e.value;
        }

        _cacheSet(key, value) {
            if (this._cache.size >= this.config.cacheMax) {
                const oldest = this._cache.keys().next().value;
                if (oldest !== undefined) this._cache.delete(oldest);
            }
            this._cache.set(key, { at: Date.now(), value });
        }

        // ---- diagnostics ----

        _record(id, ms, err) {
            const d = this._diag.get(id);
            if (d) {
                d.searches += 1;
                d.totalMs += ms;
                d.lastLatencyMs = ms;
                if (err) { d.failures += 1; d.lastError = String((err && err.message) || err); }
                else d.lastError = null;
            }
        }

        diagnostics() {
            return this.providers.map((p) => {
                const d = this._diag.get(p.id) || {};
                return {
                    id: p.id,
                    name: p.name,
                    enabled: this.isEnabled(p.id),
                    available: p.isAvailable(),
                    legalStatus: p.legal && p.legal.status,
                    authRequired: p.legal && p.legal.authRequired,
                    searches: d.searches || 0,
                    failures: d.failures || 0,
                    lastLatencyMs: d.lastLatencyMs != null ? d.lastLatencyMs : null,
                    lastError: d.lastError || null,
                    coolingDown: !!(d.cooldownUntil && Date.now() < d.cooldownUntil)
                };
            });
        }

        resetDiagnostics() {
            this._diag.forEach((d) => {
                d.searches = 0; d.failures = 0; d.totalMs = 0; d.lastLatencyMs = null; d.lastError = null;
            });
        }

        // ---- search orchestration ----

        _timeoutFor(p) { return this.config.timeoutMs[p.id] || this.config.timeoutMs.default; }

        // Bounded variant selection per provider preference (kinds above).
        _pickVariants(p, variants, ctx) {
            if (!variants || !variants.length) return [];
            const kinds = p.preferredQueryKinds || ['original'];
            const out = [];
            const push = (v) => {
                const s = sanitizeQuery(v);
                if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
            };
            kinds.forEach((kind) => {
                if (kind === 'original') push(variants[0]);
                else if (kind === 'normalized') {
                    const n = ctx.norm;
                    if (n && n !== String(variants[0]).toLowerCase()) push(n);
                } else if (kind === 'latin') {
                    if (ctx.translits && ctx.translits.length) push(ctx.translits[0]);
                    else if (variants.length > 1 && /^[a-z0-9]/.test(variants[1])) push(variants[1]);
                } else if (kind === 'artist') {
                    if (ctx.translits && ctx.translits.length) push(ctx.translits[0] + ' singer');
                    else if (variants.length > 1) push(String(variants[1]) + ' singer');
                }
            });
            return out.slice(0, MAX_PROVIDER_VARIANTS);
        }

        _withTimeout(promise, ms) {
            if (!ms) return promise;
            return Promise.race([
                promise,
                new Promise((resolve, reject) => setTimeout(() => reject(new Error('timeout')), ms))
            ]);
        }

        // One provider × one variant. Records diagnostics; never throws.
        async _searchOne(p, variant, t0) {
            const started = Date.now();
            if (Date.now() - t0 > this.config.deadlineMs) {
                this._record(p.id, 0, new Error('skipped (deadline)'));
                return [];
            }
            const diag = this._diag.get(p.id);
            // Failure cooldown: a provider that just errored/timed out is
            // skipped for a short window so a dead API never stalls the
            // search ("avoid waiting for unavailable providers").
            if (diag && diag.cooldownUntil && Date.now() < diag.cooldownUntil) {
                const secs = Math.max(1, Math.ceil((diag.cooldownUntil - Date.now()) / 1000));
                diag.lastLatencyMs = 0;
                diag.lastError = 'cooling down (' + secs + 's)';
                return [];
            }
            const cacheKey = p.id + '|' + normalizeMusicQuery(variant);
            const cached = this._cacheGet(cacheKey);
            if (cached) { this._record(p.id, 1, null); return cached; }
            try {
                const items = await this._withTimeout(p.searchTracks(variant), this._timeoutFor(p));
                const tracks = (Array.isArray(items) ? items : []).filter(Boolean);
                this._record(p.id, Date.now() - started, null);
                if (diag) diag.cooldownUntil = null; // healthy again
                this._cacheSet(cacheKey, tracks);
                return tracks;
            } catch (err) {
                this._record(p.id, Date.now() - started, err);
                if (diag) diag.cooldownUntil = Date.now() + this.config.cooldownMs;
                return [];
            }
        }

        // Bounded-concurrency worker pool.
        async _runPool(tasks, limit) {
            const results = new Array(tasks.length);
            let i = 0;
            const workers = Array(Math.max(1, Math.min(limit || POOL_LIMIT, tasks.length))).fill(0).map(async () => {
                while (i < tasks.length) {
                    const idx = i++;
                    results[idx] = await tasks[idx]();
                }
            });
            await Promise.all(workers);
            return results;
        }

        // Search every other provider (Internet Archive runs its own pipeline
        // in searchSmart). Returns merged, deduped normalized tracks with
        // sources[] attached. Never throws — provider failures are isolated
        // and recorded in diagnostics.
        async searchOthers(query, ctx, variants, excludeId) {
            const t0 = Date.now();
            const providers = this.orderedProviders().filter((p) => p.id !== (excludeId || 'internet-archive'));
            const tasks = [];
            providers.forEach((p) => {
                this._pickVariants(p, variants, ctx).forEach((v) => {
                    tasks.push(() => this._searchOne(p, v, t0));
                });
            });
            const settled = tasks.length ? await this._runPool(tasks, this.config.poolLimit) : [];
            return this._mergeDedupe(settled.flat(), providers.map((p) => p.id));
        }

        // Merge tracks from many providers into ONE result per dedupe key,
        // keeping every alternate playable source for playback fallback. The
        // primary fields come from the highest-priority source.
        _mergeDedupe(tracks, priorityIds) {
            const order = priorityIds || this.orderedProviders().map((p) => p.id);
            const rankOf = (id) => {
                const i = order.indexOf(id);
                return i === -1 ? order.length : i;
            };
            const map = new Map();
            for (const t of tracks) {
                if (!t || !t.title) continue;
                const key = dedupeKeyFor(t) || ('u:' + (t.playableUrl || t.audioUrl || Math.random()));
                let entry = map.get(key);
                if (!entry) {
                    entry = Object.assign({}, t);
                    entry.sources = [];
                    map.set(key, entry);
                }
                const pid = providerIdOf(t);
                const src = {
                    provider: pid,
                    label: t.source || t.provider || null,
                    playable: !!t.playableUrl && looksPlayableUrl(t.playableUrl),
                    audioUrl: t.audioUrl || t.playableUrl || null,
                    streamUrl: t.streamUrl || t.playableUrl || null,
                    externalUrl: t.externalUrl || t.pageUrl || null,
                    coverUrl: t.coverUrl || t.artworkUrl || null
                };
                if (!entry.sources.some((s) => (s.provider === pid || pid == null) && s.audioUrl === src.audioUrl)) {
                    entry.sources.push(src);
                }
                // Highest-priority source provides the primary playable fields
                // (Radio Javan 110 > Internet Archive 100 when both carry the
                // same track), and its extra metadata (Persian labels, cover,
                // provider-specific ids) is folded in for the UI.
                if (rankOf(pid) < rankOf(providerIdOf(entry)) || !entry.playableUrl) {
                    entry.playableUrl = t.playableUrl || entry.playableUrl;
                    entry.audioUrl = t.audioUrl || t.playableUrl || entry.audioUrl;
                    entry.artworkUrl = t.artworkUrl || t.coverUrl || entry.artworkUrl;
                    entry.pageUrl = t.pageUrl || t.externalUrl || entry.pageUrl;
                    entry.duration = t.duration || entry.duration;
                    entry.source = t.source || t.provider || entry.source;
                    entry.provider = t.provider || entry.provider;
                    entry.providerId = pid || entry.providerId;
                    entry.dedupeKey = t.dedupeKey || entry.dedupeKey;
                    entry.audioEvidence = t.audioEvidence || entry.audioEvidence;
                    entry.playbackMode = t.playbackMode || entry.playbackMode;
                    entry.sourceType = t.sourceType || entry.sourceType;
                    entry.artist_farsi = t.artist_farsi || entry.artist_farsi;
                    entry.song_farsi = t.song_farsi || entry.song_farsi;
                    if (t.metadata && (t.metadata.artist_farsi || t.metadata.rjId)) {
                        entry.metadata = Object.assign({}, entry.metadata || {}, t.metadata);
                    }
                }
            }
            return Array.from(map.values());
        }
    }

    // -----------------------------------------------------------------------
    // Registry — search variants, dedupe, relevance, playability.
    // -----------------------------------------------------------------------
    class MusicSearchRegistry {
        constructor() {
            this.providers = [
                new InternetArchiveProvider(),
                new MelobitProvider(),
                new AhangifyProvider(),
                new MelodifyProvider(),
                new CodeBazanProvider(),
                new CodeBazanRjavanProvider(),
                new AudiusProvider(),
                new DeezerProvider(),
                new YouTubeProvider(),
                new TelegramMusicProvider(),
                new DirectAudioProvider()
            ];
            // Telegram's Apify sync runs take ~5-15s — give it its own longer
            // per-provider timeout; every other provider keeps the default.
            this.manager = new MusicProviderManager({ timeoutMs: { telegram: 22000 } });
            this.providers.forEach((p) => this.manager.registerProvider(p));
            this.manager.disable('direct-audio'); // reserved for a future source
            this._smartCache = new Map(); // short-lived searchSmart result cache
        }

        _smartCacheGet(key) {
            const e = this._smartCache.get(key);
            if (!e) return null;
            if (Date.now() - e.at > SMART_CACHE_TTL_MS) { this._smartCache.delete(key); return null; }
            return e.value;
        }

        _smartCacheSet(key, value) {
            if (this._smartCache.size >= SMART_CACHE_MAX) {
                const oldest = this._smartCache.keys().next().value;
                if (oldest !== undefined) this._smartCache.delete(oldest);
            }
            this._smartCache.set(key, { at: Date.now(), value });
        }

        registerProvider(p) {
            if (!p || !p.id) return this;
            if (!this.providers.some((x) => x.id === p.id)) this.providers.push(p);
            this.manager.registerProvider(p);
            return this;
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

        // Internet Archive path — the exact Phase 5.5 pipeline (variants →
        // identifier docs → pre-rank → resolve metadata for the best
        // candidates). Returns { tracks, failed }.
        async _searchInternetArchive(q, variants, ctx) {
            const ia = this.manager.getProvider('internet-archive');
            if (!ia || typeof ia.searchIdentifiers !== 'function') return { tracks: [], failed: 0 };
            const seen = new Set();
            const docs = [];
            let failed = 0;
            let succeeded = 0;
            const stopEarly = () => docs.length >= IA_STOP_DOCS && succeeded >= 2;
            const tasks = variants.map((v) => async () => {
                if (stopEarly()) return; // enough candidates already found
                try {
                    const batch = (await ia.searchIdentifiers(v)) || [];
                    for (const d of batch) {
                        if (!d || !d.identifier || seen.has(d.identifier)) continue;
                        seen.add(d.identifier);
                        docs.push(d);
                    }
                    succeeded++;
                } catch (err) {
                    failed++;
                    console.warn('[MusicSearch] variant failed:', v, err && err.message);
                }
            });
            // Parallel variant searches (bounded, polite) — the old sequential
            // loop was the main search-latency cost (up to 4 × ~2-4s).
            await this.manager._runPool(tasks, IA_VARIANT_CONCURRENCY);
            if (docs.length === 0) return { tracks: [], failed };
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
            const tracks = [];
            const settled = await Promise.allSettled(pre.map((d) => ia.resolveTrack(d)));
            settled.forEach((r) => { if (r.status === 'fulfilled' && r.value) tracks.push(r.value); });
            return { tracks, failed };
        }

        // Smart search — the pipeline the UI uses. The Internet Archive path
        // is the exact Phase 5.5 pipeline; the manager concurrently adds every
        // other provider (bounded pool, per-provider timeout, deadline) and
        // the merged results go through the same rank/filter/probe stages.
        async searchSmart(query) {
            const q = sanitizeQuery(query);
            // Short-lived result cache for repeated queries (30s TTL): the
            // second identical search is served entirely from memory — no
            // provider calls, no probes.
            const cacheKey = q ? (normalizeMusicQuery(q) || q) : '';
            if (cacheKey) {
                const cached = this._smartCacheGet(cacheKey);
                if (cached) {
                    cached.providers = this.manager.diagnostics();
                    return cached;
                }
            }
            const emptyResp = {
                results: [], rawCount: 0, relevantCount: 0,
                playableCount: 0, nonPlayableCount: 0, query: q
            };
            if (!q) return Object.assign({ state: 'empty' }, emptyResp);

            const ctx = buildQueryContext(q);
            const variants = buildSearchVariants(q).slice(0, MAX_VARIANTS_SEARCHED);

            const iaPromise = this._searchInternetArchive(q, variants, ctx);
            const othersPromise = this.manager.searchOthers(q, ctx, variants, 'internet-archive')
                .catch((err) => {
                    console.warn('[MusicSearch] provider pool failed:', err && err.message);
                    return [];
                });
            const [iaRes, others] = await Promise.all([iaPromise, othersPromise]);

            const merged = this.manager._mergeDedupe((iaRes.tracks || []).concat(others));
            const out = rankAndFilter(merged, ctx);
            if (merged.length === 0) {
                // Nothing from any provider. Distinguish "all providers
                // failed" (network) from "providers answered but had no
                // results".
                const iaFailed = iaRes.failed >= variants.length && variants.length > 0;
                out.state = iaFailed ? 'unavailable' : 'empty';
            }

            // Probe the top candidates so an item whose URL is not actually
            // audio is not offered with a Play button.
            if (out.results.length && typeof fetch === 'function') {
                const top = out.results.slice(0, PROBE_LIMIT);
                const probes = await Promise.allSettled(top.map((t) => {
                    // YouTube embed tracks have no URL to probe — playback goes
                    // through YouTube's own IFrame player (never rip/proxy).
                    if (t.playbackMode === 'youtube-embed') return Promise.resolve({ ok: true });
                    return probePlayable(t.playableUrl);
                }));
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
            out.providers = this.manager.diagnostics();
            if (cacheKey) this._smartCacheSet(cacheKey, out);
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
    window.MusicSearch.normalizeTrack = normalizeTrack;
    window.MusicSearch.dedupeKeyFor = dedupeKeyFor;
    window.MusicSearch.nextPlayableSource = nextPlayableSource;
    window.MusicSearch.providerIdOf = providerIdOf;
    window.MusicSearch.MusicProviderManager = MusicProviderManager;
    window.MusicSearch.InternetArchiveProvider = InternetArchiveProvider;
    window.MusicSearch.MusicSearchProvider = MusicSearchProvider;
    window.MusicSearch.MelobitProvider = MelobitProvider;
    window.MusicSearch.AhangifyProvider = AhangifyProvider;
    window.MusicSearch.MelodifyProvider = MelodifyProvider;
    window.MusicSearch.CodeBazanProvider = CodeBazanProvider;
    window.MusicSearch.CodeBazanRjavanProvider = CodeBazanRjavanProvider;
    window.MusicSearch.rjavanRelayBase = rjavanRelayBase;
    window.MusicSearch.AudiusProvider = AudiusProvider;
    window.MusicSearch.DeezerProvider = DeezerProvider;
    window.MusicSearch.YouTubeProvider = YouTubeProvider;
    window.MusicSearch.TelegramMusicProvider = TelegramMusicProvider;
    window.MusicSearch.telegramRelayBase = telegramRelayBase;
    window.MusicSearch.isTrackPlayable = isTrackPlayable;
    window.MusicSearch.DirectAudioProvider = DirectAudioProvider;
})();
