// Neon Runner — tuning parameters (CONTRACT FILE, owned by the orchestrator).
// Every magic number used by more than one module lives here. Modules may add
// module-private constants in their own files, but must READ shared values from here.
// Units: meters, seconds, radians. Colors: 0xRRGGBB numbers (use `hex()` for CSS strings).
//
// Coordinate system (see ARCHITECTURE.md §2):
//   +x = right, +y = up, -z = forward (the direction the runner faces).
//   The player stays at z = 0. The WORLD scrolls toward +z by `speed * dt` each step.

export const CONFIG = Object.freeze({
  // ---- simulation -------------------------------------------------------
  sim: Object.freeze({
    step: 1 / 60,          // fixed timestep (s) for all update(dt) calls
    maxSubSteps: 5,        // max fixed steps per rendered frame (spiral-of-death guard)
    maxFrameDelta: 0.25,   // clamp real frame delta (s) after tab switches
  }),

  // ---- lanes ------------------------------------------------------------
  lanes: Object.freeze({
    count: 3,
    width: 2.4,                 // distance between lane centers (m)
    x: Object.freeze([-2.4, 0, 2.4]), // lane index 0 = left, 1 = center, 2 = right
    trackWidth: 7.8,            // visible track surface width (m)
  }),

  // ---- speed curve ------------------------------------------------------
  // speed(t) = start + (max - start) * (1 - exp(-t / tau)),  t = seconds since run start
  speed: Object.freeze({
    start: 14,        // m/s
    max: 40,          // m/s
    tau: 80,          // s — time constant of the ease-in
    demo: 16,         // constant speed used by the title-screen demo
    changedEvery: 1,  // emit speed:changed whenever floor(speed / changedEvery) changes
  }),

  // ---- player -----------------------------------------------------------
  player: Object.freeze({
    z: 0,
    width: 0.7,            // hitbox (m)
    depth: 0.7,
    height: 1.7,           // standing / running hitbox height
    slideHeight: 0.7,      // hitbox height while sliding
    hitboxShrink: 0.1,     // hitbox inset on x/z for forgiveness (m, each side)
    jumpHeight: 2.0,       // apex height of feet above ground (m)
    jumpDuration: 0.65,    // total airtime (s); gravity derived: g = 8h / T^2
    slideDuration: 0.75,   // s
    laneChangeTime: 0.13,  // s to tween between adjacent lanes
    fastFallSpeed: 18,     // m/s downward when slide pressed mid-air
    color: 0x00f0ff,
    accent: 0xff2bd6,
  }),

  // ---- obstacles (dimensions define which action is required) -----------
  //   barrier : low fence  -> must JUMP   (top < player's jump clearance)
  //   bar     : overhead   -> must SLIDE  (bottom between slideHeight and height)
  //   wall    : full block -> must CHANGE LANE
  obstacles: Object.freeze({
    barrier: Object.freeze({ width: 2.0, height: 0.9, depth: 0.35, bottom: 0,   color: 0xff3355 }),
    bar:     Object.freeze({ width: 2.2, height: 0.5, depth: 0.35, bottom: 1.15, color: 0xffaa00 }),
    wall:    Object.freeze({ width: 2.1, height: 3.2, depth: 1.2,  bottom: 0,   color: 0x9d4dff }),
    // bar is drawn with posts to the ground on both sides of the lane, but ONLY the
    // crossbar (bottom..bottom+height, extended up to 3.2 for the hitbox) is solid.
    barHitboxTop: 3.2,
    weights: Object.freeze({ barrier: 0.34, bar: 0.30, wall: 0.36 }),
  }),

  // ---- spawner ----------------------------------------------------------
  spawner: Object.freeze({
    spawnZ: -140,            // new rows are placed at this z (ahead of player)
    despawnZ: 12,            // objects with z > despawnZ are recycled
    firstRowZ: -60,          // first row of a fresh run (gives ~4 s of warm-up at start speed)
    rowGapMin: 16,           // min distance between obstacle rows (m)
    rowGapMax: 30,
    rowGapTime: 0.6,         // gap is also at least speed * rowGapTime (reaction window)
    // number of lanes blocked in a row: probabilities for 1, 2, 3 lanes
    blockedLanes: Object.freeze([0.55, 0.38, 0.07]),
    // RULES (guaranteed path, enforced by spawner):
    //  1. at least one lane per row has NO wall.
    //  2. a row that blocks all 3 lanes contains no wall and uses ONE obstacle type.
    //  3. the free lane of row N must be reachable from the free lanes of row N-1
    //     within the gap (lane change time + reaction), otherwise keep same free lane.
    coinTrailChance: 0.7,    // chance to lay a coin trail between two rows
    coinSpacing: 2.2,        // m between coins in a trail
    coinTrailMax: 8,
    coinY: 1.0,              // coin center height (m); coins over barriers arc up
    powerupChance: 0.08,     // per row
    powerupMinDistance: 220, // m between power-up spawns
    poolSize: Object.freeze({ barrier: 16, bar: 16, wall: 16, coin: 80, powerup: 6 }),
  }),

  // ---- collectibles -----------------------------------------------------
  coin: Object.freeze({
    radius: 0.4,
    pickupRadius: 0.9,     // added around player hitbox for pickup test
    spinSpeed: 4,          // rad/s
    value: 1,
    points: 10,
    color: 0xffd700,
  }),

  powerups: Object.freeze({
    types: Object.freeze(['magnet', 'shield', 'double']),
    duration: Object.freeze({ magnet: 10, shield: 15, double: 10 }), // seconds
    magnetRadius: 10,       // m — coins inside are pulled toward player
    magnetPullSpeed: 35,    // m/s
    shieldGraceTime: 1.0,   // s of invulnerability after shield absorbs a hit
    scoreMultiplier: 2,     // 'double'
    radius: 0.55,
    y: 1.2,
    color: Object.freeze({ magnet: 0xff4df0, shield: 0x00f0ff, double: 0xffe600 }),
  }),

  // ---- scoring ----------------------------------------------------------
  score: Object.freeze({
    pointsPerMeter: 1,
    storageKeyHigh: 'neonRunner.highScore',
    storageKeyMuted: 'neonRunner.muted',
  }),

  // ---- camera -----------------------------------------------------------
  camera: Object.freeze({
    fov: 62,
    near: 0.1,
    far: 400,
    offset: Object.freeze([0, 3.3, 6.8]),     // relative to player (x follows lane * followX)
    lookAt: Object.freeze([0, 1.2, -10]),
    followX: 0.6,         // fraction of the player's x the camera follows
    followLerp: 8,        // 1/s
    shake: Object.freeze({ hit: 0.6, shield: 0.3, decay: 3.0 }), // amplitude (m), decay 1/s
  }),

  // ---- world / rendering ------------------------------------------------
  world: Object.freeze({
    chunkLength: 40,       // m per recyclable scenery chunk
    chunkCount: 7,         // chunks alive at once (covers chunkLength * chunkCount m)
    fogNear: 50,
    fogFar: 190,
    maxPixelRatio: 2,
    maxPixelRatioMobile: 1.5,
    bloom: Object.freeze({ strength: 0.85, radius: 0.5, threshold: 0.2 }),
  }),

  // ---- effects ----------------------------------------------------------
  effects: Object.freeze({
    maxParticles: 500,
    coinBurst: 10,
    hitBurst: 60,
    powerupBurst: 40,
  }),

  // ---- input ------------------------------------------------------------
  input: Object.freeze({
    swipeMinDistance: 30,  // px
    swipeMaxTime: 600,     // ms
    tapMaxDistance: 12,    // px
  }),

  // ---- audio ------------------------------------------------------------
  audio: Object.freeze({
    master: 0.6,
    music: 0.32,
    sfx: 0.7,
    bpm: 116,
  }),

  // ---- color theme (synthwave) -----------------------------------------
  colors: Object.freeze({
    background: 0x07001a,
    fog: 0x1a0033,
    grid: 0xff2bd6,
    gridAlt: 0x00f0ff,
    track: 0x0b0320,
    horizon: 0xff2266,
    sunTop: 0xffd319,
    sunBottom: 0xff2bd6,
    skyTop: 0x05001a,
    skyBottom: 0x3d0060,
    mountain: 0x14002e,
    mountainEdge: 0xff2bd6,
    cyan: 0x00f0ff,
    magenta: 0xff2bd6,
    purple: 0x9d4dff,
    yellow: 0xffe600,
  }),
});

/** Convert a 0xRRGGBB number into a CSS '#rrggbb' string. */
export function hex(n) {
  return '#' + n.toString(16).padStart(6, '0');
}

/** Lane index (0..2) -> world x. */
export function laneX(lane) {
  return CONFIG.lanes.x[lane];
}

/** speed(t) per the curve above. */
export function speedAt(t) {
  const s = CONFIG.speed;
  return s.start + (s.max - s.start) * (1 - Math.exp(-t / s.tau));
}
