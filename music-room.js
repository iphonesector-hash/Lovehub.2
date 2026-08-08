// ===========================================================================
// music-room.js — the LoveHub Music Room (Phase 5 Premium).
//
// Owns the Music page UI: premium Home (hero + sections), Search (recents /
// suggestions / count / retry), Library (favorites / shared / sent / recent),
// full-screen Now Playing (gestures, lyrics, sleep timer, equalizer),
// smart queue, mini-player, mood, artwork-reactive ambient environment and
// the Canvas visualizer. The single MusicPlayerService from music-player.js
// remains the one and only playback engine.
//
// SECURITY: every external metadata string (titles, artists, provider text)
// is rendered with textContent (el()) — never innerHTML. Only static strings
// (icon SVGs, fixed labels) go through innerHTML. Nothing external is ever
// injected, executed or trusted.
//
// Public hooks (called from app.js — unchanged contract):
//   onAuthChanged(couple)  onSignOut()  onPageOpen()  onPageChanged(page)
// ===========================================================================

(function () {
    'use strict';

    // -----------------------------------------------------------------------
    // Small helpers
    // -----------------------------------------------------------------------

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

    // "3:05" (track is 3:05 long) / "−0:42" style remaining for display.
    function fmtRemaining(sec) {
        if (!isFinite(sec) || sec <= 0) return '0:00';
        return '−' + fmtTime(sec);
    }

    function icon(name, size) {
        const w = size || 16;
        return '<svg class="icon-svg" width="' + w + '" height="' + w + '" aria-hidden="true"><use href="#icon-' + name + '"/></svg>';
    }

    function el(tag, className, text) {
        const n = document.createElement(tag);
        if (className) n.className = className;
        if (text != null) n.textContent = text;
        return n;
    }

    // Safe localStorage (private mode / quota → silent no-ops).
    function safeGet(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw == null ? fallback : JSON.parse(raw);
        } catch (e) { return fallback; }
    }
    function safeSet(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    }

    // -----------------------------------------------------------------------
    // Pure logic (exported for the DOM-free test suite)
    // -----------------------------------------------------------------------

    // Recently played: newest-first, deduped by dedupeKey/playableUrl, capped.
    function pushRecent(list, track, limit) {
        const max = limit || 20;
        const key = (track && (track.dedupeKey || track.playableUrl)) || (track && track.title);
        const next = (list || []).filter((t) => t && ((t.dedupeKey || t.playableUrl) || t.title) !== key);
        const copy = Object.assign({}, track);
        copy.playedAt = Date.now();
        next.unshift(copy);
        if (next.length > max) next.length = max;
        return next;
    }

    // Continue listening: upsert a partially-played track with a resume point.
    function upsertContinue(list, track, resumeAt, limit) {
        const max = limit || 6;
        const url = track && track.playableUrl;
        if (!url) return list || [];
        const next = (list || []).filter((t) => t && t.playableUrl !== url);
        const copy = Object.assign({}, track);
        copy.resumeAt = Math.max(0, Math.floor(resumeAt || 0));
        copy.duration = track.duration || 0;
        copy.updatedAt = Date.now();
        next.unshift(copy);
        if (next.length > max) next.length = max;
        return next;
    }

    // Extract a small palette from raw RGBA pixels via color-bin histogram.
    function samplePalette(pixels, w, h, count) {
        const need = count || 3;
        const bins = new Map();
        const keyOf = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        const stride = Math.max(1, Math.floor((pixels.length / 4) / 900));
        for (let i = 0; i + 3 < pixels.length; i += 4 * stride) {
            const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
            // Skip near-black / near-white pixels (often borders & text).
            if (r < 14 && g < 14 && b < 14) continue;
            if (r > 236 && g > 236 && b > 236) continue;
            const k = keyOf(r, g, b);
            const e = bins.get(k);
            if (e) { e.n++; e.r += r; e.g += g; e.b += b; }
            else bins.set(k, { n: 1, r, g, b });
        }
        const sorted = Array.from(bins.values()).sort((a, b2) => b2.n - a.n);
        const out = [];
        for (let i = 0; i < sorted.length && out.length < need; i++) {
            const e = sorted[i];
            out.push([
                Math.round(e.r / e.n),
                Math.round(e.g / e.n),
                Math.round(e.b / e.n)
            ]);
        }
        if (!out.length) out.push([255, 55, 95], [191, 90, 242], [94, 92, 230]);
        return out;
    }

    // Mood catalogue — influences discovery seeds + the Music Room's ambient
    // presentation ONLY. Never touches LoveHub's global theme.
    const MOODS = {
        romantic: { label: 'Romantic', emoji: '❤️', hue: '#FF5A8A', seeds: ['love songs acoustic', 'عاشقانه'] },
        happy: { label: 'Happy', emoji: '☀️', hue: '#FFD60A', seeds: ['happy pop', 'cheerful music'] },
        calm: { label: 'Calm', emoji: '🌙', hue: '#64D2FF', seeds: ['ambient piano', 'relaxing music'] },
        night: { label: 'Night', emoji: '🌃', hue: '#5E5CE6', seeds: ['night drive', 'lofi beats'] },
        energy: { label: 'Energy', emoji: '⚡', hue: '#FF375F', seeds: ['workout music', 'energetic rock'] },
        focus: { label: 'Focus', emoji: '🎧', hue: '#30D158', seeds: ['focus music', 'study'] }
    };

    const VIS_MODES = [
        { key: 'eq', label: 'Equalizer' },
        { key: 'wave', label: 'Wave' },
        { key: 'circular', label: 'Circle' },
        { key: 'particles', label: 'Particles' },
        { key: 'aurora', label: 'Aurora' }
    ];

    const EQ_PRESETS = [
        { key: 'normal', label: 'Normal' },
        { key: 'bass', label: 'Bass Boost' },
        { key: 'vocal', label: 'Vocal' },
        { key: 'classical', label: 'Classical' },
        { key: 'electronic', label: 'Electronic' },
        { key: 'soft', label: 'Soft' }
    ];

    // -----------------------------------------------------------------------
    // MusicRoom controller
    // -----------------------------------------------------------------------

    class MusicRoom {
        constructor() {
            this.player = window.LoveHubMusicPlayer;
            this.results = [];
            this.favorites = [];
            this.coupleId = null;
            this.myUid = null;
            this._searchSeq = 0;
            this._debounce = null;
            this._view = 'home'; // home | search | library
            this._libView = 'favorites';
            this._query = '';
            this._mood = safeGet('lovehub_music_mood_v1', 'romantic');
            if (!MOODS[this._mood]) this._mood = 'romantic';
            this._eqPreset = safeGet('lovehub_music_eq_v1', 'normal');
            this._visMode = safeGet('lovehub_music_vis_v1', 'eq');
            this.recents = safeGet('lovehub_music_recent_v1', []);
            this.continues = safeGet('lovehub_music_continue_v1', []);
            this.recentSearches = safeGet('lovehub_music_searches_v1', []);
            this._paletteCache = new Map();
            this._npOpen = false;
            this._sleep = { mode: 'off', endsAt: 0, endSong: false, timer: null };
            this._lastContinueSave = 0;
            this._moreMenu = null;
            this._favChannelBound = false;
            this._pendingNpOpen = false;

            this._els = {
                page: document.querySelector('.page[data-page="music"]'),
                searchBar: document.getElementById('musicSearchBar'),
                input: document.getElementById('musicSearchInput'),
                clear: document.getElementById('musicSearchClear'),
                goBtn: document.getElementById('musicSearchBtn'),
                recents: document.getElementById('musicSearchRecents'),
                state: document.getElementById('musicSearchState'),
                results: document.getElementById('musicResults'),
                count: document.getElementById('musicCount'),
                tabs: Array.prototype.slice.call(document.querySelectorAll('.music-tab')),
                views: {
                    home: document.getElementById('musicHomeView'),
                    search: document.getElementById('musicSearchView'),
                    library: document.getElementById('musicLibraryView')
                },
                homeSections: document.getElementById('musicHomeSections'),
                libTabs: Array.prototype.slice.call(document.querySelectorAll('.music-lib-tab')),
                libBody: document.getElementById('musicLibraryBody'),
                hero: document.getElementById('musicHero'),
                heroAmbient: document.getElementById('musicAmbient'),
                heroAmbientArt: document.getElementById('musicAmbientArt'),
                heroVisualizer: document.getElementById('heroVisualizer'),
                heroArt: document.getElementById('heroArt'),
                heroTitle: document.getElementById('heroTitle'),
                heroArtist: document.getElementById('heroArtist'),
                heroSource: document.getElementById('heroSource'),
                heroRange: document.getElementById('heroRange'),
                heroCur: document.getElementById('heroCur'),
                heroRem: document.getElementById('heroRem'),
                heroPrev: document.getElementById('heroPrev'),
                heroPlay: document.getElementById('heroPlay'),
                heroNext: document.getElementById('heroNext'),
                heroFav: document.getElementById('heroFav'),
                heroShare: document.getElementById('heroShare'),
                heroQueue: document.getElementById('heroQueue'),
                heroModes: document.getElementById('heroVisualizerModes'),
                queueBtn: document.getElementById('musicQueueBtn'),
                queueSheet: document.getElementById('musicQueueSheet'),
                queueNow: document.getElementById('musicQueueNow'),
                queueList: document.getElementById('musicQueueList'),
                queueClear: document.getElementById('musicQueueClear'),
                queueDone: document.getElementById('musicQueueDone'),
                queueShuffle: document.getElementById('musicQueueShuffle'),
                sleepBtn: document.getElementById('musicSleepBtn'),
                eqBtn: document.getElementById('musicEqBtn'),
                sleepSheet: document.getElementById('musicSleepSheet'),
                sleepRows: Array.prototype.slice.call(document.querySelectorAll('.music-sleep-row')),
                sleepCancel: document.getElementById('musicSleepCancel'),
                sleepStatus: document.getElementById('musicSleepStatus'),
                eqSheet: document.getElementById('musicEqSheet'),
                eqRows: Array.prototype.slice.call(document.querySelectorAll('.music-eq-row')),
                eqNote: document.getElementById('musicEqNote'),
                np: document.getElementById('musicNowPlaying'),
                npAmbientArt: document.getElementById('npAmbientArt'),
                npVisualizer: document.getElementById('npVisualizer'),
                npArt: document.getElementById('npArt'),
                npTitle: document.getElementById('npTitle'),
                npArtist: document.getElementById('npArtist'),
                npProvider: document.getElementById('npProvider'),
                npRange: document.getElementById('npRange'),
                npCur: document.getElementById('npCur'),
                npRem: document.getElementById('npRem'),
                npPrev: document.getElementById('npPrev'),
                npPlay: document.getElementById('npPlay'),
                npNext: document.getElementById('npNext'),
                npShuffle: document.getElementById('npShuffle'),
                npRepeat: document.getElementById('npRepeat'),
                npFav: document.getElementById('npFav'),
                npShare: document.getElementById('npShare'),
                npQueue: document.getElementById('npQueue'),
                npEq: document.getElementById('npEq'),
                npSleep: document.getElementById('npSleep'),
                npLyrics: document.getElementById('npLyrics'),
                npClose: document.getElementById('npClose'),
                npModes: document.getElementById('npVisualizerModes'),
                npSleepBadge: document.getElementById('npSleepBadge'),
                npLyricsPanel: document.getElementById('npLyricsPanel'),
                npLyricsBody: document.getElementById('npLyricsBody'),
                npError: document.getElementById('npError'),
                mini: document.getElementById('miniPlayer'),
                miniArt: null,
                miniTitle: null,
                miniArtist: null,
                miniPlay: document.getElementById('playBtn'),
                miniNext: document.getElementById('miniNext'),
                miniFav: document.getElementById('miniFav'),
                miniFill: document.getElementById('progressFill'),
                fab: document.getElementById('musicFab')
            };

            // Visualizer — one engine, one analyser, retargetable canvas.
            this.visualizer = window.VisualizerEngine ? new window.VisualizerEngine(null) : null;
            if (this.visualizer && this.player.getAudioElement) {
                this.visualizer.attach(this.player.getAudioElement());
            }
            this._reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

            this._bindEvents();
            this._bindPlayer();
            this._applyMood();
            this._renderSearchRecents();
            this._renderHero();
            this._updateMiniPlayer();
        }

        // -------------------------------------------------------------------
        // Public lifecycle hooks (app.js contract — unchanged)
        // -------------------------------------------------------------------

        async onAuthChanged(couple) {
            this.coupleId = couple ? couple.id : null;
            this.myUid = (window.app && window.app.currentUser && window.app.currentUser.id) || null;
            if (this._favChannelBound) {
                if (window.LoveHubMusic) window.LoveHubMusic.unsubscribeFavorites();
                this._favChannelBound = false;
            }
            if (this.coupleId && window.LoveHubMusic) {
                await this.refreshFavorites();
                this._subscribeFavorites();
            } else {
                this.favorites = [];
            }
            this._renderHero();
            this._renderHome();
            this._renderLibrary();
            this._updateMiniPlayer();
        }

        onSignOut() {
            this.coupleId = null;
            this.myUid = null;
            this.favorites = [];
            this.results = [];
            this._pendingNpOpen = false;
            if (this._favChannelBound && window.LoveHubMusic) {
                window.LoveHubMusic.unsubscribeFavorites();
                this._favChannelBound = false;
            }
            this._closeNowPlaying(true);
            this._hideQueue();
            this._hideSheet(this._els.sleepSheet);
            this._hideSheet(this._els.eqSheet);
            if (this.visualizer) this.visualizer.destroy();
            this._clearMediaSession();
            this._renderResults([]);
            this._renderHome();
            this._renderLibrary();
            this._updateMiniPlayer();
        }

        async onPageOpen() {
            if (this.coupleId && window.LoveHubMusic) await this.refreshFavorites();
            if (this._view === 'home') this._renderHome();
            else if (this._view === 'library') this._renderLibrary();
            this._renderHero();
            this._renderSearchRecents();
            this._updateMiniPlayer();
            this._startVisualizer();
            if (this._view === 'search' && this._els.input && !this._els.input.value && !this.results.length) {
                this._setSearchState('idle');
            }
            if (this._pendingNpOpen) {
                this._pendingNpOpen = false;
                if (this.player.current) this._openNowPlaying();
            }
        }

        onPageChanged(page) {
            this._updateMiniPlayer();
            if (page !== 'music') {
                // Leaving the Music Room: every overlay is hidden and Now
                // Playing closes (it lives inside #musicPage). The visualizer
                // always stops so it never animates a hidden canvas.
                this._closeNowPlaying(true);
                this._hideQueue();
                this._hideSheet(this._els.sleepSheet);
                this._hideSheet(this._els.eqSheet);
                this._stopVisualizer();
            }
        }

        // -------------------------------------------------------------------
        // Visualizer lifecycle
        // -------------------------------------------------------------------

        _startVisualizer() {
            if (!this.visualizer) return;
            if (this._reducedMotion) return; // reduced-motion: ambient only
            const canvas = this._npOpen ? this._els.npVisualizer : this._els.heroVisualizer;
            this.visualizer.setCanvas(canvas);
            this.visualizer.setMode(this._visMode);
            this.visualizer.setPlaying(this.player.playing && !!this.player.current);
            this.visualizer.start();
        }

        _stopVisualizer() {
            if (this.visualizer) this.visualizer.stop();
        }

        _setVisMode(mode) {
            this._visMode = mode;
            safeSet('lovehub_music_vis_v1', mode);
            if (this.visualizer) this.visualizer.setMode(mode);
            this._renderVisModeButtons();
        }

        _renderVisModeButtons() {
            [this._els.heroModes, this._els.npModes].forEach((box) => {
                if (!box) return;
                box.innerHTML = '';
                VIS_MODES.forEach((m) => {
                    const b = el('button', 'music-vis-mode' + (m.key === this._visMode ? ' active' : ''), m.key);
                    b.title = m.label;
                    b.setAttribute('aria-label', 'Visualizer: ' + m.label);
                    b.setAttribute('aria-pressed', String(m.key === this._visMode));
                    b.addEventListener('click', (e) => { e.stopPropagation(); this._setVisMode(m.key); });
                    box.appendChild(b);
                });
            });
        }

        // -------------------------------------------------------------------
        // Mood (Music Room only — never the global theme)
        // -------------------------------------------------------------------

        _applyMood() {
            const page = this._els.page;
            if (page) page.dataset.mood = this._mood;
            const m = MOODS[this._mood] || MOODS.romantic;
            // Mood accent lives on the Music page only - never the document root.
            if (page) page.style.setProperty('--music-mood', m.hue);
        }

        setMood(key) {
            if (!MOODS[key]) return;
            this._mood = key;
            safeSet('lovehub_music_mood_v1', key);
            this._applyMood();
            this._renderHome();
            if (this.player.current) this._applyAmbient(this.player.current);
        }

        _renderMoodChips(container) {
            if (!container) return;
            container.innerHTML = '';
            Object.keys(MOODS).forEach((key) => {
                const m = MOODS[key];
                const chip = el('button', 'music-mood-chip' + (key === this._mood ? ' active' : ''), m.emoji + ' ' + m.label);
                chip.setAttribute('aria-pressed', String(key === this._mood));
                chip.addEventListener('click', () => this.setMood(key));
                container.appendChild(chip);
            });
        }

        // -------------------------------------------------------------------
        // Search (5.5 / 9) — debounced, stale-guarded, forgiving
        // -------------------------------------------------------------------

        _bindEvents() {
            const input = this._els.input;
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
            if (this._els.clear) {
                this._els.clear.addEventListener('click', () => {
                    if (input) { input.value = ''; input.focus(); }
                    this.results = [];
                    this._renderResults([]);
                    this._renderSearchRecents();
                    this._setSearchState('idle');
                });
            }
            if (this._els.goBtn) this._els.goBtn.addEventListener('click', () => this.doSearch(input ? input.value : '', true));

            this._els.tabs.forEach((tab) => {
                tab.addEventListener('click', () => this._switchView(tab.dataset.mtab));
            });
            this._els.libTabs.forEach((tab) => {
                tab.addEventListener('click', () => this._switchLibView(tab.dataset.lib));
            });

            if (this._els.queueBtn) this._els.queueBtn.addEventListener('click', () => this._showQueue());
            if (this._els.queueClear) this._els.queueClear.addEventListener('click', () => this.player.clearQueue());
            if (this._els.queueDone) this._els.queueDone.addEventListener('click', () => this._hideQueue());
            if (this._els.queueShuffle) {
                this._els.queueShuffle.addEventListener('click', () => {
                    const on = this.player.toggleShuffle();
                    this.showToast(on ? 'Shuffle on 🔀' : 'Shuffle off');
                    this._renderQueue();
                });
            }
            if (this._els.queueSheet) {
                this._els.queueSheet.addEventListener('click', (e) => { if (e.target === this._els.queueSheet) this._hideQueue(); });
            }

            if (this._els.fab) {
                this._els.fab.addEventListener('click', () => {
                    const app = window.app;
                    if (app) app.navigateTo('music');
                    else this.showToast('Please login to open the Music Room');
                });
            }

            const mini = this._els.mini;
            if (mini) {
                mini.addEventListener('click', (e) => {
                    if (e.target.closest('button')) return;
                    const app = window.app;
                    if (!this.player.current) { if (app) app.navigateTo('music'); return; }
                    // Now Playing lives INSIDE #musicPage - if the Music page
                    // is not active, open it first, then show Now Playing.
                    if (app && app.currentPage !== 'music') {
                        this._pendingNpOpen = true;
                        app.navigateTo('music');
                        return;
                    }
                    this._openNowPlaying();
                });
            }
            if (this._els.miniPlay) {
                this._els.miniPlay.addEventListener('click', (e) => { e.stopPropagation(); this.player.toggle(); });
            }
            if (this._els.miniNext) {
                this._els.miniNext.addEventListener('click', (e) => { e.stopPropagation(); this.player.next(); });
            }
            if (this._els.miniFav) {
                this._els.miniFav.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (this.player.current) await this.toggleFavorite(this.player.current);
                });
            }

            // Hero controls
            if (this._els.heroPlay) this._els.heroPlay.addEventListener('click', () => this.player.toggle());
            if (this._els.heroPrev) this._els.heroPrev.addEventListener('click', () => this.player.previous());
            if (this._els.heroNext) this._els.heroNext.addEventListener('click', () => this.player.next());
            if (this._els.heroFav) this._els.heroFav.addEventListener('click', async () => { if (this.player.current) await this.toggleFavorite(this.player.current); });
            if (this._els.heroShare) this._els.heroShare.addEventListener('click', async () => { if (this.player.current) await this._shareCurrent(); });
            if (this._els.heroQueue) this._els.heroQueue.addEventListener('click', () => this._showQueue());
            if (this._els.hero) {
                this._els.hero.addEventListener('click', (e) => {
                    if (e.target.closest('button, input')) return;
                    if (this.player.current) this._openNowPlaying();
                });
            }
            if (this._els.heroRange) {
                let dragging = false;
                this._els.heroRange.addEventListener('pointerdown', () => { dragging = true; });
                this._els.heroRange.addEventListener('input', () => { if (dragging) this.player.seek(Number(this._els.heroRange.value)); });
                this._els.heroRange.addEventListener('pointerup', () => { dragging = false; this.player.seek(Number(this._els.heroRange.value)); });
                this._els.heroRange.addEventListener('pointercancel', () => { dragging = false; });
            }

            // Now Playing controls
            if (this._els.npClose) this._els.npClose.addEventListener('click', () => this._closeNowPlaying());
            if (this._els.npPlay) this._els.npPlay.addEventListener('click', () => this.player.toggle());
            if (this._els.npPrev) this._els.npPrev.addEventListener('click', () => this.player.previous());
            if (this._els.npNext) this._els.npNext.addEventListener('click', () => this.player.next());
            if (this._els.npShuffle) this._els.npShuffle.addEventListener('click', () => {
                const on = this.player.toggleShuffle();
                this.showToast(on ? 'Shuffle on 🔀' : 'Shuffle off');
                this._renderNowPlaying();
            });
            if (this._els.npRepeat) this._els.npRepeat.addEventListener('click', () => {
                const mode = this.player.cycleRepeat();
                const label = mode === 'off' ? 'Repeat off' : mode === 'all' ? 'Repeat all' : 'Repeat one';
                this.showToast(label);
                this._renderNowPlaying();
            });
            if (this._els.npFav) this._els.npFav.addEventListener('click', async () => { if (this.player.current) await this.toggleFavorite(this.player.current); });
            if (this._els.npShare) this._els.npShare.addEventListener('click', async () => { if (this.player.current) await this._shareCurrent(); });
            if (this._els.npQueue) this._els.npQueue.addEventListener('click', () => { this._hideSheet(this._els.eqSheet); this._hideSheet(this._els.sleepSheet); this._showQueue(); });
            if (this._els.npEq) this._els.npEq.addEventListener('click', () => { this._hideSheet(this._els.sleepSheet); this._openSheet(this._els.eqSheet); });
            if (this._els.npSleep) this._els.npSleep.addEventListener('click', () => { this._hideSheet(this._els.eqSheet); this._openSheet(this._els.sleepSheet); this._renderSleepSheet(); });
            if (this._els.npLyrics) this._els.npLyrics.addEventListener('click', () => this._toggleLyrics());
            if (this._els.npRange) {
                let dragging = false;
                this._els.npRange.addEventListener('pointerdown', () => { dragging = true; });
                this._els.npRange.addEventListener('input', () => { if (dragging) this.player.seek(Number(this._els.npRange.value)); });
                this._els.npRange.addEventListener('pointerup', () => { dragging = false; this.player.seek(Number(this._els.npRange.value)); });
                this._els.npRange.addEventListener('pointercancel', () => { dragging = false; });
            }

            // Sleep timer
            this._els.sleepRows.forEach((row) => {
                row.addEventListener('click', () => {
                    const mins = Number(row.dataset.min || 0);
                    const endSong = row.dataset.end === '1';
                    if (mins > 0) this._setSleepTimer(mins);
                    else if (endSong) this._setSleepTimer('end');
                    else this._cancelSleepTimer();
                    this._hideSheet(this._els.sleepSheet);
                    this.showToast(this._sleepLabel());
                });
            });
            if (this._els.sleepCancel) this._els.sleepCancel.addEventListener('click', () => { this._cancelSleepTimer(); this._hideSheet(this._els.sleepSheet); this.showToast('Sleep timer cancelled'); });
            const sleepDone = document.getElementById('musicSleepDone');
            if (sleepDone) sleepDone.addEventListener('click', () => this._hideSheet(this._els.sleepSheet));

            // Equalizer
            this._els.eqRows.forEach((row) => {
                row.addEventListener('click', () => this._applyEq(row.dataset.preset));
            });

            // Overlay close on backdrop tap (sheets)
            if (this._els.sleepSheet) this._els.sleepSheet.addEventListener('click', (e) => { if (e.target === this._els.sleepSheet) this._hideSheet(this._els.sleepSheet); });
            if (this._els.eqSheet) this._els.eqSheet.addEventListener('click', (e) => { if (e.target === this._els.eqSheet) this._hideSheet(this._els.eqSheet); });

            // Swipe gestures on Now Playing (left=next, right=prev, down=close)
            this._bindSwipe();

            // Keyboard (only while Now Playing is open)
            document.addEventListener('keydown', (e) => this._onKey(e));

            this._renderVisModeButtons();
            // Sync EQ rows with the stored preset.
            this._els.eqRows.forEach((r) => r.classList.toggle('active', r.dataset.preset === this._eqPreset));
        }

        _bindSwipe() {
            const np = this._els.np;
            if (!np) return;
            let x0 = 0, y0 = 0, tracking = false;
            np.addEventListener('pointerdown', (e) => {
                if (e.target.closest('button, input, .music-vis-mode, .music-queue-sheet')) return;
                x0 = e.clientX; y0 = e.clientY; tracking = true;
            });
            np.addEventListener('pointermove', (e) => {
                if (!tracking) return;
                const dx = e.clientX - x0;
                const dy = e.clientY - y0;
                // Pull-down affordance
                if (dy > 0 && Math.abs(dy) > Math.abs(dx) * 1.3 && dy < 120) {
                    np.style.transform = 'translateY(' + dy * 0.5 + 'px)';
                }
            });
            np.addEventListener('pointerup', (e) => {
                if (!tracking) return;
                tracking = false;
                np.style.transform = '';
                const dx = e.clientX - x0;
                const dy = e.clientY - y0;
                if (Math.abs(dx) > 64 && Math.abs(dx) > Math.abs(dy) * 1.3) {
                    if (dx < 0) this.player.next();
                    else this.player.previous();
                } else if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.2) {
                    this._closeNowPlaying();
                }
            });
            np.addEventListener('pointercancel', () => { tracking = false; np.style.transform = ''; });
        }

        _onKey(e) {
            if (!this._npOpen) return;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
            if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); this.player.toggle(); }
            else if (e.key === 'ArrowRight') this.player.next();
            else if (e.key === 'ArrowLeft') this.player.previous();
            else if (e.key === 'ArrowUp') { e.preventDefault(); this.player.setVolume(Math.min(1, this.player.volume + 0.05)); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); this.player.setVolume(Math.max(0, this.player.volume - 0.05)); }
            else if (e.key === 'm' || e.key === 'M') { this.player.setVolume(this.player.volume > 0 ? 0 : 0.8); }
            else if (e.key === 'Escape') this._closeNowPlaying();
        }

        _rememberSearch(q) {
            const clean = String(q || '').trim().slice(0, 60);
            if (!clean) return;
            this.recentSearches = [clean].concat(this.recentSearches.filter((s) => s !== clean)).slice(0, 8);
            safeSet('lovehub_music_searches_v1', this.recentSearches);
            this._renderSearchRecents();
        }

        _renderSearchRecents() {
            const box = this._els.recents;
            if (!box) return;
            box.innerHTML = '';
            if (!this.recentSearches.length) return;
            box.appendChild(el('span', 'music-chip-label', 'Recent'));
            this.recentSearches.forEach((s) => {
                const chip = el('button', 'music-chip', '🕘 ' + s);
                chip.addEventListener('click', () => {
                    if (this._els.input) this._els.input.value = s;
                    this.doSearch(s, true);
                });
                box.appendChild(chip);
            });
        }

        async doSearch(query, immediate) {
            const q = (query == null ? '' : String(query)).trim();
            if (!q) { this.results = []; this._renderResults([]); this._setSearchState('idle'); this._renderSearchRecents(); return; }
            this._query = q;
            const seq = ++this._searchSeq;
            this._setSearchState('loading');
            this._renderResults([]);
            this._rememberSearch(q);
            try {
                const results = await window.MusicSearch.search(q);
                if (seq !== this._searchSeq) return; // superseded by a newer search
                this.results = results;
                const playable = results.filter((t) => t.playableUrl);
                if (!results.length) this._setSearchState('empty');
                else if (!playable.length) this._setSearchState('noplayable');
                else this._setSearchState('ok');
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
                p.classList.add('music-shimmer');
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
            } else if (kind === 'idle') {
                const m = MOODS[this._mood] || MOODS.romantic;
                p.textContent = 'Search songs, artists or a few words — try “دیوار چاوشی” or “Coldplay Yellow”.';
                state.appendChild(p);
                const seeds = el('div', 'music-seed-row');
                seeds.appendChild(el('span', 'music-chip-label', 'For ' + m.label + ' mood:'));
                m.seeds.forEach((seed) => {
                    const chip = el('button', 'music-chip', seed);
                    chip.addEventListener('click', () => {
                        if (this._els.input) this._els.input.value = seed;
                        this.doSearch(seed, true);
                    });
                    seeds.appendChild(chip);
                });
                state.appendChild(seeds);
                return;
            }
            state.appendChild(p);
        }

        // -------------------------------------------------------------------
        // Views
        // -------------------------------------------------------------------

        _switchView(view) {
            this._view = view;
            this._els.tabs.forEach((t) => t.classList.toggle('active', t.dataset.mtab === view));
            Object.keys(this._els.views).forEach((k) => {
                if (this._els.views[k]) this._els.views[k].style.display = k === view ? 'block' : 'none';
            });
            if (view === 'home') this._renderHome();
            else if (view === 'library') this._renderLibrary();
            else if (view === 'search' && this._els.input && !this._els.input.value && !this.results.length) this._setSearchState('idle');
        }

        _switchLibView(view) {
            this._libView = view;
            this._els.libTabs.forEach((t) => t.classList.toggle('active', t.dataset.lib === view));
            this._renderLibrary();
        }

        // -------------------------------------------------------------------
        // Home (5.2 / 20 / 21)
        // -------------------------------------------------------------------

        _renderHome() {
            const box = this._els.homeSections;
            if (!box) return;
            box.innerHTML = '';
            const frag = document.createDocumentFragment();

            const myUid = this.myUid;
            const mine = this.favorites.filter((f) => f.profile_id === myUid);
            const theirs = this.favorites.filter((f) => f.profile_id !== myUid);
            const partnerName = (window.app && window.app.currentCouple && window.app.currentCouple.partner && window.app.currentCouple.partner.display_name) || 'Your partner';

            let any = false;

            // Continue Listening (20)
            const continues = this.continues.filter((c) => c.resumeAt > 0);
            if (continues.length) {
                any = true;
                frag.appendChild(this._sectionHead('Continue Listening', null));
                frag.appendChild(this._hscroll(continues.map((c) => this._buildCard(c, {
                    progress: c.duration > 0 ? Math.min(1, c.resumeAt / c.duration) : 0,
                    badge: 'Resume'
                }))));
            }

            // Recently Played (19)
            if (this.recents.length) {
                any = true;
                frag.appendChild(this._sectionHead('Recently Played', 'Clear', () => {
                    this.recents = [];
                    safeSet('lovehub_music_recent_v1', []);
                    this._renderHome();
                }));
                frag.appendChild(this._hscroll(this.recents.map((t) => this._buildCard(t))));
            }

            // Favorites (mine)
            if (mine.length) {
                any = true;
                frag.appendChild(this._sectionHead('Favorites', null));
                frag.appendChild(this._hscroll(mine.map((f) => this._buildCard(this._favToTrack(f)))));
            }

            // Shared With Partner — "Our Music" (12)
            if (theirs.length) {
                any = true;
                frag.appendChild(this._sectionHead('Our Music', null));
                const rows = el('div', 'music-library');
                theirs.slice(0, 5).forEach((f) => {
                    const track = this._favToTrack(f);
                    const addedBy = el('div', 'music-addedby', 'Added by ' + partnerName + ' ❤️');
                    rows.appendChild(this._buildRow(track, { addedBy, removable: true, favId: f.id }));
                });
                frag.appendChild(rows);
            } else if (mine.length) {
                any = true;
                frag.appendChild(this._sectionHead('Our Music', null));
                const p = el('p', 'music-state-line', 'Share a song with ' + partnerName + ' — tap ♥ on any track. It appears here for you both.');
                frag.appendChild(p);
            }

            // Mood (17)
            any = true;
            frag.appendChild(this._sectionHead('Mood', null));
            const moodBox = el('div', 'music-mood-chips');
            this._renderMoodChips(moodBox);
            frag.appendChild(moodBox);

            if (!any) {
                const empty = el('div', 'music-empty');
                empty.appendChild(el('div', 'music-empty-icon', '🎵'));
                empty.appendChild(el('div', 'music-empty-title', 'Your Music Room is ready'));
                empty.appendChild(el('div', 'music-empty-text', 'Search for songs, favorite them, and share them with your partner. Everything appears here.'));
                const cta = el('button', 'music-retry', 'Search music');
                cta.addEventListener('click', () => this._switchView('search'));
                empty.appendChild(cta);
                frag.appendChild(empty);
            }

            box.appendChild(frag);
        }

        _sectionHead(title, actionLabel, actionFn) {
            const head = el('div', 'music-section-head');
            head.appendChild(el('div', 'music-section-title', title));
            if (actionLabel && actionFn) {
                const a = el('button', 'music-section-action', actionLabel);
                a.addEventListener('click', actionFn);
                head.appendChild(a);
            }
            return head;
        }

        _hscroll(cards) {
            const scroller = el('div', 'music-hscroll');
            cards.forEach((c) => scroller.appendChild(c));
            return scroller;
        }

        _buildCard(track, opts) {
            const o = opts || {};
            const card = el('div', 'music-card' + (this._isCurrent(track) ? ' current' : ''));
            card.tabIndex = 0;
            card.setAttribute('role', 'button');
            card.setAttribute('aria-label', 'Play ' + (track.title || 'track'));
            const art = el('div', 'music-card-art');
            if (track.artworkUrl) art.style.backgroundImage = 'url("' + esc(track.artworkUrl) + '")';
            if (o.progress != null) {
                const bar = el('div', 'music-card-progress');
                const fill = el('div', 'music-card-progress-fill');
                fill.style.width = Math.round(o.progress * 100) + '%';
                bar.appendChild(fill);
                art.appendChild(bar);
            }
            if (o.badge) art.appendChild(el('span', 'music-card-badge', o.badge));
            card.appendChild(art);
            const body = el('div', 'music-card-body');
            body.appendChild(el('div', 'music-card-title', track.title || 'Untitled'));
            body.appendChild(el('div', 'music-card-meta', [track.artist, track.source].filter(Boolean).join(' · ') || 'Unknown artist'));
            if (track.duration) body.appendChild(el('div', 'music-card-dur', fmtTime(track.duration)));
            card.appendChild(body);
            const activate = () => {
                if (track.playableUrl) {
                    this.player.setQueue([track], 0);
                    this.player.playIndex(0).then(() => {
                        if (o.progress != null && track.resumeAt) this.player.seek(track.resumeAt);
                    });
                }
            };
            card.addEventListener('click', activate);
            card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
            return card;
        }

        // -------------------------------------------------------------------
        // Search results (10)
        // -------------------------------------------------------------------

        _renderResults(results) {
            const box = this._els.results;
            if (!box) return;
            box.innerHTML = '';
            const list = results || this.results;
            if (this._els.count) {
                this._els.count.textContent = list.length ? list.length + ' result' + (list.length === 1 ? '' : 's') : '';
            }
            if (!list || !list.length) return;
            const frag = document.createDocumentFragment();
            list.forEach((track) => frag.appendChild(this._buildRow(track, { playable: !!track.playableUrl })));
            box.appendChild(frag);
        }

        _isCurrent(track) {
            const c = this.player.current;
            return !!(c && track && (c.playableUrl === track.playableUrl || (c.dedupeKey && c.dedupeKey === track.dedupeKey)));
        }

        _favToTrack(f) {
            return {
                title: f.title || 'Untitled',
                artist: f.artist || null,
                source: f.source || null,
                pageUrl: f.page_url,
                playableUrl: f.playable_url,
                artworkUrl: f.artwork_url,
                duration: f.duration,
                dedupeKey: (f.metadata && f.metadata.dedupeKey) || f.playable_url
            };
        }

        _isFavorited(track) {
            return this.favorites.some((f) =>
                (f.playable_url === track.playableUrl) ||
                (f.metadata && f.metadata.dedupeKey && f.metadata.dedupeKey === track.dedupeKey)
            );
        }

        _buildRow(track, opts) {
            const o = opts || {};
            const row = el('div', 'music-result' + (this._isCurrent(track) ? ' current' : ''));
            row.tabIndex = 0;
            row.setAttribute('role', 'button');
            row.setAttribute('aria-label', 'Play ' + (track.title || 'track'));
            const art = el('div', 'music-result-art');
            if (track.artworkUrl) art.style.backgroundImage = 'url("' + esc(track.artworkUrl) + '")';
            row.appendChild(art);

            const info = el('div', 'music-result-info');
            info.appendChild(el('div', 'music-result-title', track.title || 'Untitled'));
            const meta = [track.artist, track.source].filter(Boolean).join(' · ');
            const metaLine = el('div', 'music-result-meta', meta || 'Unknown artist');
            if (track.duration) metaLine.textContent += ' · ' + fmtTime(track.duration);
            info.appendChild(metaLine);
            if (o.addedBy) info.appendChild(o.addedBy);
            row.appendChild(info);

            const playable = o.playable !== false && !!track.playableUrl;
            const playBtn = el('button', 'music-result-play' + (playable ? '' : ' disabled'), playable ? '▶' : '⛔');
            playBtn.title = playable ? 'Play' : 'Not playable here';
            playBtn.setAttribute('aria-label', playable ? 'Play' : 'Not playable');
            if (playable) playBtn.addEventListener('click', (e) => { e.stopPropagation(); this._playTrack(track); });
            row.appendChild(playBtn);

            const favBtn = el('button', 'music-result-fav' + (this._isFavorited(track) ? ' on' : ''), this._isFavorited(track) ? '♥' : '♡');
            favBtn.title = 'Save to shared songs';
            favBtn.setAttribute('aria-label', 'Favorite');
            favBtn.addEventListener('click', async (e) => { e.stopPropagation(); await this.toggleFavorite(track); });
            row.appendChild(favBtn);

            if (o.removable) {
                const rmBtn = el('button', 'music-result-remove', '🗑');
                rmBtn.title = 'Remove';
                rmBtn.setAttribute('aria-label', 'Remove from shared songs');
                rmBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const res = await window.LoveHubMusic.removeFavorite(this.coupleId, o.favId);
                    if (res.success) {
                        this.favorites = this.favorites.filter((f) => f.id !== o.favId);
                        this._renderFavorites();
                        this._renderHome();
                        this._renderLibrary();
                        this._renderHero();
                        this.showToast('Removed from shared songs');
                    } else this.showToast(res.error || 'Could not remove');
                });
                row.appendChild(rmBtn);
            } else if (playable) {
                const moreBtn = el('button', 'music-result-more', '⋯');
                moreBtn.title = 'More';
                moreBtn.setAttribute('aria-label', 'More actions');
                moreBtn.addEventListener('click', (e) => { e.stopPropagation(); this._openMoreMenu(moreBtn, track); });
                row.appendChild(moreBtn);
            }

            const activate = () => { if (playable) this._playTrack(track); };
            row.addEventListener('click', activate);
            row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
            return row;
        }

        _playTrack(track) {
            const playable = this.results.filter((t) => t.playableUrl);
            const idx = playable.findIndex((t) => t === track || t.dedupeKey === track.dedupeKey);
            this.player.setQueue(playable, idx < 0 ? 0 : idx);
            this.player.playIndex(this.player.index);
        }

        // ---- more menu (10) ----

        _openMoreMenu(anchor, track) {
            this._closeMoreMenu();
            const menu = el('div', 'music-more-menu');
            const items = [
                { label: 'Play next', fn: () => this._playNext(track) },
                { label: 'Add to queue', fn: () => { this.player.addToQueue(track); this.showToast('Added to queue'); } },
                { label: this._isFavorited(track) ? 'Remove from shared songs' : 'Save to shared songs', fn: async () => await this.toggleFavorite(track) },
                { label: 'Share with partner', fn: async () => await this._shareTrack(track) },
                { label: 'Open source', fn: () => { if (track.pageUrl) window.open(track.pageUrl, '_blank', 'noopener'); } },
                { label: 'Remove from recent history', fn: () => {
                    this.recents = this.recents.filter((t) => (t.dedupeKey || t.playableUrl) !== (track.dedupeKey || track.playableUrl));
                    safeSet('lovehub_music_recent_v1', this.recents);
                    this._renderHome();
                    this.showToast('Removed from history');
                } }
            ];
            items.forEach((it) => {
                const b = el('button', 'music-more-item', it.label);
                b.addEventListener('click', async () => { this._closeMoreMenu(); await it.fn(); });
                menu.appendChild(b);
            });
            menu.addEventListener('pointerdown', (e) => e.stopPropagation());
            document.addEventListener('pointerdown', this._closeMoreMenuBound = () => this._closeMoreMenu(), { once: true });
            // Mounted INSIDE #musicPage so the menu can never escape the page.
            const host = this._els.page || document.body;
            host.appendChild(menu);
            this._moreMenu = menu;
            const r = anchor.getBoundingClientRect();
            const mw = 220;
            let left = r.left;
            if (left + mw > window.innerWidth - 12) left = window.innerWidth - mw - 12;
            let top = r.bottom + 6;
            if (top + menu.offsetHeight > window.innerHeight - 12) top = r.top - menu.offsetHeight - 6;
            menu.style.left = Math.max(12, left) + 'px';
            menu.style.top = Math.max(12, top) + 'px';
        }

        _closeMoreMenu() {
            if (this._moreMenu) { this._moreMenu.remove(); this._moreMenu = null; }
            if (this._closeMoreMenuBound) { document.removeEventListener('pointerdown', this._closeMoreMenuBound); this._closeMoreMenuBound = null; }
        }

        _playNext(track) {
            const p = this.player;
            if (!track || !track.playableUrl) return;
            const at = p.index >= 0 ? p.index + 1 : p.queue.length;
            p.queue.splice(at, 0, track);
            p._rebuildOrder();
            p.emit('state', p.snapshot());
            this.showToast('Plays next');
            this._renderQueue();
        }

        // -------------------------------------------------------------------
        // Library (11 / 12)
        // -------------------------------------------------------------------

        _renderLibrary() {
            const body = this._els.libBody;
            if (!body) return;
            body.innerHTML = '';
            const myUid = this.myUid;
            const mine = this.favorites.filter((f) => f.profile_id === myUid);
            const theirs = this.favorites.filter((f) => f.profile_id !== myUid);
            const partnerName = (window.app && window.app.currentCouple && window.app.currentCouple.partner && window.app.currentCouple.partner.display_name) || 'Your partner';

            let rows = [];
            let emptyMsg = '';
            let showRemove = false;
            let favIds = [];

            if (this._libView === 'favorites') {
                rows = mine.map((f) => this._favToTrack(f));
                emptyMsg = 'Nothing saved yet.<br>Tap ♥ on any track to keep it here.';
                showRemove = true;
                favIds = mine.map((f) => f.id);
            } else if (this._libView === 'shared') {
                rows = this.favorites.map((f) => this._favToTrack(f));
                emptyMsg = 'Songs you and your partner save appear here.';
                showRemove = true;
                favIds = this.favorites.map((f) => f.id);
            } else if (this._libView === 'sent') {
                rows = theirs.map((f) => this._favToTrack(f));
                emptyMsg = 'Nothing from ' + partnerName + ' yet — songs they save appear here with ❤️.';
                showRemove = true;
                favIds = theirs.map((f) => f.id);
            } else if (this._libView === 'recent') {
                rows = this.recents.slice(0, 30);
                emptyMsg = 'Songs you played will appear here.';
            }

            if (!rows.length) {
                const p = el('p', 'music-state-line', emptyMsg);
                body.appendChild(p);
                return;
            }
            const list = el('div', 'music-library');
            rows.forEach((track, i) => {
                const opts = {};
                if (showRemove && favIds[i]) { opts.removable = true; opts.favId = favIds[i]; }
                if (this._libView === 'shared' && theirs.some((f) => (f.playable_url === track.playableUrl))) {
                    opts.addedBy = el('div', 'music-addedby', 'Added by ' + partnerName + ' ❤️');
                }
                list.appendChild(this._buildRow(track, opts));
            });
            if (this._libView === 'recent' && this.recents.length) {
                const clear = el('button', 'music-retry', 'Clear history');
                clear.addEventListener('click', () => { this.recents = []; safeSet('lovehub_music_recent_v1', []); this._renderLibrary(); this._renderHome(); });
                list.appendChild(clear);
            }
            body.appendChild(list);
        }

        _renderFavorites() {
            this._renderHome();
            this._renderLibrary();
            this._renderHero();
        }

        // -------------------------------------------------------------------
        // Playback UI (hero + now playing + mini player)
        // -------------------------------------------------------------------

        _bindPlayer() {
            const p = this.player;
            p.on('state', () => { this._renderHero(); this._renderQueue(); this._renderNowPlaying(); this._updateMiniPlayer(); if (this.visualizer) this.visualizer.setPlaying(p.playing && !!p.current); });
            p.on('track', (s) => {
                this._renderHero();
                this._renderNowPlaying();
                this._updateMiniPlayer();
                if (s && s.current) {
                    this.recents = pushRecent(this.recents, s.current, 20);
                    safeSet('lovehub_music_recent_v1', this.recents);
                    this._renderHome();
                    this._renderLibrary();
                    this._applyAmbient(s.current);
                    this._updateMediaSession(s.current);
                }
            });
            p.on('progress', () => {
                this._renderProgress();
                this._updateMiniPlayer();
                this._maybeSaveContinue();
            });
            p.on('error', (e) => {
                this.showToast((e && e.message) || 'Playback failed');
                this._renderHero();
                this._renderNowPlaying();
            });
            p.on('end', () => {
                this._sleepEndSongIfSet();
            });
        }

        _maybeSaveContinue() {
            const s = this.player.snapshot();
            const t = s.current;
            if (!t || !t.playableUrl || !(s.time > 15)) return;
            if (!(s.duration > 20) || s.time >= s.duration - 8) return;
            const now = Date.now();
            if (now - this._lastContinueSave < 8000) return;
            this._lastContinueSave = now;
            this.continues = upsertContinue(this.continues, t, s.time, 6);
            safeSet('lovehub_music_continue_v1', this.continues);
        }

        _renderHero() {
            const card = this._els.hero;
            if (!card) return;
            const s = this.player.snapshot();
            if (!s.current) { card.style.display = 'none'; this._stopAmbient(); return; }
            card.style.display = 'block';
            const t = s.current;

            if (this._els.heroArt) {
                if (t.artworkUrl) this._els.heroArt.style.backgroundImage = 'url("' + esc(t.artworkUrl) + '")';
                else this._els.heroArt.style.backgroundImage = '';
                this._els.heroArt.classList.toggle('playing', !!s.playing);
            }
            if (this._els.heroTitle) this._els.heroTitle.textContent = t.title || 'Untitled';
            if (this._els.heroArtist) this._els.heroArtist.textContent = t.artist || 'Unknown artist';
            if (this._els.heroSource) {
                this._els.heroSource.textContent = t.source || t.provider || '';
                this._els.heroSource.style.display = (t.source || t.provider) ? '' : 'none';
            }
            if (this._els.heroFav) {
                const favOn = this._isFavorited(t);
                this._els.heroFav.classList.toggle('on', favOn);
                this._els.heroFav.innerHTML = icon(favOn ? 'heartFill' : 'heart', 16);
            }
            if (this._els.heroPlay) this._els.heroPlay.innerHTML = icon(s.playing ? 'pause' : 'play', 22);
            this._renderProgress();
        }

        _renderProgress() {
            const s = this.player.snapshot();
            const dur = s.duration || 0;
            const time = s.time || 0;
            const max = Math.max(1, Math.ceil(dur));

            if (this._els.heroRange) {
                this._els.heroRange.max = String(max);
                if (document.activeElement !== this._els.heroRange) this._els.heroRange.value = String(Math.floor(time));
            }
            if (this._els.heroCur) this._els.heroCur.textContent = fmtTime(time);
            if (this._els.heroRem) this._els.heroRem.textContent = fmtRemaining(dur - time);
            if (this._els.heroPlay) this._els.heroPlay.innerHTML = icon(s.playing ? 'pause' : 'play', 22);

            if (this._npOpen) {
                if (this._els.npRange) {
                    this._els.npRange.max = String(max);
                    if (document.activeElement !== this._els.npRange) this._els.npRange.value = String(Math.floor(time));
                }
                if (this._els.npCur) this._els.npCur.textContent = fmtTime(time);
                if (this._els.npRem) this._els.npRem.textContent = fmtRemaining(dur - time);
                if (this._els.npPlay) this._els.npPlay.innerHTML = icon(s.playing ? 'pause' : 'play', 30);
            }
        }

        // ---- Now Playing (5 / 6 / 7) ----

        _openNowPlaying() {
            if (!this.player.current) return;
            this._npOpen = true;
            const np = this._els.np;
            if (!np) return;
            np.classList.add('open');
            this._renderNowPlaying();
            this._startVisualizer();
            if (this.visualizer) this.visualizer.setPlaying(this.player.playing);
            this._updateMediaSession(this.player.current);
        }

        _closeNowPlaying(silent) {
            this._npOpen = false;
            const np = this._els.np;
            if (np) np.classList.remove('open');
            if (!silent) {
                this._renderHero();
                this._startVisualizer();
            } else {
                this._stopVisualizer();
            }
            this._closeMoreMenu();
        }

        _renderNowPlaying() {
            const np = this._els.np;
            if (!np || !this._npOpen) return;
            const s = this.player.snapshot();
            const t = s.current;
            if (!t) { this._closeNowPlaying(); return; }
            if (this._els.npArt) {
                if (t.artworkUrl) this._els.npArt.style.backgroundImage = 'url("' + esc(t.artworkUrl) + '")';
                else this._els.npArt.style.backgroundImage = '';
            }
            if (this._els.npTitle) this._els.npTitle.textContent = t.title || 'Untitled';
            if (this._els.npArtist) this._els.npArtist.textContent = t.artist || 'Unknown artist';
            if (this._els.npProvider) {
                this._els.npProvider.textContent = (t.source || t.provider || '').toUpperCase();
                this._els.npProvider.style.display = (t.source || t.provider) ? '' : 'none';
            }
            if (this._els.npShuffle) {
                this._els.npShuffle.classList.toggle('on', !!s.shuffle);
                this._els.npShuffle.setAttribute('aria-pressed', String(!!s.shuffle));
            }
            if (this._els.npRepeat) {
                const on = s.repeat !== 'off';
                this._els.npRepeat.classList.toggle('on', on);
                this._els.npRepeat.dataset.mode = s.repeat;
                this._els.npRepeat.setAttribute('aria-pressed', String(on));
                const inner = this._els.npRepeat.querySelector('.music-np-repeat-dot');
                if (inner) inner.style.display = s.repeat === 'one' ? '' : 'none';
            }
            if (this._els.npFav) {
                const on = this._isFavorited(t);
                this._els.npFav.classList.toggle('on', on);
                this._els.npFav.innerHTML = icon(on ? 'heartFill' : 'heart', 18);
            }
            if (this._els.npError) {
                this._els.npError.style.display = s.error ? '' : 'none';
                this._els.npError.textContent = s.error || '';
            }
            this._renderProgress();
        }

        // ---- Ambient artwork-reactive environment (18) ----

        _stopAmbient() {
            const layers = [this._els.heroAmbientArt, this._els.npAmbientArt];
            layers.forEach((l) => { if (l) l.style.backgroundImage = ''; });
        }

        async _applyAmbient(track) {
            const heroLayers = this._els.heroAmbient;
            const npLayers = this._els.npAmbientArt;
            if (!track || !track.artworkUrl) {
                if (heroLayers) heroLayers.style.backgroundImage = '';
                if (npLayers) npLayers.style.backgroundImage = '';
                this._setAmbientPalette(null);
                return;
            }
            if (heroLayers) heroLayers.style.backgroundImage = 'url("' + esc(track.artworkUrl) + '")';
            if (npLayers) npLayers.style.backgroundImage = 'url("' + esc(track.artworkUrl) + '")';
            const palette = await this._paletteFor(track.artworkUrl);
            this._setAmbientPalette(palette);
        }

        async _paletteFor(url) {
            if (!url) return null;
            if (this._paletteCache.has(url)) return this._paletteCache.get(url);
            const canvas = document.createElement('canvas');
            canvas.width = 48; canvas.height = 48;
            const img = new Image();
            img.crossOrigin = 'anonymous';
            const promise = new Promise((resolve) => {
                img.onload = () => {
                    try {
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, 48, 48);
                        const px = ctx.getImageData(0, 0, 48, 48).data;
                        resolve(samplePalette(px, 48, 48, 3));
                    } catch (e) { resolve(null); } // tainted canvas → fallback
                };
                img.onerror = () => resolve(null);
            });
            img.src = url;
            const palette = await promise;
            this._paletteCache.set(url, palette);
            return palette;
        }

        _setAmbientPalette(palette) {
            const m = MOODS[this._mood] || MOODS.romantic;
            const c1 = palette ? 'rgb(' + palette[0].join(',') + ')' : m.hue;
            const c2 = palette && palette[1] ? 'rgb(' + palette[1].join(',') + ')' : '#BF5AF2';
            const c3 = palette && palette[2] ? 'rgb(' + palette[2].join(',') + ')' : '#5E5CE6';
            // Ambient palette vars live on the Music page only - never :root.
            const root = this._els.page;
            if (root) {
                root.style.setProperty('--np-c1', c1);
                root.style.setProperty('--np-c2', c2);
                root.style.setProperty('--np-c3', c3);
            }
            if (this.visualizer) this.visualizer.setColors(c1, c2, c3);
        }

        // ---- Lyrics (14) ----

        _toggleLyrics() {
            const panel = this._els.npLyricsPanel;
            if (!panel) return;
            const show = panel.style.display !== 'block';
            panel.style.display = show ? 'block' : 'none';
            if (this._els.npLyrics) this._els.npLyrics.classList.toggle('on', show);
            if (show) {
                const body = this._els.npLyricsBody;
                if (body) {
                    body.innerHTML = '';
                    body.appendChild(el('div', 'music-lyrics-empty', '🎶'));
                    body.appendChild(el('div', 'music-lyrics-empty-title', 'Lyrics aren’t available for this song.'));
                    body.appendChild(el('div', 'music-lyrics-empty-text', 'Lyrics open when a provider supplies them — nothing is scraped or bypassed.'));
                }
            }
        }

        // ---- Sleep timer (15) ----

        _setSleepTimer(mode) {
            this._cancelSleepTimer(true);
            if (mode === 'end') {
                this._sleep = { mode: 'end', endsAt: 0, endSong: true, timer: null };
            } else if (typeof mode === 'number' && mode > 0) {
                this._sleep = {
                    mode: 'mins',
                    endsAt: Date.now() + mode * 60000,
                    endSong: false,
                    timer: setInterval(() => this._tickSleep(), 1000)
                };
            }
            this._renderSleepBadge();
        }

        _cancelSleepTimer(silent) {
            if (this._sleep.timer) clearInterval(this._sleep.timer);
            this._sleep = { mode: 'off', endsAt: 0, endSong: false, timer: null };
            if (!silent) this._renderSleepBadge();
        }

        _tickSleep() {
            const s = this._sleep;
            if (s.mode !== 'mins' || !s.endsAt) { this._cancelSleepTimer(); return; }
            const remain = s.endsAt - Date.now();
            if (remain <= 0) {
                this._cancelSleepTimer();
                this.player.pause();
                this.showToast('Sleep timer — playback paused 😴');
                return;
            }
            this._renderSleepBadge(remain);
        }

        _sleepEndSongIfSet() {
            if (this._sleep.mode === 'end' && this._sleep.endSong) {
                this._cancelSleepTimer();
                this.showToast('Sleep timer — playback ended 😴');
            }
        }

        _sleepLabel() {
            const s = this._sleep;
            if (s.mode === 'end') return 'Sleep timer: end of song 😴';
            if (s.mode === 'mins') return 'Sleep timer: ' + Math.round((s.endsAt - Date.now()) / 60000) + ' min';
            return 'Sleep timer off';
        }

        _renderSleepBadge(remain) {
            const badge = this._els.npSleepBadge;
            if (!badge) return;
            const s = this._sleep;
            if (s.mode === 'off') { badge.style.display = 'none'; return; }
            badge.style.display = '';
            if (s.mode === 'end') badge.textContent = '😴 end of song';
            else {
                const ms = remain != null ? remain : (s.endsAt - Date.now());
                const mins = Math.max(0, Math.floor(ms / 60000));
                const secs = Math.max(0, Math.floor((ms % 60000) / 1000));
                badge.textContent = '😴 ' + mins + ':' + (secs < 10 ? '0' : '') + secs;
            }
        }

        _renderSleepSheet() {
            const rows = this._els.sleepRows;
            const cancel = this._els.sleepCancel;
            const status = this._els.sleepStatus;
            if (rows) rows.forEach((r) => {
                const active = this._sleep.mode !== 'off' &&
                    ((r.dataset.min && Number(r.dataset.min) === Math.round((this._sleep.endsAt - Date.now()) / 60000) && this._sleep.mode === 'mins') ||
                     (r.dataset.end === '1' && this._sleep.mode === 'end'));
                r.classList.toggle('active', !!active);
            });
            if (status) status.textContent = this._sleep.mode === 'off' ? 'Off — music plays until you stop it.' : this._sleepLabel() + ' — cancels automatically.';
            if (cancel) cancel.style.display = this._sleep.mode === 'off' ? 'none' : '';
        }

        // ---- Equalizer (22) ----

        _applyEq(preset) {
            this._eqPreset = preset;
            safeSet('lovehub_music_eq_v1', preset);
            let applied = false;
            if (this.visualizer) applied = this.visualizer.setEqPreset(preset) || preset === 'normal';
            this._els.eqRows.forEach((r) => r.classList.toggle('active', r.dataset.preset === preset));
            if (this._els.eqNote) {
                this._els.eqNote.style.display = applied ? 'none' : '';
                this._els.eqNote.textContent = applied ? '' : 'Real audio processing isn’t available in this browser — presets are stored for when it is.';
            }
            if (applied && preset !== 'normal') this.showToast('Equalizer: ' + (EQ_PRESETS.find((p) => p.key === preset) || {}).label);
        }

        // ---- Queue sheet (8) ----

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
            const now = this._els.queueNow;
            if (!list) return;
            const s = this.player.snapshot();

            if (now) {
                now.innerHTML = '';
                if (s.current) {
                    const head = el('div', 'music-queue-nowhead', 'Playing Now');
                    now.appendChild(head);
                    now.appendChild(this._buildRow(s.current, { playable: true }));
                }
            }

            list.innerHTML = '';
            if (!s.queue.length) {
                list.appendChild(el('p', 'music-state-line', 'Queue is empty.<br>Add songs to build your session playlist.'));
                return;
            }
            const upNext = el('div', 'music-queue-nowhead', 'Up Next' + (s.shuffle ? ' · 🔀' : ''));
            list.appendChild(upNext);
            s.queue.forEach((t, i) => {
                const row = el('div', 'music-queue-row' + (i === s.index ? ' current' : ''));
                row.draggable = true;
                const art = el('div', 'music-result-art');
                if (t.artworkUrl) art.style.backgroundImage = 'url("' + esc(t.artworkUrl) + '")';
                row.appendChild(art);
                const info = el('div', 'music-queue-info');
                info.appendChild(el('div', 'music-queue-title', (i === s.index ? '♪ ' : '') + (t.title || 'Untitled')));
                const meta = el('div', 'music-queue-meta', [t.artist, t.source].filter(Boolean).join(' · ') || '');
                if (t.duration) meta.textContent += ' · ' + fmtTime(t.duration);
                info.appendChild(meta);
                row.appendChild(info);

                const up = el('button', 'music-queue-ctl', '↑');
                up.title = 'Move up';
                up.setAttribute('aria-label', 'Move up');
                up.addEventListener('click', (e) => { e.stopPropagation(); this.player.moveInQueue(i, i - 1); });
                const down = el('button', 'music-queue-ctl', '↓');
                down.title = 'Move down';
                down.setAttribute('aria-label', 'Move down');
                down.addEventListener('click', (e) => { e.stopPropagation(); this.player.moveInQueue(i, i + 1); });
                const remove = el('button', 'music-queue-ctl danger', '✕');
                remove.title = 'Remove';
                remove.setAttribute('aria-label', 'Remove from queue');
                remove.addEventListener('click', (e) => { e.stopPropagation(); this.player.removeFromQueue(i); });

                row.addEventListener('click', (e) => {
                    if (e.target.closest('button')) return;
                    this.player.playIndex(i);
                });
                row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); row.classList.add('dragging'); });
                row.addEventListener('dragend', () => row.classList.remove('dragging'));
                row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop-target'); });
                row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
                row.addEventListener('drop', (e) => {
                    e.preventDefault();
                    row.classList.remove('drop-target');
                    const from = Number(e.dataTransfer.getData('text/plain'));
                    if (isFinite(from) && from !== i) this.player.moveInQueue(from, i);
                });

                const btns = el('div', 'music-queue-btns');
                btns.appendChild(up); btns.appendChild(down); btns.appendChild(remove);
                row.appendChild(btns);
                list.appendChild(row);
            });
            if (this._els.queueShuffle) {
                this._els.queueShuffle.classList.toggle('on', !!s.shuffle);
                this._els.queueShuffle.setAttribute('aria-pressed', String(!!s.shuffle));
            }
        }

        // -------------------------------------------------------------------
        // Mini player (6)
        // -------------------------------------------------------------------

        _updateMiniPlayer() {
            const mini = this._els.mini;
            if (!mini) return;
            const s = this.player.snapshot();
            const page = (window.app && window.app.currentPage) || 'home';
            const show = !!s.current && page !== 'music' && !this._npOpen;
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
                } else artEl.style.backgroundImage = '';
                artEl.classList.toggle('playing', !!s.playing);
            }
            if (this._els.miniPlay) this._els.miniPlay.innerHTML = icon(s.playing ? 'pause' : 'play');
            if (this._els.miniFav) {
                const on = this._isFavorited(s.current);
                this._els.miniFav.classList.toggle('on', on);
                this._els.miniFav.innerHTML = icon(on ? 'heartFill' : 'heart', 13);
            }
            const fill = this._els.miniFill;
            if (fill) {
                const pct = s.duration > 0 ? Math.min(100, (s.time / s.duration) * 100) : 0;
                fill.style.width = pct + '%';
            }
        }

        // -------------------------------------------------------------------
        // Favorites + sharing (5.6 / 5.9 / 12 / 13)
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
                this._renderHero();
                this._renderNowPlaying();
                return 'added';
            }
            return 'error';
        }

        async toggleFavorite(track) {
            const res = await this._ensureFavorite(track);
            if (res === 'added') {
                this.showToast('Saved to your shared songs ❤️');
                this._renderHero();
                this._renderNowPlaying();
                this._updateMiniPlayer();
            } else if (res === 'exists') {
                const existing = this.favorites.find((f) =>
                    (f.playable_url === track.playableUrl) ||
                    (f.metadata && f.metadata.dedupeKey && f.metadata.dedupeKey === track.dedupeKey)
                );
                if (existing) {
                    const r = await window.LoveHubMusic.removeFavorite(this.coupleId, existing.id);
                    if (r.success) {
                        this.favorites = this.favorites.filter((f) => f.id !== existing.id);
                        this._renderFavorites();
                        this._renderHero();
                        this._renderNowPlaying();
                        this._updateMiniPlayer();
                        this.showToast('Removed from shared songs');
                    }
                }
            } else if (res === 'noauth') this.showToast('Please login to save songs');
            else this.showToast('Could not save — try again');
        }

        async _shareCurrent() {
            const t = this.player.current;
            if (!t) return;
            const res = await this._ensureFavorite(t);
            this.showToast(res === 'added' ? 'Shared with your partner ❤️' : res === 'exists' ? 'Already in your shared songs' : res === 'noauth' ? 'Please login to share' : 'Could not share — try again');
        }

        async _shareTrack(track) {
            const res = await this._ensureFavorite(track);
            this.showToast(res === 'added' ? 'Shared with your partner ❤️' : res === 'exists' ? 'Already in your shared songs' : res === 'noauth' ? 'Please login to share' : 'Could not share — try again');
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
                                body: partnerName + ' added “' + (row.title || 'a song') + '” to Our Music'
                            });
                        }
                        this.showToast(partnerName + ' added “' + (row.title || 'a song') + '” to Our Music ❤️');
                    }
                },
                onDelete: () => this.refreshFavorites()
            });
        }

        // -------------------------------------------------------------------
        // Media Session API (mobile lockscreen) — additive, best-effort
        // -------------------------------------------------------------------

        _updateMediaSession(track) {
            if (!('mediaSession' in navigator) || !track) return;
            try {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: track.title || '',
                    artist: track.artist || 'LoveHub',
                    album: 'LoveHub Music',
                    artwork: track.artworkUrl ? [{ src: track.artworkUrl, sizes: '512x512', type: 'image/jpeg' }] : []
                });
                const p = this.player;
                navigator.mediaSession.setActionHandler('play', () => p.play());
                navigator.mediaSession.setActionHandler('pause', () => p.pause());
                navigator.mediaSession.setActionHandler('previoustrack', () => p.previous());
                navigator.mediaSession.setActionHandler('nexttrack', () => p.next());
                navigator.mediaSession.setActionHandler('seekbackward', (d) => p.seek((p.snapshot().time || 0) - 10));
                navigator.mediaSession.setActionHandler('seekforward', (d) => p.seek((p.snapshot().time || 0) + 10));
            } catch (e) { /* ignore */ }
        }

        _clearMediaSession() {
            if (!('mediaSession' in navigator)) return;
            try {
                navigator.mediaSession.metadata = null;
                ['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward'].forEach((h) => {
                    try { navigator.mediaSession.setActionHandler(h, null); } catch (e) { /* ignore */ }
                });
            } catch (e) { /* ignore */ }
        }

        // -------------------------------------------------------------------
        // Sheets + misc
        // -------------------------------------------------------------------

        _openSheet(sheet) {
            if (sheet) sheet.classList.add('active');
        }
        _hideSheet(sheet) {
            if (sheet) sheet.classList.remove('active');
        }

        showToast(message) {
            const app = window.app;
            if (app && app.showToast) app.showToast(message);
            else if (window.console) console.info('[MusicRoom]', message);
        }
    }

    window.LoveHubMusicRoomUtils = {
        pushRecent,
        upsertContinue,
        samplePalette,
        fmtTime,
        fmtRemaining,
        MOODS,
        VIS_MODES,
        EQ_PRESETS
    };

    // Guarded: in the DOM-free test harness there is no document — the pure
    // utilities above still load and can be tested.
    if (typeof document !== 'undefined') {
        window.LoveHubMusicRoom = new MusicRoom();
    }
})();
