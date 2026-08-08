/**
 * 3D Snake — smooth body following, real meshes
 */

import * as THREE from 'three';

const SEGMENT_SPACING = 0.55;
const BASE_SPEED = 6.5;
const BOOST_MULTIPLIER = 1.7;
const TURN_SPEED = 8.0;
const HEAD_RADIUS = 0.32;
const BODY_RADIUS = 0.28;

export class Snake {
  constructor(scene, options = {}) {
    this.scene = scene;
    this.segments = [];
    this.history = [];
    this.historySpacing = 0.08;
    this.maxHistory = 2000;

    this.direction = new THREE.Vector3(0, 0, -1);
    this.targetDir = new THREE.Vector3(0, 0, -1);
    this.speed = BASE_SPEED;
    this.alive = true;
    this.length = options.startLength || 5;
    this.score = 0;
    this.combo = 1;
    this.comboTimer = 0;

    this.group = new THREE.Group();
    scene.add(this.group);

    this._createMaterials();
    this._spawn();
  }

  _createMaterials() {
    this.headMat = new THREE.MeshStandardMaterial({
      color: 0x00d4ff,
      metalness: 0.4,
      roughness: 0.35,
      emissive: 0x003344,
      emissiveIntensity: 0.3,
    });
    this.bodyMat = new THREE.MeshStandardMaterial({
      color: 0x5e5ce6,
      metalness: 0.25,
      roughness: 0.45,
      emissive: 0x1a1a40,
      emissiveIntensity: 0.15,
    });
    this.eyeMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.4,
    });
  }

  _spawn() {
    while (this.group.children.length) {
      this.group.remove(this.group.children[0]);
    }
    this.segments = [];
    this.history = [];

    const start = new THREE.Vector3(0, 0.35, 4);

    for (let i = 0; i < this.length; i++) {
      const pos = start.clone().add(new THREE.Vector3(0, 0, i * SEGMENT_SPACING));
      const isHead = i === 0;
      const mesh = this._createSegmentMesh(isHead);
      mesh.position.copy(pos);
      this.group.add(mesh);
      this.segments.push({ position: pos.clone(), mesh });
      this.history.push(pos.clone());
    }

    this.direction.set(0, 0, -1);
    this.targetDir.set(0, 0, -1);
    this.alive = true;
  }

  _createSegmentMesh(isHead) {
    const geo = new THREE.SphereGeometry(isHead ? HEAD_RADIUS : BODY_RADIUS, 16, 12);
    const mat = isHead ? this.headMat : this.bodyMat;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    if (isHead) {
      const eyeGeo = new THREE.SphereGeometry(0.07, 8, 6);
      const left = new THREE.Mesh(eyeGeo, this.eyeMat);
      const right = new THREE.Mesh(eyeGeo, this.eyeMat);
      left.position.set(-0.14, 0.12, -0.22);
      right.position.set(0.14, 0.12, -0.22);
      mesh.add(left);
      mesh.add(right);

      const light = new THREE.PointLight(0x00d4ff, 0.6, 4);
      light.position.set(0, 0.2, 0);
      mesh.add(light);
    }

    return mesh;
  }

  setTargetDirection(x, z) {
    if (!this.alive) return;
    const len = Math.sqrt(x * x + z * z) || 1;
    this.targetDir.set(x / len, 0, z / len);
  }

  grow(amount = 1) {
    for (let i = 0; i < amount; i++) {
      const last = this.segments[this.segments.length - 1];
      const pos = last.position.clone();
      const mesh = this._createSegmentMesh(false);
      mesh.position.copy(pos);
      this.group.add(mesh);
      this.segments.push({ position: pos, mesh });
      this.length++;
    }
  }

  update(dt, inputDir, boosting) {
    if (!this.alive) return;

    this.targetDir.set(inputDir.x, 0, inputDir.z).normalize();
    const current = this.direction.clone();
    const target = this.targetDir;

    const cross = current.x * target.z - current.z * target.x;
    const dot = current.x * target.x + current.z * target.z;
    let angle = Math.atan2(cross, dot);
    const maxTurn = TURN_SPEED * dt;
    angle = THREE.MathUtils.clamp(angle, -maxTurn, maxTurn);

    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    this.direction.x = current.x * cos - current.z * sin;
    this.direction.z = current.x * sin + current.z * cos;
    this.direction.normalize();

    this.speed = BASE_SPEED * (boosting ? BOOST_MULTIPLIER : 1);

    const head = this.segments[0];
    const move = this.direction.clone().multiplyScalar(this.speed * dt);
    head.position.add(move);

    this.history.unshift(head.position.clone());
    if (this.history.length > this.maxHistory) {
      this.history.pop();
    }

    let distAccum = 0;
    let histIdx = 0;
    for (let i = 1; i < this.segments.length; i++) {
      const targetDist = i * SEGMENT_SPACING;
      while (histIdx < this.history.length - 1) {
        const a = this.history[histIdx];
        const b = this.history[histIdx + 1];
        const segLen = a.distanceTo(b);
        if (distAccum + segLen >= targetDist) {
          const t = (targetDist - distAccum) / (segLen || 1);
          this.segments[i].position.lerpVectors(a, b, t);
          break;
        }
        distAccum += segLen;
        histIdx++;
      }
      if (histIdx >= this.history.length - 1) {
        this.segments[i].position.copy(this.history[this.history.length - 1] || head.position);
      }
    }

    for (let i = 0; i < this.segments.length; i++) {
      const s = this.segments[i];
      s.mesh.position.copy(s.position);
      if (i === 0) {
        const look = head.position.clone().add(this.direction);
        s.mesh.lookAt(look);
      }
    }

    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 1;
    }
  }

  getHeadPosition() {
    return this.segments[0]?.position.clone() || new THREE.Vector3();
  }

  getHeadMesh() {
    return this.segments[0]?.mesh;
  }

  checkSelfCollision(threshold = 0.35) {
    if (this.segments.length < 8) return false;
    const head = this.segments[0].position;
    for (let i = 6; i < this.segments.length; i++) {
      if (head.distanceTo(this.segments[i].position) < threshold) {
        return true;
      }
    }
    return false;
  }

  die() {
    this.alive = false;
    this.headMat.emissive.setHex(0xff0000);
    this.headMat.emissiveIntensity = 0.8;
  }

  reset(startLength = 5) {
    this.length = startLength;
    this.score = 0;
    this.combo = 1;
    this.comboTimer = 0;
    this.headMat.emissive.setHex(0x003344);
    this.headMat.emissiveIntensity = 0.3;
    this._spawn();
  }

  addScore(points) {
    const gained = Math.floor(points * this.combo);
    this.score += gained;
    this.combo = Math.min(10, this.combo + 0.5);
    this.comboTimer = 2.5;
    return gained;
  }

  dispose() {
    this.scene.remove(this.group);
    this.segments.forEach((s) => {
      s.mesh.geometry?.dispose();
    });
  }
}
