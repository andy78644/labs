// Game — state machine, rules, score, power-ups, camera. Owned by Agent 4 (Game & UI).
// See ARCHITECTURE.md §3 (update order), §4.6 (interface) and §6 (hit / power-up rules).
import * as THREE from 'three';
import { CONFIG, speedAt } from './config.js';
import { on, emit, EVENTS } from './events.js';

const POWERUP_TYPES = CONFIG.powerups.types;          // ['magnet', 'shield', 'double']
const DEATH_DELAY = 1.1;          // s the scene stays alive after a fatal hit before results
const OVER_CONFIRM_DELAY = 0.45;  // s before input:confirm may restart from the results screen
const CAM_Y_FOLLOW = 0.35;        // fraction of the player's jump height the camera follows
const LOOKAT_X_FOLLOW = 0.5;      // fraction of the camera x the look target follows

// Demo autopilot tuning (title screen only)
const AP_LOOK_NEAR = -0.3, AP_LOOK_FAR = -50;
const AP_WALL_TIME = 1.25;        // react to a wall this many seconds ahead
const AP_JUMP_TIME = 0.26;        // jump when a barrier is this many seconds ahead
const AP_SLIDE_TIME = 0.22;       // slide when a bar is this many seconds ahead
const AP_LANE_COOLDOWN = 0.16;

function storageGet(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { window.localStorage.setItem(key, String(value)); } catch { /* private mode / blocked */ }
}

export class Game {
  /** @param {{ renderer, scene, camera, world, player, spawner, effects, hud, audio, input }} deps */
  constructor(deps) {
    Object.assign(this, deps);
    /** @type {'title'|'playing'|'paused'|'over'} */
    this.state = 'title';
    this.time = 0;
    this.distance = 0;
    this.speed = CONFIG.speed.demo;
    this.score = 0;
    this.coins = 0;
    this.multiplier = 1;
    this.powerups = { magnet: 0, shield: 0, double: 0 };
    this.highScore = Math.max(0, Math.floor(Number(storageGet(CONFIG.score.storageKeyHigh)) || 0));
    this.muted = storageGet(CONFIG.score.storageKeyMuted) === '1';

    this._scoreF = 0;             // un-floored score accumulator
    this._grace = 0;              // post-shield invulnerability (s)
    this._invincible = false;     // debug
    this._dying = -1;             // >= 0 while the death sequence runs (seconds left)
    this._stateTime = 0;          // seconds spent in the current state (updates only)
    this._speedBucket = -1;
    this._lastScoreSig = -1;
    this._apCooldown = 0;
    this._apNearest = [null, null, null];
    this._box = new THREE.Box3();
    this._ctx = { distance: 0, playerPos: this.player.position, magnet: false };
    this._camPos = new THREE.Vector3(...CONFIG.camera.offset);
    this._camTarget = new THREE.Vector3();
    this._lastRender = 0;
    this._hudState = {
      score: 0, coins: 0, distance: 0, speed: 0, multiplier: 1,
      powerups: this.powerups, highScore: this.highScore, state: this.state, grace: 0,
    };

    this.audio.setMuted(this.muted);
    this.hud.setMuted(this.muted);

    this._unsubs = [
      on(EVENTS.INPUT_LEFT, () => this._act('moveLeft')),
      on(EVENTS.INPUT_RIGHT, () => this._act('moveRight')),
      on(EVENTS.INPUT_JUMP, () => this._act('jump')),
      on(EVENTS.INPUT_SLIDE, () => this._act('slide')),
      on(EVENTS.INPUT_CONFIRM, () => this._confirm()),
      on(EVENTS.INPUT_PAUSE, () => this._togglePause()),
      on(EVENTS.UI_PAUSE, () => this._togglePause()),
      on(EVENTS.INPUT_MUTE, () => this.toggleMute()),
      on(EVENTS.UI_MUTE, () => this.toggleMute()),
      on(EVENTS.UI_START, () => { if (this.state === 'title' || this.state === 'over') this.start(); }),
      on(EVENTS.UI_RESTART, () => { if (this.state === 'over' || this.state === 'paused') this.start(); }),
      on(EVENTS.UI_HOME, () => { if (this.state === 'over' || this.state === 'paused') this.toTitle(); }),
    ];
    this._onVisibility = () => { if (document.hidden && this.state === 'playing') this.setPaused(true); };
    document.addEventListener('visibilitychange', this._onVisibility);

    this.debug = {
      grantPowerup: (type) => this._grantPowerup(type, null),
      setInvincible: (on) => { this._invincible = !!on; },
      setTime: (t) => { this.time = Math.max(0, +t || 0); this.speed = speedAt(this.time); this._emitSpeed(true); },
      /** Resolve a synthetic spawner Hit through the real rules (tests). */
      injectHit: (hit) => this._resolveHits([hit]),
    };

    this.audio.startMusic(); // starts as soon as audio.init() succeeds (user gesture)
    this.toTitle();
  }

