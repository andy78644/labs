// Hazards & FX test harness (Agent 3). Not part of the game.
// URL params: ?auto=1 run the loop with an autopilot fake player; ?world=1 try the real World (bloom).
import * as THREE from 'three';
import { CONFIG, laneX, speedAt } from '../../src/config.js';
import bus, { EVENTS } from '../../src/events.js';
import { Spawner } from '../../src/spawner.js';
import { Effects } from '../../src/effects.js';

const qs = new URLSearchParams(location.search);
const P = CONFIG.player;
const C = CONFIG.camera;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(C.fov, innerWidth / innerHeight, C.near, C.far);

let world = null;
if (qs.get('world') === '1') {
  try {
    const mod = await import('../../src/world.js');
    world = new mod.World({ renderer, scene, camera });
    world.resize?.(innerWidth, innerHeight);
  } catch (e) {
    console.warn('[harness] World unavailable, using fallback ground:', e.message);
    world = null;
  }
}
let grid = null;
if (!world) {
  scene.background = new THREE.Color(CONFIG.colors.background);
  scene.fog = new THREE.Fog(CONFIG.colors.fog, CONFIG.world.fogNear, CONFIG.world.fogFar);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(CONFIG.lanes.trackWidth, 400).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: CONFIG.colors.track }));
  ground.position.z = -150;
  scene.add(ground);
  grid = new THREE.GridHelper(400, 160, CONFIG.colors.grid, CONFIG.colors.grid);
  grid.material.opacity = 0.35; grid.material.transparent = true;
  grid.position.y = 0.01; grid.position.z = -150;
  scene.add(grid);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x220044, 1.2));
}

// ---- fake player -------------------------------------------------------------------------------
const g = (8 * P.jumpHeight) / (P.jumpDuration ** 2);
const v0 = (4 * P.jumpHeight) / P.jumpDuration;
const player = {
  lane: 1, y: 0, vy: 0, air: false, slideT: 0, pendingSlide: false,
  position: new THREE.Vector3(0, 0, P.z),
  box: new THREE.Box3(),
  mesh: new THREE.Mesh(new THREE.BoxGeometry(P.width, P.height, P.depth).translate(0, P.height / 2, 0),
    new THREE.MeshBasicMaterial({ color: P.color, wireframe: true })),
  moveTo(l) { this.lane = Math.max(0, Math.min(2, l)); },
  jump() { if (this.air) return false; this.air = true; this.vy = v0; this.slideT = 0; return true; },
  slide() { if (this.air) { this.vy = -P.fastFallSpeed; this.pendingSlide = true; } else this.slideT = P.slideDuration; return true; },
  update(dt) {
    const tx = laneX(this.lane);
    const vx = CONFIG.lanes.width / P.laneChangeTime;
    const dx = tx - this.position.x;
    this.position.x += Math.sign(dx) * Math.min(Math.abs(dx), vx * dt);
    if (this.air) {
      this.vy -= g * dt; this.y += this.vy * dt;
      if (this.y <= 0) {
        this.y = 0; this.air = false; this.vy = 0;
        bus.emit(EVENTS.PLAYER_LAND, { position: this.position });
        if (this.pendingSlide) { this.pendingSlide = false; this.slideT = P.slideDuration; }
      }
    }
    if (this.slideT > 0) this.slideT -= dt;
    this.position.y = this.y;
    this.mesh.position.copy(this.position);
    this.mesh.scale.y = this.slideT > 0 ? P.slideHeight / P.height : 1;
  },
  getBounds() {
    const hw = P.width / 2 - P.hitboxShrink, hd = P.depth / 2 - P.hitboxShrink;
    const h = this.slideT > 0 ? P.slideHeight : P.height;
    this.box.min.set(this.position.x - hw, this.y, this.position.z - hd);
    this.box.max.set(this.position.x + hw, this.y + h, this.position.z + hd);
    return this.box;
  },
  reset() { this.lane = 1; this.y = 0; this.vy = 0; this.air = false; this.slideT = 0; this.pendingSlide = false; this.position.set(0, 0, P.z); },
};
scene.add(player.mesh);

const spawner = new Spawner(scene);
const effects = new Effects(scene, camera);

const state = {
  speed: CONFIG.speed.start, distance: 0, time: 0, magnet: false, autopilot: true, rampSpeed: false,
  collide: true, emitEvents: true,
  hits: { barrier: 0, bar: 0, wall: 0 }, coins: 0, powerups: 0, hitLog: [],
};

