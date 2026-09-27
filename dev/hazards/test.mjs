// Hazards & FX automated checks. Run: python3 -m http.server 8103 (project root) && node dev/hazards/test.mjs
import { launch } from '../launch.mjs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, 'shots');
mkdirSync(SHOTS, { recursive: true });
const BASE = process.env.BASE || 'http://localhost:8103/dev/hazards/index.html';
const ONLY = process.argv[2] || 'all';

const browser = await launch();
const errors = [];
let failures = 0;
const ok = (cond, msg, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};

async function open(query = '') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(BASE + query);
  await page.waitForFunction(() => window.__H_READY === true, null, { timeout: 30000 });
  return page;
}

const page = await open();

// ---------------------------------------------------------------------------------------------
// (a) path guarantee + content sanity over long simulated runs
if (ONLY === 'all' || ONLY === 'path') {
  const res = await page.evaluate(() => {
    const { THREE, CONFIG, Spawner, speedAt } = window.__H;
    const P = CONFIG.player, OB = CONFIG.obstacles;
    const out = [];
    for (const mode of [14, 20, 28, 34, 40, 'ramp']) {
      const scene = new THREE.Scene();
      const sp = new Spawner(scene);
      sp.debugLog = [];
      const dt = CONFIG.sim.step;
      let distance = 0, t = 0;
      const playerPos = new THREE.Vector3(0, 0, 0);
      const puAbs = []; const seenPU = new Set();
      let overlap = 0; let checks = 0;
      while (distance < 8000) {
        const speed = mode === 'ramp' ? speedAt(t) : mode;
        sp.update(dt, speed, { distance, playerPos, magnet: false });
        for (const u of sp.powerups) if (!seenPU.has(u.id)) { seenPU.add(u.id); puAbs.push(distance - u.obj.position.z); }
        // every ~0.5s: no coin / power-up inside an obstacle hitbox
        if (Math.round(t / dt) % 30 === 0) {
          checks++;
          for (const list of [sp.coins, sp.powerups]) for (const c of list) {
            const p = c.obj.position, r = list === sp.coins ? CONFIG.coin.radius : CONFIG.powerups.radius;
            for (const o of sp.obstacles) {
              const d = OB[o.type], q = o.obj.position;
              const y1 = o.type === 'bar' ? OB.barHitboxTop : d.bottom + d.height;
              if (Math.abs(p.x - q.x) < d.width / 2 + r && Math.abs(p.z - q.z) < d.depth / 2 + r &&
                  p.y + r > d.bottom && p.y - r < y1) overlap++;
            }
          }
        }
        distance += speed * dt; t += dt;
      }
      const rows = sp.debugLog;
      let noWallFree = 0, badFull = 0, minGap = Infinity, unsolvable = 0, fullRows = 0, walls = 0, barriers = 0, bars = 0;
      // BFS solver over lanes. Transition a->b possible if |a-b|*laneChangeTime + reaction <= time between rows.
      // Same-lane consecutive barriers need time to land & re-jump.
      let reach = [true, true, true];
      const needLand = P.jumpDuration * 0.35;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const L = r.lanes;
        if (!L.some((x) => x !== 'wall')) noWallFree++;
        if (L.every((x) => x)) {
          fullRows++;
          if (L.includes('wall') || new Set(L).size !== 1) badFull++;
        }
        for (const x of L) { if (x === 'wall') walls++; else if (x === 'barrier') barriers++; else if (x === 'bar') bars++; }
        let rowTime = Infinity;
        if (i > 0) {
          const gap = r.abs - rows[i - 1].abs;
          minGap = Math.min(minGap, gap);
          rowTime = gap / r.speed;
        }
        const next = [false, false, false];
        for (let b = 0; b < 3; b++) {
          if (L[b] === 'wall') continue;
          for (let a = 0; a < 3; a++) {
            if (!reach[a]) continue;
            let need = Math.abs(a - b) * P.laneChangeTime + 0.2;
            if (a === b && i > 0 && L[b] === 'barrier' && rows[i - 1].lanes[a] === 'barrier') need = Math.max(need, needLand);
            if (need <= rowTime) { next[b] = true; break; }
          }
        }
        if (!next.some(Boolean)) { unsolvable++; reach = [true, true, true]; } else reach = next;
      }
      puAbs.sort((a, b) => a - b);
      let minPU = Infinity;
      for (let i = 1; i < puAbs.length; i++) minPU = Math.min(minPU, puAbs[i] - puAbs[i - 1]);
      out.push({ mode, rows: rows.length, noWallFree, badFull, fullRows, minGap: +minGap.toFixed(2), unsolvable,
        walls, barriers, bars, powerups: puAbs.length, minPUSpacing: Math.round(minPU), overlap, checks,
        created: { ...sp.created } });
      sp.dispose();
    }
    return out;
  });
  for (const r of res) {
    console.log('   ', JSON.stringify(r));
    ok(r.noWallFree === 0 && r.badFull === 0 && r.unsolvable === 0 && r.minGap >= 16 && r.overlap === 0 &&
       (r.powerups < 2 || r.minPUSpacing >= 220),
       `path guarantee @ ${r.mode} m/s over 8000 m (${r.rows} rows)`);
  }
}

