/**
 * LoveHub Snake 3D — Sector Edition
 * Entry point
 */

import { GameEngine, GameState } from './engine/GameEngine.js';
import { I18n } from './i18n/I18n.js';
import { LoveHubBridge } from './integration/LoveHubBridge.js';
import { GameNetworkService } from './network/GameNetworkService.js';

class Snake3DApp {
  constructor() {
    this.i18n = new I18n();
    this.bridge = new LoveHubBridge();
    this.network = new GameNetworkService();
    this.engine = null;
    this.stats = null;

    this.els = {
      loading: document.getElementById('screen-loading'),
      menu: document.getElementById('screen-menu'),
      pause: document.getElementById('screen-pause'),
      gameover: document.getElementById('screen-gameover'),
      hud: document.getElementById('hud'),
      score: document.getElementById('score-value'),
      combo: document.getElementById('combo-display'),
      comboValue: document.getElementById('combo-value'),
      finalScore: document.getElementById('final-score'),
      finalBest: document.getElementById('final-best'),
      bestScore: document.getElementById('best-score'),
      playerLevel: document.getElementById('player-level'),
      coins: document.getElementById('coins'),
      loadingFill: document.getElementById('loading-fill'),
    };

    this._bindUI();
    this.i18n.apply();
  }

  async start() {
    this._setProgress(10);
    await this._loadStats();
    this._setProgress(40);

    const container = document.getElementById('canvas-container');
    this.engine = new GameEngine(container, {
      onStateChange: (s) => this._onState(s),
      onScore: (score, combo) => this._onScore(score, combo),
      onGameOver: (data) => this._onGameOver(data),
    });

    this._setProgress(70);
    await this.engine.init();
    this._setProgress(100);

    await new Promise((r) => setTimeout(r, 300));
    this.engine.startLoop();
    this._showScreen('menu');
    this._updateMenuStats();
  }

  async _loadStats() {
    this.stats = await this.bridge.getPlayerStats();
  }

  _setProgress(p) {
    if (this.els.loadingFill) {
      this.els.loadingFill.style.width = p + '%';
    }
  }

  _bindUI() {
    document.getElementById('btn-play')?.addEventListener('click', () => this._play());
    document.getElementById('btn-resume')?.addEventListener('click', () => this.engine.resume());
    document.getElementById('btn-restart')?.addEventListener('click', () => this._play());
    document.getElementById('btn-quit')?.addEventListener('click', () => this._toMenu());
    document.getElementById('btn-retry')?.addEventListener('click', () => this._play());
    document.getElementById('btn-menu')?.addEventListener('click', () => this._toMenu());
    document.getElementById('btn-pause')?.addEventListener('click', () => this.engine.pause());

    document.getElementById('btn-lang-en')?.addEventListener('click', () => {
      this.i18n.setLanguage('en');
      this._updateLangButtons();
    });
    document.getElementById('btn-lang-fa')?.addEventListener('click', () => {
      this.i18n.setLanguage('fa');
      this._updateLangButtons();
    });

    document.getElementById('btn-worlds')?.addEventListener('click', () => {
      alert(this.i18n.t('worlds') + ' — coming in next phase');
    });
    document.getElementById('btn-customize')?.addEventListener('click', () => {
      alert(this.i18n.t('customize') + ' — coming in next phase');
    });
    document.getElementById('btn-settings')?.addEventListener('click', () => {
      alert(this.i18n.t('settings') + ' — coming in next phase');
    });

    this._updateLangButtons();
  }

  _updateLangButtons() {
    document.getElementById('btn-lang-en')?.classList.toggle('active', this.i18n.language === 'en');
    document.getElementById('btn-lang-fa')?.classList.toggle('active', this.i18n.language === 'fa');
  }

  _showScreen(name) {
    ['loading', 'menu', 'pause', 'gameover'].forEach((n) => {
      this.els[n]?.classList.toggle('hidden', n !== name);
    });
    this.els.hud?.classList.toggle('hidden', name !== null && name !== 'playing');
  }

  _onState(state) {
    switch (state) {
      case GameState.MENU:
        this._showScreen('menu');
        this.els.hud?.classList.add('hidden');
        break;
      case GameState.PLAYING:
        this._showScreen(null);
        this.els.loading?.classList.add('hidden');
        this.els.menu?.classList.add('hidden');
        this.els.pause?.classList.add('hidden');
        this.els.gameover?.classList.add('hidden');
        this.els.hud?.classList.remove('hidden');
        break;
      case GameState.PAUSED:
        this.els.pause?.classList.remove('hidden');
        break;
      case GameState.GAMEOVER:
        this.els.gameover?.classList.remove('hidden');
        this.els.hud?.classList.add('hidden');
        break;
    }
  }

  _onScore(score, combo) {
    if (this.els.score) this.els.score.textContent = score;
    if (combo > 1) {
      this.els.combo?.classList.remove('hidden');
      if (this.els.comboValue) this.els.comboValue.textContent = 'x' + Math.floor(combo);
    } else {
      this.els.combo?.classList.add('hidden');
    }
  }

  async _onGameOver({ score }) {
    if (this.els.finalScore) this.els.finalScore.textContent = score;
    const updated = await this.bridge.submitScore(score);
    this.stats = updated;
    if (this.els.finalBest) this.els.finalBest.textContent = updated.bestScore;
    this._updateMenuStats();
  }

  _updateMenuStats() {
    if (!this.stats) return;
    if (this.els.bestScore) this.els.bestScore.textContent = this.stats.bestScore || 0;
    if (this.els.playerLevel) this.els.playerLevel.textContent = this.stats.level || 1;
    if (this.els.coins) this.els.coins.textContent = this.stats.coins || 0;
  }

  _play() {
    if (this.els.score) this.els.score.textContent = '0';
    this.els.combo?.classList.add('hidden');
    this.engine.startGame();
  }

  _toMenu() {
    this.engine.setState(GameState.MENU);
    this._updateMenuStats();
  }
}

const app = new Snake3DApp();
app.start().catch((err) => {
  console.error('[Snake3D] boot failed', err);
  const tip = document.getElementById('loading-tip');
  if (tip) tip.textContent = 'Failed to load. Please refresh.';
});
