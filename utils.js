const Utils = {
    calculateDaysTogether(startDate) {
        const start = new Date(startDate);
        const now = new Date();
        const diffTime = Math.abs(now - start);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return diffDays;
    },
    
    getGreeting() {
        const hour = new Date().getHours();
        if (hour < 12) return 'Good morning';
        if (hour < 18) return 'Good afternoon';
        return 'Good evening';
    },
    
    formatTime(timestamp) {
        const date = new Date(timestamp);
        const hours = date.getHours();
        const minutes = date.getMinutes();
        const ampm = hours >= 12 ? 'PM' : 'AM';
        const displayHours = hours % 12 || 12;
        const displayMinutes = minutes.toString().padStart(2, '0');
        return `${displayHours}:${displayMinutes} ${ampm}`;
    },
    
    formatDate(dateString) {
        const date = new Date(dateString);
        const options = { year: 'numeric', month: 'long', day: 'numeric' };
        return date.toLocaleDateString('en-US', options);
    },
    
    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    },
    
    saveToStorage(key, data) {
        try {
            localStorage.setItem(`lovehub_${key}`, JSON.stringify(data));
            return true;
        } catch (error) {
            console.error('Error saving to localStorage:', error);
            return false;
        }
    },
    
    loadFromStorage(key) {
        try {
            const data = localStorage.getItem(`lovehub_${key}`);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            console.error('Error loading from localStorage:', error);
            return null;
        }
    },
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },
    
    hapticFeedback(pattern = [10]) {
        if (navigator.vibrate) {
            navigator.vibrate(pattern);
        }
    },
    
    showToast(message, duration = 3000) {
        const container = document.getElementById('toastContainer');
        if (!container) {
            console.warn('Toast container not found');
            return;
        }
        
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        container.appendChild(toast);
        
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });
        
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                if (container.contains(toast)) {
                    container.removeChild(toast);
                }
            }, 400);
        }, duration);
    }
};

class ApiService {
    constructor() {
        this.baseUrl = '';
        this.ws = null;
    }

    async login(username, password) {
        return new Promise(resolve => {
            setTimeout(() => {
                resolve({ success: true, user: { name: username } });
            }, 500);
        });
    }

    async logout() {
        return new Promise(resolve => {
            setTimeout(() => {
                resolve({ success: true });
            }, 300);
        });
    }

    async fetchMessages() {
        return Utils.loadFromStorage('messages') || LoveHubData.messages;
    }

    async sendMessage(message) {
        const messages = Utils.loadFromStorage('messages') || [];
        messages.push(message);
        Utils.saveToStorage('messages', messages);
        return message;
    }

    connectWebSocket(onMessageCallback) {
        console.log('WebSocket connection placeholder initialized.');
    }

    async fetchMemories() {
        return LoveHubData.memories;
    }

    async uploadMemory(memoryData) {
        return new Promise(resolve => {
            setTimeout(() => {
                resolve({ success: true, id: Utils.generateId() });
            }, 1000);
        });
    }

    async requestNotificationPermission() {
        if ('Notification' in window) {
            return Notification.requestPermission();
        }
        return 'denied';
    }
}

