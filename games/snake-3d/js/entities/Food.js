/**
 * Collectible food / crystals
 */

import * as THREE from 'three';

export class Food {
  constructor(scene, position, type = 'normal') {
    this.scene = scene;
    this.type = type;
    this.alive = true;
    this.value = type === 'crystal' ? 5 : 1;
    this.growAmount = type === 'crystal' ? 2 : 1;

    const color = type === 'crystal' ? 0xffd700 : 0xff375f;
    const geo = type === 'crystal'
      ? new THREE.OctahedronGeometry(0.28, 0)
      : new THREE.SphereGeometry(0.22, 12, 10);

    this.mat = new THREE.MeshStandardMaterial({
      color,
      metalness: 0.5,
      roughness: 0.3,
      emissive: color,
      emissiveIntensity: 0.45,
    });

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.castShadow = true;
    this.mesh.position.copy(position);
    this.mesh.position.y = 0.35;

    this.light = new THREE.PointLight(color, 0.5, 3);
    this.mesh.add(this.light);

    scene.add(this.mesh);

    this.baseY = 0.35;
    this.phase = Math.random() * Math.PI * 2;
  }

  update(dt, time) {
    if (!this.alive) return;
    this.mesh.position.y = this.baseY + Math.sin(time * 3 + this.phase) * 0.12;
    this.mesh.rotation.y += dt * 2;
    if (this.type === 'crystal') {
      this.mesh.rotation.x += dt * 1.2;
    }
  }

  getPosition() {
    return this.mesh.position;
  }

  collect() {
    this.alive = false;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }

  dispose() {
    if (this.alive) this.collect();
  }
}

export function spawnFood(scene, bounds = 18, existing = []) {
  let pos;
  let attempts = 0;
  do {
    pos = new THREE.Vector3(
      (Math.random() - 0.5) * bounds * 2,
      0.35,
      (Math.random() - 0.5) * bounds * 2
    );
    attempts++;
  } while (
    attempts < 20 &&
    existing.some((f) => f.alive && f.getPosition().distanceTo(pos) < 2)
  );

  const type = Math.random() < 0.12 ? 'crystal' : 'normal';
  return new Food(scene, pos, type);
}
