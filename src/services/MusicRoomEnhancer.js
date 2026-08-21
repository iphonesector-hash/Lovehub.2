// Music Room runtime compatibility fixes for iOS/mobile.
// Keeps the canonical MusicPlayerService and normalizes provider payloads
// before playback so provider-specific metadata cannot break the player.

function isMusicActive() {
    const page = document.getElementById('musicPage');
    if (!page) return false;
    const activePage = document.querySelector('.page.active');
    if (activePage === page || page.classList.contains('active')) return true;
    const style = getComputedStyle(page);
    const rect = page.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
}

function syncMiniPlayer() {
    const active = isMusicActive();
    document.documentElement.classList.toggle('lh-music-page-active', active);
    const mini = document.getElementById('miniPlayer');
    if (!mini) return;
    if (active) {
        mini.style.setProperty('display', 'none', 'important');
        mini.style.setProperty('visibility', 'hidden', 'important');
        mini.style.setProperty('pointer-events', 'none', 'important');
        mini.setAttribute('aria-hidden', 'true');
    } else {
        mini.style.removeProperty('display');
        mini.style.removeProperty('visibility');
        mini.style.removeProperty('pointer-events');
        mini.removeAttribute('aria-hidden');
    }
}

function ensureStyles() {
    if (document.getElementById('musicRoomEnhancerStyles')) return;
    const style = document.createElement('style');
    style.id = 'musicRoomEnhancerStyles';
    style.textContent = `
      html.lh-music-page-active #miniPlayer{display:none!important;visibility:hidden!important;pointer-events:none!important}
      .lh-provider-strip{display:flex;gap:7px;overflow-x:auto;padding:2px 2px 9px;scrollbar-width:none}
      .lh-provider-chip{flex:0 0 auto;padding:6px 10px;border-radius:999px;font-size:11px;font-weight:700;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1)}
      .lh-provider-chip:before{content:'● ';color:#30d158}
      .lh-music-tools{display:flex;gap:8px;align-items:center;margin:0 0 12px}
      .lh-lyrics-btn{border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:8px 13px;background:rgba(255,55,95,.13);color:inherit;font:inherit;font-size:12px;font-weight:750}
    `;
    document.head.appendChild(style);
}

function installProviderStripAndLyrics() {
    const search = document.getElementById('musicSearchBar');
    if (!search) return;
    let strip = document.getElementById('lhProviderStrip');
    if (!strip) {
        strip = document.createElement('div');
        strip.id = 'lhProviderStrip';
        strip.className = 'lh-provider-strip';
        strip.innerHTML = '<span class="lh-provider-chip">Apple</span><span class="lh-provider-chip">Deezer</span><span class="lh-provider-chip">Radio Javan</span><span class="lh-provider-chip">YouTube</span><span class="lh-provider-chip">Archive</span><span class="lh-provider-chip">Audius</span>';
        search.insertAdjacentElement('afterend', strip);
    }
    if (!document.getElementById('lhLyricsButton')) {
        const tools = document.createElement('div');
        tools.className = 'lh-music-tools';
        const lyrics = document.createElement('button');
        lyrics.type = 'button';
        lyrics.id = 'lhLyricsButton';
        lyrics.className = 'lh-lyrics-btn';
        lyrics.textContent = 'Lyrics';
        lyrics.addEventListener('click', async () => {
            const track = window.LoveHubMusicPlayer?.current;
            if (!track) {
                window.app?.showToast?.('Play a song first');
                return;
            }
            await window.LoveHubLyrics?.openForTrack?.(track);
        });
        tools.appendChild(lyrics);
        strip.insertAdjacentElement('afterend', tools);
    }
}

function validYoutubeId(value) {
    const s = String(value || '').trim();
    return /^[A-Za-z0-9_-]{11}$/.test(s) ? s : null;
}

