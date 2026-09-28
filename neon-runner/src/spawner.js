// Spawner — owned by Agent 3 (Hazards & FX). See ARCHITECTURE.md §4.4.
// Obstacles / coins / power-ups: procedural neon meshes, object pools, row generation with a
// guaranteed path, magnet pull and AABB collision queries. Never emits bus events.
import * as THREE from 'three';
import { CONFIG, laneX } from './config.js';

/**
 * @typedef {'barrier'|'bar'|'wall'} ObstacleType
 * @typedef {'magnet'|'shield'|'double'} PowerupType
 * @typedef {{ kind: 'obstacle', type: ObstacleType, id: number, position: THREE.Vector3 }
 *         | { kind: 'coin', id: number, position: THREE.Vector3 }
 *         | { kind: 'powerup', type: PowerupType, id: number, position: THREE.Vector3 }} Hit
 */

const SP = CONFIG.spawner;
const OB = CONFIG.obstacles;
const CO = CONFIG.coin;
const PU = CONFIG.powerups;
const PL = CONFIG.player;
const LANES = CONFIG.lanes.count;
const ALL_LANES = (1 << LANES) - 1;

const OBSTACLE_TYPES = ['barrier', 'bar', 'wall'];
const POWERUP_TYPES = PU.types;

// module-private tuning (not shared with other modules)
const REACTION_TIME = 0.22; // s the player needs to react before a lane change
const GAP_JITTER = 4;       // m random extra spacing between rows
const TRAIL_CLEARANCE = 1.6;// m kept free between a coin trail and the row/power-up midway
const BOB_AMP = 0.14;       // m power-up bob
const BOB_FREQ = 2.6;       // rad/s
const COIN_UNDER_BAR_Y = 0.45;

const tmpV = new THREE.Vector3();

// ---------------------------------------------------------------------------------------------
// private procedural textures
function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
const css = (n) => '#' + n.toString(16).padStart(6, '0');

function hazardTexture(color, dark, border) {
  return canvasTexture(256, 64, (g, w, h) => {
    g.fillStyle = dark; g.fillRect(0, 0, w, h);
    g.fillStyle = color;
    for (let x = -h; x < w + h; x += 40) {
      g.beginPath();
      g.moveTo(x, h); g.lineTo(x + 20, h); g.lineTo(x + 20 + h, 0); g.lineTo(x + h, 0);
      g.closePath(); g.fill();
    }
    g.strokeStyle = border; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
  });
}

function wallTexture(color) {
  return canvasTexture(128, 192, (g, w, h) => {
    g.fillStyle = '#0c0020'; g.fillRect(0, 0, w, h);
    // horizontal glowing slats
    g.fillStyle = color;
    for (let y = 18; y < h - 10; y += 22) { g.globalAlpha = 0.22; g.fillRect(12, y, w - 24, 5); }
    g.globalAlpha = 1;
    // big warning X
    g.globalAlpha = 0.75; g.strokeStyle = color; g.lineWidth = 8; g.lineCap = 'round';
    g.beginPath(); g.moveTo(26, 50); g.lineTo(w - 26, h - 50); g.moveTo(w - 26, 50); g.lineTo(26, h - 50); g.stroke();
    // bright border
    g.globalAlpha = 1; g.strokeStyle = color; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
  });
}

function coinTexture(color) {
  return canvasTexture(128, 128, (g, w) => {
    const r = w / 2;
    const grd = g.createRadialGradient(r * 0.8, r * 0.8, 4, r, r, r);
    grd.addColorStop(0, '#ffe680'); grd.addColorStop(0.6, color); grd.addColorStop(1, '#a06000');
    g.fillStyle = grd; g.fillRect(0, 0, w, w);
    g.strokeStyle = '#8a5200'; g.lineWidth = 7;
    g.beginPath(); g.arc(r, r, r * 0.72, 0, Math.PI * 2); g.stroke();
    // star
    g.fillStyle = '#fff2a8';
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.2 : r * 0.46;
      g.lineTo(r + Math.cos(a) * rr, r + Math.sin(a) * rr);
    }
    g.closePath(); g.fill();
  });
}

