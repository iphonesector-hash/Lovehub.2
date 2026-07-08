class AuthService {
    constructor() {
        this.SESSION_KEY = 'session';
        this.USERS_KEY = 'users';
        
        // Default users for demo
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

    init() {
        // Seed default users if none exist
        const existing = storage.get(this.USERS_KEY);
        if (!existing) {
            storage.set(this.USERS_KEY, this.defaultUsers);
        }
    }

    login(username, password) {
        const users = storage.get(this.USERS_KEY) || this.defaultUsers;
        const user = users.find(u => 
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
        
        const users = storage.get(this.USERS_KEY) || this.defaultUsers;
        const user = users.find(u => u.id === session.userId);
        return user ? this.sanitizeUser(user) : null;
    }

    changePassword(userId, oldPassword, newPassword) {
        const users = storage.get(this.USERS_KEY) || this.defaultUsers;
        const user = users.find(u => u.id === userId);
        
        if (!user) return { success: false, error: 'User not found' };
        if (user.password !== oldPassword) return { success: false, error: 'Current password is incorrect' };
        
        user.password = newPassword;
        storage.set(this.USERS_KEY, users);
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

