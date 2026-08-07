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
// Adding a future API provider (e.g. Jamendo with an API key) is a matter of
// subclassing MusicSearchProvider and registering it in MusicSearchRegistry.
// ===========================================================================

(function () {
    'use strict';

    const DEFAULT_TIMEOUT_MS = 12000;

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
    // Base provider contract
    // -----------------------------------------------------------------------
    class MusicSearchProvider {
        constructor(name) {
            this.name = name || 'provider';
        }
        // A provider may be unavailable (e.g. it needs a key that is absent);
        // the registry simply skips it instead of failing the whole search.
        isAvailable() { return true; }
        async search(query) { throw new Error('search() not implemented'); }
    }

    // -----------------------------------------------------------------------
    // Internet Archive — keyless, CORS-open, legitimate public audio.
    // -----------------------------------------------------------------------
    class InternetArchiveProvider extends MusicSearchProvider {
        constructor() { super('Internet Archive'); }

        async search(query) {
            const q = sanitizeQuery(query);
            if (!q) return [];
            const searchUrl = 'https://archive.org/advancedsearch.php?q=' +
                encodeURIComponent(q + ' AND mediatype:(audio)') +
                '&fl[]=identifier&fl[]=title&fl[]=creator&rows=24&page=1&output=json';

            const json = await fetchJson(searchUrl);
            const docs = (json && json.response && json.response.docs) || [];
            const settled = await Promise.allSettled(docs.slice(0, 10).map((doc) => this._toTrack(doc)));
            return settled
                .filter((r) => r.status === 'fulfilled')
                .map((r) => r.value)
                .filter(Boolean);
        }

        // Resolve one search hit into a normalized track. The metadata call
        // finds a concrete audio FILE (MP3 preferred, Ogg as fallback) whose
        // direct download URL is the playableUrl. No DRM/paywall bypass is
        // involved — these are openly downloadable files.
        async _toTrack(doc) {
            const identifier = doc.identifier;
            if (!identifier) return null;

            let meta = null;
            try {
                meta = await fetchJson('https://archive.org/metadata/' + encodeURIComponent(identifier));
            } catch (e) { /* metadata is optional — the item may still be browsable */ }

            const files = (meta && meta.files) || [];
            const audio = files.filter((f) =>
                f && f.format && /MP3|Ogg Vorbis/.test(f.format) &&
                !/\.(jpg|png|gif|jpeg|txt|xml|json|md5|sha1|ffp|log|m3u)$/i.test(f.name || '')
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
                dedupeKey: identifier
            };
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
    // Registry — runs every available provider, merges, dedupes.
    // -----------------------------------------------------------------------
    class MusicSearchRegistry {
        constructor() {
            this.providers = [
                new InternetArchiveProvider(),
                new DirectAudioProvider()
            ];
        }

        async search(query) {
            const q = sanitizeQuery(query);
            if (!q) return [];
            const providers = this.providers.filter((p) => p.isAvailable());
            const settled = await Promise.allSettled(
                providers.map((p) => p.search(q).catch((err) => {
                    console.warn('[MusicSearch] provider', p.name, 'failed:', err && err.message);
                    return [];
                }))
            );
            const seen = new Set();
            const merged = [];
            settled.forEach((r) => {
                if (r.status !== 'fulfilled') return;
                (r.value || []).forEach((t) => {
                    if (!t) return;
                    const key = t.dedupeKey || t.playableUrl || t.pageUrl || t.title;
                    if (!key || seen.has(key)) return;
                    seen.add(key);
                    merged.push(t);
                });
            });
            return merged;
        }
    }

    window.MusicSearch = new MusicSearchRegistry();
    window.MusicSearch.sanitizeQuery = sanitizeQuery;
    window.MusicSearch.InternetArchiveProvider = InternetArchiveProvider;
    window.MusicSearch.MusicSearchProvider = MusicSearchProvider;
})();
