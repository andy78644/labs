// Orchestrator integration play-test. Usage: node dev/integration/playtest.mjs <port>
// Drives the real game through window.__NEON__ (contract §4.9) + real keyboard input.
import { launch } from '../launch.mjs';
import { mkdirSync } from 'node:fs';

const PORT = process.argv[2] || 8110;
const GAME_URL = `http://localhost:${PORT}/`;
const SHOTS = new URL('../../docs/screenshots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const errors = [];
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));

const N = (fn, arg) => page.evaluate(fn, arg);
const state = () => N(() => window.__NEON__.game.state);
const shot = (name) => page.screenshot({ path: SHOTS + name });

await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__NEON__ && window.__NEON__.game, null, { timeout: 20000 });
await N(() => { try { localStorage.clear(); } catch {} });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__NEON__ && window.__NEON__.game);
await page.waitForTimeout(2500);
check('boots into title', (await state()) === 'title', await state());
await page.waitForFunction(() => (window.__NEON__.stats?.frames ?? 99) > 20, null, { timeout: 60000 });
const demoMoved = await N(async () => { const d0 = window.__NEON__.game.distance; await new Promise(r => setTimeout(r, 2000)); return window.__NEON__.game.distance - d0; });
check('title demo runs', demoMoved > 1, `demo moved ${demoMoved.toFixed(1)} m in 2 s (wall clock)`);
await shot('01-title-demo.png');

// ---- start via keyboard (user gesture -> audio init) ----
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
check('Enter starts run', (await state()) === 'playing', await state());
const audio = await N(() => { const a = window.__NEON__.audio; return { ready: a.ready, ctx: a.ctx?.state ?? a.context?.state ?? a._ctx?.state ?? null }; });
check('audio initialised after gesture', !!audio.ready, JSON.stringify(audio));