  // ---------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------

  /** Reset every module and begin a new run. */
  start() {
    this._resetRun();
    this._setState('playing');
    this.hud.showPlaying();
    this._emitSpeed(true);
    emit(EVENTS.GAME_START, {});
    this._emitScore(true);
  }

  /** @param {boolean} paused */
  setPaused(paused) {
    if (paused && this.state === 'playing') {
      this._setState('paused');
    } else if (!paused && this.state === 'paused') {
      this._setState('playing');
    } else return;
    this.hud.showPause(paused);
    emit(EVENTS.GAME_PAUSE, { paused });
  }

  gameOver() {
    if (this.state === 'over') return;
    this._dying = -1;
    const isNewHigh = this.score > this.highScore;
    if (isNewHigh) {
      this.highScore = this.score;
      storageSet(CONFIG.score.storageKeyHigh, this.highScore);
    }
    if (this.state === 'paused') this.hud.showPause(false);
    this._setState('over');
    const result = {
      score: this.score, coins: this.coins, distance: Math.floor(this.distance),
      highScore: this.highScore, isNewHigh,
    };
    emit(EVENTS.GAME_OVER, result);
    this.hud.showResults(result);
  }

  /** Back to the title screen with the demo autopilot running. */
  toTitle() {
    if (this.state === 'paused') this.hud.showPause(false);
    this._resetRun();
    this.speed = CONFIG.speed.demo;
    this._setState('title');
    this.hud.showTitle({ highScore: this.highScore, muted: this.muted });
    emit(EVENTS.GAME_TITLE, {});
    this._emitSpeed(true);
  }

  toggleMute() {
    this.muted = !this.muted;
    this.audio.setMuted(this.muted);
    this.hud.setMuted(this.muted);
    storageSet(CONFIG.score.storageKeyMuted, this.muted ? '1' : '0');
  }

  dispose() {
    for (const u of this._unsubs) u();
    this._unsubs.length = 0;
    document.removeEventListener('visibilitychange', this._onVisibility);
  }

  // ---------------------------------------------------------------------------
  // per-step update (dt === CONFIG.sim.step)
  // ---------------------------------------------------------------------------

  update(dt) {
    switch (this.state) {
      case 'playing': this._stateTime += dt; this._updatePlaying(dt); break;
      case 'title': this._stateTime += dt; this._updateDemo(dt); break;
      case 'over':
        this._stateTime += dt;
        this.world.update(dt, 0);
        this.effects.update(dt, 0);
        break;
      default: break; // paused: no simulation
    }
  }

  _updatePlaying(dt) {
    const player = this.player;
    if (this._dying >= 0) {
      // Death sequence: world frozen at the impact, player animation + particles keep going.
      this._dying -= dt;
      player.update(dt, 0);
      this.effects.update(dt, 0);
      if (this._dying <= 0) this.gameOver();
      return;
    }

    // 1. time & speed
    this.time += dt;
    this.speed = speedAt(this.time);
    this._emitSpeed(false);
    const speed = this.speed;
    // 2-4. movers
    player.update(dt, speed);
    this.world.update(dt, speed);
    const ctx = this._ctx;
    ctx.distance = this.distance; ctx.playerPos = player.position; ctx.magnet = this.powerups.magnet > 0;
    this.spawner.update(dt, speed, ctx);
    // 5. collisions
    const hits = this.spawner.collide(player.getBounds(this._box));
    if (hits && hits.length) this._resolveHits(hits);
    if (this._dying >= 0) { this.effects.update(dt, 0); return; }
    // 6. power-up timers
    if (this._grace > 0) this._grace = Math.max(0, this._grace - dt);
    for (const type of POWERUP_TYPES) {
      const left = this.powerups[type];
      if (left <= 0) continue;
      this.powerups[type] = Math.max(0, left - dt);
      if (this.powerups[type] === 0) this._endPowerup(type);
    }
    this.multiplier = this.powerups.double > 0 ? CONFIG.powerups.scoreMultiplier : 1;
    // 7. effects
    this.effects.update(dt, speed);
    // 8. distance & score
    const dd = speed * dt;
    this.distance += dd;
    this._scoreF += dd * CONFIG.score.pointsPerMeter * this.multiplier;
    this._emitScore(false);
  }

