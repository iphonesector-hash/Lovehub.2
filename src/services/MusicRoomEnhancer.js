// Visible Music Room runtime fixes for iOS/mobile.
// Additive only: keeps the canonical MusicPlayerService and existing search UI.

function text(value) { return String(value == null ? '' : value); }

function appleTrack(item) {
    const preview = item?.previewUrl ? String(item.previewUrl) : '';
    if (!preview || item?.kind !== 'song') return null;
    const art = item.artworkUrl100 ? String(item.artworkUrl100).replace(/\/\d+x\d+bb\./, '/600x600bb.') : '';
    return {
        id: String(item.trackId || ''),
        title: text(item.trackName || 'Untitled'),
        artist: text(item.artistName || ''),
        album: text(item.collectionName || ''),
        artworkUrl: art,
        coverUrl: art,
        duration: Number(item.trackTimeMillis || 0) / 1000,
        playableUrl: preview,
        streamUrl: preview,
        audioUrl: preview,
        playable: true,
        provider: 'itunes',
        providerId: 'itunes',
        source: 'Apple Music Preview',
        sourceType: 'preview',
        playbackMode: 'html5-audio',
        pageUrl: item.trackViewUrl || null,
        dedupeKey: 'itunes:' + String(item.trackId || preview)
    };
}

function deezerTrack(item) {
    const preview = item?.preview ? String(item.preview) : '';
    if (!preview) return null;
    const art = item?.album?.cover_xl || item?.album?.cover_big || item?.album?.cover_medium || '';
    return {
        id: String(item.id || ''),
        title: text(item.title_short || item.title || 'Untitled'),
        artist: text(item?.artist?.name || ''),
        album: text(item?.album?.title || ''),
        artworkUrl: art,
        coverUrl: art,
        duration: Number(item.duration || 0),
        playableUrl: preview,
        streamUrl: preview,
        audioUrl: preview,
        playable: true,
        provider: 'deezer',
        providerId: 'deezer',
        source: 'Deezer Preview',
        sourceType: 'preview',
        playbackMode: 'html5-audio',
        pageUrl: item.link || null,
        dedupeKey: 'deezer:' + String(item.id || preview)
    };
}

function ensureStyles() {
    if (document.getElementById('musicRoomEnhancerStyles')) return;
    const style = document.createElement('style');
    style.id = 'musicRoomEnhancerStyles';
    style.textContent = `
      #musicPage.active ~ * #miniPlayer, body:has(#musicPage.active) #miniPlayer { display:none !important; }
      .lh-provider-strip{display:flex;gap:7px;overflow-x:auto;padding:2px 2px 10px;scrollbar-width:none}
      .lh-provider-chip{flex:0 0 auto;padding:6px 10px;border-radius:999px;font-size:11px;font-weight:700;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);opacity:.9}
      .lh-provider-chip.ok:before{content:'● ';color:#30d158}.lh-provider-chip.warn:before{content:'● ';color:#ff9f0a}
      .lh-extra-wrap{margin:14px 0 24px}.lh-extra-title{font-size:14px;font-weight:800;margin:0 0 9px 2px}
      .lh-extra-list{display:grid;gap:8px}.lh-extra-track{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.055);border-radius:15px;min-width:0}
      .lh-extra-art{width:48px;height:48px;flex:0 0 48px;border-radius:10px;background:rgba(255,255,255,.08) center/cover no-repeat}
      .lh-extra-meta{min-width:0;flex:1}.lh-extra-name{font-size:13px;font-weight:750;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.lh-extra-artist{font-size:11px;opacity:.62;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}.lh-extra-source{font-size:9px;opacity:.48;margin-top:3px}
      .lh-extra-play{width:38px;height:38px;border:0;border-radius:50%;background:rgba(255,55,95,.18);color:inherit;font-size:16px}
      .lh-hero-lyrics{border:0;border-radius:999px;padding:8px 12px;background:rgba(255,255,255,.09);color:inherit;font-size:11px;font-weight:750;margin-left:7px}
    `;
    document.head.appendChild(style);
}

function isMusicActive() {
    return document.getElementById('musicPage')?.classList.contains('active');
}

function syncMiniPlayer() {
    const mini = document.getElementById('miniPlayer');
    if (!mini) return;
    if (isMusicActive()) {
        mini.style.setProperty('display', 'none', 'important');
        mini.setAttribute('aria-hidden', 'true');
    } else {
        mini.style.removeProperty('display');
        mini.removeAttribute('aria-hidden');
    }
}

function installProviderStrip() {
    const search = document.getElementById('musicSearchBar');
    if (!search || document.getElementById('lhProviderStrip')) return;
    const row = document.createElement('div');
    row.id = 'lhProviderStrip';
    row.className = 'lh-provider-strip';
    row.innerHTML = '<span class="lh-provider-chip ok">Apple</span><span class="lh-provider-chip ok">Deezer</span><span class="lh-provider-chip ok">Archive</span><span class="lh-provider-chip ok">Audius</span><span class="lh-provider-chip warn">Radio Javan fallback</span>';
    search.insertAdjacentElement('afterend', row);
}