// ---------------------------------------------------------------------------------------------
// (b) collide() correctness
if (ONLY === 'all' || ONLY === 'collide') {
  const res = await page.evaluate(() => {
    const { THREE, CONFIG, Spawner, laneX } = window.__H;
    const P = CONFIG.player;
    const sp = new Spawner(new THREE.Scene());
    sp.setEnabled(false);
    const box = (lane, feet, h, x) => {
      const hw = P.width / 2 - P.hitboxShrink, hd = P.depth / 2 - P.hitboxShrink, cx = x ?? laneX(lane);
      return new THREE.Box3(new THREE.Vector3(cx - hw, feet, -hd), new THREE.Vector3(cx + hw, feet + h, hd));
    };
    const poses = { run: [0, P.height], jump: [1.2, P.height], slide: [0, P.slideHeight] };
    const table = {};
    for (const type of ['barrier', 'bar', 'wall']) {
      table[type] = {};
      for (const [pose, [feet, h]] of Object.entries(poses)) {
        sp.reset(); sp.spawnRow(0, [type, null, null]);
        const first = sp.collide(box(0, feet, h)).filter((x) => x.kind === 'obstacle' && x.type === type).length;
        const second = sp.collide(box(0, feet, h)).length;
        const other = (sp.reset(), sp.spawnRow(0, [type, null, null]), sp.collide(box(1, feet, h)).length);
        table[type][pose] = { first, second, otherLane: other };
      }
    }
    // bar posts are not solid: sliding at the post x
    sp.reset(); sp.spawnRow(0, ['bar', null, null]);
    const postSlide = sp.collide(box(0, 0, P.slideHeight, laneX(0) + CONFIG.obstacles.bar.width / 2 + 0.04)).length;
    // tunneling: obstacle approaching at 40 m/s is detected exactly once
    const tunnel = {};
    for (const type of ['barrier', 'bar', 'wall']) {
      sp.reset(); sp.spawnRow(-10, [null, type, null]);
      let n = 0;
      for (let i = 0; i < 60; i++) {
        sp.update(CONFIG.sim.step, 40, { distance: 0, playerPos: new THREE.Vector3(), magnet: false });
        n += sp.collide(box(1, 0, P.height)).length;
      }
      tunnel[type] = n;
    }
    // coins & power-ups: picked once, removed
    sp.reset(); sp.spawnRow(0, ['coin', 'magnet', null]); sp.spawnRow(0.5, [null, null, 'double']); sp.spawnRow(-0.3, [null, null, 'shield']);
    const c1 = sp.collide(box(0, 0, P.height)).map((h) => h.kind);
    const c2 = sp.collide(box(0, 0, P.height)).length;
    const p1 = sp.collide(box(1, 0, P.height)).map((h) => h.kind + ':' + h.type);
    const p2 = sp.collide(box(1, 0, P.height)).length;
    const p3 = sp.collide(box(2, 0, P.height)).map((h) => h.type).sort();
    const st = sp.stats();
    // coins over a barrier: a jumping player at mid arc still picks them
    const ahead = (sp.reset(), sp.spawnRow(-5, ['wall', 'bar', 'barrier']), sp.getObstaclesAhead(-1, -40).map((o) => `${o.type}@${o.lane}`));
    sp.dispose();
    return { table, postSlide, tunnel, c1, c2, p1, p2, p3, st, ahead };
  });
  console.log('   ', JSON.stringify(res));
  const T = res.table;
  const expect = { barrier: { run: 1, jump: 0, slide: 1 }, bar: { run: 1, jump: 1, slide: 0 }, wall: { run: 1, jump: 1, slide: 1 } };
  for (const type in expect) for (const pose in expect[type]) {
    ok(T[type][pose].first === expect[type][pose] && T[type][pose].second === 0 && T[type][pose].otherLane === 0,
      `collide ${type} vs ${pose}: expect ${expect[type][pose]}`, JSON.stringify(T[type][pose]));
  }
  ok(res.postSlide === 0, 'bar side posts are not solid');
  ok(res.tunnel.barrier === 1 && res.tunnel.bar === 1 && res.tunnel.wall === 1, 'approaching obstacle at 40 m/s reported exactly once', JSON.stringify(res.tunnel));
  ok(res.c1.length === 1 && res.c1[0] === 'coin' && res.c2 === 0, 'coin picked up once');
  ok(res.p1.length === 1 && res.p1[0] === 'powerup:magnet' && res.p2 === 0, 'power-up picked up once');
  ok(res.p3.join() === 'double,shield', 'pickup radius covers nearby power-ups');
  ok(res.st.coins === 0 && res.st.powerups === 0, 'picked items returned to pool');
  ok(res.ahead.join() === 'wall@0,bar@1,barrier@2', 'getObstaclesAhead', res.ahead.join());
}

