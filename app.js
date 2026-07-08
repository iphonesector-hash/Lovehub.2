class LoveHub {
    constructor() {
        this.data = LoveHubData;
        this.utils = Utils;
        this.api = new ApiService();
        this.currentPage = 'home';
        this.init();
    }

    async init() {
        try {
            await this.loadData();
            this.setupSplash();
            this.setupTheme();
            this.setupNavigation();
            this.setupChat();
            this.setupMemoryModal();
            this.setupLogin();
            this.setupSettings();
            this.setupInteractions();
            this.renderAll();
            
            this.api.connectWebSocket((msg) => {
                console.log('Real-time message received:', msg);
            });
        } catch (error) {
            console.error('Error initializing LoveHub:', error);
        }
    }

    async loadData() {
        try {
            this.data.messages = await this.api.fetchMessages();
            
            const savedSettings = this.utils.loadFromStorage('settings');
            if (savedSettings) {
                this.data.settings = { ...this.data.settings, ...savedSettings };
            }
            
            const savedUser = this.utils.loadFromStorage('user');
            if (savedUser) {
                this.data.currentUser = { ...this.data.currentUser, ...savedUser };
            }
        } catch (error) {
            console.error('Error loading data:', error);
        }
    }

    setupSplash() {
        const splash = document.getElementById('splash');
        const logo = document.querySelector('.splash-logo');
        
        if (!splash || !logo) {
            console.error('Splash screen elements not found');
            return;
        }
        
        setTimeout(() => {
            logo.classList.add('expand');
        }, 2500);
        
        setTimeout(() => {
            splash.classList.add('fade-out');
        }, 3200);
        
        setTimeout(() => {
            splash.style.display = 'none';
        }, 4000);
    }

    setupTheme() {
        this.applyTheme(this.data.settings.theme);
        
        const themeOptions = document.querySelectorAll('.theme-option');
        themeOptions.forEach(option => {
            option.addEventListener('click', (e) => {
                const theme = e.currentTarget.dataset.theme;
                this.applyTheme(theme);
                this.data.settings.theme = theme;
                this.utils.saveToStorage('settings', this.data.settings);
                this.updateThemeOptions();
            });
        });
        
        this.updateThemeOptions();
    }

    applyTheme(theme) {
        const app = document.getElementById('app');
        if (app) {
            app.className = `theme-${theme}`;
        }
    }

    updateThemeOptions() {
        const themeOptions = document.querySelectorAll('.theme-option');
        themeOptions.forEach(option => {
            option.classList.toggle('active', option.dataset.theme === this.data.settings.theme);
        });
    }

    setupNavigation() {
        const tabs = document.querySelectorAll('.tab-item');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const targetPage = tab.dataset.tab;
                this.navigateTo(targetPage);
            });
        });

        const navButtons = document.querySelectorAll('[data-nav]');
        navButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const target = btn.dataset.nav;
                this.navigateTo(target);
            });
        });
    }

    navigateTo(pageName) {
        if (this.currentPage === pageName) return;

        const tabs = document.querySelectorAll('.tab-item');
        tabs.forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === pageName);
        });

        const pages = document.querySelectorAll('.page');
        pages.forEach(page => {
            page.classList.toggle('active', page.dataset.page === pageName);
        });

        this.currentPage = pageName;
        this.utils.hapticFeedback([10]);
    }

    renderAll() {
        this.renderHome();
        this.renderChat();
        this.renderLove();
        this.renderGames();
        this.renderMemories();
        this.renderTimeline();
        this.renderProfile();
    }

    animateValue(id, start, end, duration) {
        const obj = document.getElementById(id);
        if (!obj) return;
        
        let startTimestamp = null;
        const step = (timestamp) => {
            if (!startTimestamp) startTimestamp = timestamp;
            const progress = Math.min((timestamp - startTimestamp) / duration, 1);
            obj.innerHTML = Math.floor(progress * (end - start) + start).toLocaleString();
            if (progress < 1) {
                window.requestAnimationFrame(step);
            }
        };
        window.requestAnimationFrame(step);
    }

    renderHome() {
        const greeting = document.getElementById('greeting');
        if (greeting) {
            greeting.textContent = this.utils.getGreeting();
        }
        
        const days = this.utils.calculateDaysTogether(this.data.relationship.startDate);
        this.animateValue('daysCounter', 0, days, 1500);
        
        const latestMemory = this.data.memories[0];
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
        if (memoriesCount) {
            memoriesCount.textContent = `${this.data.memories.length} photos`;
        }
    }

    renderChat() {
        const conversation = document.getElementById('chatConversation');
        if (!conversation) return;
        
        conversation.innerHTML = '';
        
        const messagesByDate = {};
        this.data.messages.forEach(msg => {
            const date = msg.timestamp.split('T')[0];
            if (!messagesByDate[date]) {
                messagesByDate[date] = [];
            }
            messagesByDate[date].push(msg);
        });

        Object.keys(messagesByDate).sort().forEach(date => {
            const dateDiv = document.createElement('div');
            dateDiv.className = 'chat-date-divider';
            dateDiv.innerHTML = `<span>${this.utils.formatDate(date)}</span>`;
            conversation.appendChild(dateDiv);

            messagesByDate[date].forEach(msg => {
                const bubble = document.createElement('div');
                bubble.className = `message-bubble ${msg.type}`;
                bubble.innerHTML = `
                    <div class="bubble-content">${this.utils.escapeHtml(msg.text)}</div>
                    <div class="bubble-time">${this.utils.formatTime(msg.timestamp)}</div>
                `;
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
            this.sendMessageToApi(text);
        };
        
        if (sendBtn) {
            sendBtn.addEventListener('click', sendMessage);
        }
        
        if (chatInput) {
            chatInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    sendMessage();
                }
            });
        }
    }

    async sendMessageToApi(text) {
        const message = {
            id: this.utils.generateId(),
            senderId: this.data.currentUser.id,
            text: text,
            timestamp: new Date().toISOString(),
            type: 'sent'
        };
        
        await this.api.sendMessage(message);
        this.data.messages.push(message);
        
        const chatInput = document.getElementById('chatInput');
        if (chatInput) {
            chatInput.value = '';
        }
        
        this.renderChat();
        setTimeout(() => this.simulateReply(), 1500);
    }

    async simulateReply() {
        const replies = ['Miss you too!', 'Can\'t wait!', 'Love you', 'See you soon!'];
        const reply = replies[Math.floor(Math.random() * replies.length)];
        
        const message = {
            id: this.utils.generateId(),
            senderId: this.data.partner.id,
            text: reply,
            timestamp: new Date().toISOString(),
            type: 'received'
        };
        
        await this.api.sendMessage(message);
        this.data.messages.push(message);
        this.renderChat();
    }

    renderLove() {
        const loveStats = document.getElementById('loveStats');
        if (loveStats) {
            const days = this.utils.calculateDaysTogether(this.data.relationship.startDate);
            loveStats.innerHTML = `
                <div class="love-stat-card glass-card">
                    <div class="stat-icon" style="color: var(--love-accent)">${Icons.heartFill || '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>'}</div>
                    <div class="stat-value">${days.toLocaleString()}</div>
                    <div class="stat-label">Days Together</div>
                </div>
                <div class="love-stat-card glass-card">
                    <div class="stat-icon" style="color: var(--luxury-accent)">${Icons.message || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>'}</div>
                    <div class="stat-value">${this.data.messages.length}</div>
                    <div class="stat-label">Messages Sent</div>
                </div>
            `;
        }
        
        const loveLetterContent = document.getElementById('loveLetterContent');
        if (loveLetterContent) {
            loveLetterContent.textContent = `"${this.data.relationship.loveLetter}"`;
        }
        
        const loveLetterFrom = document.getElementById('loveLetterFrom');
        if (loveLetterFrom) {
            loveLetterFrom.textContent = `— ${this.data.relationship.writtenBy}`;
        }

        const milestonesContainer = document.getElementById('loveMilestones');
        if (milestonesContainer) {
            const existingTitle = milestonesContainer.querySelector('.section-title');
            milestonesContainer.innerHTML = '';
            if (existingTitle) {
                milestonesContainer.appendChild(existingTitle);
            }
            
            this.data.milestones.forEach(m => {
                const item = document.createElement('div');
                item.className = 'milestone-item glass-card';
                const iconSvg = Icons[m.icon] || Icons.heart;
                item.innerHTML = `
                    <div class="milestone-icon" style="color: var(--love-accent)">${iconSvg}</div>
                    <div class="milestone-info">
                        <div class="milestone-title">${m.title}</div>
                        <div class="milestone-date">${m.dateDisplay}</div>
                    </div>
                `;
                milestonesContainer.appendChild(item);
            });
        }
    }

    renderGames() {
        const gamesGrid = document.getElementById('gamesGrid');
        if (!gamesGrid) return;
        
        gamesGrid.innerHTML = '';
        
        this.data.games.forEach(game => {
            const card = document.createElement('div');
            card.className = 'game-card glass-card';
            card.innerHTML = `
                <div class="game-cover ${game.cover}">${game.coverContent}</div>
                <div class="game-info-section">
                    <div class="game-title">${game.name}</div>
                    <div class="game-desc">${game.description}</div>
                    <div class="game-meta">
                        <span class="game-rating">${Icons.star || '★'} ${game.rating}</span>
                        <span class="game-wins">${Icons.trophy || '🏆'} ${game.wins} wins</span>
                    </div>
                    <div class="game-last">Last played: ${game.lastPlayed}</div>
                </div>
                <button class="play-btn" data-game-id="${game.id}">${Icons.play || '▶'} Play</button>
            `;
            
            const playBtn = card.querySelector('.play-btn');
            if (playBtn) {
                playBtn.addEventListener('click', () => this.playGame(game.id));
            }
            
            gamesGrid.appendChild(card);
        });
    }

    playGame(gameId) {
        this.utils.hapticFeedback([20, 10, 20]);
        this.utils.showToast(`Starting ${gameId}... (Coming Soon)`);
    }

    renderMemories() {
        const memoriesGrid = document.getElementById('memoriesGrid');
        if (!memoriesGrid) return;
        
        memoriesGrid.innerHTML = '';
        
        this.data.memories.forEach(memory => {
            const item = document.createElement('div');
            item.className = 'memory-item';
            
            let bgStyle = '';
            if (memory.image) {
                bgStyle = `background-image: url('${memory.image}'); background-size: cover; background-position: center;`;
            } else {
                bgStyle = `background: ${memory.gradient};`;
            }
            
            const dateParts = memory.dateDisplay.split(' ');
            const dateTag = `${dateParts[1]} ${dateParts[2] ? dateParts[2].replace(',', '') : ''}`;
            
            item.innerHTML = `
                <div class="memory-thumb" style="${bgStyle}">
                    <div class="memory-overlay">
                        <span class="memory-date-tag">${dateTag}</span>
                    </div>
                </div>
            `;
            
            item.addEventListener('click', () => this.openMemoryDetail(memory.id));
            memoriesGrid.appendChild(item);
        });
    }

    setupMemoryModal() {
        const modal = document.getElementById('memoryModal');
        const closeBtn = document.getElementById('closeMemoryModal');
        
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                modal.classList.remove('active');
            });
        }
        
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.classList.remove('active');
                }
            });
        }
    }

    openMemoryDetail(memoryId) {
        const memory = this.data.memories.find(m => m.id === memoryId);
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
        
        const dateEl = document.getElementById('modalDate');
        if (dateEl) dateEl.textContent = memory.dateDisplay;
        
        const locationSpan = document.querySelector('#modalLocation span');
        if (locationSpan) locationSpan.textContent = memory.location;
        
        const musicSpan = document.querySelector('#modalMusic span');
        if (musicSpan) musicSpan.textContent = memory.music;
        
        const notesSpan = document.querySelector('#modalNotes span');
        if (notesSpan) notesSpan.textContent = memory.notes;
        
        const commentList = document.getElementById('commentList');
        if (commentList) {
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
        }
        
        if (modal) {
            modal.classList.add('active');
        }
    }

    renderTimeline() {
        const timelineContainer = document.getElementById('timelineContainer');
        if (!timelineContainer) return;
        
        timelineContainer.innerHTML = '';
        
        const timelineItems = [
            ...this.data.memories.map(m => ({
                date: m.date,
                dateDisplay: m.dateDisplay,
                title: m.location,
                desc: m.notes
            })),
            ...this.data.milestones.map(m => ({
                date: m.date,
                dateDisplay: m.dateDisplay,
                title: m.title,
                desc: ''
            }))
        ];
        
        timelineItems.sort((a, b) => new Date(b.date) - new Date(a.date));
        
        timelineItems.forEach(item => {
            const el = document.createElement('div');
            el.className = 'timeline-item';
            el.innerHTML = `
                <div class="timeline-dot"></div>
                <div class="timeline-card glass-card">
                    <div class="timeline-date">${item.dateDisplay}</div>
                    <div class="timeline-title">${item.title}</div>
                    <div class="timeline-desc">${item.desc}</div>
                </div>
            `;
            timelineContainer.appendChild(el);
        });
    }

    renderProfile() {
        const user = this.data.currentUser;
        
        const avatarEl = document.getElementById('profileAvatarInitial');
        if (avatarEl) avatarEl.textContent = user.initial;
        
        const nameEl = document.getElementById('profileName');
        if (nameEl) nameEl.textContent = user.name.toUpperCase();
        
        const subtitleEl = document.getElementById('profileSubtitle');
        if (subtitleEl) {
            const year = new Date(this.data.relationship.startDate).getFullYear();
            subtitleEl.textContent = `Together since ${year}`;
        }

        const healthGrid = document.getElementById('healthGrid');
        if (healthGrid) {
            healthGrid.innerHTML = '';
            this.data.healthMetrics.forEach(m => {
                const card = document.createElement('div');
                card.className = 'health-card glass-card';
                const iconSvg = Icons[m.icon] || Icons.heart;
                card.innerHTML = `
                    <div class="health-icon" style="color: ${m.color}">${iconSvg}</div>
                    <div class="health-info">
                        <div class="health-name">${m.name}</div>
                        <div class="health-value">${m.value}</div>
                    </div>
                `;
                healthGrid.appendChild(card);
            });
        }

        const personalInfoCard = document.getElementById('personalInfoCard');
        if (personalInfoCard) {
            personalInfoCard.innerHTML = '';
            this.data.personalInfo.forEach(info => {
                const row = document.createElement('div');
                row.className = 'info-row';
                row.innerHTML = `
                    <span class="info-key">${info.key}</span>
                    <span class="info-value">${info.value}</span>
                `;
                personalInfoCard.appendChild(row);
            });
        }

        const loginBtn = document.getElementById('loginBtn');
        const logoutBtn = document.getElementById('logoutBtn');
        
        if (loginBtn) {
            loginBtn.style.display = user.isLoggedIn ? 'none' : 'flex';
        }
        if (logoutBtn) {
            logoutBtn.style.display = user.isLoggedIn ? 'flex' : 'none';
        }
    }

    setupLogin() {
        const loginBtn = document.getElementById('loginBtn');
        const logoutBtn = document.getElementById('logoutBtn');
        const overlay = document.getElementById('loginOverlay');
        const cancelBtn = document.getElementById('loginCancel');
        const submitBtn = document.getElementById('loginSubmit');

        if (loginBtn) {
            loginBtn.addEventListener('click', () => {
                overlay.classList.add('active');
            });
        }

        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                overlay.classList.remove('active');
            });
        }

        if (overlay) {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    overlay.classList.remove('active');
                }
            });
        }

        if (submitBtn) {
            submitBtn.addEventListener('click', async () => {
                const username = document.getElementById('loginUsername').value;
                const password = document.getElementById('loginPassword').value;

                if (username && password) {
                    submitBtn.disabled = true;
                    submitBtn.textContent = 'Logging in...';
                    
                    try {
                        const result = await this.api.login(username, password);
                        if (result.success) {
                            this.data.currentUser.isLoggedIn = true;
                            this.data.currentUser.email = username;
                            this.utils.saveToStorage('user', this.data.currentUser);
                            overlay.classList.remove('active');
                            document.getElementById('loginUsername').value = '';
                            document.getElementById('loginPassword').value = '';
                            this.renderProfile();
                            this.utils.showToast('Login Successful');
                        }
                    } catch (error) {
                        console.error('Login error:', error);
                        this.utils.showToast('Login failed');
                    }
                    
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Login';
                } else {
                    this.utils.showToast('Please enter credentials');
                }
            });
        }

        if (logoutBtn) {
            logoutBtn.addEventListener('click', async () => {
                if (confirm('Are you sure you want to logout?')) {
                    try {
                        await this.api.logout();
                        this.data.currentUser.isLoggedIn = false;
                        this.data.currentUser.email = '';
                        this.utils.saveToStorage('user', this.data.currentUser);
                        this.renderProfile();
                        this.utils.showToast('Logged out successfully');
                    } catch (error) {
                        console.error('Logout error:', error);
                    }
                }
            });
        }
    }

    setupSettings() {
        const settingsBtn = document.getElementById('settingsBtn');
        const overlay = document.getElementById('settingsOverlay');
        const closeBtn = document.getElementById('settingsClose');

        if (settingsBtn) {
            settingsBtn.addEventListener('click', () => {
                overlay.classList.add('active');
            });
        }

        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                overlay.classList.remove('active');
            });
        }

        if (overlay) {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    overlay.classList.remove('active');
                }
            });
        }
    }

    setupInteractions() {
        const glassCards = document.querySelectorAll('.glass-card');
        glassCards.forEach(card => {
            card.addEventListener('touchstart', () => {
                card.style.transform = 'scale(0.97)';
            });
            card.addEventListener('touchend', () => {
                setTimeout(() => {
                    card.style.transform = '';
                }, 100);
            });
        });
        
        let lastTouchEnd = 0;
        document.addEventListener('touchend', (e) => {
            const now = Date.now();
            if (now - lastTouchEnd <= 300) {
                e.preventDefault();
            }
            lastTouchEnd = now;
        }, false);
    }
}

let app;
document.addEventListener('DOMContentLoaded', () => {
    app = new LoveHub();
});