function youtubeIdFromUrl(value) {
    if (!value) return null;
    try {
        const u = new URL(String(value), window.location.origin);
        if (/youtu\.be$/i.test(u.hostname)) return validYoutubeId(u.pathname.split('/').filter(Boolean)[0]);
        if (/youtube\.com$/i.test(u.hostname) || /youtube-nocookie\.com$/i.test(u.hostname)) {
            return validYoutubeId(u.searchParams.get('v')) || validYoutubeId(u.pathname.split('/').filter(Boolean).pop());
        }
    } catch (_) { /* ignore */ }
    return null;
}

function safeDirectAudio(value) {
    if (!value) return null;
    let s = String(value).trim();
    if (!/^https?:\/\//i.test(s) || /\.m3u8(?:$|\?)/i.test(s)) return null;
    if (/^http:\/\//i.test(s)) s = 'https://' + s.slice(7);
    return s;
}

function normalizePlaybackTrack(track) {
    if (!track || typeof track !== 'object') return track;
    const out = { ...track, metadata: { ...(track.metadata || {}) } };
    const provider = String(out.providerId || out.provider || '').toLowerCase();

    const youtubeLike = provider.includes('youtube') || out.playbackMode === 'youtube-embed' || out.metadata.youtubeId || out.metadata?.youtube?.videoId;
    if (youtubeLike) {
        const videoId = validYoutubeId(out.metadata?.youtube?.videoId)
            || validYoutubeId(out.metadata?.youtubeId)
            || validYoutubeId(out.videoId)
            || validYoutubeId(out.id)
            || youtubeIdFromUrl(out.pageUrl)
            || youtubeIdFromUrl(out.externalUrl)
            || youtubeIdFromUrl(out.playableUrl);
        if (videoId) {
            out.playbackMode = 'youtube-embed';
            out.playable = true;
            out.metadata.youtube = { ...(out.metadata.youtube || {}), videoId, playbackMode: 'youtube-embed' };
        }
    }

    const radioLike = provider === 'codebazan-rjavan' || provider.includes('rjavan') || /radio\s*javan/i.test(String(out.source || ''));
    if (radioLike) {
        const md = out.metadata || {};
        const candidates = [
            md.hq_link, md.hqLink, out.hq_link,
            md.lq_link, md.lqLink, out.lq_link,
            md.link, out.link,
            out.playableUrl, out.audioUrl, out.streamUrl
        ];
        const direct = candidates.map(safeDirectAudio).find(Boolean);
        if (direct) {
            out.playableUrl = direct;
            out.audioUrl = direct;
            out.streamUrl = direct;
            out.playbackMode = 'html5-audio';
            out.playable = true;
        }
    }
    return out;
}

function installPlaybackCompatibility() {
    let tries = 0;
    const attach = () => {
        const player = window.LoveHubMusicPlayer;
        if (!player?.loadTrack) return false;
        if (player.__lhPlaybackCompatibilityInstalled) return true;
        const originalLoadTrack = player.loadTrack.bind(player);
        player.loadTrack = function(track, options) {
            return originalLoadTrack(normalizePlaybackTrack(track), options);
        };
        player.__lhPlaybackCompatibilityInstalled = true;
        return true;
    };
    if (attach()) return;
    const timer = setInterval(() => {
        tries += 1;
        if (attach() || tries >= 80) clearInterval(timer);
    }, 100);
}

export function installMusicRoomEnhancer() {
    ensureStyles();
    installProviderStripAndLyrics();
    installPlaybackCompatibility();
    syncMiniPlayer();

    const pages = document.querySelector('.pages-container') || document.body;
    new MutationObserver(syncMiniPlayer).observe(pages, { subtree: true, attributes: true, attributeFilter: ['class'] });
    document.addEventListener('click', () => setTimeout(syncMiniPlayer, 0), true);
    window.addEventListener('pageshow', syncMiniPlayer);
    // Legacy code can re-open the mini player after a delayed render; keep a
    // tiny guard while the app is alive so Music page always wins.
    setInterval(syncMiniPlayer, 250);
}