  _updateDemo(dt) {
    const player = this.player;
    this.time += dt;
    this.speed = CONFIG.speed.demo;
    const speed = this.speed;
    player.update(dt, speed);
    this.world.update(dt, speed);
    const ctx = this._ctx;
    ctx.distance = this.distance; ctx.playerPos = player.position; ctx.magnet = false;
    this.spawner.update(dt, speed, ctx);
    this._autopilot(dt);
    // Collisions are ignored in the demo; still query so coins disappear as the runner passes.
    this.spawner.collide(player.getBounds(this._box));
    this.effects.update(dt, speed);
    this.distance += speed * dt;
  }

  /** Title-screen AI: dodge walls by lane change, jump barriers, slide under bars. */
  _autopilot(dt) {
    const p = this.player;
    if (p.state === 'dead') return;
    this._apCooldown -= dt;
    const obs = this.spawner.getObstaclesAhead(AP_LOOK_NEAR, AP_LOOK_FAR) || [];
    const nearest = this._apNearest;
    nearest[0] = nearest[1] = nearest[2] = null;
    const walls = [Infinity, Infinity, Infinity];
    for (const o of obs) {
      if (o.lane < 0 || o.lane > 2) continue;
      if (!nearest[o.lane]) nearest[o.lane] = o;
      if (o.type === 'wall' && walls[o.lane] === Infinity) walls[o.lane] = -o.z;
    }
    const v = Math.max(1, this.speed);
    const lane = p.lane;
    // Lane change if a wall is coming in our lane.
    if (walls[lane] < v * AP_WALL_TIME && this._apCooldown <= 0) {
      let best = -1, bestScore = -Infinity;
      for (const cand of [lane - 1, lane + 1]) {
        if (cand < 0 || cand > 2) continue;
        // prefer lanes with the farthest wall; small bonus if the lane has nothing at all
        const score = Math.min(walls[cand], 999) + (nearest[cand] ? 0 : 5) + (cand === 1 ? 1 : 0);
        if (score > bestScore) { bestScore = score; best = cand; }
      }
      // If both neighbors are walled nearer than ours, head toward the far lane through the middle.
      if (best >= 0 && walls[best] < walls[lane] && lane !== 1) best = 1;
      if (best >= 0 && best !== lane) {
        (best < lane ? p.moveLeft() : p.moveRight());
        this._apCooldown = AP_LANE_COOLDOWN;
      }
    }
    const cur = nearest[p.lane];
    if (!cur || cur.type === 'wall') return;
    const dz = -cur.z;
    if (cur.type === 'barrier' && dz < v * AP_JUMP_TIME && !p.airborne && p.state !== 'jump') p.jump();
    else if (cur.type === 'bar' && dz < v * AP_SLIDE_TIME && p.state !== 'slide') p.slide();
  }

  // ---------------------------------------------------------------------------
  // rules (§6)
  // ---------------------------------------------------------------------------

  _resolveHits(hits) {
    for (const h of hits) {
      if (!h) continue;
      if (h.kind === 'coin') {
        const value = CONFIG.coin.value;
        this.coins += value;
        this._scoreF += value * CONFIG.coin.points * this.multiplier;
        emit(EVENTS.COIN_COLLECTED, { position: h.position, total: this.coins, value });
      } else if (h.kind === 'powerup') {
        this._grantPowerup(h.type, h.position);
      } else if (h.kind === 'obstacle') {
        if (this._invincible || this._dying >= 0) continue;
        const pos = this._hitPos();
        if (this.powerups.shield > 0 || this._grace > 0) {
          emit(EVENTS.PLAYER_HIT, { type: h.type, position: pos, shielded: true });
          if (this.powerups.shield > 0) {
            this.powerups.shield = 0;
            this.player.setShield(false);
            emit(EVENTS.SHIELD_BREAK, { position: pos });
            emit(EVENTS.POWERUP_END, { type: 'shield' });
            this._grace = CONFIG.powerups.shieldGraceTime;
          }
        } else {
          emit(EVENTS.PLAYER_HIT, { type: h.type, position: pos, shielded: false });
          this.player.die(h.type);
          this._dying = DEATH_DELAY;
          this._emitScore(true);
          return;
        }
      }
    }
    this.multiplier = this.powerups.double > 0 ? CONFIG.powerups.scoreMultiplier : 1;
    this._emitScore(false);
  }

