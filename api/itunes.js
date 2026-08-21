'use strict';

// Keyless Apple iTunes Search API relay for LoveHub Music Room.
// Metadata/search only. Preview audio URLs are returned unchanged and played
// directly from Apple's CDN by the browser; this function never proxies audio.

const UPSTREAM = 'https://itunes.apple.com';
const TIMEOUT_MS = 9000;
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

    const query = req.query && req.query.query != null ? String(req.query.query).trim() : '';
    const id = req.query && req.query.id != null ? String(req.query.id).trim() : '';
    if (!query && !id) {
        sendJson(res, 400, { error: 'Provide ?query=... or ?id=...' });
        return;
    }
    if (query && id) {
        sendJson(res, 400, { error: 'Provide either ?query=... or ?id=..., not both' });
        return;
    }
    if (query.length > 200) {
        sendJson(res, 400, { error: 'query too long' });
        return;
    }
    if (id && !/^\d+$/.test(id)) {
        sendJson(res, 400, { error: 'invalid id' });
        return;
    }

    let limit = 50;
    if (req.query && req.query.limit != null) {
        const n = Number(req.query.limit);
        if (Number.isFinite(n)) limit = Math.max(1, Math.min(100, Math.floor(n)));
    }

    const params = new URLSearchParams();
    let path;
    if (query) {
        path = '/search';
        params.set('term', query);
        params.set('media', 'music');
        params.set('entity', 'song');
        params.set('limit', String(limit));
        params.set('country', 'US');
    } else {
        path = '/lookup';
        params.set('id', id);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let upstream;
    try {
        upstream = await fetch(`${UPSTREAM}${path}?${params.toString()}`, {
            signal: controller.signal,
            headers: {
                Accept: 'application/json',
                'User-Agent': 'LoveHub-iTunesRelay/1.0'
            }
        });
    } catch (e) {
        clearTimeout(timer);
        const timedOut = e && e.name === 'AbortError';
        sendJson(res, timedOut ? 504 : 502, {
            error: timedOut ? 'upstream timeout' : 'upstream unreachable',
            provider: 'itunes'
        });
        return;
    }
    clearTimeout(timer);

    if (!upstream.ok) {
        sendJson(res, 502, { error: `upstream HTTP ${upstream.status}`, provider: 'itunes' });
        return;
    }

    let data;
    try {
        data = JSON.parse(await upstream.text());
    } catch (_) {
        sendJson(res, 502, { error: 'invalid upstream JSON', provider: 'itunes' });
        return;
    }

    const results = Array.isArray(data && data.results) ? data.results : [];
    sendJson(res, 200, { resultCount: results.length, results }, 'public, s-maxage=60');
};
