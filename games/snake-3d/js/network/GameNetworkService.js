/**
 * GameNetworkService — interface for multiplayer.
 * Current implementation is a local no-op (offline single-player).
 * Real WebSocket / Supabase Realtime adapter will plug in later
 * without touching the game engine.
 */

export class GameNetworkService {
  constructor() {
    this.connected = false;
    this.roomId = null;
    this.listeners = {
      playerState: new Set(),
      gameEvent: new Set(),
      roomUpdate: new Set(),
      connection: new Set(),
    };
  }

  async createRoom(options = {}) {
    this.roomId = 'local-' + Date.now().toString(36);
    this.connected = false;
    return { roomId: this.roomId, ok: true, mode: 'offline' };
  }

  async joinRoom(roomId) {
    return { ok: false, reason: 'offline_mode' };
  }

  async leaveRoom() {
    this.roomId = null;
    this.connected = false;
  }

  sendPlayerState(_state) {}
  sendGameEvent(_event) {}

  on(event, fn) {
    if (this.listeners[event]) {
      this.listeners[event].add(fn);
    }
    return () => this.listeners[event]?.delete(fn);
  }

  startMatch() {}
  endMatch() {}
  syncScore() {}
  syncWorldState() {}

  async reconnect() {
    return { ok: false };
  }

  disconnect() {
    this.connected = false;
  }

  isOnline() {
    return this.connected;
  }
}
