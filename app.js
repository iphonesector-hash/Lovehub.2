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
        // Drop the realtime chat channel and any cached conversation — a
        // signed-out user must never keep seeing (or receiving) couple chats.
        this.unsubscribeChat();
        this._chatCoupleId = null;
        this._chatMessages = [];
        this._chatState = 'idle';
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
        this._chatState = 'idle';
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
                    nextPageEl.style.opacity = '1';
                    nextPageEl.style.transform = 'translateY(0)';
                });
            }, 200);
        } else {
            // Fallback
            document.querySelectorAll('.page').forEach(page => 
                page.classList.toggle('active', page.dataset.page === pageName));
        }

        this.currentPage = pageName;

        // Opening the chat tab (re)renders and marks the conversation read.
        if (pageName === 'chat') {
            this.renderChat();
            if (this.isRealUser() && this.currentCouple?.status === 'active' && window.LoveHubChat) {
                window.LoveHubChat.markAsRead(this.currentCouple.id);
            }
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

    // Real users: Supabase-backed private couple chat ----------------------

    renderRealChat(conversation) {
        const couple = this.currentCouple;
        const titleEl = document.querySelector('.page[data-page="chat"] .page-title');
        const empty = (html) => {
            conversation.innerHTML = `<div class="chat-empty" style="text-align:center;color:var(--text-secondary);padding:60px 24px;font-size:15px;line-height:1.7">${html}</div>`;
            conversation.scrollTop = 0;
        };

        if (!couple) {
            if (titleEl) titleEl.textContent = 'Messages';
            empty('Connect with your partner to start chatting.');
            return;
        }
        if (couple.status !== 'active') {
            if (titleEl) titleEl.textContent = 'Messages';
            empty('Your invite is still pending.<br>Chat unlocks when your partner accepts.');
            return;
        }

        const partnerName = couple.partner?.display_name || 'Your partner';
        if (titleEl) titleEl.textContent = partnerName;

        // Load + subscribe once per couple id; re-render from cache after that.
        if (this._chatCoupleId !== couple.id) {
            this.unsubscribeChat();
            this._chatCoupleId = couple.id;
            this._chatMessages = [];
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
        if (!this._chatMessages.length) {
            empty('No messages yet.<br>Say something sweet ❤️');
            return;
        }

        const myUid = this.currentUser?.id;
        const byDate = {};
        this._chatMessages.forEach((msg) => {
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
                const mine = msg.sender_id === myUid;
                const bubble = document.createElement('div');
                bubble.className = `message-bubble ${mine ? 'sent' : 'received'}`;
                const read = mine && msg.read_at ? '<span class="bubble-read">Read</span>' : '';
                bubble.innerHTML = `<div class="bubble-content">${this.escapeHtml(msg.text)}</div><div class="bubble-time">${this.formatTime(msg.timestamp)}${read}</div>`;
                conversation.appendChild(bubble);
            });
        });
        conversation.scrollTop = conversation.scrollHeight;
    }

    async loadChat(coupleId) {
        const res = await window.LoveHubChat?.getConversation(coupleId);
        // A logout or couple switch may have happened while loading.
        if (this._chatCoupleId !== coupleId) return;
        if (!res?.success) {
            this._chatState = 'error';
        } else {
            this._chatMessages = (res.messages || []).map((m) => ({
                id: m.id,
                sender_id: m.sender_id,
                text: m.content,
                timestamp: m.created_at,
                read_at: m.read_at
            }));
            this._chatState = 'ready';
            this.subscribeChat(coupleId);
            window.LoveHubChat?.markAsRead(coupleId);
        }
        this.renderChat();
    }

    // Realtime: new messages and read receipts arrive without a refresh.
    subscribeChat(coupleId) {
        if (!window.LoveHubChat || this._chatChannel) return;
        this._chatChannel = window.LoveHubChat.subscribeToMessages(coupleId, (msg, isUpdate) => {
            if (this._chatCoupleId !== coupleId) return;
            if (isUpdate) {
                this._chatMessages = this._chatMessages.map((m) =>
                    m.id === msg.id ? { ...m, read_at: msg.read_at } : m);
                if (this.currentPage === 'chat') this.renderChat();
                return;
            }
            if (this._chatMessages.some((m) => m.id === msg.id)) return;
            this._chatMessages = [...this._chatMessages, {
                id: msg.id,
                sender_id: msg.sender_id,
                text: msg.content,
                timestamp: msg.created_at,
                read_at: msg.read_at
            }];
            if (this.currentPage === 'chat') this.renderChat();
            // My own message is already read by me — only receipt partner's.
            if (msg.sender_id !== this.currentUser?.id) window.LoveHubChat?.markAsRead(coupleId);
        });
    }

    unsubscribeChat() {
        if (this._chatChannel) {
            window.LoveHubChat?.unsubscribe(this._chatChannel);
            this._chatChannel = null;
        }
    }

    setupChat() {
        const sendBtn = document.getElementById('sendBtn');
        const chatInput = document.getElementById('chatInput');
        
        const sendMessage = async () => {
            const text = chatInput.value.trim();
            if (!text) return;

            // Real accounts send through Supabase (RLS-scoped to their couple).
            if (this.isRealUser()) {
                const couple = this.currentCouple;
                if (!couple || couple.status !== 'active') {
                    this.showToast(couple ? 'Chat unlocks when your partner accepts your invite.' : 'Connect with your partner to start chatting.');
                    return;
                }
                const res = await window.LoveHubChat?.sendMessage(couple.id, text);
                if (!res?.success) {
                    this.showToast(res?.error || 'Could not send message');
                    return;
                }
                chatInput.value = '';
                // Realtime usually echoes it back; append now for instant UI.
                this._chatMessages = [...this._chatMessages, {
                    id: res.message.id,
                    sender_id: res.message.sender_id,
                    text: res.message.content,
                    timestamp: res.message.created_at,
                    read_at: res.message.read_at
                }];
                this.renderChat();
                return;
            }

            if (!this.isDemoUser()) {
                this.showToast('Please login to chat.');
                return;
            }

            const messages = storage.get('messages') || LoveHubData.messages;
            messages.push({
                id: Date.now().toString(),
                senderId: this.currentUser?.id || 'user1',
                text: text,
                timestamp: new Date().toISOString(),
                type: 'sent'
            });
            storage.set('messages', messages);
            chatInput.value = '';
            this.renderChat();
            setTimeout(() => this.simulateReply(), 1500);
        };
        
        if (sendBtn) sendBtn.addEventListener('click', sendMessage);
        if (chatInput) chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
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

