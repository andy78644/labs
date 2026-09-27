// World (owned by Agent 1). See ARCHITECTURE.md §4.1.
// Infinite track from recycled chunks, neon grid ground, sky dome + stars, striped sun,
// layered mountains, lights, fog, bloom post-processing and renderer tone mapping.
//
// Scrolling: every chunk is a THREE.Group whose local geometry spans z ∈ [-L, 0]
// (L = CONFIG.world.chunkLength). update() moves each group by exactly +speed*dt, so the grid,
// track markings and scenery stay locked to obstacles. A chunk whose far edge passes
// RECYCLE_Z is moved back by L*chunkCount (a multiple of the grid cell, so it's seamless)
// and its buildings are re-randomized.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG, hex } from './config.js';
import {
  createGridTexture, createSkyTexture, createSunTexture, createMountainTexture, createPanelTexture,
} from './textures.js';

// ---- module-private layout constants (not shared with other modules) -------------
const L = CONFIG.world.chunkLength;
const COUNT = CONFIG.world.chunkCount;
const TRACK_HALF = CONFIG.lanes.trackWidth / 2;          // 3.9
const GRID_CELLS = Math.max(1, Math.round(L / 4));       // grid cell ≈ 4 m, integer per chunk
const GRID_CELL = L / GRID_CELLS;
const SIDE_WIDTH = 260;                                  // grid ground width on each side (m)
const RECYCLE_Z = 10;                                    // chunk recycled when its far edge > this
const FIRST_NEAR_Z = RECYCLE_Z + L;                      // near edge of chunk 0 after reset
const DASH_PERIOD = 5, DASH_LEN = 2.6, DASH_W = 0.09;    // lane divider dashes
const RAIL_W = 0.1, RAIL_H = 0.12;                      // track edge rails
const POST_X = TRACK_HALF + 1.0, POST_H = 1.1, POST_SPACING = 10;
const GATE_X = TRACK_HALF + 2.2, GATE_H = 7.5, GATE_T = 0.2;
const BUILDINGS_PER_SIDE = 4;
const SKY_RADIUS = 360;
const SUN_DIST = 335, SUN_SIZE = 165, SUN_ELEV = 0.115;  // radians above horizon (center)

/** Brightened color (values > 1 feed the bloom). */
function glowColor(n, k) { return new THREE.Color(n).multiplyScalar(k); }

