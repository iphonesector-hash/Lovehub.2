class LoveHub {
    constructor() {
        this.currentPage = 'home';
        this.currentUser = null;
        this.currentProfile = null;
        this.currentCouple = null;
        this.onboardingDismissed = false;
        this._authStateBusy = false;
        this._authStateQueued = false;
        this._authStateGeneration = 0;
        // Premium chat state (Phase 3.2)
        this._chatMessages = [];
        this._chatCoupleId = null;
        this._chatState = 'idle';
        this._chatChannel = null;
        this._chatReactions = {};
        this._chatTyping = false;
        this._chatTypingTimer = null;
        this._chatPartnerOnline = false;
        this._chatPartnerLastSeen = null;
        this._chatPartnerName = null;
        this._chatSearch = '';
        this._chatReplyTo = null;
        this._chatSending = false;
        this._chatPrefs = null;
        this._chatSharedBg = false;
        this._chatNotifPrefs = null;
        this._chatAtBottom = true;
        this.init();
    }

    async init() {
        try {
            // Supabase is authoritative whenever configured. Only a genuinely
            // absent backend may restore the legacy demo session.
            if (window.LoveHubAuth?.isReady()) {
                await window.LoveHubAuth.initialize();
                await this.loadAccountState();
            } else if (window.LoveHubInit?.status === 'missing-config') {
                this.currentUser = authService.getCurrentUser();
            }
            this.setupSplash();
            this.setupTheme();
            this.setupNavigation();
            this.setupChat();
            this.setupMemoryModal();
            this.setupLogin();
            this.setupOnboarding();
            this.setupRecovery();
            this.setupSettings();
            this.setupProfileEditing();
            this.setupAvatarUpload();
            this.setupDataManagement();
            this.setupInteractions();
            this.renderAll();
            
            // If logged in, show logged-in UI
            this.updateAuthUI();
            if (window.LoveHubMarkAppReady) window.LoveHubMarkAppReady(this);
            if (window.LoveHubPendingRecovery) {
                window.LoveHubPendingRecovery = false;
                this.openRecovery();
            } else if (this.currentUser) {
                this.checkOnboarding();
            }
        } catch (error) {
            console.error('Init error:', error);
            this.updateAuthUI();
        }
    }

    // Single entry point for all Supabase auth events. It serializes refreshes
    // so INITIAL_SESSION/SIGNED_IN cannot overwrite each other out of order.
    async handleSignedIn(session) {
        if (!window.LoveHubAuth?.isReady() || !session?.user) return;
        if (this._authStateBusy) {
            this._authStateQueued = true;
            return;
        }
        this._authStateBusy = true;
        const generation = this._authStateGeneration;
        const hadUser = !!this.currentUser;
        try {
            window.LoveHubAuth.setSession(session);
            await this.loadAccountState(session.user);
            // A slow profile/couple request must never restore a user after a
            // SIGNED_OUT event has already cleared the shell.
            if (generation !== this._authStateGeneration || !window.LoveHubAuth.session?.user) return;
            this.updateAuthUI();
            this.renderAll();
            if (!hadUser) this.showToast('Welcome back ❤️');
            this.onboardingDismissed = false;
            this.checkOnboarding();
        } finally {
            this._authStateBusy = false;
            if (this._authStateQueued) {
                this._authStateQueued = false;
                await this.handleSignedIn(window.LoveHubAuth.session);
            }
        }
    }

    async refreshAuthFromSupabase() {
        return this.handleSignedIn(window.LoveHubAuth?.session);
    }

    handleSignedOut() {
        // Invalidate any async account load that is still awaiting Supabase.
        this._authStateGeneration += 1;
        const hadState = !!(this.currentUser || this.currentProfile || this.currentCouple);
        this.currentUser = null;
        this.currentProfile = null;
        this.currentCouple = null;
        this.onboardingDismissed = false;
        authService.logout();
        window.LoveHubAuth?.setSession(null);
        window.LoveHubOnboarding?.close();
        // Drop every realtime chat channel and any cached conversation — a
        // signed-out user must never keep seeing (or receiving) couple chats.
        this.unsubscribeChat();
        this._chatCoupleId = null;
        this._chatMessages = [];
        this._chatReactions = {};
        this._chatState = 'idle';
        this._chatTyping = false;
        this._chatPartnerOnline = false;
        this._chatPartnerLastSeen = null;
        this._chatReplyTo = null;
        this._chatSearch = '';
        this._chatPrefs = null;
        this._chatSharedBg = false;
        this._chatNotifPrefs = null;
        this.closeChatSheets();
        this.resetChatComposer();
        // Never leave a protected page visible after the session ends.
        if (this.currentPage !== 'home') this.navigateTo('home');
        if (!hadState) {
            this.updateAuthUI();
            return;
        }
        this.updateAuthUI();
        this.renderAll();
    }

    // Phase 2: load the real account state (Supabase user + profile + couple).
    async loadAccountState(sbUser = null) {
        if (!window.LoveHubAuth?.isReady()) return;
        sbUser = sbUser || await window.LoveHubAuth.getUser();
        if (!sbUser) {
            this.currentUser = null;
            this.currentProfile = null;
            this.currentCouple = null;
            return;
        }
        let profile = await window.LoveHubProfile.getProfile(sbUser.id);
        if (!profile) {
            profile = await window.LoveHubProfile.ensureProfile(sbUser.id, {
                username: sbUser.user_metadata?.username || sbUser.email?.split('@')[0],
                displayName: sbUser.user_metadata?.display_name
            });
        }
        this.currentProfile = profile;
        this.currentUser = window.LoveHubProfile.toAppUser(profile, sbUser);
        if (window.LoveHubCouple) {
            this.currentCouple = await window.LoveHubCouple.getMyCouple();
        }
    }

    // Demo accounts (user1/user2) are the hidden dev fallback. Real users are
    // any other authenticated profile — they must not see demo data.
    isDemoUser() {
        const id = this.currentUser?.id;
        return id === 'user1' || id === 'user2';
    }

    isRealUser() {
        return !!this.currentUser && !this.isDemoUser();
    }

    getDaysTogether() {
        const start = this.currentCouple?.relationship_started_on;
        if (!start) return 0;
        const diff = Math.abs(new Date() - new Date(start + 'T00:00:00'));
        return Math.ceil(diff / (1000 * 60 * 60 * 24));
    }

    checkOnboarding() {
        if (!window.LoveHubOnboarding) return;
        if (!this.isRealUser()) return;
        if (this.onboardingDismissed) return;
        const profileComplete = !!this.currentProfile?.onboarding_completed;
        const hasCouple = !!this.currentCouple;
        if (!profileComplete) {
            window.LoveHubOnboarding.start({ step: 'profile' });
        } else if (!hasCouple) {
            window.LoveHubOnboarding.start({ step: 'couple-menu' });
        }
    }

    setupOnboarding() {
        const overlay = document.getElementById('onboardingOverlay');
        const skip = document.getElementById('onbSkip');
        if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) this.dismissOnboarding(); });
        if (skip) skip.addEventListener('click', () => this.dismissOnboarding());
    }

    dismissOnboarding() {
        this.onboardingDismissed = true;
        if (window.LoveHubOnboarding) window.LoveHubOnboarding.close();
        this.renderHome();
        this.renderProfile();
    }

    // Phase 2.1 — real backend diagnostics ---------------------------------

    // Human-readable reason when the Supabase backend is unavailable, or null.
    getBackendMessage() {
        const s = window.LoveHubInit;
        if (!s || s.status === 'ok') return null;
        if (s.status === 'missing-config') {
            return 'Demo mode only: supabase/config.js is missing (copy config.example.js → config.js) to enable real accounts.';
        }
        return s.reason || 'The Supabase backend failed to initialize.';
    }

    setupRecovery() {
        const overlay = document.getElementById('recoveryOverlay');
        const cancel = document.getElementById('recoveryCancel');
        const submit = document.getElementById('recoverySubmit');
        if (!overlay) return;
        if (cancel) cancel.addEventListener('click', () => this.closeRecovery());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) this.closeRecovery(); });
        if (submit) submit.addEventListener('click', () => this.submitRecovery());
    }

    // Shown when a PASSWORD_RECOVERY session is detected (user clicked the
    // "Forgot password" email link and landed back on the app).
    openRecovery() {
        const overlay = document.getElementById('recoveryOverlay');
        if (!overlay) return;
        const pw = document.getElementById('recoveryPassword');
        const conf = document.getElementById('recoveryConfirm');
        if (pw) pw.value = '';
        if (conf) conf.value = '';
        overlay.classList.add('active');
    }

    closeRecovery() {
        const overlay = document.getElementById('recoveryOverlay');
        if (overlay) overlay.classList.remove('active');
        this.stripRecoveryHash();
    }

    // Consume the recovery tokens in the URL so they don't re-trigger on reload.
    stripRecoveryHash() {
        try {
            if (window.location.hash) {
                history.replaceState(null, '', window.location.pathname + window.location.search);
            }
        } catch (e) { /* ignore */ }
    }

    async submitRecovery() {
        const pw = document.getElementById('recoveryPassword')?.value || '';
        const conf = document.getElementById('recoveryConfirm')?.value || '';
        if (pw.length < 6) { this.showToast('Password must be at least 6 characters'); return; }
        if (pw !== conf) { this.showToast('Passwords do not match'); return; }
        if (!window.LoveHubAuth?.isReady()) {
            this.showToast(this.getBackendMessage() || 'Backend unavailable');
            return;
        }

        const res = await window.LoveHubAuth.updatePassword(pw);
        if (!res.success) {
            this.showToast(res.error || 'Could not update password');
            return;
        }

        const signOutResult = await window.LoveHubAuth.signOut();
        if (!signOutResult.success) {
            this.showToast(`Password updated, but logout failed: ${signOutResult.error || 'please reload'}`);
            return;
        }
        this.showToast('Password updated — log in with your new password');
        this.closeRecovery();
        this.handleSignedOut();

        // Back to the login sheet, forced to login mode.
        const overlay = document.getElementById('loginOverlay');
        if (overlay) overlay.classList.add('active');
        if (this.resetLoginForgot) this.resetLoginForgot();
        if (this.setLoginMode) this.setLoginMode(false);
    }

    async refreshCouple() {
        if (!this.isRealUser() || !window.LoveHubCouple) return;
        this.currentCouple = await window.LoveHubCouple.getMyCouple();
        // Rebind chat to the (possibly new) couple: conversation + realtime.
        this.unsubscribeChat();
        this._chatCoupleId = null;
        this._chatMessages = [];
        this._chatReactions = {};
        this._chatState = 'idle';
        this._chatTyping = false;
        this._chatPartnerOnline = false;
        this._chatPartnerLastSeen = null;
        this._chatReplyTo = null;
        this._chatPrefs = null;
        this._chatSharedBg = false;
        this._chatNotifPrefs = null;
        this.resetChatComposer();
        this.renderAll();
    }

    setupSplash() {
        const splash = document.getElementById('splash');
        const logo = document.querySelector('.splash-logo');
        if (!splash || !logo) return;

        // Cinematic timing — Apple keynote style
        setTimeout(() => logo.classList.add('expand'), 2500);
        setTimeout(() => splash.classList.add('fade-out'), 3200);
        setTimeout(() => splash.style.display = 'none', 4400);
    }

    setupTheme() {
        const savedTheme = storage.get('theme') || 'night';
        this.applyTheme(savedTheme);
        
        document.querySelectorAll('.theme-option').forEach(option => {
            option.addEventListener('click', (e) => {
                const theme = e.currentTarget.dataset.theme;
                this.applyTheme(theme);
                storage.set('theme', theme);
                this.updateThemeOptions();
            });
        });
        this.updateThemeOptions();
    }

    applyTheme(theme) {
        const app = document.getElementById('app');
        if (app) app.className = `theme-${theme}`;
    }

    updateThemeOptions() {
        const currentTheme = storage.get('theme') || 'night';
        document.querySelectorAll('.theme-option').forEach(option => {
            option.classList.toggle('active', option.dataset.theme === currentTheme);
        });
    }

    setupNavigation() {
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => this.navigateTo(tab.dataset.tab));
        });
        document.querySelectorAll('[data-nav]').forEach(btn => {
            btn.addEventListener('click', () => this.navigateTo(btn.dataset.nav));
        });
    }

    navigateTo(pageName) {
        if (!this.currentUser && pageName !== 'home') {
            this.showToast('Please login to open this page');
            const loginOverlay = document.getElementById('loginOverlay');
            if (loginOverlay) loginOverlay.classList.add('active');
            return;
        }
        if (this.currentPage === pageName) return;

        // Update tabs immediately
        document.querySelectorAll('.tab').forEach(tab => 
            tab.classList.toggle('active', tab.dataset.tab === pageName));

        // Smooth page transition with spring animation
        const currentPageEl = document.querySelector('.page.active');
        const nextPageEl = document.querySelector(`.page[data-page="${pageName}"]`);

        if (currentPageEl && nextPageEl) {
            // Fade out current
            currentPageEl.style.opacity = '0';
            currentPageEl.style.transform = 'translateY(-10px)';

            setTimeout(() => {
                currentPageEl.classList.remove('active');
                currentPageEl.style.opacity = '';
                currentPageEl.style.transform = '';

                // Fade in next
                nextPageEl.classList.add('active');
                nextPageEl.style.opacity = '0';
                nextPageEl.style.transform = 'translateY(10px)';

                requestAnimationFrame(() => {
                    // IMPORTANT: do not leave a transform on the active page.
                    // Any non-"none" transform makes this page the containing
                    // block for its fixed descendants, so position:fixed
                    // elements (the .chat-bar composer) scroll with the page
                    // instead of the viewport and disappear once message
                    // history makes the page tall/scrollable. The stylesheet
                    // rule is .page.active { transform: none } — clearing the
                    // inline style lets the CSS transition to the final state.
                    nextPageEl.style.opacity = '1';
                    nextPageEl.style.transform = '';
                });
            }, 200);
        } else {
            // Fallback
            document.querySelectorAll('.page').forEach(page => 
                page.classList.toggle('active', page.dataset.page === pageName));
        }

        this.currentPage = pageName;

        // Opening the chat tab (re)renders, marks read and binds scroll.
        if (pageName === 'chat') {
            this.onChatPageOpened();
        }

        // Haptic feedback
        if (navigator.vibrate) navigator.vibrate(8);
    }

    renderAll() {
        this.renderHome();
        this.renderChat();
        this.renderLove();
        this.renderGames();
        this.renderMemories();
        this.renderTimeline();
        this.renderProfile();
        this.startECG();
    }

    // Realistic Medical ECG Animation (PQRST Waveform)
    startECG() {
        const path = document.querySelector('.ecg-path');
        if (!path) return;

        let offset = 0;
        let lastBeat = 0;
        let nextBeatInterval = 800 + Math.random() * 400;

        // Realistic PQRST complex generator
        const drawPQRST = (x, y, scale) => {
            // P wave (atrial depolarization)
            let d = `L${x} ${y} L${x+5} ${y-3*scale} L${x+10} ${y} `;
            // PR segment
            d += `L${x+15} ${y} `;
            // QRS complex (ventricular depolarization)
            d += `L${x+18} ${y+2*scale} L${x+22} ${y-25*scale} L${x+26} ${y+8*scale} L${x+30} ${y} `;
            // ST segment
            d += `L${x+40} ${y} `;
            // T wave (ventricular repolarization)
            d += `L${x+45} ${y-6*scale} L${x+55} ${y-10*scale} L${x+65} ${y} `;
            // Baseline (TP segment)
            d += `L${x+80} ${y} `;
            return { d, nextX: x + 80 };
        };

        const animate = (timestamp) => {
            if (!lastBeat) lastBeat = timestamp;
            const elapsed = timestamp - lastBeat;

            // Natural rhythm variation
            if (elapsed > nextBeatInterval) {
                lastBeat = timestamp;
                nextBeatInterval = 700 + Math.random() * 600;
            }

            const phase = elapsed / nextBeatInterval;
            let amplitude = 0;

            // Amplitude envelope — fades in/out around beat
            if (phase < 0.15) amplitude = 1 - (phase / 0.15);
            else if (phase > 0.85) amplitude = (phase - 0.85) / 0.15;

            // Occasional stronger beat (natural variation)
            if (Math.random() < 0.02) amplitude = Math.max(amplitude, 0.8);

            // Move right-to-left
            offset = (offset + 1) % 100;
            const width = 800;
            const baseline = 30;
            let d = `M${-offset} ${baseline}`;
            let curX = -offset;

            while (curX < width + 100) {
                const result = drawPQRST(curX, baseline, amplitude);
                d += result.d;
                curX = result.nextX;
            }

            path.setAttribute('d', d);
            requestAnimationFrame(animate);
        };

        requestAnimationFrame(animate);
    }

    renderHome() {
        const greeting = document.getElementById('greeting');
        if (greeting) {
            const hour = new Date().getHours();
            greeting.textContent = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
        }

        // Real users: days come from the confirmed couple start date, never a
        // hardcoded demo date. Seeded data is limited to the explicit demo
        // account; signed-out users see an empty state.
        const real = this.isRealUser();
        const demo = this.isDemoUser();
        const days = real
            ? this.getDaysTogether()
            : demo
                ? Math.ceil(Math.abs(new Date() - new Date('2023-01-01')) / (1000 * 60 * 60 * 24))
                : 0;
        this.animateValue('daysCounter', 0, days, 1500);

        const latestMemory = demo ? LoveHubData.memories[0] : null;
        if (latestMemory) {
            const imgEl = document.getElementById('latestMemoryImage');
            if (imgEl) {
                if (latestMemory.image) {
                    imgEl.style.backgroundImage = `url('${latestMemory.image}')`;
                    imgEl.style.backgroundSize = 'cover';
                    imgEl.style.backgroundPosition = 'center';
                } else {
                    imgEl.style.background = latestMemory.gradient;
                }
            }
            const dateEl = document.getElementById('latestMemoryDate');
            if (dateEl) dateEl.textContent = latestMemory.dateDisplay;
            const locationEl = document.getElementById('latestMemoryLocation');
            if (locationEl) locationEl.textContent = latestMemory.location;
            const quoteEl = document.getElementById('latestMemoryQuote');
            if (quoteEl) quoteEl.textContent = `"${latestMemory.notes}"`;
        } else {
            const imgEl = document.getElementById('latestMemoryImage');
            if (imgEl) imgEl.style.background = 'linear-gradient(135deg, rgba(255,63,95,0.12), rgba(94,92,230,0.12))';
            const dateEl = document.getElementById('latestMemoryDate');
            if (dateEl) dateEl.textContent = demo ? 'Your story starts here' : 'Log in to start your story';
            const locationEl = document.getElementById('latestMemoryLocation');
            if (locationEl) locationEl.textContent = '';
            const quoteEl = document.getElementById('latestMemoryQuote');
            if (quoteEl) quoteEl.textContent = real
                ? (this.currentCouple?.status === 'active' ? 'No memories yet — coming soon' : 'Finish your profile and find your partner')
                : 'Your private memories will appear here';
        }

        const memoriesCount = document.getElementById('memoriesCount');
        if (memoriesCount) memoriesCount.textContent = demo ? `${LoveHubData.memories.length} photos` : '0 photos';

        const relationshipStatus = document.getElementById('relationshipStatus');
        if (relationshipStatus) {
            relationshipStatus.textContent = demo
                ? 'In a relationship'
                : this.currentCouple?.status === 'active'
                    ? 'In a relationship'
                    : this.currentUser ? 'Find your partner' : 'Log in to begin';
        }

        this.updateAvatars();
    }

    updateAvatars() {
        const avatarP = document.getElementById('avatarP');
        const avatarS = document.getElementById('avatarS');

        // Real users: own avatar + confirmed partner's avatar. No fake couple.
        if (this.isRealUser()) {
            this.applyAvatar(avatarP, this.currentUser?.id, this.currentUser?.initial);
            this.applyAvatar(avatarS, this.currentCouple?.partner?.id, this.currentCouple?.partner?.display_name?.[0]?.toUpperCase());
            return;
        }

        if (!this.isDemoUser()) {
            this.applyAvatar(avatarP, null, this.currentUser ? this.currentUser.initial : '?');
            this.applyAvatar(avatarS, null, '?');
            return;
        }

        const pImg = userService.getAvatar('user1');
        const sImg = userService.getAvatar('user2');
        
        if (avatarP && pImg) {
            avatarP.style.backgroundImage = `url(${pImg.data})`;
            avatarP.style.backgroundSize = 'cover';
            avatarP.style.backgroundPosition = 'center';
            avatarP.childNodes[0].textContent = '';
        }
        if (avatarS && sImg) {
            avatarS.style.backgroundImage = `url(${sImg.data})`;
            avatarS.style.backgroundSize = 'cover';
            avatarS.style.backgroundPosition = 'center';
            avatarS.childNodes[0].textContent = '';
        }
    }

    applyAvatar(el, userId, fallbackInitial) {
        if (!el) return;
        el.style.backgroundImage = '';
        el.classList.remove('has-image');
        const img = userId ? userService.getAvatar(userId) : null;
        if (img && img.data) {
            el.style.backgroundImage = `url(${img.data})`;
            el.style.backgroundSize = 'cover';
            el.style.backgroundPosition = 'center';
            el.childNodes[0].textContent = '';
        } else {
            el.childNodes[0].textContent = fallbackInitial || '?';
        }
    }

    animateValue(id, start, end, duration) {
        const obj = document.getElementById(id);
        if (!obj) return;
        let startTimestamp = null;
        const step = (timestamp) => {
            if (!startTimestamp) startTimestamp = timestamp;
            const progress = Math.min((timestamp - startTimestamp) / duration, 1);
            obj.innerHTML = Math.floor(progress * (end - start) + start).toLocaleString();
            if (progress < 1) window.requestAnimationFrame(step);
        };
        window.requestAnimationFrame(step);
    }

    renderChat() {
        const conversation = document.getElementById('chatConversation');
        if (!conversation) return;
        conversation.innerHTML = '';

        // Real accounts use the Supabase-backed private couple chat.
        if (this.isRealUser()) {
            this.renderRealChat(conversation);
            return;
        }

        // Only the explicit legacy demo session may show seeded conversation.
        if (!this.isDemoUser()) {
            conversation.innerHTML = `<div class="chat-empty" style="text-align:center;color:var(--text-secondary);padding:60px 24px;font-size:15px;line-height:1.7">Log in to open your private couple chat.</div>`;
            conversation.scrollTop = 0;
            return;
        }
        
        const messages = storage.get('messages') || LoveHubData.messages;
        const messagesByDate = {};
        messages.forEach(msg => {
            const date = msg.timestamp.split('T')[0];
            if (!messagesByDate[date]) messagesByDate[date] = [];
            messagesByDate[date].push(msg);
        });

        Object.keys(messagesByDate).sort().forEach(date => {
            const dateDiv = document.createElement('div');
            dateDiv.className = 'chat-date';
            dateDiv.innerHTML = `<span>${new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</span>`;
            conversation.appendChild(dateDiv);

            messagesByDate[date].forEach(msg => {
                const bubble = document.createElement('div');
                bubble.className = `message-bubble ${msg.type}`;
                bubble.innerHTML = `<div class="bubble-content">${this.escapeHtml(msg.text)}</div><div class="bubble-time">${this.formatTime(msg.timestamp)}</div>`;
                conversation.appendChild(bubble);
            });
        });
        conversation.scrollTop = conversation.scrollHeight;
    }

    // Real users: premium Supabase-backed private couple chat --------------

    renderRealChat(conversation) {
        const couple = this.currentCouple;
        const empty = (html) => {
            conversation.innerHTML = `<div class="chat-empty" style="text-align:center;color:var(--text-secondary);padding:60px 24px;font-size:15px;line-height:1.7">${html}</div>`;
            conversation.scrollTop = 0;
        };

        if (!couple) {
            this.updateChatHeader('Messages', null);
            empty('Connect with your partner to start chatting.');
            return;
        }
        if (couple.status !== 'active') {
            this.updateChatHeader('Messages', null);
            empty('Your invite is still pending.<br>Chat unlocks when your partner accepts.');
            return;
        }

        this._chatPartnerName = couple.partner?.display_name || 'Your partner';
        this.updateChatHeader(this._chatPartnerName, this._chatPartnerOnline ? 'online' : 'lastSeen', this._chatPartnerLastSeen);
        this.applyChatBackground();

        // Load + subscribe once per couple id; re-render from cache after that.
        if (this._chatCoupleId !== couple.id) {
            this.unsubscribeChat();
            this._chatCoupleId = couple.id;
            this._chatMessages = [];
            this._chatReactions = {};
            this._chatState = 'loading';
            this.loadChat(couple.id);
        }

        if (this._chatState === 'loading') {
            empty('Loading your conversation…');
            return;
        }
        if (this._chatState === 'error') {
            empty('Could not load your messages.<br>Check your connection and try again.');
            return;
        }

        // Client-side search over the loaded conversation.
        const query = this._chatSearch.toLowerCase();
        const list = this._chatSearch
            ? this._chatMessages.filter((m) => (m.text || '').toLowerCase().includes(query))
            : this._chatMessages;

        if (!list.length) {
            empty(this._chatSearch ? 'No messages match your search.' : 'No messages yet.<br>Say something sweet ❤️');
            return;
        }

        const myUid = this.currentUser?.id;
        const byDate = {};
        list.forEach((msg) => {
            const date = (msg.timestamp || '').split('T')[0];
            if (!byDate[date]) byDate[date] = [];
            byDate[date].push(msg);
        });

        Object.keys(byDate).sort().forEach((date) => {
            const dateDiv = document.createElement('div');
            dateDiv.className = 'chat-date';
            dateDiv.innerHTML = `<span>${new Date(date + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</span>`;
            conversation.appendChild(dateDiv);

            byDate[date].forEach((msg) => {
                const bubble = this.buildBubbleSafely(msg, myUid);
                if (bubble) conversation.appendChild(bubble);
            });
        });
        conversation.scrollTop = conversation.scrollHeight;
        // The list uses scroll-behavior: smooth, so this scroll animates. Mark
        // the at-bottom state now instead of waiting for the animation's scroll
        // events — a send during the animation would otherwise see a stale
        // false flag and skip the reveal in appendMessageDom.
        this._chatAtBottom = true;
        this.debugComposer('after renderRealChat (messages in list)');
    }

    // One bubble element for a message row (real users).
    buildMessageBubble(msg, myUid) {
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

        // Content (or a deletion placeholder).
        const content = document.createElement('div');
        content.className = 'bubble-content';
        const shown = msg.deleted_at
            ? 'Message deleted'
            : this.isHiddenForMe(msg)
                ? 'You deleted this message'
                : (msg.text || '');
        content.appendChild(document.createTextNode(shown));
        if (msg.edited_at && !msg.deleted_at && !this.isHiddenForMe(msg)) {
            const edited = document.createElement('span');
            edited.className = 'bubble-edited';
            edited.textContent = 'edited';
            content.appendChild(edited);
        }
        frag.appendChild(content);

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
        if (mine && !this.isHiddenForMe(msg)) meta.appendChild(this.buildStatusTicks(msg));
        frag.appendChild(meta);

        bubble.appendChild(frag);
        return bubble;
    }

    buildStatusTicks(msg) {
        const status = document.createElement('span');
        status.className = 'bubble-status';
        if (msg._pending) {
            status.classList.add('sending');
            status.textContent = 'Sending…';
        } else if (msg.read_at) {
            status.classList.add('read');
            status.innerHTML = '<span class="tick">✓✓</span> Read';
            status.title = `Read at ${this.formatTime(msg.read_at)}`;
        } else if (msg.delivered_at) {
            status.classList.add('delivered');
            status.innerHTML = '<span class="tick">✓✓</span>';
        } else {
            status.classList.add('sent');
            status.innerHTML = '<span class="tick">✓</span>';
        }
        return status;
    }

    isHiddenForMe(msg) {
        return !!msg.deleted_for && msg.deleted_for.includes(this.currentUser?.id);
    }

    // Rebuild one bubble in place (receipts, edits, deletions, flags…).
    refreshMessageDom(msg) {
        const conversation = document.getElementById('chatConversation');
        if (!conversation || this.currentPage !== 'chat') return;
        const existing = conversation.querySelector(`.message-bubble[data-mid="${msg.id}"]`);
        if (!existing) return;
        // Phase 3.6 — isolated rebuild: one malformed message must never be
        // able to abort the chat layout / composer.
        const next = this.buildBubbleSafely(msg, this.currentUser?.id);
        if (!next) return;
        existing.replaceWith(next);
    }

    // Append one message preserving scroll position.
    appendMessageDom(msg) {
        const conversation = document.getElementById('chatConversation');
        if (!conversation || this.currentPage !== 'chat') return;
        if (this._chatSearch) { this.renderChat(); return; }

        // Safety: never duplicate a bubble. The send RPC resolves after the
        // row is already broadcast, so the sender's own realtime handler can
        // race the awaited send continuation and append the same message twice.
        if (msg.id && conversation.querySelector(`.message-bubble[data-mid="${msg.id}"]`)) return;

        // Live geometry check. The cached _chatAtBottom flag is only refreshed
        // by the list's scroll event, and can go stale exactly around a send:
        // the keyboard inset grows scrollHeight without firing a scroll event,
        // and the history smooth-scroll animates for ~300ms after render. A
        // stale false here is what pushed freshly sent messages below the fold.
        const atBottomNow = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 80;
        const wasAtBottom = atBottomNow || this._chatAtBottom;
        const isMine = msg.sender_id === this.currentUser?.id;

        const date = (msg.timestamp || '').split('T')[0];
        const wantDate = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        const lastDate = conversation.querySelector('.chat-date:last-of-type span')?.textContent || '';
        if (lastDate !== wantDate) {
            const dateDiv = document.createElement('div');
            dateDiv.className = 'chat-date';
            dateDiv.innerHTML = `<span>${wantDate}</span>`;
            conversation.appendChild(dateDiv);
        }
        // Phase 3.6 — isolated append: a single unrenderable message is
        // skipped and logged instead of breaking the whole conversation.
        const bubble = this.buildBubbleSafely(msg, this.currentUser?.id);
        if (!bubble) return;
        conversation.appendChild(bubble);

        // Reveal the newest message: always for a message the user just sent,
        // and for incoming ones only while they were reading the bottom. Use an
        // instant jump — the list's CSS smooth behavior can fight a moving
        // target right after an append and leave the message half-scrolled.
        if (isMine || wasAtBottom) {
            const prev = conversation.style.scrollBehavior;
            conversation.style.scrollBehavior = 'auto';
            conversation.scrollTop = conversation.scrollHeight;
            conversation.style.scrollBehavior = prev;
            this._chatAtBottom = true;
            const btn = document.getElementById('chatScrollBtn');
            if (btn) btn.style.display = 'none';
        }
    }

    onChatPageOpened() {
        this.renderChat();
        this.bindChatScroll();
        if (this.isRealUser() && this.currentCouple?.status === 'active' && window.LoveHubChat) {
            window.LoveHubChat.markAsRead(this.currentCouple.id);
        }
    }

    bindChatScroll() {
        const list = document.getElementById('chatConversation');
        const btn = document.getElementById('chatScrollBtn');
        if (!list || !btn) return;
        if (this._chatScrollHandler) list.removeEventListener('scroll', this._chatScrollHandler);
        const update = () => {
            const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
            this._chatAtBottom = atBottom;
            btn.style.display = atBottom ? 'none' : 'flex';
        };
        this._chatScrollHandler = update;
        list.addEventListener('scroll', update, { passive: true });
        btn.onclick = () => list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
        update();
    }

    // ---- composer safety + diagnostics ----

    // Diagnostic: confirm the composer shell is still in the DOM at key
    // moments of the chat lifecycle (before history loads, after fetch,
    // after render). A missing .chat-bar / #chatInput / #sendBtn here means
    // some code removed the composer — this log is how that is caught.
    debugComposer(label) {
        if (!window.LoveHubChat) return;
        const bar = document.querySelector('.chat-bar');
        const input = document.getElementById('chatInput');
        const send = document.getElementById('sendBtn');
        console.debug(`[LoveHub:composer] ${label} —`, {
            chatBarInDom: !!bar,
            chatInputInDom: !!input,
            sendBtnInDom: !!send,
            chatPageInDom: !!document.getElementById('chatPage'),
            inViewport: !!(input && bar &&
                (() => {
                    const r = input.getBoundingClientRect();
                    return r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight + 1;
                })())
        });
    }

    // Render one bubble defensively: a single malformed message (bad media
    // payload, missing fields, unexpected type) must NEVER abort the whole
    // history render — skip it, log it, and keep the composer intact.
    buildBubbleSafely(msg, myUid) {
        try {
            return this.buildMessageBubble(msg, myUid);
        } catch (err) {
            console.error('[LoveHub:chat] skipped unrenderable message', msg && msg.id, err);
            return null;
        }
    }

    // ---- load + realtime subscriptions ----

    async loadChat(coupleId) {
        const [convo, reactions, prefs, notifPrefs, coupleSettings] = await Promise.all([
            window.LoveHubChat?.getConversation(coupleId),
            window.LoveHubChat?.getReactions(coupleId),
            window.LoveHubChat?.getChatPreferences(),
            window.LoveHubChat?.getNotificationPreferences(),
            window.LoveHubChat?.getCoupleChatSettings(coupleId)
        ]);
        // A logout or couple switch may have happened while loading.
        if (this._chatCoupleId !== coupleId) return;
        if (!convo?.success) {
            this._chatState = 'error';
        } else {
            this._chatMessages = (convo.messages || []).map((m) => this.normalizeMessage(m));
            this._chatReactions = {};
            (reactions || []).forEach((r) => {
                if (!this._chatReactions[r.message_id]) this._chatReactions[r.message_id] = {};
                if (!this._chatReactions[r.message_id][r.emoji]) this._chatReactions[r.message_id][r.emoji] = [];
                this._chatReactions[r.message_id][r.emoji].push(r.profile_id);
            });
            // Personal prefs win; the couple-shared background is the fallback.
            this._chatPrefs = prefs || null;
            this._chatSharedBg = false;
            if (!prefs && coupleSettings) {
                this._chatPrefs = {
                    background_theme: coupleSettings.background_theme || 'dark',
                    background_color: coupleSettings.background_color || null
                };
                this._chatSharedBg = true;
            }
            this._chatNotifPrefs = notifPrefs || { messages_enabled: true, couple_requests_enabled: true, events_enabled: true };
            this._chatState = 'ready';
            this.subscribeChat(coupleId);
            window.LoveHubChat?.markAsRead(coupleId);
        }
        this.debugComposer('after history fetched, before render');
        this.renderChat();
        this.debugComposer('after renderChat (history rendered)');
    }

    normalizeMessage(m) {
        return {
            id: m.id,
            sender_id: m.sender_id,
            text: m.content,
            timestamp: m.created_at,
            message_type: m.message_type || 'text',
            media: m.media || null,
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
    }

    // Realtime: messages, receipts, reactions, typing, presence, notifications.
    subscribeChat(coupleId) {
        if (!window.LoveHubChat) return;

        // 1) Messages (INSERT + UPDATE).
        this._chatChannel = window.LoveHubChat.subscribeToMessages(coupleId, (row, isUpdate) => {
            if (this._chatCoupleId !== coupleId) return;
            if (isUpdate) {
                const idx = this._chatMessages.findIndex((m) => m.id === row.id);
                if (idx === -1) return;
                this._chatMessages[idx] = this.normalizeMessage(row);
                this.refreshMessageDom(this._chatMessages[idx]);
                return;
            }
            if (this._chatMessages.some((m) => m.id === row.id)) return;
            const msg = this.normalizeMessage(row);
            this._chatMessages = [...this._chatMessages, msg];
            this.appendMessageDom(msg);

            const isMine = msg.sender_id === this.currentUser?.id;
            if (!isMine) {
                // Receipts: delivered now, read while on the chat page.
                window.LoveHubChat.markDelivered(msg.id);
                if (this.currentPage === 'chat' && document.visibilityState === 'visible') {
                    window.LoveHubChat.markAsRead(coupleId);
                } else {
                    this.notifyNewMessage(msg);
                }
            }
        });

        // 2) Reactions.
        window.LoveHubChat.subscribeToReactions(coupleId, (row, isDelete) => {
            if (this._chatCoupleId !== coupleId) return;
            const map = this._chatReactions[row.message_id] || (this._chatReactions[row.message_id] = {});
            if (!map[row.emoji]) map[row.emoji] = [];
            if (isDelete) {
                map[row.emoji] = map[row.emoji].filter((id) => id !== row.profile_id);
                if (!map[row.emoji].length) delete map[row.emoji];
            } else if (!map[row.emoji].includes(row.profile_id)) {
                map[row.emoji].push(row.profile_id);
            }
            const target = this._chatMessages.find((m) => m.id === row.message_id);
            if (target) this.refreshMessageDom(target);
        });

        // 3) Typing indicator (partner only, broadcast — never stored).
        window.LoveHubChat.subscribeTyping(coupleId, (payload) => {
            if (payload.user_id === this.currentUser?.id) return;
            this._chatTyping = !!payload.typing;
            this.updateTypingIndicator();
        });

        // 4) Presence (partner online / last seen).
        window.LoveHubChat.trackPresence(coupleId, {
            onSync: (state) => {
                const partnerId = this.currentCouple?.partner?.id;
                const online = Object.values(state || {}).some((list) =>
                    (list || []).some((p) => p.user_id === partnerId));
                this._chatPartnerOnline = online;
                if (!online && this._chatPartnerLastSeen == null && this.currentCouple?.partner?.last_seen_at) {
                    this._chatPartnerLastSeen = this.currentCouple.partner.last_seen_at;
                }
                this.updateChatHeader(this._chatPartnerName || 'Your partner', online ? 'online' : 'lastSeen', this._chatPartnerLastSeen);
            },
            onLeave: (left) => {
                const partnerId = this.currentCouple?.partner?.id;
                if ((left || []).some((p) => p.user_id === partnerId)) {
                    this._chatPartnerOnline = false;
                    // Phase 3.5 — don't touch OUR OWN last_seen when the
                    // partner leaves; their record is updated in their browser.
                    this._chatPartnerLastSeen = new Date().toISOString();
                    this.updateChatHeader(this._chatPartnerName || 'Your partner', 'lastSeen', this._chatPartnerLastSeen);
                }
            }
        });

        // Phase 3.5 — re-render the header clock so "Last seen Xm ago" stays
        // accurate while the chat is open. (Own last_seen flushing already
        // happens in the app-wide visibilitychange/pagehide handler.)
        if (this._lastSeenTimer) clearInterval(this._lastSeenTimer);
        this._lastSeenTimer = setInterval(() => {
            if (this.currentPage === 'chat' && !this._chatPartnerOnline) {
                this.updateChatHeader(this._chatPartnerName || 'Your partner', 'lastSeen', this._chatPartnerLastSeen);
            }
        }, 30000);
    }

    unsubscribeChat() {
        window.LoveHubChat?.disconnectAll();
        this._chatChannel = null;
        this._chatTyping = false;
        this._chatPartnerOnline = false;
        if (this._lastSeenTimer) { clearInterval(this._lastSeenTimer); this._lastSeenTimer = null; }
        this.updateTypingIndicator();
    }

    // ---- header / typing / background / notifications ----

    updateChatHeader(name, state, lastSeen) {
        const titleEl = document.getElementById('chatTitle');
        const subEl = document.getElementById('chatSub');
        if (titleEl && name) titleEl.textContent = name;
        if (!subEl) return;
        if (!this.isRealUser() || !this.currentCouple || this.currentCouple.status !== 'active') {
            subEl.innerHTML = '';
            return;
        }
        if (state === 'online') {
            subEl.innerHTML = '<span class="presence-dot online"></span> Active now';
        } else if (lastSeen) {
            subEl.innerHTML = `<span class="presence-dot"></span> Last seen ${this.formatLastSeen(lastSeen)}`;
        } else {
            subEl.innerHTML = '<span class="presence-dot"></span> Offline';
        }
    }

    formatLastSeen(value) {
        if (!value) return 'recently';
        const mins = Math.floor(Math.max(0, Date.now() - new Date(value).getTime()) / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
        const days = Math.floor(hours / 24);
        return `${days} day${days === 1 ? '' : 's'} ago`;
    }

    updateTypingIndicator() {
        const el = document.getElementById('chatTyping');
        if (!el) return;
        if (this._chatTyping && this._chatPartnerName) {
            el.classList.add('show');
            el.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span> ${this.escapeHtml(this._chatPartnerName)} is typing…`;
        } else {
            el.classList.remove('show');
            el.innerHTML = '';
        }
    }

    applyChatBackground() {
        const page = document.getElementById('chatPage');
        if (!page) return;
        page.classList.remove('chat-bg-romantic', 'chat-bg-dark', 'chat-bg-minimal', 'chat-bg-sunset', 'chat-bg-hearts');
        page.style.background = '';
        const theme = this._chatPrefs?.background_theme || 'dark';
        const color = this._chatPrefs?.background_color || null;
        if (theme !== 'custom') {
            page.classList.add(`chat-bg-${theme}`);
        } else if (color) {
            page.style.background = `radial-gradient(circle at 20% 25%, ${color}33, transparent 55%), linear-gradient(160deg, #0b0b0f 0%, ${color}22 100%)`;
        }
    }

    notifyNewMessage(msg) {
        if (!window.LoveHubNotifications) return;
        if (this._chatNotifPrefs && this._chatNotifPrefs.messages_enabled === false) return;
        // Never notify while the user is actively looking at the chat.
        if (document.visibilityState === 'visible' && this.currentPage === 'chat') return;
        window.LoveHubNotifications.notify(this._chatPartnerName || 'New message', {
            body: (msg.text || '').slice(0, 120)
        });
    }

    setupChat() {
        const sendBtn = document.getElementById('sendBtn');
        const chatInput = document.getElementById('chatInput');
        const counter = document.getElementById('chatCounter');
        const searchBtn = document.getElementById('chatSearchBtn');
        const searchBar = document.getElementById('chatSearchBar');
        const searchInput = document.getElementById('chatSearchInput');
        const searchClose = document.getElementById('chatSearchClose');
        const settingsBtn = document.getElementById('chatSettingsBtn');
        const replyPreview = document.getElementById('chatReplyPreview');
        const list = document.getElementById('chatConversation');

        const updateComposer = () => {
            const len = chatInput.value.length;
            if (counter) {
                counter.textContent = len > 0 ? `${len}/4000` : '';
                counter.style.color = len > 3500 ? '#FF9F0A' : '';
            }
            sendBtn.disabled = !(len > 0) || this._chatSending;
            sendBtn.classList.toggle('sending', !!this._chatSending);
            // Auto-grow textarea (multi-line support).
            chatInput.style.height = 'auto';
            chatInput.style.height = Math.min(chatInput.scrollHeight, 110) + 'px';
            // Typing broadcast with idle timeout (real users, active couple).
            if (this.isRealUser() && this.currentCouple?.status === 'active') {
                if (len > 0 && !this._chatSending) {
                    window.LoveHubChat?.startTyping(this.currentCouple.id);
                    clearTimeout(this._chatTypingTimer);
                    this._chatTypingTimer = setTimeout(() => window.LoveHubChat?.stopTyping(this.currentCouple.id), 2500);
                } else {
                    clearTimeout(this._chatTypingTimer);
                    window.LoveHubChat?.stopTyping(this.currentCouple.id);
                }
            }
        };

        const clearComposer = () => {
            chatInput.value = '';
            this._chatReplyTo = null;
            if (replyPreview) replyPreview.style.display = 'none';
            updateComposer();
        };

        const sendMessage = async () => {
            const text = chatInput.value.trim();
            if (!text || this._chatSending) return;

            // Real accounts: RPC-backed send (RLS-scoped to their couple).
            if (this.isRealUser()) {
                const couple = this.currentCouple;
                if (!couple || couple.status !== 'active') {
                    this.showToast(couple ? 'Chat unlocks when your partner accepts your invite.' : 'Connect with your partner to start chatting.');
                    return;
                }
                this._chatSending = true;
                updateComposer();
                clearTimeout(this._chatTypingTimer);
                window.LoveHubChat?.stopTyping(couple.id);

                const res = await window.LoveHubChat?.sendMessage(couple.id, text, { replyToId: this._chatReplyTo?.id || null });
                this._chatSending = false;
                if (!res?.success) {
                    updateComposer();
                    this.showToast(res?.error || 'Could not send message');
                    return;
                }
                clearComposer();
                const msg = this.normalizeMessage(res.message);
                const idx = this._chatMessages.findIndex((m) => m._pending);
                if (idx !== -1) this._chatMessages[idx] = msg;
                else this._chatMessages = [...this._chatMessages, msg];
                this.appendMessageDom(msg);
                return;
            }

            if (!this.isDemoUser()) {
                this.showToast('Please login to chat.');
                return;
            }

            // Legacy demo path stays fully intact.
            const messages = storage.get('messages') || LoveHubData.messages;
            messages.push({
                id: Date.now().toString(),
                senderId: this.currentUser?.id || 'user1',
                text: text,
                timestamp: new Date().toISOString(),
                type: 'sent'
            });
            storage.set('messages', messages);
            clearComposer();
            this.renderChat();
            setTimeout(() => this.simulateReply(), 1500);
        };

        sendBtn.addEventListener('click', sendMessage);
        chatInput.addEventListener('input', updateComposer);
        // Enter = send, Shift + Enter = new line.
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // Reply preview close (delegated — content is dynamic).
        if (replyPreview) {
            replyPreview.addEventListener('click', (e) => {
                if (e.target.closest('button')) clearComposer();
            });
        }

        // Search.
        if (searchBtn) {
            searchBtn.addEventListener('click', () => {
                const show = searchBar.style.display === 'none';
                searchBar.style.display = show ? 'flex' : 'none';
                if (show) searchInput.focus(); else this.setChatSearch('');
            });
        }
        if (searchInput) searchInput.addEventListener('input', (e) => this.setChatSearch(e.target.value));
        if (searchClose) {
            searchClose.addEventListener('click', () => {
                searchBar.style.display = 'none';
                searchInput.value = '';
                this.setChatSearch('');
            });
        }

        // Chat settings sheet.
        if (settingsBtn) settingsBtn.addEventListener('click', () => this.openChatSettings());

        // Long-press / right-click on a bubble opens the message actions.
        if (list) {
            let holdTimer = null;
            list.addEventListener('pointerdown', (e) => {
                const bubble = e.target.closest('.message-bubble');
                if (!bubble) return;
                holdTimer = setTimeout(() => {
                    const msg = this._chatMessages.find((m) => m.id === bubble.dataset.mid);
                    if (msg) this.openMessageActions(msg);
                }, 500);
            });
            ['pointerup', 'pointerleave', 'pointercancel'].forEach((evt) =>
                list.addEventListener(evt, () => clearTimeout(holdTimer)));
            list.addEventListener('contextmenu', (e) => {
                const bubble = e.target.closest('.message-bubble');
                if (!bubble) return;
                e.preventDefault();
                const msg = this._chatMessages.find((m) => m.id === bubble.dataset.mid);
                if (msg) this.openMessageActions(msg);
            });
        }

        // Flush presence + typing when the app goes to the background.
        const flushPresence = () => {
            if (!this.isRealUser() || !this.currentCouple) return;
            window.LoveHubChat?.stopTyping(this.currentCouple.id);
            window.LoveHubChat?.untrackPresence();
            window.LoveHubChat?.touchLastSeen();
        };
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flushPresence();
        });
        window.addEventListener('pagehide', flushPresence);

        updateComposer();
    }

    // ---- composer helpers ----

    resetChatComposer() {
        const input = document.getElementById('chatInput');
        if (input) { input.value = ''; input.style.height = 'auto'; }
        const counter = document.getElementById('chatCounter');
        if (counter) counter.textContent = '';
        const reply = document.getElementById('chatReplyPreview');
        if (reply) reply.style.display = 'none';
        const btn = document.getElementById('sendBtn');
        if (btn) { btn.disabled = true; btn.classList.remove('sending'); }
        const searchInput = document.getElementById('chatSearchInput');
        if (searchInput) searchInput.value = '';
        const searchBar = document.getElementById('chatSearchBar');
        if (searchBar) searchBar.style.display = 'none';
        this._chatReplyTo = null;
        this._chatSending = false;
    }

    setReply(msg) {
        if (!this.isRealUser()) return;
        this._chatReplyTo = msg;
        const preview = document.getElementById('chatReplyPreview');
        if (!preview) return;
        const mine = msg.sender_id === this.currentUser?.id;
        const who = mine ? 'You' : (this._chatPartnerName || 'Partner');
        preview.style.display = 'flex';
        preview.innerHTML = `<span class="reply-who">${this.escapeHtml(who)}</span><span class="reply-text">${this.escapeHtml((msg.text || '').slice(0, 80))}</span><button><svg width="13" height="13" class="icon-svg"><use href="#icon-close"/></svg></button>`;
        document.getElementById('chatInput')?.focus();
    }

    setChatSearch(value) {
        this._chatSearch = (value || '').trim();
        this.renderChat();
    }

    // ---- message actions ----

    _ensureChatSheets() {
        if (document.getElementById('chatActionSheet')) return;

        const overlay = document.createElement('div');
        overlay.className = 'action-sheet-overlay';
        overlay.id = 'chatActionSheet';
        overlay.innerHTML = `<div class="action-sheet">
            <div class="action-sheet-head">
                <div class="as-title" id="asTitle">Message</div>
                <div class="as-sub" id="asSub"></div>
            </div>
            <div class="action-sheet-grid" id="asReactions"></div>
            <div id="asActions"></div>
            <button class="action-cancel" id="asCancel">Cancel</button>
        </div>`;
        overlay.addEventListener('click', (e) => { if (e.target === overlay) this.closeChatSheets(); });
        overlay.querySelector('#asCancel').addEventListener('click', () => this.closeChatSheets());
        document.body.appendChild(overlay);

        const settings = document.createElement('div');
        settings.className = 'chat-settings-overlay';
        settings.id = 'chatSettingsSheet';
        settings.innerHTML = `<div class="chat-settings-sheet">
            <h2>Chat Settings</h2>
            <div class="chat-settings-sub">Customize your private space</div>
            <div id="csBody"></div>
            <button class="cs-close" id="csClose">Done</button>
        </div>`;
        settings.addEventListener('click', (e) => { if (e.target === settings) this.closeChatSheets(); });
        settings.querySelector('#csClose').addEventListener('click', () => this.closeChatSheets());
        document.body.appendChild(settings);
    }

    closeChatSheets() {
        const a = document.getElementById('chatActionSheet');
        const s = document.getElementById('chatSettingsSheet');
        if (a) a.classList.remove('active');
        if (s) s.classList.remove('active');
    }

    openMessageActions(msg) {
        this._ensureChatSheets();
        const overlay = document.getElementById('chatActionSheet');
        const myUid = this.currentUser?.id;
        const mine = msg.sender_id === myUid;
        document.getElementById('asTitle').textContent = mine ? 'Your message' : `${this._chatPartnerName || 'Partner'}'s message`;
        document.getElementById('asSub').textContent = this.formatTime(msg.timestamp);

        const reactionsRow = document.getElementById('asReactions');
        reactionsRow.innerHTML = '';
        ['❤️', '😂', '😍', '🥰', '👍'].forEach((emoji) => {
            const btn = document.createElement('button');
            btn.className = 'react-quick';
            btn.textContent = emoji;
            btn.addEventListener('click', async () => {
                await this.toggleReaction(msg, emoji);
                this.closeChatSheets();
            });
            reactionsRow.appendChild(btn);
        });

        const actions = document.getElementById('asActions');
        actions.innerHTML = '';
        const addAction = (label, icon, fn, danger) => {
            const btn = document.createElement('button');
            btn.className = `action-item${danger ? ' danger' : ''}`;
            btn.innerHTML = `<svg class="icon-svg"><use href="#icon-${icon}"/></svg><span>${label}</span>`;
            btn.addEventListener('click', async () => { await fn(); this.closeChatSheets(); });
            actions.appendChild(btn);
        };

        const hidden = this.isHiddenForMe(msg) || !!msg.deleted_at;
        addAction('Reply', 'reply', () => this.setReply(msg));
        addAction(msg.pinned ? 'Unpin' : 'Pin', 'pin', () => this.toggleMessageFlag(msg, 'pinned'));
        addAction(msg.favorite ? 'Remove Favorite' : 'Favorite', 'star', () => this.toggleMessageFlag(msg, 'favorite'));
        addAction(msg.saved_to_memories ? 'Remove from Memories' : 'Save to Memories', 'bookmark', () => this.toggleMessageFlag(msg, 'saved_to_memories'));
        if (mine && !hidden) addAction('Edit', 'edit', () => this.startEditMessage(msg));
        if (!hidden) addAction('Delete for me', 'trash', () => this.deleteMessage(msg, 'me'), true);
        if (mine && !hidden) addAction('Delete for everyone', 'trash', () => this.deleteMessage(msg, 'everyone'), true);

        overlay.classList.add('active');
    }

    async toggleMessageFlag(msg, flag) {
        if (!window.LoveHubChat) return;
        const res = await window.LoveHubChat.toggleFlag(msg.id, flag);
        if (!res.success) { this.showToast(res.error || 'Could not update'); return; }
        const target = this._chatMessages.find((m) => m.id === msg.id);
        if (target) {
            target[flag] = !target[flag];
            this.refreshMessageDom(target);
            if (flag === 'saved_to_memories') this.showToast(target[flag] ? 'Saved to Memories ❤️' : 'Removed from Memories');
            else if (flag === 'pinned') this.showToast(target[flag] ? 'Message pinned 📌' : 'Message unpinned');
            else if (flag === 'favorite') this.showToast(target[flag] ? 'Added to favorites ⭐' : 'Removed from favorites');
        }
    }

    async toggleReaction(msg, emoji) {
        if (!window.LoveHubChat) return;
        const res = await window.LoveHubChat.react(msg.id, emoji);
        if (!res.success) { this.showToast(res.error || 'Could not react'); return; }
        // Patch locally for snappiness; the realtime channel keeps it in sync.
        const map = this._chatReactions[msg.id] || (this._chatReactions[msg.id] = {});
        if (!map[emoji]) map[emoji] = [];
        const me = this.currentUser?.id;
        if (res.added) { if (!map[emoji].includes(me)) map[emoji].push(me); }
        else map[emoji] = map[emoji].filter((id) => id !== me);
        if (!map[emoji].length) delete map[emoji];
        const target = this._chatMessages.find((m) => m.id === msg.id);
        if (target) this.refreshMessageDom(target);
    }

    async deleteMessage(msg, scope) {
        if (!window.LoveHubChat) return;
        if (scope === 'everyone' && !confirm('Delete this message for both of you? This cannot be undone.')) return;
        if (scope === 'me' && !confirm('Delete this message for you? Your partner will still see it.')) return;
        const res = scope === 'me'
            ? await window.LoveHubChat.deleteForMe(msg.id)
            : await window.LoveHubChat.deleteForEveryone(msg.id);
        if (!res.success) { this.showToast(res.error || 'Could not delete'); return; }
        const target = this._chatMessages.find((m) => m.id === msg.id);
        if (target) {
            if (scope === 'me') target.deleted_for = [...(target.deleted_for || []), this.currentUser?.id];
            else { target.deleted_at = new Date().toISOString(); target.text = null; }
            this.refreshMessageDom(target);
            this.showToast(scope === 'me' ? 'Message deleted for you' : 'Message deleted for everyone');
        }
    }

    startEditMessage(msg) {
        this._ensureChatSheets();
        const sheet = document.getElementById('chatActionSheet');
        if (sheet) sheet.classList.remove('active');
        const conversation = document.getElementById('chatConversation');
        const bubble = conversation?.querySelector(`.message-bubble[data-mid="${msg.id}"]`);
        if (!bubble) return;
        const content = bubble.querySelector('.bubble-content');
        if (!content) return;

        const box = document.createElement('div');
        box.className = 'bubble-edit-box';
        const area = document.createElement('textarea');
        area.value = msg.text || '';
        const row = document.createElement('div');
        row.className = 'row';
        const save = document.createElement('button');
        save.className = 'save';
        save.textContent = 'Save';
        const cancel = document.createElement('button');
        cancel.className = 'cancel';
        cancel.textContent = 'Cancel';
        row.appendChild(save);
        row.appendChild(cancel);
        box.appendChild(area);
        box.appendChild(row);
        content.replaceWith(box);
        area.focus();

        cancel.addEventListener('click', () => box.replaceWith(content));
        save.addEventListener('click', async () => {
            const res = await window.LoveHubChat?.editMessage(msg.id, area.value);
            if (!res?.success) { this.showToast(res?.error || 'Could not edit'); return; }
            const idx = this._chatMessages.findIndex((m) => m.id === msg.id);
            if (idx !== -1) {
                this._chatMessages[idx] = this.normalizeMessage(res.message);
                this.refreshMessageDom(this._chatMessages[idx]);
            }
            this.showToast('Message edited');
        });
    }

    // ---- chat settings sheet ----

    async openChatSettings() {
        this._ensureChatSheets();
        const sheet = document.getElementById('chatSettingsSheet');
        const body = document.getElementById('csBody');
        if (!body) return;

        const couple = this.currentCouple;
        const prefs = this._chatPrefs || { background_theme: 'dark', background_color: null };
        const notif = this._chatNotifPrefs || { messages_enabled: true, couple_requests_enabled: true, events_enabled: true };
        const perm = window.LoveHubNotifications?.permission() || 'unsupported';
        const theme = prefs.background_theme || 'dark';
        const color = prefs.background_color || '';
        const themes = ['romantic', 'dark', 'minimal', 'sunset', 'hearts', 'custom'];

        body.innerHTML = `
            <div class="cs-section">
                <div class="cs-section-title">Background</div>
                <div class="theme-grid">${themes.map((t) =>
                    `<button class="theme-cell ${t}${t === theme ? ' active' : ''}" data-theme="${t}">${t[0].toUpperCase()}${t.slice(1)}</button>`).join('')}
                </div>
                <div class="cs-color-row" style="${theme === 'custom' ? 'display:flex' : 'display:none'}">
                    <input type="color" id="csColorPicker" value="${color || '#FF375F'}">
                    <input type="text" id="csColorText" placeholder="#FF375F" value="${this.escapeHtml(color)}">
                </div>
                <div class="cs-note">Your personal choice. Toggle below to share the same background with your partner.</div>
            </div>
            <div class="cs-section">
                <div class="cs-toggle">
                    <div><div class="lbl">Share with partner</div><div class="sub">Both of you see the same background</div></div>
                    <button class="switch ${this._chatSharedBg ? 'on' : ''}" id="csSharedSwitch"></button>
                </div>
            </div>
            <div class="cs-section">
                <div class="cs-section-title">Notifications</div>
                <div class="cs-toggle">
                    <div><div class="lbl">New messages</div><div class="sub">Alert me about new messages</div></div>
                    <button class="switch ${notif.messages_enabled ? 'on' : ''}" data-pref="messages_enabled"></button>
                </div>
                <div class="cs-toggle">
                    <div><div class="lbl">Couple requests</div><div class="sub">Invites and join requests</div></div>
                    <button class="switch ${notif.couple_requests_enabled ? 'on' : ''}" data-pref="couple_requests_enabled"></button>
                </div>
                <div class="cs-toggle">
                    <div><div class="lbl">LoveHub events</div><div class="sub">Anniversaries and important moments</div></div>
                    <button class="switch ${notif.events_enabled ? 'on' : ''}" data-pref="events_enabled"></button>
                </div>
                ${perm === 'denied'
                    ? '<div class="permission-note">Notifications are blocked in your browser. Enable them in site settings.</div>'
                    : perm === 'unsupported'
                        ? '<div class="permission-note">This browser does not support notifications.</div>'
                        : `<button class="login-submit" id="csEnableNotifications" style="margin:0">${perm === 'granted' ? 'Notifications enabled ✓' : 'Enable notifications'}</button>`}
            </div>
            <div class="cs-section">
                <div class="cs-section-title">Chat statistics</div>
                <div class="cs-stats" id="csStats"><div class="cs-stat"><div class="v">…</div><div class="k">Loading</div></div></div>
                <div class="cs-note">Days together: <b>${this.getDaysTogether().toLocaleString()}</b></div>
            </div>
        `;

        // Theme picker.
        body.querySelectorAll('.theme-cell').forEach((cell) => {
            cell.addEventListener('click', async () => {
                const t = cell.dataset.theme;
                body.querySelector('.cs-color-row').style.display = t === 'custom' ? 'flex' : 'none';
                this._chatPrefs = { ...(this._chatPrefs || {}), background_theme: t };
                this.persistChatBackground(t, t === 'custom' ? this._chatPrefs.background_color || null : null);
                this.applyChatBackground();
                body.querySelectorAll('.theme-cell').forEach((c) => c.classList.toggle('active', c.dataset.theme === t));
            });
        });

        // Custom color.
        const colorPicker = body.querySelector('#csColorPicker');
        const colorText = body.querySelector('#csColorText');
        const applyColor = (v) => {
            if (!v) return;
            this._chatPrefs = { ...(this._chatPrefs || {}), background_theme: 'custom', background_color: v };
            this.persistChatBackground('custom', v);
            this.applyChatBackground();
        };
        if (colorPicker) colorPicker.addEventListener('input', (e) => applyColor(e.target.value));
        if (colorText) colorText.addEventListener('change', (e) => applyColor(e.target.value.trim()));

        // Share-with-partner toggle.
        const sharedSwitch = body.querySelector('#csSharedSwitch');
        if (sharedSwitch) {
            sharedSwitch.addEventListener('click', async () => {
                const next = !this._chatSharedBg;
                this._chatSharedBg = next;
                sharedSwitch.classList.toggle('on', next);
                if (next && couple) {
                    const res = await window.LoveHubChat?.saveCoupleChatSettings(couple.id, {
                        background_theme: this._chatPrefs?.background_theme || 'dark',
                        background_color: this._chatPrefs?.background_color || null
                    });
                    if (!res?.success) this.showToast(res?.error || 'Could not share background');
                }
            });
        }

        // Notification toggles.
        body.querySelectorAll('[data-pref]').forEach((sw) => {
            sw.addEventListener('click', async () => {
                const key = sw.dataset.pref;
                const next = !this._chatNotifPrefs[key];
                this._chatNotifPrefs = { ...(this._chatNotifPrefs || {}), [key]: next };
                sw.classList.toggle('on', next);
                const res = await window.LoveHubChat?.saveNotificationPreferences(this._chatNotifPrefs);
                if (!res?.success) this.showToast(res?.error || 'Could not save preference');
            });
        });

        // Permission flow (must be a user gesture).
        const enableBtn = body.querySelector('#csEnableNotifications');
        if (enableBtn) {
            enableBtn.addEventListener('click', async () => {
                const res = await window.LoveHubNotifications?.requestPermission();
                if (res?.success) {
                    this.showToast('Notifications enabled ❤️');
                    enableBtn.textContent = 'Notifications enabled ✓';
                } else if (res?.permission === 'denied') {
                    this.showToast('Notifications blocked — enable them in browser settings');
                } else {
                    this.showToast(res?.error || 'Could not enable notifications');
                }
            });
        }

        // Statistics.
        this.loadChatStats(body, couple?.id);

        sheet.classList.add('active');
    }

    async loadChatStats(body, coupleId) {
        const box = body.querySelector('#csStats');
        if (!box || !coupleId) return;
        const stats = await window.LoveHubChat?.getChatStats(coupleId);
        if (!stats) return;
        box.innerHTML = `
            <div class="cs-stat"><div class="v">${stats.sent.toLocaleString()}</div><div class="k">Sent</div></div>
            <div class="cs-stat"><div class="v">${stats.received.toLocaleString()}</div><div class="k">Received</div></div>
            <div class="cs-stat"><div class="v">${stats.topEmoji.length ? stats.topEmoji.join('') : '—'}</div><div class="k">Top emoji</div></div>`;
    }

    async persistChatBackground(theme, color) {
        const couple = this.currentCouple;
        const prefs = { background_theme: theme, background_color: color || null };
        const res = await window.LoveHubChat?.saveChatPreferences(prefs);
        if (res?.success) this._chatPrefs = { ...(this._chatPrefs || {}), ...prefs };
        if (this._chatSharedBg && couple) {
            await window.LoveHubChat?.saveCoupleChatSettings(couple.id, prefs);
        }
    }

    simulateReply() {
        // A delayed demo reply must not write after logout or run for real
        // accounts whose chat is not backed by Supabase yet.
        if (!this.isDemoUser()) return;
        const replies = ['Miss you too!', 'Can\'t wait!', 'Love you', 'See you soon!'];
        const messages = storage.get('messages') || [];
        messages.push({
            id: Date.now().toString(),
            senderId: 'user2',
            text: replies[Math.floor(Math.random() * replies.length)],
            timestamp: new Date().toISOString(),
            type: 'received'
        });
        storage.set('messages', messages);
        this.renderChat();
    }

    renderLove() {
        const loveStats = document.getElementById('loveStats');
        if (loveStats) {
            if (!this.isDemoUser()) {
                const days = this.getDaysTogether();
                const myId = this.currentUser?.id;
                const sentCount = myId ? this._chatMessages.filter((m) => m.sender_id === myId).length : 0;
                loveStats.innerHTML = `
                    <div class="love-stat-card glass-card">
                        <div class="stat-icon" style="color: var(--love-accent)"><svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg></div>
                        <div class="stat-value">${days.toLocaleString()}</div>
                        <div class="stat-label">Days Together</div>
                    </div>
                    <div class="love-stat-card glass-card">
                        <div class="stat-icon" style="color: var(--luxury-accent)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></div>
                        <div class="stat-value">${sentCount.toLocaleString()}</div>
                        <div class="stat-label">Messages Sent</div>
                    </div>
                `;
            } else {
                const days = Math.ceil(Math.abs(new Date() - new Date('2023-01-01')) / (1000 * 60 * 60 * 24));
                const messages = storage.get('messages') || LoveHubData.messages;
                loveStats.innerHTML = `
                    <div class="love-stat-card glass-card">
                        <div class="stat-icon" style="color: var(--love-accent)"><svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg></div>
                        <div class="stat-value">${days.toLocaleString()}</div>
                        <div class="stat-label">Days Together</div>
                    </div>
                    <div class="love-stat-card glass-card">
                        <div class="stat-icon" style="color: var(--luxury-accent)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></div>
                        <div class="stat-value">${messages.length}</div>
                        <div class="stat-label">Messages Sent</div>
                    </div>
                `;
            }
        }

        const letterEl = document.getElementById('loveLetterContent');
        const fromEl = document.getElementById('loveLetterFrom');
        const milestonesContainer = document.getElementById('loveMilestones');
        if (!this.isDemoUser()) {
            if (letterEl) letterEl.textContent = this.currentUser ? '"Write your first love letter here soon."' : 'Log in to write your first love letter.';
            if (fromEl) fromEl.textContent = '';
            if (milestonesContainer) {
                milestonesContainer.innerHTML = '<div class="glass-card" style="padding:20px;text-align:center;color:var(--text-secondary)">Milestones will appear here</div>';
            }
            return;
        }

        if (letterEl) letterEl.textContent = `"${LoveHubData.relationship.loveLetter}"`;
        if (fromEl) fromEl.textContent = `— ${LoveHubData.relationship.writtenBy}`;
        
        if (milestonesContainer) {
            milestonesContainer.innerHTML = '';
            LoveHubData.milestones.forEach(m => {
                const item = document.createElement('div');
                item.className = 'milestone-item glass-card';
                item.innerHTML = `<div class="milestone-icon" style="color: var(--love-accent)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><circle cx="12" cy="12" r="10"></circle></svg></div><div class="milestone-info"><div class="milestone-title">${m.title}</div><div class="milestone-date">${m.dateDisplay}</div></div>`;
                milestonesContainer.appendChild(item);
            });
        }
    }

    renderGames() {
        const gamesGrid = document.getElementById('gamesGrid');
        if (!gamesGrid) return;
        gamesGrid.innerHTML = '';
        const demo = this.isDemoUser();
        
        LoveHubData.games.forEach(game => {
            const card = document.createElement('div');
            card.className = 'game-card glass-card';
            card.innerHTML = `
                <div class="game-cover ${game.cover}">${game.coverContent}</div>
                <div class="game-info-section">
                    <div class="game-title">${game.name}</div>
                    <div class="game-desc">${game.description}</div>
                    <div class="game-meta">
                        ${demo
                            ? `<span class="game-rating">★ ${game.rating}</span><span class="game-wins"> ${game.wins} wins</span>`
                            : '<span class="game-rating">Play together — coming soon</span>'}
                    </div>
                    ${demo ? `<div class="game-last">Last played: ${game.lastPlayed}</div>` : ''}
                </div>
                <button class="play-btn" data-game-id="${game.id}">▶ Play</button>
            `;
            card.querySelector('.play-btn').addEventListener('click', () => {
                this.showToast(`Starting ${game.name}... (Coming Soon)`);
            });
            gamesGrid.appendChild(card);
        });
    }

    renderMemories() {
        const memoriesGrid = document.getElementById('memoriesGrid');
        if (!memoriesGrid) return;
        memoriesGrid.innerHTML = '';
        if (!this.isDemoUser()) {
            memoriesGrid.innerHTML = `<div class="glass-card" style="grid-column:1/-1;padding:26px;text-align:center;color:var(--text-secondary);font-size:14px;line-height:1.7">${this.currentUser ? 'No memories yet.<br>Your shared photo memories will live here.' : 'Log in to create private memories.'}</div>`;
            return;
        }
        
        LoveHubData.memories.forEach(memory => {
            const item = document.createElement('div');
            item.className = 'mem-item';
            let bgStyle = memory.image ? 
                `background-image: url('${memory.image}'); background-size: cover; background-position: center;` : 
                `background: ${memory.gradient};`;
            const dateParts = memory.dateDisplay.split(' ');
            item.innerHTML = `<div class="mem-thumb" style="${bgStyle}"><div class="mem-overlay"><span class="mem-date">${dateParts[1]} ${dateParts[2]?.replace(',', '') || ''}</span></div></div>`;
            item.addEventListener('click', () => this.openMemoryDetail(memory.id));
            memoriesGrid.appendChild(item);
        });
    }

    setupMemoryModal() {
        const modal = document.getElementById('memoryModal');
        document.getElementById('closeMemoryModal').addEventListener('click', () => modal.classList.remove('active'));
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('active'); });
    }

    openMemoryDetail(memoryId) {
        const memory = LoveHubData.memories.find(m => m.id === memoryId);
        if (!memory) return;
        
        const modal = document.getElementById('memoryModal');
        const imgEl = document.getElementById('modalImage');
        if (imgEl) {
            if (memory.image) {
                imgEl.style.backgroundImage = `url('${memory.image}')`;
                imgEl.style.backgroundSize = 'cover';
                imgEl.style.backgroundPosition = 'center';
            } else {
                imgEl.style.background = memory.gradient;
            }
        }
        
        document.getElementById('modalDate').textContent = memory.dateDisplay;
        document.querySelector('#modalLocation span').textContent = memory.location;
        document.querySelector('#modalMusic span').textContent = memory.music;
        document.querySelector('#modalNotes span').textContent = memory.notes;
        
        const commentList = document.getElementById('commentList');
        commentList.innerHTML = '';
        if (memory.comments.length === 0) {
            commentList.innerHTML = '<div class="comment">No comments yet</div>';
        } else {
            memory.comments.forEach(c => {
                const div = document.createElement('div');
                div.className = 'comment';
                div.innerHTML = `<strong>${c.author}:</strong> ${c.text}`;
                commentList.appendChild(div);
            });
        }
        modal.classList.add('active');
    }

    renderTimeline() {
        const timelineContainer = document.getElementById('timelineList');
        if (!timelineContainer) return;
        if (!this.isDemoUser()) {
            timelineContainer.innerHTML = `<div class="glass-card" style="padding:26px;text-align:center;color:var(--text-secondary);font-size:14px">${this.currentUser ? 'Your timeline will grow here as you create memories together.' : 'Log in to view your private timeline.'}</div>`;
            return;
        }
        timelineContainer.innerHTML = '';
        
        const timelineItems = [
            ...LoveHubData.memories.map(m => ({ date: m.date, dateDisplay: m.dateDisplay, title: m.location, desc: m.notes })),
            ...LoveHubData.milestones.map(m => ({ date: m.date, dateDisplay: m.dateDisplay, title: m.title, desc: '' }))
        ];
        timelineItems.sort((a, b) => new Date(b.date) - new Date(a.date));
        
        timelineItems.forEach(item => {
            const el = document.createElement('div');
            el.className = 'timeline-item';
            el.innerHTML = `<div class="timeline-dot"></div><div class="timeline-card glass-card"><div class="timeline-date">${item.dateDisplay}</div><div class="timeline-title">${item.title}</div><div class="timeline-desc">${item.desc}</div></div>`;
            timelineContainer.appendChild(el);
        });
    }

    renderProfile() {
        const user = this.currentUser;
        const avatarEl = document.getElementById('profileAvatarInitial');
        const nameEl = document.getElementById('profileName');
        const subtitleEl = document.getElementById('profileSubtitle');
        const personalInfoCard = document.getElementById('personalInfoCard');

        if (user && this.isRealUser()) {
            // Real profile, straight from the DB — no demo fallbacks.
            const profile = this.currentProfile || {};
            const displayName = profile.display_name || user.name || user.username || 'Friend';
            nameEl.textContent = displayName.toUpperCase();
            avatarEl.textContent = (displayName[0] || user.initial || '?').toUpperCase();
            subtitleEl.textContent = this.getProfileSubtitle(profile);

            const avatarImg = userService.getAvatar(user.id);
            if (avatarImg) {
                avatarEl.style.backgroundImage = `url(${avatarImg.data})`;
                avatarEl.style.backgroundSize = 'cover';
                avatarEl.style.backgroundPosition = 'center';
                avatarEl.classList.add('has-image');
            } else {
                avatarEl.style.backgroundImage = '';
                avatarEl.classList.remove('has-image');
            }

            if (personalInfoCard) this.renderDbPersonalInfo(personalInfoCard, profile);
            this.renderHealth();
        } else if (user) {
            // Legacy demo user — keep the old local experience intact.
            const profile = userService.getProfile(user.id);
            const displayName = profile.firstName || user.name;
            nameEl.textContent = displayName.toUpperCase();
            avatarEl.textContent = (profile.firstName?.[0] || user.initial).toUpperCase();
            subtitleEl.textContent = `Together since 2023`;

            const avatarImg = userService.getAvatar(user.id);
            if (avatarImg) {
                avatarEl.style.backgroundImage = `url(${avatarImg.data})`;
                avatarEl.style.backgroundSize = 'cover';
                avatarEl.style.backgroundPosition = 'center';
                avatarEl.classList.add('has-image');
            } else {
                avatarEl.style.backgroundImage = '';
                avatarEl.classList.remove('has-image');
            }

            if (personalInfoCard) {
                personalInfoCard.innerHTML = '';
                const fields = [
                    { key: 'birthday', label: 'Birthday' },
                    { key: 'height', label: 'Height', suffix: ' cm' },
                    { key: 'weight', label: 'Weight', suffix: ' kg' },
                    { key: 'bloodType', label: 'Blood Type' },
                    { key: 'city', label: 'City' },
                    { key: 'country', label: 'Country' },
                    { key: 'occupation', label: 'Occupation' },
                    { key: 'favoriteFood', label: 'Favorite Food' },
                    { key: 'favoriteMovie', label: 'Favorite Movie' },
                    { key: 'favoriteMusic', label: 'Favorite Music' }
                ];
                fields.forEach(f => {
                    if (profile[f.key]) {
                        const row = document.createElement('div');
                        row.className = 'info-row';
                        row.innerHTML = `<span class="info-key">${f.label}</span><span class="info-val">${profile[f.key]}${f.suffix || ''}</span>`;
                        personalInfoCard.appendChild(row);
                    }
                });
                if (personalInfoCard.children.length === 0) {
                    personalInfoCard.innerHTML = '<div class="info-row"><span class="info-key" style="width:100%;text-align:center;">No information yet. Tap Edit Profile to add.</span></div>';
                }
            }
            this.renderHealth();
        } else {
            nameEl.textContent = 'LOVEHUB';
            avatarEl.textContent = '♥';
            subtitleEl.textContent = 'Login to see your profile';
            if (personalInfoCard) personalInfoCard.innerHTML = '<div class="info-row"><span class="info-key" style="width:100%;text-align:center;">Please login to view profile</span></div>';
        }
        this.renderCoupleSection();
    }

    renderDbPersonalInfo(card, profile) {
        card.innerHTML = '';
        const genderLabel = profile.gender === 'prefer_not_to_say' ? 'Prefer not to say' : profile.gender;
        const rows = [
            { label: 'Birthday', value: profile.date_of_birth ? new Date(profile.date_of_birth + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '' },
            { label: 'Gender', value: genderLabel || '' },
            { label: 'Height', value: profile.height ? `${profile.height} cm` : '' },
            { label: 'Weight', value: profile.weight ? `${profile.weight} kg` : '' },
            { label: 'City', value: profile.city || '' },
            { label: 'Country', value: profile.country || '' },
            { label: 'Occupation', value: profile.occupation || '' },
            { label: 'Bio', value: profile.bio || '' }
        ];
        rows.forEach(r => {
            if (r.value) {
                const row = document.createElement('div');
                row.className = 'info-row';
                row.innerHTML = `<span class="info-key">${r.label}</span><span class="info-val">${this.escapeHtml(r.value)}</span>`;
                card.appendChild(row);
            }
        });
        if (card.children.length === 0) {
            card.innerHTML = '<div class="info-row"><span class="info-key" style="width:100%;text-align:center;">No information yet. Tap Edit Profile to add.</span></div>';
        }
    }

    getProfileSubtitle(profile) {
        if (this.currentCouple?.status === 'active') {
            if (this.currentCouple.relationship_started_on) {
                return `Together since ${new Date(this.currentCouple.relationship_started_on + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`;
            }
            return 'Connected on LoveHub';
        }
        return profile.onboarding_completed ? 'Find your partner' : 'Complete your profile';
    }

    renderCoupleSection() {
        const el = document.getElementById('coupleSection');
        if (!el) return;
        if (!this.currentUser) {
            el.innerHTML = '<div class="glass-card" style="padding:22px;text-align:center;color:var(--text-secondary);font-size:14px">Login to find your partner</div>';
            return;
        }
        if (this.isDemoUser()) {
            el.innerHTML = '<div class="glass-card" style="padding:22px;text-align:center;color:var(--text-secondary);font-size:14px">Couples are available to real accounts.</div>';
            return;
        }

        const couple = this.currentCouple;
        if (couple?.status === 'active') {
            const partnerName = couple.partner?.display_name || 'Your partner';
            const partnerInitial = partnerName[0]?.toUpperCase() || '?';
            const since = couple.relationship_started_on
                ? new Date(couple.relationship_started_on + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
                : null;
            const days = this.getDaysTogether();
            el.innerHTML = `
                <div class="glass-card" style="padding:20px">
                    <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
                        <div class="avatar-circle" style="width:52px;height:52px;font-size:20px">${this.escapeHtml(partnerInitial)}</div>
                        <div style="flex:1">
                            <div style="font-weight:600;font-size:17px">${this.escapeHtml(partnerName)}</div>
                            <div style="font-size:13px;color:var(--text-secondary)">@${this.escapeHtml(couple.partner?.username || '')}</div>
                        </div>
                    </div>
                    ${since ? `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:14px">Together since ${since} · ${days.toLocaleString()} days</div>` : ''}
                    <button class="login-submit" id="coupleManageBtn" style="margin:0;font-size:14px">Manage Couple</button>
                </div>`;
            const manage = document.getElementById('coupleManageBtn');
            if (manage) manage.addEventListener('click', () => window.LoveHubOnboarding?.start({ step: 'status' }));
        } else if (couple?.status === 'pending') {
            const isCreator = couple.created_by === this.currentUser.id;
            el.innerHTML = `
                <div class="glass-card" style="padding:20px;text-align:center">
                    ${isCreator
                        ? `<div style="font-size:14px;color:var(--text-secondary);margin-bottom:8px">Your invite code</div>
                           <div style="font-size:26px;font-weight:800;letter-spacing:6px;color:var(--love-accent);margin-bottom:12px">${this.escapeHtml(couple.invite_code)}</div>`
                        : `<div style="font-size:15px;margin-bottom:6px">Waiting for your partner to accept</div>
                           <div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">You will be connected here</div>`}
                    <button class="login-submit" id="coupleStatusBtn" style="margin:0;font-size:14px">View status</button>
                </div>`;
            const status = document.getElementById('coupleStatusBtn');
            if (status) status.addEventListener('click', () => window.LoveHubOnboarding?.start({ step: 'status' }));
        } else {
            el.innerHTML = `
                <div class="glass-card" style="padding:22px;text-align:center">
                    <div style="font-size:15px;margin-bottom:6px">Find your partner</div>
                    <div style="font-size:13px;color:var(--text-secondary);margin-bottom:14px">Create a couple and share your invite code, or join with theirs.</div>
                    <button class="login-submit" id="coupleSetupBtn" style="margin:0">Create / Join Couple</button>
                </div>`;
            const setup = document.getElementById('coupleSetupBtn');
            if (setup) setup.addEventListener('click', () => window.LoveHubOnboarding?.start({ step: 'couple-menu' }));
        }
    }

    renderHealth() {
        const healthGrid = document.getElementById('healthGrid');
        if (!healthGrid) return;
        healthGrid.innerHTML = '';

        // Only the explicit legacy demo session may show seeded metrics.
        if (!this.isDemoUser()) {
            healthGrid.innerHTML = `<div class="glass-card" style="grid-column:1/-1;padding:22px;text-align:center;color:var(--text-secondary);font-size:14px">${this.currentUser ? 'Health data will appear here' : 'Log in to view your private health data.'}</div>`;
            return;
        }
        
        const healthData = healthService.getTodayData();
        const metrics = healthService.getMetrics().slice(0, 4);
        metrics.forEach(m => {
            const card = document.createElement('div');
            card.className = 'health-card glass-card';
            card.innerHTML = `
                <div class="health-icon" style="color: ${m.color}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="22" height="22"><circle cx="12" cy="12" r="10"></circle></svg></div>
                <div class="health-info">
                    <div class="health-name">${m.name}</div>
                    <div class="health-value">${healthData[m.id]}${m.unit ? ' ' + m.unit : ''}</div>
                </div>
            `;
            healthGrid.appendChild(card);
        });
    }

    setupLogin() {
        const loginBtn = document.getElementById('loginBtn');
        const logoutBtn = document.getElementById('logoutBtn');
        const overlay = document.getElementById('loginOverlay');
        const cancelBtn = document.getElementById('loginCancel');
        const submitBtn = document.getElementById('loginSubmit');
        const switchModeBtn = document.getElementById('loginSwitchMode');
        const forgotBtn = document.getElementById('forgotPasswordBtn');
        const nameField = document.getElementById('signupName');
        const emailField = document.getElementById('signupEmail');
        const userField = document.getElementById('loginUser');
        const passField = document.getElementById('loginPass');
        const titleEl = document.getElementById('loginTitle');
        const subEl = document.getElementById('loginSub');

        let isSignupMode = false;
        let forgotMode = false;

        const setMode = (signup) => {
            isSignupMode = signup;
            nameField.style.display = signup ? 'block' : 'none';
            emailField.style.display = signup ? 'block' : 'none';
            forgotBtn.style.display = signup ? 'none' : 'block';
            titleEl.textContent = signup ? 'Create Account' : 'Welcome Back';
            subEl.textContent = signup ? 'Join LoveHub' : 'Login to your LoveHub account';
            submitBtn.textContent = signup ? 'Sign Up' : 'Login';
            switchModeBtn.textContent = signup ? 'Already have an account? Login' : "Don't have an account? Sign up";
        };

        // Restore the normal login/signup state after forgot-password mode.
        const resetForgotMode = () => {
            forgotMode = false;
            userField.style.display = 'block';
            passField.style.display = 'block';
            emailField.style.display = isSignupMode ? 'block' : 'none';
            emailField.placeholder = 'Email';
            switchModeBtn.style.display = 'block';
            forgotBtn.style.display = isSignupMode ? 'none' : 'block';
        };

        // Exposed so the recovery flow can force the sheet back to login mode.
        this.setLoginMode = setMode;
        this.resetLoginForgot = resetForgotMode;

        switchModeBtn.addEventListener('click', () => setMode(!isSignupMode));

        // Forgot-password mode reuses the email field (login stays
        // username-only; the reset email is where the real address is needed).
        forgotBtn.addEventListener('click', () => {
            forgotMode = true;
            nameField.style.display = 'none';
            userField.style.display = 'none';
            passField.style.display = 'none';
            emailField.style.display = 'block';
            emailField.placeholder = 'Enter your email';
            titleEl.textContent = 'Reset Password';
            subEl.textContent = 'We will email you a reset link';
            submitBtn.textContent = 'Send Reset Link';
            switchModeBtn.style.display = 'none';
            forgotBtn.style.display = 'none';
        });

        loginBtn.addEventListener('click', () => {
            resetForgotMode();
            setMode(false);
            overlay.classList.add('active');
            const backendMsg = this.getBackendMessage();
            if (backendMsg) this.showToast(backendMsg, 4500);
        });
        cancelBtn.addEventListener('click', () => overlay.classList.remove('active'));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('active'); });

        submitBtn.addEventListener('click', async () => {
            const username = userField.value.trim();
            const password = passField.value;
            const displayName = nameField.value.trim();
            const email = emailField.value.trim();

            // ---- forgot-password mode ----
            if (forgotMode) {
                if (!email || !email.includes('@')) {
                    this.showToast('Please enter a valid email');
                    return;
                }
                submitBtn.disabled = true;
                submitBtn.textContent = 'Sending...';
                if (!window.LoveHubAuth?.isReady()) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Send Reset Link';
                    this.showToast(this.getBackendMessage() || 'Backend unavailable');
                    return;
                }
                const res = await window.LoveHubAuth.resetPasswordForEmail(email);
                submitBtn.disabled = false;
                if (res.success) {
                    this.showToast('Reset link sent — check your email');
                    resetForgotMode();
                    setMode(false);
                } else {
                    submitBtn.textContent = 'Send Reset Link';
                    this.showToast(res.error || 'Could not send reset link');
                }
                return;
            }

            if (!username || !password) {
                this.showToast('Please enter credentials');
                return;
            }
            if (isSignupMode && !displayName) {
                this.showToast('Please enter a display name');
                return;
            }
            if (isSignupMode && (!email || !email.includes('@'))) {
                this.showToast('Please enter a valid email');
                return;
            }

            submitBtn.disabled = true;
            submitBtn.textContent = isSignupMode ? 'Creating account...' : 'Logging in...';

            let result;

            if (isSignupMode) {
                // Real email signup (Phase 1) — no more @lovehub.local.
                if (window.LoveHubAuth?.isReady()) {
                    const res = await window.LoveHubAuth.signUp({ email, password, username, displayName });
                    if (res.success) {
                        this.showToast(res.needsEmailConfirmation
                            ? 'Account created — check your email to confirm your account.'
                            : 'Account created — welcome to LoveHub ❤️');
                        setMode(false);
                        emailField.value = '';
                        if (res.user) {
                            this.currentUser = res.user;
                            this.updateAuthUI();
                            this.renderProfile();
                        }
                        submitBtn.disabled = false;
                        return;
                    }
                    result = { success: false, error: res.error };
                } else {
                    result = { success: false, error: this.getBackendMessage() || 'Backend unavailable' };
                }
            } else {
                    // Real Supabase login (by username/email).
                if (window.LoveHubAuth?.isReady()) {
                        const sbResult = await window.LoveHubAuth.signInWithUsername(username, password);
                        if (sbResult.success) {
                            const profile = await window.LoveHubProfile.getProfile(sbResult.user.id);
                            result = { success: true, user: window.LoveHubProfile.toAppUser(profile, sbResult.user) };
                        } else {
                            // Needs-confirmation or wrong password — show the error,
                            // never silently land on a demo account with the same name.
                            result = { success: false, error: sbResult.error };
                        }
                } else if (window.LoveHubInit?.status === 'missing-config') {
                    // Supabase genuinely absent — demo fallback is allowed.
                    result = authService.login(username, password);
                } else {
                    // Configured but broken — show the real reason, never a fake demo success.
                    result = { success: false, error: this.getBackendMessage() || 'Backend unavailable' };
                }
                if (!result && window.LoveHubInit?.status === 'missing-config') {
                    result = authService.login(username, password);
                }
            }

            if (result.success) {
                this.currentUser = result.user;
                overlay.classList.remove('active');
                userField.value = '';
                passField.value = '';
                nameField.value = '';
                emailField.value = '';
                if (this.isRealUser()) {
                    await this.loadAccountState();
                    this.onboardingDismissed = false;
                }
                this.updateAuthUI();
                this.renderAll();
                this.showToast('Login Successful ❤️');
                if (this.isRealUser()) this.checkOnboarding();
            } else {
                this.showToast(result.error || 'Login failed');
            }

            submitBtn.disabled = false;
            setMode(isSignupMode);
        });

        logoutBtn.addEventListener('click', async () => {
            if (confirm('Are you sure you want to logout?')) {
                if (window.LoveHubAuth?.isReady()) {
                    const result = await window.LoveHubAuth.signOut();
                    if (!result.success) {
                        this.showToast(result.error || 'Could not log out');
                        return;
                    }
                } else if (window.LoveHubInit?.status === 'missing-config') {
                    authService.logout();
                }
                this.handleSignedOut();
                this.showToast('Logged out successfully');
            }
        });
    }

    updateAuthUI() {
        const isLoggedIn = this.currentUser !== null;
        document.getElementById('loginBtn').style.display = isLoggedIn ? 'none' : 'flex';
        document.getElementById('logoutBtn').style.display = isLoggedIn ? 'flex' : 'none';
        document.getElementById('changePasswordBtn').style.display = isLoggedIn ? 'flex' : 'none';
        document.getElementById('settingsAccountSection').style.display = isLoggedIn ? 'block' : 'none';
    }

    setupProfileEditing() {
        const editBtn = document.getElementById('editProfileBtn');
        const settingsEditBtn = document.getElementById('settingsEditProfileBtn');
        const modal = document.getElementById('editProfileModal');
        const closeBtn = document.getElementById('closeEditProfile');
        const saveBtn = document.getElementById('saveProfileBtn');
        const form = document.getElementById('editProfileForm');
        
        const openEdit = () => {
            if (!this.currentUser) {
                this.showToast('Please login first');
                return;
            }
            // Real users edit the DB-backed fields; demo users keep the legacy form.
            const real = this.isRealUser();
            const profile = real ? (this.currentProfile || {}) : userService.getProfile(this.currentUser.id);
            const fields = real ? window.LoveHubProfile.getDbFieldDefinitions() : userService.getAllFieldDefinitions();
            form.innerHTML = '';
            
            fields.forEach(f => {
                const group = document.createElement('div');
                group.className = 'form-group';
                const label = document.createElement('label');
                label.textContent = f.label;
                group.appendChild(label);
                
                let input;
                if (f.type === 'textarea') {
                    input = document.createElement('textarea');
                    input.value = profile[f.key] || '';
                } else if (f.type === 'select') {
                    input = document.createElement('select');
                    f.options.forEach(opt => {
                        const option = document.createElement('option');
                        option.value = opt;
                        option.textContent = opt;
                        if (profile[f.key] === opt) option.selected = true;
                        input.appendChild(option);
                    });
                } else {
                    input = document.createElement('input');
                    input.type = f.type;
                    input.value = profile[f.key] || '';
                }
                input.dataset.field = f.key;
                group.appendChild(input);
                form.appendChild(group);
            });
            modal.classList.add('active');
        };
        
        if (editBtn) editBtn.addEventListener('click', openEdit);
        if (settingsEditBtn) settingsEditBtn.addEventListener('click', () => {
            document.getElementById('settingsOverlay').classList.remove('active');
            setTimeout(openEdit, 300);
        });
        if (closeBtn) closeBtn.addEventListener('click', () => modal.classList.remove('active'));
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('active'); });
        
        saveBtn.addEventListener('click', async () => {
            const inputs = form.querySelectorAll('[data-field]');
            const profileData = {};
            inputs.forEach(input => {
                let v = input.value;
                if (this.isRealUser()) {
                    if (input.dataset.field === 'height' || input.dataset.field === 'weight') v = v === '' ? null : Number(v);
                    if (input.dataset.field === 'date_of_birth') v = v === '' ? null : v;
                }
                profileData[input.dataset.field] = v;
            });
            
            if (this.isRealUser()) {
                const res = await window.LoveHubProfile.updateProfile(this.currentUser.id, profileData);
                if (res.success) {
                    this.currentProfile = res.profile;
                    modal.classList.remove('active');
                    this.renderProfile();
                    this.showToast('Profile saved');
                } else {
                    this.showToast(res.error || 'Could not save profile');
                }
            } else {
                const result = userService.saveProfile(this.currentUser.id, profileData);
                if (result.success) {
                    modal.classList.remove('active');
                    this.renderProfile();
                    this.showToast('Profile saved');
                }
            }
        });
        
        // Change password
        const changePasswordBtn = document.getElementById('changePasswordBtn');
        const settingsChangePasswordBtn = document.getElementById('settingsChangePasswordBtn');
        const passwordModal = document.getElementById('changePasswordModal');
        const closePasswordBtn = document.getElementById('closeChangePassword');
        const submitPasswordBtn = document.getElementById('submitChangePassword');
        
        const openPassword = () => {
            if (!this.currentUser) return;
            document.getElementById('currentPassword').value = '';
            document.getElementById('newPassword').value = '';
            document.getElementById('confirmPassword').value = '';
            passwordModal.classList.add('active');
        };
        
        if (changePasswordBtn) changePasswordBtn.addEventListener('click', openPassword);
        if (settingsChangePasswordBtn) settingsChangePasswordBtn.addEventListener('click', () => {
            document.getElementById('settingsOverlay').classList.remove('active');
            setTimeout(openPassword, 300);
        });
        if (closePasswordBtn) closePasswordBtn.addEventListener('click', () => passwordModal.classList.remove('active'));
        passwordModal.addEventListener('click', (e) => { if (e.target === passwordModal) passwordModal.classList.remove('active'); });
        
        submitPasswordBtn.addEventListener('click', async () => {
            const current = document.getElementById('currentPassword').value;
            const newPass = document.getElementById('newPassword').value;
            const confirm = document.getElementById('confirmPassword').value;
            
            if (!current || !newPass || !confirm) {
                this.showToast('Please fill all fields');
                return;
            }
            if (newPass !== confirm) {
                this.showToast('Passwords do not match');
                return;
            }
            if (newPass.length < 4) {
                this.showToast('Password must be at least 4 characters');
                return;
            }
            
            if (window.LoveHubAuth?.isReady() && window.LoveHubAuth.isSupabaseUser()) {
                // Real Supabase user — update via the Auth SDK.
                const res = await window.LoveHubAuth.updatePassword(newPass);
                if (res.success) {
                    passwordModal.classList.remove('active');
                    this.showToast('Password changed successfully');
                } else {
                    this.showToast(res.error || 'Could not change password');
                }
            } else {
                // Legacy demo account.
                const result = authService.changePassword(this.currentUser.id, current, newPass);
                if (result.success) {
                    passwordModal.classList.remove('active');
                    this.showToast('Password changed successfully');
                } else {
                    this.showToast(result.error);
                }
            }
        });
    }

    setupAvatarUpload() {
        const avatarEditBtn = document.getElementById('avatarEditBtn');
        const modal = document.getElementById('avatarModal');
        const closeBtn = document.getElementById('closeAvatarModal');
        const uploadArea = document.getElementById('avatarUploadArea');
        const fileInput = document.getElementById('avatarFileInput');
        const removeBtn = document.getElementById('removeAvatarBtn');
        
        if (avatarEditBtn) avatarEditBtn.addEventListener('click', () => {
            if (!this.currentUser) {
                this.showToast('Please login first');
                return;
            }
            modal.classList.add('active');
        });
        if (closeBtn) closeBtn.addEventListener('click', () => modal.classList.remove('active'));
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('active'); });
        
        if (uploadArea) uploadArea.addEventListener('click', () => fileInput.click());
        
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                userService.saveAvatar(this.currentUser.id, event.target.result);
                modal.classList.remove('active');
                this.renderProfile();
                this.updateAvatars();
                this.showToast('Photo updated');
            };
            reader.readAsDataURL(file);
            fileInput.value = '';
        });
        
        if (removeBtn) removeBtn.addEventListener('click', () => {
            if (!this.currentUser) return;
            userService.removeAvatar(this.currentUser.id);
            modal.classList.remove('active');
            this.renderProfile();
            this.updateAvatars();
            this.showToast('Photo removed');
        });
    }

    setupSettings() {
        const settingsBtn = document.getElementById('settingsBtn');
        const overlay = document.getElementById('settingsOverlay');
        const closeBtn = document.getElementById('settingsClose');
        
        settingsBtn.addEventListener('click', () => overlay.classList.add('active'));
        closeBtn.addEventListener('click', () => overlay.classList.remove('active'));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('active'); });
    }

    setupDataManagement() {
        const exportBtn = document.getElementById('exportDataBtn');
        const importBtn = document.getElementById('importDataBtn');
        const resetBtn = document.getElementById('resetDataBtn');
        const importFileInput = document.getElementById('importFileInput');
        
        if (exportBtn) exportBtn.addEventListener('click', () => {
            const data = storage.exportAll();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `lovehub-backup-${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
            this.showToast('Data exported');
        });
        
        if (importBtn) importBtn.addEventListener('click', () => importFileInput.click());
        
        importFileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const data = JSON.parse(event.target.result);
                    storage.importAll(data);
                    this.showToast('Data imported. Refreshing...');
                    setTimeout(() => location.reload(), 1000);
                } catch (err) {
                    this.showToast('Invalid file');
                }
            };
            reader.readAsText(file);
            importFileInput.value = '';
        });
        
        if (resetBtn) resetBtn.addEventListener('click', () => {
            if (confirm('This will delete all your data. Are you sure?')) {
                storage.clear();
                this.showToast('All data has been reset');
                setTimeout(() => location.reload(), 1000);
            }
        });
    }

    setupInteractions() {
        // Spring-based card press
        document.querySelectorAll('.glass-card, .glass').forEach(card => {
            card.addEventListener('touchstart', () => {
                card.style.transform = 'scale(0.97)';
            }, { passive: true });
            card.addEventListener('touchend', () => {
                setTimeout(() => {
                    card.style.transform = '';
                }, 100);
            }, { passive: true });
        });

        // Prevent double-tap zoom
        let lastTouchEnd = 0;
        document.addEventListener('touchend', (e) => {
            const now = Date.now();
            if (now - lastTouchEnd <= 300) e.preventDefault();
            lastTouchEnd = now;
        }, { passive: false });
    }

    showToast(message, duration = 3000) {
        const container = document.getElementById('toastContainer');
        if (!container) return;
        
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        container.appendChild(toast);
        
        requestAnimationFrame(() => toast.classList.add('show'));
        
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => { 
                if (container.contains(toast)) container.removeChild(toast); 
            }, 400);
        }, duration);
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    formatTime(timestamp) {
        const date = new Date(timestamp);
        const hours = date.getHours();
        const minutes = date.getMinutes();
        const ampm = hours >= 12 ? 'PM' : 'AM';
        return `${hours % 12 || 12}:${minutes.toString().padStart(2, '0')} ${ampm}`;
    }
}

let app;
document.addEventListener('DOMContentLoaded', () => { app = new LoveHub(); });

