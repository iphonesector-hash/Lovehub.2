// api/rjavan.js — Vercel zero-config Node.js serverless function.
//
// CORS relay for the CodeBazan → Radio Javan search API used by LoveHub's
// Music Room. The upstream API (https://api.codebazan.ir/music/rjavan/) does
// NOT send an Access-Control-Allow-Origin header, so browsers cannot read its
// JSON directly. This function forwards ONLY the metadata/search requests
// LoveHub needs:
//
//   ?query=...   search
//   ?id=...      single-track lookup
//
// Safety guarantees:
//   * Only `query` and `id` are forwarded — nothing else is ever sent
//     upstream, so this endpoint cannot be abused as a general proxy.
//   * The upstream JSON (including link / hls_link / lq_link / hq_link) is
//     passed through UNCHANGED: audio stays on the provider's own servers
//     (host*.media-rj.com). This function NEVER fetches, proxies, caches,
//     downloads or redistributes MP3/audio files.
//   * Responses are Cache-Control: no-store — nothing is cached anywhere.
//   * CORS is allowlisted (LoveHub Vercel prod, GitHub Pages prod, localhost).
//   * Timeouts, non-200 upstream responses and invalid upstream JSON produce
//     clean JSON errors (the frontend provider then falls back to Internet
//     Archive through the existing provider manager).
//
// Deployed at: https://lovehub-gamma.vercel.app/api/rjavan

'use strict';

const UPSTREAM_BASE = 'https://api.codebazan.ir/music/rjavan/';
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

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
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
    if (id && !/^[A-Za-z0-9_-]+$/.test(id)) {
        sendJson(res, 400, { error: 'invalid id' });
        return;
    }

    // Build the upstream request with ONLY the validated param.
    const params = new URLSearchParams();
    if (query) params.set('query', query);
    else params.set('id', id);
    const upstreamUrl = UPSTREAM_BASE + '?' + params.toString();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let upstream;
    try {
        upstream = await fetch(upstreamUrl, {
            signal: controller.signal,
            headers: {
                Accept: 'application/json',
                'User-Agent': 'LoveHub-RjavanRelay/1.0'
            }
        });
    } catch (e) {
        clearTimeout(timer);
        const timedOut = !!(e && e.name === 'AbortError');
        sendJson(res, timedOut ? 504 : 502, {
            error: timedOut ? 'upstream timeout' : 'upstream unreachable',
            provider: 'codebazan-rjavan'
        });
        return;
    }
    clearTimeout(timer);

    if (!upstream.ok) {
        sendJson(res, 502, { error: 'upstream HTTP ' + upstream.status, provider: 'codebazan-rjavan' });
        return;
    }

    let parsed;
    try {
        parsed = JSON.parse(await upstream.text());
    } catch (e) {
        sendJson(res, 502, { error: 'invalid upstream JSON', provider: 'codebazan-rjavan' });
        return;
    }

    // Pass the upstream JSON through unchanged — audio URLs stay provider-direct.
    sendJson(res, 200, parsed);
};