// ---------------------------------------------------------------------------------------------
// (c) pools bounded over a long run with the autopilot fake player; (d) magnet
if (ONLY === 'all' || ONLY === 'pool') {
  const res = await page.evaluate(() => {
    const H = window.__H;
    const { spawner: sp, state } = H;
    H.running = false;
    state.rampSpeed = true; state.time = 0; state.distance = 0; state.emitEvents = true;
    state.hits = { barrier: 0, bar: 0, wall: 0 }; state.coins = 0; state.powerups = 0; state.hitLog = [];
    sp.reset(); H.player.reset(); H.effects.reset();
    const max = { obstacles: 0, coins: 0, powerups: 0 };
    let children0 = 0;
    for (let i = 0; i < 60 * 600; i++) { // 10 simulated minutes
      H.step(1);
      const s = sp.stats();
      for (const k in max) max[k] = Math.max(max[k], s[k]);
      if (i === 60 * 60) children0 = sp.root.children.length;
    }
    return { distance: Math.round(state.distance), max, created: { ...sp.created }, children0, children1: sp.root.children.length,
      hits: state.hits, coins: state.coins, powerups: state.powerups, hitLog: state.hitLog.slice(0, 5), fxAlive: H.effects.alive };
  });
  console.log('   ', JSON.stringify(res));
  const P = { barrier: 16, bar: 16, wall: 16, coin: 80 };
  ok(res.children1 === res.children0 && Object.keys(P).every((k) => res.created[k] <= P[k] * 2),
    `pools bounded over ${res.distance} m`, `created=${JSON.stringify(res.created)}`);
  ok(res.hits.barrier + res.hits.bar + res.hits.wall === 0, 'autopilot fake player (real jump/slide/lane physics) completes the run with 0 hits', JSON.stringify(res.hits));
  ok(res.coins > 100 && res.powerups > 3, 'coins & power-ups collectible along the way', `coins=${res.coins} powerups=${res.powerups}`);

  const mag = await page.evaluate(() => {
    const { THREE, CONFIG, Spawner } = window.__H;
    const sp = new Spawner(new THREE.Scene());
    sp.setEnabled(false);
    const pp = new THREE.Vector3(0, 0, 0);
    sp.spawnRow(-8, [null, 'coin', null]); sp.spawnRow(-8, ['coin', null, null]); sp.spawnRow(-30, [null, 'coin', null]);
    const [near, side, far] = sp.coins;
    const d = (c) => c.obj.position.distanceTo(new THREE.Vector3(pp.x, pp.y + CONFIG.player.height / 2, pp.z));
    const d0 = [d(near), d(side), d(far)];
    for (let i = 0; i < 6; i++) sp.update(CONFIG.sim.step, 0, { distance: 0, playerPos: pp, magnet: true });
    const d1 = [d(near), d(side), d(far)];
    // without magnet nothing moves
    const sp2 = new Spawner(new THREE.Scene()); sp2.setEnabled(false); sp2.spawnRow(-8, [null, 'coin', null]);
    const z0 = sp2.coins[0].obj.position.z;
    for (let i = 0; i < 6; i++) sp2.update(CONFIG.sim.step, 0, { distance: 0, playerPos: pp, magnet: false });
    const still = sp2.coins[0].obj.position.z === z0;
    // pulled coins get collected
    let got = 0;
    const box = new THREE.Box3(new THREE.Vector3(-0.25, 0, -0.25), new THREE.Vector3(0.25, 1.7, 0.25));
    for (let i = 0; i < 180; i++) { sp.update(CONFIG.sim.step, 14, { distance: 0, playerPos: pp, magnet: true }); got += sp.collide(box).length; }
    sp.dispose(); sp2.dispose();
    return { d0, d1, still, got };
  });
  console.log('   ', JSON.stringify(mag));
  const pulled = 35 * 6 / 60;
  ok(Math.abs(mag.d0[0] - mag.d1[0] - pulled) < 0.05 && mag.d1[1] < mag.d0[1] && Math.abs(mag.d1[2] - mag.d0[2]) < 1e-9 && mag.still,
    'magnet pulls coins within radius at magnetPullSpeed (not those outside / without magnet)');
  ok(mag.got === 3, 'magnet-pulled coins (incl. side lane) get collected', `got=${mag.got}`);
}

