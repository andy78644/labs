// STUB — owned by Agent 2 (Player). Replace bodies, keep signatures. See ARCHITECTURE.md §4.2.
import * as THREE from 'three';
import { CONFIG, laneX } from './config.js';
import { emit, EVENTS } from './events.js';

export class Player {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.object3d = new THREE.Group();
    const c = CONFIG.player;
    const body = new THREE.Mesh(new THREE.BoxGeometry(c.width, c.height, c.depth), new THREE.MeshBasicMaterial({ color: c.color }));
    body.position.y = c.height / 2; this.object3d.add(body);
    scene.add(this.object3d);
    /** @type {0|1|2} */ this.lane = 1;
    /** @type {'run'|'jump'|'slide'|'dead'} */ this.state = 'run';
    this.position = this.object3d.position; // live THREE.Vector3; z stays CONFIG.player.z
    this.shield = false;
    this._box = new THREE.Box3();
  }
  /** Back to center lane, running, alive, no shield. */
  reset() { this.lane = 1; this.state = 'run'; this.position.set(0, 0, CONFIG.player.z); this.setShield(false); }
  /** Advance animation / physics. @param {number} dt @param {number} speed m/s (animation rate) */
  update(dt, speed) {}
  /** @returns {boolean} true if a lane change started */
  moveLeft() { if (this.lane === 0 || this.state === 'dead') return false; const from = this.lane--; this.position.x = laneX(this.lane); emit(EVENTS.PLAYER_LANE, { lane: this.lane, from }); return true; }
  /** @returns {boolean} */
  moveRight() { if (this.lane === 2 || this.state === 'dead') return false; const from = this.lane++; this.position.x = laneX(this.lane); emit(EVENTS.PLAYER_LANE, { lane: this.lane, from }); return true; }
  /** @returns {boolean} true if a jump started (only from ground) */
  jump() { return false; }
  /** @returns {boolean} true if a slide started (mid-air: fast-fall then slide) */
  slide() { return false; }
  /** World-space AABB hitbox (already shrunk by hitboxShrink; height depends on state).
   *  @param {THREE.Box3} [out] @returns {THREE.Box3} */
  getBounds(out = this._box) {
    const c = CONFIG.player, hw = c.width / 2 - c.hitboxShrink, hd = c.depth / 2 - c.hitboxShrink;
    const h = this.state === 'slide' ? c.slideHeight : c.height, p = this.position;
    return out.set(new THREE.Vector3(p.x - hw, p.y, p.z - hd), new THREE.Vector3(p.x + hw, p.y + h, p.z + hd));
  }
  /** Show/hide shield bubble. @param {boolean} on */
  setShield(on) { this.shield = on; }
  /** Play death animation; state -> 'dead'; ignores further input. @param {string} [cause] obstacle type */
  die(cause) { this.state = 'dead'; }
  /** true while airborne */
  get airborne() { return this.state === 'jump'; }
  dispose() {}
}
