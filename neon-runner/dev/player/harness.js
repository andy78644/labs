// Player/Input test harness (Agent 2). Standalone scene approximating the game look:
// ACES tone mapping + UnrealBloom with CONFIG.world.bloom, scrolling grid, chase camera per CONFIG.camera.
// Query params: ?manual=1 (no auto stepping; tests call __P.step(n)), ?speed=N, ?shield=1
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CONFIG, laneX } from '../../src/config.js';
import * as bus from '../../src/events.js';
import { Player } from '../../src/player.js';
import { Input } from '../../src/input.js';

const qs = new URLSearchParams(location.search);
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
const scene = new THREE.Scene();
scene.background = new THREE.Color(CONFIG.colors.background);
scene.fog = new THREE.Fog(CONFIG.colors.fog, CONFIG.world.fogNear, CONFIG.world.fogFar);
const camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, 1, CONFIG.camera.near, CONFIG.camera.far);

// lights (world.js owns these in the game; approximate here)
scene.add(new THREE.HemisphereLight(0x8a5cff, 0x220033, 1.1));
const key = new THREE.DirectionalLight(0xff66dd, 1.6); key.position.set(-4, 8, -6); scene.add(key);
const rim = new THREE.DirectionalLight(0x33e0ff, 1.4); rim.position.set(5, 4, 8); scene.add(rim);

// ground: dark track + scrolling grid lines
const track = new THREE.Mesh(new THREE.PlaneGeometry(CONFIG.lanes.trackWidth, 400),
  new THREE.MeshStandardMaterial({ color: CONFIG.colors.track, roughness: 0.8 }));
track.rotation.x = -Math.PI / 2; track.position.z = -150; scene.add(track);
const grid = new THREE.GridHelper(400, 200, CONFIG.colors.grid, CONFIG.colors.grid);
grid.material.transparent = true; grid.material.opacity = 0.2; grid.position.y = 0.005; scene.add(grid);
for (const x of [-3.6, -1.2, 1.2, 3.6]) {
  const l = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.02, 400), new THREE.MeshBasicMaterial({ color: new THREE.Color(CONFIG.colors.cyan).multiplyScalar(0.35) }));
  l.position.set(x, 0.01, -150); scene.add(l);
}
// a few reference posts: barrier height & bar bottom in the left lane far ahead
const ob = CONFIG.obstacles;
const refs = new THREE.Group(); scene.add(refs);
const barrier = new THREE.Mesh(new THREE.BoxGeometry(ob.barrier.width, ob.barrier.height, ob.barrier.depth), new THREE.MeshBasicMaterial({ color: ob.barrier.color, wireframe: true }));
barrier.position.set(laneX(0), ob.barrier.height / 2, -3); refs.add(barrier);
const bar = new THREE.Mesh(new THREE.BoxGeometry(ob.bar.width, ob.bar.height, ob.bar.depth), new THREE.MeshBasicMaterial({ color: ob.bar.color, wireframe: true }));
bar.position.set(laneX(2), ob.bar.bottom + ob.bar.height / 2, -3); refs.add(bar);
refs.visible = qs.has('refs');

// hitbox helper
const box = new THREE.Box3();
const boxHelper = new THREE.Box3Helper(box, 0xffff00);
boxHelper.visible = qs.has('hitbox');
scene.add(boxHelper);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const b = CONFIG.world.bloom;
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), b.strength, b.radius, b.threshold);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const player = new Player(scene);
const input = new Input(canvas);

// event log for tests
const log = [];
for (const name of Object.values(bus.EVENTS)) {
  bus.on(name, (p) => {
    const e = { name, t: +(sim.t.toFixed(4)) };
    if (p) for (const k in p) e[k] = p[k] && typeof p[k] === 'object' ? { x: p[k].x, y: p[k].y, z: p[k].z } : p[k];
    log.push(e);
  });
}
// wire input → player like game.js will in 'playing'
bus.on(bus.EVENTS.INPUT_LEFT, () => player.moveLeft());
bus.on(bus.EVENTS.INPUT_RIGHT, () => player.moveRight());
bus.on(bus.EVENTS.INPUT_JUMP, () => player.jump());
bus.on(bus.EVENTS.INPUT_SLIDE, () => player.slide());

const sim = { t: 0, speed: +(qs.get('speed') || CONFIG.speed.start), paused: false, maxY: 0, trace: null };
const manual = qs.has('manual');
if (qs.has('shield')) player.setShield(true);

function step(n = 1) {
  for (let i = 0; i < n; i++) {
    sim.t += CONFIG.sim.step;
    player.update(CONFIG.sim.step, sim.speed);
    if (player.position.y > sim.maxY) sim.maxY = player.position.y;
    if (sim.trace) sim.trace.push([sim.t, player.state, player.position.x, player.position.y, player.getBounds(box).max.y - box.min.y]);
    grid.position.z = (grid.position.z + sim.speed * CONFIG.sim.step) % 2;
  }
}

const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
function render() {
  const o = CONFIG.camera.offset, la = CONFIG.camera.lookAt;
  const cx = player.position.x * CONFIG.camera.followX;
  camPos.set(cx + o[0], o[1], player.position.z + o[2]);
  camera.position.lerp(camPos, 0.25);
  camLook.set(camera.position.x - o[0] + la[0], la[1], la[2]);
  camera.lookAt(camLook);
  player.getBounds(box);
  composer.render();
  document.getElementById('hud').textContent =
    `state ${player.state}  lane ${player.lane}  x ${player.position.x.toFixed(2)}  y ${player.position.y.toFixed(2)}  shield ${player.shield}`;
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  composer.setSize(w, h);
}
addEventListener('resize', resize); resize();
{ const o = CONFIG.camera.offset; camera.position.set(o[0], o[1], o[2]); }

let last = performance.now(), acc = 0;
function frame(now) {
  if (!manual && !sim.paused) {
    acc += Math.min((now - last) / 1000, CONFIG.sim.maxFrameDelta);
    let n = 0;
    while (acc >= CONFIG.sim.step && n++ < CONFIG.sim.maxSubSteps) { step(1); acc -= CONFIG.sim.step; }
    if (n > CONFIG.sim.maxSubSteps) acc = 0;
  }
  last = now;
  if (!sim.freeze) render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// snap camera instantly (for screenshots in manual mode)
function snap() { for (let i = 0; i < 30; i++) render(); }

window.__P = { player, input, bus, CONFIG, THREE, log, sim, step, render, snap, renderer, scene, camera, refs, boxHelper, ready: true };
