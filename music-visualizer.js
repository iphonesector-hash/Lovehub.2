// ===========================================================================
// music-visualizer.js — lightweight Canvas + Web Audio visualizer.
//
// Design rules (Phase 5 spec):
//   * No external visualization libraries. Just Canvas 2D + the Web Audio
//     AnalyserNode (one lazy AudioContext, one MediaElementSource, one
//     analyser — never duplicated across canvases or tracks).
//   * Real frequency data is used when the stream is CORS-clean; if the
//     browser refuses (tainted media / no Web Audio), it degrades to a
//     lightweight SYNTHETIC animation synchronized to playback state
//     (energy rises while playing, calms down when paused).
//   * Modes: eq (equalizer bars), wave, circular, particles, aurora.
//   * start()/stop() gate the rAF loop; destroy() cancels it, disconnects the
//     graph and closes the context (called on sign-out). The page's
//     visibilitychange also parks the loop automatically.
// ===========================================================================

(function () {
    'use strict';

    const MODES = ['eq', 'wave', 'circular', 'particles', 'aurora'];

    class VisualizerEngine {
        constructor(canvas) {
            this.canvas = canvas || null;
            this.ctx = canvas ? canvas.getContext('2d') : null;
            this.mode = 'eq';
            this.accent = '#FF375F';
            this.secondary = '#BF5AF2';
            this.tertiary = '#5E5CE6';
            this.playing = false;
            this.enabled = false;
            this._raf = 0;
            this._audioCtx = null;
            this._src = null;
            this._analyser = null;
            this._mediaEl = null;
            this._real = false;
            this._energy = 0;
            this._lastT = 0;
            this._freq = null;
            this._particles = [];
            this._bind = {
                vis: () => this._onVisibility(),
                resize: () => this._resize()
            };
        }

        // Retarget the same graph at a different canvas (hero ↔ now playing).
        setCanvas(canvas) {
            this.canvas = canvas;
            this.ctx = canvas ? canvas.getContext('2d') : null;
            this._resize();
        }

        setMode(mode) {
            if (MODES.indexOf(mode) > -1) this.mode = mode;
        }

        setColors(accent, secondary, tertiary) {
            if (accent) this.accent = accent;
            if (secondary) this.secondary = secondary;
            if (tertiary) this.tertiary = tertiary;
        }

        // Attach the engine to the player's <audio> element. Creates the
        // context + analyser exactly once; reattaching the same element is a
        // no-op (so we never stack analysers).
        attach(audioEl) {
            if (!audioEl) { this._real = false; return; }
            if (this._src && this._mediaEl === audioEl) return; // already attached to this element
            this._mediaEl = audioEl;
            // Re-attaching a DIFFERENT element (player recreated after
            // sign-out/in): tear down the old graph before wiring the new one,
            // so we never stack analysers on dead elements.
            this._disconnectEq();
            if (this._src) { try { this._src.disconnect(); } catch (e) { /* ignore */ } }
            if (this._analyser) { try { this._analyser.disconnect(); } catch (e) { /* ignore */ } }
            try {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) throw new Error('no Web Audio');
                const ctx = this._audioCtx || new AC();
                this._audioCtx = ctx;
                if (ctx.state === 'suspended' && this.playing) ctx.resume().catch(() => {});
                const src = ctx.createMediaElementSource(audioEl);
                const analyser = ctx.createAnalyser();
                analyser.fftSize = 128;
                analyser.smoothingTimeConstant = 0.72;
                src.connect(analyser);
                analyser.connect(ctx.destination);
                this._src = src;
                this._analyser = analyser;
                this._freq = new Uint8Array(analyser.frequencyBinCount);
                this._real = true;
            } catch (e) {
                // Tainted/cross-origin media, missing API, or an already-wired
                // source — fall back to the synthetic animation.
                this._real = false;
            }
        }

        // Apply a real EQ preset via BiquadFilter nodes inserted into the
        // graph (source → filters → analyser → destination). Returns true when
        // real processing is available; false otherwise (UI-only mode, never
        // faked). 'normal' bypasses the chain.
        setEqPreset(name) {
            if (!this._audioCtx || !this._src || !this._analyser) return false;
            try {
                const ctx = this._audioCtx;
                this._disconnectEq();
                this._eqFilters = [];
                const specs = VisualizerEngine.EQ_PRESETS[name];
                if (specs && specs.length) {
                    this._src.disconnect(this._analyser);
                    let node = this._src;
                    specs.forEach((s) => {
                        const f = ctx.createBiquadFilter();
                        f.type = s.type;
                        f.frequency.value = s.frequency || 1000;
                        if (s.gain != null) f.gain.value = s.gain;
                        if (s.Q != null) f.Q.value = s.Q;
                        node.connect(f);
                        this._eqFilters.push(f);
                        node = f;
                    });
                    node.connect(this._analyser);
                }
                return true;
            } catch (e) {
                return false;
            }
        }

        _disconnectEq() {
            if (!this._src || !this._analyser) return;
            const filters = this._eqFilters || [];
            filters.forEach((f) => { try { f.disconnect(); } catch (e) { /* ignore */ } });
            this._eqFilters = [];
            try { this._src.connect(this._analyser); } catch (e) { /* ignore */ }
        }

        // ---- lifecycle ----

        setPlaying(on) {
            this.playing = !!on;
            if (this._audioCtx && this._audioCtx.state === 'suspended' && on) {
                try { this._audioCtx.resume().catch(() => {}); } catch (e) { /* ignore */ }
            }
        }

        start() {
            if (this.enabled) return;
            this.enabled = true;
            window.addEventListener('resize', this._bind.resize);
            document.addEventListener('visibilitychange', this._bind.vis);
            this._resize();
            this._lastT = 0;
            this._raf = requestAnimationFrame((t) => this._frame(t));
        }

        stop() {
            this.enabled = false;
            cancelAnimationFrame(this._raf);
            this._raf = 0;
            window.removeEventListener('resize', this._bind.resize);
            document.removeEventListener('visibilitychange', this._bind.vis);
        }

        _onVisibility() {
            if (document.hidden) cancelAnimationFrame(this._raf);
            else if (this.enabled && !this._raf) this._raf = requestAnimationFrame((t) => this._frame(t));
        }

        destroy() {
            this.stop();
            this._disconnectEq();
            if (this._src) { try { this._src.disconnect(); } catch (e) { /* ignore */ } }
            if (this._analyser) { try { this._analyser.disconnect(); } catch (e) { /* ignore */ } }
            if (this._audioCtx) {
                try { this._audioCtx.close(); } catch (e) { /* ignore */ }
            }
            this._audioCtx = null; this._src = null; this._analyser = null;
            this._mediaEl = null; this._real = false; this._particles = [];
        }

        _resize() {
            const c = this.canvas;
            if (!c || !this.ctx) return;
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const w = c.clientWidth || c.parentElement.clientWidth || 320;
            const h = c.clientHeight || c.parentElement.clientHeight || 120;
            c.width = Math.round(w * dpr);
            c.height = Math.round(h * dpr);
            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        // ---- per-frame ----

        _readEnergy(t) {
            let target = 0;
            if (this._real && this._analyser && this.playing) {
                try {
                    this._analyser.getByteFrequencyData(this._freq);
                    let sum = 0;
                    const len = this._freq.length;
                    for (let i = 0; i < len; i++) sum += this._freq[i] / 255;
                    target = sum / len;
                    this._lastSpectrum = this._freq;
                } catch (e) {
                    // Frequency data became unavailable (taint) — degrade to
                    // synthetic for the rest of the session.
                    this._real = false;
                }
            }
            if (!this._real) {
                // Synthetic: smooth pseudo-random energy, rises while playing,
                // decays when paused — synchronized to the transport state.
                if (this.playing) {
                    target = 0.28 + 0.2 * Math.abs(Math.sin(t / 380)) + 0.08 * Math.sin(t / 137);
                    target = Math.min(1, target);
                } else {
                    target = 0;
                }
            }
            const speed = this.playing ? 0.12 : 0.05;
            this._energy += (target - this._energy) * speed;
            if (this._energy < 0.004) this._energy = 0;
            return this._energy;
        }

        _frame(t) {
            if (!this.enabled) return;
            const energy = this._readEnergy(t);
            if (this.canvas && this.ctx) {
                const w = this.canvas.clientWidth || 320;
                const h = this.canvas.clientHeight || 120;
                const ctx = this.ctx;
                ctx.clearRect(0, 0, w, h);
                try {
                    switch (this.mode) {
                        case 'wave': this._drawWave(ctx, w, h, t, energy); break;
                        case 'circular': this._drawCircular(ctx, w, h, t, energy); break;
                        case 'particles': this._drawParticles(ctx, w, h, t, energy); break;
                        case 'aurora': this._drawAurora(ctx, w, h, t, energy); break;
                        default: this._drawEq(ctx, w, h, energy);
                    }
                } catch (e) { /* a single bad frame must never break playback */ }
            }
            this._raf = requestAnimationFrame((tt) => this._frame(tt));
        }

        _bars(count, energy) {
            // Real data → 24-bin spectrum; synthetic → sin-based bars.
            const bars = [];
            if (this._real && this._lastSpectrum) {
                const spec = this._lastSpectrum;
                const step = Math.max(1, Math.floor(spec.length / count));
                for (let i = 0; i < count; i++) {
                    let v = 0;
                    for (let j = 0; j < step && i * step + j < spec.length; j++) v += spec[i * step + j];
                    bars.push(v / (step * 255));
                }
            } else {
                const t = performance.now() / 1000;
                for (let i = 0; i < count; i++) {
                    const v = 0.16 + 0.5 * Math.abs(Math.sin(t * 2.2 + i * 0.55));
                    bars.push(Math.min(1, v * (0.5 + energy * 0.5)));
                }
            }
            return bars;
        }

        _drawEq(ctx, w, h, energy) {
            // Older Safari lacks roundRect — fall back to plain bars.
            if (typeof ctx.roundRect !== 'function') {
                this._drawEqRect(ctx, w, h, energy);
                return;
            }
            const bars = this._bars(28, energy);
            const bw = Math.min(5, (w - 24) / bars.length);
            const gap = 2.5;
            const base = h - 8;
            bars.forEach((v, i) => {
                const bh = Math.max(2, (v * (h - 18) * (0.55 + 0.45 * energy)));
                const x = 12 + i * (bw + gap);
                const grad = ctx.createLinearGradient(0, base - bh, 0, base);
                grad.addColorStop(0, this.accent);
                grad.addColorStop(1, this.secondary);
                ctx.fillStyle = grad;
                ctx.globalAlpha = 0.9;
                ctx.beginPath();
                ctx.roundRect(x, base - bh, bw, bh, bw / 2);
                ctx.fill();
            });
            ctx.globalAlpha = 1;
        }

        _drawEqRect(ctx, w, h, energy) {
            const bars = this._bars(28, energy);
            const bw = Math.min(5, (w - 24) / bars.length);
            const base = h - 8;
            bars.forEach((v, i) => {
                const bh = Math.max(2, v * (h - 18) * (0.55 + 0.45 * energy));
                ctx.fillStyle = i % 2 ? this.accent : this.secondary;
                ctx.globalAlpha = 0.9;
                ctx.fillRect(12 + i * (bw + 2.5), base - bh, bw, bh);
            });
            ctx.globalAlpha = 1;
        }

        _drawWave(ctx, w, h, t, energy) {
            const mid = h / 2;
            ctx.strokeStyle = this.accent;
            ctx.lineWidth = 2;
            ctx.globalAlpha = 0.85;
            ctx.beginPath();
            const step = 4;
            for (let x = 0; x <= w; x += step) {
                let y = mid;
                if (this._real && this._lastSpectrum) {
                    const i = Math.floor((x / w) * this._lastSpectrum.length * 0.5);
                    const v = (this._lastSpectrum[i] || 0) / 255;
                    y = mid - (v - 0.5) * h * 1.4;
                } else {
                    y = mid + Math.sin(x * 0.02 + t / 420) * h * 0.22 * (0.4 + energy) +
                        Math.sin(x * 0.045 - t / 260) * h * 0.08;
                }
                if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.globalAlpha = 1;
        }

        _drawCircular(ctx, w, h, t, energy) {
            const cx = w / 2, cy = h / 2;
            const radius = Math.min(w, h) * 0.22;
            const bars = this._bars(48, energy);
            ctx.save();
            ctx.translate(cx, cy);
            bars.forEach((v, i) => {
                const ang = (i / bars.length) * Math.PI * 2 - Math.PI / 2;
                const len = 6 + v * radius * 1.5 * (0.5 + energy);
                const x0 = Math.cos(ang) * radius;
                const y0 = Math.sin(ang) * radius;
                const x1 = Math.cos(ang) * (radius + len);
                const y1 = Math.sin(ang) * (radius + len);
                ctx.strokeStyle = i % 2 ? this.accent : this.secondary;
                ctx.lineWidth = 2;
                ctx.globalAlpha = 0.75;
                ctx.beginPath();
                ctx.moveTo(x0, y0);
                ctx.lineTo(x1, y1);
                ctx.stroke();
            });
            ctx.restore();
            ctx.globalAlpha = 1;
        }

        _drawParticles(ctx, w, h, t, energy) {
            if (this._particles.length < 26 && Math.random() < 0.3 + energy * 0.5) {
                this._particles.push({
                    x: Math.random() * w,
                    y: h + 6,
                    vx: (Math.random() - 0.5) * 0.6,
                    vy: -(0.5 + Math.random() * 1.4) * (0.5 + energy),
                    r: 1 + Math.random() * 2.4,
                    hue: Math.random() > 0.5 ? this.accent : this.secondary,
                    life: 1
                });
            }
            this._particles = this._particles.filter((p) => {
                p.x += p.vx; p.y += p.vy; p.life -= 0.012;
                if (p.life <= 0 || p.y < -8) return false;
                ctx.globalAlpha = Math.max(0, p.life) * 0.8;
                ctx.fillStyle = p.hue;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                ctx.fill();
                return true;
            });
            ctx.globalAlpha = 1;
        }

        _drawAurora(ctx, w, h, t, energy) {
            const c1 = this.accent, c2 = this.secondary, c3 = this.tertiary;
            const blend = (c, dx, dy, amp) => {
                const g = ctx.createRadialGradient(w / 2 + dx, h / 2 + dy, 0, w / 2 + dx, h / 2 + dy, Math.max(w, h) * 0.7);
                g.addColorStop(0, c);
                g.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = g;
                ctx.globalAlpha = (0.16 + energy * 0.22) * amp;
                ctx.fillRect(0, 0, w, h);
            };
            blend(c1, Math.sin(t / 3000) * w * 0.16, Math.cos(t / 2600) * h * 0.14, 1);
            blend(c2, Math.cos(t / 3600) * w * 0.2, Math.sin(t / 3200) * h * 0.16, 0.8);
            blend(c3, Math.sin(t / 4200 + 2) * w * 0.12, 0, 0.6);
            ctx.globalAlpha = 1;
        }
    }

    VisualizerEngine.EQ_PRESETS = {
        normal: [],
        bass: [
            { type: 'lowshelf', frequency: 200, gain: 6 },
            { type: 'peaking', frequency: 1000, gain: 1 }
        ],
        vocal: [
            { type: 'peaking', frequency: 300, gain: -3 },
            { type: 'peaking', frequency: 1200, gain: 4 },
            { type: 'peaking', frequency: 3200, gain: 3 }
        ],
        classical: [
            { type: 'lowshelf', frequency: 250, gain: -2 },
            { type: 'peaking', frequency: 1000, gain: 1 },
            { type: 'highshelf', frequency: 6000, gain: -2 }
        ],
        electronic: [
            { type: 'lowshelf', frequency: 200, gain: 3 },
            { type: 'peaking', frequency: 4000, gain: 4 }
        ],
        soft: [
            { type: 'lowshelf', frequency: 250, gain: -2 },
            { type: 'highshelf', frequency: 5000, gain: -4 }
        ]
    };

    window.VisualizerEngine = VisualizerEngine;
    window.VisualizerModes = MODES.slice();
})();
