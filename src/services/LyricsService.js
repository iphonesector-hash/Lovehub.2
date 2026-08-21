export class LyricsService {
    constructor() {
        this._cache = new Map();
        this._overlay = null;
    }

    async fetchLyrics(track) {
        const title = String(track?.title || '').trim();
        const artist = String(track?.artist || '').trim();
        const duration = Number(track?.duration || 0);
        if (!title) return { success: false, error: 'No track selected' };
        const key = `${artist.toLowerCase()}|${title.toLowerCase()}|${Math.round(duration || 0)}`;
        if (this._cache.has(key)) return this._cache.get(key);
        try {
            const url = new URL('/api/lyrics', window.location.origin);
            url.searchParams.set('title', title);
            if (artist) url.searchParams.set('artist', artist);
            if (duration > 0) url.searchParams.set('duration', String(Math.round(duration)));
            const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
            const body = await res.json().catch(() => ({}));
            const result = res.ok
                ? { success: true, lyrics: body }
                : { success: false, error: body.error || 'Lyrics not found' };
            this._cache.set(key, result);
            return result;
        } catch (_) {
            return { success: false, error: 'Lyrics service unavailable' };
        }
    }

    _ensureOverlay() {
        if (this._overlay) return this._overlay;
        const root = document.createElement('div');
        root.id = 'lovehubLyricsOverlay';
        root.style.cssText = 'position:fixed;inset:0;z-index:10050;background:rgba(8,10,18,.86);backdrop-filter:blur(18px);display:none;align-items:flex-end;justify-content:center;padding:16px;padding-bottom:calc(16px + env(safe-area-inset-bottom,0px));';
        root.innerHTML = '<section role="dialog" aria-modal="true" aria-label="Lyrics" style="width:min(720px,100%);max-height:82vh;overflow:hidden;background:var(--glass,rgba(24,27,38,.96));border:1px solid rgba(255,255,255,.12);border-radius:24px;display:flex;flex-direction:column;box-shadow:0 24px 70px rgba(0,0,0,.45)"><header style="display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid rgba(255,255,255,.08)"><div><strong id="lovehubLyricsTitle">Lyrics</strong><div id="lovehubLyricsArtist" style="font-size:12px;opacity:.65;margin-top:2px"></div></div><button id="lovehubLyricsClose" aria-label="Close lyrics" style="border:0;background:transparent;color:inherit;font-size:28px;line-height:1;padding:4px 8px">×</button></header><div id="lovehubLyricsBody" style="padding:18px;overflow:auto;white-space:pre-wrap;line-height:1.9;font-size:16px;text-align:start"></div><footer id="lovehubLyricsSource" style="padding:10px 18px;font-size:11px;opacity:.5;border-top:1px solid rgba(255,255,255,.06)"></footer></section>';
        document.body.appendChild(root);
        root.querySelector('#lovehubLyricsClose')?.addEventListener('click', () => this.close());
        root.addEventListener('click', (e) => { if (e.target === root) this.close(); });
        this._overlay = root;
        return root;
    }

    close() {
        if (this._overlay) this._overlay.style.display = 'none';
    }

    async openForTrack(track) {
        const root = this._ensureOverlay();
        const titleEl = root.querySelector('#lovehubLyricsTitle');
        const artistEl = root.querySelector('#lovehubLyricsArtist');
        const bodyEl = root.querySelector('#lovehubLyricsBody');
        const sourceEl = root.querySelector('#lovehubLyricsSource');
        titleEl.textContent = track?.title || 'Lyrics';
        artistEl.textContent = track?.artist || '';
        bodyEl.textContent = 'Loading lyrics…';
        sourceEl.textContent = '';
        root.style.display = 'flex';

        const result = await this.fetchLyrics(track);
        if (!result.success) {
            bodyEl.textContent = result.error || 'Lyrics not found';
            return result;
        }
        const data = result.lyrics || {};
        bodyEl.textContent = data.plainLyrics || data.syncedLyrics || 'Lyrics not found';
        sourceEl.textContent = data.source === 'lrclib' ? 'Lyrics: LRCLIB' : '';
        return result;
    }
}
