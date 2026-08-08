/**
 * LoveHubBridge — abstraction over existing LoveHub services.
 * Works standalone when LoveHub is unavailable.
 */

export class LoveHubBridge {
  constructor() {
    this._available = false;
    this._checkAvailability();
  }

  _checkAvailability() {
    this._available = !!(
      typeof window !== 'undefined' &&
      (window.LoveHubAuth || window.LoveHubCouple || window.LoveHubProfile)
    );
  }

  isAvailable() {
    return this._available;
  }

  getCurrentUser() {
    if (window.LoveHubAuth?.getUser) {
      return window.LoveHubAuth.getUser();
    }
    if (window.LoveHubProfile?.getProfile) {
      return window.LoveHubProfile.getProfile();
    }
    return {
      id: 'local-player',
      name: localStorage.getItem('snake3d_player_name') || 'Player',
      avatar: null,
    };
  }

  getPartner() {
    if (window.LoveHubCouple?.getPartner) {
      return window.LoveHubCouple.getPartner();
    }
    return null;
  }

  getCouple() {
    if (window.LoveHubCouple?.getCouple) {
      return window.LoveHubCouple.getCouple();
    }
    return null;
  }

  getAvatar() {
    const user = this.getCurrentUser();
    return user?.avatar || null;
  }

  getLanguage() {
    return localStorage.getItem('snake3d_lang') || 'en';
  }

  getTheme() {
    return document.body.classList.contains('theme-day') ? 'day' : 'night';
  }

  async getPlayerStats() {
    try {
      const raw = localStorage.getItem('snake3d_stats');
      return raw ? JSON.parse(raw) : this._defaultStats();
    } catch {
      return this._defaultStats();
    }
  }

  async savePlayerStats(stats) {
    localStorage.setItem('snake3d_stats', JSON.stringify(stats));
  }

  async submitScore(score, meta = {}) {
    const stats = await this.getPlayerStats();
    if (score > (stats.bestScore || 0)) {
      stats.bestScore = score;
    }
    stats.gamesPlayed = (stats.gamesPlayed || 0) + 1;
    stats.totalScore = (stats.totalScore || 0) + score;
    await this.savePlayerStats(stats);
    return stats;
  }

  _defaultStats() {
    return {
      bestScore: 0,
      gamesPlayed: 0,
      totalScore: 0,
      level: 1,
      xp: 0,
      coins: 0,
      sectorTokens: 0,
      unlockedSkins: ['classic'],
      achievements: [],
      worldProgress: { sectorCity: { stars: 0, levels: {} } },
    };
  }

  async invitePartner() {
    console.warn('[LoveHubBridge] invitePartner not yet connected');
    return { ok: false, reason: 'not_implemented' };
  }

  async startCoupleGame() {
    return { ok: false, reason: 'not_implemented' };
  }

  async joinCoupleGame() {
    return { ok: false, reason: 'not_implemented' };
  }
}
