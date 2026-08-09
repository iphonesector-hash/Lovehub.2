// ===========================================================================
// music-player.js — the single LoveHub playback engine (MusicPlayerService).
//
// Wraps the browser's native <audio> element (no downloading, no permanent
// copies — the stream is played from the source URL). Responsibilities:
//   play / pause / toggle / seek / setVolume / loadTrack / next / previous,
//   queue management (add, remove, reorder, clear), shuffle, repeat modes,
//   sleep-timer-friendly 'end' event, current-track state and playback events
//   (state / track / progress / error).
//
// Handles autoplay restrictions (keeps the track loaded, surfaces a paused
// state), unsupported MIME types (MediaError surfaced as a retryable error),
// network failures (one silent retry, then a user-facing retryable error),
// and unavailable/expired streams. Never loops retries.
//
// Events: 'state' (full snapshot), 'track' (a new track loaded),
//         'progress' (timeupdate snapshot), 'error' ({message, code, retryable}),
//         'end' (a track finished and playback stopped / wrapped).
//
// Phase 5 Premium additions (all additive, nothing removed):
//   * shuffle mode   — a shuffled play-order that keeps the current track in
//                      place and re-shuffles the rest (deterministic when a
//                      custom rng is supplied — used by tests).
//   * repeat modes   — 'off' | 'all' | 'one' (cycleRepeat() walks the cycle).
//   * 'end' event    — fired when the current track reaches the end.
//   * getAudioElement() — exposes the one <audio> so the visualizer can
//                      attach a single MediaElementSource (never duplicated).
//   * crossOrigin    — 'anonymous' on the element so archive.org streams can
//                      feed the analyser (the source serves CORS headers).
//   * fixed the previously-dead silent retry (was testing `a.current`, which
//     never exists on HTMLAudioElement; now uses currentSrc || src).
// ===========================================================================

