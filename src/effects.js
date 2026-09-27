// Effects — owned by Agent 3 (Hazards & FX). See ARCHITECTURE.md §4.5.
// One additive THREE.Points particle system (fixed capacity, ring-buffer allocation) + camera shake.
// Subscribes ITSELF to bus events in the constructor and unsubscribes in dispose().
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { bus, EVENTS } from './events.js';
import { createGlowTexture } from './textures.js';

const FX = CONFIG.effects;
const MAX = FX.maxParticles;
const SIZE_SCALE = 1.5; // particle sizes below are tuned for the game camera distance
const SHAKE = CONFIG.camera.shake;

const VERT = /* glsl */`
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aAlpha > 0.0 ? aSize * uScale / max(-mv.z, 0.05) : 0.0;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */`
uniform sampler2D uMap;
varying vec3 vColor;
varying float vAlpha;
void main() {
  if (vAlpha <= 0.0) discard;
  vec4 t = texture2D(uMap, gl_PointCoord);
  float a = t.a * max(max(t.r, t.g), t.b) * vAlpha;
  if (a < 0.003) discard;
  // hot white core for a neon look
  vec3 c = mix(vColor, vec3(1.0), smoothstep(0.7, 1.0, t.a * vAlpha) * 0.25);
  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Soft radial sprite. Uses textures.createGlowTexture() unless it is still a tiny stub. */
function makeGlowTexture() {
  let tex = null;
  try { tex = createGlowTexture({ size: 64 }); } catch (e) { tex = null; }
  const img = tex && tex.image;
  if (img && img.width >= 16) return tex;
  if (tex) tex.dispose();
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.3, 'rgba(255,255,255,0.6)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const _col = new THREE.Color();
const _white = new THREE.Color(0xffffff);
const _bufSize = new THREE.Vector2();

export class Effects {
  /** @param {THREE.Scene} scene @param {THREE.PerspectiveCamera} camera */
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;

    // particle state (struct of arrays)
    this.pos = new Float32Array(MAX * 3);
    this.vel = new Float32Array(MAX * 3);
    this.col = new Float32Array(MAX * 3);
    this.size = new Float32Array(MAX);
    this.alpha = new Float32Array(MAX);
    this.life = new Float32Array(MAX);
    this.maxLife = new Float32Array(MAX);
    this.size0 = new Float32Array(MAX);
    this.grav = new Float32Array(MAX);
    this.drag = new Float32Array(MAX);
    this.cursor = 0;
    this.alive = 0;
    this._dirty = false;
    for (let i = 0; i < MAX; i++) this.pos[i * 3 + 1] = -1000;

    const geo = new THREE.BufferGeometry();
    const mk = (arr, n) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', mk(this.pos, 3));
    geo.setAttribute('aColor', mk(this.col, 3));
    geo.setAttribute('aSize', mk(this.size, 1));
    geo.setAttribute('aAlpha', mk(this.alpha, 1));
    this.geometry = geo;
    this.texture = makeGlowTexture();
    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: this.texture }, uScale: { value: 500 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.name = 'effects-particles';
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    this.points.onBeforeRender = (renderer, _scene, cam) => {
      renderer.getDrawingBufferSize(_bufSize);
      const fov = cam.isPerspectiveCamera ? cam.fov : CONFIG.camera.fov;
      this.material.uniforms.uScale.value = _bufSize.y / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
    };
    scene.add(this.points);

    // camera shake (driven by real time so it also decays while paused / game over)
    this.shakeAmp = 0;
    this.shakeDecay = SHAKE.decay;
    this._shakeT = 0;
    this._lastApply = 0;
    this._applied = false;
    this._shakeOff = new THREE.Vector3();
    this._shakePos = new THREE.Vector3();

    // bus subscriptions
    const E = EVENTS;
    const P = CONFIG.player;
    this._unsubs = [
      bus.on(E.COIN_COLLECTED, (e) => {
        if (!e || !e.position) return;
        this.burst(e.position, { color: CONFIG.coin.color, count: FX.coinBurst, speed: 3.2, life: 0.45, size: 0.28, gravity: 1.5 });
      }),
      bus.on(E.POWERUP_COLLECTED, (e) => {
        if (!e || !e.position) return;
        const color = CONFIG.powerups.color[e.type] ?? 0xffffff;
        this.burst(e.position, { color, count: Math.round(FX.powerupBurst * 0.6), speed: 6, life: 0.8, size: 0.4, gravity: 2 });
        this.burst(e.position, { color, count: Math.round(FX.powerupBurst * 0.4), speed: 5, life: 0.55, size: 0.3, ring: true, gravity: 0 });
      }),
      bus.on(E.PLAYER_HIT, (e) => {
        if (!e) return;
        const p = e.position;
        if (p) {
          const color = (CONFIG.obstacles[e.type] && CONFIG.obstacles[e.type].color) ?? 0xffffff;
          const y = p.y < 0.6 ? 0.9 : p.y;
          const n = e.shielded ? Math.round(FX.hitBurst * 0.5) : FX.hitBurst;
          this.burst({ x: p.x, y, z: p.z }, { color, count: Math.round(n * 0.7), speed: 9, life: 1.0, size: 0.45, gravity: 7 });
          this.burst({ x: p.x, y, z: p.z }, { color: e.shielded ? CONFIG.colors.cyan : 0xffffff, count: Math.round(n * 0.3), speed: 5, life: 0.6, size: 0.3, gravity: 3 });
        }
        this.shake(e.shielded ? SHAKE.shield : SHAKE.hit);
      }),
      bus.on(E.SHIELD_BREAK, (e) => {
        const p = (e && e.position) || { x: 0, y: 0.9, z: P.z };
        const y = p.y < 0.6 ? 0.9 : p.y;
        this.burst({ x: p.x, y, z: p.z }, { color: CONFIG.colors.cyan, count: 48, speed: 7.5, life: 0.65, size: 0.35, ring: true, gravity: 0, drag: 2.5 });
      }),
      bus.on(E.PLAYER_LAND, (e) => {
        if (!e || !e.position) return;
        const p = e.position;
        this.burst({ x: p.x, y: p.y + 0.05, z: p.z }, { color: P.color, count: 10, speed: 2.8, life: 0.35, size: 0.2, up: true, gravity: 6 });
      }),
      bus.on(E.GAME_START, () => this.reset()),
    ];
  }

  /** Particle burst. @param {{x:number,y:number,z:number}} position
   *  @param {{ color?: number, count?: number, speed?: number, life?: number, size?: number,
   *            ring?: boolean, up?: boolean, gravity?: number, drag?: number }} [opts] */
  burst(position, opts = {}) {
    const count = Math.min(MAX, Math.max(0, Math.floor(opts.count ?? 20)));
    const speed = opts.speed ?? 5;
    const life = opts.life ?? 0.7;
    const size = opts.size ?? 0.3;
    const gravity = opts.gravity ?? 5;
    const drag = opts.drag ?? 1.2;
    const ring = !!opts.ring;
    const up = !!opts.up;
    _col.setHex(opts.color ?? 0xffffff);
    const px = position.x, py = position.y, pz = position.z;
    const phase = Math.random() * Math.PI * 2;
    for (let k = 0; k < count; k++) {
      const i = this._alloc();
      const i3 = i * 3;
      let dx, dy, dz, s;
      if (ring) {
        const a = phase + (k / count) * Math.PI * 2;
        dx = Math.cos(a); dy = Math.sin(a); dz = (Math.random() - 0.5) * 0.2;
        s = speed * (0.9 + Math.random() * 0.2);
      } else {
        // random direction on the unit sphere
        dy = Math.random() * 2 - 1;
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - dy * dy);
        dx = Math.cos(a) * r; dz = Math.sin(a) * r;
        if (up) { dy = Math.abs(dy) * 0.6 + 0.2; }
        s = speed * (0.35 + Math.random() * 0.65);
      }
      this.pos[i3] = px; this.pos[i3 + 1] = py; this.pos[i3 + 2] = pz;
      this.vel[i3] = dx * s; this.vel[i3 + 1] = dy * s; this.vel[i3 + 2] = dz * s;
      // slight random whitening for sparkle variety
      const w = Math.random() * 0.2;
      this.col[i3] = _col.r + (_white.r - _col.r) * w;
      this.col[i3 + 1] = _col.g + (_white.g - _col.g) * w;
      this.col[i3 + 2] = _col.b + (_white.b - _col.b) * w;
      const l = life * (0.6 + Math.random() * 0.4);
      if (this.life[i] <= 0) this.alive++;
      this.life[i] = l; this.maxLife[i] = l;
      this.size0[i] = size * SIZE_SCALE * (0.6 + Math.random() * 0.6);
      this.size[i] = this.size0[i];
      this.alpha[i] = 1;
      this.grav[i] = gravity;
      this.drag[i] = drag;
    }
    if (count) this._dirty = true;
  }

  /** find a dead slot starting at the cursor; if none, overwrite the cursor slot (oldest-ish) */
  _alloc() {
    for (let n = 0; n < MAX; n++) {
      const i = (this.cursor + n) % MAX;
      if (this.life[i] <= 0) { this.cursor = (i + 1) % MAX; return i; }
    }
    const i = this.cursor;
    this.cursor = (i + 1) % MAX;
    return i;
  }

  /** Start/boost camera shake. @param {number} amplitude m @param {number} [decay] 1/s */
  shake(amplitude, decay = SHAKE.decay) {
    if (!(amplitude > 0)) return;
    this.shakeAmp = Math.max(this.shakeAmp, amplitude);
    this.shakeDecay = decay;
  }

  /** Advance particles (particles also scroll +z with the world). @param {number} dt @param {number} speed */
  update(dt, speed) {
    if (this.alive === 0 && !this._dirty) return;
    const dzWorld = speed * dt;
    let alive = 0;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      const l = (this.life[i] -= dt);
      if (l <= 0) {
        this.life[i] = 0; this.alpha[i] = 0; this.size[i] = 0;
        this.pos[i * 3 + 1] = -1000;
        continue;
      }
      alive++;
      const i3 = i * 3;
      const damp = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i3] *= damp;
      this.vel[i3 + 1] = this.vel[i3 + 1] * damp - this.grav[i] * dt;
      this.vel[i3 + 2] *= damp;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt + dzWorld;
      if (this.pos[i3 + 1] < 0.02) { this.pos[i3 + 1] = 0.02; this.vel[i3 + 1] *= -0.35; }
      const f = l / this.maxLife[i];
      this.alpha[i] = f < 0.3 ? f / 0.3 : 1;
      this.size[i] = this.size0[i] * (0.35 + 0.65 * f);
    }
    this.alive = alive;
    this._flush();
  }

  _flush() {
    const a = this.geometry.attributes;
    a.position.needsUpdate = true;
    a.aColor.needsUpdate = true;
    a.aSize.needsUpdate = true;
    a.aAlpha.needsUpdate = true;
    this._dirty = false;
  }

  /** Add the current shake offset to camera.position. Call AFTER game.js set the base pose. @param {THREE.Camera} camera */
  applyCameraShake(camera) {
    const cam = camera || this.camera;
    if (!cam) return;
    // If the base pose was NOT re-set since our last call, remove our previous offset first,
    // so the camera never drifts no matter how the caller drives it.
    if (this._applied && cam.position.equals(this._shakePos)) cam.position.sub(this._shakeOff);
    this._applied = false;

    const now = performance.now() / 1000;
    const dt = this._lastApply ? Math.min(0.1, Math.max(0, now - this._lastApply)) : 0;
    this._lastApply = now;
    if (this.shakeAmp <= 0) return;
    this.shakeAmp *= Math.exp(-this.shakeDecay * dt);
    if (this.shakeAmp < 0.003) { this.shakeAmp = 0; return; }
    const t = (this._shakeT += dt);
    const a = this.shakeAmp;
    this._shakeOff.set(
      a * (Math.sin(t * 47.3) + 0.6 * Math.sin(t * 83.1 + 1.3)) / 1.6,
      a * 0.8 * (Math.sin(t * 53.7 + 2.1) + 0.6 * Math.sin(t * 71.9 + 0.4)) / 1.6,
      a * 0.3 * Math.sin(t * 61.0 + 3.0),
    );
    cam.position.add(this._shakeOff);
    this._shakePos.copy(cam.position);
    this._applied = true;
  }

  /** Kill all particles and shake. */
  reset() {
    this.life.fill(0);
    this.alpha.fill(0);
    this.size.fill(0);
    for (let i = 0; i < MAX; i++) this.pos[i * 3 + 1] = -1000;
    this.alive = 0;
    this.cursor = 0;
    this.shakeAmp = 0;
    this._flush();
  }

  dispose() {
    for (const u of this._unsubs) u();
    this._unsubs.length = 0;
    this.scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