// ---------------------------------------------------------------------------------------------
// (e) effects
if (ONLY === 'all' || ONLY === 'fx') {
  const res = await page.evaluate(async () => {
    const H = window.__H;
    const { bus, EVENTS, CONFIG, effects: fx, camera, THREE, scene } = H;
    H.running = false;
    fx.reset();
    const r = {};
    const pos = { x: 0, y: 1, z: -5 };
    const n = () => fx.alive;
    bus.emit(EVENTS.COIN_COLLECTED, { position: pos, total: 1, value: 1 }); r.coin = n(); fx.reset();
    bus.emit(EVENTS.POWERUP_COLLECTED, { type: 'shield', position: pos }); r.powerup = n(); fx.reset();
    bus.emit(EVENTS.PLAYER_HIT, { type: 'wall', position: pos, shielded: false }); r.hit = n(); r.shakeHit = fx.shakeAmp; fx.reset();
    bus.emit(EVENTS.PLAYER_HIT, { type: 'bar', position: pos, shielded: true }); r.shakeShield = fx.shakeAmp; fx.reset();
    bus.emit(EVENTS.SHIELD_BREAK, { position: pos }); r.shieldBreak = n();
    bus.emit(EVENTS.PLAYER_LAND, { position: { x: 0, y: 0, z: 0 } }); r.land = n() - r.shieldBreak;
    bus.emit(EVENTS.GAME_START, {}); r.afterStart = n();
    fx.burst(pos, { count: 5000 }); r.cap = n();
    // particles scroll with the world and die
    fx.reset(); fx.burst(pos, { count: 10, speed: 0, gravity: 0, life: 10 });
    const i0 = Array.from(fx.life).findIndex((l) => l > 0);
    const z0 = fx.pos[i0 * 3 + 2];
    for (let i = 0; i < 60; i++) fx.update(CONFIG.sim.step, 20);
    r.scroll = +(fx.pos[i0 * 3 + 2] - z0).toFixed(3);
    fx.reset(); fx.burst(pos, { count: 30, life: 0.5 });
    for (let i = 0; i < 60; i++) fx.update(CONFIG.sim.step, 20);
    r.diedOut = n();

    // shake: game-style (base pose set each frame) and caller that never resets (no drift)
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    H.setCameraBase(); const base = camera.position.clone();
    fx.shake(CONFIG.camera.shake.hit);
    let maxDev = 0;
    for (let i = 0; i < 120; i++) { H.setCameraBase(); fx.applyCameraShake(camera); maxDev = Math.max(maxDev, camera.position.distanceTo(base)); await sleep(16); }
    H.setCameraBase(); fx.applyCameraShake(camera);
    r.shakeMax = +maxDev.toFixed(3); r.shakeEnd = camera.position.distanceTo(base); r.ampEnd = fx.shakeAmp;
    H.setCameraBase(); fx.shake(0.6);
    let maxDev2 = 0;
    for (let i = 0; i < 150; i++) { fx.applyCameraShake(camera); maxDev2 = Math.max(maxDev2, camera.position.distanceTo(base)); await sleep(16); }
    fx.applyCameraShake(camera);
    r.noResetMax = +maxDev2.toFixed(3); r.noResetEnd = camera.position.distanceTo(base);
    // dispose unsubscribes
    const before = bus.listenerCount(EVENTS.PLAYER_HIT);
    const fx2 = new H.Effects(scene, camera);
    const during = bus.listenerCount(EVENTS.PLAYER_HIT);
    fx2.dispose();
    r.listeners = [before, during, bus.listenerCount(EVENTS.PLAYER_HIT)];
    r.sceneHasPoints = scene.children.includes(fx.points) && !scene.children.includes(fx2.points);
    return r;
  });
  console.log('   ', JSON.stringify(res));
  const FX = { coinBurst: 10, hitBurst: 60, powerupBurst: 40 };
  ok(res.coin === FX.coinBurst, 'coin:collected → gold sparkle');
  ok(res.powerup === FX.powerupBurst, 'powerup:collected → burst');
  ok(res.hit === FX.hitBurst && Math.abs(res.shakeHit - 0.6) < 1e-9, 'player:hit → big burst + shake(hit)');
  ok(Math.abs(res.shakeShield - 0.3) < 1e-9, 'shielded player:hit → shake(shield)');
  ok(res.shieldBreak === 48 && res.land === 10, 'shield:break ring + player:land sparks');
  ok(res.afterStart === 0, 'game:start → reset');
  ok(res.cap === 500, 'particle cap = maxParticles');
  ok(Math.abs(res.scroll - 20) < 0.01, 'particles scroll +z with the world', `dz=${res.scroll}`);
  ok(res.diedOut === 0, 'particles expire');
  ok(res.shakeMax > 0.2 && res.shakeEnd < 1e-9 && res.ampEnd === 0, 'shake visible then camera returns exactly to base', `max=${res.shakeMax}`);
  ok(res.noResetMax < 1.2 && res.noResetEnd < 1e-9, 'no drift when base pose is not re-set', `max=${res.noResetMax}`);
  ok(res.listeners[1] === res.listeners[0] + 1 && res.listeners[2] === res.listeners[0], 'dispose() unsubscribes', res.listeners.join('/'));
}