function glowTexture() {
  return canvasTexture(64, 64, (g, w) => {
    const r = w / 2;
    const grd = g.createRadialGradient(r, r, 0, r, r, r);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, w);
  });
}

function labelTexture(text, color) {
  return canvasTexture(128, 128, (g, w) => {
    g.font = 'bold 76px Arial, Helvetica, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 12; g.strokeStyle = '#2a0040'; g.strokeText(text, w / 2, w / 2 + 4);
    g.fillStyle = color; g.fillText(text, w / 2, w / 2 + 4);
  });
}

function starShape(outer, inner, points = 5) {
  const s = new THREE.Shape();
  for (let i = 0; i < points * 2; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / points, r = i % 2 ? inner : outer;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
  }
  s.closePath();
  return s;
}

function hexShape(r, holeR) {
  const s = new THREE.Shape();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 3;
    if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r); else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  s.closePath();
  if (holeR) {
    const h = new THREE.Path();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 2 - (i * Math.PI) / 3;
      if (i === 0) h.moveTo(Math.cos(a) * holeR, Math.sin(a) * holeR); else h.lineTo(Math.cos(a) * holeR, Math.sin(a) * holeR);
    }
    h.closePath();
    s.holes.push(h);
  }
  return s;
}

function shieldShape(w, h) {
  const s = new THREE.Shape();
  s.moveTo(0, h * 0.5);
  s.quadraticCurveTo(w * 0.25, h * 0.42, w * 0.5, h * 0.5);
  s.lineTo(w * 0.5, h * 0.05);
  s.quadraticCurveTo(w * 0.45, -h * 0.3, 0, -h * 0.5);
  s.quadraticCurveTo(-w * 0.45, -h * 0.3, -w * 0.5, h * 0.05);
  s.lineTo(-w * 0.5, h * 0.5);
  s.quadraticCurveTo(-w * 0.25, h * 0.42, 0, h * 0.5);
  return s;
}

// ---------------------------------------------------------------------------------------------
class Item {
  constructor(kind, type, obj) {
    this.kind = kind;       // 'obstacle' | 'coin' | 'powerup'
    this.type = type;       // obstacle / power-up type, 'coin' for coins
    this.obj = obj;         // THREE.Object3D (position = world position)
    this.spin = null;       // child rotated for animation (powerups)
    this.id = 0;
    this.lane = 0;
    this.hit = false;       // obstacle already reported
    this.attracted = false; // coin caught by magnet
    this.baseY = 0;
    this.phase = 0;
    this.hitRec = kind === 'coin'
      ? { kind, id: 0, position: new THREE.Vector3() }
      : { kind, type, id: 0, position: new THREE.Vector3() };
    this.info = { type, lane: 0, z: 0 };
  }
}

const byZDesc = (a, b) => b.z - a.z;

export class Spawner {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.scene = scene;
    this.enabled = true;
    /** debug: when set to an array, every generated row is pushed as {abs, z, lanes, speed, full} */
    this.debugLog = null;

    this.root = new THREE.Group();
    this.root.name = 'spawner';
    scene.add(this.root);

    this._buildAssets();

    this.pools = {};
    this.created = {};
    for (const t of OBSTACLE_TYPES) { this.pools[t] = []; this.created[t] = 0; }
    this.pools.coin = []; this.created.coin = 0;
    for (const t of POWERUP_TYPES) { this.pools[t] = []; this.created[t] = 0; }

    this.obstacles = [];
    this.coins = [];
    this.powerups = [];

    // pre-fill pools
    for (const t of OBSTACLE_TYPES) for (let i = 0; i < SP.poolSize[t]; i++) this.pools[t].push(this._create(t));
    for (let i = 0; i < SP.poolSize.coin; i++) this.pools.coin.push(this._create('coin'));
    const perPU = Math.max(1, Math.ceil(SP.poolSize.powerup / POWERUP_TYPES.length));
    for (const t of POWERUP_TYPES) for (let i = 0; i < perPU; i++) this.pools[t].push(this._create(t));

