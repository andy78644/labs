// Player — owned by Agent 2. Procedural low-poly neon runner. See ARCHITECTURE.md §4.2.
//
// Rig hierarchy (runner faces -z, feet at object3d.position.y):
//   object3d (x = lane tween, y = jump height, z = CONFIG.player.z)
//   ├─ lean      (rotation z/y: banking into lane changes)
//   │   └─ tumble (death fall: rotation x + knock-back offset, pivot at the feet)
//   │       └─ pelvis (y = hip height, rot x = whole-body pitch, e.g. slide lean-back)
//   │           ├─ thighL/R → shinL/R (knee pivots) → foot + glowing sole
//   │           └─ spine → torso, back core, shoulders → upperArmL/R → forearmL/R (elbows), neck → head
//   ├─ shield bubble (fresnel, additive)
//   └─ light trail   (ground ribbon, world-space history of x/y)
//
// Joint angle convention: rotation.x > 0 swings a hanging limb FORWARD (-z) and tips an
// upright segment BACKWARD (+z).
import * as THREE from 'three';
import { CONFIG, laneX } from './config.js';
import { emit, EVENTS } from './events.js';

// ---- module-private look/animation constants (not shared with other modules) ----
const HIP_H = 0.92;          // pelvis pivot height when standing
const THIGH = 0.45, SHIN = 0.42;
const GLOW = 1.25;            // HDR multiplier for trim colors (pushes bloom)
const POSE_RATE = 16;        // 1/s blend rate between run / jump / slide poses
const LEAN_PER_MPS = 0.016;  // bank angle per m/s lateral velocity
const TRAIL_N = 18;          // trail samples
const SHIELD_R = 1.08;

// joint indices into pose arrays
const PY = 0, PRX = 1, SRX = 2, TL = 3, TR = 4, SL = 5, SR = 6, UL = 7, UR = 8, FL = 9, FR = 10, AZ = 11, HRX = 12, J = 13;