function makeTrackRow(track) {
    const row = document.createElement('div');
    row.className = 'lh-extra-track';
    const art = document.createElement('div');
    art.className = 'lh-extra-art';
    if (track.artworkUrl) art.style.backgroundImage = `url("${String(track.artworkUrl).replace(/"/g, '')}")`;
    const meta = document.createElement('div'); meta.className = 'lh-extra-meta';
    const name = document.createElement('div'); name.className = 'lh-extra-name'; name.textContent = track.title;
    const artist = document.createElement('div'); artist.className = 'lh-extra-artist'; artist.textContent = track.artist || 'Unknown artist';
    const source = document.createElement('div'); source.className = 'lh-extra-source'; source.textContent = track.source;
    meta.append(name, artist, source);
    const play = document.createElement('button'); play.type = 'button'; play.className = 'lh-extra-play'; play.setAttribute('aria-label', 'Play'); play.textContent = '▶';
    play.addEventListener('click', async () => {
        const player = window.LoveHubMusicPlayer;
        if (!player?.loadTrack) return;
        await player.loadTrack(track, { autoplay: true, fromUser: true });
        document.getElementById('musicHero')?.style.removeProperty('display');
    });
    row.append(art, meta, play);
    return row;
}

async function fetchExtras(query) {
    const q = String(query || '').trim();
    if (!q) return [];
    const requests = [
        fetch('/api/itunes?query=' + encodeURIComponent(q) + '&limit=12', { headers: { Accept: 'application/json' } })
            .then(r => r.ok ? r.json() : null).then(b => (b?.results || []).map(appleTrack).filter(Boolean)).catch(() => []),
        fetch('/api/deezer?query=' + encodeURIComponent(q) + '&limit=12', { headers: { Accept: 'application/json' } })
            .then(r => r.ok ? r.json() : null).then(b => (b?.data || []).map(deezerTrack).filter(Boolean)).catch(() => [])
    ];
    const groups = await Promise.all(requests);
    const seen = new Set();
    const out = [];
    for (const track of groups.flat()) {
        const key = (track.title + '|' + track.artist).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key); out.push(track);
        if (out.length >= 16) break;
    }
    return out;
}

async function renderExtras(query) {
    const host = document.getElementById('musicResults');
    if (!host) return;
    document.getElementById('lhExtraProviderResults')?.remove();
    const tracks = await fetchExtras(query);
    if (!tracks.length) return;
    const wrap = document.createElement('section'); wrap.id = 'lhExtraProviderResults'; wrap.className = 'lh-extra-wrap';
    const title = document.createElement('div'); title.className = 'lh-extra-title'; title.textContent = 'Apple Music & Deezer';
    const list = document.createElement('div'); list.className = 'lh-extra-list'; tracks.forEach(t => list.appendChild(makeTrackRow(t)));
    wrap.append(title, list); host.appendChild(wrap);
}

function bindSearchAugment() {
    const input = document.getElementById('musicSearchInput');
    const btn = document.getElementById('musicSearchBtn');
    if (!input || !btn || btn.dataset.lhEnhanced === '1') return;
    btn.dataset.lhEnhanced = '1';
    btn.addEventListener('click', () => setTimeout(() => renderExtras(input.value), 120), false);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') setTimeout(() => renderExtras(input.value), 120);
    }, false);
}

function installHeroLyrics() {
    const actions = document.querySelector('.music-hero-actions');
    if (!actions || document.getElementById('lhHeroLyrics')) return;
    const button = document.createElement('button');
    button.id = 'lhHeroLyrics'; button.type = 'button'; button.className = 'lh-hero-lyrics'; button.textContent = 'Lyrics';
    button.addEventListener('click', async () => {
        const track = window.LoveHubMusicPlayer?.current;
        if (!track) return window.app?.showToast?.('No track selected');
        await window.LoveHubLyrics?.openForTrack?.(track);
    });
    actions.appendChild(button);
}

export function installMusicRoomEnhancer() {
    ensureStyles();
    installProviderStrip();
    bindSearchAugment();
    installHeroLyrics();
    syncMiniPlayer();
    const page = document.getElementById('musicPage');
    if (page) new MutationObserver(syncMiniPlayer).observe(page, { attributes: true, attributeFilter: ['class'] });
    const mini = document.getElementById('miniPlayer');
    if (mini) new MutationObserver(syncMiniPlayer).observe(mini, { attributes: true, attributeFilter: ['style', 'class'] });
    document.addEventListener('click', () => setTimeout(syncMiniPlayer, 0), true);
}
