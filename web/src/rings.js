// rings.js
// Checkpoint ring course: fly through every ring to finish.
// Rings glow amber when next, green once passed; a chime plays on each pass.

import * as THREE from 'three';
import { terrainHeight } from './scene-builder.js';

const RING_POSITIONS = [
  [0, 4, -22], [18, 6, -45], [45, 9, -60], [75, 7, -40],
  [90, 10, 0], [70, 13, 40], [30, 9, 60], [-15, 7, 65],
  [-55, 8, 40], [-70, 6, -5],
];

export class RingCourse {
  constructor(scene) {
    this.scene = scene;
    this.rings = [];
    this.nextIndex = 0;
    this.startedAt = null;
    this.finishedMs = null;
    this.bestMs = Number(localStorage.getItem('drone-best-ms')) || null;

    this._audio = null;

    RING_POSITIONS.forEach(([x, y, z]) => this._addRing(x, y, z));
    this._updateGlow();
  }

  _addRing(x, y, z) {
    const geo = new THREE.TorusGeometry(2.6, 0.14, 12, 48);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x333a44,
      emissive: 0xffa500,
      emissiveIntensity: 0.0,
      roughness: 0.4,
      metalness: 0.6,
    });
    const ring = new THREE.Mesh(geo, mat);
    const ground = terrainHeight ? terrainHeight(x, z) : 0;
    ring.position.set(x, Math.max(y, ground + y * 0.75 + 1.2), z);
    // Face roughly toward the previous ring / start so the course flows.
    ring.rotation.y = Math.atan2(x, z) + Math.PI / 2;
    ring.castShadow = true;
    this.scene.add(ring);
    this.rings.push(ring);
  }

  get total() { return this.rings.length; }
  get passed() { return this.nextIndex; }
  get finished() { return this.finishedMs !== null; }

  elapsedMs(now) {
    if (this.startedAt === null) return 0;
    if (this.finishedMs !== null) return this.finishedMs;
    return now - this.startedAt;
  }

  reset() {
    this.nextIndex = 0;
    this.startedAt = null;
    this.finishedMs = null;
    this.rings.forEach((r) => { r.userData.passed = false; });
    this._updateGlow();
  }

  // Called each frame with the drone position (THREE.Vector3-like) and ms time.
  update(pos, now) {
    if (this.finished || this.nextIndex >= this.rings.length) return null;
    const ring = this.rings[this.nextIndex];
    const dx = pos.x - ring.position.x;
    const dy = pos.y - ring.position.y;
    const dz = pos.z - ring.position.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (dist < 2.6) {
      if (this.startedAt === null) this.startedAt = now;
      ring.userData.passed = true;
      this.nextIndex++;
      this._chime(this.nextIndex);
      this._updateGlow();
      if (this.nextIndex >= this.rings.length) {
        this.finishedMs = now - this.startedAt;
        if (this.bestMs === null || this.finishedMs < this.bestMs) {
          this.bestMs = this.finishedMs;
          localStorage.setItem('drone-best-ms', String(Math.round(this.bestMs)));
        }
        return { type: 'finished', ms: this.finishedMs };
      }
      return { type: 'passed', count: this.nextIndex };
    }
    return null;
  }

  _updateGlow() {
    this.rings.forEach((ring, i) => {
      if (ring.userData.passed) {
        ring.material.emissive.setHex(0x39ff7a);
        ring.material.emissiveIntensity = 0.9;
      } else if (i === this.nextIndex) {
        ring.material.emissive.setHex(0xffa500);
        ring.material.emissiveIntensity = 1.6;
      } else {
        ring.material.emissive.setHex(0xffa500);
        ring.material.emissiveIntensity = 0.15;
      }
    });
  }

  _chime(step) {
    try {
      if (!this._audio) this._audio = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this._audio;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 520 + step * 40; // pitch climbs with progress
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    } catch { /* audio unavailable — ignore */ }
  }
}