const SHIELD_VERT = /* glsl */`
  varying vec3 vN; varying vec3 vV;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
const SHIELD_FRAG = /* glsl */`
  uniform vec3 uColor; uniform float uAlpha; uniform float uTime;
  varying vec3 vN; varying vec3 vV;
  void main() {
    float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
    float rim = pow(f, 2.4);
    float bands = 0.5 + 0.5 * sin(vN.y * 18.0 - uTime * 3.0);
    float a = (0.012 + rim * 0.42 + bands * rim * 0.18) * uAlpha;
    gl_FragColor = vec4(uColor * a, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

function easeOutCubic(t) { t = 1 - t; return 1 - t * t * t; }
function smooth01(t) { return t * t * (3 - 2 * t); }

export class Player {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    const c = CONFIG.player;
    this.object3d = new THREE.Group();
    this.object3d.name = 'player';
    /** @type {0|1|2} */ this.lane = 1;
    /** @type {'run'|'jump'|'slide'|'dead'} */ this.state = 'run';
    this.position = this.object3d.position; // live THREE.Vector3; z stays CONFIG.player.z
    this.shield = false;
    this._box = new THREE.Box3();

    // physics (derived per contract)
    this._g = (8 * c.jumpHeight) / (c.jumpDuration * c.jumpDuration);
    this._v0 = (4 * c.jumpHeight) / c.jumpDuration;
    this._vy = 0;
    this._airT = 0;
    this._fastFall = false;
    this._slideQueued = false;
    this._slideT = 0;
    // lane tween
    this._laneFrom = 0; this._laneTo = 0; this._laneT = 1; this._laneDur = c.laneChangeTime;
    this._prevX = 0;
    // animation
    this._phase = 0;
    this._time = 0;
    this._w = new Float32Array(4);        // blend weights: run, jump, slide, dead
    this._w[0] = 1;
    this._pose = [new Float32Array(J), new Float32Array(J), new Float32Array(J), new Float32Array(J)];
    this._final = new Float32Array(J);
    this._lean = 0; this._yaw = 0;
    // death
    this._deadT = 0; this._deathDir = 1; this._deathSide = 1;
    // shield
    this._shieldK = 0; this._shieldBreakT = 0;

    this._buildMaterials();
    this._buildRig();
    this._buildShield();
    this._buildTrail();

    scene.add(this.object3d);
    this.reset();
  }

  // ------------------------------------------------------------------ build
  _buildMaterials() {
    const c = CONFIG.player;
    this._geos = [];
    this._mats = [];
    const m = (mat) => (this._mats.push(mat), mat);
    this._cyanBase = new THREE.Color(c.color).multiplyScalar(GLOW);
    this._pinkBase = new THREE.Color(c.accent).multiplyScalar(GLOW);
    this._white = new THREE.Color(0xffffff).multiplyScalar(2.2);
    this._tmpC = new THREE.Color();
    this.matSuit = m(new THREE.MeshStandardMaterial({ color: 0x2c2458, roughness: 0.45, metalness: 0.5, emissive: 0x2a1a5e, flatShading: true }));
    this.matArmor = m(new THREE.MeshStandardMaterial({ color: 0x4a3f8f, roughness: 0.3, metalness: 0.6, emissive: 0x23306a, flatShading: true }));
    this.matCyan = m(new THREE.MeshBasicMaterial({ color: this._cyanBase.clone() }));
    this.matPink = m(new THREE.MeshBasicMaterial({ color: this._pinkBase.clone() }));
    this.matVisor = m(new THREE.MeshBasicMaterial({ color: this._cyanBase.clone() }));
    this._suitEmissive = this.matSuit.emissive.clone();
    this._armorEmissive = this.matArmor.emissive.clone();
  }

  /** Box geometry whose pivot is at its top (y from 0 down to -h), optional z/x offset. */
  _limbGeo(w, h, d, oz = 0, ox = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(ox, -h / 2, oz);
    this._geos.push(g);
    return g;
  }
  _geo(g) { this._geos.push(g); return g; }
  _mesh(geo, mat, parent, x = 0, y = 0, z = 0) {
    const me = new THREE.Mesh(geo, mat);
    me.position.set(x, y, z);
    parent.add(me);
    return me;
  }

  _buildRig() {
    const suit = this.matSuit, armor = this.matArmor, cyan = this.matCyan, pink = this.matPink;
    this._leanG = new THREE.Group();
    this._tumble = new THREE.Group();
    this._pelvis = new THREE.Group();
    this.object3d.add(this._leanG);
    this._leanG.add(this._tumble);
    this._tumble.add(this._pelvis);

    // pelvis + glowing belt
    this._mesh(this._geo(new THREE.BoxGeometry(0.34, 0.18, 0.22)), suit, this._pelvis, 0, 0.02, 0);
    this._mesh(this._geo(new THREE.BoxGeometry(0.37, 0.04, 0.25)), pink, this._pelvis, 0, 0.09, 0);

    // legs
    const thighG = this._limbGeo(0.14, THIGH, 0.16);
    const shinG = this._limbGeo(0.12, SHIN, 0.13);
    const kneeG = this._geo(new THREE.BoxGeometry(0.13, 0.08, 0.05));
    const footG = this._geo(new THREE.BoxGeometry(0.13, 0.08, 0.26));
    const soleG = this._geo(new THREE.BoxGeometry(0.14, 0.03, 0.27));
    const stripeG = this._geo(new THREE.BoxGeometry(0.025, SHIN * 0.8, 0.025));
    const tStripeG = this._geo(new THREE.BoxGeometry(0.025, THIGH * 0.75, 0.02));
    const mkLeg = (side) => {
      const thigh = new THREE.Group();
      thigh.position.set(0.1 * side, -0.02, 0);
      this._pelvis.add(thigh);
      this._mesh(thighG, suit, thigh);
      this._mesh(tStripeG, cyan, thigh, 0.05 * side, -THIGH * 0.5, 0.085);
      const shin = new THREE.Group();
      shin.position.y = -THIGH;
      thigh.add(shin);
      this._mesh(shinG, armor, shin);
      this._mesh(kneeG, pink, shin, 0, -0.02, -0.075);
      this._mesh(stripeG, cyan, shin, 0.055 * side, -SHIN * 0.5, 0.05); // outer-back stripe (visible from camera)
      this._mesh(footG, armor, shin, 0, -SHIN - 0.02, -0.05);
      this._mesh(soleG, cyan, shin, 0, -SHIN - 0.06, -0.05);
      return { thigh, shin };
    };
    const L = mkLeg(-1), R = mkLeg(1);
    this._thighL = L.thigh; this._shinL = L.shin; this._thighR = R.thigh; this._shinR = R.shin;

    // spine / torso (low-poly tapered prism)
    this._spine = new THREE.Group();
    this._spine.position.y = 0.1;
    this._pelvis.add(this._spine);
    const torsoG = this._geo(new THREE.CylinderGeometry(0.27, 0.19, 0.48, 4, 1));
    torsoG.rotateY(Math.PI / 4); torsoG.scale(1, 1, 0.62); torsoG.translate(0, 0.24, 0);
    this._mesh(torsoG, suit, this._spine);
    // chest plate (front) and back power core + spine light (seen from the chase camera)
    this._mesh(this._geo(new THREE.BoxGeometry(0.3, 0.2, 0.05)), armor, this._spine, 0, 0.33, -0.12);
    this._mesh(this._geo(new THREE.BoxGeometry(0.2, 0.24, 0.1)), armor, this._spine, 0, 0.3, 0.14);
    this._mesh(this._geo(new THREE.BoxGeometry(0.12, 0.16, 0.03)), cyan, this._spine, 0, 0.3, 0.2);
    this._mesh(this._geo(new THREE.BoxGeometry(0.035, 0.3, 0.03)), pink, this._spine, 0, 0.12, 0.13);
    // shoulder chevrons (back)
    const chevG = this._geo(new THREE.BoxGeometry(0.16, 0.03, 0.03));
    const chevL = this._mesh(chevG, pink, this._spine, -0.13, 0.43, 0.12); chevL.rotation.z = -0.35;
    const chevR = this._mesh(chevG, pink, this._spine, 0.13, 0.43, 0.12); chevR.rotation.z = 0.35;

    // head: neck + faceted helmet + visor + glowing halo ring
    this._neck = new THREE.Group();
    this._neck.position.y = 0.5;
    this._spine.add(this._neck);
    this._mesh(this._geo(new THREE.CylinderGeometry(0.06, 0.07, 0.08, 6)), suit, this._neck, 0, 0.03, 0);
    const helmG = this._geo(new THREE.IcosahedronGeometry(0.14, 1));
    helmG.scale(1, 1.1, 1.08);
    this._mesh(helmG, armor, this._neck, 0, 0.17, 0);
    const visorG = this._geo(new THREE.BoxGeometry(0.22, 0.06, 0.08));
    this._mesh(visorG, this.matVisor, this._neck, 0, 0.18, -0.11);
    const ringG = this._geo(new THREE.TorusGeometry(0.15, 0.014, 4, 18));
    ringG.rotateX(Math.PI / 2);
    this._mesh(ringG, cyan, this._neck, 0, 0.16, 0.0);
    this._mesh(this._geo(new THREE.BoxGeometry(0.03, 0.05, 0.18)), pink, this._neck, 0, 0.32, 0.03); // mohawk fin

    // arms
    const upperG = this._limbGeo(0.1, 0.28, 0.11);
    const foreG = this._limbGeo(0.09, 0.26, 0.1);
    const padG = this._geo(new THREE.BoxGeometry(0.15, 0.08, 0.15));
    const handG = this._geo(new THREE.BoxGeometry(0.1, 0.1, 0.1));
    const cuffG = this._geo(new THREE.BoxGeometry(0.1, 0.03, 0.11));
    const aStripeG = this._geo(new THREE.BoxGeometry(0.02, 0.2, 0.03));
    const mkArm = (side) => {
      const upper = new THREE.Group();
      upper.position.set(0.28 * side, 0.43, 0);
      this._spine.add(upper);
      this._mesh(upperG, suit, upper);
      this._mesh(aStripeG, cyan, upper, 0.055 * side, -0.15, 0.02);
      this._mesh(padG, armor, upper, 0.02 * side, 0.0, 0);
      const fore = new THREE.Group();
      fore.position.y = -0.28;
      upper.add(fore);
      this._mesh(foreG, armor, fore);
      this._mesh(cuffG, pink, fore, 0, -0.19, 0);
      this._mesh(handG, cyan, fore, 0, -0.28, 0);
      return { upper, fore };
    };
    const AL = mkArm(-1), AR = mkArm(1);
    this._upperL = AL.upper; this._foreL = AL.fore; this._upperR = AR.upper; this._foreR = AR.fore;

    this.object3d.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  }

  _buildShield() {
    const geo = this._geo(new THREE.IcosahedronGeometry(SHIELD_R, 4));
    this.matShield = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(CONFIG.powerups.color.shield) },
        uAlpha: { value: 1 },
        uTime: { value: 0 },
      },
      vertexShader: SHIELD_VERT,
      fragmentShader: SHIELD_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this._mats.push(this.matShield);
    const wireGeo = this._geo(new THREE.IcosahedronGeometry(SHIELD_R * 1.01, 1));
    this.matShieldWire = new THREE.MeshBasicMaterial({
      color: CONFIG.powerups.color.shield, wireframe: true, transparent: true, opacity: 0.22,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._mats.push(this.matShieldWire);
    this._shieldG = new THREE.Group();
    this._shieldG.position.y = 0.9;
    this._shieldMesh = new THREE.Mesh(geo, this.matShield);
    this._shieldWire = new THREE.Mesh(wireGeo, this.matShieldWire);
    this._shieldMesh.renderOrder = 10; this._shieldWire.renderOrder = 11;
    this._shieldG.add(this._shieldMesh, this._shieldWire);
    this._shieldG.visible = false;
    this.object3d.add(this._shieldG);
  }

  _buildTrail() {
    // Flat ribbon on the ground behind the runner: 3 verts across (edge, core, edge) per sample.
    const n = TRAIL_N;
    this._trailX = new Float32Array(n);
    this._trailY = new Float32Array(n);
    const pos = new Float32Array(n * 3 * 3);
    const col = new Float32Array(n * 3 * 3);
    const idx = [];
    const tc = new THREE.Color(CONFIG.player.accent);
    const cc = new THREE.Color(CONFIG.player.color);
    for (let i = 0; i < n; i++) {
      const f = Math.pow(1 - i / (n - 1), 1.6);
      const core = i === 0 ? 0 : f; // fade in the first segment under the heels
      // edges black (additive → invisible), core bright magenta blending toward cyan near the runner
      const k = i / (n - 1);
      const m = Math.min(1, k * 3); const r = cc.r * (1 - m) + tc.r * m, g = cc.g * (1 - m) + tc.g * m, b = cc.b * (1 - m) + tc.b * m;
      col.set([0, 0, 0, r * core, g * core, b * core, 0, 0, 0], i * 9);
      if (i < n - 1) {
        const a = i * 3, bI = (i + 1) * 3;
        idx.push(a, a + 1, bI, a + 1, bI + 1, bI, a + 1, a + 2, bI + 1, a + 2, bI + 2, bI + 1);
      }
    }
    const geo = this._geo(new THREE.BufferGeometry());
    this._trailPos = new THREE.BufferAttribute(pos, 3);
    this._trailPos.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this._trailPos);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    this.matTrail = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide, fog: false,
    });
    this._mats.push(this.matTrail);
    this._trail = new THREE.Mesh(geo, this.matTrail);
    this._trail.frustumCulled = false;
    this._trail.renderOrder = 5;
    this.object3d.add(this._trail);
    this._trailK = 1;
  }

  // ------------------------------------------------------------------ API
  /** Back to center lane, running, alive, no shield. */
  reset() {
    const c = CONFIG.player;
    this.lane = 1;
    this.state = 'run';
    this.position.set(laneX(1), 0, c.z);
    this._vy = 0; this._airT = 0; this._fastFall = false; this._slideQueued = false; this._slideT = 0;
    this._laneFrom = this._laneTo = laneX(1); this._laneT = 1; this._prevX = laneX(1);
    this._phase = 0; this._time = 0;
    this._w.fill(0); this._w[0] = 1;
    this._lean = 0; this._yaw = 0;
    this._deadT = 0;
    this._leanG.rotation.set(0, 0, 0);
    this._tumble.rotation.set(0, 0, 0);
    this._tumble.position.set(0, 0, 0);
    this._restoreMaterials(1, 0);
    this._trailX.fill(this.position.x); this._trailY.fill(0); this._trailK = 1;
    this.setShield(false);
    this._shieldK = 0; this._shieldBreakT = 0; this._shieldG.visible = false;
    this._computePose(0);
    this._applyPose();
    this._updateTrail(0);
  }

  /** Advance animation / physics. @param {number} dt @param {number} speed m/s (animation rate) */
  update(dt, speed) {
    const c = CONFIG.player;
    this._time += dt;
    const p = this.position;

    // --- lane tween (keeps running during jump/slide; frozen when dead)
    if (this.state !== 'dead' && this._laneT < 1) {
      this._laneT = Math.min(1, this._laneT + dt / this._laneDur);
      p.x = this._laneT >= 1 ? this._laneTo : this._laneFrom + (this._laneTo - this._laneFrom) * smooth01(this._laneT);
    }
    const vx = (p.x - this._prevX) / dt;
    this._prevX = p.x;

    // --- vertical physics
    if (this.state === 'jump' || (this.state === 'dead' && (p.y > 0 || this._vy > 0))) {
      this._airT += dt;
      if (this._fastFall) {
        p.y -= c.fastFallSpeed * dt;
        this._vy = -c.fastFallSpeed;
      } else {
        // exact integration for constant gravity (apex / airtime independent of dt)
        p.y += this._vy * dt - 0.5 * this._g * dt * dt;
        this._vy -= this._g * dt;
      }
      if (p.y <= 1e-6 && this._vy < 0) {
        p.y = 0; this._vy = 0; this._fastFall = false;
        if (this.state === 'jump') {
          emit(EVENTS.PLAYER_LAND, { position: p });
          if (this._slideQueued) { this._slideQueued = false; this._startSlide(false); }
          else this.state = 'run';
        }
      }
    } else if (this.state === 'slide') {
      this._slideT -= dt;
      if (this._slideT <= 0) { this._slideT = 0; this.state = 'run'; }
    }

    // --- animation
    const ratio = Math.max(0, Math.min(1, (speed - CONFIG.speed.start) / (CONFIG.speed.max - CONFIG.speed.start)));
    if (this.state !== 'dead' && speed > 0.1) {
      const freq = 1.2 + speed * 0.055; // strides (L+R) per second
      this._phase = (this._phase + Math.PI * 2 * freq * dt) % (Math.PI * 2);
    }
    const target = this.state === 'run' ? 0 : this.state === 'jump' ? 1 : this.state === 'slide' ? 2 : 3;
    const k = 1 - Math.exp(-(target === 3 ? 10 : POSE_RATE) * dt);
    for (let i = 0; i < 4; i++) this._w[i] += ((i === target ? 1 : 0) - this._w[i]) * k;
    this._computePose(ratio);
    this._applyPose();

    // bank into lane changes
    const leanK = 1 - Math.exp(-14 * dt);
    const leanT = this.state === 'dead' ? 0 : Math.max(-0.35, Math.min(0.35, -vx * LEAN_PER_MPS));
    this._lean += (leanT - this._lean) * leanK;
    this._yaw += (leanT * 0.6 - this._yaw) * leanK;
    this._leanG.rotation.z = this._lean;
    this._leanG.rotation.y = this._yaw;

    if (this.state === 'dead') this._updateDeath(dt);
    this._updateShield(dt);
    this._updateTrail(this.state === 'dead' ? 0 : speed * dt, dt);
  }

  /** @returns {boolean} true if a lane change started */
  moveLeft() { return this._changeLane(-1); }
  /** @returns {boolean} */
  moveRight() { return this._changeLane(1); }

  _changeLane(dir) {
    if (this.state === 'dead') return false;
    const to = this.lane + dir;
    if (to < 0 || to >= CONFIG.lanes.count) return false;
    const from = this.lane;
    this.lane = /** @type {0|1|2} */ (to);
    this._laneFrom = this.position.x;
    this._laneTo = laneX(to);
    const dist = Math.abs(this._laneTo - this._laneFrom) / CONFIG.lanes.width;
    this._laneDur = CONFIG.player.laneChangeTime * Math.max(0.35, Math.min(2, dist));
    this._laneT = 0;
    emit(EVENTS.PLAYER_LANE, { lane: this.lane, from });
    return true;
  }

  /** @returns {boolean} true if a jump started (only from ground) */
  jump() {
    if (this.state === 'dead' || this.state === 'jump') return false;
    this.state = 'jump';
    this._slideT = 0;
    this._vy = this._v0;
    this._airT = 0;
    this._fastFall = false;
    this._slideQueued = false;
    emit(EVENTS.PLAYER_JUMP, {});
    return true;
  }

  /** @returns {boolean} true if a slide started (mid-air: fast-fall then slide) */
  slide() {
    if (this.state === 'dead') return false;
    if (this.state === 'jump') {
      if (this._fastFall) return false;
      this._fastFall = true;
      this._slideQueued = true;
      emit(EVENTS.PLAYER_SLIDE, {});
      return true;
    }
    this._startSlide(true);
    return true;
  }

  _startSlide(doEmit) {
    this.state = 'slide';
    this._slideT = CONFIG.player.slideDuration;
    if (doEmit) emit(EVENTS.PLAYER_SLIDE, {});
  }

  /** World-space AABB hitbox (already shrunk by hitboxShrink; height depends on state).
   *  @param {THREE.Box3} [out] @returns {THREE.Box3} */
  getBounds(out = this._box) {
    const c = CONFIG.player, hw = c.width / 2 - c.hitboxShrink, hd = c.depth / 2 - c.hitboxShrink;
    const h = this.state === 'slide' ? c.slideHeight : c.height, p = this.position;
    out.min.set(p.x - hw, p.y, p.z - hd);
    out.max.set(p.x + hw, p.y + h, p.z + hd);
    return out;
  }

  /** Show/hide shield bubble. @param {boolean} on */
  setShield(on) {
    on = !!on;
    if (on === this.shield) return;
    this.shield = on;
    if (on) { this._shieldG.visible = true; this._shieldBreakT = 0; }
    else if (this._shieldK > 0.01) this._shieldBreakT = 0.3; // pop outward and fade
  }

  /** Play death animation; state -> 'dead'; ignores further input. @param {string} [cause] obstacle type */
  die(cause) {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this._deadT = 0;
    this._slideQueued = false;
    this._laneT = 1; // freeze lateral where we are
    // low fence trips you forward; beams / walls knock you backward
    this._deathDir = cause === 'barrier' ? -1 : 1;
    // fall toward the track center (positive z-roll tips the body toward -x)
    this._deathSide = this.position.x > 0.01 ? 1 : this.position.x < -0.01 ? -1 : (this._lean > 0 ? -1 : 1);
    if (this._fastFall) this._fastFall = false;
    if (this.position.y > 0 && this._vy > 0) this._vy = 0;
  }

  /** true while airborne */
  get airborne() { return this.state === 'jump' || (this.state === 'dead' && this.position.y > 0); }

  dispose() {
    this.object3d.removeFromParent();
    for (const g of this._geos) g.dispose();
    for (const m of this._mats) m.dispose();
    this._geos.length = 0; this._mats.length = 0;
  }

  // ------------------------------------------------------------------ animation internals
  _computePose(ratio) {
    const [run, jump, slide, dead] = this._pose;
    const ph = this._phase, s = Math.sin(ph), co = Math.cos(ph);
    // RUN
    const amp = 0.75 + 0.3 * ratio;
    run[PY] = HIP_H - 0.05 + 0.06 * Math.abs(s);
    run[PRX] = 0;
    run[SRX] = -0.2 - 0.14 * ratio;
    run[TL] = amp * s;
    run[TR] = -amp * s;
    run[SL] = -0.15 - 1.45 * Math.max(0, co);
    run[SR] = -0.15 - 1.45 * Math.max(0, -co);
    run[UL] = -0.8 * amp * s;
    run[UR] = 0.8 * amp * s;
    run[FL] = 1.25 + 0.35 * s;
    run[FR] = 1.25 - 0.35 * s;
    run[AZ] = 0.12;
    run[HRX] = 0.15 + 0.1 * ratio;

    // JUMP: stretch on take-off/fast-fall, tuck around the apex
    const T = CONFIG.player.jumpDuration;
    let tuck = this.state === 'jump' ? Math.sin(Math.PI * Math.min(1, this._airT / T)) : 0;
    if (this._fastFall) tuck = 0;
    tuck = Math.pow(Math.max(0, tuck), 0.7);
    const st = 1 - tuck;
    jump[PY] = HIP_H * st + 0.66 * tuck;
    jump[PRX] = -0.1 * tuck;
    jump[SRX] = -0.1 * st - 0.35 * tuck;
    jump[TL] = 0.7 * st + 1.45 * tuck;
    jump[TR] = -0.35 * st + 1.05 * tuck;
    jump[SL] = -0.5 * st - 2.0 * tuck;
    jump[SR] = -0.4 * st - 1.7 * tuck;
    jump[UL] = (this._fastFall ? 2.6 : -0.6) * st + 1.2 * tuck;
    jump[UR] = (this._fastFall ? 2.6 : 2.2) * st + 0.9 * tuck;
    jump[FL] = 0.6 * st + 1.3 * tuck;
    jump[FR] = 0.3 * st + 1.3 * tuck;
    jump[AZ] = 0.35 * st + 0.45 * tuck;
    jump[HRX] = 0.1 + 0.2 * tuck;

    // SLIDE: lean back, low, lead leg straight, trailing leg tucked, one hand trailing on the ground
    slide[PY] = 0.3;
    slide[PRX] = 1.18;
    slide[SRX] = -0.3;
    slide[TL] = 0.3;
    slide[TR] = 0.95;
    slide[SL] = -0.1;
    slide[SR] = -1.9;
    slide[UL] = -0.5;
    slide[UR] = 1.0;
    slide[FL] = 0.2;
    slide[FR] = 0.9;
    slide[AZ] = 0.55;
    slide[HRX] = -0.75;

    // DEAD: limp, splayed (the tumble group supplies the fall)
    const td = this._deadT;
    const flail = Math.max(0, 1 - td / 0.7);
    dead[PY] = HIP_H;
    dead[PRX] = 0;
    dead[SRX] = 0.15 * this._deathDir;
    dead[TL] = 0.5 + 0.4 * Math.sin(td * 22) * flail;
    dead[TR] = -0.2 - 0.4 * Math.sin(td * 22) * flail;
    dead[SL] = -0.6;
    dead[SR] = -0.3;
    dead[UL] = 2.6 + 0.4 * Math.sin(td * 18) * flail;
    dead[UR] = 2.3 - 0.4 * Math.sin(td * 18) * flail;
    dead[FL] = 0.3;
    dead[FR] = 0.5;
    dead[AZ] = 0.9;
    dead[HRX] = 0.3 * this._deathDir;

    const w = this._w, out = this._final;
    const sum = w[0] + w[1] + w[2] + w[3] || 1;
    for (let j = 0; j < J; j++) out[j] = (run[j] * w[0] + jump[j] * w[1] + slide[j] * w[2] + dead[j] * w[3]) / sum;
  }

  _applyPose() {
    const f = this._final;
    this._pelvis.position.y = f[PY];
    this._pelvis.rotation.x = f[PRX];
    this._spine.rotation.x = f[SRX];
    this._thighL.rotation.x = f[TL];
    this._thighR.rotation.x = f[TR];
    this._shinL.rotation.x = f[SL];
    this._shinR.rotation.x = f[SR];
    this._upperL.rotation.x = f[UL];
    this._upperR.rotation.x = f[UR];
    this._upperL.rotation.z = -f[AZ];
    this._upperR.rotation.z = f[AZ];
    this._foreL.rotation.x = f[FL];
    this._foreR.rotation.x = f[FR];
    this._neck.rotation.x = f[HRX];
  }

  _updateDeath(dt) {
    this._deadT += dt;
    const t = this._deadT, dir = this._deathDir;
    // fall over around the feet, knocked back (dir 1) or tripped forward (dir -1)
    const fall = easeOutCubic(Math.min(1, t / 0.55));
    const settle = t > 0.55 ? Math.exp(-(t - 0.55) * 6) * Math.sin((t - 0.55) * 20) * 0.08 : 0;
    const side = this._deathSide;
    if (dir < 0) { // tripped: face-plant forward, slight twist
      this._tumble.rotation.x = -(Math.PI / 2 - 0.08) * fall + settle;
      this._tumble.rotation.z = 0.25 * side * fall;
      this._tumble.rotation.y = 0;
    } else {       // knocked back: spin and fall onto the side (reads well from the chase cam)
      this._tumble.rotation.x = 0;
      this._tumble.rotation.y = side * 0.9 * fall;
      this._tumble.rotation.z = side * (Math.PI / 2 - 0.12) * fall + settle;
    }
    const hop = t < 0.45 ? Math.sin((Math.PI * t) / 0.45) * 0.5 : 0;
    this._tumble.position.y = hop + 0.12 * fall;
    this._tumble.position.z = (dir > 0 ? 0.7 : -0.5) * easeOutCubic(Math.min(1, t / 0.6));
    // hit flash → flicker → dim
    let glow, flash;
    if (t < 0.12) { flash = 1; glow = 1; }
    else {
      flash = Math.max(0, 1 - (t - 0.12) / 0.25);
      const flick = t < 0.9 && Math.sin(t * 60) > 0.3 ? 0.35 : 1;
      glow = Math.max(0.28, 1 - (t - 0.12) * 0.8) * flick;
    }
    this._restoreMaterials(glow, flash);
  }

  _restoreMaterials(glow, flash) {
    const tc = this._tmpC;
    this.matCyan.color.copy(tc.copy(this._cyanBase).multiplyScalar(glow).lerp(this._white, flash));
    this.matPink.color.copy(tc.copy(this._pinkBase).multiplyScalar(glow).lerp(this._white, flash));
    this.matVisor.color.copy(this.matCyan.color);
    this.matSuit.emissive.copy(this._suitEmissive).lerp(this._white, flash * 0.25);
    this.matArmor.emissive.copy(this._armorEmissive).lerp(this._white, flash * 0.25);
  }

  _updateShield(dt) {
    const g = this._shieldG;
    if (!g.visible) return;
    const u = this.matShield.uniforms;
    u.uTime.value = this._time;
    const sliding = this._w[2];
    let scale, alpha;
    if (this.shield) {
      this._shieldK = Math.min(1, this._shieldK + dt * 6);
      const pop = easeOutCubic(this._shieldK);
      const pulse = 1 + 0.035 * Math.sin(this._time * 6.5);
      scale = pop * pulse * (1 + 0.25 * (1 - pop));
      alpha = pop * (0.85 + 0.15 * Math.sin(this._time * 6.5 + 1.2));
    } else if (this._shieldBreakT > 0) {
      this._shieldBreakT -= dt;
      const k = Math.max(0, this._shieldBreakT / 0.3);
      scale = this._shieldK * (1 + 0.6 * (1 - k));
      alpha = k;
      if (this._shieldBreakT <= 0) { g.visible = false; this._shieldK = 0; }
    } else { g.visible = false; this._shieldK = 0; return; }
    // squash down with the body while sliding
    g.position.y = 0.9 - 0.42 * sliding;
    g.scale.set(scale * (1 + 0.1 * sliding), scale * (1 - 0.4 * sliding), scale * (1 + 0.1 * sliding));
    g.rotation.y = this._time * 0.6;
    u.uAlpha.value = alpha;
    this.matShieldWire.opacity = 0.07 * alpha;
  }

  _updateTrail(dz, dt = 0) {
    const n = TRAIL_N, xs = this._trailX, ys = this._trailY, p = this.position;
    if (dz > 0) {
      for (let i = n - 1; i > 0; i--) { xs[i] = xs[i - 1]; ys[i] = ys[i - 1]; }
      xs[0] = p.x; ys[0] = p.y;
      this._trailDz = dz;
      this._trailK = Math.min(1, this._trailK + dt * 4);
    } else if (dt > 0) {
      this._trailK = Math.max(0, this._trailK - dt * 2.5);
    }
    const step = this._trailDz || 0.25;
    const arr = this._trailPos.array;
    const half = 0.13;
    for (let i = 0; i < n; i++) {
      const x = xs[i] - p.x, y = ys[i] - p.y + 0.03, z = 0.12 + i * step;
      const w = half * (1 - 0.5 * i / (n - 1));
      const o = i * 9;
      arr[o] = x - w; arr[o + 1] = y; arr[o + 2] = z;
      arr[o + 3] = x; arr[o + 4] = y; arr[o + 5] = z;
      arr[o + 6] = x + w; arr[o + 7] = y; arr[o + 8] = z;
    }
    this._trailPos.needsUpdate = true;
    this.matTrail.color.setScalar(0.55 * this._trailK);
    this._trail.visible = this._trailK > 0.01;
  }
}
