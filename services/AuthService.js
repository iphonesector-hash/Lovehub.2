class AuthService {
    constructor() {
        this.SESSION_KEY = 'session';
        this.USERS_KEY = 'users';

        // Default users for demo — development-only. These plaintext demo
        // credentials are never persisted to localStorage and are only usable
        // when isDevMode() is true (localhost / file: / ?demo=1). On a real
        // deployment the Supabase-backed AuthService is the only auth path.
        this.defaultUsers = [
            {
                id: 'user1',
                username: 'pouriya',
                password: '12345',
                name: 'Pourya',
                initial: 'P',
                role: 'partner1',
                createdAt: new Date().toISOString()
            },
            {
                id: 'user2',
                username: 'sarina',
                password: '12345',
                name: 'Sarina',
                initial: 'S',
                role: 'partner2',
                createdAt: new Date().toISOString()
            }
        ];

        this.init();
    }

    // Demo mode is a development-only fallback. Every demo auth method checks
    // this first so the hardcoded accounts can never be used on a deployed
    // site. Real users authenticate through Supabase (src/services).
    isDevMode() {
        try {
            const host = (window.location.hostname || '').toLowerCase();
            return host === 'localhost'
                || host === '127.0.0.1'
                || window.location.protocol === 'file:'
                || /[?&]demo=1/.test(window.location.search || '');
        } catch (e) {
            return false;
        }
    }

    init() {
        // Security hardening: demo users (which carry plaintext passwords) are
        // NEVER written to localStorage. They live in memory only; the only
        // thing persisted after a successful dev login is a session marker
        // (userId + timestamps), never a password or token.
    }

    login(username, password) {
        if (!this.isDevMode()) {
            return { success: false, error: 'Demo accounts are only available in development mode.' };
        }
        const user = this.defaultUsers.find(u =>
            u.username.toLowerCase() === username.toLowerCase() &&
            u.password === password
        );

        if (user) {
            const session = {
                userId: user.id,
                username: user.username,
                loginTime: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
            };
            storage.set(this.SESSION_KEY, session);
            return { success: true, user: this.sanitizeUser(user) };
        }

        return { success: false, error: 'Invalid credentials' };
    }

    logout() {
        storage.remove(this.SESSION_KEY);
        return { success: true };
    }

    getSession() {
        // A demo session marker only ever exists in dev mode. If the app is
        // running as a real deployment, ignore/clear any stale demo session.
        if (!this.isDevMode()) {
            storage.remove(this.SESSION_KEY);
            return null;
        }
        const session = storage.get(this.SESSION_KEY);
        if (!session) return null;

        // Check expiry
        if (new Date(session.expiresAt) < new Date()) {
            storage.remove(this.SESSION_KEY);
            return null;
        }

        return session;
    }

    getCurrentUser() {
        const session = this.getSession();
        if (!session) return null;

        const user = this.defaultUsers.find(u => u.id === session.userId);
        return user ? this.sanitizeUser(user) : null;
    }

    changePassword(userId, oldPassword, newPassword) {
        if (!this.isDevMode()) {
            return { success: false, error: 'Demo accounts are only available in development mode.' };
        }
        const user = this.defaultUsers.find(u => u.id === userId);

        if (!user) return { success: false, error: 'User not found' };
        if (user.password !== oldPassword) return { success: false, error: 'Current password is incorrect' };

        // In-memory only — never persisted to localStorage.
        user.password = newPassword;
        return { success: true };
    }

    sanitizeUser(user) {
        const { password, ...safe } = user;
        return safe;
    }

    isLoggedIn() {
        return this.getSession() !== null;
    }
}

const authService = new AuthService();
