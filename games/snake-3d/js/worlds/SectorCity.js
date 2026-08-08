/**
 * Sector City — first playable 3D world
 * Futuristic technological arena
 */

import * as THREE from 'three';

export class SectorCity {
  constructor(scene) {
    this.scene = scene;
    this.bounds = 20;
    this.obstacles = [];
    this.group = new THREE.Group();
    scene.add(this.group);
    this._build();
  }

  _build() {
    const groundGeo = new THREE.PlaneGeometry(this.bounds * 2.4, this.bounds * 2.4, 32, 32);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x0c0c18,
      metalness: 0.6,
      roughness: 0.7,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.group.add(ground);

    const grid = new THREE.GridHelper(this.bounds * 2, 40, 0x00d4ff, 0x1a1a30);
    grid.position.y = 0.01;
    grid.material.opacity = 0.25;
    grid.material.transparent = true;
    this.group.add(grid);

    this._createBoundary();
    this._createDecor();
    this._createAmbient();

    const ambientAccent = new THREE.PointLight(0x00d4ff, 0.4, 30);
    ambientAccent.position.set(0, 8, 0);
    this.group.add(ambientAccent);

    const accent2 = new THREE.PointLight(0x5e5ce6, 0.3, 25);
    accent2.position.set(10, 5, -10);
    this.group.add(accent2);
  }

  _createBoundary() {
    const wallHeight = 1.2;
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x111122,
      metalness: 0.7,
      roughness: 0.4,
      emissive: 0x003344,
      emissiveIntensity: 0.15,
      transparent: true,
      opacity: 0.85,
    });

    const thickness = 0.4;
    const size = this.bounds * 2;

    const sides = [
      { w: size + thickness * 2, d: thickness, x: 0, z: -this.bounds - thickness / 2 },
      { w: size + thickness * 2, d: thickness, x: 0, z: this.bounds + thickness / 2 },
      { w: thickness, d: size, x: -this.bounds - thickness / 2, z: 0 },
      { w: thickness, d: size, x: this.bounds + thickness / 2, z: 0 },
    ];

    sides.forEach((s) => {
      const geo = new THREE.BoxGeometry(s.w, wallHeight, s.d);
      const mesh = new THREE.Mesh(geo, wallMat);
      mesh.position.set(s.x, wallHeight / 2, s.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.obstacles.push({
        type: 'wall',
        minX: s.x - s.w / 2,
        maxX: s.x + s.w / 2,
        minZ: s.z - s.d / 2,
        maxZ: s.z + s.d / 2,
      });
    });

    const edgeMat = new THREE.LineBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0.6 });
    const edgePoints = [
      new THREE.Vector3(-this.bounds, 0.05, -this.bounds),
      new THREE.Vector3(this.bounds, 0.05, -this.bounds),
      new THREE.Vector3(this.bounds, 0.05, this.bounds),
      new THREE.Vector3(-this.bounds, 0.05, this.bounds),
      new THREE.Vector3(-this.bounds, 0.05, -this.bounds),
    ];
    const edgeGeo = new THREE.BufferGeometry().setFromPoints(edgePoints);
    const edge = new THREE.Line(edgeGeo, edgeMat);
    this.group.add(edge);
  }

  _createDecor() {
    const pillarMat = new THREE.MeshStandardMaterial({
      color: 0x151528,
      metalness: 0.8,
      roughness: 0.3,
      emissive: 0x002233,
      emissiveIntensity: 0.2,
    });

    const positions = [
      [-12, -12], [12, -12], [-12, 12], [12, 12],
      [-8, 0], [8, 0], [0, -8], [0, 8],
    ];

    positions.forEach(([x, z]) => {
      const h = 1.5 + Math.random() * 2;
      const geo = new THREE.CylinderGeometry(0.35, 0.45, h, 8);
      const mesh = new THREE.Mesh(geo, pillarMat);
      mesh.position.set(x, h / 2, z);
      mesh.castShadow = true;
      this.group.add(mesh);

      this.obstacles.push({
        type: 'pillar',
        minX: x - 0.5,
        maxX: x + 0.5,
        minZ: z - 0.5,
        maxZ: z + 0.5,
      });

      const light = new THREE.PointLight(0x00d4ff, 0.35, 6);
      light.position.set(x, h + 0.3, z);
      this.group.add(light);
    });
  }

  _createAmbient() {
    const count = 40;
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * this.bounds * 2;
      positions[i * 3 + 1] = 1 + Math.random() * 6;
      positions[i * 3 + 2] = (Math.random() - 0.5) * this.bounds * 2;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0x00d4ff,
      size: 0.08,
      transparent: true,
      opacity: 0.6,
    });
    this.particles = new THREE.Points(geo, mat);
    this.group.add(this.particles);
  }

  checkCollision(pos, radius = 0.3) {
    if (
      Math.abs(pos.x) > this.bounds - radius ||
      Math.abs(pos.z) > this.bounds - radius
    ) {
      return true;
    }

    for (const o of this.obstacles) {
      if (
        pos.x + radius > o.minX &&
        pos.x - radius < o.maxX &&
        pos.z + radius > o.minZ &&
        pos.z - radius < o.maxZ
      ) {
        return true;
      }
    }
    return false;
  }

  update(dt, time) {
    if (this.particles) {
      this.particles.rotation.y += dt * 0.05;
    }
  }

  dispose() {
    this.scene.remove(this.group);
  }
}