    this._hits = [];
    this._ahead = [];
    this._rowTypes = [null, null, null];
    this._lastDz = 0;
    this._nextId = 0;
    this.reset();
  }

  // ------------------------------------------------------------------ assets
  _buildAssets() {
    const A = (this.assets = { geo: [], mat: [], tex: [] });
    const G = (g) => (A.geo.push(g), g);
    const M = (m) => (A.mat.push(m), m);
    const T = (t) => (A.tex.push(t), t);
    const basic = (color, extra) => M(new THREE.MeshBasicMaterial({ color, ...extra }));
    const glowTex = T(glowTexture());
    const halo = (color, opacity) => M(new THREE.SpriteMaterial({
      map: glowTex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    const floorGlow = (color, opacity) => M(new THREE.MeshBasicMaterial({
      map: glowTex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    A.floorGeo = G(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));

    // barrier ---------------------------------------------------------------
    {
      const c = OB.barrier, w = c.width, h = c.height;
      A.barrier = {
        panelGeo: G(new THREE.BoxGeometry(w, h * 0.62, 0.06)),
        panelMat: basic(0xffffff, { map: T(hazardTexture('#b0203a', '#1a0008', css(c.color))) }),
        railGeo: G(new THREE.BoxGeometry(w + 0.12, 0.13, 0.2)),
        railMat: basic(c.color),
        postGeo: G(new THREE.BoxGeometry(0.14, h, 0.24)),
        postMat: basic(c.color),
        floorMat: floorGlow(c.color, 0.35),
      };
    }
    // bar ---------------------------------------------------------------------
    {
      const c = OB.bar;
      const top = c.bottom + c.height;
      A.bar = {
        beamGeo: G(new THREE.BoxGeometry(c.width, c.height, c.depth)),
        beamMat: basic(0xffffff, { map: T(hazardTexture('#c07000', '#1a0c00', css(c.color))) }),
        edgeGeo: G(new THREE.BoxGeometry(c.width + 0.14, 0.07, c.depth + 0.06)),
        edgeMat: basic(c.color),
        postGeo: G(new THREE.CylinderGeometry(0.06, 0.08, top, 8).translate(0, top / 2, 0)),
        postMat: basic(0x9a5200),
        capGeo: G(new THREE.SphereGeometry(0.1, 10, 8)),
        capMat: basic(c.color),
        floorMat: floorGlow(c.color, 0.2),
      };
    }
    // wall --------------------------------------------------------------------
    {
      const c = OB.wall;
      const side = T(wallTexture(css(c.color)));
      const sideMat = basic(0xffffff, { map: side });
      const topMat = basic(0x1a0638);
      A.wall = {
        bodyGeo: G(new THREE.BoxGeometry(c.width, c.height, c.depth).translate(0, c.height / 2, 0)),
        bodyMats: [sideMat, sideMat, topMat, topMat, sideMat, sideMat],
        frameVGeo: G(new THREE.BoxGeometry(0.12, c.height + 0.12, 0.12)),
        frameHGeo: G(new THREE.BoxGeometry(c.width + 0.12, 0.12, 0.12)),
        frameMat: basic(c.color),
        floorMat: floorGlow(c.color, 0.3),
      };
    }
    // coin --------------------------------------------------------------------
    {
      const r = CO.radius;
      const face = basic(0xffffff, { map: T(coinTexture(css(CO.color))) });
      A.coin = {
        geo: G(new THREE.CylinderGeometry(r, r, 0.09, 28).rotateX(Math.PI / 2)),
        mats: [basic(0xe09000), face, face],
      };
    }
    // power-ups --------------------------------------------------------------
    {
      const r = PU.radius;
      const col = PU.color;
      A.pu = {
        haloMat: {
          magnet: halo(col.magnet, 0.28), shield: halo(col.shield, 0.22), double: halo(col.double, 0.22),
        },
        // magnet: U-shape (half torus) + white pole tips
        magnetArcGeo: G(new THREE.TorusGeometry(r * 0.6, r * 0.2, 10, 28, Math.PI).rotateZ(Math.PI)),
        magnetLegGeo: G(new THREE.CylinderGeometry(r * 0.2, r * 0.2, r * 0.45, 12)),
        magnetTipGeo: G(new THREE.CylinderGeometry(r * 0.21, r * 0.21, r * 0.3, 12)),
        magnetMat: basic(col.magnet),
        magnetTipMat: basic(0xb8b8d0),
        // shield: hex frame + inner emblem + translucent back plate
        hexFrameGeo: G(new THREE.ExtrudeGeometry(hexShape(r * 1.05, r * 0.85), { depth: 0.1, bevelEnabled: false }).translate(0, 0, -0.05)),
        hexPlateGeo: G(new THREE.ShapeGeometry(hexShape(r * 0.9))),
        emblemGeo: G(new THREE.ExtrudeGeometry(shieldShape(r * 0.95, r * 1.1), { depth: 0.12, bevelEnabled: false }).translate(0, 0, -0.06)),
        shieldMat: basic(col.shield),
        shieldPlateMat: basic(0x003a44, { transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }),
        emblemMat: basic(0x00a8c0),
        // double: star + "x2" label
        starGeo: G(new THREE.ExtrudeGeometry(starShape(r * 1.15, r * 0.55), { depth: 0.12, bevelEnabled: false }).translate(0, 0, -0.06)),
        starMat: basic(col.double),
        labelMat: M(new THREE.SpriteMaterial({ map: T(labelTexture('x2', '#fff27a')), transparent: true, depthWrite: false })),
      };
    }
  }

  _create(type) {
    const A = this.assets;
    const g = new THREE.Group();
    let item;
    const floor = (mat, sx, sz) => {
      const m = new THREE.Mesh(A.floorGeo, mat);
      m.scale.set(sx, 1, sz); m.position.y = 0.015; m.renderOrder = 1;
      g.add(m);
    };
    if (type === 'barrier') {
      const a = A.barrier, c = OB.barrier;
      const panel = new THREE.Mesh(a.panelGeo, a.panelMat); panel.position.y = c.height * 0.45; g.add(panel);
      const top = new THREE.Mesh(a.railGeo, a.railMat); top.position.y = c.height - 0.065; g.add(top);
      const low = new THREE.Mesh(a.railGeo, a.railMat); low.position.y = 0.1; low.scale.y = 0.7; g.add(low);
      for (const s of [-1, 1]) {
        const p = new THREE.Mesh(a.postGeo, a.postMat); p.position.set(s * c.width / 2, c.height / 2, 0); g.add(p);
      }
      floor(a.floorMat, c.width + 1.2, 2.2);
      item = new Item('obstacle', type, g);
    } else if (type === 'bar') {
      const a = A.bar, c = OB.bar;
      const beam = new THREE.Mesh(a.beamGeo, a.beamMat); beam.position.y = c.bottom + c.height / 2; g.add(beam);
      for (const y of [c.bottom, c.bottom + c.height]) {
        const e = new THREE.Mesh(a.edgeGeo, a.edgeMat); e.position.y = y; g.add(e);
      }
      for (const s of [-1, 1]) {
        const p = new THREE.Mesh(a.postGeo, a.postMat); p.position.x = s * (c.width / 2 + 0.04); g.add(p);
        const cap = new THREE.Mesh(a.capGeo, a.capMat); cap.position.set(s * (c.width / 2 + 0.1), c.bottom + c.height / 2, 0); g.add(cap);
      }
      floor(a.floorMat, c.width + 0.6, 2.4);
      item = new Item('obstacle', type, g);
    } else if (type === 'wall') {
      const a = A.wall, c = OB.wall;
      g.add(new THREE.Mesh(a.bodyGeo, a.bodyMats));
      const fz = c.depth / 2 + 0.02;
      for (const s of [-1, 1]) {
        const v = new THREE.Mesh(a.frameVGeo, a.frameMat); v.position.set(s * c.width / 2, c.height / 2, fz); g.add(v);
      }
      for (const y of [0.06, c.height]) {
        const hh = new THREE.Mesh(a.frameHGeo, a.frameMat); hh.position.set(0, y, fz); g.add(hh);
      }
      floor(a.floorMat, c.width + 1.4, c.depth + 2.6);
      item = new Item('obstacle', type, g);
    } else if (type === 'coin') {
      const m = new THREE.Mesh(A.coin.geo, A.coin.mats);
      g.add(m);
      item = new Item('coin', 'coin', g);
      item.spin = m;
    } else {
      const a = A.pu, r = PU.radius;
      const halo = new THREE.Sprite(a.haloMat[type]); halo.scale.setScalar(r * 3.4); g.add(halo);
      const spin = new THREE.Group(); g.add(spin);
      if (type === 'magnet') {
        const arcR = r * 0.6, legH = r * 0.45, tipH = r * 0.3;
        const arc = new THREE.Mesh(a.magnetArcGeo, a.magnetMat); arc.position.y = -0.12; spin.add(arc);
        for (const s of [-1, 1]) {
          const leg = new THREE.Mesh(a.magnetLegGeo, a.magnetMat); leg.position.set(s * arcR, -0.12 + legH / 2, 0); spin.add(leg);
          const tip = new THREE.Mesh(a.magnetTipGeo, a.magnetTipMat); tip.position.set(s * arcR, -0.12 + legH + tipH / 2, 0); spin.add(tip);
        }
        spin.scale.setScalar(1.25);
      } else if (type === 'shield') {
        spin.add(new THREE.Mesh(a.hexPlateGeo, a.shieldPlateMat));
        spin.add(new THREE.Mesh(a.hexFrameGeo, a.shieldMat));
        spin.add(new THREE.Mesh(a.emblemGeo, a.emblemMat));
      } else {
        spin.add(new THREE.Mesh(a.starGeo, a.starMat));
        const label = new THREE.Sprite(a.labelMat); label.scale.setScalar(r * 1.25); label.position.z = 0.2; label.renderOrder = 2;
        g.add(label);
      }
      item = new Item('powerup', type, g);
      item.spin = spin;
    }
    g.visible = false;
    this.root.add(g);
    this.created[type]++;
    return item;
  }

  // ------------------------------------------------------------------ pool helpers
  _acquire(type, lane, z, y = 0) {
    const pool = this.pools[type];
    const item = pool.length ? pool.pop() : this._create(type); // grow if exhausted
    item.id = ++this._nextId;
    item.lane = lane;
    item.hit = false;
    item.attracted = false;
    item.baseY = y;
    item.phase = Math.random() * Math.PI * 2;
    item.obj.position.set(laneX(lane), y, z);
    item.obj.rotation.set(0, 0, 0);
    if (item.spin) item.spin.rotation.set(0, item.kind === 'coin' ? item.phase : 0, 0);
    item.obj.visible = true;
    (item.kind === 'obstacle' ? this.obstacles : item.kind === 'coin' ? this.coins : this.powerups).push(item);
    return item;
  }

  /** swap-remove index i from list and return the item to its pool */
  _release(list, i) {
    const item = list[i];
    const last = list.pop();
    if (i < list.length) list[i] = last;
    item.obj.visible = false;
    this.pools[item.type].push(item);
  }

  // ------------------------------------------------------------------ public API
  /** Recycle every active object back into its pool; next row at CONFIG.spawner.firstRowZ. */
  reset() {
    for (const list of [this.obstacles, this.coins, this.powerups]) {
      while (list.length) this._release(list, list.length - 1);
    }
    this.nextRowZ = SP.firstRowZ;
    this.prevRowZ = null;       // z of the previous generated row (scrolls with the world)
    this.prevReach = ALL_LANES; // bitmask of lanes the player can be in when passing prev row
    this.prevFull = false;
    this.prevGap = SP.rowGapMax;
    this.lastPowerupAbs = -Infinity;
    this.time = 0;
    this._lastDz = 0;
  }

  /**
   * @param {number} dt @param {number} speed m/s
   * @param {{ distance: number, playerPos: THREE.Vector3, magnet: boolean }} ctx
   */
  update(dt, speed, ctx) {
    const dz = speed * dt;
    this._lastDz = dz;
    this.time += dt;
    const t = this.time;
    const despawn = SP.despawnZ;

    for (let i = this.obstacles.length - 1; i >= 0; i--) {
      const p = this.obstacles[i].obj.position;
      p.z += dz;
      if (p.z > despawn) this._release(this.obstacles, i);
    }

    const magnet = !!(ctx && ctx.magnet && ctx.playerPos);
    const pp = ctx && ctx.playerPos;
    const r2 = PU.magnetRadius * PU.magnetRadius;
    const spinStep = CO.spinSpeed * dt;
    for (let i = this.coins.length - 1; i >= 0; i--) {
      const c = this.coins[i];
      const p = c.obj.position;
      p.z += dz;
      c.spin.rotation.y += spinStep;
      if (magnet) {
        tmpV.set(pp.x - p.x, pp.y + PL.height * 0.5 - p.y, pp.z - p.z);
        const d2 = tmpV.lengthSq();
        if (c.attracted || d2 < r2) {
          c.attracted = true;
          const d = Math.sqrt(d2);
          const step = PU.magnetPullSpeed * dt;
          if (d <= step) p.add(tmpV); else p.addScaledVector(tmpV, step / d);
        }
      }
      if (p.z > despawn) this._release(this.coins, i);
    }

    for (let i = this.powerups.length - 1; i >= 0; i--) {
      const u = this.powerups[i];
      const p = u.obj.position;
      p.z += dz;
      p.y = u.baseY + Math.sin(t * BOB_FREQ + u.phase) * BOB_AMP;
      if (u.type === 'magnet') u.spin.rotation.y += 1.8 * dt;
      else u.spin.rotation.y = Math.sin(t * 1.7 + u.phase) * 0.55;
      if (p.z > despawn) this._release(this.powerups, i);
    }

    // generation ------------------------------------------------------------
    this.nextRowZ += dz;
    if (this.prevRowZ !== null) this.prevRowZ += dz;
    if (!this.enabled) {
      this.nextRowZ = Math.min(this.nextRowZ, SP.spawnZ);
      return;
    }
    const distance = (ctx && ctx.distance) || 0;
    let guard = 0;
    while (this.nextRowZ >= SP.spawnZ && guard++ < 32) this._generateRow(this.nextRowZ, speed, distance);
  }

  _gapFor(speed) {
    const base = Math.min(SP.rowGapMax, Math.max(SP.rowGapMin, speed * SP.rowGapTime));
    return base + Math.random() * GAP_JITTER;
  }

  _pickObstacle(allowWall) {
    const w = OB.weights;
    const total = w.barrier + w.bar + (allowWall ? w.wall : 0);
    let r = Math.random() * total;
    if ((r -= w.barrier) < 0) return 'barrier';
    if ((r -= w.bar) < 0 || !allowWall) return 'bar';
    return 'wall';
  }

  /** Generate one procedural row at z and schedule the next one. Enforces the path rules. */
  _generateRow(z, speed, distance) {
    const spd = Math.max(speed, 1);
    // 1) which lanes can the player reach by the time they get here?
    let shift = LANES - 1;
    if (this.prevRowZ !== null) {
      const gapTime = (this.prevRowZ - z) / spd;
      shift = Math.max(0, Math.min(LANES - 1, Math.floor((gapTime - REACTION_TIME) / PL.laneChangeTime)));
    }
    let reach = 0;
    for (let l = 0; l < LANES; l++) {
      for (let k = 0; k < LANES; k++) {
        if ((this.prevReach & (1 << k)) && Math.abs(k - l) <= shift) { reach |= 1 << l; break; }
      }
    }
    if (!reach) reach = this.prevReach || ALL_LANES;

    // 2) how many lanes blocked
    const pb = SP.blockedLanes;
    const r = Math.random() * (pb[0] + pb[1] + pb[2]);
    let n = r < pb[0] ? 1 : r < pb[0] + pb[1] ? 2 : 3;
    if (n === 3 && this.prevFull) n = 2; // never two full rows back to back

    const types = this._rowTypes;
    types[0] = types[1] = types[2] = null;
    if (n === 3) {
      // rule 2: full row = one type, never wall
      const t = this._pickObstacle(false);
      types[0] = types[1] = types[2] = t;
    } else {
      // rule 1 + 3: an open path lane reachable from the previous row
      const path = randomBit(reach);
      if (n === 1) {
        let o = Math.floor(Math.random() * (LANES - 1));
        if (o >= path) o++;
        types[o] = this._pickObstacle(true);
      } else {
        for (let l = 0; l < LANES; l++) if (l !== path) types[l] = this._pickObstacle(true);
      }
    }
    let wallFree = 0;
    for (let l = 0; l < LANES; l++) {
      if (types[l] !== 'wall') wallFree |= 1 << l;
      if (types[l]) this._acquire(types[l], l, z, 0);
    }
    const newReach = (reach & wallFree) || wallFree; // wallFree∩reach is never empty by construction

    const gapNext = this._gapFor(speed);
    const gapPrev = this.prevRowZ === null ? gapNext : this.prevRowZ - z;

    // 3) coin trail along a safe lane, centered on the row
    if (Math.random() < SP.coinTrailChance) {
      const lane = randomBit(newReach);
      const halfMax = Math.min(gapPrev, gapNext) / 2 - TRAIL_CLEARANCE;
      const maxCount = Math.min(SP.coinTrailMax, Math.floor((2 * halfMax) / SP.coinSpacing) + 1);
      const minCount = Math.min(4, maxCount);
      const count = minCount + Math.floor(Math.random() * (maxCount - minCount + 1));
      const ob = types[lane];
      const jumpHalf = (PL.jumpDuration * spd) / 2;
      for (let i = 0; i < count; i++) {
        const off = (i - (count - 1) / 2) * SP.coinSpacing; // + = toward player
        let y = SP.coinY;
        if (ob === 'barrier') {
          const f = off / jumpHalf;
          if (f > -1 && f < 1) y += PL.jumpHeight * 0.9 * (1 - f * f);
        } else if (ob === 'bar' && Math.abs(off) < 1.2) {
          y = COIN_UNDER_BAR_Y;
        }
        this._acquire('coin', lane, z + off, y);
      }
    }

    // 4) power-up midway to the next row (nothing else lives there), in a safe lane
    const midZ = z - gapNext / 2;
    const midAbs = distance - midZ;
    if (Math.random() < SP.powerupChance && midAbs - this.lastPowerupAbs >= SP.powerupMinDistance) {
      const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
      this._acquire(type, randomBit(newReach), midZ, PU.y);
      this.lastPowerupAbs = midAbs;
    }

    if (this.debugLog) {
      this.debugLog.push({ abs: distance - z, z, speed, full: n === 3, lanes: [types[0], types[1], types[2]] });
    }

    this.prevRowZ = z;
    this.prevReach = newReach;
    this.prevFull = n === 3;
    this.prevGap = gapNext;
    this.nextRowZ = z - gapNext;
  }

  /**
   * Test the player hitbox against active objects. Coins/power-ups that hit are returned to
   * the pool; obstacles that hit are flagged and reported only once. Never emits events.
   * NOTE: the returned array (and its Hit objects) are reused on the next call.
   * @param {THREE.Box3} playerBox @returns {Hit[]}
   */
  collide(playerBox) {
    const out = this._hits;
    out.length = 0;
    const bmin = playerBox.min, bmax = playerBox.max;
    const sweep = this._lastDz; // obstacle travelled this far during the last step (anti-tunneling)

    for (let i = 0; i < this.obstacles.length; i++) {
      const o = this.obstacles[i];
      if (o.hit) continue;
      const c = OB[o.type];
      const p = o.obj.position;
      const hw = c.width / 2, hd = c.depth / 2;
      const y0 = c.bottom;
      const y1 = o.type === 'bar' ? OB.barHitboxTop : c.bottom + c.height;
      if (bmax.x > p.x - hw && bmin.x < p.x + hw &&
          bmax.y > y0 && bmin.y < y1 &&
          bmax.z > p.z - hd - sweep && bmin.z < p.z + hd) {
        o.hit = true;
        const h = o.hitRec;
        h.id = o.id;
        h.position.copy(p);
        out.push(h);
      }
    }

    const R = CO.pickupRadius;
    const x0 = bmin.x - R, x1 = bmax.x + R, y0 = bmin.y - R, y1 = bmax.y + R, z0 = bmin.z - R, z1 = bmax.z + R;
    for (let pass = 0; pass < 2; pass++) {
      const list = pass === 0 ? this.coins : this.powerups;
      for (let i = list.length - 1; i >= 0; i--) {
        const it = list[i];
        const p = it.obj.position;
        if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && p.z >= z0 && p.z <= z1) {
          const h = it.hitRec;
          h.id = it.id;
          h.position.copy(p);
          out.push(h);
          this._release(list, i);
        }
      }
    }
    return out;
  }

  /**
   * Obstacles with z in [zMax, zMin] (zMin > zMax), nearest first. Result array and its
   * records are reused between calls.
   * @param {number} zMin @param {number} zMax
   * @returns {{ type: ObstacleType, lane: number, z: number }[]}
   */
  getObstaclesAhead(zMin, zMax) {
    const out = this._ahead;
    out.length = 0;
    for (let i = 0; i < this.obstacles.length; i++) {
      const o = this.obstacles[i];
      const z = o.obj.position.z;
      if (z <= zMin && z >= zMax) {
        o.info.lane = o.lane; o.info.z = z;
        out.push(o.info);
      }
    }
    out.sort(byZDesc);
    return out;
  }

  /**
   * Force-place a row (debug/tests). lanes[i] = ObstacleType | 'coin' | PowerupType | null.
   * @param {number} z @param {(string|null)[]} lanes
   */
  spawnRow(z, lanes) {
    for (let l = 0; l < LANES; l++) {
      const t = lanes[l];
      if (!t) continue;
      if (OBSTACLE_TYPES.includes(t)) this._acquire(t, l, z, 0);
      else if (t === 'coin') this._acquire('coin', l, z, SP.coinY);
      else if (POWERUP_TYPES.includes(t)) this._acquire(t, l, z, PU.y);
      else console.warn(`[spawner] spawnRow: unknown type "${t}"`);
    }
  }

  /** @param {boolean} on */
  setEnabled(on) { this.enabled = !!on; }

  /** @returns {{ obstacles: number, coins: number, powerups: number }} */
  stats() {
    return { obstacles: this.obstacles.length, coins: this.coins.length, powerups: this.powerups.length };
  }

  dispose() {
    this.scene.remove(this.root);
    const A = this.assets;
    for (const g of A.geo) g.dispose();
    for (const m of A.mat) m.dispose();
    for (const t of A.tex) t.dispose();
    this.obstacles.length = this.coins.length = this.powerups.length = 0;
    for (const k in this.pools) this.pools[k].length = 0;
    this.root.clear();
  }
}

/** random set bit index of a non-zero lane mask */
function randomBit(mask) {
  let n = 0;
  for (let l = 0; l < LANES; l++) if (mask & (1 << l)) n++;
  let k = Math.floor(Math.random() * n);
  for (let l = 0; l < LANES; l++) if (mask & (1 << l)) { if (k-- === 0) return l; }
  return 1;
}
