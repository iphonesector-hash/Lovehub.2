class LoveHub {
    constructor() {
        this.currentPage = 'home';
        this.currentUser = null;
        this.init();
    }

    async init() {
        try {
            // Check existing session
            this.currentUser = authService.getCurrentUser();
            
            this.setupSplash();
            this.setupTheme();
            this.setupNavigation();
            this.setupChat();
            this.setupMemoryModal();
            this.setupLogin();
            this.setupSettings();
            this.setupProfileEditing();
            this.setupAvatarUpload();
            this.setupDataManagement();
            this.setupInteractions();
            
            this.renderAll();
            
            // If logged in, show logged-in UI
            if (this.currentUser) {
                this.updateAuthUI();
            }
        } catch (error) {
            console.error('Init error:', error);
        }
    }

    setupSplash() {
        const splash = document.getElementById('splash');
        const logo = document.querySelector('.splash-logo');
        if (!splash || !logo) return;
        
        setTimeout(() => logo.classList.add('expand'), 2500);
        setTimeout(() => splash.classList.add('fade-out'), 3200);
        setTimeout(() => splash.style.display = 'none', 4000);
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
        document.querySelectorAll('.tab-item').forEach(tab => {
            tab.addEventListener('click', () => this.navigateTo(tab.dataset.tab));
        });
        document.querySelectorAll('[data-nav]').forEach(btn => {
            btn.addEventListener('click', () => this.navigateTo(btn.dataset.nav));
        });
    }

    navigateTo(pageName) {
        if (this.currentPage === pageName) return;
        document.querySelectorAll('.tab-item').forEach(tab => 
            tab.classList.toggle('active', tab.dataset.tab === pageName));
        document.querySelectorAll('.page').forEach(page => 
            page.classList.toggle('active', page.dataset.page === pageName));
        this.currentPage = pageName;
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

    // ECG Animation
    startECG() {
        const path = document.querySelector('.ecg-path');
        if (!path) return;
        
        let offset = 0;
        let lastBeat = 0;
        let nextBeatInterval = 800 + Math.random() * 600;
        
        const generateSegment = (x, amplitude) => {
            const baseline = 30;
            if (amplitude > 0.7) {
                // Strong heartbeat
                return `L${x} ${baseline} L${x+5} ${baseline-25*amplitude} L${x+10} ${baseline+15*amplitude} L${x+15} ${baseline-8*amplitude} L${x+20} ${baseline}`;
            } else if (amplitude > 0.3) {
                // Medium beat
                return `L${x} ${baseline} L${x+8} ${baseline-12*amplitude} L${x+16} ${baseline+8*amplitude} L${x+24} ${baseline}`;
            } else {
                // Flat
                return `L${x} ${baseline} L${x+20} ${baseline}`;
            }
        };
        
        const animate = (timestamp) => {
            if (!lastBeat) lastBeat = timestamp;
            const elapsed = timestamp - lastBeat;
            
            if (elapsed > nextBeatInterval) {
                lastBeat = timestamp;
                nextBeatInterval = 700 + Math.random() * 800;
            }
            
            const beatProgress = elapsed / nextBeatInterval;
            let amplitude = 0;
            
            if (beatProgress < 0.15) amplitude = 1 - (beatProgress / 0.15);
            else if (beatProgress > 0.85) amplitude = (beatProgress - 0.85) / 0.15;
            
            // Occasionally add stronger beat
            if (Math.random() < 0.02) amplitude = Math.max(amplitude, 0.8);
            
            offset = (offset + 0.5) % 400;
            
            let d = `M${-offset} 30`;
            for (let x = 0; x <= 800; x += 20) {
                const segAmplitude = amplitude * (0.5 + 0.5 * Math.sin((x + offset) * 0.01));
                d += generateSegment(x - offset, segAmplitude);
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
        
        const days = Math.ceil(Math.abs(new Date() - new Date('2023-01-01')) / (1000 * 60 * 60 * 24));
        this.animateValue('daysCounter', 0, days, 1500);
        
        const latestMemory = LoveHubData.memories[0];
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
        }
        
        const memoriesCount = document.getElementById('memoriesCount');
        if (memoriesCount) memoriesCount.textContent = `${LoveHubData.memories.length} photos`;
        
        // Update avatars with saved images
        this.updateAvatars();
    }

    updateAvatars() {
        const avatarP = document.getElementById('avatarP');
        const avatarS = document.getElementById('avatarS');
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
        
        const messages = storage.get('messages') || LoveHubData.messages;
        const messagesByDate = {};
        messages.forEach(msg => {
            const date = msg.timestamp.split('T')[0];
            if (!messagesByDate[date]) messagesByDate[date] = [];
            messagesByDate[date].push(msg);
        });

        Object.keys(messagesByDate).sort().forEach(date => {
            const dateDiv = document.createElement('div');
            dateDiv.className = 'chat-date-divider';
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

    setupChat() {
        const sendBtn = document.getElementById('sendBtn');
        const chatInput = document.getElementById('chatInput');
        
        const sendMessage = () => {
            const text = chatInput.value.trim();
            if (!text) return;
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
        document.getElementById('loveLetterContent').textContent = `"${LoveHubData.relationship.loveLetter}"`;
        document.getElementById('loveLetterFrom').textContent = `— ${LoveHubData.relationship.writtenBy}`;

        const milestonesContainer = document.getElementById('loveMilestones');
        if (milestonesContainer) {
            const existingTitle = milestonesContainer.querySelector('.section-title');
            milestonesContainer.innerHTML = '';
            if (existingTitle) milestonesContainer.appendChild(existingTitle);
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
        LoveHubData.games.forEach(game => {
            const card = document.createElement('div');
            card.className = 'game-card glass-card';
            card.innerHTML = `
                <div class="game-cover ${game.cover}">${game.coverContent}</div>
                <div class="game-info-section">
                    <div class="game-title">${game.name}</div>
                    <div class="game-desc">${game.description}</div>
                    <div class="game-meta">
                        <span class="game-rating">★ ${game.rating}</span>
                        <span class="game-wins"> ${game.wins} wins</span>
                    </div>
                    <div class="game-last">Last played: ${game.lastPlayed}</div>
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
        LoveHubData.memories.forEach(memory => {
            const item = document.createElement('div');
            item.className = 'memory-item';
            let bgStyle = memory.image ? 
                `background-image: url('${memory.image}'); background-size: cover; background-position: center;` : 
                `background: ${memory.gradient};`;
            const dateParts = memory.dateDisplay.split(' ');
            item.innerHTML = `<div class="memory-thumb" style="${bgStyle}"><div class="memory-overlay"><span class="memory-date-tag">${dateParts[1]} ${dateParts[2]?.replace(',', '') || ''}</span></div></div>`;
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
        const timelineContainer = document.getElementById('timelineContainer');
        if (!timelineContainer) return;
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
        
        if (user) {
            const profile = userService.getProfile(user.id);
            const displayName = profile.firstName || user.name;
            nameEl.textContent = displayName.toUpperCase();
            avatarEl.textContent = (profile.firstName?.[0] || user.initial).toUpperCase();
            subtitleEl.textContent = `Together since 2023`;
            
            // Load avatar image
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
            
            // Render personal info
            const personalInfoCard = document.getElementById('personalInfoCard');
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
                        row.innerHTML = `<span class="info-key">${f.label}</span><span class="info-value">${profile[f.key]}${f.suffix || ''}</span>`;
                        personalInfoCard.appendChild(row);
                    }
                });
                if (personalInfoCard.children.length === 0) {
                    personalInfoCard.innerHTML = '<div class="info-row"><span class="info-key" style="width:100%;text-align:center;">No information yet. Tap Edit Profile to add.</span></div>';
                }
            }
            
            // Render health
            this.renderHealth();
        } else {
            nameEl.textContent = 'POURYA';
            avatarEl.textContent = 'P';
            subtitleEl.textContent = 'Login to see your profile';
            document.getElementById('personalInfoCard').innerHTML = '<div class="info-row"><span class="info-key" style="width:100%;text-align:center;">Please login to view profile</span></div>';
        }
    }

    renderHealth() {
        const healthGrid = document.getElementById('healthGrid');
        if (!healthGrid) return;
        healthGrid.innerHTML = '';
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

        loginBtn.addEventListener('click', () => overlay.classList.add('active'));
        cancelBtn.addEventListener('click', () => overlay.classList.remove('active'));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('active'); });

        submitBtn.addEventListener('click', async () => {
            const username = document.getElementById('loginUsername').value.trim();
            const password = document.getElementById('loginPassword').value;

            if (!username || !password) {
                this.showToast('Please enter credentials');
                return;
            }

            submitBtn.disabled = true;
            submitBtn.textContent = 'Logging in...';
            
            const result = authService.login(username, password);
            
            if (result.success) {
                this.currentUser = result.user;
                overlay.classList.remove('active');
                document.getElementById('loginUsername').value = '';
                document.getElementById('loginPassword').value = '';
                this.updateAuthUI();
                this.renderProfile();
                this.showToast('Login Successful ❤️');
            } else {
                this.showToast(result.error);
            }
            
            submitBtn.disabled = false;
            submitBtn.textContent = 'Login';
        });

        logoutBtn.addEventListener('click', () => {
            if (confirm('Are you sure you want to logout?')) {
                authService.logout();
                this.currentUser = null;
                this.updateAuthUI();
                this.renderProfile();
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
            const profile = userService.getProfile(this.currentUser.id);
            const fields = userService.getAllFieldDefinitions();
            
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

        saveBtn.addEventListener('click', () => {
            const inputs = form.querySelectorAll('[data-field]');
            const profileData = {};
            inputs.forEach(input => {
                profileData[input.dataset.field] = input.value;
            });
            
            const result = userService.saveProfile(this.currentUser.id, profileData);
            if (result.success) {
                modal.classList.remove('active');
                this.renderProfile();
                this.showToast('Profile saved');
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

        submitPasswordBtn.addEventListener('click', () => {
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
            
            const result = authService.changePassword(this.currentUser.id, current, newPass);
            if (result.success) {
                passwordModal.classList.remove('active');
                this.showToast('Password changed successfully');
            } else {
                this.showToast(result.error);
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
                // Simple crop: use as-is (full implementation would use canvas)
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
        document.querySelectorAll('.glass-card').forEach(card => {
            card.addEventListener('touchstart', () => card.style.transform = 'scale(0.97)');
            card.addEventListener('touchend', () => setTimeout(() => card.style.transform = '', 100));
        });
        let lastTouchEnd = 0;
        document.addEventListener('touchend', (e) => {
            const now = Date.now();
            if (now - lastTouchEnd <= 300) e.preventDefault();
            lastTouchEnd = now;
        }, false);
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
            setTimeout(() => { if (container.contains(toast)) container.removeChild(toast); }, 400);
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

