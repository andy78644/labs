// World test harness. Query params: ?speed=16&auto=1&stand=1 (stand = stand-in player/obstacles)
import * as THREE from 'three';
import { CONFIG } from '../../src/config.js';
import { World } from '../../src/world.js';
import { createGlowTexture, createPanelTexture } from '../../src/textures.js';

const q = new URLSearchParams(location.search);
let speed = Number(q.get('speed') ?? CONFIG.speed.demo);
const auto = q.get('auto') !== '0';
const stand = q.get('stand') !== '0';
const noBloom = q.get('bloom') === '0';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
const isMobile = matchMedia('(pointer: coarse)').matches;
renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? CONFIG.world.maxPixelRatioMobile : CONFIG.world.maxPixelRatio));
renderer.setSize(innerWidth, innerHeight, false);
const scene = new THREE.Scene();
const cam = CONFIG.camera;
const camera = new THREE.PerspectiveCamera(cam.fov, innerWidth / innerHeight, cam.near, cam.far);
camera.position.set(cam.offset[0], cam.offset[1], CONFIG.player.z + cam.offset[2]);
camera.lookAt(cam.lookAt[0], cam.lookAt[1], cam.lookAt[2]);

const world = new World({ renderer, scene, camera });
if (noBloom) world.bloom.enabled = false;

// stand-ins so composition can be judged (NOT part of the world module)
const marker = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.05), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
scene.add(marker);
const extras = [];
if (stand) {
  const pl = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1.0, 4, 8), new THREE.MeshStandardMaterial({ color: CONFIG.player.color, emissive: CONFIG.player.color, emissiveIntensity: 0.4 }));
  pl.position.set(0, 0.8, 0); scene.add(pl);
  const pTex = createPanelTexture({ style: 'stripes', color: '#ff3355' });
  const ob = new THREE.Mesh(new THREE.BoxGeometry(2, 0.9, 0.35), new THREE.MeshStandardMaterial({ map: pTex, emissive: 0xff3355, emissiveIntensity: 0.5, emissiveMap: pTex }));
  ob.position.set(-2.4, 0.45, -30); scene.add(ob); extras.push(ob);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(2.1, 3.2, 1.2), new THREE.MeshStandardMaterial({ color: 0x2a0a50, emissive: 0x9d4dff, emissiveIntensity: 0.6 }));
  wall.position.set(2.4, 1.6, -55); scene.add(wall); extras.push(wall);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: createGlowTexture(), color: 0xffd700, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.position.set(0, 1, -20); glow.scale.setScalar(1.2); scene.add(glow); extras.push(glow);
}

function resetMarker() {
  // place on a grid line: chunk0 near edge is a grid line; put marker at x=6 (side grid)
  marker.position.set(6, 0.15, world.chunks[0].position.z - 8);
}
resetMarker();

function step(n = 1, s = speed) {
  const dt = CONFIG.sim.step;
  for (let i = 0; i < n; i++) {
    world.update(dt, s);
    marker.position.z += s * dt;
    if (marker.position.z > 8) marker.position.z -= 40;
    for (const e of extras) { e.position.z += s * dt; if (e.position.z > 8) e.position.z -= 120; }
  }
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  world.resize(innerWidth, innerHeight);
});

let frames = 0, last = performance.now(), fps = 0;
const info = document.getElementById('info');
function loop() {
  if (auto) step(1);
  world.render();
  frames++;
  const now = performance.now();
  if (now - last > 1000) { fps = frames * 1000 / (now - last); frames = 0; last = now; info.textContent = `fps ${fps.toFixed(1)} speed ${speed} calls ${renderer.info.render.calls}`; }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

window.__W = { world, renderer, scene, camera, marker, step, resetMarker, THREE, CONFIG,
  setSpeed: (s) => { speed = s; }, getFps: () => fps, ready: true };
