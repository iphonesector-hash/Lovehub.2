'use strict';

// Keyless LRCLIB relay for LoveHub Music Room.
// Returns plain and time-synced lyrics metadata only; no audio/media proxying.

const BASE = 'https://lrclib.net/api';
const TIMEOUT_MS = 7000;
const ALLOWED_ORIGINS = [
    'https://lovehub-gamma.vercel.app',
    'https://iphonesector-hash.github.io'
];

function isAllowedOrigin(origin) {
    if (!origin || typeof origin !== 'string') return false;
    if (ALLOWED_ORIGINS.includes(origin)) return true;
    try {
        const u = new URL(origin);
        return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    } catch (_) {
        return false;
    }
}

function sendJson(res, status, body, cacheControl = 'no-store') {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('Vary', 'Origin');
    res.end(JSON.stringify(body));
}

async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(url, {
            signal: controller.signal,
            headers: { Accept: 'application/json', 'User-Agent': 'LoveHub-Lyrics/1.0' }
        });
        const text = await r.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) {}
        return { ok: r.ok, status: r.status, json };
    } finally {
        clearTimeout(timer);
    }
}

function normalizeHit(hit) {
    if (!hit || typeof hit !== 'object') return null;
    const plain = typeof hit.plainLyrics === 'string' ? hit.plainLyrics.trim() : '';
    const synced = typeof hit.syncedLyrics === 'string' ? hit.syncedLyrics.trim() : '';
    if (!plain && !synced) return null;
    return {
        id: hit.id != null ? String(hit.id) : null,
        trackName: hit.trackName || null,
        artistName: hit.artistName || null,
        albumName: hit.albumName || null,
        duration: Number(hit.duration || 0) || null,
        instrumental: !!hit.instrumental,
        plainLyrics: plain || null,
        syncedLyrics: synced || null,
        source: 'lrclib'
    };
}

module.exports = async function handler(req, res) {
    const origin = req.headers.origin || '';
    if (origin && isAllowedOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return; }

    const title = String(req.query?.title || '').trim();
    const artist = String(req.query?.artist || '').trim();
    const duration = Number(req.query?.duration || 0);
    if (!title) { sendJson(res, 400, { error: 'title required' }); return; }
    if (title.length > 200 || artist.length > 200) { sendJson(res, 400, { error: 'query too long' }); return; }

    try {
        const exact = new URL(BASE + '/get');
        exact.searchParams.set('track_name', title);
        if (artist) exact.searchParams.set('artist_name', artist);
        if (Number.isFinite(duration) && duration > 0) exact.searchParams.set('duration', String(Math.round(duration)));
        const first = await fetchJson(exact.toString());
        if (first.ok) {
            const hit = normalizeHit(first.json);
            if (hit) { sendJson(res, 200, hit, 'public, s-maxage=3600'); return; }
        }

        const search = new URL(BASE + '/search');
        search.searchParams.set('track_name', title);
        if (artist) search.searchParams.set('artist_name', artist);
        const second = await fetchJson(search.toString());
        const rows = Array.isArray(second.json) ? second.json : [];
        let candidates = rows.map(normalizeHit).filter(Boolean);
        if (Number.isFinite(duration) && duration > 0) {
            candidates = candidates.sort((a, b) => Math.abs((a.duration || duration) - duration) - Math.abs((b.duration || duration) - duration));
        }
        if (candidates[0]) { sendJson(res, 200, candidates[0], 'public, s-maxage=3600'); return; }
        sendJson(res, 404, { error: 'lyrics not found', provider: 'lrclib' }, 'public, s-maxage=300');
    } catch (e) {
        const timedOut = e && e.name === 'AbortError';
        sendJson(res, timedOut ? 504 : 502, { error: timedOut ? 'upstream timeout' : 'upstream unavailable', provider: 'lrclib' });
    }
};