  _grantPowerup(type, position) {
    if (!POWERUP_TYPES.includes(type)) return;
    const pos = position || this._hitPos();
    emit(EVENTS.POWERUP_COLLECTED, { type, position: pos });
    const duration = CONFIG.powerups.duration[type];
    this.powerups[type] = duration;
    if (type === 'shield') this.player.setShield(true);
    if (type === 'double') this.multiplier = CONFIG.powerups.scoreMultiplier;
    emit(EVENTS.POWERUP_START, { type, duration });
  }

  _endPowerup(type) {
    this.powerups[type] = 0;
    if (type === 'shield') this.player.setShield(false);
    if (type === 'double') this.multiplier = 1;
    emit(EVENTS.POWERUP_END, { type });
  }

  _hitPos() {
    const p = this.player.position;
    return { x: p.x, y: p.y + CONFIG.player.height * 0.5, z: p.z };
  }

  // ---------------------------------------------------------------------------
  // input routing
  // ---------------------------------------------------------------------------

  _act(method) {
    if (this.state !== 'playing' || this._dying >= 0) return;
    this.player[method]();
  }

  _confirm() {
    if (this.state === 'title') this.start();
    else if (this.state === 'over' && this._stateTime >= OVER_CONFIRM_DELAY) this.start();
    else if (this.state === 'paused') this.setPaused(false);
  }

  _togglePause() {
    if (this.state === 'playing') this.setPaused(true);
    else if (this.state === 'paused') this.setPaused(false);
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  _resetRun() {
    for (const type of POWERUP_TYPES) if (this.powerups[type] > 0) this._endPowerup(type);
    this.time = 0; this.distance = 0; this.score = 0; this.coins = 0; this.multiplier = 1;
    this._scoreF = 0; this._grace = 0; this._dying = -1; this._speedBucket = -1; this._lastScoreSig = -1;
    this.speed = speedAt(0);
    this.world.reset();
    this.player.reset();
    this.spawner.reset();
    this.spawner.setEnabled(true);
    this.effects.reset();
    this._snapCamera();
  }

  _setState(to) {
    const from = this.state;
    this.state = to;
    this._stateTime = 0;
    if (from !== to) emit(EVENTS.GAME_STATE, { from, to });
  }

  _emitSpeed(force) {
    const s = CONFIG.speed;
    const bucket = Math.floor(this.speed / s.changedEvery);
    if (!force && bucket === this._speedBucket) return;
    this._speedBucket = bucket;
    const ratio = Math.min(1, Math.max(0, (this.speed - s.start) / (s.max - s.start)));
    emit(EVENTS.SPEED_CHANGED, { speed: this.speed, ratio });
  }

  _emitScore(force) {
    this.score = Math.floor(this._scoreF);
    const sig = this.score * 64 + this.coins * 2 + (this.multiplier > 1 ? 1 : 0);
    if (!force && sig === this._lastScoreSig) return;
    this._lastScoreSig = sig;
    emit(EVENTS.SCORE_CHANGED, {
      score: this.score, coins: this.coins, distance: this.distance, multiplier: this.multiplier,
    });
  }

  _snapCamera() {
    this._cameraTarget();
    this._camPos.copy(this._camTarget);
  }

  _cameraTarget() {
    const c = CONFIG.camera, p = this.player.position;
    this._camTarget.set(
      p.x * c.followX + c.offset[0],
      c.offset[1] + Math.max(0, p.y) * CAM_Y_FOLLOW,
      p.z + c.offset[2],
    );
    return this._camTarget;
  }

  // ---------------------------------------------------------------------------
  // render (once per animation frame)
  // ---------------------------------------------------------------------------

  render() {
    const now = performance.now();
    const fdt = this._lastRender ? Math.min(0.1, Math.max(0, (now - this._lastRender) / 1000)) : 0;
    this._lastRender = now;

    const c = CONFIG.camera, cam = this.camera;
    const target = this._cameraTarget();
    this._camPos.lerp(target, 1 - Math.exp(-c.followLerp * fdt));
    cam.position.copy(this._camPos);
    cam.lookAt(this._camPos.x * LOOKAT_X_FOLLOW + c.lookAt[0], c.lookAt[1], this.player.position.z + c.lookAt[2]);
    this.effects.applyCameraShake(cam);

    const s = this._hudState;
    s.score = this.score; s.coins = this.coins; s.distance = this.distance; s.speed = this.speed;
    s.multiplier = this.multiplier; s.powerups = this.powerups; s.highScore = this.highScore;
    s.state = this.state; s.grace = this._grace;
    this.hud.update(s);

    this.world.render();
  }
}
