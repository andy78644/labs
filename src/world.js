// STUB — owned by Agent 1 (World). Replace bodies, keep signatures. See ARCHITECTURE.md §4.1.
import * as THREE from 'three';
import { CONFIG } from './config.js';

export class World {
  /**
   * Builds everything static/scenic: sky, sun, mountains, neon grid ground, track,
   * side scenery chunks, lights, fog, and the bloom post-processing chain.
   * @param {{ renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera }} deps
   */
  constructor({ renderer, scene, camera }) {
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    scene.background = new THREE.Color(CONFIG.colors.background);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x220044, 1.5));
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(CONFIG.lanes.trackWidth, 400), new THREE.MeshBasicMaterial({ color: CONFIG.colors.track }));
    ground.rotation.x = -Math.PI / 2; ground.position.z = -150; scene.add(ground);
  }
  /** Scroll scenery toward +z by speed*dt; recycle chunks. @param {number} dt @param {number} speed m/s */
  update(dt, speed) {}
  /** Draw the frame (through the bloom composer in the real implementation). */
  render() { this.renderer.render(this.scene, this.camera); }
  /** Called after renderer.setSize / camera.aspect update. @param {number} w css px @param {number} h css px */
  resize(w, h) {}
  /** Restore initial scroll state (new run). */
  reset() {}
  /** Release GPU resources. */
  dispose() {}
}
