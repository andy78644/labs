// STUB — owned by Agent 4 (Game & UI). Bootstrap + fixed-timestep loop. See ARCHITECTURE.md §3.
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
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, CONFIG.world.maxPixelRatio));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, 1, CONFIG.camera.near, CONFIG.camera.far);

const world = new World({ renderer, scene, camera });
const player = new Player(scene);
const input = new Input(canvas);
const spawner = new Spawner(scene);
const effects = new Effects(scene, camera);
const hud = new Hud(document.getElementById('ui'));
const audio = new AudioEngine();
const game = new Game({ renderer, scene, camera, world, player, spawner, effects, hud, audio, input });

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); world.resize(w, h);
}
addEventListener('resize', resize); resize();

let last = performance.now(), acc = 0;
function frame(now) {
  acc += Math.min((now - last) / 1000, CONFIG.sim.maxFrameDelta); last = now;
  let n = 0;
  while (acc >= CONFIG.sim.step && n++ < CONFIG.sim.maxSubSteps) { game.update(CONFIG.sim.step); acc -= CONFIG.sim.step; }
  if (n > CONFIG.sim.maxSubSteps) acc = 0;
  game.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Test hook (contract): used by headless play-tests.
window.__NEON__ = { game, bus, CONFIG, THREE, world, player, spawner, effects, hud, audio, input };