// ---- autopilot: pick the nearest non-wall lane of the next row, jump barriers, slide bars ---------
function autopilot(speed) {
  const ahead = spawner.getObstaclesAhead(0.9, -80); // keep the current row until fully passed (no sideswipe)
  if (!ahead.length) return;
  const z0 = ahead[0].z;
  const row = [null, null, null];
  for (const o of ahead) if (Math.abs(o.z - z0) < 0.5) row[o.lane] = o.type;
  // choose lane
  let best = player.lane, bestCost = Infinity;
  for (let l = 0; l < 3; l++) {
    if (row[l] === 'wall') continue;
    const cost = Math.abs(l - player.lane) + (row[l] ? 0.6 : 0);
    if (cost < bestCost) { bestCost = cost; best = l; }
  }
  player.moveTo(best);
  const t = -z0 / speed;
  const type = row[best];
  if (type === 'barrier' && !player.air && t <= P.jumpDuration / 2) player.jump();
  if (type === 'bar' && t <= 0.2 && player.slideT < 0.3) player.slide();
}

function step(n = 1, speedOverride) {
  const dt = CONFIG.sim.step;
  for (let k = 0; k < n; k++) {
    state.time += dt;
    const speed = speedOverride ?? (state.rampSpeed ? speedAt(state.time) : state.speed);
    state.curSpeed = speed;
    if (state.autopilot) autopilot(speed);
    player.update(dt);
    spawner.update(dt, speed, { distance: state.distance, playerPos: player.position, magnet: state.magnet });
    if (state.collide) {
      const hits = spawner.collide(player.getBounds());
      for (const h of hits) {
        if (h.kind === 'coin') {
          state.coins++;
          if (state.emitEvents) bus.emit(EVENTS.COIN_COLLECTED, { position: h.position, total: state.coins, value: 1 });
        } else if (h.kind === 'powerup') {
          state.powerups++;
          if (state.emitEvents) bus.emit(EVENTS.POWERUP_COLLECTED, { type: h.type, position: h.position });
        } else {
          state.hits[h.type]++;
          state.hitLog.push({ type: h.type, lane: player.lane, x: +player.position.x.toFixed(2), hz: +h.position.z.toFixed(2), hx: h.position.x, y: player.y, slide: player.slideT > 0, d: state.distance });
          if (state.emitEvents) bus.emit(EVENTS.PLAYER_HIT, { type: h.type, position: h.position, shielded: true });
        }
      }
    }
    effects.update(dt, speed);
    state.distance += speed * dt;
    if (grid) grid.position.z = -150 + (state.distance % (400 / 160));
    world?.update(dt, speed);
  }
}

function setCameraBase() {
  const px = player.position.x * C.followX;
  camera.position.set(px + C.offset[0], player.position.y * 0 + C.offset[1], P.z + C.offset[2]);
  camera.lookAt(px + C.lookAt[0], C.lookAt[1], C.lookAt[2]);
}

function render() {
  setCameraBase();
  effects.applyCameraShake(camera);
  if (world) world.render(); else renderer.render(scene, camera);
}

const info = document.getElementById('info');
let acc = 0, last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  if (H.running) {
    acc += Math.min(CONFIG.sim.maxFrameDelta, (now - last) / 1000);
    let n = 0;
    while (acc >= CONFIG.sim.step && n < CONFIG.sim.maxSubSteps) { step(1); acc -= CONFIG.sim.step; n++; }
    if (n === CONFIG.sim.maxSubSteps) acc = 0;
  }
  last = now;
  render();
  const s = spawner.stats();
  info.textContent = `d=${state.distance.toFixed(0)}m v=${(state.curSpeed ?? state.speed).toFixed(1)} obs=${s.obstacles} coins=${s.coins} pu=${s.powerups} ` +
    `hits=${JSON.stringify(state.hits)} got=${state.coins}c/${state.powerups}p fx=${effects.alive}`;
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  world?.resize?.(innerWidth, innerHeight);
});

const H = (window.__H = {
  THREE, CONFIG, bus, EVENTS, laneX, speedAt, Spawner, Effects,
  renderer, scene, camera, spawner, effects, player, state, world,
  running: qs.get('auto') === '1',
  step, render, setCameraBase,
});
requestAnimationFrame(loop);
window.__H_READY = true;
