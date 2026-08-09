// api/youtube.js — Vercel zero-config Node.js serverless function.
//
// Server-side relay for the OFFICIAL YouTube Data API v3, used by LoveHub's
// Music Room. The YOUTUBE_API_KEY secret NEVER leaves the server — the browser
// only ever talks to this same-origin endpoint:
//
//   ?query=...   search.list  (part=snippet, type=video, videoCategoryId=10)
//   ?id=...      videos.list  (part=snippet,contentDetails -> duration)
//
// If YOUTUBE_API_KEY is not configured the function returns
//   503 { error: 'YOUTUBE_API_KEY_NOT_CONFIGURED' }
// and the frontend provider treats that as a normal per-provider failure
// (failure isolation) — every other provider keeps working.
//
// The official API returns METADATA ONLY — no audio or MP3 URLs. This function
// never fetches, proxies, caches, downloads or redistributes any audio/video
// file. Playback (when enabled in the UI) uses YouTube's own IFrame player.
//
// Quota: search.list costs 100 units, videos.list costs 1 unit; default quota
// is 10,000 units/day (~100 searches/day) — the frontend provider cache
// (CACHE_TTL_MS) plus the s-maxage below keep repeat queries off the quota.
//
// Deployed at: https://lovehub-gamma.vercel.app/api/youtube

'use strict';

const UPSTREAM_BASE = 'https://www.googleapis.com/youtube/v3';
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

// Trim a YouTube search.list item to the minimal shape LoveHub needs.
function normalizeSearchItem(item) {
    const sn = (item && item.snippet) || {};
    const videoId = (item && item.id && item.id.videoId) || null;
    if (!videoId) return null;
    const thumbs = sn.thumbnails || {};
    const thumb = (thumbs.medium && thumbs.medium.url) || (thumbs.high && thumbs.high.url)
        || (thumbs.default && thumbs.default.url) || null;
    return {
        videoId,
        kind: item.kind || 'youtube#video',
        title: sn.title || '',
        channelId: sn.channelId || null,
        channelTitle: sn.channelTitle || null,
        publishedAt: sn.publishedAt || null,
        thumbnail: thumb,
        videoUrl: 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId)
    };
}

// ISO-8601 duration ("PT3M45S") -> seconds.
function isoDurationToSeconds(d) {
    if (!d || typeof d !== 'string') return null;
    const m = d.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
    if (!m) return null;
    return ((+m[1] || 0) * 3600) + ((+m[2] || 0) * 60) + (+m[3] || 0);
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
    if (id && !/^[A-Za-z0-9_-]{6,}$/.test(id)) {
        sendJson(res, 400, { error: 'invalid id' });
        return;
    }
    let maxResults = 25;
    if (req.query && req.query.maxResults != null) {
        const m = Number(req.query.maxResults);
        if (isFinite(m) && m >= 1 && m <= 50) maxResults = Math.floor(m);
    }

    const apiKey = process.env.YOUTUBE_API_KEY || '';
    if (!apiKey) {
        // No secret configured yet — graceful, isolated provider failure.
        sendJson(res, 503, {
            error: 'YOUTUBE_API_KEY_NOT_CONFIGURED',
            provider: 'youtube',
            hint: 'Set the YOUTUBE_API_KEY environment variable on Vercel to enable YouTube search.'
        });
        return;
    }

    let upstreamUrl;
    if (query) {
        const p = new URLSearchParams({
            part: 'snippet',
            type: 'video',
            order: 'relevance',
            videoCategoryId: '10',
            q: query,
            maxResults: String(maxResults),
            key: apiKey
        });
        upstreamUrl = UPSTREAM_BASE + '/search?' + p.toString();
    } else {
        const p = new URLSearchParams({
            part: 'snippet,contentDetails',
            id: id,
            key: apiKey
        });
        upstreamUrl = UPSTREAM_BASE + '/videos?' + p.toString();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let upstream;
    try {
        upstream = await fetch(upstreamUrl, {
            signal: controller.signal,
            headers: {
                Accept: 'application/json',
                'User-Agent': 'LoveHub-YouTubeRelay/1.0'
            }
        });
    } catch (e) {
        clearTimeout(timer);
        const timedOut = !!(e && e.name === 'AbortError');
        sendJson(res, timedOut ? 504 : 502, {
            error: timedOut ? 'upstream timeout' : 'upstream unreachable',
            provider: 'youtube'
        });
        return;
    }
    clearTimeout(timer);

    let parsed;
    try {
        parsed = JSON.parse(await upstream.text());
    } catch (e) {
        sendJson(res, 502, { error: 'invalid upstream JSON', provider: 'youtube' });
        return;
    }

    if (!upstream.ok) {
        const detail = (parsed && parsed.error && parsed.error.message) ? String(parsed.error.message).slice(0, 200) : ('upstream HTTP ' + upstream.status);
        sendJson(res, 502, { error: 'youtube api error', detail, provider: 'youtube' });
        return;
    }

    if (query) {
        const items = (parsed.items || []).map(normalizeSearchItem).filter(Boolean);
        // Search results are stable enough to cache briefly — cuts quota usage
        // on repeat queries across users.
        sendJson(res, 200, { items }, 'public, s-maxage=300');
        return;
    }

    // Single-video lookup: add the parsed duration.
    const items = (parsed.items || []).map((item) => {
        const normalized = {
            videoId: item.id || null,
            kind: item.kind || 'youtube#video',
            title: (item.snippet && item.snippet.title) || '',
            channelId: (item.snippet && item.snippet.channelId) || null,
            channelTitle: (item.snippet && item.snippet.channelTitle) || null,
            publishedAt: (item.snippet && item.snippet.publishedAt) || null,
            thumbnail: (item.snippet && item.snippet.thumbnails && item.snippet.thumbnails.medium && item.snippet.thumbnails.medium.url) || null,
            videoUrl: 'https://www.youtube.com/watch?v=' + encodeURIComponent(String(item.id || '')),
            durationSeconds: isoDurationToSeconds(item.contentDetails && item.contentDetails.duration)
        };
        return normalized.videoId ? normalized : null;
    }).filter(Boolean);
    sendJson(res, 200, { items }, 'public, s-maxage=300');
};
