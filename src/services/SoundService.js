// src/services/SoundService.js
// Phase 3.2 — premium chat sound effects, generated entirely with WebAudio
// (no audio assets, works offline). Three themes:
//   romantic ❤️  soft major-pentatonic two-note chime
//   premium  ✨  bright bell-like single note with overtone
//   night    🌙  mellow lower two-note lullaby chime
//
// The app decides WHEN sounds play (never while actively viewing the chat),
// and consults chat_preferences (sounds_enabled / sound_theme) via ChatService.

const THEMES = {
    romantic: {
        send:   [{ f: 523.25, t: 0, d: 0.5 }, { f: 659.25, t: 0.09, d: 0.7 }], // C5 → E5
        receive: [{ f: 587.33, t: 0, d: 0.6 }, { f: 880.00, t: 0.1, d: 0.9 }]  // D5 → A5
    },
    premium: {
        send:   [{ f: 783.99, t: 0, d: 0.6, sparkle: true }],                   // G5 bell
        receive: [{ f: 1046.50, t: 0, d: 0.8, sparkle: true }]                  // C6 bell
    },
    night: {
        send:   [{ f: 440.00, t: 0, d: 0.7 }, { f: 554.37, t: 0.14, d: 1.0 }],  // A4 → C#5
        receive: [{ f: 493.88, t: 0, d: 0.8 }, { f: 659.25, t: 0.16, d: 1.1 }]  // B4 → E5
    }
};

export class SoundService {
    constructor() {
        this._ctx = null;
        this._enabled = true;
        this._theme = 'romantic';
        this._lastReceiveAt = 0;
    }

    _ensure() {
        if (this._ctx) return this._ctx;
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return null;
            this._ctx = new AC();
        } catch (e) {
            return null;
        }
        return this._ctx;
    }

    // Call from a user gesture to unlock audio on mobile.
    unlock() {
        const ctx = this._ensure();
        if (ctx && ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }
    }

    setEnabled(v) { this._enabled = !!v; }
    setTheme(name) { if (THEMES[name]) this._theme = name; }

    _tone(freq, startAt, dur, { gain = 0.10, sparkle = false } = {}) {
        const ctx = this._ctx;
        const t0 = ctx.currentTime + startAt;
        const osc = ctx.createOscillator();
        osc.type = sparkle ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(freq, t0);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(g);
        g.connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.05);

        if (sparkle) {
            // Airy overtone for the premium bell.
            const osc2 = ctx.createOscillator();
            osc2.type = 'sine';
            osc2.frequency.setValueAtTime(freq * 2.01, t0);
            const g2 = ctx.createGain();
            g2.gain.setValueAtTime(0.0001, t0);
            g2.gain.exponentialRampToValueAtTime(gain * 0.35, t0 + 0.02);
            g2.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * 0.7);
            osc2.connect(g2);
            g2.connect(ctx.destination);
            osc2.start(t0);
            osc2.stop(t0 + dur * 0.7 + 0.05);
        }
    }

    play(kind = 'send', { dedupeKey = null } = {}) {
        if (!this._enabled) return;
        const ctx = this._ensure();
        if (!ctx) return;

        // Never double-sound the same event (e.g. realtime echo).
        if (kind === 'receive' && dedupeKey) {
            const now = Date.now();
            if (this._lastReceiveKey === dedupeKey && now - this._lastReceiveAt < 3000) return;
            this._lastReceiveKey = dedupeKey;
            this._lastReceiveAt = now;
        }

        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const notes = (THEMES[this._theme] || THEMES.romantic)[kind] || [];
        notes.forEach((n, i) => this._tone(n.f, n.t, n.d, { sparkle: !!n.sparkle }));
    }
}
