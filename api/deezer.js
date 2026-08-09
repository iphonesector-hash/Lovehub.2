// api/deezer.js — Vercel zero-config Node.js serverless function.
//
// CORS relay for the Deezer public API used by LoveHub's Music Room.
// api.deezer.com does NOT send an Access-Control-Allow-Origin header, so
// browsers cannot read its JSON directly. This function forwards ONLY the
// metadata requests LoveHub needs:
//
//   ?query=...   search tracks (30s previews included in the response)
//   ?id=...      single-track lookup
//
// Safety guarantees:
//   * Only `query` / `id` (+ clamped `limit`) are forwarded — nothing else is
//     ever sent upstream, so this endpoint cannot be abused as a general proxy.
//   * The response carries the Deezer `preview` URL (a 30-second CDN sample on
//     cdns-preview-*.dzcdn.net) UNCHANGED. This function NEVER fetches,
//     proxies, caches, downloads or redistributes MP3/audio files — playback is
//     direct from Deezer's CDN in the browser.
//   * CORS is allowlisted (LoveHub Vercel prod, GitHub Pages prod, localhost).
//   * Timeouts, non-200 upstream responses and invalid upstream JSON produce
//     clean JSON errors (the frontend provider then falls back through the
//     existing provider manager).
//
// Deployed at: https://lovehub-gamma.vercel.app/api/deezer

'use strict';

const UPSTREAM_BASE = 'https://api.deezer.com';
const TIMEOUT_MS = 9000;

// Safe CORS allowlist — only these origins may read the relay response.
const ALLOWED_ORIGINS = [
    'https://lovehub-gamma.vercel.app',
    'https://iphonesector-hash.github.io'
];

function isAllowedOrigin(origin) {
    if (!origin || typeof origin !== 'string') return false;
    if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return true;
    try {
        const u = new URL(origin);
        return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    } catch (e) {
        return false;
    }
}

function sendJson(res, status, body, cacheControl) {
    const payload = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', cacheControl || 'no-store');
    res.setHeader('Vary', 'Origin');
    res.end(payload);
}

module.exports = async function handler(req, res) {
    const origin = req.headers.origin || '';

    if (origin && isAllowedOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
    }
    if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
    }

    // Validate input: exactly one of ?query= or ?id=.
    const query = (req.query && req.query.query != null) ? String(req.query.query).trim() : '';
    const id = (req.query && req.query.id != null) ? String(req.query.id).trim() : '';
    if (!query && !id) {
        sendJson(res, 400, { error: 'Provide ?query=... or ?id=...' });
        return;
    }
    if (query && id) {
        sendJson(res, 400, { error: 'Provide either ?query=... or ?id=..., not both' });
        return;
    }
    if (query && query.length > 200) {
        sendJson(res, 400, { error: 'query too long' });
        return;
    }
    if (id && !/^[0-9]+$/.test(id)) {
        sendJson(res, 400, { error: 'invalid id' });
        return;
    }
    let limit = 50;
    if (req.query && req.query.limit != null) {
        const l = Number(req.query.limit);
        if (isFinite(l) && l >= 1 && l <= 100) limit = Math.floor(l);
    }

    // Build the upstream request with ONLY the validated params.
    let upstreamUrl;
    if (query) {
        upstreamUrl = UPSTREAM_BASE + '/search?q=' + encodeURIComponent(query) + '&limit=' + limit;
    } else {
        upstreamUrl = UPSTREAM_BASE + '/track/' + encodeURIComponent(id);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let upstream;
    try {
        upstream = await fetch(upstreamUrl, {
            signal: controller.signal,
            headers: {
                Accept: 'application/json',
                'User-Agent': 'LoveHub-DeezerRelay/1.0'
            }
        });
    } catch (e) {
        clearTimeout(timer);
        const timedOut = !!(e && e.name === 'AbortError');
        sendJson(res, timedOut ? 504 : 502, {
            error: timedOut ? 'upstream timeout' : 'upstream unreachable',
            provider: 'deezer'
        });
        return;
    }
    clearTimeout(timer);

    if (!upstream.ok) {
        sendJson(res, 502, { error: 'upstream HTTP ' + upstream.status, provider: 'deezer' });
        return;
    }

    let parsed;
    try {
        parsed = JSON.parse(await upstream.text());
    } catch (e) {
        sendJson(res, 502, { error: 'invalid upstream JSON', provider: 'deezer' });
        return;
    }

    // Search responses carry { data, total, next }; pass the track list through
    // unchanged — preview URLs stay provider-direct (Deezer CDN). Never touched.
    if (query && parsed && Array.isArray(parsed.data)) {
        sendJson(res, 200, { data: parsed.data, total: parsed.total != null ? parsed.total : parsed.data.length }, 'public, s-maxage=60');
        return;
    }
    // Single-track lookup: the track object itself.
    sendJson(res, 200, parsed, 'public, s-maxage=60');
};
