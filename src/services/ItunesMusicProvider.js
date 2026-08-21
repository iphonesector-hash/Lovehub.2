// Keyless iTunes/Apple Music preview provider for LoveHub Music Room.
// Uses LoveHub's same-origin /api/itunes relay. Audio previews remain direct
// Apple CDN URLs; this module never downloads or proxies media.

// This module is imported by src/main.js before AuthService is instantiated.
// Install the cross-device username-login fallback here so Private Browsing and
// fresh devices do not depend on the legacy local username->email map.
import { AuthService } from './AuthService.js';
import { installUsernameLoginFallback } from './UsernameLoginBridge.js';
import { installMusicRoomEnhancer } from './MusicRoomEnhancer.js';
installUsernameLoginFallback(AuthService);
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installMusicRoomEnhancer, { once: true });
} else {
    installMusicRoomEnhancer();
}

function artwork600(item) {
    const url = item?.artworkUrl100 || item?.artworkUrl60 || item?.artworkUrl30 || null;
    return url ? String(url).replace(/\/\d+x\d+bb\./, '/600x600bb.') : null;
}

function toTrack(item) {
    if (!item || item.wrapperType !== 'track' || item.kind !== 'song') return null;
    const preview = item.previewUrl ? String(item.previewUrl) : null;
    const id = item.trackId != null ? String(item.trackId) : '';
    const title = String(item.trackName || '').trim();
    const artist = String(item.artistName || '').trim();
    if (!id || !title || !artist) return null;

    return {
        id,
        title,
        artist,
        album: String(item.collectionName || ''),
        duration: Number(item.trackTimeMillis || 0) / 1000,
        coverUrl: artwork600(item),
        artworkUrl: artwork600(item),
        audioUrl: preview,
        streamUrl: preview,
        playableUrl: preview,
        playable: !!preview,
        downloadable: false,
        provider: 'itunes',
        providerId: 'itunes',
        source: 'Apple Music Preview',
        sourceType: 'preview',
        playbackMode: preview ? 'html5-audio' : null,
        externalUrl: item.trackViewUrl || item.collectionViewUrl || null,
        pageUrl: item.trackViewUrl || item.collectionViewUrl || null,
        audioEvidence: !!preview,
        metadata: {
            itunes: {
                trackId: id,
                artistId: item.artistId != null ? String(item.artistId) : null,
                collectionId: item.collectionId != null ? String(item.collectionId) : null,
                genre: item.primaryGenreName || null,
                releaseDate: item.releaseDate || null,
                country: item.country || null,
                playbackMode: preview ? 'html5-audio' : null
            }
        }
    };
}

export function installItunesMusicProvider() {
    const registry = window.MusicSearch;
    const manager = registry?.manager;
    const Base = registry?.MusicSearchProvider;
    if (!manager || !Base) return false;
    if (manager.getProvider?.('itunes') || manager.providers?.some?.((p) => p?.id === 'itunes')) return true;

    class ItunesMusicProvider extends Base {
        constructor() {
            super('Apple Music Preview', 'itunes');
            this.timeoutMs = 6500;
            this.preferredQueryKinds = ['original', 'normalized', 'latin'];
            this.legal = { authRequired: false, keyEnv: null };
        }

        async searchTracks(query) {
            const q = String(query || '').trim();
            if (!q) return [];
            const res = await fetch('/api/itunes?query=' + encodeURIComponent(q) + '&limit=50', {
                headers: { Accept: 'application/json' }
            });
            if (!res.ok) throw new Error('iTunes relay HTTP ' + res.status);
            const body = await res.json();
            const rows = Array.isArray(body?.results) ? body.results : [];
            return rows.map(toTrack).filter(Boolean);
        }

        async getTrack(id) {
            const trackId = String(id || '').trim();
            if (!/^\d+$/.test(trackId)) return null;
            const res = await fetch('/api/itunes?id=' + encodeURIComponent(trackId), {
                headers: { Accept: 'application/json' }
            });
            if (!res.ok) return null;
            const body = await res.json();
            const row = Array.isArray(body?.results) ? body.results[0] : null;
            return toTrack(row);
        }
    }

    const provider = new ItunesMusicProvider();
    manager.registerProvider(provider);
    manager.setPriority?.('itunes', 97);
    manager.enable?.('itunes');
    registry.ItunesMusicProvider = ItunesMusicProvider;
    return true;
}

export function installItunesMusicProviderWhenReady() {
    if (installItunesMusicProvider()) return;
    let tries = 0;
    const timer = setInterval(() => {
        tries += 1;
        if (installItunesMusicProvider() || tries >= 20) clearInterval(timer);
    }, 100);
}
