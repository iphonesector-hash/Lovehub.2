/* ============================================================================
 * chat-rich.js — LoveHub Phase 3.2 (rich chat experience + UI polish)
 *
 * Loaded AFTER app.js (classic script, runs after the LoveHub class is
 * defined and before the DOMContentLoaded instance is created). It extends
 * the class through prototype wraps — no changes to app.js itself, so the
 * existing app keeps working even if this file is removed.
 *
 * Adds:
 *   - media messages: photo / camera / video (compression, progress, preview,
 *     signed-URL loading via ChatService + couples-media bucket)
 *   - drawing & handwritten canvas messages with stroke-replay on the receiver
 *   - animated sticker messages
 *   - voice messages (MediaRecorder, waveform, 1x/1.5x/2x playback)
 *   - chat sound effects (SoundService) + settings section
 *   - floating-hearts message effects
 *   - AI Love Assistant sheets (the legacy procedural Music Room overlay was
 *     retired in Phase 13 — Music opens the canonical Music page/player)
 *   - bug fixes: composer overlap (hide FABs on chat page), chat open position
 *     (internal scroll list + scroll-to-bottom), keyboard inset, and purple
 *     message status theme (CSS in chat-rich.css)
 *
 * No Supabase auth, couple-linking, or existing RLS logic is touched.
 * ========================================================================== */

