/**
 * GameEngine — core loop, rendering, state machine
 */

import * as THREE from 'three';
import { Snake } from '../entities/Snake.js';
import { spawnFood } from '../entities/Food.js';
import { SectorCity } from '../worlds/SectorCity.js';
import { InputSystem } from '../systems/InputSystem.js';

export const GameState = {
  LOADING: 'loading',
  MENU: 'menu',
  PLAYING: 'playing',
  PAUSED: 'paused',
  GAMEOVER: 'gameover',
};

export class GameEngine {
  constructor(container, options = {}) {
    this.container = container;
    this.options = options;
    this.state = GameState.LOADING;
    this.clock = new THREE.Clock();
    this.time = 0;
    this.foods = [];
    this.maxFood = 6;

    this.onStateChange = options.onStateChange || (() => {});
    this.onScore = options.onScore || (() => {});
    this.onGameOver = options.onGameOver || (() => {});

    this._initRenderer();
    this._initScene();
    this._initCamera();
    this._initLights();
    this.input = new InputSystem(document.getElementById('game-root'));
    this.world = null;
    this.snake = null;

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);
    this._onResize();

    this._raf = null;
    this._running = false;
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.container.appendChild(this.renderer.domElement);
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x07070f);
    this.scene.fog = new THREE.FogExp2(0x07070f, 0.028);
  }

  _initCamera() {
    const aspect = this.container.clientWidth / Math.max(1, this.container.clientHeight);
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.1, 120);
    this.camera.position.set(0, 12, 14);
    this.camera.lookAt(0, 0, 0);
    this.cameraLerp = 4.5;
  }

  _initLights() {
    const hemi = new THREE.HemisphereLight(0x4a4a80, 0x0a0a12, 0.55);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffffff, 0.85);
    dir.position.set(8, 18, 10);
    dir.castShadow = true;
    dir.shadow.mapSize.set(1024, 1024);
    dir.shadow.camera.near = 1;
    dir.shadow.camera.far = 50;
    dir.shadow.camera.left = -25;
    dir.shadow.camera.right = 25;
    dir.shadow.camera.top = 25;
    dir.shadow.camera.bottom = -25;
    dir.shadow.bias = -0.001;
    this.scene.add(dir);
  }

  async init() {
    this.world = new SectorCity(this.scene);
    this.snake = new Snake(this.scene, { startLength: 5 });
    this._spawnFoods();
    this.setState(GameState.MENU);
  }

  _spawnFoods() {
    while (this.foods.length < this.maxFood) {
      const f = spawnFood(this.scene, this.world.bounds - 2, this.foods);
      this.foods.push(f);
    }
  }

  startGame() {
    this.snake.reset(5);
    this.foods.forEach((f) => f.dispose());
    this.foods = [];
    this._spawnFoods();
    this.input.setEnabled(true);
    this.input.showJoystick(this._isTouchDevice());
    this.setState(GameState.PLAYING);
    this.clock.start();
  }

  pause() {
    if (this.state !== GameState.PLAYING) return;
    this.setState(GameState.PAUSED);
    this.input.setEnabled(false);
  }

  resume() {
    if (this.state !== GameState.PAUSED) return;
    this.setState(GameState.PLAYING);
    this.input.setEnabled(true);
    this.clock.start();
  }

  gameOver() {
    this.snake.die();
    this.input.setEnabled(false);
    this.setState(GameState.GAMEOVER);
    this.onGameOver({
      score: this.snake.score,
      length: this.snake.length,
    });
  }

  setState(s) {
    this.state = s;
    this.onStateChange(s);
  }

  startLoop() {
    if (this._running) return;
    this._running = true;
    this.clock.start();
    this._loop();
  }

  stopLoop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  _loop = () => {
    if (!this._running) return;
    this._raf = requestAnimationFrame(this._loop);

    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.time += dt;

    if (this.state === GameState.PLAYING) {
      this._updateGameplay(dt);
    }

    this._updateCamera(dt);
    if (this.world) this.world.update(dt, this.time);
    this.foods.forEach((f) => f.update(dt, this.time));

    this.renderer.render(this.scene, this.camera);
  };

  _updateGameplay(dt) {
    this.input.update(dt);
    const dir = this.input.getDirection();
    const boosting = this.input.isBoosting();

    this.snake.setTargetDirection(dir.x, dir.z);
    this.snake.update(dt, dir, boosting);

    const headPos = this.snake.getHeadPosition();
    if (this.world.checkCollision(headPos, 0.3)) {
      this.gameOver();
      return;
    }

    if (this.snake.checkSelfCollision()) {
      this.gameOver();
      return;
    }

    for (let i = this.foods.length - 1; i >= 0; i--) {
      const f = this.foods[i];
      if (!f.alive) continue;
      if (headPos.distanceTo(f.getPosition()) < 0.55) {
        this.snake.addScore(f.value * 10);
        this.snake.grow(f.growAmount);
        f.collect();
        this.foods.splice(i, 1);
        this.onScore(this.snake.score, this.snake.combo);
        if (navigator.vibrate) navigator.vibrate(15);
      }
    }

    this._spawnFoods();
  }

  _updateCamera(dt) {
    if (!this.snake) return;
    const head = this.snake.getHeadPosition();
    const dir = this.snake.direction;

    const desired = head.clone()
      .add(new THREE.Vector3(-dir.x * 8, 0, -dir.z * 8))
      .add(new THREE.Vector3(0, 8.5, 0));

    this.camera.position.lerp(desired, 1 - Math.exp(-this.cameraLerp * dt));

    const lookAt = head.clone().add(dir.clone().multiplyScalar(3));
    lookAt.y += 0.4;

    if (!this._lookTarget) this._lookTarget = lookAt.clone();
    this._lookTarget.lerp(lookAt, 1 - Math.exp(-5 * dt));
    this.camera.lookAt(this._lookTarget);
  }

  _isTouchDevice() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  }

  _onResize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  getScore() {
    return this.snake?.score || 0;
  }

  getCombo() {
    return this.snake?.combo || 1;
  }

  dispose() {
    this.stopLoop();
    window.removeEventListener('resize', this._onResize);
    this.input.dispose();
    this.snake?.dispose();
    this.world?.dispose();
    this.foods.forEach((f) => f.dispose());
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}