(function () {
    'use strict';

    class Emitter {
        constructor() { this._listeners = {}; }
        on(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); return this; }
        off(ev, fn) {
            const l = this._listeners[ev];
            if (l) { const i = l.indexOf(fn); if (i > -1) l.splice(i, 1); }
            return this;
        }
        emit(ev, payload) {
            (this._listeners[ev] || []).slice().forEach((fn) => {
                try { fn(payload); } catch (e) { console.error('[MusicPlayer] listener error:', e); }
            });
            return this;
        }
    }

    // Fisher–Yates over [0..n); deterministic when rng() is supplied.
    function shuffledIndices(n, rng) {
        const arr = [];
        for (let i = 0; i < n; i++) arr.push(i);
        const rand = typeof rng === 'function' ? rng : Math.random;
        for (let i = n - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
        }
        return arr;
    }

    class MusicPlayerService extends Emitter {
        constructor() {
            super();
            this.queue = [];
            this.index = -1;
            this.current = null;
            this.playing = false;
            this.loading = false;
            this.error = null;
            this.volume = 0.8;
            this.shuffle = false;
            this.repeat = 'off'; // 'off' | 'all' | 'one'
            this._order = [];    // play-order of queue indices
            this._retried = 0;
            this._audio = null;
            this._bound = {};
            // YouTube embed mode (Phase 12): tracks with playbackMode
            // 'youtube-embed' play through YouTube's official IFrame player —
            // never ripped, proxied or downloaded.
            this._mode = 'audio';      // 'audio' | 'youtube'
            this._yt = null;           // YT.Player instance
            this._ytHost = null;       // hidden host <div>
            this._ytTime = 0;
            this._ytDuration = 0;
            this._ytTimer = null;
            this._ytApiPromise = null;
            this._createAudio();
        }

        // ---- audio lifecycle ----

        _createAudio() {
            if (this._audio) this._teardownAudio();
            const a = new Audio();
            a.preload = 'auto';
            a.volume = this.volume;
            // crossOrigin lets the visualizer read real frequency data from
            // CORS-open sources (archive.org) via a MediaElementSource.
            a.crossOrigin = 'anonymous';
            const b = this._bound;
            b.timeupdate = () => this.emit('progress', this.snapshot());
            b.ended = () => this._onEnded();
            b.onplay = () => { this.loading = false; this.playing = true; this.emit('state', this.snapshot()); };
            b.onpause = () => { this.loading = false; this.playing = false; this.emit('state', this.snapshot()); };
            b.oncanplay = () => { this.loading = false; this.emit('state', this.snapshot()); };
            b.onwaiting = () => { this.loading = true; this.emit('state', this.snapshot()); };
            b.onerror = () => this._onPlaybackError();
            b.onseeking = () => { this.loading = true; this.emit('state', this.snapshot()); };
            b.onseeked = () => { this.loading = false; this.emit('state', this.snapshot()); };
            // Handlers are stored under their DOM-ish names (b.onplay, b.onerror,
            // ...) while timeupdate/ended live directly on b. Resolve the actual
            // handler so listeners are really registered (previously b['play'] /
            // b['error'] etc. were undefined, silently breaking error fallback
            // and canplay/loading state in the browser).
            ['timeupdate', 'ended', 'play', 'pause', 'canplay', 'waiting', 'error', 'seeking', 'seeked'].forEach((ev) => {
                const fn = b[ev] || b['on' + ev];
                if (fn) a.addEventListener(ev, fn);
            });
            this._audio = a;
        }

        _teardownAudio() {
            const a = this._audio;
            if (!a) return;
            try { a.pause(); a.removeAttribute('src'); a.load(); } catch (e) { /* ignore */ }
            ['timeupdate', 'ended', 'play', 'pause', 'canplay', 'waiting', 'error', 'seeking', 'seeked'].forEach((ev) => {
                const fn = this._bound[ev] || this._bound['on' + ev];
                if (fn) a.removeEventListener(ev, fn);
            });
            this._bound = {};
            this._audio = null;
        }

        getAudioElement() {
            return this._audio;
        }

        // ---- YouTube embed mode (Phase 12) --------------------------------
        // Tracks with playbackMode 'youtube-embed' play through YouTube's
        // OFFICIAL IFrame player (youtube.com/iframe_api). Nothing is ripped,
        // proxied or downloaded; the iframe stays hidden (audio-like). Falls
        // back to a graceful error if the IFrame API cannot load.

        _isYoutubeTrack(t) {
            if (!t) return false;
            const mode = t.playbackMode
                || (t.metadata && t.metadata.youtube && t.metadata.youtube.playbackMode) || '';
            return mode === 'youtube-embed'
                && !!(t.metadata && t.metadata.youtube && t.metadata.youtube.videoId);
        }

        _youtubeVideoId(t) {
            return (t.metadata && t.metadata.youtube && t.metadata.youtube.videoId) || null;
        }

        _currentTime() {
            if (this._mode === 'youtube') return this._ytTime || 0;
            const a = this._audio;
            return (a && isFinite(a.currentTime)) ? a.currentTime : 0;
        }

        _safeYtCall(fn) {
            if (this._yt && typeof fn === 'function') {
                try { fn(); } catch (e) { /* YT not ready — ignore */ }
            }
        }

        _ensureYtApi() {
            if (this._ytApiPromise) return this._ytApiPromise;
            this._ytApiPromise = new Promise((resolve, reject) => {
                if (typeof window === 'undefined' || typeof document === 'undefined' || !document.createElement) {
                    reject(new Error('youtube-api-unavailable'));
                    return;
                }
                if (window.YT && window.YT.Player) { resolve(); return; }
                const prev = window.onYouTubeIframeAPIReady;
                window.onYouTubeIframeAPIReady = () => {
                    if (typeof prev === 'function') { try { prev(); } catch (e) { /* ignore */ } }
                    resolve();
                };
                const s = document.createElement('script');
                s.src = 'https://www.youtube.com/iframe_api';
                s.async = true;
                s.onerror = () => reject(new Error('youtube-api-load-failed'));
                (document.head || document.documentElement).appendChild(s);
            });
            return this._ytApiPromise;
        }

        async _loadYoutube(track, { autoplay = true, fromUser = false } = {}) {
            this._teardownYoutube();
            this._mode = 'youtube';
            this.current = track;
            this.error = null;
            this._retried = 0;
            this.playing = false;
            this.loading = true;
            this.emit('state', this.snapshot());
            const videoId = this._youtubeVideoId(track);
            try {
                await this._ensureYtApi();
            } catch (e) {
                if (this.current !== track) return false;
                this._mode = 'audio';
                this.loading = false;
                this.error = 'YouTube player unavailable';
                this.emit('error', { message: 'YouTube playback could not start', code: (e && e.name) || 'yt', retryable: true });
                this.emit('state', this.snapshot());
                return false;
            }
            if (this.current !== track) return false; // superseded by another load
            if (!window.YT || !window.YT.Player) {
                this._mode = 'audio';
                this.loading = false;
                this.error = 'YouTube player unavailable';
                this.emit('state', this.snapshot());
                return false;
            }
            try {
                if (!this._ytHost) {
                    const host = document.createElement('div');
                    host.id = 'lovehub-yt-host';
                    host.setAttribute('aria-hidden', 'true');
                    host.style.cssText = 'position:fixed;left:-9999px;top:0;width:480px;height:270px;opacity:0;pointer-events:none;overflow:hidden;';
                    document.body.appendChild(host);
                    this._ytHost = host;
                }
                this._yt = new window.YT.Player(this._ytHost, {
                    width: '480',
                    height: '270',
                    videoId,
                    playerVars: { autoplay: autoplay ? 1 : 0, playsinline: 1, rel: 0, modestbranding: 1 },
                    events: {
                        onReady: () => {
                            this.loading = false;
                            if (autoplay) this._safeYtCall(() => this._yt.playVideo());
                            this.emit('state', this.snapshot());
                        },
                        onStateChange: (e) => this._ytOnState(e && e.data),
                        onError: () => this._onYtError()
                    }
                });
            } catch (e) {
                this._mode = 'audio';
                this.loading = false;
                this.error = 'YouTube playback failed';
                this.emit('error', { message: 'YouTube playback could not start', code: (e && e.name) || 'yt', retryable: true });
                this.emit('state', this.snapshot());
                return false;
            }
            this.emit('track', this.snapshot());
            this.emit('state', this.snapshot());
            return true;
        }

        _ytOnState(state) {
            if (state === 1) { // playing
                this.playing = true;
                this.loading = false;
                this._startYtTimer();
            } else if (state === 2) { // paused
                this.playing = false;
                this.loading = false;
                this._stopYtTimer();
            } else if (state === 3) { // buffering
                this.loading = true;
            } else if (state === 0) { // ended
                this._stopYtTimer();
                this.playing = false;
                this._onEnded();
            }
            this.emit('state', this.snapshot());
        }

        _onYtError() {
            this._stopYtTimer();
            this.playing = false;
            this.loading = false;
            this.error = 'YouTube playback failed';
            this.emit('error', { message: 'YouTube playback failed', code: 'yt', retryable: true });
            this.emit('state', this.snapshot());
        }

        _startYtTimer() {
            this._stopYtTimer();
            const tick = () => {
                if (!this._yt || this._mode !== 'youtube') return;
                try {
                    const t = this._yt.getCurrentTime ? this._yt.getCurrentTime() : 0;
                    if (isFinite(t)) this._ytTime = t;
                    const d = this._yt.getDuration ? this._yt.getDuration() : 0;
                    if (isFinite(d) && d > 0) this._ytDuration = d;
                    this.emit('progress', this.snapshot());
                } catch (e) { /* ignore */ }
            };
            if (typeof setInterval === 'function') this._ytTimer = setInterval(tick, 500);
        }

        _stopYtTimer() {
            if (this._ytTimer) { clearInterval(this._ytTimer); this._ytTimer = null; }
        }

        _teardownYoutube() {
            this._stopYtTimer();
            if (this._yt && typeof this._yt.destroy === 'function') {
                try { this._yt.destroy(); } catch (e) { /* ignore */ }
            }
            this._yt = null;
            this._ytTime = 0;
            this._ytDuration = 0;
            if (this._ytHost && this._ytHost.parentNode) {
                try { this._ytHost.parentNode.removeChild(this._ytHost); } catch (e) { /* ignore */ }
            }
            this._ytHost = null;
            this._mode = 'audio';
        }

        // ---- state ----

        snapshot() {
            const a = this._audio;
            return {
                current: this.current,
                queue: this.queue.slice(),
                index: this.index,
                playing: !!(this.playing && this.current),
                loading: this.loading,
                error: this.error,
                shuffle: this.shuffle,
                repeat: this.repeat,
                duration: this._mode === 'youtube'
                    ? (this._ytDuration || (this.current && this.current.duration) || 0)
                    : ((a && isFinite(a.duration) && a.duration > 0) ? a.duration : (this.current && this.current.duration) || 0),
                time: this._mode === 'youtube' ? (this._ytTime || 0) : ((a && isFinite(a.currentTime)) ? a.currentTime : 0),
                volume: this.volume
            };
        }

        // ---- loading / transport ----

        async loadTrack(track, { autoplay = true, fromUser = false } = {}) {
            if (!track) {
                this.error = 'This result has no playable stream';
                this.emit('state', this.snapshot());
                return false;
            }
            // YouTube embed tracks play through the official IFrame player.
            if (this._isYoutubeTrack(track)) {
                return this._loadYoutube(track, { autoplay, fromUser });
            }
            if (!track.playableUrl) {
                this.error = 'This result has no playable stream';
                this.emit('state', this.snapshot());
                return false;
            }
            this.current = track;
            this.error = null;
            this._retried = 0;
            const a = this._audio;
            try {
                a.src = track.playableUrl;
                a.load();
            } catch (e) {
                this.error = 'Could not load stream';
                this.emit('state', this.snapshot());
                return false;
            }
            if (autoplay) {
                try {
                    await a.play();
                    this.playing = true;
                } catch (e) {
                    // Autoplay policy: keep the track ready, surface a paused
                    // state so a user gesture can start playback.
                    this.playing = false;
                    this.error = null;
                    if (fromUser && e && e.name === 'NotSupportedError') {
                        this.error = 'This browser cannot play this stream';
                    }
                }
            } else {
                this.playing = false;
            }
            this.emit('track', this.snapshot());
            this.emit('state', this.snapshot());
            return true;
        }

        async play() {
            if (!this.current) return;
            if (this._mode === 'youtube') {
                this.error = null;
                try {
                    this._safeYtCall(() => this._yt.playVideo());
                    this.playing = true;
                } catch (e) {
                    this.playing = false;
                    this.error = 'Playback failed';
                    this.emit('error', { message: 'Playback failed — retry?', code: (e && e.name) || 'play', retryable: true });
                }
                this.emit('state', this.snapshot());
                return;
            }
            const a = this._audio;
            if (!a || !this.current) return;
            this.error = null;
            try {
                await a.play();
                this.playing = true;
            } catch (e) {
                this.playing = false;
                this.error = 'Playback failed';
                this.emit('error', { message: 'Playback failed — retry?', code: (e && e.name) || 'play', retryable: true });
            }
            this.emit('state', this.snapshot());
        }

        pause() {
            if (this._mode === 'youtube') {
                this._safeYtCall(() => this._yt.pauseVideo());
                this._stopYtTimer();
                this.playing = false;
                this.emit('state', this.snapshot());
                return;
            }
            if (this._audio) this._audio.pause();
            this.playing = false;
            this.emit('state', this.snapshot());
        }

        async toggle() {
            if (this.playing) this.pause();
            else await this.play();
        }

        seek(seconds) {
            if (!isFinite(seconds)) return;
            if (this._mode === 'youtube') {
                this._safeYtCall(() => this._yt.seekTo(Math.max(0, seconds), true));
                return;
            }
            const a = this._audio;
            if (!a) return;
            try { a.currentTime = Math.max(0, seconds); } catch (e) { /* ignore */ }
        }

        setVolume(v) {
            this.volume = Math.max(0, Math.min(1, Number(v) || 0));
            if (this._audio) this._audio.volume = this.volume;
            this.emit('state', this.snapshot());
        }

        // ---- shuffle / repeat (Phase 5 Premium, additive) ----

        setShuffle(on, rng) {
            this.shuffle = !!on;
            if (this.shuffle) this._rebuildOrder(rng);
            else this._order = this.queue.map((_, i) => i);
            this.emit('state', this.snapshot());
        }

        toggleShuffle() {
            this.setShuffle(!this.shuffle);
            return this.shuffle;
        }

        setRepeat(mode) {
            this.repeat = ['off', 'all', 'one'].indexOf(mode) > -1 ? mode : 'off';
            this.emit('state', this.snapshot());
        }

        // off → all → one → off
        cycleRepeat() {
            const cycle = { off: 'all', all: 'one', one: 'off' };
            this.setRepeat(cycle[this.repeat] || 'off');
            return this.repeat;
        }

        // Play-order management. With shuffle OFF the order is identity.
        // With shuffle ON we keep the current/anchored track first and
        // shuffle the rest — so "next" never re-plays the current song.
        _rebuildOrder(rng) {
            const n = this.queue.length;
            if (!this.shuffle || n < 2) {
                this._order = this.queue.map((_, i) => i);
                return;
            }
            const anchor = this.index > -1 && this.index < n ? this.index : (n ? 0 : -1);
            const rest = [];
            for (let i = 0; i < n; i++) if (i !== anchor) rest.push(i);
            const perm = shuffledIndices(rest.length, rng);
            this._order = [anchor].concat(perm.map((k) => rest[k]));
        }

        _orderPos(idx) {
            const pos = this._order.indexOf(idx);
            return pos > -1 ? pos : this._order.length - 1; // unknown → treat as last
        }

        // ---- queue ----

        setQueue(tracks, startIndex) {
            this.queue = (tracks || []).filter((t) => t && (t.playableUrl || this._isYoutubeTrack(t)));
            this.index = Math.max(0, startIndex || 0);
            if (this.queue.length && this.index >= this.queue.length) this.index = 0;
            this._rebuildOrder();
            this.emit('state', this.snapshot());
        }

        addToQueue(track) {
            if (!track || !(track.playableUrl || this._isYoutubeTrack(track))) return false;
            this.queue.push(track);
            this._rebuildOrder();
            this.emit('state', this.snapshot());
            return true;
        }

        removeFromQueue(idx) {
            if (idx < 0 || idx >= this.queue.length) return;
            this.queue.splice(idx, 1);
            if (this.index === idx) this.index = -1;
            else if (this.index > idx) this.index -= 1;
            this._rebuildOrder();
            this.emit('state', this.snapshot());
        }

        moveInQueue(from, to) {
            if (from === to || from < 0 || from >= this.queue.length || to < 0 || to >= this.queue.length) return;
            const [item] = this.queue.splice(from, 1);
            this.queue.splice(to, 0, item);
            if (this.index === from) this.index = to;
            else if (this.index > from && this.index <= to) this.index -= 1;
            else if (this.index < from && this.index >= to) this.index += 1;
            this._rebuildOrder();
            this.emit('state', this.snapshot());
        }

        clearQueue() {
            this.queue = [];
            this.index = -1;
            this._order = [];
            this.emit('state', this.snapshot());
        }

        async playIndex(idx) {
            if (idx < 0 || idx >= this.queue.length) return;
            this.index = idx;
            this._rebuildOrder();
            await this.loadTrack(this.queue[idx], { autoplay: true, fromUser: true });
        }

        async next() {
            if (!this.queue.length) return;
            const pos = this._orderPos(this.index);
            const n = pos + 1;
            if (n < this._order.length) {
                await this.playIndex(this._order[n]);
                return;
            }
            // Reached the end of the play order.
            if (this.repeat === 'all') {
                await this.playIndex(this._order[0]);
                return;
            }
            this.pause();
            this.seek(0);
        }

        async previous() {
            if (!this.queue.length) return;
            if (this._currentTime() > 3) { this.seek(0); return; }
            const pos = this._orderPos(this.index);
            const n = pos - 1;
            if (n >= 0) {
                await this.playIndex(this._order[n]);
                return;
            }
            if (this.repeat === 'all') {
                await this.playIndex(this._order[this._order.length - 1]);
                return;
            }
            this.pause();
            this.seek(0);
        }

        retry() {
            if (!this.current) return;
            return this.loadTrack(this.current, { autoplay: true, fromUser: true });
        }

        // ---- internal handlers ----

        _onEnded() {
            if (this.repeat === 'one' && this.current) {
                // Replay the same track from the top (Repeat One).
                try { this.seek(0); this.play(); } catch (e) { /* ignore */ }
                this.emit('end', this.snapshot());
                return;
            }
            const pos = this._orderPos(this.index);
            const n = pos + 1;
            if (n < this._order.length) {
                this.playIndex(this._order[n]);
            } else if (this.repeat === 'all') {
                this.playIndex(this._order[0]);
            } else {
                this.playing = false;
                this.emit('end', this.snapshot());
                this.emit('state', this.snapshot());
            }
        }

        _onPlaybackError() {
            const a = this._audio;
            const code = (a && a.error && a.error.code) || null;
            // One silent retry for transient network blips; a second failure
            // becomes a user-facing retryable error (never an infinite loop).
            if (this._retried < 1 && a && this.current) {
                this._retried += 1;
                const src = a.currentSrc || a.src;
                try {
                    a.load();
                    if (src) { a.src = src; a.play().catch(() => {}); }
                } catch (e) { /* fall through to error state */ }
                return;
            }
            this.playing = false;
            this.loading = false;
            this.error = 'Stream unavailable';
            this.emit('error', { message: 'Playback failed — the stream may be unavailable', code, retryable: true });
            this.emit('state', this.snapshot());
        }

        destroy() {
            this._teardownYoutube();
            this._teardownAudio();
            this.queue = [];
            this.index = -1;
            this._order = [];
            this.current = null;
            this.playing = false;
        }
    }

    // Exposed for tests / advanced consumers.
    MusicPlayerService._shuffledIndices = shuffledIndices;

    window.MusicPlayerService = MusicPlayerService;
    window.LoveHubMusicPlayer = new MusicPlayerService();
})();