// helper: clear the track and place one row in front of the player, then run a page-side
// controller that fires `action` when the obstacle reaches triggerZ. Resolves with outcome.
async function obstacleTrial(row, action, triggerZ) {
  return N(async ({ row, action, triggerZ }) => {
    const { game, spawner, bus } = window.__NEON__;
    spawner.reset(); spawner.setEnabled(false);
    let hit = null; const off = bus.on('player:hit', (p) => { hit = p; });
    spawner.spawnRow(-45, row);
    const t0 = performance.now(); let fired = false;
    const keys = { jump: 'ArrowUp', slide: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
    await new Promise((resolve) => {
      const tick = () => {
        const obs = spawner.getObstaclesAhead(20, -60);
        const o = obs[0];
        if (!fired && action && o && o.z > triggerZ) {
          fired = true;
          window.dispatchEvent(new KeyboardEvent('keydown', { key: keys[action], code: keys[action], bubbles: true }));
          window.dispatchEvent(new KeyboardEvent('keyup', { key: keys[action], code: keys[action], bubbles: true }));
        }
        if (hit || (!o && performance.now() - t0 > 500) || performance.now() - t0 > 12000) return resolve();
        requestAnimationFrame(tick);
      };
      tick();
    });
    off();
    return { hit, state: game.state, lane: window.__NEON__.player.lane };
  }, { row, action, triggerZ });
}

async function freshRun() {
  await N(() => { const g = window.__NEON__.game; if (g.state !== 'playing') g.start(); });
  await page.waitForTimeout(300);
  await N(() => { window.__NEON__.game.debug.setTime(0); });
  await N(() => { const p = window.__NEON__.player; while (p.lane > 1) p.moveLeft(); while (p.lane < 1) p.moveRight(); });
  await page.waitForTimeout(300);
}
// wait for N seconds of *simulated* time (headless SwiftShader runs slower than real time)

// Player starts in lane 1 (center).
const trials = [
  { name: 'barrier: running into it kills',      row: [null, 'barrier', null], action: null,    expectHit: true },
  { name: 'barrier: jumping clears it',          row: [null, 'barrier', null], action: 'jump',  trig: -5.5, expectHit: false },
  { name: 'barrier: sliding does NOT clear it',  row: [null, 'barrier', null], action: 'slide', trig: -4,   expectHit: true },
  { name: 'bar: running into it kills',          row: [null, 'bar', null],     action: null,    expectHit: true },
  { name: 'bar: sliding clears it',              row: [null, 'bar', null],     action: 'slide', trig: -6,   expectHit: false },
  { name: 'bar: jumping does NOT clear it',      row: [null, 'bar', null],     action: 'jump',  trig: -5,   expectHit: true },
  { name: 'wall: jumping does NOT clear it',     row: [null, 'wall', null],    action: 'jump',  trig: -5,   expectHit: true },
  { name: 'wall: sliding does NOT clear it',     row: [null, 'wall', null],    action: 'slide', trig: -5,   expectHit: true },
  { name: 'wall: lane change avoids it',         row: [null, 'wall', null],    action: 'left',  trig: -12,  expectHit: false },
];
for (const t of trials) {
  await freshRun();
  // re-center the player
  await N(() => { const p = window.__NEON__.player; while (p.lane > 1) p.moveLeft(); while (p.lane < 1) p.moveRight(); });
  await page.waitForTimeout(250);
  const r = await obstacleTrial(t.row, t.action, t.trig ?? 0);
  check(t.name, !!r.hit === t.expectHit, r.hit ? `hit ${r.hit.type}` : 'no hit');
  if (r.hit) { await page.waitForFunction(() => window.__NEON__.game.state === 'over', null, { timeout: 5000 }).catch(() => {}); }
}

// ---- mid-action screenshots on a natural run ----
await freshRun();
await N(() => { const { spawner } = window.__NEON__; spawner.setEnabled(true); window.__NEON__.game.debug.setInvincible(true); });
await page.waitForFunction(() => window.__NEON__.spawner.getObstaclesAhead(0, -30).length > 0 && window.__NEON__.game.coins > 0, null, { timeout: 60000, polling: 'raf' }).catch(() => {});
await shot('02-gameplay.png');

// jump over a barrier screenshot
await N(() => { const { spawner } = window.__NEON__; spawner.reset(); spawner.setEnabled(false); spawner.spawnRow(-40, ['coin', 'barrier', 'wall']); spawner.spawnRow(-70, ['bar', 'bar', 'bar']); });
await page.waitForFunction(() => { const o = window.__NEON__.spawner.getObstaclesAhead(20, -80)[0]; return o && o.z > -6; }, null, { polling: 'raf', timeout: 10000 });
await page.keyboard.press('ArrowUp');
await page.waitForTimeout(220);
await shot('03-jump-barrier.png');
await page.waitForFunction(() => { const o = window.__NEON__.spawner.getObstaclesAhead(20, -80)[0]; return o && o.type === 'bar' && o.z > -6; }, null, { polling: 'raf', timeout: 10000 });
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(200);
await shot('04-slide-bar.png');
await N(() => window.__NEON__.game.debug.setInvincible(false));

// ---- coins ----
await freshRun();
const coinRes = await N(async () => {
  const { game, spawner, player } = window.__NEON__;
  spawner.reset(); spawner.setEnabled(false);
  const c0 = game.coins; const s0 = game.score;
  for (let i = 0; i < 5; i++) spawner.spawnRow(-20 - i * 2.2, [null, 'coin', null]);
  await new Promise(r => { const t0 = game.time; const f = () => game.time - t0 >= 2.5 ? r() : requestAnimationFrame(f); f(); });
  return { coins: game.coins - c0, lane: player.lane, state: game.state };
});
check('coins collected in lane', coinRes.coins === 5, JSON.stringify(coinRes));

// ---- power-ups (picked up from the track) ----
for (const type of ['magnet', 'shield', 'double']) {
  await freshRun();
  const r = await N(async (type) => {
    const { game, spawner, bus } = window.__NEON__;
    spawner.reset(); spawner.setEnabled(false);
    let started = null; const off = bus.on('powerup:start', p => { started = p; });
    spawner.spawnRow(-25, [null, type, null]);
    await new Promise(r => { const t0 = game.time; const f = () => game.time - t0 >= 2.8 ? r() : requestAnimationFrame(f); f(); });
    off();
    return { started, left: game.powerups[type] };
  }, type);
  check(`power-up ${type} picked up & active`, !!r.started && r.left > 0, JSON.stringify(r));
  if (type === 'magnet') {
    const m = await N(async () => {
      const { game, spawner } = window.__NEON__;
      const c0 = game.coins;
      for (let i = 0; i < 4; i++) spawner.spawnRow(-30 - i * 2.2, ['coin', null, 'coin']);
      await new Promise(r => { const t0 = game.time; const f = () => game.time - t0 >= 3 ? r() : requestAnimationFrame(f); f(); });
      return { coins: game.coins - c0 };
    });
    check('magnet pulls coins from other lanes', m.coins >= 6, JSON.stringify(m));
  }
  if (type === 'shield') {
    await shot('05-shield.png');
    const s = await obstacleTrial([null, 'wall', null], null, 0);
    await page.waitForTimeout(300);
    const after = await N(() => ({ state: window.__NEON__.game.state, shield: window.__NEON__.game.powerups.shield, pshield: window.__NEON__.player.shield }));
    check('shield absorbs a wall hit', s.hit && s.hit.shielded === true && after.state === 'playing' && !after.pshield, JSON.stringify({ hit: s.hit && { type: s.hit.type, shielded: s.hit.shielded }, ...after }));
  }
  if (type === 'double') {
    const d = await N(async () => {
      const g = window.__NEON__.game; await new Promise(r => setTimeout(r, 200));
      return { multiplier: g.multiplier ?? null, hudBadge: !!document.querySelector('#ui')?.textContent.match(/[x×]\s?2/i) };
    });
    check('double score active (multiplier/HUD badge)', d.multiplier === 2 || d.hudBadge, JSON.stringify(d));
    await shot('06-powerup-double.png');
  }
}

// ---- death -> results -> high score -> restart ----
await freshRun();
await N(() => { const { spawner } = window.__NEON__; spawner.reset(); spawner.setEnabled(false); spawner.spawnRow(-30, ['wall', 'wall', 'barrier']); });
await page.waitForFunction(() => window.__NEON__.player.state === 'dead', null, { timeout: 15000, polling: 'raf' }).catch(() => {});
await page.waitForTimeout(150);
await shot('07-crash.png');
await page.waitForFunction(() => window.__NEON__.game.state === 'over', null, { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(700);
check('death leads to results', (await state()) === 'over');
await shot('08-results.png');
const hs = await N(() => ({ stored: localStorage.getItem(window.__NEON__.CONFIG.score.storageKeyHigh), high: window.__NEON__.game.highScore }));
check('high score saved to localStorage', Number(hs.stored) > 0 && Number(hs.stored) === hs.high, JSON.stringify(hs));
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
check('restart from results (Enter)', (await state()) === 'playing', await state());

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__NEON__ && window.__NEON__.game);
await page.waitForTimeout(1500);
const hs2 = await N(() => ({ high: window.__NEON__.game.highScore, text: document.querySelector('#ui')?.innerText || '' }));
check('high score persists across reload', hs2.high === hs.high && hs2.text.includes(String(hs.high)), `high=${hs2.high}`);

// ---- pause ----
await page.keyboard.press('Enter'); await page.waitForTimeout(400);
await page.keyboard.press('p'); await page.waitForTimeout(300);
const d1 = await N(() => window.__NEON__.game.distance); await page.waitForTimeout(500);
const d2 = await N(() => window.__NEON__.game.distance);
check('pause freezes simulation', (await state()) === 'paused' && d1 === d2, `${await state()} ${d1} ${d2}`);
await page.keyboard.press('p'); await page.waitForTimeout(300);
check('resume', (await state()) === 'playing');

// ---- BGM scheduling ----
const bgm = await N(() => { const a = window.__NEON__.audio; return { ctx: (a.ctx || a.context || a._ctx)?.state, time: (a.ctx || a.context || a._ctx)?.currentTime }; });
check('AudioContext running', bgm.ctx === 'running', JSON.stringify(bgm));

// ---- soak: natural spawns, keyboard bot, 45 s of sim time ----
await freshRun();
const soak = await N(async () => {
  const { game, spawner, player, bus } = window.__NEON__;
  spawner.reset(); spawner.setEnabled(true); game.debug.setTime(0);
  const seen = { barrier: 0, bar: 0, wall: 0 }, hits = []; let pu = 0;
  const offs = [bus.on('player:hit', p => hits.push(p.type)), bus.on('powerup:start', () => pu++)];
  const key = (k) => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, bubbles: true })); window.dispatchEvent(new KeyboardEvent('keyup', { key: k, code: k, bubbles: true })); };
  const counted = new WeakSet();
  let acted = -999;
  await new Promise((resolve) => {
    const tick = () => {
      if (game.state !== 'playing' || game.time > 45) return resolve();
      const ahead = spawner.getObstaclesAhead(1, -40);
      for (const o of ahead) seen[o.type] += 0; // (types seen tallied below)
      const row = ahead.filter(o => o.z > -Math.max(9, game.speed * 0.45));
      const mine = row.find(o => o.lane === player.lane);
      if (mine && game.time - acted > 0.12) {
        const blocked = new Set(ahead.filter(o => Math.abs(o.z - mine.z) < 2 && o.type === 'wall').map(o => o.lane));
        if (mine.type === 'wall') { const L = player.lane; const c = [L - 1, L + 1].filter(l => l >= 0 && l <= 2 && !blocked.has(l)); if (c.length) { key(c[0] < L ? 'ArrowLeft' : 'ArrowRight'); acted = game.time; } }
        else if (mine.type === 'barrier' && mine.z > -game.speed * 0.3 && player.state !== 'jump') { key('ArrowUp'); acted = game.time; }
        else if (mine.type === 'bar' && mine.z > -game.speed * 0.25 && player.state !== 'slide') { key('ArrowDown'); acted = game.time; }
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
  offs.forEach(f => f());
  return { simTime: +game.time.toFixed(1), distance: Math.round(game.distance), speed: +game.speed.toFixed(1), coins: game.coins, score: game.score, powerups: pu, hits, state: game.state };
});
console.log('soak:', JSON.stringify(soak));
check('soak run: natural spawns playable for 45 s sim / coins collected', soak.coins > 0 && soak.distance > 500, JSON.stringify(soak));

// ---- mobile viewport + swipe ----
await ctx.close();
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
const mp = await mctx.newPage();
mp.on('console', (m) => { if (m.type() === 'error') errors.push('[mobile] ' + m.text()); });
mp.on('pageerror', (e) => errors.push('[mobile] PAGEERROR ' + e.message));
await mp.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await mp.waitForFunction(() => window.__NEON__ && window.__NEON__.game, null, { timeout: 90000 });
await mp.waitForTimeout(1500);
await mp.screenshot({ path: SHOTS + '09-mobile-title.png' });
await mp.tap('canvas', { position: { x: 195, y: 700 } }).catch(() => {});
await mp.waitForTimeout(400);
if ((await mp.evaluate(() => window.__NEON__.game.state)) !== 'playing') await mp.evaluate(() => window.__NEON__.game.start());
const swipe = await mp.evaluate(async () => {
  const c = document.querySelector('canvas'); const p = window.__NEON__.player; const lane0 = p.lane;
  const fire = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: true }));
  fire('pointerdown', 200, 500); fire('pointermove', 150, 502); fire('pointermove', 100, 503); fire('pointerup', 100, 503);
  await new Promise(r => setTimeout(r, 300));
  return { lane0, lane1: p.lane };
});
check('mobile swipe left changes lane', swipe.lane1 === swipe.lane0 - 1, JSON.stringify(swipe));
await mp.waitForTimeout(1200);
await mp.screenshot({ path: SHOTS + '10-mobile-gameplay.png' });

check('zero console errors', errors.length === 0, errors.slice(0, 8).join(' | '));
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
