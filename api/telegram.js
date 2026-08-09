// api/telegram.js — Vercel zero-config Node.js serverless function.
//
// CORS relay for the Apify "Telegram Public Channels Scraper"
// (crawlerbros/telegram-public-channels-scraper), used by LoveHub's Music
// Room. Telegram has NO global music search API, so we search WITHIN a
// curated list of verified public Persian-music channels (all eight channels
// below were live-verified in Phase 12: they exist, are public, and return
// real posts via t.me/s/<handle>). No channel is fabricated.
//
//   ?query=...   run the actor with searchQuery=<query> over the channel list
//
// The APIFY_API_TOKEN secret NEVER leaves the server — the browser only ever
// talks to this same-origin endpoint. If the token is not configured the
// function returns 503 { error: 'APIFY_API_TOKEN_NOT_CONFIGURED' } and the
// frontend provider treats that as a normal per-provider failure (failure
// isolation) — every other provider keeps working.
//
// Safety guarantees:
//   * Only `query` is forwarded (validated, length-capped) — nothing else is
//     ever sent to Apify, so this endpoint cannot be abused as a proxy.
//   * Only AUDIO/audio-like media attachments are kept by the frontend
//     provider. The returned media URLs are Telegram's own signed CDN URLs
//     (cdn*.telesco.pe/file/...?token=...) — this function NEVER fetches,
//     proxies, caches, downloads, re-hosts or permanently stores any media
//     file. The URLs are temporary and intended for immediate playback.
//   * The token is read from the environment and never appears in any
//     response, log or header.
//   * Responses are CDN-cached briefly (s-maxage) to avoid excessive Apify
//     calls on repeat queries; the frontend provider + searchSmart caches
//     add another layer.
//   * Timeouts, non-200 upstream responses, malformed JSON and Apify errors
//     produce clean JSON errors.
//
// Deployed at: https://lovehub-gamma.vercel.app/api/telegram

'use strict';

const APIFY_API = 'https://api.apify.com/v2';
const ACTOR_ID = 'crawlerbros~telegram-public-channels-scraper';
const TIMEOUT_MS = 22000; // Apify sync runs typically take ~5-15s

// Verified public Persian-music channels (Phase 12 live validation).
const CHANNELS = [
    'RadioJavan',
    'Mohsenchavoshi',
    'AvangRecords',
    'OfficialShadmehr',
    'ebiofficialchannel',
    'djborhan',
    'GoogooshLegend2015',
    'Ebi_lover_forever'
];

// Bounded run so every search is small, cheap and fast.
const MAX_POSTS_PER_CHANNEL = 1;
const MAX_ITEMS = 12;

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

    // Validate input: exactly one ?query= (no id lookup — Apify is search-only).
    const query = (req.query && req.query.query != null) ? String(req.query.query).trim() : '';
    if (!query) {
        sendJson(res, 400, { error: 'Provide ?query=...' });
        return;
    }
    if (query.length > 200) {
        sendJson(res, 400, { error: 'query too long' });
        return;
    }

    const token = process.env.APIFY_API_TOKEN || '';
    if (!token) {
        // No secret configured yet — graceful, isolated provider failure.
        sendJson(res, 503, {
            error: 'APIFY_API_TOKEN_NOT_CONFIGURED',
            provider: 'telegram',
            hint: 'Set the APIFY_API_TOKEN environment variable on Vercel to enable Telegram music search.'
        });
        return;
    }

    const runInput = {
        channels: CHANNELS,
        searchQuery: query,
        mediaOnly: true,
        maxPostsPerChannel: MAX_POSTS_PER_CHANNEL,
        maxItems: MAX_ITEMS
    };

    const url = APIFY_API + '/acts/' + ACTOR_ID + '/run-sync-get-dataset-items?timeout=20';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let upstream;
    try {
        upstream = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                Authorization: 'Bearer ' + token,
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'User-Agent': 'LoveHub-TelegramRelay/1.0'
            },
            body: JSON.stringify(runInput)
        });
    } catch (e) {
        clearTimeout(timer);
        const timedOut = !!(e && e.name === 'AbortError');
        sendJson(res, timedOut ? 504 : 502, {
            error: timedOut ? 'upstream timeout' : 'upstream unreachable',
            provider: 'telegram'
        });
        return;
    }
    clearTimeout(timer);

    let parsed;
    try {
        parsed = JSON.parse(await upstream.text());
    } catch (e) {
        sendJson(res, 502, { error: 'invalid upstream JSON', provider: 'telegram' });
        return;
    }

    if (!upstream.ok) {
        const detail = (parsed && parsed.error && parsed.error.message)
            ? String(parsed.error.message).slice(0, 200)
            : ('upstream HTTP ' + upstream.status);
        sendJson(res, 502, { error: 'apify error', detail, provider: 'telegram' });
        return;
    }

    // Apify returns the dataset items array directly. Pass them through with
    // their original media URLs (Telegram CDN) — never touched by this relay.
    const items = Array.isArray(parsed) ? parsed
        : (Array.isArray(parsed.items) ? parsed.items : []);
    // Same query is stable enough to cache briefly — cuts Apify spend on
    // repeat queries across users.
    sendJson(res, 200, { items, provider: 'telegram', count: items.length }, 'public, s-maxage=3600');
};
