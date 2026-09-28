// Bootstrap + fixed-timestep loop. Owned by Agent 4 (Game & UI). See ARCHITECTURE.md §3, §4.9.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import * as bus from './events.js';
import { World } from './world.js';
import { Player } from './player.js';
import { Input } from './input.js';
import { Spawner } from './spawner.js';
import { Effects } from './effects.js';
import { Hud } from './hud.js';
import { AudioEngine } from './audio.js';
import { Game } from './game.js';

const canvas = document.getElementById('game');
const uiRoot = document.getElementById('ui');

const isTouch = (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)
  || 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0;
const pixelRatioCap = isTouch ? CONFIG.world.maxPixelRatioMobile : CONFIG.world.maxPixelRatio;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, 1, CONFIG.camera.near, CONFIG.camera.far);
camera.position.set(...CONFIG.camera.offset);
camera.lookAt(...CONFIG.camera.lookAt);

const world = new World({ renderer, scene, camera });
const player = new Player(scene);
const input = new Input(canvas);
const spawner = new Spawner(scene);
const effects = new Effects(scene, camera);
const hud = new Hud(uiRoot);
const audio = new AudioEngine();
const game = new Game({ renderer, scene, camera, world, player, spawner, effects, hud, audio, input });

// ---- resize ----------------------------------------------------------------
function resize() {
  const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
  renderer.setSize(w, h);
  camera.aspect = w / h;
  // Keep the three lanes in view on portrait screens by widening the vertical FOV.
  camera.fov = w < h ? Math.min(80, CONFIG.camera.fov * (1 + 0.35 * (h / w - 1))) : CONFIG.camera.fov;
  camera.updateProjectionMatrix();
  world.resize(w, h);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);
resize();

// ---- audio unlock (one-time user gesture) ------------------------------------
const GESTURES = ['pointerdown', 'keydown', 'touchend', 'click'];
function unlockAudio() {
  const p = audio.init();
  Promise.resolve(p).then(() => {
    if (audio.running) for (const t of GESTURES) window.removeEventListener(t, unlockAudio, true);
  }).catch(() => {});
}
for (const t of GESTURES) window.addEventListener(t, unlockAudio, true);

// ---- fixed-timestep loop (§3) --------------------------------------------------
const STEP = CONFIG.sim.step;
let last = performance.now();
let acc = 0;
let errors = 0;
const stats = { frames: 0, steps: 0 };

function frame(now) {
  requestAnimationFrame(frame);
  acc += Math.min(Math.max(0, (now - last) / 1000), CONFIG.sim.maxFrameDelta);
  last = now;
  try {
    let n = 0;
    while (acc >= STEP && n < CONFIG.sim.maxSubSteps) {
      game.update(STEP);
      acc -= STEP;
      n++;
    }
    if (n >= CONFIG.sim.maxSubSteps) acc = 0; // spiral-of-death guard: drop the backlog
    stats.steps += n;
    game.render();
    stats.frames++;
  } catch (err) {
    // Keep the loop alive but don't flood the console with the same error every frame.
    if (errors++ < 5) console.error('[main] frame error:', err);
  }
}
requestAnimationFrame(frame);

// ---- test hook (contract, §4.9) ---------------------------------------------
window.__NEON__ = {
  game, bus, CONFIG, THREE, world, player, spawner, effects, hud, audio, input,
  renderer, scene, camera, stats,
};
