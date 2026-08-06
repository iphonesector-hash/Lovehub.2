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
 *   - Music Room (procedural ambient originals) + AI Love Assistant sheets
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
        this.setupRichChat();
    });

    wrap(proto, 'navigateTo', function () {
        // Composer-overlap fix: hide the global FABs + mini player on the
        // chat page so they can never cover the composer or send button.
        document.body.classList.toggle('chat-open', this.currentPage === 'chat');
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
        this.stopMusic();
        this._pendingMedia = null;
        this._mediaUrlCache = {};
        this.setUploadUi(false);
    });

    wrap(proto, 'refreshCouple', function () {
        this.stopVoiceRecording();
        this.closeAllSheets();
        this.stopMusic();
        this._pendingMedia = null;
        this._mediaUrlCache = {};
    });

    wrap(proto, 'resetChatComposer', function () {
        this.setUploadUi(false);
        this.closeMediaPreview(true);
    });

    // =====================================================================
    // Sound preferences (loaded from chat_preferences)
    // =====================================================================

    wrap(proto, 'loadChat', function () {
        this._chatSoundEnabled = this._chatPrefs?.sounds_enabled !== false;
        this._chatSoundTheme = this._chatPrefs?.sound_theme || 'romantic';
        if (window.LoveHubSounds) {
            window.LoveHubSounds.setEnabled(this._chatSoundEnabled);
            window.LoveHubSounds.setTheme(this._chatSoundTheme);
        }
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

    proto.getSignedMediaUrl = async function (path) {
        if (!path) return null;
        if (this._mediaUrlCache[path]) return this._mediaUrlCache[path];
        const p = window.LoveHubChat ? window.LoveHubChat.getMediaUrl(path) : Promise.resolve(null);
        this._mediaUrlCache[path] = p.then((url) => url || null);
        return this._mediaUrlCache[path];
    };

    proto.formatDuration = function (sec) {
        const s = Math.max(0, Math.round(sec || 0));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };

    proto.buildMediaContent = function (msg) {
        switch (msg.message_type) {
            case 'image':
            case 'gif': return this.buildImageBubble(msg);
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
        img.loading = 'lazy';
        img.addEventListener('click', () => this.openMediaViewer(msg, 'image'));
        wrap.appendChild(img);
        this.getSignedMediaUrl(msg.media_url).then((url) => {
            if (url) img.src = url;
            else wrap.innerHTML = '<div class="msg-error-note" style="padding:10px">Media unavailable</div>';
        });
        return wrap;
    };

    proto.buildVideoBubble = function (msg) {
        const wrap = document.createElement('div');
        wrap.className = 'bubble-media';
        const video = document.createElement('video');
        video.controls = false;
        video.preload = 'metadata';
        video.playsInline = true;
        video.addEventListener('click', () => this.openMediaViewer(msg, 'video'));
        wrap.appendChild(video);
        if (msg.duration) {
            const badge = document.createElement('span');
            badge.className = 'media-dur';
            badge.textContent = this.formatDuration(msg.duration);
            wrap.appendChild(badge);
        }
        this.getSignedMediaUrl(msg.media_url).then((url) => { if (url) video.src = url; });
        this.getSignedMediaUrl(msg.thumbnail_url).then((url) => { if (url) video.poster = url; });
        return wrap;
    };

    proto.buildVoiceBubble = function (msg) {
        const wrap = document.createElement('div');
        wrap.className = 'bubble-voice';
        const btn = document.createElement('button');
        btn.className = 'voice-play-btn';
        btn.innerHTML = '<svg class="icon-svg"><use href="#icon-play"/></svg>';
        const bars = document.createElement('div');
        bars.className = 'voice-bars';
        for (let i = 0; i < 26; i++) {
            const b = document.createElement('i');
            b.style.height = (6 + Math.abs(Math.sin(i * 1.7)) * 18) + 'px';
            bars.appendChild(b);
        }
        const time = document.createElement('span');
        time.className = 'voice-time';
        time.textContent = msg.duration ? this.formatDuration(msg.duration) : '0:00';
        const speed = document.createElement('button');
        speed.className = 'voice-speed-btn';
        speed.textContent = '1x';
        wrap.appendChild(btn);
        wrap.appendChild(bars);
        wrap.appendChild(time);
        wrap.appendChild(speed);

        let audio = null;
        let playing = false;
        let rate = 1;
        const setBtn = (p) => {
            playing = p;
            btn.classList.toggle('playing', p);
            bars.classList.toggle('playing', p);
            btn.innerHTML = p
                ? '<svg class="icon-svg"><use href="#icon-pause"/></svg>'
                : '<svg class="icon-svg"><use href="#icon-play"/></svg>';
        };
        btn.addEventListener('click', () => {
            if (!audio) {
                this.getSignedMediaUrl(msg.media_url).then((url) => {
                    if (!url) { this.showToast('Voice message unavailable'); return; }
                    audio = new Audio(url);
                    audio.playbackRate = rate;
                    audio.onended = () => setBtn(false);
                    audio.onpause = () => setBtn(false);
                    audio.play();
                    setBtn(true);
                });
            } else if (playing) {
                audio.pause();
            } else {
                audio.play();
                setBtn(true);
            }
        });
        speed.addEventListener('click', () => {
            const rates = [1, 1.5, 2];
            rate = rates[(rates.indexOf(rate) + 1) % rates.length];
            speed.textContent = rate + 'x';
            if (audio) audio.playbackRate = rate;
        });
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
        if (kind === 'video') {
            const v = document.createElement('video');
            v.src = url;
            v.controls = true;
            v.autoplay = true;
            v.playsInline = true;
            stage.appendChild(v);
        } else {
            const img = document.createElement('img');
            img.src = url;
            stage.appendChild(img);
        }
        viewer.classList.add('active');
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
        if (msg.sender_id === this.currentUser?.id) window.LoveHubSounds?.play('send');
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

    wrap(proto, 'openChatSettings', function () {
        const body = document.getElementById('csBody');
        if (!body) return;
        const enabled = this._chatSoundEnabled !== false;
        const soundTheme = this._chatSoundTheme || 'romantic';
        const soundsHtml = `
            <div class="cs-section">
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
    });

    // =====================================================================
    // setupRichChat — bind all Phase 3.2 UI (called from init)
    // =====================================================================

    proto.setupRichChat = function () {
        this.setupChatMedia();
        this.setupDrawSheet();
        this.setupStickerSheet();
        this.setupVoiceSheet();
        this.setupMusicRoom();
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
        stage.innerHTML = '';
        if (label) label.textContent = pending.kind === 'video' ? 'Video preview' : 'Photo preview';
        if (pending.kind === 'video') {
            const v = document.createElement('video');
            v.src = URL.createObjectURL(pending.blob);
            v.controls = true;
            v.playsInline = true;
            stage.appendChild(v);
        } else {
            const img = document.createElement('img');
            img.src = URL.createObjectURL(pending.blob);
            stage.appendChild(img);
        }
        overlay.classList.add('active');
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

    proto.sendPendingMedia = async function () {
        const pending = this._pendingMedia;
        if (!pending) return;
        const couple = this.currentCouple;
        if (!couple || couple.status !== 'active') { this.showToast('Chat not active'); return; }
        this.setUploadUi(true, pending.kind === 'video' ? 'Uploading video…' : 'Uploading photo…');
        const kind = pending.kind === 'video' ? 'videos' : 'images';
        const up = await window.LoveHubChat?.uploadCoupleFile(couple.id, kind, pending.blob, {
            onProgress: (pct) => this.setUploadUi(true, null, pct)
        });
        if (!up?.success) {
            this.setUploadUi(false);
            this.showToast(up?.error || 'Upload failed');
            return;
        }
        let thumbPath = null;
        if (pending.kind === 'video' && pending.poster) {
            const thumb = await window.LoveHubChat?.uploadCoupleFile(couple.id, 'images', pending.poster, {});
            if (thumb?.success) thumbPath = thumb.path;
        }
        const res = await window.LoveHubChat?.sendMediaMessage(couple.id, {
            type: pending.kind === 'video' ? 'video' : 'image',
            mediaUrl: up.path,
            thumbnailUrl: thumbPath,
            fileSize: pending.size,
            duration: pending.duration || null,
            metadata: {
                mime: pending.mime,
                name: pending.name,
                width: this._pendingMediaWidth || null,
                height: this._pendingMediaHeight || null
            },
            replyToId: this._chatReplyTo?.id || null
        });
        this.setUploadUi(false);
        this.closeMediaPreview();
        this._pendingMedia = null;
        if (!res?.success) { this.showToast(res?.error || 'Could not send'); return; }
        const msg = this.normalizeMessage(res.message);
        this._chatMessages = [...this._chatMessages, msg];
        this.appendMessageDom(msg);
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
        const mode = this._draw.mode === 'write' ? 'handwritten' : 'drawing';
        const canvas = document.getElementById('drawCanvas');
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        let thumbPath = null;
        if (blob) {
            this.setUploadUi(true, 'Saving drawing…');
            const up = await window.LoveHubChat?.uploadCoupleFile(couple.id, 'drawings', blob, {});
            this.setUploadUi(false);
            if (up?.success) thumbPath = up.path;
        }
        const res = await window.LoveHubChat?.sendMediaMessage(couple.id, {
            type: mode,
            content: null,
            thumbnailUrl: thumbPath,
            metadata: { strokes: this._draw.strokes, mode, width: canvas.width, height: canvas.height },
            replyToId: this._chatReplyTo?.id || null
        });
        overlay?.classList.remove('active');
        if (!res?.success) { this.showToast(res?.error || 'Could not send'); return; }
        const msg = this.normalizeMessage(res.message);
        this._chatMessages = [...this._chatMessages, msg];
        this.appendMessageDom(msg);
    };

    // ---- stickers ----

    proto.openStickerSheet = function () {
        const overlay = document.getElementById('stickerOverlay');
        if (!overlay) return;
        this.renderStickerSheet('love');
        overlay.classList.add('active');
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
        grid.innerHTML = '';
        (window.LoveHubStickers || []).filter((s) => s.cat === catId).forEach((s) => {
            const cell = document.createElement('button');
            cell.className = 'sticker-cell';
            cell.textContent = s.emoji;
            cell.addEventListener('click', () => this.sendSticker(s.id));
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
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const rec = new MediaRecorder(stream);
            v.rec = rec;
            v.stream = stream;
            v.chunks = [];
            rec.ondataavailable = (e) => { if (e.data.size) v.chunks.push(e.data); };
            rec.onstop = () => {
                const blob = new Blob(v.chunks, { type: 'audio/webm' });
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
        const v = this._voice;
        const overlay = document.getElementById('voiceOverlay');
        if (!v || !v.blob) { this.showToast('Record a message first'); return; }
        const couple = this.currentCouple;
        if (!couple || couple.status !== 'active') { this.showToast('Chat not active'); return; }
        if (v.audio) v.audio.pause();
        this.setUploadUi(true, 'Uploading voice message…');
        const up = await window.LoveHubChat?.uploadCoupleFile(couple.id, 'audio', v.blob, {
            onProgress: (pct) => this.setUploadUi(true, null, pct)
        });
        this.setUploadUi(false);
        if (!up?.success) { this.showToast(up?.error || 'Upload failed'); return; }
        const res = await window.LoveHubChat?.sendMediaMessage(couple.id, {
            type: 'voice',
            mediaUrl: up.path,
            duration: Math.round(v.duration || 0),
            fileSize: v.blob.size,
            metadata: { mime: v.blob.type || 'audio/webm' },
            replyToId: this._chatReplyTo?.id || null
        });
        overlay?.classList.remove('active');
        if (!res?.success) { this.showToast(res?.error || 'Could not send'); return; }
        const msg = this.normalizeMessage(res.message);
        this._chatMessages = [...this._chatMessages, msg];
        this.appendMessageDom(msg);
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

    // ---- Music Room (procedural ambient originals) ----

    proto.openMusicRoom = function () {
        const overlay = document.getElementById('musicRoomOverlay');
        if (!overlay) return;
        if (!this._music) this._music = { index: 0, playing: false, nextTime: 0, beat: 0 };
        this.renderMusicList();
        this.updateMusicUI();
        overlay.classList.add('active');
    };

    proto.renderMusicList = function () {
        const list = document.getElementById('musicList');
        if (!list || list.dataset.built) return;
        list.dataset.built = '1';
        this._musicTracks().forEach((t, i) => {
            const item = document.createElement('div');
            item.className = 'music-item';
            item.innerHTML = `<span class="mi-emoji">${t.emoji}</span><span class="mi-name">${t.name}</span><span class="mi-dur">${this.formatDuration(t.duration)}</span>`;
            item.addEventListener('click', () => this.musicSelect(i));
            list.appendChild(item);
        });
    };

    proto._musicTracks = function () {
        return [
            { name: 'First Light', emoji: '🌅', tempo: 60, duration: 68, chords: [[261.63, 329.63, 392.0], [293.66, 349.23, 440.0], [220.0, 293.66, 349.23], [261.63, 329.63, 392.0]] },
            { name: 'Heartbeat', emoji: '💓', tempo: 72, duration: 52, chords: [[329.63, 415.3, 493.88], [349.23, 440.0, 523.25], [293.66, 369.99, 440.0], [329.63, 415.3, 493.88]] },
            { name: 'Moonlight', emoji: '🌙', tempo: 55, duration: 74, chords: [[220.0, 277.18, 329.63], [196.0, 246.94, 293.66], [174.61, 220.0, 261.63], [196.0, 246.94, 293.66]] },
            { name: 'Golden Hour', emoji: '🌇', tempo: 66, duration: 58, chords: [[293.66, 369.99, 440.0], [329.63, 415.3, 493.88], [261.63, 329.63, 392.0], [293.66, 369.99, 440.0]] },
            { name: 'Forever', emoji: '💍', tempo: 64, duration: 66, chords: [[329.63, 392.0, 493.88], [293.66, 369.99, 466.16], [349.23, 440.0, 523.25], [329.63, 392.0, 493.88]] }
        ];
    };

    proto.musicSelect = function (index, autoplay) {
        const wasPlaying = this._music ? this._music.playing : false;
        this.stopMusic();
        this._music = { index, playing: false, nextTime: 0, beat: 0 };
        this.updateMusicUI();
        if (autoplay !== false || wasPlaying) this.musicToggle();
    };

    proto.musicPrev = function () {
        if (!this._music) this._music = { index: 0, playing: false, nextTime: 0, beat: 0 };
        this.musicSelect((this._music.index - 1 + this._musicTracks().length) % this._musicTracks().length, true);
    };

    proto.musicNext = function () {
        if (!this._music) this._music = { index: 0, playing: false, nextTime: 0, beat: 0 };
        this.musicSelect((this._music.index + 1) % this._musicTracks().length, true);
    };

    proto.musicToggle = function () {
        if (!this._music) this._music = { index: 0, playing: false, nextTime: 0, beat: 0 };
        const m = this._music;
        m.playing = !m.playing;
        if (m.playing) {
            if (window.LoveHubSounds) window.LoveHubSounds.unlock();
            this.scheduleMusicLoop();
        } else {
            this.stopMusicScheduler();
        }
        this.updateMusicUI();
    };

    proto.scheduleMusicLoop = function () {
        const m = this._music;
        if (!m || !m.playing) return;
        const track = this._musicTracks()[m.index];
        const beatDur = 60 / track.tempo;
        const schedule = () => {
            if (!this._music || !this._music.playing) return;
            while (this._music.nextTime < performance.now() + 3000) {
                this.scheduleBeat(this._music, track, this._music.nextTime);
                this._music.nextTime += beatDur * 1000;
                this._music.beat += 1;
                if (this._music.beat * beatDur >= track.duration) {
                    this.musicNext();
                    return;
                }
            }
            this._musicTimer = setTimeout(schedule, 120);
        };
        if (!this._music.nextTime) this._music.nextTime = performance.now() + 300;
        schedule();
        clearInterval(this._musicFillTimer);
        this._musicFillTimer = setInterval(() => {
            const fill = document.getElementById('musicFill');
            if (fill && this._music) {
                fill.style.width = Math.min(100, ((this._music.beat * beatDur) / track.duration) * 100) + '%';
            }
        }, 250);
    };

    proto.scheduleBeat = function (m, track, when) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!this._musicCtx) this._musicCtx = new AC();
        const ctx = this._musicCtx;
        const t0 = ctx.currentTime + Math.max(0, (when - performance.now()) / 1000);
        const chord = track.chords[m.beat % track.chords.length];
        chord.forEach((f, i) => {
            const osc = ctx.createOscillator();
            osc.type = i === 0 ? 'triangle' : 'sine';
            osc.frequency.value = i === 0 ? f * 0.5 : f;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.exponentialRampToValueAtTime(i === 0 ? 0.07 : 0.045, t0 + 0.4);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.2);
            osc.connect(g);
            g.connect(ctx.destination);
            osc.start(t0);
            osc.stop(t0 + 2.4);
        });
        if (m.beat % track.chords.length === 0) {
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = chord[0] * 2;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.exponentialRampToValueAtTime(0.035, t0 + 0.05);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.4);
            osc.connect(g);
            g.connect(ctx.destination);
            osc.start(t0);
            osc.stop(t0 + 1.5);
        }
    };

    proto.stopMusicScheduler = function () {
        clearTimeout(this._musicTimer);
        clearInterval(this._musicFillTimer);
        this._musicTimer = null;
        this._musicFillTimer = null;
    };

    proto.stopMusic = function () {
        this.stopMusicScheduler();
        if (this._music) this._music.playing = false;
        const art = document.getElementById('musicArt');
        if (art) art.classList.remove('playing');
    };

    proto.updateMusicUI = function () {
        const m = this._music;
        if (!m) return;
        const track = this._musicTracks()[m.index];
        const title = document.getElementById('musicTitle');
        const artist = document.getElementById('musicArtist');
        const art = document.getElementById('musicArt');
        const playBtn = document.getElementById('musicPlay');
        if (title) title.textContent = track.name;
        if (artist) artist.textContent = `${track.emoji} LoveHub original · ${this.formatDuration(track.duration)}`;
        if (art) { art.textContent = track.emoji; art.classList.toggle('playing', !!m.playing); }
        if (playBtn) {
            playBtn.innerHTML = m.playing
                ? '<svg class="icon-svg" style="width:22px;height:22px"><use href="#icon-pause"/></svg>'
                : '<svg class="icon-svg" style="width:22px;height:22px"><use href="#icon-play"/></svg>';
        }
        document.querySelectorAll('.music-item').forEach((el, i) => el.classList.toggle('active', i === m.index));
        const fill = document.getElementById('musicFill');
        if (fill && !m.playing) fill.style.width = '0%';
    };

    proto.setupMusicRoom = function () {
        const overlay = document.getElementById('musicRoomOverlay');
        const closeBtn = document.getElementById('musicRoomClose');
        if (closeBtn) closeBtn.addEventListener('click', () => { this.stopMusic(); overlay?.classList.remove('active'); });
        if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) { this.stopMusic(); overlay.classList.remove('active'); } });
        const prev = document.getElementById('musicPrev');
        const next = document.getElementById('musicNext');
        const play = document.getElementById('musicPlay');
        if (prev) prev.addEventListener('click', () => this.musicPrev());
        if (next) next.addEventListener('click', () => this.musicNext());
        if (play) play.addEventListener('click', () => this.musicToggle());
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
        ['drawOverlay', 'stickerOverlay', 'voiceOverlay', 'musicRoomOverlay', 'aiOverlay', 'mediaPreviewOverlay', 'mediaViewer'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.classList.remove('active');
        });
    };
})();
