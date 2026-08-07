// ===========================================================================
// music-player.js — Phase 5.4: reusable MusicPlayerService engine.
//
// Wraps the browser's native <audio> element (no downloading, no permanent
// copies — the stream is played from the source URL). Responsibilities:
//   play / pause / toggle / seek / setVolume / loadTrack / next / previous,
//   queue management (add, remove, reorder, clear), current-track state and
//   playback events (state / track / progress / error).
//
// Handles autoplay restrictions (keeps the track loaded, surfaces a paused
// state), unsupported MIME types (MediaError surfaced as a retryable error),
// network failures (one silent retry, then a user-facing retryable error),
// and unavailable/expired streams. Never loops retries.
//
// Events: 'state' (full snapshot), 'track' (a new track loaded),
//         'progress' (timeupdate snapshot), 'error' ({message, code, retryable}).
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
            this._retried = 0;
            this._audio = null;
            this._bound = {};
            this._createAudio();
        }

        // ---- audio lifecycle ----

        _createAudio() {
            if (this._audio) this._teardownAudio();
            const a = new Audio();
            a.preload = 'auto';
            a.volume = this.volume;
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
            ['timeupdate', 'ended', 'play', 'pause', 'canplay', 'waiting', 'error', 'seeking', 'seeked'].forEach((ev) => {
                a.addEventListener(ev, b[ev]);
            });
            this._audio = a;
        }

        _teardownAudio() {
            const a = this._audio;
            if (!a) return;
            try { a.pause(); a.removeAttribute('src'); a.load(); } catch (e) { /* ignore */ }
            ['timeupdate', 'ended', 'play', 'pause', 'canplay', 'waiting', 'error', 'seeking', 'seeked'].forEach((ev) => {
                a.removeEventListener(ev, this._bound[ev]);
            });
            this._bound = {};
            this._audio = null;
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
                duration: (a && isFinite(a.duration) && a.duration > 0) ? a.duration : (this.current && this.current.duration) || 0,
                time: (a && isFinite(a.currentTime)) ? a.currentTime : 0,
                volume: this.volume
            };
        }

        // ---- loading / transport ----

        async loadTrack(track, { autoplay = true, fromUser = false } = {}) {
            if (!track || !track.playableUrl) {
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
            if (this._audio) this._audio.pause();
            this.playing = false;
            this.emit('state', this.snapshot());
        }

        async toggle() {
            if (this.playing) this.pause();
            else await this.play();
        }

        seek(seconds) {
            const a = this._audio;
            if (!a || !isFinite(seconds)) return;
            try { a.currentTime = Math.max(0, seconds); } catch (e) { /* ignore */ }
        }

        setVolume(v) {
            this.volume = Math.max(0, Math.min(1, Number(v) || 0));
            if (this._audio) this._audio.volume = this.volume;
            this.emit('state', this.snapshot());
        }

        // ---- queue ----

        setQueue(tracks, startIndex) {
            this.queue = (tracks || []).filter((t) => t && t.playableUrl);
            this.index = Math.max(0, startIndex || 0);
            if (this.queue.length && this.index >= this.queue.length) this.index = 0;
            this.emit('state', this.snapshot());
        }

        addToQueue(track) {
            if (!track || !track.playableUrl) return false;
            this.queue.push(track);
            this.emit('state', this.snapshot());
            return true;
        }

        removeFromQueue(idx) {
            if (idx < 0 || idx >= this.queue.length) return;
            this.queue.splice(idx, 1);
            if (this.index === idx) this.index = -1;
            else if (this.index > idx) this.index -= 1;
            this.emit('state', this.snapshot());
        }

        moveInQueue(from, to) {
            if (from === to || from < 0 || from >= this.queue.length || to < 0 || to >= this.queue.length) return;
            const [item] = this.queue.splice(from, 1);
            this.queue.splice(to, 0, item);
            if (this.index === from) this.index = to;
            else if (this.index > from && this.index <= to) this.index -= 1;
            else if (this.index < from && this.index >= to) this.index += 1;
            this.emit('state', this.snapshot());
        }

        clearQueue() {
            this.queue = [];
            this.index = -1;
            this.emit('state', this.snapshot());
        }

        async playIndex(idx) {
            if (idx < 0 || idx >= this.queue.length) return;
            this.index = idx;
            await this.loadTrack(this.queue[idx], { autoplay: true, fromUser: true });
        }

        async next() {
            if (!this.queue.length) return;
            const n = this.index + 1;
            if (n >= this.queue.length) { this.pause(); this.seek(0); return; }
            await this.playIndex(n);
        }

        async previous() {
            if (!this.queue.length) return;
            const a = this._audio;
            if (a && a.currentTime > 3) { this.seek(0); return; }
            const n = this.index - 1;
            if (n < 0) { this.pause(); this.seek(0); return; }
            await this.playIndex(n);
        }

        retry() {
            if (!this.current) return;
            return this.loadTrack(this.current, { autoplay: true, fromUser: true });
        }

        // ---- internal handlers ----

        _onEnded() {
            const n = this.index + 1;
            if (n < this.queue.length) {
                this.playIndex(n);
            } else {
                this.playing = false;
                this.emit('state', this.snapshot());
            }
        }

        _onPlaybackError() {
            const a = this._audio;
            const code = (a && a.error && a.error.code) || null;
            // One silent retry for transient network blips; a second failure
            // becomes a user-facing retryable error (never an infinite loop).
            if (this._retried < 1 && a && a.current && this.current) {
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
            this._teardownAudio();
            this.queue = [];
            this.index = -1;
            this.current = null;
            this.playing = false;
        }
    }

    window.MusicPlayerService = MusicPlayerService;
    window.LoveHubMusicPlayer = new MusicPlayerService();
})();