/** Deterministic PRNG so reset() reproduces the same scenery. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class World {
  /**
   * @param {{ renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera }} deps
   */
  constructor({ renderer, scene, camera }) {
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    this.root = new THREE.Group();
    this.root.name = 'World';
    scene.add(this.root);

    /** things to dispose */
    this._disposables = [];
    this._rand = mulberry32(1337);
    this._tmpObj = new THREE.Object3D();
    this._tmpColor = new THREE.Color();
    this._size = new THREE.Vector2();

    this._setupRenderer();
    this._setupAtmosphere();
    this._setupLights();
    this._setupSky();
    this._setupChunks();
    this._setupComposer();
    this.reset();
  }

  // ======================================================================= setup
  _track(o) { this._disposables.push(o); return o; }

  _setupRenderer() {
    const r = this.renderer;
    this._prevToneMapping = r.toneMapping;
    this._prevExposure = r.toneMappingExposure;
    r.toneMapping = THREE.NeutralToneMapping; // keeps neon hues saturated (ACES bleaches them)
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    this._maxAniso = Math.min(8, r.capabilities.getMaxAnisotropy());
  }

  _setupAtmosphere() {
    const s = this.scene;
    this._prevBackground = s.background;
    this._prevFog = s.fog;
    s.background = new THREE.Color(CONFIG.colors.background);
    s.fog = new THREE.Fog(CONFIG.colors.fog, CONFIG.world.fogNear, CONFIG.world.fogFar);
  }

  _setupLights() {
    const C = CONFIG.colors;
    // Hemisphere: purple sky / dark magenta ground bounce — keeps Standard materials readable.
    this.hemi = new THREE.HemisphereLight(0xb9a3ff, 0x2a0040, 0.9);
    // Key light from behind the camera, slightly above and to the right (lights the runner's back
    // and the obstacle faces that point toward the camera).
    this.key = new THREE.DirectionalLight(0xffffff, 1.1);
    this.key.position.set(4, 10, 12);
    this.key.target.position.set(0, 0, -10);
    // Rim light from the sun direction: magenta edge highlights.
    this.rim = new THREE.DirectionalLight(C.magenta, 0.9);
    this.rim.position.set(0, 6, -30);
    this.rim.target.position.set(0, 0, 0);
    this.root.add(this.hemi, this.key, this.key.target, this.rim, this.rim.target);
  }

  _setupSky() {
    const C = CONFIG.colors;
    // --- sky dome (does not scroll, drawn first, no fog) ---
    const skyTex = this._track(createSkyTexture({
      top: hex(C.skyTop), bottom: hex(C.skyBottom), horizon: hex(C.horizon), below: hex(C.fog),
      stars: 420, width: 1024, height: 1024,
    }));
    skyTex.repeat.set(3, 1); // 3 tiles around the dome → crisper stars
    const skyGeo = this._track(new THREE.SphereGeometry(SKY_RADIUS, 48, 32));
    const skyMat = this._track(new THREE.MeshBasicMaterial({
      map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false, color: glowColor(0xffffff, 0.5),
    }));
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.root.add(this.sky);

    // --- sun ---
    const sunTex = this._track(createSunTexture({ top: hex(C.sunTop), bottom: hex(C.sunBottom), size: 512, stripes: 8 }));
    const sunMat = this._track(new THREE.MeshBasicMaterial({
      map: sunTex, transparent: true, fog: false, depthWrite: false, color: glowColor(0xffffff, 0.42),
    }));
    this.sun = new THREE.Mesh(this._track(new THREE.PlaneGeometry(SUN_SIZE, SUN_SIZE)), sunMat);
    this.sun.position.set(0, CONFIG.camera.offset[1] + SUN_DIST * Math.tan(SUN_ELEV), -SUN_DIST);
    this.sun.renderOrder = -9;
    this.root.add(this.sun);

    // sun halo (soft additive glow disc behind the sun)
    const haloTex = this._track(this._makeHaloTexture());
    const haloMat = this._track(new THREE.MeshBasicMaterial({
      map: haloTex, transparent: true, fog: false, depthWrite: false, blending: THREE.AdditiveBlending,
      color: new THREE.Color(C.horizon).multiplyScalar(0.07),
    }));
    this.halo = new THREE.Mesh(this._track(new THREE.PlaneGeometry(SUN_SIZE * 2.3, SUN_SIZE * 2.3)), haloMat);
    this.halo.position.copy(this.sun.position);
    this.halo.position.z -= 1;
    this.halo.renderOrder = -9.5;
    this.root.add(this.halo);

    // --- layered mountains (far → near). No fog: tinted manually toward fog color. ---
    const layers = [
      { z: -318, w: 1500, h: 120, fill: 0x1c0440, edge: C.purple, seed: 11, peak: 0.95, rough: 0.35, wire: 0.12, edgeK: 1.0, y: -14 },
      { z: -292, w: 1300, h: 80, fill: 0x16023a, edge: C.magenta, seed: 5, peak: 0.9, rough: 0.55, wire: 0.2, edgeK: 1.3, y: -12 },
      { z: -266, w: 1100, h: 46, fill: C.mountain, edge: C.cyan, seed: 2, peak: 0.85, rough: 0.7, wire: 0.25, edgeK: 1.2, y: -10 },
    ];
    this.mountains = [];
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      const tex = this._track(createMountainTexture({
        width: 2048, height: 256, fill: hex(l.fill), edge: hex(l.edge), base: hex(C.fog), seed: l.seed,
        peak: l.peak, rough: l.rough, wire: l.wire,
      }));
      tex.anisotropy = this._maxAniso;
      const mat = this._track(new THREE.MeshBasicMaterial({
        map: tex, transparent: true, fog: false, depthWrite: true, alphaTest: 0.02,
        color: glowColor(0xffffff, l.edgeK),
      }));
      const m = new THREE.Mesh(this._track(new THREE.PlaneGeometry(l.w, l.h)), mat);
      m.position.set(0, l.y + l.h / 2, l.z);
      m.renderOrder = -8 + i;
      this.root.add(m);
      this.mountains.push(m);
    }
  }

  _makeHaloTexture() {
    const size = 256, c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, size * 0.18, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.28)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  _setupChunks() {
    const C = CONFIG.colors;
    // ---- shared textures/materials -----------------------------------------
    const gridTex = this._track(createGridTexture({
      size: 256, divisions: 1, lineColor: hex(C.grid), bgColor: hex(C.background), lineWidth: 4, glow: 6, core: 0.25,
    }));
    gridTex.anisotropy = this._maxAniso;
    const trackTex = this._track(createGridTexture({
      size: 128, divisions: 1, lineColor: '#3a1070', bgColor: hex(C.track), lineWidth: 3, glow: 8, axis: 'x',
    }));
    trackTex.anisotropy = this._maxAniso;

    const gridMat = this._track(new THREE.MeshBasicMaterial({ map: gridTex, color: glowColor(0xffffff, 0.62) }));
    const trackMat = this._track(new THREE.MeshBasicMaterial({ map: trackTex }));
    const cyanMat = this._track(new THREE.MeshBasicMaterial({
      color: glowColor(C.cyan, 0.85), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    }));
    const magentaMat = this._track(new THREE.MeshBasicMaterial({ color: glowColor(C.magenta, 0.8) }));
    const postMat = this._track(new THREE.MeshStandardMaterial({
      color: 0x1a0836, emissive: C.purple, emissiveIntensity: 0.25, roughness: 0.5, metalness: 0.3,
    }));
    const bTex = this._track(createPanelTexture({ size: 256, color: hex(C.cyan), bg: '#0a0020', style: 'windows', density: 0.22, seed: 9 }));
    bTex.anisotropy = this._maxAniso;
    const buildingMat = this._track(new THREE.MeshBasicMaterial({ map: bTex, color: 0xffffff }));

    // ---- shared geometries (built once; every chunk reuses them) ------------
    // side grid: two planes, x ∈ [-TRACK_HALF-SIDE_WIDTH, -TRACK_HALF] and mirrored
    const sideParts = [-1, 1].map((sgn) => {
      const p = new THREE.PlaneGeometry(SIDE_WIDTH, L);
      p.rotateX(-Math.PI / 2);
      p.translate(sgn * (TRACK_HALF + SIDE_WIDTH / 2), -0.02, -L / 2);
      // UVs in world units / cell, anchored at the track edge so lines sit at ±TRACK_HALF + k*cell
      const pos = p.attributes.position, uv = p.attributes.uv;
      for (let i = 0; i < pos.count; i++) {
        uv.setXY(i, (Math.abs(pos.getX(i)) - TRACK_HALF) / GRID_CELL, -pos.getZ(i) / GRID_CELL);
      }
      return p;
    });
    const sideGeo = this._track(mergeGeometries(sideParts));
    sideParts.forEach((p) => p.dispose());

    const trackGeo = this._track(new THREE.PlaneGeometry(CONFIG.lanes.trackWidth, L));
    trackGeo.rotateX(-Math.PI / 2);
    trackGeo.translate(0, 0, -L / 2);
    {
      const pos = trackGeo.attributes.position, uv = trackGeo.attributes.uv;
      for (let i = 0; i < pos.count; i++) uv.setXY(i, uv.getX(i), -pos.getZ(i) / GRID_CELL);
    }

    // cyan: dashed lane dividers at the lane boundaries + post lamps
    const cyanParts = [];
    const lx = CONFIG.lanes.x;
    for (let b = 0; b < lx.length - 1; b++) {
      const x = (lx[b] + lx[b + 1]) / 2; // ±1.2
      for (let z = 0; z > -L + 1e-6; z -= DASH_PERIOD) {
        const q = new THREE.PlaneGeometry(DASH_W, DASH_LEN);
        q.rotateX(-Math.PI / 2);
        q.translate(x, 0.012, z - DASH_PERIOD / 2);
        cyanParts.push(q);
      }
    }
    for (const sgn of [-1, 1]) {
      for (let z = 0; z > -L + 1e-6; z -= POST_SPACING) {
        const cap = new THREE.BoxGeometry(0.34, 0.16, 0.34);
        cap.translate(sgn * POST_X, POST_H + 0.08, z - POST_SPACING / 2);
        cyanParts.push(cap);
      }
    }
    const cyanGeo = this._track(mergeGeometries(cyanParts.map(toNonIndexedPN)));
    cyanParts.forEach((p) => p.dispose());

    // magenta: edge rails (full chunk length) + one neon gate per chunk
    const magParts = [];
    for (const sgn of [-1, 1]) {
      const rail = new THREE.BoxGeometry(RAIL_W, RAIL_H, L);
      rail.translate(sgn * (TRACK_HALF - RAIL_W / 2), RAIL_H / 2, -L / 2);
      magParts.push(rail);
      const post = new THREE.BoxGeometry(GATE_T, GATE_H, GATE_T);
      post.translate(sgn * GATE_X, GATE_H / 2, -L / 2);
      magParts.push(post);
    }
    const beam = new THREE.BoxGeometry(GATE_X * 2 + GATE_T, GATE_T, GATE_T);
    beam.translate(0, GATE_H, -L / 2);
    magParts.push(beam);
    const beam2 = new THREE.BoxGeometry(GATE_X * 2 - 0.6, GATE_T * 0.5, GATE_T * 0.5);
    beam2.translate(0, GATE_H - 0.7, -L / 2);
    magParts.push(beam2);
    const magGeo = this._track(mergeGeometries(magParts.map(toNonIndexedPN)));
    magParts.forEach((p) => p.dispose());

    // dark post bodies
    const postParts = [];
    for (const sgn of [-1, 1]) {
      for (let z = 0; z > -L + 1e-6; z -= POST_SPACING) {
        const p = new THREE.BoxGeometry(0.22, POST_H, 0.22);
        p.translate(sgn * POST_X, POST_H / 2, z - POST_SPACING / 2);
        postParts.push(p);
      }
    }
    const postGeo = this._track(mergeGeometries(postParts.map(toNonIndexedPNU)));
    postParts.forEach((p) => p.dispose());

    const buildingGeo = this._track(new THREE.BoxGeometry(1, 1, 1));
    buildingGeo.translate(0, 0.5, 0);

    // ---- chunks ------------------------------------------------------------------
    this.chunks = [];
    this._buildingTints = [
      glowColor(C.cyan, 0.55), glowColor(C.magenta, 0.55), glowColor(C.purple, 0.7), glowColor(0x4d7dff, 0.6),
    ];
    for (let i = 0; i < COUNT; i++) {
      const g = new THREE.Group();
      g.name = `chunk${i}`;
      const side = new THREE.Mesh(sideGeo, gridMat);
      const track = new THREE.Mesh(trackGeo, trackMat);
      const cyan = new THREE.Mesh(cyanGeo, cyanMat);
      const mag = new THREE.Mesh(magGeo, magentaMat);
      const posts = new THREE.Mesh(postGeo, postMat);
      const bld = new THREE.InstancedMesh(buildingGeo, buildingMat, BUILDINGS_PER_SIDE * 2);
      bld.frustumCulled = false; // instance layout changes on recycle; bounds would be stale
      bld.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      bld.setColorAt(0, this._buildingTints[0]); // allocate instanceColor
      g.add(side, track, cyan, mag, posts, bld);
      g.userData.buildings = bld;
      this.root.add(g);
      this.chunks.push(g);
    }
  }

  _setupComposer() {
    const r = this.renderer;
    r.getSize(this._size);
    const pr = r.getPixelRatio();
    const w = Math.max(1, this._size.x), h = Math.max(1, this._size.y);
    const rt = new THREE.WebGLRenderTarget(Math.round(w * pr), Math.round(h * pr), {
      type: THREE.HalfFloatType,
      samples: pr >= 2 ? 0 : 4, // MSAA for the scene pass (hi-dpi screens don't need it)
    });
    this.composer = new EffectComposer(r, rt);
    this.renderPass = new RenderPass(this.scene, this.camera);
    const b = CONFIG.world.bloom;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), b.strength, b.radius, b.threshold);
    this.outputPass = new OutputPass();
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.outputPass);
    this.resize(w, h);
  }

  // ======================================================================= runtime
  /** Scroll scenery toward +z by speed*dt; recycle chunks. @param {number} dt @param {number} speed m/s */
  update(dt, speed) {
    const dz = speed * dt;
    const span = L * COUNT;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      c.position.z += dz;
      if (c.position.z - L > RECYCLE_Z) {
        c.position.z -= span;
        this._layoutBuildings(c);
      }
    }
  }

  /** Draw the frame through the bloom composer. */
  render() {
    this.composer.render();
  }

  /** Called after renderer.setSize / camera.aspect update. @param {number} w css px @param {number} h css px */
  resize(w, h) {
    w = Math.max(1, Math.floor(w)); h = Math.max(1, Math.floor(h));
    const pr = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    // Bloom is blurry by nature: run it at reduced resolution. Low pixel ratio (typically
    // mobile / low-end) gets the cheapest setting.
    // Sized from CSS px (not device px) so the glow looks the same on hi-dpi screens and
    // doesn't cost 4× there.
    const scale = pr < 1.25 ? 0.85 : 1.0;
    this.bloom.setSize(Math.max(2, Math.round(w * scale)), Math.max(2, Math.round(h * scale)));
  }

  /** Restore initial scroll state (new run). */
  reset() {
    this._rand = mulberry32(1337);
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      c.position.set(0, 0, FIRST_NEAR_Z - i * L);
      this._layoutBuildings(c);
    }
  }

  /** Release GPU resources and remove everything World added to the scene. */
  dispose() {
    this.scene.remove(this.root);
    for (const c of this.chunks) c.userData.buildings.dispose();
    for (const d of this._disposables) d.dispose?.();
    this._disposables.length = 0;
    this.bloom.dispose();
    this.outputPass.dispose();
    this.composer.dispose();
    this.scene.fog = this._prevFog ?? null;
    this.scene.background = this._prevBackground ?? null;
    this.renderer.toneMapping = this._prevToneMapping;
    this.renderer.toneMappingExposure = this._prevExposure;
  }

  // ======================================================================= helpers
  /** Randomize the chunk's building instances (called on recycle — no allocations). */
  _layoutBuildings(chunk) {
    const bld = chunk.userData.buildings;
    const o = this._tmpObj, r = this._rand;
    let n = 0;
    for (let s = -1; s <= 1; s += 2) {
      for (let k = 0; k < BUILDINGS_PER_SIDE; k++) {
        const near = k % 2 === 0;
        const x = s * (near ? 22 + r() * 16 : 48 + r() * 50);
        const z = -(k + r() * 0.8) * (L / BUILDINGS_PER_SIDE);
        const w = 4 + r() * 6, d = 4 + r() * 6;
        const h = near ? 3 + r() * 7 : 8 + r() * 20;
        o.position.set(x, 0, z);
        o.rotation.set(0, 0, 0);
        o.scale.set(w, h, d);
        o.updateMatrix();
        bld.setMatrixAt(n, o.matrix);
        bld.setColorAt(n, this._buildingTints[(r() * this._buildingTints.length) | 0]);
        n++;
      }
    }
    bld.instanceMatrix.needsUpdate = true;
    if (bld.instanceColor) bld.instanceColor.needsUpdate = true;
  }
}

/** Keep only position+normal (non-indexed) so mixed primitive geometries merge cleanly. */
function toNonIndexedPN(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  return g;
}
/** Same, but keep uv too (for lit / textured merged meshes). */
function toNonIndexedPNU(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  return g;
}
