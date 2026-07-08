class StorageService {
    constructor() {
        this.PREFIX = 'lovehub_';
        this.VERSION = '1.0.0';
    }

    get(key) {
        try {
            const raw = localStorage.getItem(this.PREFIX + key);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            console.error('StorageService.get error:', e);
            return null;
        }
    }

    set(key, value) {
        try {
            localStorage.setItem(this.PREFIX + key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.error('StorageService.set error:', e);
            return false;
        }
    }

    remove(key) {
        try {
            localStorage.removeItem(this.PREFIX + key);
            return true;
        } catch (e) {
            return false;
        }
    }

    clear() {
        try {
            const keys = Object.keys(localStorage).filter(k => k.startsWith(this.PREFIX));
            keys.forEach(k => localStorage.removeItem(k));
            return true;
        } catch (e) {
            return false;
        }
    }

    exportAll() {
        const data = {};
        const keys = Object.keys(localStorage).filter(k => k.startsWith(this.PREFIX));
        keys.forEach(k => {
            data[k.replace(this.PREFIX, '')] = this.get(k.replace(this.PREFIX, ''));
        });
        return data;
    }

    importAll(data) {
        Object.keys(data).forEach(key => {
            this.set(key, data[key]);
        });
    }
}

const storage = new StorageService();