(function () {
    'use strict';

    if (typeof LoveHub === 'undefined') return; // app.js not loaded

    const proto = LoveHub.prototype;

    // ---- tiny helper: wrap a prototype method, keeping the original ----
    // fn receives (originalReturnValue, originalArgs) so argument-using
    // wrappers can read args[0] etc.
    function wrap(prototype, name, fn) {
        const orig = prototype[name];
        prototype[name] = function (...args) {
            if (orig) {
                const r = orig.apply(this, args);
                if (r && typeof r.then === 'function') return r.then((v) => fn.call(this, v, args));
                return fn.call(this, r, args);
            }
            return fn.call(this, undefined, args);
        };
    }

    // =====================================================================
    // Lifecycle wraps
    // =====================================================================

    wrap(proto, 'init', function () {
        // Phase 3.6 — media caches must exist before the first render path can
        // run (a media bubble may render before handleSignedOut/refreshCouple
        // fire on cold start with an existing session).
        this._mediaUrlCache = this._mediaUrlCache || new Map();
        this._mediaUrlInFlight = this._mediaUrlInFlight || new Map();
        this.setupRichChat();
    });

    wrap(proto, 'navigateTo', function () {
        // Composer-overlap fix: hide the global FABs + mini player on the
        // chat page so they can never cover the composer or send button.
        document.body.classList.toggle('chat-open', this.currentPage === 'chat');
        if (this.currentPage === 'chat') this.applyChatBackground();
        if (this.currentPage !== 'chat') this.setChatKeyboardInset(0);
    });

    wrap(proto, 'setupNavigation', function () {
        // Home action cards that open experience sheets.
        document.querySelectorAll('[data-action]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                if (action === 'music') this.openMusicRoom();
                else if (action === 'ai') this.openAiSheet();
            });
        });
        // Floating action buttons — same experiences.
        const musicFab = document.getElementById('musicFab');
        if (musicFab) musicFab.addEventListener('click', () => this.openMusicRoom());
        const aiFab = document.getElementById('aiFab');
        if (aiFab) aiFab.addEventListener('click', () => this.openAiSheet());
    });

    wrap(proto, 'handleSignedOut', function () {
        this.stopVoiceRecording();
        this.closeAllSheets();
        this._pendingMedia = null;
        this._mediaUrlCache = new Map();
        this._mediaUrlInFlight = new Map();
        this.setUploadUi(false);
    });

    wrap(proto, 'refreshCouple', function () {
        this.stopVoiceRecording();
        this.closeAllSheets();
        this._pendingMedia = null;
        this._mediaUrlCache = new Map();
        this._mediaUrlInFlight = new Map();
    });

    wrap(proto, 'resetChatComposer', function () {
        this.setUploadUi(false);
        this.closeMediaPreview(true);
        // Collapse the '+' media row back after send / logout / couple switch.
        const row = document.getElementById('chatMediaRow');
        const toggle = document.getElementById('chatMediaToggle');
        if (row) row.style.display = 'none';
        if (toggle) toggle.classList.remove('active');
    });

    // =====================================================================
    // Sound preferences (loaded from chat_preferences)
    // =====================================================================

    wrap(proto, 'loadChat', function () {
        this._chatSoundEnabled = this._chatPrefs?.sounds_enabled !== false;
        this._chatSoundTheme = this._chatPrefs?.sound_theme || 'romantic';
        this._chatBackground = this._chatPrefs?.background || 'aurora';
        this._chatBgMode = this._chatPrefs?.background_mode || 'static';
        if (window.LoveHubSounds) {
            window.LoveHubSounds.setEnabled(this._chatSoundEnabled);
            window.LoveHubSounds.setTheme(this._chatSoundTheme);
        }
        this.applyChatBackground();
    });

    // =====================================================================
    // Message normalization (rich fields)
    // =====================================================================

    proto.normalizeMessage = function (m) {
        return {
            id: m.id,
            sender_id: m.sender_id,
            text: m.content,
            timestamp: m.created_at,
            message_type: m.message_type || 'text',
            media: m.media || null,
            // Phase 3.6 — the DB stores rich metadata (mime, trim, muted, …)
            // in the `media` jsonb column; renderers read it as `metadata`.
            // Without this mapping, video trim/mute never worked from history
            // or realtime because msg.metadata was always undefined.
            metadata: m.media || null,
            media_url: m.media_url || null,
            thumbnail_url: m.thumbnail_url || null,
            file_size: m.file_size || null,
            duration: m.duration || null,
            read_at: m.read_at,
            delivered_at: m.delivered_at,
            edited_at: m.edited_at,
            edited_by: m.edited_by,
            reply_to_id: m.reply_to_id,
            reply_to_content: m.reply_to_content,
            reply_to_sender_id: m.reply_to_sender_id,
            deleted_for: m.deleted_for || [],
            deleted_at: m.deleted_at,
            pinned: !!m.pinned,
            favorite: !!m.favorite,
            saved_to_memories: !!m.saved_to_memories
        };
    };

    // =====================================================================
    // Bubble rendering with rich media
    // =====================================================================

    proto.buildMessageBubble = function (msg, myUid) {
        const mine = msg.sender_id === myUid;
        const bubble = document.createElement('div');
        bubble.className = `message-bubble ${mine ? 'sent' : 'received'}`;
        bubble.dataset.mid = msg.id;
        if (msg.deleted_at) bubble.classList.add('deleted');

        const frag = document.createDocumentFragment();

        // Overflow menu (tap-hold on the bubble opens the same sheet).
        const menu = document.createElement('button');
        menu.className = 'bubble-menu';
        menu.innerHTML = '<svg width="13" height="13" class="icon-svg"><use href="#icon-more"/></svg>';
        menu.addEventListener('click', (e) => { e.stopPropagation(); this.openMessageActions(msg); });
        frag.appendChild(menu);

        if (msg.pinned) {
            const pin = document.createElement('span');
            pin.className = 'bubble-pin';
            pin.textContent = '📌';
            frag.appendChild(pin);
        }

        // Reply preview (snapshot stored server-side at send time).
        if (msg.reply_to_content) {
            const reply = document.createElement('div');
            reply.className = 'bubble-reply';
            const who = msg.reply_to_sender_id === myUid ? 'You' : (this._chatPartnerName || 'Partner');
            reply.innerHTML = `<div class="reply-who">${this.escapeHtml(who)}</div><div class="reply-text">${this.escapeHtml(msg.reply_to_content)}</div>`;
            frag.appendChild(reply);
        }

        const hidden = !!msg.deleted_at || this.isHiddenForMe(msg);

        // Rich media content, or the classic text bubble.
        if (!hidden && msg.message_type && msg.message_type !== 'text') {
            const mediaEl = this.buildMediaContent(msg);
            if (mediaEl) frag.appendChild(mediaEl);
        } else {
            const content = document.createElement('div');
            content.className = 'bubble-content';
            const shown = msg.deleted_at
                ? 'Message deleted'
                : this.isHiddenForMe(msg)
                    ? 'You deleted this message'
                    : (msg.text || '');
            content.appendChild(document.createTextNode(shown));
            if (msg.edited_at && !hidden) {
                const edited = document.createElement('span');
                edited.className = 'bubble-edited';
                edited.textContent = 'edited';
                content.appendChild(edited);
            }
            frag.appendChild(content);
        }

        // Reactions.
        const reactions = this._chatReactions[msg.id];
        if (reactions && Object.keys(reactions).length) {
            const row = document.createElement('div');
            row.className = 'bubble-reactions';
            Object.keys(reactions).sort().forEach((emoji) => {
                const chip = document.createElement('button');
                chip.className = 'reaction-chip';
                if ((reactions[emoji] || []).includes(myUid)) chip.classList.add('mine');
                chip.textContent = `${emoji} ${reactions[emoji].length}`;
                chip.addEventListener('click', (e) => { e.stopPropagation(); this.toggleReaction(msg, emoji); });
                row.appendChild(chip);
            });
            frag.appendChild(row);
        }

        // Time + status (sent ✓ / delivered ✓✓ / read ✓✓ + Read).
        const meta = document.createElement('div');
        meta.className = 'bubble-meta';
        const time = document.createElement('span');
        time.className = 'bubble-time';
        time.textContent = this.formatTime(msg.timestamp);
        meta.appendChild(time);
        if (mine && !hidden) meta.appendChild(this.buildStatusTicks(msg));
        frag.appendChild(meta);

        bubble.appendChild(frag);
        return bubble;
    };

    // ---- media helpers ----

    // Phase 3.6 — media reliability. The previous implementation cached the
    // in-flight PROMISE (not the resolved URL) and never invalidated failures,
    // so one transient sign_couple_media failure permanently blanked every
    // media bubble for 50 minutes (sender AND receiver). Now we cache only the
    // resolved URL, cache failures as short "retry soon" markers, never reject,
    // and expire signed URLs before the server's 3600s limit.
    proto.getSignedMediaUrl = async function (path) {
        if (!path) return null;
        // Defensive init: never let a missing map break the first media bubble.
        this._mediaUrlCache = this._mediaUrlCache || new Map();
        this._mediaUrlInFlight = this._mediaUrlInFlight || new Map();
        const cached = this._mediaUrlCache.get(path);
        if (cached) {
            if (cached.url && cached.exp > Date.now()) return cached.url;
            // Recent failure — let the caller show the error state and retry
            // shortly after, instead of inheriting a dead result all session.
            if (cached.failedAt && Date.now() - cached.failedAt < 8000) return null;
        }
        // Deduplicate concurrent requests for the same path (a history batch
        // renders many bubbles at once) without ever caching the promise —
        // failures are never stored, only a short failedAt marker so a broken
        // RPC/auth window does not become a permanent dead entry.
        if (this._mediaUrlInFlight.has(path)) return this._mediaUrlInFlight.get(path);
        const p = (window.LoveHubChat ? window.LoveHubChat.getMediaUrl(path) : Promise.resolve(null))
            .then((url) => {
                if (!url) return null;
                // storage.create_signed_url hands back a full URL on current
                // Supabase; older hosts may return a bare path — absolutize it
                // against the configured Supabase origin so media always loads.
                if (url.charAt(0) === '/') {
                    const base = (typeof SUPABASE_CONFIG !== 'undefined' && SUPABASE_CONFIG.url) || '';
                    return base ? base.replace(/\/$/, '') + url : null;
                }
                return url;
            })
            .catch(() => null);
        this._mediaUrlInFlight.set(path, p);
        const resolved = await p;
        this._mediaUrlInFlight.delete(path);
        if (resolved) {
            // Signed URLs expire after 3600s server-side — refresh before then.
            this._mediaUrlCache.set(path, { url: resolved, exp: Date.now() + 50 * 60 * 1000 });
        } else {
            this._mediaUrlCache.set(path, { failedAt: Date.now() });
        }
        if (this._mediaUrlCache.size > 150) {
            this._mediaUrlCache.delete(this._mediaUrlCache.keys().next().value);
        }
        return resolved;
    };

    // Drop a cached signed URL so the next render/play mints a fresh one.
    // Used when an <img>/<video>/<audio> element reports a load/play error
    // (e.g. the URL was rotated before it loaded).
    proto.invalidateMediaUrl = function (path) {
        if (path) this._mediaUrlCache.delete(path);
    };

    // Shared loading placeholder for media bubbles — shown until the signed
    // URL resolves and the element actually loads.
    proto.mediaLoadingEl = function () {
        const el = document.createElement('div');
        el.className = 'media-loading';
        el.appendChild(document.createElement('span'));
        return el;
    };

    // Shared error state for media bubbles — a broken URL never leaves a blank
    // bubble, and always offers an inline retry that mints a fresh URL.
    proto.mediaErrorEl = function (label, onRetry) {
        const el = document.createElement('div');
        el.className = 'media-error';
        const note = document.createElement('span');
        note.textContent = label || 'Media unavailable';
        el.appendChild(note);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Retry';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (onRetry) onRetry();
        });
        el.appendChild(btn);
        return el;
    };

    proto.mediaError = function (wrap, label, onRetry) {
        wrap.querySelector('.media-loading')?.remove();
        wrap.querySelector('.media-error')?.remove();
        const imgEl = wrap.querySelector('img');
        if (imgEl) imgEl.remove();
        const vid = wrap.querySelector('video');
        if (vid) vid.remove();
        wrap.appendChild(this.mediaErrorEl(label, onRetry));
    };

    proto.formatDuration = function (sec) {
        const s = Math.max(0, Math.round(sec || 0));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };

    proto.buildMediaContent = function (msg) {
        switch (msg.message_type) {
            case 'image': return this.buildImageBubble(msg);
            case 'gif': return this.buildGifBubble(msg);
            case 'video': return this.buildVideoBubble(msg);
            case 'voice':
            case 'audio': return this.buildVoiceBubble(msg);
            case 'drawing':
            case 'handwritten': return this.buildDrawingBubble(msg);
            case 'sticker': return this.buildStickerBubble(msg);
            case 'memory': return this.buildMemoryBubble(msg);
            default: return null;
        }
    };

    proto.buildImageBubble = function (msg) {
        const wrap = document.createElement('div');
        wrap.className = 'bubble-media';
        const img = document.createElement('img');
        img.alt = 'Photo';
        // Eager load on purpose: loading="lazy" combined with display:none
        // would defer the fetch indefinitely (a hidden element has no layout
        // box, so it is never "near the viewport") and the image would never
        // appear. Eager images fetch even while hidden, then onload restores
        // visibility — this was the image-never-renders bug.
        img.style.display = 'none'; // shown once the image actually loads
        img.addEventListener('click', () => this.openMediaViewer(msg, 'image'));
        wrap.appendChild(this.mediaLoadingEl());
        wrap.appendChild(img);
        let attempts = 0;
        const showError = (label) => {
            if (wrap.querySelector('.media-error')) return;
            wrap.querySelector('.media-loading')?.remove();
            img.style.display = 'none';
            wrap.appendChild(this.mediaErrorEl(label || 'Media unavailable', () => {
                attempts = 0;
                this.invalidateMediaUrl(msg.media_url);
                wrap.querySelector('.media-error')?.remove();
                wrap.appendChild(this.mediaLoadingEl());
                load();
            }));
        };
        const load = () => {
            this.getSignedMediaUrl(msg.media_url).then((url) => {
                if (!url) { showError(); return; }
                img.onload = () => { img.style.display = ''; wrap.querySelector('.media-loading')?.remove(); };
                img.onerror = () => {
                    // URL may have been rotated/expired — mint a fresh one once,
                    // then surface a retryable error instead of a blank bubble.
                    if (attempts === 0) {
                        attempts = 1;
                        this.invalidateMediaUrl(msg.media_url);
                        load();
                    } else {
                        showError();
                    }
                };
                img.src = url;
            });
        };
        load();
        if (msg.text) {
            const cap = document.createElement('div');
            cap.className = 'media-caption';
            cap.textContent = msg.text;
            wrap.appendChild(cap);
        }
        return wrap;
    };

    // Telegram-style round video bubble: circular thumb, play overlay, inline
    // play/pause. Tapping the video itself opens the fullscreen viewer.
    proto.buildVideoBubble = function (msg) {
        const block = document.createElement('div');
        block.className = 'bubble-video-block';
        const wrap = document.createElement('div');
        wrap.className = 'bubble-media video-round';
        const video = document.createElement('video');
        video.controls = false;
        video.preload = 'metadata';
        video.playsInline = true;
        video.muted = true;
        video.loop = true;
        video.style.display = 'none';
        video.addEventListener('click', () => this.openMediaViewer(msg, 'video'));
        wrap.appendChild(this.mediaLoadingEl());
        wrap.appendChild(video);
        const play = document.createElement('button');
        play.className = 'video-play-btn';
        play.innerHTML = '<svg class="icon-svg"><use href="#icon-play"/></svg>';
        const togglePlay = () => {
            if (video.paused) { video.play().catch(() => {}); play.style.display = 'none'; }
            else { video.pause(); play.style.display = ''; }
        };
        play.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
        video.addEventListener('ended', () => { play.style.display = ''; });
        wrap.appendChild(play);
        if (msg.duration) {
            const badge = document.createElement('span');
            badge.className = 'media-dur';
            badge.textContent = this.formatDuration(msg.duration);
            wrap.appendChild(badge);
        }
        const meta = msg.metadata || {};
        const trim = meta.trim && meta.trim.end > (meta.trim.start || 0) ? meta.trim : null;
        let attempts = 0;
        const showError = (label) => {
            wrap.querySelector('.media-loading')?.remove();
            video.style.display = 'none';
            play.style.display = 'none';
            if (!wrap.querySelector('.media-error')) {
                wrap.appendChild(this.mediaErrorEl(label || 'Video unavailable', () => {
                    attempts = 0;
                    this.invalidateMediaUrl(msg.media_url);
                    wrap.querySelector('.media-error')?.remove();
                    wrap.appendChild(this.mediaLoadingEl());
                    load();
                }));
            }
        };
        const load = () => {
            this.getSignedMediaUrl(msg.media_url).then((url) => {
                if (!url) { showError(); return; }
                video.onerror = () => {
                    // URL may have been rotated/expired — mint a fresh one once,
                    // then surface a retryable error instead of a black round.
                    if (attempts === 0) {
                        attempts = 1;
                        this.invalidateMediaUrl(msg.media_url);
                        load();
                    } else {
                        showError();
                    }
                };
                video.src = url;
                if (trim) {
                    video.onloadedmetadata = () => { video.currentTime = trim.start; video.onloadedmetadata = null; };
                    video.ontimeupdate = () => {
                        if (video.currentTime >= trim.end) {
                            video.pause();
                            video.currentTime = trim.start;
                            play.style.display = '';
                        }
                    };
                }
                // Reveal the frame once the first frame is ready, then quietly
                // loop the clip while it is on screen (Telegram-style).
                video.onloadeddata = () => {
                    video.style.display = '';
                    wrap.querySelector('.media-loading')?.remove();
                    play.style.display = '';
                };
                if ('IntersectionObserver' in window) {
                    const io = new IntersectionObserver((entries) => {
                        entries.forEach((en) => {
                            if (en.isIntersecting) {
                                video.play().catch(() => {});
                                io.unobserve(video);
                            } else {
                                video.pause();
                            }
                        });
                    }, { threshold: 0.35 });
                    io.observe(video);
                }
            });
        };
        load();
        this.getSignedMediaUrl(msg.thumbnail_url).then((url) => { if (url) video.poster = url; });
        block.appendChild(wrap);
        if (msg.text) {
            const cap = document.createElement('div');
            cap.className = 'media-caption';
            cap.textContent = msg.text;
            block.appendChild(cap);
        }
        return block;
    };

    proto.buildVoiceBubble = function (msg) {
        const wrap = document.createElement('div');
        wrap.className = 'bubble-voice';
        const btn = document.createElement('button');
        btn.className = 'voice-play-btn';
        btn.innerHTML = '<svg class="icon-svg"><use href="#icon-play"/></svg>';
        const mid = document.createElement('div');
        mid.className = 'voice-mid';
        const bars = document.createElement('div');
        bars.className = 'voice-bars';
        const N = 34;
        for (let i = 0; i < N; i++) {
            const b = document.createElement('i');
            b.style.height = (6 + Math.abs(Math.sin(i * 1.7)) * 18 + Math.abs(Math.sin(i * 0.9)) * 8) + 'px';
            bars.appendChild(b);
        }
        const seek = document.createElement('div');
        seek.className = 'voice-seek';
        const fill = document.createElement('div');
        fill.className = 'voice-seek-fill';
        seek.appendChild(fill);
        const time = document.createElement('span');
        time.className = 'voice-time';
        const speed = document.createElement('button');
        speed.className = 'voice-speed-btn';
        speed.textContent = '1x';
        mid.appendChild(bars);
        mid.appendChild(seek);
        mid.appendChild(time);
        wrap.appendChild(btn);
        wrap.appendChild(mid);
        wrap.appendChild(speed);

        const total = Math.max(0, Math.round(msg.duration || 0));
        let audio = null;
        let playing = false;
        let rate = 1;
        let seekDragging = false;
        const setBtn = (p) => {
            playing = p;
            btn.classList.toggle('playing', p);
            bars.classList.toggle('playing', p);
            btn.innerHTML = p
                ? '<svg class="icon-svg"><use href="#icon-pause"/></svg>'
                : '<svg class="icon-svg"><use href="#icon-play"/></svg>';
        };
        const paint = () => {
            const cur = audio ? audio.currentTime : 0;
            const frac = total > 0 ? Math.min(1, cur / total) : 0;
            fill.style.width = (frac * 100) + '%';
            time.textContent = `${this.formatDuration(cur)} / ${this.formatDuration(total)}`;
            const active = Math.round(frac * N);
            Array.from(bars.children).forEach((b, i) => b.classList.toggle('on', i < active));
        };
        // Phase 3.6 — lazy audio init shared by the play button and the seek
        // bar (a voice message can be scrubbed before its first play). Shows a
        // loading state, surfaces failures instead of failing silently, and
        // clears the signed-URL cache so the next tap mints a fresh URL and
        // retries.
        const ensureAudio = (onReady) => {
            if (audio) { if (onReady) onReady(); return; }
            btn.classList.add('loading');
            this.getSignedMediaUrl(msg.media_url).then((url) => {
                btn.classList.remove('loading');
                if (!url) {
                    time.textContent = 'Unavailable';
                    this.showToast('Voice message unavailable');
                    return;
                }
                audio = new Audio(url);
                audio.playbackRate = rate;
                audio.onended = () => { setBtn(false); paint(); };
                audio.onpause = () => { if (!seekDragging) { setBtn(false); paint(); } };
                // Genuine media failure (bad/expired URL, unsupported codec,
                // network). Log the exact MediaError code+message, drop the
                // broken instance and cached URL so the next tap mints a fresh
                // signed URL and rebuilds — a real retry, never a silent blank.
                audio.onerror = () => {
                    const me = audio && audio.error;
                    console.warn('[MEDIA_RENDER][voice] audio error', msg && msg.id,
                        me ? ('code=' + me.code + ' ' + (me.message || 'media error')) : 'no MediaError');
                    setBtn(false);
                    this.invalidateMediaUrl(msg.media_url);
                    time.textContent = 'Playback failed — tap to retry';
                    this.showToast('Voice playback failed');
                    audio = null;
                };
                audio.ontimeupdate = paint;
                if (onReady) onReady();
            });
        };
        btn.addEventListener('click', () => {
            if (!audio) {
                ensureAudio(() => {
                    audio.play()
                        .then(() => setBtn(true))
                        .catch((err) => {
                            // Never swallow: log the rejection and KEEP the audio
                            // instance alive. The first async play() can be
                            // rejected (e.g. NotAllowedError on iOS Safari when
                            // the element was created outside the tap gesture) —
                            // the next tap then calls play() inside a real user
                            // gesture and succeeds.
                            console.warn('[MEDIA_RENDER][voice] play() rejected', msg && msg.id,
                                err && (err.name + ': ' + err.message));
                            time.textContent = 'Tap to retry';
                        });
                });
            } else if (playing) {
                audio.pause();
            } else {
                audio.play()
                    .then(() => setBtn(true))
                    .catch((err) => {
                        console.warn('[MEDIA_RENDER][voice] play() rejected', msg && msg.id,
                            err && (err.name + ': ' + err.message));
                        time.textContent = 'Tap to retry';
                    });
            }
        });
        speed.addEventListener('click', () => {
            const rates = [1, 1.5, 2];
            rate = rates[(rates.indexOf(rate) + 1) % rates.length];
            speed.textContent = rate + 'x';
            if (audio) audio.playbackRate = rate;
        });
        const seekTo = (e) => {
            const rect = seek.getBoundingClientRect();
            const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
            const applySeek = () => { if (audio) audio.currentTime = frac * total; paint(); };
            if (!audio) ensureAudio(applySeek); // scrub before first play
            else applySeek();
        };
        seek.addEventListener('pointerdown', (e) => {
            seekDragging = true;
            seek.setPointerCapture && seek.setPointerCapture(e.pointerId);
            seekTo(e);
        });
        seek.addEventListener('pointermove', (e) => { if (seekDragging) seekTo(e); });
        seek.addEventListener('pointerup', (e) => { seekDragging = false; seekTo(e); });
        seek.addEventListener('pointercancel', () => { seekDragging = false; });
        paint();
        return wrap;
    };

    proto.buildDrawingBubble = function (msg) {
        const wrap = document.createElement('div');
        wrap.className = msg.message_type === 'handwritten' ? 'bubble-handwritten' : 'bubble-drawing';
        const canvas = document.createElement('canvas');
        canvas.width = 720;
        canvas.height = 480;
        wrap.appendChild(canvas);
        const tag = document.createElement('span');
        tag.className = 'draw-mode-tag';
        tag.textContent = msg.message_type === 'handwritten' ? '✍️ Handwritten' : '🎨 Drawing';
        wrap.appendChild(tag);
        const replay = document.createElement('button');
        replay.className = 'draw-replay';
        replay.textContent = '▶ Replay';
        wrap.appendChild(replay);
        this.renderStrokes(canvas, msg, false);
        replay.addEventListener('click', () => this.renderStrokes(canvas, msg, true));
        return wrap;
    };

    proto.renderStrokes = function (canvas, msg, replay) {
        const ctx = canvas.getContext('2d');
        const strokes = (msg.media && msg.media.strokes) || [];
        const draw = (s) => {
            ctx.strokeStyle = s.color || '#fff';
            ctx.fillStyle = s.color || '#fff';
            ctx.lineWidth = s.size || 6;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            if (s.type === 'heart') {
                this.drawHeartPath(ctx, s.x || canvas.width / 2, s.y || canvas.height / 2, s.size || 40, s.color || '#fff');
            } else if (s.points && s.points.length) {
                ctx.beginPath();
                ctx.moveTo(s.points[0].x, s.points[0].y);
                for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
                ctx.stroke();
                if (s.points.length === 1) {
                    ctx.beginPath();
                    ctx.arc(s.points[0].x, s.points[0].y, s.size / 2 || 3, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        };
        if (replay) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            let i = 0;
            const tick = () => { if (i < strokes.length) { draw(strokes[i]); i++; requestAnimationFrame(tick); } };
            requestAnimationFrame(tick);
        } else {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            strokes.forEach(draw);
        }
    };

    proto.buildStickerBubble = function (msg) {
        const wrap = document.createElement('div');
        wrap.className = 'sticker-bubble';
        const def = (window.LoveHubStickerById || {})[msg.text || ''];
        if (def) {
            wrap.classList.add('sticker-' + def.anim);
            wrap.textContent = def.emoji;
        } else {
            wrap.textContent = msg.text || '❤️';
            wrap.classList.add('sticker-pulse');
        }
        return wrap;
    };

    // Animated emoji GIF messages (offline-first, CSS-animated like stickers).
    proto.buildGifBubble = function (msg) {
        const wrap = document.createElement('div');
        wrap.className = 'gif-bubble';
        const def = this._gifRegistry().find((g) => g.id === (msg.text || ''));
        if (def) {
            wrap.classList.add('gif-' + def.anim);
            wrap.textContent = def.emoji;
        } else {
            wrap.classList.add('gif-pulse');
            wrap.textContent = msg.text || '💫';
        }
        return wrap;
    };

    proto.buildMemoryBubble = function (msg) {
        const wrap = document.createElement('div');
        wrap.className = 'bubble-memory';
        wrap.innerHTML = `<div class="memory-badge">💝</div><div class="memory-line">${this.escapeHtml(msg.text || 'A special moment')}</div>`;
        return wrap;
    };

    proto.openMediaViewer = async function (msg, kind) {
        const viewer = document.getElementById('mediaViewer');
        const stage = document.getElementById('viewerStage');
        if (!viewer || !stage) return;
        stage.innerHTML = '';
        const url = await this.getSignedMediaUrl(msg.media_url);
        if (!url) { this.showToast('Media unavailable'); return; }
        const frame = document.createElement('div');
        frame.className = 'viewer-media';
        const meta = msg.metadata || {};
        const trim = meta.trim && meta.trim.end > (meta.trim.start || 0) ? meta.trim : null;

        if (kind === 'video') {
            const v = document.createElement('video');
            v.src = url;
            v.controls = true;
            v.playsInline = true;
            v.autoplay = true;
            v.muted = !!meta.muted;
            v.onloadedmetadata = () => { if (trim) v.currentTime = trim.start; };
            v.ontimeupdate = () => {
                if (trim && v.currentTime >= trim.end) { v.pause(); v.currentTime = trim.start; }
            };
            frame.appendChild(v);
        } else {
            const img = document.createElement('img');
            img.alt = 'Photo';
            frame.appendChild(this.mediaLoadingEl());
            img.onload = () => frame.querySelector('.media-loading')?.remove();
            img.onerror = () => {
                frame.querySelector('.media-loading')?.remove();
                const note = document.createElement('div');
                note.className = 'media-error';
                note.textContent = 'Media unavailable';
                frame.appendChild(note);
            };
            img.src = url;
            frame.appendChild(img);
            this.attachViewerGestures(frame, img, viewer);
        }

        // Action bar: save + share (media messages only).
        const bar = document.createElement('div');
        bar.className = 'viewer-actions';
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'viewer-act';
        saveBtn.innerHTML = '<svg class="icon-svg"><use href="#icon-download"/></svg><span>Save</span>';
        saveBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                const res = await fetch(url);
                const blob = await res.blob();
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'lovehub-media';
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(a.href), 4000);
            } catch (err) {
                window.open(url, '_blank');
            }
        });
        bar.appendChild(saveBtn);
        if (navigator.share) {
            const shareBtn = document.createElement('button');
            shareBtn.type = 'button';
            shareBtn.className = 'viewer-act';
            shareBtn.innerHTML = '<svg class="icon-svg"><use href="#icon-share"/></svg><span>Share</span>';
            shareBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                try { await navigator.share({ title: 'LoveHub', url }); } catch (err) { /* user cancelled */ }
            });
            bar.appendChild(shareBtn);
        }
        stage.appendChild(frame);
        stage.appendChild(bar);
        viewer.classList.add('active');
        const closeBtn = document.getElementById('mediaViewerClose');
        if (closeBtn) closeBtn.focus();
    };

    // Pinch / double-tap zoom + drag-down-to-close for the fullscreen viewer.
    proto.attachViewerGestures = function (frame, img, viewer) {
        let zoom = 1;
        let tx = 0;
        let ty = 0;
        let pinchDist = 0;
        let dragStart = null;
        let lastTap = 0;
        const pointers = new Map();
        const apply = (smooth) => {
            frame.style.transition = smooth ? 'transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1)' : 'none';
            frame.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
        };
        const onWheel = (e) => {
            e.preventDefault();
            zoom = Math.min(4, Math.max(1, zoom - e.deltaY * 0.002));
            tx = Math.min(zoom * 80, Math.max(-zoom * 80, tx));
            ty = Math.min(zoom * 120, Math.max(-zoom * 120, ty));
            apply(false);
        };
        const onDown = (e) => {
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.size === 2) {
                const [a, b] = [...pointers.values()];
                pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
                dragStart = null;
                return;
            }
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            dragStart = { x: e.clientX - tx, y: e.clientY - ty, id: e.pointerId, t: Date.now() };
        };
        const onMove = (e) => {
            if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.size === 2 && pinchDist > 0) {
                const [a, b] = [...pointers.values()];
                const d = Math.hypot(a.x - b.x, a.y - b.y);
                zoom = Math.min(4, Math.max(1, zoom * (d / pinchDist)));
                pinchDist = d;
                apply(false);
                return;
            }
            if (!dragStart || dragStart.id !== e.pointerId) return;
            if (zoom > 1) {
                tx = e.clientX - dragStart.x;
                ty = e.clientY - dragStart.y;
                apply(false);
            } else {
                const dy = e.clientY - (dragStart.y + ty);
                if (dy > 3) {
                    ty = dy;
                    frame.style.opacity = Math.max(0.35, 1 - Math.abs(ty) / 420);
                    apply(false);
                }
            }
        };
        const onUp = (e) => {
            pointers.delete(e.pointerId);
            if (pointers.size < 2) pinchDist = 0;
            if (!dragStart || dragStart.id !== e.pointerId) return;
            const now = Date.now();
            const dy = e.clientY - (dragStart.y + ty);
            if (now - dragStart.t < 260 && Math.abs(dy) < 10) {
                if (now - lastTap < 320) {
                    lastTap = 0;
                    if (zoom > 1) { zoom = 1; tx = 0; ty = 0; }
                    else { zoom = 2.4; tx = 0; ty = 0; }
                    apply(true);
                    return;
                }
                lastTap = now;
                dragStart = null;
                return;
            }
            dragStart = null;
            if (Math.abs(dy) > 110) {
                frame.style.opacity = 1;
                viewer.classList.remove('active');
                return;
            }
            tx = 0; ty = 0;
            apply(true);
            frame.style.opacity = 1;
        };
        frame.addEventListener('wheel', onWheel, { passive: false });
        frame.addEventListener('pointerdown', onDown);
        frame.addEventListener('pointermove', onMove);
        frame.addEventListener('pointerup', onUp);
        frame.addEventListener('pointercancel', onUp);
    };

    // =====================================================================
    // Receive sound + effects (wrapped — only fires when NOT viewing chat)
    // =====================================================================

    wrap(proto, 'notifyNewMessage', function (value, args) {
        const msg = args && args[0];
        if (!msg) return;
        window.LoveHubSounds?.play('receive', { dedupeKey: msg.id });
        this.maybeMessageEffect(msg);
    });

    wrap(proto, 'appendMessageDom', function (value, args) {
        const msg = args && args[0];
        if (!msg || this.currentPage !== 'chat') return;
        if (msg.sender_id === this.currentUser?.id) window.LoveHubSounds?.play('send', { dedupeKey: msg.id });
        this.maybeMessageEffect(msg);
    });

    proto.maybeMessageEffect = function (msg) {
        if (!msg) return;
        const text = (msg.text || '').toLowerCase();
        if (msg.message_type === 'sticker' ||
            /i love you|love you|miss you|marry me|forever|soulmate|always|ily\b/.test(text)) {
            this.floatHearts();
        }
    };

    proto.floatHearts = function () {
        const layer = document.getElementById('chatEffects');
        if (!layer) return;
        const emojis = ['❤️', '💜', '💖', '💕', '✨'];
        for (let i = 0; i < 12; i++) {
            const h = document.createElement('span');
            h.className = 'fx-heart';
            h.textContent = emojis[i % emojis.length];
            h.style.left = (5 + Math.random() * 90) + '%';
            h.style.fontSize = (14 + Math.random() * 22) + 'px';
            h.style.animationDuration = (2.6 + Math.random() * 2.2) + 's';
            h.style.animationDelay = (Math.random() * 0.5) + 's';
            layer.appendChild(h);
            setTimeout(() => h.remove(), 6500);
        }
    };

    // =====================================================================
    // Hide Edit for non-text messages (server rejects content edits anyway)
    // =====================================================================

    wrap(proto, 'openMessageActions', function (value, args) {
        const msg = args && args[0];
        if (msg && msg.message_type && msg.message_type !== 'text') {
            const actions = document.getElementById('asActions');
            if (actions) {
                actions.querySelectorAll('.action-item').forEach((b) => {
                    if (b.textContent.includes('Edit')) b.remove();
                });
            }
        }
    });

    // =====================================================================
    // Chat settings — Sounds section
    // =====================================================================

    // Phase 3.6 — premium backgrounds. Keeps the legacy theme ids so saved
    // preferences keep working, adds a short cross-fade when the theme or mode
    // changes (CSS fades the ::before layer via .bg-switching), and makes the
    // layer switch idempotent (safe to call on every navigateTo).
    proto.applyChatBackground = function () {
        const page = document.getElementById('chatPage');
        if (!page) return;
        const theme = this._chatBackground || 'aurora';
        const mode = this._chatBgMode || 'static';
        const switching = page.getAttribute('data-bg') && page.getAttribute('data-bg') !== theme;
        page.setAttribute('data-bg', theme);
        page.setAttribute('data-bg-mode', mode);
        if (switching) {
            page.classList.remove('bg-switching');
            void page.offsetWidth; // reflow so the fade-out can animate
            page.classList.add('bg-switching');
            setTimeout(() => page.classList.remove('bg-switching'), 520);
        }
    };

    wrap(proto, 'openChatSettings', function () {
        const body = document.getElementById('csBody');
        if (!body) return;
        const enabled = this._chatSoundEnabled !== false;
        const soundTheme = this._chatSoundTheme || 'romantic';
        const background = this._chatBackground || 'aurora';
        const bgMode = this._chatBgMode || 'static';
        // Phase 3.6 — premium theme registry. ids stay backward-compatible
        // (existing saved prefs keep resolving); display names + previews are
        // the original LoveHub packs. CSS paints each .bg-cell with a mini
        // version of its gradient so the picker shows real previews.
        const BG_THEMES = [
            ['romantic', '❤️', 'Romantic Velvet'], ['moonlight', '🌙', 'Midnight Love'],
            ['aurora', '✨', 'Aurora Dream'], ['stars', '🌌', 'Galaxy Couple'],
            ['ocean', '🌊', 'Ocean Calm'], ['soft', '🌸', 'Sakura Garden'],
            ['clouds', '☁️', 'Soft Clouds'], ['sunset', '🌅', 'Golden Sunset'],
            ['autumn', '🍂', 'Autumn Romance'], ['minimal', '🤍', 'Minimal Premium']
        ];
        // Idempotent render: settings can open many times.
        if (!body.querySelector('[data-cs-section="sounds"]')) {
            const soundsHtml = `
                <div class="cs-section" data-cs-section="sounds">
                    <div class="cs-section-title">Sounds</div>
                    <div class="cs-toggle">
                        <div><div class="lbl">Chat sounds</div><div class="sub">Soft send & receive chimes</div></div>
                        <button class="switch ${enabled ? 'on' : ''}" id="csSoundsSwitch"></button>
                    </div>
                    <div class="theme-grid">${['romantic', 'premium', 'night'].map((t) =>
                        `<button class="theme-cell ${t}${t === soundTheme ? ' active' : ''}" data-sound="${t}">${t[0].toUpperCase()}${t.slice(1)}</button>`).join('')}
                    </div>
                </div>`;
            const stats = body.querySelector('.cs-section:last-of-type');
            if (stats) stats.insertAdjacentHTML('beforebegin', soundsHtml);
            else body.insertAdjacentHTML('beforeend', soundsHtml);

            const switchEl = document.getElementById('csSoundsSwitch');
            if (switchEl) {
                switchEl.addEventListener('click', async () => {
                    this._chatSoundEnabled = !this._chatSoundEnabled;
                    switchEl.classList.toggle('on', this._chatSoundEnabled);
                    window.LoveHubSounds?.setEnabled(this._chatSoundEnabled);
                    const res = await window.LoveHubChat?.saveChatPreferences({ sounds_enabled: this._chatSoundEnabled });
                    if (!res?.success) this.showToast(res?.error || 'Could not save sound preference');
                });
            }
            body.querySelectorAll('[data-sound]').forEach((cell) => {
                cell.addEventListener('click', async () => {
                    this._chatSoundTheme = cell.dataset.sound;
                    window.LoveHubSounds?.setTheme(this._chatSoundTheme);
                    body.querySelectorAll('[data-sound]').forEach((c) => c.classList.toggle('active', c.dataset.sound === this._chatSoundTheme));
                    window.LoveHubSounds?.play('send');
                    const res = await window.LoveHubChat?.saveChatPreferences({ sound_theme: this._chatSoundTheme });
                    if (!res?.success) this.showToast(res?.error || 'Could not save sound theme');
                });
            });
        }
        if (!body.querySelector('[data-cs-section="background"]')) {
            const bgHtml = `
                <div class="cs-section" data-cs-section="background">
                    <div class="cs-section-title">Chat Background</div>
                    <div class="bg-grid">${BG_THEMES.map(([id, em, name]) =>
                        `<button class="bg-cell bg-${id}${id === background ? ' active' : ''}" data-bg="${id}" title="${name}"><span>${em}</span><small>${name}</small></button>`).join('')}
                    </div>
                    <div class="bg-modes">${['static', 'blur', 'animated'].map((m) =>
                        `<button class="bg-mode${m === bgMode ? ' active' : ''}" data-mode="${m}">${m[0].toUpperCase()}${m.slice(1)}</button>`).join('')}
                    </div>
                </div>`;
            body.insertAdjacentHTML('beforeend', bgHtml);
            body.querySelectorAll('[data-bg]').forEach((cell) => {
                cell.addEventListener('click', async () => {
                    this._chatBackground = cell.dataset.bg;
                    body.querySelectorAll('[data-bg]').forEach((c) => c.classList.toggle('active', c.dataset.bg === this._chatBackground));
                    this.applyChatBackground();
                    const res = await window.LoveHubChat?.saveChatPreferences({ background: this._chatBackground });
                    if (!res?.success) this.showToast(res?.error || 'Could not save background');
                });
            });
            body.querySelectorAll('[data-mode]').forEach((cell) => {
                cell.addEventListener('click', async () => {
                    this._chatBgMode = cell.dataset.mode;
                    body.querySelectorAll('[data-mode]').forEach((c) => c.classList.toggle('active', c.dataset.mode === this._chatBgMode));
                    this.applyChatBackground();
                    const res = await window.LoveHubChat?.saveChatPreferences({ background_mode: this._chatBgMode });
                    if (!res?.success) this.showToast(res?.error || 'Could not save background mode');
                });
            });
        }
    });

    // =====================================================================
    // setupRichChat — bind all Phase 3.2 UI (called from init)
    // =====================================================================

    proto.setupRichChat = function () {
        // Phase 3.5 — unlock WebAudio on the first user gesture (autoplay
        // policy), so receive chimes can play even when they arrive outside a
        // user interaction.
        const unlock = () => window.LoveHubSounds?.unlock();
        ['pointerdown', 'touchstart', 'keydown'].forEach((ev) => window.addEventListener(ev, unlock, { once: true, passive: true }));
        this.setupChatMedia();
        this.setupDrawSheet();
        this.setupStickerSheet();
        this.setupVoiceSheet();
        this.setupAiSheet();
        this.setupKeyboardInset();

        // Media preview + viewer bindings.
        const previewOverlay = document.getElementById('mediaPreviewOverlay');
        const previewClose = document.getElementById('mediaPreviewClose');
        const previewCancel = document.getElementById('mediaPreviewCancel');
        const previewSend = document.getElementById('mediaPreviewSend');
        if (previewClose) previewClose.addEventListener('click', () => this.closeMediaPreview());
        if (previewCancel) previewCancel.addEventListener('click', () => this.closeMediaPreview());
        if (previewSend) previewSend.addEventListener('click', () => this.sendPendingMedia());
        if (previewOverlay) previewOverlay.addEventListener('click', (e) => { if (e.target === previewOverlay) this.closeMediaPreview(); });

        const viewer = document.getElementById('mediaViewer');
        const viewerClose = document.getElementById('mediaViewerClose');
        if (viewerClose) viewerClose.addEventListener('click', () => viewer?.classList.remove('active'));
        if (viewer) viewer.addEventListener('click', (e) => { if (e.target === viewer) viewer.classList.remove('active'); });

        const uploadCancel = document.getElementById('chatUploadCancel');
        if (uploadCancel) uploadCancel.addEventListener('click', () => this.setUploadUi(false));
    };

    proto.setupKeyboardInset = function () {
        const vv = window.visualViewport;
        if (!vv) return;
        const update = () => {
            if (this.currentPage !== 'chat') return;
            const inset = Math.max(0, (window.innerHeight || 0) - vv.height);
            this.setChatKeyboardInset(inset > 80 ? inset : 0);
        };
        vv.addEventListener('resize', update);
        vv.addEventListener('scroll', update);
    };

    proto.setChatKeyboardInset = function (px) {
        document.documentElement.style.setProperty('--chat-kb', px ? px + 'px' : '0px');
    };

    // ---- media toolbar + uploads ----

    proto.setupChatMedia = function () {
        // '+' toggle: reveal / hide the media tool row (Phase 3.3 composer).
        const toggle = document.getElementById('chatMediaToggle');
        const mediaRow = document.getElementById('chatMediaRow');
        if (toggle && mediaRow) {
            toggle.addEventListener('click', () => {
                const open = mediaRow.style.display !== 'flex';
                mediaRow.style.display = open ? 'flex' : 'none';
                toggle.classList.toggle('active', open);
                toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
                if (open) window.LoveHubSounds?.play('send');
            });
        }
        document.querySelectorAll('.media-tool').forEach((btn) => {
            btn.addEventListener('click', () => {
                const kind = btn.dataset.media;
                if (!this.isRealUser() || this.currentCouple?.status !== 'active') {
                    this.showToast('Media messages need an active couple chat.');
                    return;
                }
                window.LoveHubSounds?.unlock();
                if (kind === 'image') document.getElementById('chatImageInput')?.click();
                else if (kind === 'camera') document.getElementById('chatCameraInput')?.click();
                else if (kind === 'video') document.getElementById('chatVideoInput')?.click();
                else if (kind === 'voice') this.openVoiceSheet();
                else if (kind === 'draw') this.openDrawSheet();
                else if (kind === 'sticker') this.openStickerSheet();
                else if (kind === 'gif') this.openStickerSheet('gif');
            });
        });
        const imageInput = document.getElementById('chatImageInput');
        if (imageInput) imageInput.addEventListener('change', (e) => this.prepareImageUpload(e.target));
        const cameraInput = document.getElementById('chatCameraInput');
        if (cameraInput) cameraInput.addEventListener('change', (e) => this.prepareImageUpload(e.target, true));
        const videoInput = document.getElementById('chatVideoInput');
        if (videoInput) videoInput.addEventListener('change', (e) => this.prepareVideoUpload(e.target));
    };

    proto.prepareImageUpload = async function (input, fromCamera) {
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        const blob = await this.compressImage(file);
        if (!blob) { this.showToast('Could not read image'); return; }
        this._mediaEdit = { rotate: 0, flipH: false, brightness: 0, text: '', contrast: 0, saturation: 0, blur: 0, emoji: '', strokes: [], draw: false, drawColor: '#ff5fa2', drawSize: 6 };
        this._pendingMedia = { kind: 'image', blob, name: file.name || (fromCamera ? 'camera.jpg' : 'photo.jpg'), size: blob.size, mime: blob.type || 'image/jpeg' };
        this.showMediaPreview(this._pendingMedia);
    };

    proto.compressImage = function (file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
                const img = new Image();
                img.onload = () => {
                    const MAX = 1600;
                    let { width, height } = img;
                    const scale = Math.min(1, MAX / Math.max(width, height));
                    width = Math.round(width * scale);
                    height = Math.round(height * scale);
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                    this._pendingMediaWidth = width;
                    this._pendingMediaHeight = height;
                    canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.82);
                };
                img.onerror = () => resolve(null);
                img.src = reader.result;
            };
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(file);
        });
    };

    proto.prepareVideoUpload = async function (input) {
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        const meta = await this.readVideoMeta(file);
        this._pendingMedia = {
            kind: 'video', blob: file, name: file.name, size: file.size,
            mime: file.type || 'video/mp4', duration: meta.duration || 0, poster: meta.poster || null
        };
        this.showMediaPreview(this._pendingMedia);
    };

    proto.readVideoMeta = function (file) {
        return new Promise((resolve) => {
            const url = URL.createObjectURL(file);
            const v = document.createElement('video');
            v.preload = 'metadata';
            v.muted = true;
            v.onloadedmetadata = () => {
                const duration = v.duration || 0;
                v.currentTime = Math.min(0.5, duration / 2 || 0);
                v.onseeked = () => {
                    try {
                        const canvas = document.createElement('canvas');
                        canvas.width = v.videoWidth || 640;
                        canvas.height = v.videoHeight || 360;
                        canvas.getContext('2d').drawImage(v, 0, 0);
                        canvas.toBlob((b) => resolve({ duration, poster: b }), 'image/jpeg', 0.7);
                    } catch (e) { resolve({ duration, poster: null }); }
                };
                v.onseeked();
            };
            v.onerror = () => resolve({ duration: 0, poster: null });
            v.src = url;
        });
    };

    proto.showMediaPreview = function (pending) {
        const overlay = document.getElementById('mediaPreviewOverlay');
        const stage = document.getElementById('mediaPreviewStage');
        const label = document.getElementById('mediaPreviewLabel');
        if (!overlay || !stage) return;
        const oldEdit = document.getElementById('mediaPreviewEdit');
        if (oldEdit) oldEdit.remove();
        const oldCtrl = document.getElementById('mediaPreviewControls');
        if (oldCtrl) oldCtrl.remove();
        stage.classList.remove('video-round');
        stage.innerHTML = '';
        this._mediaEdit = this._mediaEdit || { rotate: 0, flipH: false, brightness: 0, text: '', contrast: 0, saturation: 0, blur: 0, emoji: '', strokes: [], draw: false, drawColor: '#ff5fa2', drawSize: 6 };
        if (label) label.textContent = pending.kind === 'video' ? 'Video preview' : 'Photo preview';
        if (pending.kind === 'video') {
            // Telegram-style round preview: thumbnail + play overlay.
            stage.classList.add('video-round');
            const v = document.createElement('video');
            v.src = URL.createObjectURL(pending.blob);
            v.muted = true;
            v.playsInline = true;
            v.preload = 'metadata';
            stage.appendChild(v);
            const play = document.createElement('button');
            play.className = 'video-play-btn';
            play.innerHTML = '<svg class="icon-svg"><use href="#icon-play"/></svg>';
            stage.appendChild(play);
            const toggle = () => {
                if (v.paused) { v.play(); play.style.display = 'none'; }
                else { v.pause(); play.style.display = ''; }
            };
            play.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
            v.addEventListener('click', toggle);
            v.addEventListener('ended', () => { play.style.display = ''; });
            // Phase 3.5 — trim + mute before upload (baked into metadata so
            // bubbles and the fullscreen player replay the chosen clip).
            this._videoTrim = { start: 0, end: 0 };
            this._videoMuted = false;
            const durMax = Math.max(1, Math.floor(pending.duration || 0));
            const controls = document.createElement('div');
            controls.className = 'video-controls';
            controls.id = 'mediaPreviewControls';
            const stL = document.createElement('label');
            stL.className = 'vt-label';
            stL.innerHTML = '<span>Trim start</span><input type="range" class="vt-start" min="0" max="' + durMax + '" value="0">';
            const enL = document.createElement('label');
            enL.className = 'vt-label';
            enL.innerHTML = '<span>Trim end</span><input type="range" class="vt-end" min="0" max="' + durMax + '" value="' + durMax + '">';
            const muteL = document.createElement('label');
            muteL.className = 'vt-mute';
            muteL.innerHTML = '<input type="checkbox" class="vt-muted"> Mute video';
            const stIn = stL.querySelector('input');
            const enIn = enL.querySelector('input');
            const muteIn = muteL.querySelector('input');
            this._videoTrim.end = durMax;
            stIn.addEventListener('input', () => {
                this._videoTrim.start = Number(stIn.value);
                if (Number(enIn.value) <= Number(stIn.value)) enIn.value = Math.min(Number(enIn.max), Number(stIn.value) + 1);
                this._videoTrim.end = Number(enIn.value);
            });
            enIn.addEventListener('input', () => {
                this._videoTrim.end = Number(enIn.value);
                if (Number(stIn.value) >= Number(enIn.value)) stIn.value = Math.max(0, Number(enIn.value) - 1);
                this._videoTrim.start = Number(stIn.value);
            });
            muteIn.addEventListener('change', () => { this._videoMuted = muteIn.checked; });
            controls.appendChild(stL);
            controls.appendChild(enL);
            controls.appendChild(muteL);
            stage.parentElement.insertBefore(controls, stage);
        } else {
            this.renderPendingImagePreview(stage, pending);
            const edit = this.buildMediaEditor();
            stage.parentElement.insertBefore(edit, stage);
        }
        overlay.classList.add('active');
    };

    // ---- premium photo editor (Phase 3.3/3.5): rotate / flip / brightness /
    //      contrast / saturation / blur / caption / emoji / freehand draw ----

    proto.buildMediaEditor = function () {
        const ed = this._mediaEdit || (this._mediaEdit = { rotate: 0, flipH: false, brightness: 0, text: '', contrast: 0, saturation: 0, blur: 0, emoji: '', strokes: [], draw: false, drawColor: '#ff5fa2', drawSize: 6 });
        const box = document.createElement('div');
        box.id = 'mediaPreviewEdit';
        const toolbar = document.createElement('div');
        toolbar.className = 'media-edit-toolbar';
        const rerender = () => this.renderPendingImagePreview(document.getElementById('mediaPreviewStage'));
        const mkBtn = (label) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'media-edit-btn';
            b.innerHTML = label;
            return b;
        };
        const mkRange = (icon, min, max, set) => {
            const lab = document.createElement('label');
            lab.className = 'media-edit-brightness';
            lab.innerHTML = `<span>${icon}</span>`;
            const r = document.createElement('input');
            r.type = 'range';
            r.min = min;
            r.max = max;
            r.value = 0;
            r.addEventListener('input', () => { set(Number(r.value) / 100); rerender(); });
            lab.appendChild(r);
            return lab;
        };
        const rotate = mkBtn('⟳ Rotate');
        rotate.addEventListener('click', () => { ed.rotate += 90; rerender(); });
        const flip = mkBtn('⇋ Flip');
        flip.addEventListener('click', () => { ed.flipH = !ed.flipH; rerender(); });
        toolbar.appendChild(rotate);
        toolbar.appendChild(flip);
        toolbar.appendChild(mkRange('☀️', -60, 60, (v) => { ed.brightness = v; }));
        toolbar.appendChild(mkRange('◐', -60, 60, (v) => { ed.contrast = v; }));
        toolbar.appendChild(mkRange('🎨', -60, 60, (v) => { ed.saturation = v; }));
        toolbar.appendChild(mkRange('💧', 0, 40, (v) => { ed.blur = v; }));

        // Emoji stamp row.
        const emojiRow = document.createElement('div');
        emojiRow.className = 'media-emoji-row';
        ['❤️', '😂', '😍', '🥰', '👍', '😘', '🎉', '✨'].forEach((em) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'media-emoji' + (ed.emoji === em ? ' active' : '');
            b.textContent = em;
            b.addEventListener('click', () => {
                ed.emoji = ed.emoji === em ? '' : em;
                emojiRow.querySelectorAll('.media-emoji').forEach((x) => x.classList.toggle('active', x === b));
                rerender();
            });
            emojiRow.appendChild(b);
        });

        // Freehand draw: toggle + colours + clear.
        const drawRow = document.createElement('div');
        drawRow.className = 'media-draw-row';
        const drawToggle = mkBtn('✏️ Draw');
        drawToggle.classList.toggle('active', !!ed.draw);
        drawToggle.addEventListener('click', () => { ed.draw = !ed.draw; drawToggle.classList.toggle('active', ed.draw); });
        drawRow.appendChild(drawToggle);
        ['#ffffff', '#ff5fa2', '#7c4dff', '#ffd60a', '#101014'].forEach((c) => {
            const dot = document.createElement('button');
            dot.type = 'button';
            dot.className = 'media-draw-color' + (ed.drawColor === c ? ' active' : '');
            dot.style.background = c;
            dot.addEventListener('click', () => {
                ed.drawColor = c;
                drawRow.querySelectorAll('.media-draw-color').forEach((x) => x.classList.toggle('active', x === dot));
            });
            drawRow.appendChild(dot);
        });
        const clearDraw = mkBtn('🗑 Clear');
        clearDraw.addEventListener('click', () => { ed.strokes = []; rerender(); });
        drawRow.appendChild(clearDraw);

        const textbox = document.createElement('div');
        textbox.className = 'media-edit-textbox';
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Add a caption…';
        input.maxLength = 120;
        input.value = ed.text || '';
        input.addEventListener('input', () => { ed.text = input.value; rerender(); });
        textbox.appendChild(input);
        box.appendChild(toolbar);
        box.appendChild(emojiRow);
        box.appendChild(drawRow);
        box.appendChild(textbox);
        return box;
    };

    // Live canvas preview reflecting the current edit state (no blob round-trip).
    proto.renderPendingImagePreview = function (stage, pending) {
        pending = pending || this._pendingMedia;
        if (!stage || !pending) return;
        const ed = this._mediaEdit || {};
        stage.innerHTML = '';
        const canvas = document.createElement('canvas');
        stage.appendChild(canvas);
        const url = URL.createObjectURL(pending.blob);
        const img = new Image();
        img.onload = () => {
            let w = img.naturalWidth || img.width;
            let h = img.naturalHeight || img.height;
            const rot = ((ed.rotate || 0) % 360 + 360) % 360;
            if (rot === 90 || rot === 270) { const t = w; w = h; h = t; }
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.translate(w / 2, h / 2);
            ctx.rotate((rot * Math.PI) / 180);
            ctx.scale(ed.flipH ? -1 : 1, 1);
            const filt = 'brightness(' + (1 + (ed.brightness || 0)) + ')'
                + ' contrast(' + (1 + (ed.contrast || 0)) + ')'
                + ' saturate(' + (1 + (ed.saturation || 0)) + ')'
                + (ed.blur ? ' blur(' + ed.blur + 'px)' : '');
            ctx.filter = filt;
            ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2, img.naturalWidth, img.naturalHeight);
            ctx.filter = 'none';
            if (ed.text) {
                ctx.font = '600 22px Inter, system-ui, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
                ctx.shadowBlur = 10;
                ctx.fillStyle = '#fff';
                const lines = String(ed.text).split('\n');
                let y = h - 26;
                for (let i = lines.length - 1; i >= 0; i--) { ctx.fillText(lines[i], w / 2, y); y -= 30; }
            }
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            this.drawMediaDecor(ctx, w, h, ed);
            URL.revokeObjectURL(url);
            this.attachDrawEvents(canvas, ed);
        };
        img.onerror = () => URL.revokeObjectURL(url);
        img.src = url;
    };

    // Freehand strokes are kept in final (unrotated) canvas space — the same
    // space the uploaded JPEG uses — so preview and sent image always match.
    proto.attachDrawEvents = function (canvas, ed) {
        if (!ed.draw) return;
        let current = null;
        const toCanvas = (e) => {
            const rect = canvas.getBoundingClientRect();
            return [
                (e.clientX - rect.left) * (canvas.width / rect.width),
                (e.clientY - rect.top) * (canvas.height / rect.height)
            ];
        };
        canvas.style.touchAction = 'none';
        canvas.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            current = { color: ed.drawColor, size: ed.drawSize, points: [toCanvas(e)] };
            canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
        });
        canvas.addEventListener('pointermove', (e) => {
            if (!current) return;
            current.points.push(toCanvas(e));
            const ctx = canvas.getContext('2d');
            ctx.strokeStyle = current.color;
            ctx.lineWidth = current.size;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            const p = current.points;
            if (p.length >= 2) {
                ctx.beginPath();
                ctx.moveTo(p[p.length - 2][0], p[p.length - 2][1]);
                ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
                ctx.stroke();
            }
        });
        const end = () => {
            if (current) { ed.strokes.push(current); current = null; }
        };
        canvas.addEventListener('pointerup', end);
        canvas.addEventListener('pointercancel', end);
    };

    // Emoji stamp + saved strokes drawn in final canvas space.
    proto.drawMediaDecor = function (ctx, w, h, ed) {
        ed = ed || {};
        if (ed.emoji) {
            ctx.font = '64px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
            ctx.shadowBlur = 14;
            ctx.fillText(ed.emoji, w / 2, h * 0.32);
            ctx.shadowBlur = 0;
        }
        (ed.strokes || []).forEach((s) => {
            ctx.strokeStyle = s.color || '#ff5fa2';
            ctx.lineWidth = s.size || 6;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            (s.points || []).forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
            ctx.stroke();
        });
    };

    // Bake the edit state (filters / caption / emoji / strokes) into the
    // final JPEG that gets uploaded.
    proto.applyPendingImageEdits = function (pending) {
        const ed = this._mediaEdit || {};
        return new Promise((resolve) => {
            const url = URL.createObjectURL(pending.blob);
            const img = new Image();
            img.onload = () => {
                let w = img.naturalWidth || img.width;
                let h = img.naturalHeight || img.height;
                const rot = ((ed.rotate || 0) % 360 + 360) % 360;
                if (rot === 90 || rot === 270) { const t = w; w = h; h = t; }
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.translate(w / 2, h / 2);
                ctx.rotate((rot * Math.PI) / 180);
                ctx.scale(ed.flipH ? -1 : 1, 1);
                const filt = 'brightness(' + (1 + (ed.brightness || 0)) + ')'
                    + ' contrast(' + (1 + (ed.contrast || 0)) + ')'
                    + ' saturate(' + (1 + (ed.saturation || 0)) + ')'
                    + (ed.blur ? ' blur(' + ed.blur + 'px)' : '');
                ctx.filter = filt;
                ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2, img.naturalWidth, img.naturalHeight);
                ctx.filter = 'none';
                if (ed.text) {
                    ctx.font = '600 22px Inter, system-ui, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'bottom';
                    ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
                    ctx.shadowBlur = 10;
                    ctx.fillStyle = '#fff';
                    const lines = String(ed.text).split('\n');
                    let y = h - 26;
                    for (let i = lines.length - 1; i >= 0; i--) { ctx.fillText(lines[i], w / 2, y); y -= 30; }
                }
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                this.drawMediaDecor(ctx, w, h, ed);
                canvas.toBlob((b) => {
                    URL.revokeObjectURL(url);
                    if (b) { this._pendingMediaWidth = w; this._pendingMediaHeight = h; }
                    resolve(b ? { blob: b, width: w, height: h } : null);
                }, 'image/jpeg', 0.82);
            };
            img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
            img.src = url;
        });
    };

    proto.closeMediaPreview = function (silent) {
        const overlay = document.getElementById('mediaPreviewOverlay');
        if (overlay) overlay.classList.remove('active');
        const stage = document.getElementById('mediaPreviewStage');
        if (stage) stage.innerHTML = '';
        if (!silent) this._pendingMedia = null;
        this.setUploadUi(false);
    };

    proto.setUploadUi = function (show, label, pct) {
        const bar = document.getElementById('chatUploadProgress');
        const fill = document.getElementById('chatUploadFill');
        const lbl = document.getElementById('chatUploadLabel');
        const preview = document.getElementById('mediaPreviewProgress');
        const pfill = document.getElementById('mediaPreviewFill');
        if (bar) bar.style.display = show ? 'flex' : 'none';
        if (preview) preview.style.display = show && this._pendingMedia ? 'flex' : 'none';
        if (lbl && label) lbl.textContent = label;
        const v = pct || 0;
        if (fill) fill.style.width = v + '%';
        if (pfill) pfill.style.width = v + '%';
    };

    // Disable / re-enable the composer send button during media uploads, so a
    // user cannot fire a text message while media is being sent.
    proto.setComposerBusy = function (busy) {
        const btn = document.getElementById('sendBtn');
        const input = document.getElementById('chatInput');
        if (!btn) return;
        const hasText = !!input && input.value.trim().length > 0;
        btn.disabled = busy || !hasText;
        btn.classList.toggle('sending', !!busy);
    };

    proto.sendPendingMedia = async function () {
        const pending = this._pendingMedia;
        if (!pending || this._mediaBusy) return;
        const couple = this.currentCouple;
        if (!couple || couple.status !== 'active') { this.showToast('Chat not active'); return; }
        const isVideo = pending.kind === 'video';
        this._mediaBusy = true;
        this.setComposerBusy(true);
        try {
            let blob = pending.blob;
            let caption = null;
            if (!isVideo) {
                const edited = await this.applyPendingImageEdits(pending);
                if (edited) blob = edited.blob;
                caption = (this._mediaEdit?.text || '').trim() || null;
            }
            console.debug('[MEDIA_UPLOAD_START]', isVideo ? 'video' : 'image', blob.type || pending.mime, blob.size);
            this.setUploadUi(true, isVideo ? 'Uploading video…' : 'Uploading image…');
            const kind = isVideo ? 'videos' : 'images';
            // Phase 3.6 — one automatic retry on transient failure, then fall
            // back to the manual path (preview stays open → press Send again).
            let up = null;
            for (let attempt = 0; attempt < 2; attempt++) {
                up = await window.LoveHubChat?.uploadCoupleFile(couple.id, kind, blob, {
                    onProgress: (pct) => this.setUploadUi(true, null, pct)
                });
                if (up?.success) break;
                if (attempt === 0) console.debug('[MEDIA_UPLOAD_RETRY]', up?.error || 'Upload failed, retrying…');
            }
            if (!up?.success) {
                console.debug('[MEDIA_UPLOAD_ERROR]', up?.error || 'Upload failed');
                this.showToast(`Upload failed — ${up?.error || 'please try again'}`);
                return; // preview stays open → press Send to retry
            }
            console.debug('[MEDIA_UPLOAD_SUCCESS]', up.path);

            let thumbPath = null;
            if (isVideo && pending.poster) {
                const thumb = await window.LoveHubChat?.uploadCoupleFile(couple.id, 'images', pending.poster, {});
                if (thumb?.success) thumbPath = thumb.path;
            }

            console.debug('[MESSAGE_INSERT_START]', isVideo ? 'video' : 'image');
            const res = await window.LoveHubChat?.sendMediaMessage(couple.id, {
                type: isVideo ? 'video' : 'image',
                content: caption,
                mediaUrl: up.path,
                thumbnailUrl: thumbPath,
                fileSize: pending.size,
                duration: pending.duration || null,
                metadata: {
                    mime: pending.mime,
                    name: pending.name,
                    width: this._pendingMediaWidth || null,
                    height: this._pendingMediaHeight || null,
                    trim: isVideo && this._videoTrim ? { start: this._videoTrim.start, end: this._videoTrim.end } : null,
                    muted: isVideo ? !!this._videoMuted : null
                },
                replyToId: this._chatReplyTo?.id || null
            });
            if (!res?.success) {
                console.debug('[MESSAGE_INSERT_ERROR]', res?.error);
                this.showToast(`Could not send — ${res?.error || 'please try again'}`);
                return;
            }
            console.debug('[MESSAGE_INSERT_SUCCESS]', res.message?.id);
            this._pendingMedia = null;
            this._mediaEdit = null;
            this.closeMediaPreview();
            const msg = this.normalizeMessage(res.message);
            this._chatMessages = [...this._chatMessages, msg];
            this.appendMessageDom(msg);
        } catch (err) {
            console.debug('[MEDIA_UPLOAD_ERROR]', err && (err.message || err));
            this.showToast(`Upload failed — ${(err && err.message) || 'please try again'}`);
        } finally {
            this.setUploadUi(false);
            this.setComposerBusy(false);
            this._mediaBusy = false;
        }
    };

    // ---- drawing & handwritten ----

    proto.openDrawSheet = function () {
        const overlay = document.getElementById('drawOverlay');
        if (!overlay) return;
        this._draw = { strokes: [], redo: [], color: '#FF5FA2', size: 6, eraser: false, mode: 'draw' };
        const canvas = document.getElementById('drawCanvas');
        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
        this.setupDrawPalette();
        this.updateDrawMode();
        overlay.classList.add('active');
    };

    proto.setupDrawPalette = function () {
        const palette = document.getElementById('drawPalette');
        if (!palette || palette.dataset.built) return;
        palette.dataset.built = '1';
        ['#FFFFFF', '#FF5FA2', '#FF375F', '#BF5AF2', '#5E5CE6', '#FF9F0A', '#30D158', '#FFD60A'].forEach((c) => {
            const dot = document.createElement('button');
            dot.className = 'palette-dot' + (c === '#FF5FA2' ? ' active' : '');
            dot.style.background = c;
            dot.addEventListener('click', () => {
                if (!this._draw) return;
                this._draw.color = c;
                this._draw.eraser = false;
                palette.querySelectorAll('.palette-dot').forEach((d) => d.classList.toggle('active', d === dot));
            });
            palette.appendChild(dot);
        });
    };

    proto.updateDrawMode = function () {
        const d = this._draw;
        const drawBtn = document.getElementById('drawModeDraw');
        const writeBtn = document.getElementById('drawModeWrite');
        if (drawBtn) drawBtn.classList.toggle('active', !d || d.mode !== 'write');
        if (writeBtn) writeBtn.classList.toggle('active', !!d && d.mode === 'write');
        const title = document.getElementById('drawTitle');
        if (title) title.textContent = d && d.mode === 'write' ? 'Write a handwritten note' : 'Draw your love';
    };

    proto.setupDrawSheet = function () {
        const canvas = document.getElementById('drawCanvas');
        const overlay = document.getElementById('drawOverlay');
        if (!canvas || !overlay) return;
        const ctx = canvas.getContext('2d');
        const pos = (e) => {
            const rect = canvas.getBoundingClientRect();
            const pt = (e.touches && e.touches[0]) || e;
            return {
                x: (pt.clientX - rect.left) * (canvas.width / rect.width),
                y: (pt.clientY - rect.top) * (canvas.height / rect.height)
            };
        };
        let cur = null;
        canvas.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            if (!this._draw) return;
            this._draw.redo = [];
            this._draw.drawing = true;
            cur = {
                type: 'stroke',
                points: [pos(e)],
                color: this._draw.eraser ? '#101014' : this._draw.color,
                size: this._draw.eraser ? Math.max(this._draw.size * 3, 18) : this._draw.size
            };
            this._draw.strokes.push(cur);
            this.paintPoint(ctx, cur.points[0], cur);
        });
        canvas.addEventListener('pointermove', (e) => {
            if (!this._draw || !this._draw.drawing || !cur) return;
            e.preventDefault();
            const p = pos(e);
            cur.points.push(p);
            this.paintPoint(ctx, p, cur);
        });
        const end = () => { if (this._draw) this._draw.drawing = false; cur = null; };
        canvas.addEventListener('pointerup', end);
        canvas.addEventListener('pointerleave', end);

        const undo = document.getElementById('drawUndo');
        const redo = document.getElementById('drawRedo');
        const clearBtn = document.getElementById('drawClear');
        const eraser = document.getElementById('drawEraser');
        const heart = document.getElementById('drawHeart');
        const size = document.getElementById('drawSize');
        if (undo) undo.addEventListener('click', () => {
            if (!this._draw || !this._draw.strokes.length) return;
            this._draw.redo.push(this._draw.strokes.pop());
            this.redrawCanvas(ctx);
        });
        if (redo) redo.addEventListener('click', () => {
            if (!this._draw || !this._draw.redo.length) return;
            this._draw.strokes.push(this._draw.redo.pop());
            this.redrawCanvas(ctx);
        });
        if (clearBtn) clearBtn.addEventListener('click', () => {
            if (!this._draw) return;
            this._draw.strokes = [];
            this._draw.redo = [];
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        });
        if (eraser) eraser.addEventListener('click', () => { if (this._draw) this._draw.eraser = !this._draw.eraser; });
        if (heart) heart.addEventListener('click', () => {
            if (!this._draw) return;
            this._draw.strokes.push({
                type: 'heart',
                x: canvas.width / 2 + (Math.random() * 120 - 60),
                y: canvas.height / 2 + (Math.random() * 80 - 40),
                size: 40 + Math.random() * 40,
                color: this._draw.color
            });
            this.redrawCanvas(ctx);
        });
        if (size) size.addEventListener('input', (e) => { if (this._draw) this._draw.size = Number(e.target.value); });

        const modeDraw = document.getElementById('drawModeDraw');
        const modeWrite = document.getElementById('drawModeWrite');
        if (modeDraw) modeDraw.addEventListener('click', () => {
            if (!this._draw) return;
            this._draw.mode = 'draw';
            this._draw.color = '#FF5FA2';
            this._draw.eraser = false;
            if (size) size.value = 6;
            this._draw.size = 6;
            this.updateDrawMode();
        });
        if (modeWrite) modeWrite.addEventListener('click', () => {
            if (!this._draw) return;
            this._draw.mode = 'write';
            this._draw.color = '#FFFFFF';
            this._draw.eraser = false;
            if (size) size.value = 5;
            this._draw.size = 5;
            this.updateDrawMode();
        });

        const closeBtn = document.getElementById('drawClose');
        const cancel = document.getElementById('drawCancel');
        const send = document.getElementById('drawSend');
        if (closeBtn) closeBtn.addEventListener('click', () => overlay.classList.remove('active'));
        if (cancel) cancel.addEventListener('click', () => overlay.classList.remove('active'));
        if (send) send.addEventListener('click', () => this.sendDrawing());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('active'); });
    };

    proto.paintPoint = function (ctx, p, s) {
        ctx.strokeStyle = s.color;
        ctx.fillStyle = s.color;
        ctx.lineWidth = s.size;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (s.points.length === 1) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, s.size / 2, 0, Math.PI * 2);
            ctx.fill();
        } else {
            const prev = s.points[s.points.length - 2];
            ctx.beginPath();
            ctx.moveTo(prev.x, prev.y);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
        }
    };

    proto.redrawCanvas = function (ctx) {
        const canvas = document.getElementById('drawCanvas');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        (this._draw ? this._draw.strokes : []).forEach((s) => {
            ctx.strokeStyle = s.color || '#fff';
            ctx.fillStyle = s.color || '#fff';
            ctx.lineWidth = s.size || 6;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            if (s.type === 'heart') {
                this.drawHeartPath(ctx, s.x, s.y, s.size || 40, s.color || '#fff');
            } else if (s.points && s.points.length) {
                ctx.beginPath();
                ctx.moveTo(s.points[0].x, s.points[0].y);
                for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
                ctx.stroke();
                if (s.points.length === 1) {
                    ctx.beginPath();
                    ctx.arc(s.points[0].x, s.points[0].y, s.size / 2, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        });
    };

    proto.drawHeartPath = function (ctx, x, y, size, color) {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(size / 30, size / 30);
        ctx.beginPath();
        ctx.moveTo(0, 6);
        ctx.bezierCurveTo(0, 3, -3, 0, -6, 0);
        ctx.bezierCurveTo(-12, 0, -12, 8, -12, 8);
        ctx.bezierCurveTo(-12, 13, -7, 18, 0, 24);
        ctx.bezierCurveTo(7, 18, 12, 13, 12, 8);
        ctx.bezierCurveTo(12, 8, 12, 0, 6, 0);
        ctx.bezierCurveTo(3, 0, 0, 3, 0, 6);
        ctx.fill();
        ctx.restore();
    };

    proto.sendDrawing = async function () {
        const overlay = document.getElementById('drawOverlay');
        if (!this._draw || !this._draw.strokes.length) { this.showToast('Draw something first ❤️'); return; }
        const couple = this.currentCouple;
        if (!couple || couple.status !== 'active') { this.showToast('Chat not active'); return; }
        if (this._mediaBusy) return;
        this._mediaBusy = true;
        this.setComposerBusy(true);
        const mode = this._draw.mode === 'write' ? 'handwritten' : 'drawing';
        try {
            const canvas = document.getElementById('drawCanvas');
            const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
            if (!blob) { this.showToast('Could not export drawing'); return; }
            console.debug('[MEDIA_UPLOAD_START]', mode, blob.type || 'image/png', blob.size);
            this.setUploadUi(true, 'Saving drawing…');
            const up = await window.LoveHubChat?.uploadCoupleFile(couple.id, 'drawings', blob, {
                onProgress: (pct) => this.setUploadUi(true, null, pct)
            });
            if (!up?.success) {
                console.debug('[MEDIA_UPLOAD_ERROR]', up?.error || 'Upload failed');
                this.showToast(`Upload failed — ${up?.error || 'please try again'}`);
                return; // canvas stays open → press Send to retry
            }
            console.debug('[MEDIA_UPLOAD_SUCCESS]', up.path);

            console.debug('[MESSAGE_INSERT_START]', mode);
            const res = await window.LoveHubChat?.sendMediaMessage(couple.id, {
                type: mode,
                content: null,
                thumbnailUrl: up.path,
                metadata: { strokes: this._draw.strokes, mode, width: canvas.width, height: canvas.height },
                replyToId: this._chatReplyTo?.id || null
            });
            if (!res?.success) {
                console.debug('[MESSAGE_INSERT_ERROR]', res?.error);
                this.showToast(`Could not send — ${res?.error || 'please try again'}`);
                return;
            }
            console.debug('[MESSAGE_INSERT_SUCCESS]', res.message?.id);
            overlay?.classList.remove('active');
            const msg = this.normalizeMessage(res.message);
            this._chatMessages = [...this._chatMessages, msg];
            this.appendMessageDom(msg);
        } catch (err) {
            console.debug('[MEDIA_UPLOAD_ERROR]', err && (err.message || err));
            this.showToast(`Upload failed — ${(err && err.message) || 'please try again'}`);
        } finally {
            this.setUploadUi(false);
            this.setComposerBusy(false);
            this._mediaBusy = false;
        }
    };

    // ---- stickers ----

    proto.openStickerSheet = function (catId) {
        const overlay = document.getElementById('stickerOverlay');
        if (!overlay) return;
        this.renderStickerSheet(catId || 'love');
        overlay.classList.add('active');
    };

    // Built-in animated emoji GIFs — offline-first, CSS-animated, zero assets.
    proto._gifRegistry = function () {
        return [
            { id: 'gif-kiss', emoji: '💋💕', anim: 'heartbeat', label: 'Kiss' },
            { id: 'gif-hearteyes', emoji: '😍💘', anim: 'pulse', label: 'In love' },
            { id: 'gif-sparkle', emoji: '✨💖✨', anim: 'spin', label: 'Sparkles' },
            { id: 'gif-hug', emoji: '🤗💝', anim: 'squish', label: 'Hug' },
            { id: 'gif-cat', emoji: '😻💞', anim: 'wobble', label: 'Cat love' },
            { id: 'gif-couple', emoji: '💑', anim: 'float', label: 'Us' },
            { id: 'gif-kiss2', emoji: '💏', anim: 'pulse', label: 'Sweet kiss' },
            { id: 'gif-rose', emoji: '🌹💌', anim: 'float', label: 'Rose' },
            { id: 'gif-night', emoji: '🌙💫', anim: 'float', label: 'Goodnight' },
            { id: 'gif-cake', emoji: '🎂🎉', anim: 'bounce', label: 'Celebrate' },
            { id: 'gif-rainbow', emoji: '🌈💕', anim: 'sway', label: 'Rainbow' },
            { id: 'gif-thanks', emoji: '🥰🙏', anim: 'pulse', label: 'Thank you' }
        ];
    };

    proto.renderStickerSheet = function (catId) {
        const tabs = document.getElementById('stickerTabs');
        const grid = document.getElementById('stickerGrid');
        if (!tabs || !grid) return;
        tabs.innerHTML = '';
        (window.LoveHubStickerCategories || []).forEach((c) => {
            const b = document.createElement('button');
            b.textContent = `${c.emoji} ${c.label}`;
            b.className = c.id === catId ? 'active' : '';
            b.addEventListener('click', () => this.renderStickerSheet(c.id));
            tabs.appendChild(b);
        });
        const gifTab = document.createElement('button');
        gifTab.textContent = '🎞️ GIFs';
        gifTab.className = catId === 'gif' ? 'active' : '';
        gifTab.addEventListener('click', () => this.renderStickerSheet('gif'));
        tabs.appendChild(gifTab);

        grid.innerHTML = '';
        const items = catId === 'gif' ? this._gifRegistry() : (window.LoveHubStickers || []).filter((s) => s.cat === catId);
        if (!items.length) {
            const empty = document.createElement('div');
            empty.className = 'sticker-empty';
            empty.textContent = catId === 'gif' ? 'No GIFs here yet 💫' : 'No stickers in this pack yet';
            grid.appendChild(empty);
            return;
        }
        items.forEach((s) => {
            const cell = document.createElement('button');
            cell.className = catId === 'gif' ? 'gif-cell' : 'sticker-cell';
            cell.textContent = s.emoji;
            cell.title = s.label;
            cell.addEventListener('click', () => {
                if (catId === 'gif') this.sendGif(s.id);
                else this.sendSticker(s.id);
            });
            grid.appendChild(cell);
        });
    };

    proto.sendSticker = async function (stickerId) {
        const overlay = document.getElementById('stickerOverlay');
        overlay?.classList.remove('active');
        const couple = this.currentCouple;
        if (!couple || couple.status !== 'active') { this.showToast('Chat not active'); return; }
        const res = await window.LoveHubChat?.sendMediaMessage(couple.id, {
            type: 'sticker', content: stickerId, metadata: { sticker: stickerId }
        });
        if (!res?.success) { this.showToast(res?.error || 'Could not send'); return; }
        const msg = this.normalizeMessage(res.message);
        this._chatMessages = [...this._chatMessages, msg];
        this.appendMessageDom(msg);
    };

    proto.setupStickerSheet = function () {
        const overlay = document.getElementById('stickerOverlay');
        const closeBtn = document.getElementById('stickerClose');
        if (closeBtn) closeBtn.addEventListener('click', () => overlay?.classList.remove('active'));
        if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('active'); });
    };

    proto.sendGif = async function (gifId) {
        const overlay = document.getElementById('stickerOverlay');
        overlay?.classList.remove('active');
        const couple = this.currentCouple;
        if (!couple || couple.status !== 'active') { this.showToast('Chat not active'); return; }
        const res = await window.LoveHubChat?.sendMediaMessage(couple.id, {
            type: 'gif', content: gifId, metadata: { gif: gifId }
        });
        if (!res?.success) { this.showToast(res?.error || 'Could not send'); return; }
        const msg = this.normalizeMessage(res.message);
        this._chatMessages = [...this._chatMessages, msg];
        this.appendMessageDom(msg);
    };

    // ---- voice messages ----

    proto.openVoiceSheet = function () {
        const overlay = document.getElementById('voiceOverlay');
        if (!overlay) return;
        this._voice = { rec: null, chunks: [], stream: null, blob: null, url: null, duration: 0, playing: false, audio: null, rate: 1, wave: [], timer: null };
        const wave = document.getElementById('voiceWave');
        this.drawWave(wave.getContext('2d'), []);
        const timer = document.getElementById('voiceTimer');
        if (timer) timer.textContent = '0:00';
        document.getElementById('voiceRecord').style.display = '';
        document.getElementById('voiceStop').style.display = 'none';
        document.getElementById('voicePlay').style.display = 'none';
        document.getElementById('voiceSpeed').style.display = 'none';
        document.getElementById('voiceSend').style.display = 'none';
        overlay.classList.add('active');
    };

    proto.setupVoiceSheet = function () {
        const overlay = document.getElementById('voiceOverlay');
        const recBtn = document.getElementById('voiceRecord');
        const stopBtn = document.getElementById('voiceStop');
        const playBtn = document.getElementById('voicePlay');
        const speedBtn = document.getElementById('voiceSpeed');
        const sendBtn = document.getElementById('voiceSend');
        const cancelBtn = document.getElementById('voiceCancel');
        const closeBtn = document.getElementById('voiceClose');
        if (recBtn) recBtn.addEventListener('click', () => this.startVoiceRecording());
        if (stopBtn) stopBtn.addEventListener('click', () => this.stopVoiceRecording());
        if (playBtn) playBtn.addEventListener('click', () => this.toggleVoicePlayback());
        if (speedBtn) speedBtn.addEventListener('click', () => this.cycleVoiceSpeed());
        if (sendBtn) sendBtn.addEventListener('click', () => this.sendVoiceMessage());
        if (cancelBtn) cancelBtn.addEventListener('click', () => this.closeVoiceSheet());
        if (closeBtn) closeBtn.addEventListener('click', () => this.closeVoiceSheet());
        if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) this.closeVoiceSheet(); });
    };

    proto.closeVoiceSheet = function () {
        this.stopVoiceRecording();
        const overlay = document.getElementById('voiceOverlay');
        if (overlay) overlay.classList.remove('active');
        const v = this._voice;
        if (v && v.url) URL.revokeObjectURL(v.url);
        this._voice = null;
    };

    proto.startVoiceRecording = async function () {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            this.showToast('Voice recording is not supported in this browser');
            return;
        }
        if (!this._voice) this._voice = { rec: null, chunks: [], stream: null, blob: null, url: null, duration: 0, playing: false, audio: null, rate: 1, wave: [], timer: null };
        const v = this._voice;
        if (v.rec) return; // already recording
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mime = (typeof MediaRecorder !== 'undefined')
                ? (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
                    : MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
                    : 'audio/webm')
                : 'audio/webm';
            const rec = new MediaRecorder(stream, { mimeType: mime });
            v.mime = mime;
            v.rec = rec;
            v.stream = stream;
            v.chunks = [];
            rec.ondataavailable = (e) => { if (e.data.size) v.chunks.push(e.data); };
            rec.onstop = () => {
                const blob = new Blob(v.chunks, { type: v.mime || 'audio/webm' });
                v.blob = blob;
                if (v.url) URL.revokeObjectURL(v.url);
                v.url = URL.createObjectURL(blob);
                document.getElementById('voicePlay').style.display = '';
                document.getElementById('voiceSpeed').style.display = '';
                document.getElementById('voiceSend').style.display = '';
            };
            rec.start(250);
            document.getElementById('voiceRecord').style.display = 'none';
            document.getElementById('voiceStop').style.display = '';
            const t0 = Date.now();
            v.duration = 0;
            v.timer = setInterval(() => {
                v.duration = (Date.now() - t0) / 1000;
                const timer = document.getElementById('voiceTimer');
                if (timer) timer.textContent = this.formatDuration(v.duration);
                v.wave.push(Math.random() * 40 + 10);
                this.drawWave(document.getElementById('voiceWave').getContext('2d'), v.wave);
            }, 200);
        } catch (e) {
            this.showToast('Microphone unavailable — check permissions');
        }
    };

    proto.stopVoiceRecording = function () {
        const v = this._voice;
        if (!v || !v.rec) return;
        clearInterval(v.timer);
        v.rec.stop();
        if (v.stream) v.stream.getTracks().forEach((t) => t.stop());
        v.rec = null;
        document.getElementById('voiceRecord').style.display = 'none';
        document.getElementById('voiceStop').style.display = 'none';
    };

    proto.toggleVoicePlayback = function () {
        const v = this._voice;
        const btn = document.getElementById('voicePlay');
        if (!v || !v.url) return;
        if (v.playing) {
            if (v.audio) v.audio.pause();
            v.playing = false;
            btn.textContent = '▶';
            return;
        }
        if (!v.audio) {
            v.audio = new Audio(v.url);
            v.audio.playbackRate = v.rate;
            v.audio.onended = () => { v.playing = false; btn.textContent = '▶'; };
        }
        v.audio.play();
        v.playing = true;
        btn.textContent = '⏸';
    };

    proto.cycleVoiceSpeed = function () {
        const v = this._voice;
        if (!v) return;
        const rates = [1, 1.5, 2];
        v.rate = rates[(rates.indexOf(v.rate) + 1) % rates.length];
        const btn = document.getElementById('voiceSpeed');
        if (btn) btn.textContent = v.rate + 'x';
        if (v.audio) v.audio.playbackRate = v.rate;
    };

    proto.sendVoiceMessage = async function () {
        if (this._composerBusy) { this.showToast('Wait for the current upload to finish'); return; }
        const v = this._voice;
        if (!v || !v.blob) { this.showToast('Record a message first'); return; }
        const couple = this.currentCouple;
        if (!couple || couple.status !== 'active') { this.showToast('Chat not active'); return; }
        if (v.audio) v.audio.pause();
        const blob = v.blob;
        const duration = Math.round(v.duration || 0);
        this.setComposerBusy(true);
        this.setUploadUi(true, 'Uploading voice message…');
        try {
            console.debug('[MEDIA_UPLOAD_START]', 'audio', blob.size, blob.type || 'audio/webm');
            const up = await window.LoveHubChat?.uploadCoupleFile(couple.id, 'audio', blob, {
                onProgress: (pct) => this.setUploadUi(true, null, pct)
            });
            if (!up?.success) {
                console.error('[MEDIA_UPLOAD_FAIL]', up?.error || 'upload failed');
                this.closeVoiceSheet();
                this.showToast(up?.error || 'Upload failed');
                return;
            }
            console.debug('[MEDIA_UPLOAD_SUCCESS]', up.path);
            console.debug('[MESSAGE_INSERT_START]', 'voice');
            const res = await window.LoveHubChat?.sendMediaMessage(couple.id, {
                type: 'voice',
                mediaUrl: up.path,
                duration,
                fileSize: blob.size,
                metadata: { mime: blob.type || 'audio/webm' },
                replyToId: this._chatReplyTo?.id || null
            });
            if (!res?.success) {
                console.error('[MESSAGE_INSERT_FAIL]', res?.error || 'insert failed');
                this.closeVoiceSheet();
                this.showToast(res?.error || 'Could not send');
                return;
            }
            console.debug('[MESSAGE_INSERT_SUCCESS]', res.message?.id);
            const msg = this.normalizeMessage(res.message);
            this._chatMessages = [...this._chatMessages, msg];
            this.appendMessageDom(msg);
            this.scrollChatToBottom?.();
        } catch (err) {
            console.error('[MEDIA_UPLOAD_ERROR]', err);
            this.showToast('Upload failed — try again');
        } finally {
            this.closeVoiceSheet();
            this.setUploadUi(false);
            this.setComposerBusy(false);
        }
    };

    proto.drawWave = function (ctx, wave) {
        if (!ctx) return;
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.strokeStyle = 'rgba(124, 77, 255, 0.9)';
        ctx.lineWidth = 2;
        const step = ctx.canvas.width / 60;
        ctx.beginPath();
        wave.slice(-60).forEach((h, i) => {
            const x = i * step;
            const y = ctx.canvas.height / 2;
            ctx.moveTo(x, y - h / 2);
            ctx.lineTo(x, y + h / 2);
        });
        ctx.stroke();
    };

    // ---- Music Room entry (Phase 13) ----
    // LoveHub has ONE canonical playback engine: the global MusicPlayerService
    // (music-player.js) driven by the Music Room page (music-room.js). The
    // legacy procedural "LoveHub originals" WebAudio sheet was retired in
    // Phase 13 — opening Music from the home card / FAB now navigates to the
    // Music page, which connects to that same global player state and queue.

    proto.openMusicRoom = function () {
        const app = window.app;
        if (app && app.navigateTo) app.navigateTo('music');
    };

    // ---- AI Love Assistant (curated local generator, API-ready) ----

    proto.openAiSheet = function () {
        const overlay = document.getElementById('aiOverlay');
        if (!overlay) return;
        const chat = document.getElementById('aiChat');
        if (chat && !chat.children.length) {
            this.aiSay('bot', "Hi! I'm your LoveHub assistant 💜 Ask me for a love message, a date idea, or a gift suggestion for your partner.");
        }
        overlay.classList.add('active');
    };

    proto.setupAiSheet = function () {
        const overlay = document.getElementById('aiOverlay');
        const closeBtn = document.getElementById('aiClose');
        if (closeBtn) closeBtn.addEventListener('click', () => overlay?.classList.remove('active'));
        if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('active'); });
        const input = document.getElementById('aiInput');
        const send = document.getElementById('aiSend');
        const go = () => this.askAi(input ? input.value : '');
        if (send) send.addEventListener('click', go);
        if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        this.renderAiChips();
    };

    proto.renderAiChips = function () {
        const chips = document.getElementById('aiChips');
        if (!chips) return;
        const suggestions = ['Write a love message 💌', 'Date idea for tonight 🌙', 'Gift idea 🎁', 'Goodnight message 🌙'];
        chips.innerHTML = '';
        suggestions.forEach((s) => {
            const c = document.createElement('button');
            c.className = 'ai-chip';
            c.textContent = s;
            c.addEventListener('click', () => this.askAi(s));
            chips.appendChild(c);
        });
    };

    proto.askAi = async function (text) {
        const q = (text || '').trim();
        if (!q) return;
        const input = document.getElementById('aiInput');
        if (input) input.value = '';
        this.aiSay('user', q);
        this.aiSay('typing', '…');
        await new Promise((r) => setTimeout(r, 700 + Math.random() * 500));
        this.aiRemoveTyping();
        this.aiSay('bot', this.aiAnswer(q));
    };

    proto.aiAnswer = function (q) {
        const t = q.toLowerCase();
        if (/date|tonight|weekend|activity|something to do/.test(t)) {
            return this.aiPick([
                'How about a picnic at sunset with your favorite playlist? 🧺🌅\n\nOr a stargazing walk — bring a blanket and two cups of hot chocolate. 🌌',
                'Cook dinner together with a recipe neither of you has tried, then rate it 1–10. The losing chef does the dishes. 😄🍝',
                'Mini city tour: each of you picks 3 places you love, then swap — discover each other\'s spots. 🗺️'
            ]);
        }
        if (/gift|present|surprise/.test(t)) {
            return this.aiPick([
                'A handwritten letter + a small item that matches an inside joke you share. 💌 It\'s the thought that counts — literally. ✨',
                'Plan a "your day" — every hour is something your partner loves, from breakfast to a cozy movie night. 🎬',
                'A custom playlist of songs that remind you of them, with a note for each track. 🎧💜'
            ]);
        }
        if (/goodnight|night|sleep/.test(t)) {
            return this.aiPick([
                'Goodnight my love 🌙 — close your eyes and dream of us. I\'ll be there in the morning. ❤️',
                'Sleep well, my favorite person. The stars are jealous of you tonight. ✨🌙',
                'Goodnight gorgeous — I saved the last heartbeat of the day just for you. 💓'
            ]);
        }
        if (/miss|longing|away/.test(t)) {
            return this.aiPick([
                'I miss you in the small things — your laugh, your hand in mine, the way the world gets quieter when you\'re near. 💜',
                'Distance means so little when someone means so much. Counting the moments until you\'re back. ❤️',
                'Every song reminds me of you, and suddenly the whole world is our song. 🌍💕'
            ]);
        }
        if (/i love you|love you|i love|sweet/.test(t)) {
            return this.aiPick([
                '"I love you more than yesterday, but less than tomorrow." — a classic, but it\'s true. 💜',
                'You\'re my favorite hello and my hardest goodbye. ❤️',
                'If I could give you one thing, it\'d be the ability to see yourself through my eyes — you\'d know how loved you are. 💕'
            ]);
        }
        if (/apolog|sorry|fight|argu/.test(t)) {
            return this.aiPick([
                'A gentle note: "I\'m sorry for the words I didn\'t mean. You matter more than being right." ❤️',
                'Try: "Can we pause for a hug? I\'d rather fix this together than be right alone." 🤗',
                'Write: "Thank you for loving me even on my hard days. Let\'s talk — I\'m listening." 💜'
            ]);
        }
        if (/anniversary|birthday|special|celebrate/.test(t)) {
            return this.aiPick([
                'For a special day: a small album of your favorite memories + "here\'s to us and all the chapters still to come." 🎂💜',
                'Plan a "first date replay" — recreate where it all began, from the outfit to the venue. 💘',
                'Write them a "top 10 things I love about you" list and hide it somewhere they\'ll find it later. 🕵️💌'
            ]);
        }
        return this.aiPick([
            'Here\'s something from the heart: "You are my today and all of my tomorrows." 💜',
            'How about: "In a sea of people, my eyes always find you." 🌊💕',
            'Simple and strong: "Thank you for being my calm in a chaotic world." 🌿❤️',
            'Send this: "Home isn\'t a place — it\'s wherever you are." 🏡💜'
        ]);
    };

    proto.aiPick = function (arr) {
        return arr[Math.floor(Math.random() * arr.length)];
    };

    proto.aiSay = function (kind, text) {
        const chat = document.getElementById('aiChat');
        if (!chat) return null;
        const msg = document.createElement('div');
        msg.className = `ai-msg ${kind}`;
        msg.textContent = text;
        chat.appendChild(msg);
        chat.scrollTop = chat.scrollHeight;
        return msg;
    };

    proto.aiRemoveTyping = function () {
        const chat = document.getElementById('aiChat');
        const t = chat && chat.querySelector('.ai-msg.typing');
        if (t) t.remove();
    };

    // ---- shared sheet helpers ----

    proto.closeAllSheets = function () {
        ['drawOverlay', 'stickerOverlay', 'voiceOverlay', 'aiOverlay', 'mediaPreviewOverlay', 'mediaViewer'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.classList.remove('active');
        });
    };
})();
