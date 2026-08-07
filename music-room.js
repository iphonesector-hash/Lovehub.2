// ===========================================================================
// music-room.js — Phase 5: the LoveHub Music Room.
//
// Owns the Music page UI (search / player / queue / favorites / shared) and
// the global mini-player. All external metadata is rendered as TEXT
// (textContent / escapeHtml) — never innerHTML — because search results are
// untrusted third-party data.
//
// The page markup lives in index.html (<section data-page="music">); the
// existing #miniPlayer shell is driven from here. Search is debounced and
// request-stale-guarded; only safe metadata (never signed/expiring URLs) is
// cached in memory; audio listeners are cleaned up on sign-out.
// ===========================================================================

(function () {
    'use strict';

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function fmtTime(sec) {
        if (!isFinite(sec) || sec < 0) return '0:00';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function icon(name) {
        return '<svg class="icon-svg" width="16" height="16"><use href="#icon-' + name + '"/></svg>';
    }

    function el(tag, className, text) {
        const n = document.createElement(tag);
        if (className) n.className = className;
        if (text != null) n.textContent = text;
        return n;
    }

    const FAV_EMOJI = ['❤️', '😂', '😍', '👍', '😢', '🔥', '🥰'];

    class MusicRoom {
        constructor() {
            this.player = window.LoveHubMusicPlayer;
            this.results = [];
            this.favorites = [];
            this.coupleId = null;
            this.myUid = null;
            this._searchSeq = 0;
            this._debounce = null;
            this._view = 'search';
            this._query = '';
            this._favChannelBound = false;

            this._els = {
                input: document.getElementById('musicSearchInput'),
                goBtn: document.getElementById('musicSearchBtn'),
                state: document.getElementById('musicSearchState'),
                results: document.getElementById('musicResults'),
                nowCard: document.getElementById('musicNowCard'),
                queueBtn: document.getElementById('musicQueueBtn'),
                queueSheet: document.getElementById('musicQueueSheet'),
                queueList: document.getElementById('musicQueueList'),
                queueClear: document.getElementById('musicQueueClear'),
                queueDone: document.getElementById('musicQueueDone'),
                tabs: Array.prototype.slice.call(document.querySelectorAll('.music-tab')),
                views: {
                    search: document.getElementById('musicSearchView'),
                    favorites: document.getElementById('musicFavView'),
                    shared: document.getElementById('musicSharedView')
                },
                mini: document.getElementById('miniPlayer'),
                miniPlay: document.getElementById('playBtn'),
                miniFill: document.getElementById('progressFill'),
                fab: document.getElementById('musicFab')
            };

            this._bindEvents();
            this._bindPlayer();
            this._updateMiniPlayer();
        }

        // -------------------------------------------------------------------
        // Public lifecycle hooks (called from app.js)
        // -------------------------------------------------------------------

        // After sign-in: load the couple library + subscribe to partner shares.
        async onAuthChanged(couple) {
            this.coupleId = couple ? couple.id : null;
            this.myUid = (window.app && window.app.currentUser && window.app.currentUser.id) || null;
            if (this._favChannelBound) {
                window.LoveHubMusic && window.LoveHubMusic.unsubscribeFavorites();
                this._favChannelBound = false;
            }
            if (this.coupleId && window.LoveHubMusic) {
                await this.refreshFavorites();
                this._subscribeFavorites();
            } else {
                this.favorites = [];
                this._renderFavorites();
            }
            this._renderNowCard();
            this._updateMiniPlayer();
        }

        onSignOut() {
            this.coupleId = null;
            this.myUid = null;
            this.favorites = [];
            this.results = [];
            if (this._favChannelBound && window.LoveHubMusic) {
                window.LoveHubMusic.unsubscribeFavorites();
                this._favChannelBound = false;
            }
            this._renderFavorites();
            this._renderResults();
            this._hideQueue();
        }

        // Opening the Music tab: refresh library + keep the player UI current.
        async onPageOpen() {
            if (this.coupleId && window.LoveHubMusic) await this.refreshFavorites();
            this._renderNowCard();
            this._updateMiniPlayer();
            const input = this._els.input;
            if (input && !this._view) this._switchView('search');
            if (this._view === 'search' && input && !input.value && !this.results.length) {
                this._setSearchState('idle');
            }
        }

        // Any tab change: the mini-player shows whenever music is loaded and
        // the user is NOT on the Music page (5.8 — playback keeps going).
        onPageChanged(page) {
            this._updateMiniPlayer();
            if (page !== 'music') this._hideQueue();
        }

        // -------------------------------------------------------------------
        // Search (5.5) — debounced, stale-guarded, forgiving
        // -------------------------------------------------------------------

        _bindEvents() {
            const input = this._els.input;
            const goBtn = this._els.goBtn;
            if (input) {
                input.addEventListener('input', () => {
                    clearTimeout(this._debounce);
                    const q = input.value;
                    this._debounce = setTimeout(() => this.doSearch(q), 350);
                });
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); this.doSearch(input.value, true); }
                });
            }
            if (goBtn) goBtn.addEventListener('click', () => this.doSearch(input ? input.value : '', true));

            this._els.tabs.forEach((tab) => {
                tab.addEventListener('click', () => this._switchView(tab.dataset.mtab));
            });

            if (this._els.queueBtn) this._els.queueBtn.addEventListener('click', () => this._showQueue());
            if (this._els.queueClear) this._els.queueClear.addEventListener('click', () => this.player.clearQueue());
            if (this._els.queueDone) this._els.queueDone.addEventListener('click', () => this._hideQueue());
            if (this._els.queueSheet) {
                this._els.queueSheet.addEventListener('click', (e) => { if (e.target === this._els.queueSheet) this._hideQueue(); });
            }

            // Music FAB (existing) → Music Room.
            if (this._els.fab) {
                this._els.fab.addEventListener('click', () => {
                    const app = window.app;
                    if (app) app.navigateTo('music');
                    else this.showToast('Please login to open the Music Room');
                });
            }

            // Mini-player (existing shell) — click returns to Music Room,
            // the play/pause button stops propagation.
            const mini = this._els.mini;
            if (mini) {
                mini.addEventListener('click', (e) => {
                    if (e.target.closest('#playBtn')) return;
                    const app = window.app;
                    if (app) app.navigateTo('music');
                });
            }
            if (this._els.miniPlay) {
                this._els.miniPlay.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.player.toggle();
                });
            }
        }

        async doSearch(query, immediate) {
            const q = (query == null ? '' : String(query)).trim();
            if (!q) { this.results = []; this._renderResults(); this._setSearchState('idle'); return; }
            this._query = q;
            const seq = ++this._searchSeq;
            this._setSearchState('loading');
            this._renderResults([]);
            try {
                const results = await window.MusicSearch.search(q);
                if (seq !== this._searchSeq) return; // a newer search superseded this one
                this.results = results;
                const playable = results.filter((t) => t.playableUrl);
                if (!results.length) {
                    this._setSearchState('empty');
                } else if (!playable.length) {
                    this._setSearchState('noplayable');
                } else {
                    this._setSearchState('ok');
                }
                this._renderResults(results);
            } catch (err) {
                if (seq !== this._searchSeq) return;
                this._setSearchState('error');
            }
        }

        retrySearch() {
            if (this._query) this.doSearch(this._query, true);
        }

        _setSearchState(kind) {
            const state = this._els.state;
            if (!state) return;
            state.innerHTML = '';
            const p = el('p', 'music-state-line');
            if (kind === 'loading') {
                p.textContent = 'Searching…';
            } else if (kind === 'empty') {
                p.textContent = 'No results found. Try another song, artist, or language.';
            } else if (kind === 'noplayable') {
                p.textContent = 'No playable results found — try a different query.';
            } else if (kind === 'error') {
                p.textContent = 'Search failed — check your connection.';
                const retry = el('button', 'music-retry', 'Retry');
                retry.addEventListener('click', () => this.retrySearch());
                state.appendChild(p);
                state.appendChild(retry);
                return;
            } else {
                p.textContent = 'Search for songs by name, artist, or a few words — try “دیوار چاوشی” or “Coldplay Yellow”.';
            }
            state.appendChild(p);
        }

        // -------------------------------------------------------------------
        // Rendering
        // -------------------------------------------------------------------

        _switchView(view) {
            this._view = view;
            this._els.tabs.forEach((t) => t.classList.toggle('active', t.dataset.mtab === view));
            Object.keys(this._els.views).forEach((k) => {
                if (this._els.views[k]) this._els.views[k].style.display = k === view ? 'block' : 'none';
            });
            if (view === 'favorites' || view === 'shared') this._renderFavorites();
        }

        _renderResults(results) {
            const box = this._els.results;
            if (!box) return;
            box.innerHTML = '';
            const list = results || this.results;
            if (!list || !list.length) return;
            const frag = document.createDocumentFragment();
            list.forEach((track) => {
                frag.appendChild(this._buildResultRow(track));
            });
            box.appendChild(frag);
        }

        _buildResultRow(track) {
            const row = el('div', 'music-result');
            row.dataset.url = track.playableUrl || '';
            const art = el('div', 'music-result-art');
            if (track.artworkUrl) art.style.backgroundImage = 'url("' + esc(track.artworkUrl) + '")';
            row.appendChild(art);

            const info = el('div', 'music-result-info');
            info.appendChild(el('div', 'music-result-title', track.title || 'Untitled'));
            const meta = [track.artist, track.source].filter(Boolean).join(' · ');
            const metaLine = el('div', 'music-result-meta', meta || 'Unknown artist');
            if (track.duration) metaLine.textContent += ' · ' + fmtTime(track.duration);
            info.appendChild(metaLine);
            row.appendChild(info);

            const playable = !!track.playableUrl;
            const playBtn = el('button', 'music-result-play' + (playable ? '' : ' disabled'), playable ? '▶' : '⛔');
            playBtn.title = playable ? 'Play' : 'Not playable here';
            if (playable) {
                playBtn.addEventListener('click', () => this._playInResults(track));
            }
            row.appendChild(playBtn);

            const addBtn = el('button', 'music-result-add', '➕');
            addBtn.title = 'Add to queue';
            addBtn.addEventListener('click', () => {
                this.player.addToQueue(track);
                this.showToast('Added to queue');
            });
            row.appendChild(addBtn);

            const favBtn = el('button', 'music-result-fav', '♡');
            favBtn.title = 'Save to shared songs';
            favBtn.addEventListener('click', async () => {
                await this.toggleFavorite(track);
            });
            row.appendChild(favBtn);

            return row;
        }

        _renderFavorites() {
            const favView = this._els.views.favorites;
            const sharedView = this._els.views.shared;
            if (!favView && !sharedView) return;
            const myUid = this.myUid;
            const mine = this.favorites.filter((f) => f.profile_id === myUid);
            const theirs = this.favorites.filter((f) => f.profile_id !== myUid);

            const buildList = (rows, emptyMsg) => {
                const box = el('div', 'music-library');
                if (!rows.length) {
                    const p = el('p', 'music-state-line', emptyMsg);
                    box.appendChild(p);
                    return box;
                }
                rows.forEach((f) => {
                    box.appendChild(this._buildLibraryRow(f));
                });
                return box;
            };

            if (favView) {
                favView.innerHTML = '';
                favView.appendChild(buildList(mine, 'Nothing saved yet.<br>Tap ♡ on a search result to keep it here.'));
            }
            if (sharedView) {
                sharedView.innerHTML = '';
                sharedView.appendChild(buildList(theirs, 'Songs your partner shared will appear here.'));
            }
        }

        _buildLibraryRow(fav) {
            const track = {
                title: fav.title || 'Untitled',
                artist: fav.artist || null,
                source: fav.source || null,
                pageUrl: fav.page_url,
                playableUrl: fav.playable_url,
                artworkUrl: fav.artwork_url,
                duration: fav.duration,
                dedupeKey: (fav.metadata && fav.metadata.dedupeKey) || fav.playable_url
            };
            const row = el('div', 'music-result');
            const art = el('div', 'music-result-art');
            if (track.artworkUrl) art.style.backgroundImage = 'url("' + esc(track.artworkUrl) + '")';
            row.appendChild(art);
            const info = el('div', 'music-result-info');
            info.appendChild(el('div', 'music-result-title', track.title));
            const meta = [track.artist, track.source].filter(Boolean).join(' · ');
            const metaLine = el('div', 'music-result-meta', meta || 'Saved song');
            if (track.duration) metaLine.textContent += ' · ' + fmtTime(track.duration);
            info.appendChild(metaLine);
            row.appendChild(info);

            const playBtn = el('button', 'music-result-play', '▶');
            playBtn.addEventListener('click', () => {
                this.player.setQueue([track], 0);
                this.player.playIndex(0);
            });
            row.appendChild(playBtn);

            const removeBtn = el('button', 'music-result-remove', '🗑');
            removeBtn.title = 'Remove from shared songs';
            removeBtn.addEventListener('click', async () => {
                const res = await window.LoveHubMusic.removeFavorite(this.coupleId, fav.id);
                if (res.success) {
                    this.favorites = this.favorites.filter((f) => f.id !== fav.id);
                    this._renderFavorites();
                    this._renderNowCard();
                    this.showToast('Removed from shared songs');
                } else {
                    this.showToast(res.error || 'Could not remove');
                }
            });
            row.appendChild(removeBtn);
            return row;
        }

        // -------------------------------------------------------------------
        // Playback UI (now-playing card + mini player)
        // -------------------------------------------------------------------

        _playInResults(track) {
            const playable = this.results.filter((t) => t.playableUrl);
            const idx = playable.findIndex((t) => t === track || t.dedupeKey === track.dedupeKey);
            this.player.setQueue(playable, idx < 0 ? 0 : idx);
            this.player.playIndex(this.player.index);
        }

        _bindPlayer() {
            const p = this.player;
            p.on('state', () => { this._renderNowCard(); this._renderQueue(); this._updateMiniPlayer(); });
            p.on('track', () => { this._renderNowCard(); this._renderQueue(); this._updateMiniPlayer(); });
            p.on('progress', () => { this._renderNowProgress(); this._updateMiniPlayer(); });
            p.on('error', (e) => {
                this.showToast((e && e.message) || 'Playback failed');
                this._renderNowCard();
            });
        }

        _renderNowCard() {
            const card = this._els.nowCard;
            if (!card) return;
            const s = this.player.snapshot();
            if (!s.current) { card.style.display = 'none'; return; }
            card.style.display = 'block';
            card.innerHTML = '';
            const t = s.current;

            const head = el('div', 'music-now-head');
            const art = el('div', 'music-now-art');
            if (t.artworkUrl) art.style.backgroundImage = 'url("' + esc(t.artworkUrl) + '")';
            head.appendChild(art);
            const info = el('div', 'music-now-info');
            info.appendChild(el('div', 'music-now-title', t.title || 'Untitled'));
            info.appendChild(el('div', 'music-now-artist', [t.artist, t.source].filter(Boolean).join(' · ') || 'Playing'));
            head.appendChild(info);

            const controls = el('div', 'music-now-controls');
            const prev = el('button', 'music-ctl', icon('skipBack'));
            prev.addEventListener('click', () => this.player.previous());
            const playPause = el('button', 'music-ctl music-ctl-main', icon(s.playing ? 'pause' : 'play'));
            playPause.addEventListener('click', () => this.player.toggle());
            const next = el('button', 'music-ctl', icon('skipForward'));
            next.addEventListener('click', () => this.player.next());
            controls.appendChild(prev); controls.appendChild(playPause); controls.appendChild(next);

            const progress = el('div', 'music-now-progress');
            const range = document.createElement('input');
            range.type = 'range';
            range.min = '0';
            range.max = String(Math.max(1, Math.ceil(s.duration || 0)));
            range.value = String(Math.floor(s.time || 0));
            range.step = '0.5';
            let dragging = false;
            range.addEventListener('pointerdown', () => { dragging = true; });
            range.addEventListener('input', () => { if (dragging) this.player.seek(Number(range.value)); });
            range.addEventListener('pointerup', () => { dragging = false; this.player.seek(Number(range.value)); });
            range.addEventListener('pointercancel', () => { dragging = false; });
            progress.appendChild(range);
            const times = el('div', 'music-now-times');
            const cur = el('span', null, fmtTime(s.time));
            const dur = el('span', null, fmtTime(s.duration));
            cur.id = 'musicCurTime';
            dur.id = 'musicDurTime';
            times.appendChild(cur); times.appendChild(dur);
            progress.appendChild(times);

            const foot = el('div', 'music-now-foot');
            const vol = el('div', 'music-now-volume');
            const volIcon = el('span', 'music-vol-icon', icon('volume'));
            const volRange = document.createElement('input');
            volRange.type = 'range';
            volRange.min = '0'; volRange.max = '1'; volRange.step = '0.05';
            volRange.value = String(s.volume);
            volRange.addEventListener('input', () => this.player.setVolume(Number(volRange.value)));
            vol.appendChild(volIcon); vol.appendChild(volRange);

            const favBtn = el('button', 'music-now-fav', icon('heart'));
            favBtn.title = 'Save / remove from shared songs';
            favBtn.addEventListener('click', async () => this.toggleFavorite(t));
            const shareBtn = el('button', 'music-now-share', icon('share'));
            shareBtn.title = 'Share with your partner';
            shareBtn.addEventListener('click', async () => {
                const res = await this._ensureFavorite(t);
                this.showToast(res === 'added' ? 'Shared with your partner ❤️' : res === 'exists' ? 'Already in your shared songs' : 'Please login to share');
            });
            const retryBtn = el('button', 'music-now-retry', icon('refresh'));
            retryBtn.title = 'Retry playback';
            retryBtn.addEventListener('click', () => this.player.retry());
            foot.appendChild(vol);
            const right = el('div', 'music-now-actions');
            right.appendChild(retryBtn); right.appendChild(shareBtn); right.appendChild(favBtn);
            foot.appendChild(right);

            if (s.error) {
                const err = el('div', 'music-now-error', s.error);
                card.appendChild(err);
            }

            card.appendChild(head);
            card.appendChild(controls);
            card.appendChild(progress);
            card.appendChild(foot);
        }

        _renderNowProgress() {
            const card = this._els.nowCard;
            if (!card || card.style.display === 'none') return;
            const s = this.player.snapshot();
            const range = card.querySelector('.music-now-progress input[type="range"]');
            if (range && document.activeElement !== range) range.value = String(Math.floor(s.time || 0));
            const cur = document.getElementById('musicCurTime');
            if (cur) cur.textContent = fmtTime(s.time);
            const dur = document.getElementById('musicDurTime');
            if (dur) dur.textContent = fmtTime(s.duration);
            const playPause = card.querySelector('.music-ctl-main');
            if (playPause) playPause.innerHTML = icon(s.playing ? 'pause' : 'play');
        }

        _updateMiniPlayer() {
            const mini = this._els.mini;
            if (!mini) return;
            const s = this.player.snapshot();
            const page = (window.app && window.app.currentPage) || 'home';
            const show = !!s.current && page !== 'music';
            mini.classList.toggle('show', show);
            if (!s.current) return;

            const titleEl = mini.querySelector('.mini-title');
            const artistEl = mini.querySelector('.mini-artist');
            const artEl = mini.querySelector('.mini-art');
            if (titleEl) titleEl.textContent = s.current.title || '';
            if (artistEl) artistEl.textContent = [s.current.artist, s.current.source].filter(Boolean).join(' · ') || '';
            if (artEl) {
                if (s.current.artworkUrl) {
                    artEl.style.backgroundImage = 'url("' + esc(s.current.artworkUrl) + '")';
                    artEl.style.backgroundSize = 'cover';
                    artEl.style.backgroundPosition = 'center';
                } else {
                    artEl.style.backgroundImage = '';
                }
            }
            const miniPlay = this._els.miniPlay;
            if (miniPlay) miniPlay.innerHTML = icon(s.playing ? 'pause' : 'play');
            const fill = this._els.miniFill;
            if (fill) {
                const pct = s.duration > 0 ? Math.min(100, (s.time / s.duration) * 100) : 0;
                fill.style.width = pct + '%';
            }
        }

        // -------------------------------------------------------------------
        // Queue sheet
        // -------------------------------------------------------------------

        _showQueue() {
            const sheet = this._els.queueSheet;
            if (!sheet) return;
            this._renderQueue();
            sheet.classList.add('active');
        }

        _hideQueue() {
            const sheet = this._els.queueSheet;
            if (sheet) sheet.classList.remove('active');
        }

        _renderQueue() {
            const list = this._els.queueList;
            if (!list) return;
            list.innerHTML = '';
            const s = this.player.snapshot();
            if (!s.queue.length) {
                list.appendChild(el('p', 'music-state-line', 'Queue is empty.<br>Add songs with ➕ to build your session playlist.'));
                return;
            }
            s.queue.forEach((t, i) => {
                const row = el('div', 'music-queue-row' + (i === s.index ? ' current' : ''));
                const title = el('div', 'music-queue-title', (i === s.index ? '▶ ' : '') + (t.title || 'Untitled'));
                const meta = el('div', 'music-queue-meta', [t.artist, t.source].filter(Boolean).join(' · ') || '');
                const info = el('div', 'music-queue-info');
                info.appendChild(title); info.appendChild(meta);
                row.appendChild(info);

                const up = el('button', 'music-queue-ctl', '↑');
                up.addEventListener('click', () => this.player.moveInQueue(i, i - 1));
                const down = el('button', 'music-queue-ctl', '↓');
                down.addEventListener('click', () => this.player.moveInQueue(i, i + 1));
                const remove = el('button', 'music-queue-ctl danger', '✕');
                remove.addEventListener('click', () => this.player.removeFromQueue(i));

                row.addEventListener('click', (e) => {
                    if (e.target.closest('button')) return;
                    this.player.playIndex(i);
                });

                const btns = el('div', 'music-queue-btns');
                btns.appendChild(up); btns.appendChild(down); btns.appendChild(remove);
                row.appendChild(btns);
                list.appendChild(row);
            });
        }

        // -------------------------------------------------------------------
        // Favorites (5.6) + couple sharing (5.9)
        // -------------------------------------------------------------------

        async refreshFavorites() {
            if (!this.coupleId || !window.LoveHubMusic) return;
            this.favorites = await window.LoveHubMusic.getFavorites(this.coupleId);
            this._renderFavorites();
        }

        async _ensureFavorite(track) {
            if (!this.coupleId || !window.LoveHubMusic) return 'noauth';
            const existing = this.favorites.find((f) =>
                (f.playable_url === track.playableUrl) ||
                (f.metadata && f.metadata.dedupeKey && f.metadata.dedupeKey === track.dedupeKey)
            );
            if (existing) return 'exists';
            const res = await window.LoveHubMusic.addFavorite(this.coupleId, track);
            if (res.success) {
                this.favorites = [res.favorite, ...this.favorites];
                this._renderFavorites();
                this._renderNowCard();
                return 'added';
            }
            return 'error';
        }

        async toggleFavorite(track) {
            const res = await this._ensureFavorite(track);
            if (res === 'added') this.showToast('Saved to your shared songs ❤️');
            else if (res === 'exists') {
                // Toggle OFF: remove it.
                const existing = this.favorites.find((f) =>
                    (f.playable_url === track.playableUrl) ||
                    (f.metadata && f.metadata.dedupeKey && f.metadata.dedupeKey === track.dedupeKey)
                );
                if (existing) {
                    const r = await window.LoveHubMusic.removeFavorite(this.coupleId, existing.id);
                    if (r.success) {
                        this.favorites = this.favorites.filter((f) => f.id !== existing.id);
                        this._renderFavorites();
                        this._renderNowCard();
                        this.showToast('Removed from shared songs');
                    }
                }
            } else if (res === 'noauth') this.showToast('Please login to save songs');
            else this.showToast('Could not save — try again');
        }

        _subscribeFavorites() {
            if (!window.LoveHubMusic || !this.coupleId) return;
            this._favChannelBound = true;
            window.LoveHubMusic.subscribeToFavorites(this.coupleId, {
                onInsert: (row) => {
                    this.refreshFavorites();
                    if (row && row.profile_id !== this.myUid) {
                        const partnerName = (window.app && window.app.currentCouple && window.app.currentCouple.partner && window.app.currentCouple.partner.display_name) || 'Your partner';
                        const isOnMusic = (window.app && window.app.currentPage) === 'music';
                        if (!isOnMusic && window.LoveHubNotifications) {
                            window.LoveHubNotifications.notify('LoveHub Music', {
                                body: partnerName + ' shared “' + (row.title || 'a song') + '” with you'
                            });
                        }
                        this.showToast(partnerName + ' shared “' + (row.title || 'a song') + '” ❤️');
                    }
                },
                onDelete: () => this.refreshFavorites()
            });
        }

        // -------------------------------------------------------------------

        showToast(message) {
            const app = window.app;
            if (app && app.showToast) app.showToast(message);
            else if (window.console) console.info('[MusicRoom]', message);
        }
    }

    window.LoveHubMusicRoom = new MusicRoom();
})();
