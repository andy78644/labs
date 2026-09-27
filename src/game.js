// STUB — owned by Agent 4 (Game & UI). State machine + rules. See ARCHITECTURE.md §4.6.
import { CONFIG } from './config.js';

export class Game {
  /** @param {{ renderer, scene, camera, world, player, spawner, effects, hud, audio, input }} deps */
  constructor(deps) { Object.assign(this, deps); /** @type {'title'|'playing'|'paused'|'over'} */ this.state = 'title'; this.time = 0; this.distance = 0; this.speed = CONFIG.speed.demo; }
  /** Fixed-step update. @param {number} dt = CONFIG.sim.step */
  update(dt) {
    this.world.update(dt, this.speed);
    this.player.update(dt, this.speed);
    this.spawner.update(dt, this.speed, { distance: this.distance, playerPos: this.player.position, magnet: false });
    this.effects.update(dt, this.speed);
    this.distance += this.speed * dt;
  }
  /** Once per animation frame, after update(s). Sets camera pose, applies shake, draws. */
  render() {
    const [ox, oy, oz] = CONFIG.camera.offset, [lx, ly, lz] = CONFIG.camera.lookAt;
    this.camera.position.set(ox, oy, oz); this.camera.lookAt(lx, ly, lz);
    this.effects.applyCameraShake(this.camera);
    this.world.render();
  }
  start() {}
  /** @param {boolean} paused */
  setPaused(paused) {}
  gameOver() {}
  toTitle() {}
}
