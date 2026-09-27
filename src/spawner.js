// STUB — owned by Agent 3 (Hazards & FX). Replace bodies, keep signatures. See ARCHITECTURE.md §4.4.
import * as THREE from 'three';
import { CONFIG } from './config.js';

/**
 * @typedef {'barrier'|'bar'|'wall'} ObstacleType
 * @typedef {'magnet'|'shield'|'double'} PowerupType
 * @typedef {{ kind: 'obstacle', type: ObstacleType, id: number, position: THREE.Vector3 }
 *         | { kind: 'coin', id: number, position: THREE.Vector3 }
 *         | { kind: 'powerup', type: PowerupType, id: number, position: THREE.Vector3 }} Hit
 */

export class Spawner {
  /** @param {THREE.Scene} scene */
  constructor(scene) { this.scene = scene; this.enabled = true; }
  /** Recycle every active object back into its pool; next row at CONFIG.spawner.firstRowZ. */
  reset() {}
  /**
   * Move all active objects +z by speed*dt, recycle those past despawnZ, spawn new rows
   * so that there is always content out to spawnZ, animate coins/powerups, apply magnet pull.
   * @param {number} dt @param {number} speed m/s
   * @param {{ distance: number, playerPos: THREE.Vector3, magnet: boolean }} ctx
   */
  update(dt, speed, ctx) {}
  /**
   * Test the player hitbox against active objects. Coins and power-ups that hit are
   * removed (returned to pool) immediately. Obstacles that hit are flagged so they are
   * reported only ONCE. Never emits events — game.js does that.
   * @param {THREE.Box3} playerBox @returns {Hit[]}
   */
  collide(playerBox) { return []; }
  /**
   * Obstacles ahead of the player (z in [zMax, zMin], i.e. zMin > zMax, both <= 0), sorted nearest first.
   * Used by the title-screen demo autopilot.
   * @param {number} zMin e.g. -1  @param {number} zMax e.g. -40
   * @returns {{ type: ObstacleType, lane: number, z: number }[]}
   */
  getObstaclesAhead(zMin, zMax) { return []; }
  /**
   * Force-place a row (debug/tests). lanes[i] = ObstacleType | 'coin' | PowerupType | null.
   * @param {number} z @param {(string|null)[]} lanes length 3
   */
  spawnRow(z, lanes) {}
  /** true = keep generating content; false = only move/recycle existing objects. @param {boolean} on */
  setEnabled(on) { this.enabled = on; }
  /** @returns {{ obstacles: number, coins: number, powerups: number }} active counts (debug) */
  stats() { return { obstacles: 0, coins: 0, powerups: 0 }; }
  dispose() {}
}