// ---------------------------------------------------------------------------------------------
// screenshots from the game camera
if (ONLY === 'all' || ONLY === 'shots') {
  const prep = async (p, rows, extra) => p.evaluate(({ rows, extra }) => {
    const H = window.__H;
    H.running = false;
    H.state.autopilot = false; H.state.collide = false;
    H.spawner.reset(); H.spawner.setEnabled(false); H.effects.reset();
    H.player.reset(); H.player.update(0);
    for (const [z, lanes] of rows) H.spawner.spawnRow(z, lanes);
    H.spawner.update(1 / 60, 0.0001, { distance: 0, playerPos: H.player.position, magnet: false });
    if (extra === 'burst') {
      const { bus, EVENTS } = H;
      bus.emit(EVENTS.PLAYER_HIT, { type: 'barrier', position: { x: 0, y: 0.9, z: -7 }, shielded: false });
      bus.emit(EVENTS.POWERUP_COLLECTED, { type: 'magnet', position: { x: -2.4, y: 1.2, z: -9 } });
      bus.emit(EVENTS.SHIELD_BREAK, { position: { x: 2.4, y: 1.0, z: -9 } });
      bus.emit(EVENTS.COIN_COLLECTED, { position: { x: 2.4, y: 1.0, z: -5 }, total: 1, value: 1 });
      H.effects.shake(0); // no shake in the screenshot
      for (let i = 0; i < 9; i++) H.effects.update(1 / 60, 0);
      H.effects.shakeAmp = 0;
    }
    H.render();
  }, { rows, extra });
  const shots = [
    ['obstacles', [[-13, ['barrier', 'bar', 'wall']]]],
    ['barrier_row', [[-11, ['barrier', 'barrier', 'barrier']]]],
    ['bar_row', [[-11, ['bar', 'bar', 'bar']]]],
    ['wall', [[-12, ['wall', null, 'wall']], [-30, [null, 'wall', null]]]],
    ['collectibles', [[-8, ['magnet', 'shield', 'double']], ...[0, 1, 2, 3, 4, 5].map((i) => [-14 - i * 2.2, ['coin', null, 'coin']])]],
    ['burst', [], 'burst'],
  ];
  for (const [name, rows, extra] of shots) {
    await prep(page, rows, extra);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  }
  // generated gameplay (ramped speed, autopilot)
  await page.evaluate(() => {
    const H = window.__H;
    H.spawner.reset(); H.spawner.setEnabled(true); H.player.reset(); H.effects.reset();
    Object.assign(H.state, { autopilot: true, collide: true, rampSpeed: true, time: 0, distance: 0 });
    H.step(60 * 25); H.render();
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOTS, 'gameplay.png') });

  // with the real World (bloom), if the World worker's module currently works
  const pw = await open('?world=1');
  const hasWorld = await pw.evaluate(() => !!window.__H.world);
  if (hasWorld) {
    for (const [name, rows, extra] of [shots[0], shots[4], shots[5]]) {
      await prep(pw, rows, extra);
      await pw.waitForTimeout(200);
      await pw.screenshot({ path: join(SHOTS, `world_${name}.png`) });
    }
    await pw.evaluate(() => {
      const H = window.__H;
      H.spawner.reset(); H.spawner.setEnabled(true); H.player.reset(); H.effects.reset();
      Object.assign(H.state, { autopilot: true, collide: true, rampSpeed: true, time: 0, distance: 0 });
      H.step(60 * 20); H.render();
    });
    await pw.waitForTimeout(200);
    await pw.screenshot({ path: join(SHOTS, 'world_gameplay.png') });
  }
  console.log(`    screenshots written to ${SHOTS} (world=${hasWorld})`);
}

console.log(`\nconsole errors: ${errors.length}`);
for (const e of errors) console.log('   ', e);
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
await browser.close();
process.exit(failures || errors.length ? 1 : 0);
