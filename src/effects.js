// STUB — owned by Agent 3 (Hazards & FX). Replace bodies, keep signatures. See ARCHITECTURE.md §4.5.
// Effects subscribes ITSELF to bus events in the constructor (coin:collected, player:hit,
// powerup:collected, shield:break, player:land, game:start) and unsubscribes in dispose().
import * as THREE from 'three';

export class Effects {
  /** @param {THREE.Scene} scene @param {THREE.PerspectiveCamera} camera */
  constructor(scene, camera) { this.scene = scene; this.camera = camera; }
  /** Particle burst. @param {{x:number,y:number,z:number}} position
   *  @param {{ color?: number, count?: number, speed?: number, life?: number, size?: number }} [opts] */
  burst(position, opts = {}) {}
  /** Start/boost camera shake. @param {number} amplitude m @param {number} [decay] 1/s */
  shake(amplitude, decay) {}
  /** Advance particles (particles also scroll +z with the world) and shake. @param {number} dt @param {number} speed */
  update(dt, speed) {}
  /** Add the current shake offset to camera.position. Call AFTER game.js has set the base camera pose each frame. @param {THREE.Camera} camera */
  applyCameraShake(camera) {}
  /** Kill all particles and shake. */
  reset() {}
  dispose() {}
}
