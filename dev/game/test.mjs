// Game & UI slice test: node dev/game/test.mjs  (server on :8104 must be running)
import { launch } from '../launch.mjs';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, 'shots');
mkdirSync(SHOTS, { recursive: true });
const URL = process.env.URL || 'http://localhost:8104/index.html';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPage(browser, viewport, opts = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, ...opts });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); if (m.type() === 'warning' && !m.text().includes('GL Driver')) console.log('  [warn]', m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));
  await page.goto(URL);
  await page.waitForFunction(() => window.__NEON__ && window.__NEON__.stats.frames > 5, null, { timeout: 20000 });
  await page.waitForTimeout(400);
  return { context, page, errors };
}
const state = (page) => page.evaluate(() => window.__NEON__.game.state);
const evalN = (page, fn, arg) => page.evaluate(fn, arg);

const browser = await launch();
try {
  // ======================= desktop =======================
  const { page, errors, context } = await newPage(browser, { width: 1280, height: 720 });
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload();
  await page.waitForFunction(() => window.__NEON__ && window.__NEON__.stats.frames > 5);
  await page.waitForTimeout(1500);

  ok(await state(page) === 'title', 'boots into title state');
  ok(await page.isVisible('[data-screen="title"]'), 'title screen visible');
  const hookKeys = await evalN(page, () => Object.keys(window.__NEON__));
  ok(['game','bus','CONFIG','THREE','world','player','spawner','effects','hud','audio','input'].every((k) => hookKeys.includes(k)), 'test hook exposes contract keys');
  const demo = await evalN(page, () => ({ d: window.__NEON__.game.distance, s: window.__NEON__.game.speed }));
  ok(demo.d > 5 && demo.s === 16, `demo runs at demo speed (distance ${demo.d.toFixed(1)}, speed ${demo.s})`);
  await page.screenshot({ path: join(SHOTS, 'desktop-title.png') });

  // Audio: before gesture no ctx
  ok(await evalN(page, () => !window.__NEON__.audio.ctx), 'no AudioContext before gesture');

  // Record events
  await evalN(page, () => {
    const { bus } = window.__NEON__;
    window.__ev = [];
    for (const name of Object.values(bus.EVENTS)) bus.on(name, (p) => window.__ev.push([name, JSON.parse(JSON.stringify(p ?? {}))]));
  });

  // ---- click PLAY
  await page.click('[data-ui="start"]');
  await page.waitForTimeout(300);
  ok(await state(page) === 'playing', 'PLAY click → playing');
  ok(await page.isVisible('[data-screen="hud"]'), 'HUD visible');
  const au = await evalN(page, () => ({ st: window.__NEON__.audio.ctx?.state, ready: window.__NEON__.audio.ready }));
  ok(au.st === 'running' && au.ready, `AudioContext running after gesture (${au.st})`);
  await evalN(page, () => { const s = window.__NEON__.spawner; s.reset(); s.setEnabled(false); });
  await page.waitForFunction(() => window.__NEON__.game.time > 1.2, null, { timeout: 20000 });
  const notes = await evalN(page, () => window.__NEON__.audio.notesScheduled);
  ok(notes > 10, `BGM scheduled notes (${notes})`);
  ok(await evalN(page, () => document.activeElement === document.body || document.activeElement?.tagName !== 'BUTTON'), 'button not left focused');
  const evs = await evalN(page, () => window.__ev.map((e) => e[0]));
  ok(evs.includes('ui:start') && evs.includes('game:start') && evs.includes('game:state') && evs.includes('speed:changed') && evs.includes('score:changed'), 'start events emitted');

  // Speed curve + score
  const p1 = await evalN(page, () => { const g = window.__NEON__.game; return { t: g.time, s: g.speed, d: g.distance, sc: g.score }; });
  ok(p1.t > 1 && p1.s > 14 && p1.d > 10 && p1.sc > 0, `playing advances (t=${p1.t.toFixed(2)} speed=${p1.s.toFixed(2)} dist=${p1.d.toFixed(1)} score=${p1.sc})`);

  // Keyboard lane input routed to player
  const lane0 = await evalN(page, () => window.__NEON__.player.lane);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(100);
  ok(await evalN(page, () => window.__NEON__.player.lane) === lane0 - 1, 'ArrowLeft moves player lane');
  await page.keyboard.press('ArrowRight');

  // Power-ups
  await evalN(page, () => { const d = window.__NEON__.game.debug; d.grantPowerup('magnet'); d.grantPowerup('shield'); d.grantPowerup('double'); });
  await page.waitForFunction(() => window.__NEON__.game.powerups.magnet < 9.5, null, { timeout: 20000 });
  const pu = await evalN(page, () => ({ ...window.__NEON__.game.powerups, m: window.__NEON__.game.multiplier, sh: window.__NEON__.player.shield }));
  ok(pu.magnet > 8 && pu.magnet < 10 && pu.shield > 13 && pu.double > 8 && pu.m === 2 && pu.sh, `power-up timers tick (${JSON.stringify(pu)})`);
  ok(await page.isVisible('[data-pu="magnet"]') && await page.isVisible('[data-pu="shield"]') && await page.isVisible('.mult'), 'power-up HUD visible');
  await page.screenshot({ path: join(SHOTS, 'desktop-playing-powerups.png') });

  // Score doubling while double active (distance component)
  const snap = () => evalN(page, () => ({ s: window.__NEON__.game._scoreF, c: window.__NEON__.game.coins, d: window.__NEON__.game.distance }));
  const sA = await snap();
  await page.waitForFunction((d) => window.__NEON__.game.distance > d + 8, sA.d, { timeout: 20000 });
  const sB = await snap();
  const ratio = (sB.s - sA.s - (sB.c - sA.c) * 20) / (sB.d - sA.d);
  ok(ratio > 1.8 && ratio < 2.2, `double multiplier applies to distance points (ratio ${ratio.toFixed(2)})`);

  // Coin via hit path (x2 active → 20 points)
  const c0 = await evalN(page, () => ({ c: window.__NEON__.game.coins, s: window.__NEON__.game._scoreF }));
  await evalN(page, () => window.__NEON__.game.debug.injectHit({ kind: 'coin', id: 1, position: { x: 0, y: 1, z: 0 } }));
  const c1 = await evalN(page, () => ({ c: window.__NEON__.game.coins, s: window.__NEON__.game._scoreF }));
  ok(c1.c === c0.c + 1 && c1.s - c0.s > 19.99 && c1.s - c0.s < 20.01, `coin hit → +1 coin, +20 pts under x2 (${(c1.s - c0.s).toFixed(2)})`);

  // Shield absorbs an obstacle hit
  await evalN(page, () => { window.__ev.length = 0; window.__NEON__.game.debug.injectHit({ kind: 'obstacle', type: 'wall', id: 2, position: { x: 0, y: 0, z: 0 } }); });
  const sh = await evalN(page, () => ({ st: window.__NEON__.game.state, shield: window.__NEON__.game.powerups.shield, grace: window.__NEON__.game._grace, dying: window.__NEON__.game._dying, ev: window.__ev.map((e) => e[0] + (e[0] === 'player:hit' ? ':' + e[1].shielded : '') + (e[0] === 'powerup:end' ? ':' + e[1].type : '')) }));
  ok(sh.st === 'playing' && sh.shield === 0 && sh.grace > 0.9 && sh.dying < 0, 'shield absorbed hit, grace started');
  ok(sh.ev.includes('player:hit:true') && sh.ev.includes('shield:break') && sh.ev.includes('powerup:end:shield'), `shield events (${sh.ev.join(',')})`);
  // Grace: another hit immediately is harmless
  await evalN(page, () => window.__NEON__.game.debug.injectHit({ kind: 'obstacle', type: 'bar', id: 3, position: { x: 0, y: 0, z: 0 } }));
  ok(await evalN(page, () => window.__NEON__.game._dying < 0), 'grace period protects');

  // ---- pause / resume (keyboard P, fallback bus)
  await page.keyboard.press('p');
  await page.waitForTimeout(100);
  if (await state(page) !== 'paused') { console.log('  (input.js does not map P yet — using input:pause)'); await evalN(page, () => window.__NEON__.bus.emit('input:pause')); }
  ok(await state(page) === 'paused', 'pause');
  const tP = await evalN(page, () => window.__NEON__.game.time);
  await page.waitForTimeout(400);
  ok(await evalN(page, () => window.__NEON__.game.time) === tP, 'time frozen while paused');
  ok(await page.isVisible('[data-screen="pause"]'), 'pause overlay visible');
  await page.screenshot({ path: join(SHOTS, 'desktop-paused.png') });
  await page.click('[data-ui="resume"]');
  await page.waitForTimeout(200);
  ok(await state(page) === 'playing', 'RESUME button → playing');
  await page.click('[data-ui="pause"]');
  ok(await state(page) === 'paused', 'HUD pause button → paused');
  await evalN(page, () => window.__NEON__.bus.emit('input:pause'));
  ok(await state(page) === 'playing', 'input:pause toggles back');

  // visibilitychange auto-pause
  await evalN(page, () => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  ok(await state(page) === 'paused', 'visibilitychange hidden → paused');
  await evalN(page, () => { delete document.hidden; Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); window.__NEON__.game.setPaused(false); });

  // Mute toggle + persistence
  await page.click('[data-ui="mute"]');
  const mu = await evalN(page, () => ({ m: window.__NEON__.audio.muted, ls: localStorage.getItem(window.__NEON__.CONFIG.score.storageKeyMuted) }));
  ok(mu.m === true && mu.ls === '1', 'mute toggles and persists');
  await page.click('[data-ui="mute"]');

  // speedAt / setTime
  await evalN(page, () => window.__NEON__.game.debug.setTime(80));
  await page.waitForTimeout(100);
  const sp = await evalN(page, () => window.__NEON__.game.speed);
  ok(Math.abs(sp - (14 + 26 * (1 - Math.exp(-80 / 80)))) < 0.2, `setTime(80) → speed ${sp.toFixed(2)}`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS, 'desktop-playing-fast.png') });

  // ---- forced death (grace has expired by now)
  await page.waitForTimeout(300);
  const scoreBefore = await evalN(page, () => window.__NEON__.game.score);
  await evalN(page, () => { window.__ev.length = 0; window.__NEON__.game.debug.injectHit({ kind: 'obstacle', type: 'barrier', id: 4, position: { x: 0, y: 0, z: 0 } }); });
  ok(await evalN(page, () => window.__NEON__.player.state === 'dead' && window.__NEON__.game._dying > 0), 'fatal hit → player dead, death sequence');
  const tDeath = await evalN(page, () => window.__NEON__.stats.steps);
  await page.waitForFunction((t0) => window.__NEON__.stats.steps > t0 + 30, tDeath, { timeout: 20000 });
  ok(await state(page) === 'playing', 'still in death sequence after 0.5 s sim');
  await page.waitForFunction(() => window.__NEON__.game.state === 'over', null, { timeout: 20000 });
  const stepsDeath = (await evalN(page, () => window.__NEON__.stats.steps)) - tDeath;
  ok(stepsDeath >= 60 && stepsDeath < 90, `gameOver after ~1.1 s of sim steps (${stepsDeath})`);
  const over = await evalN(page, () => window.__ev.filter((e) => e[0] === 'game:over').map((e) => e[1])[0]);
  ok(over && over.isNewHigh === true && over.score >= scoreBefore && over.highScore === over.score, `game:over payload ${JSON.stringify(over)}`);
  ok(await evalN(page, () => +localStorage.getItem(window.__NEON__.CONFIG.score.storageKeyHigh)) === over.score, 'high score saved');
  ok(await page.isVisible('[data-f="record"]'), 'NEW RECORD shown');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, 'desktop-results.png') });

  // restart via Enter
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  ok(await state(page) === 'playing', 'Enter on results → new run');
  ok(await evalN(page, () => window.__NEON__.game.score < 20 && window.__NEON__.game.coins === 0 && window.__NEON__.player.state !== 'dead'), 'run reset');
  await evalN(page, () => { const s = window.__NEON__.spawner; s.reset(); s.setEnabled(false); });

  // second death, lower score → not a record, then RUN AGAIN button
  await evalN(page, () => window.__NEON__.game.debug.injectHit({ kind: 'obstacle', type: 'wall', id: 5, position: { x: 0, y: 0, z: 0 } }));
  await page.waitForFunction(() => window.__NEON__.game.state === 'over', null, { timeout: 20000 });
  ok(await state(page) === 'over', 'second game over');
  ok(!(await page.isVisible('[data-f="record"]')), 'no NEW RECORD for lower score');
  await page.click('[data-ui="restart"]');
  ok(await state(page) === 'playing', 'RUN AGAIN button → playing');
  await evalN(page, () => window.__NEON__.game.debug.injectHit({ kind: 'obstacle', type: 'wall', id: 6, position: { x: 0, y: 0, z: 0 } }));
  await page.waitForFunction(() => window.__NEON__.game.state === 'over' && window.__NEON__.game._stateTime > 0.5, null, { timeout: 20000 });
  await page.click('.screen-over [data-ui="home"]');
  ok(await state(page) === 'title', 'MENU → title');

  // Reload: high score persisted, shows on title
  const hs = over.score;
  await page.reload();
  await page.waitForFunction(() => window.__NEON__ && window.__NEON__.stats.frames > 5);
  await page.waitForTimeout(1500);
  const hs2 = await evalN(page, () => window.__NEON__.game.highScore);
  ok(hs2 === hs, `high score persisted across reload (${hs2})`);
  ok((await page.textContent('[data-f="titleBest"]')).replace(/,/g, '') === String(hs), 'title shows best');
  await page.screenshot({ path: join(SHOTS, 'desktop-title-best.png') });

  // Enter on title starts (keyboard path) and invincible debug
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  ok(await state(page) === 'playing', 'Enter on title → playing');
  await evalN(page, () => { window.__NEON__.game.debug.setInvincible(true); window.__NEON__.game.debug.injectHit({ kind: 'obstacle', type: 'wall', id: 7, position: { x: 0, y: 0, z: 0 } }); });
  ok(await evalN(page, () => window.__NEON__.game._dying < 0), 'setInvincible ignores obstacle hits');

  // Tap on canvas (outside buttons) on title emits confirm via input.js (if implemented)
  console.log(`  steps=${await evalN(page, () => window.__NEON__.stats.steps)}  frames=${await evalN(page, () => window.__NEON__.stats.frames)}`);
  ok(errors.length === 0, `desktop console errors: ${errors.length}`);
  errors.forEach((e) => console.log('   ERR', e.slice(0, 300)));
  await context.close();

  // ======================= mobile =======================
  const m = await newPage(browser, { width: 390, height: 844 }, { hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
  await m.page.waitForTimeout(1500);
  await m.page.screenshot({ path: join(SHOTS, 'mobile-title.png') });
  await m.page.tap('[data-ui="start"]');
  await m.page.waitForTimeout(300);
  ok(await state(m.page) === 'playing', 'mobile tap PLAY → playing');
  await evalN(m.page, () => window.__NEON__.game.debug.setInvincible(true));
  ok(await evalN(m.page, () => window.__NEON__.renderer.getPixelRatio()) <= 1.5, 'mobile pixel ratio capped at 1.5');
  await evalN(m.page, () => { const d = window.__NEON__.game.debug; d.grantPowerup('shield'); d.grantPowerup('double'); });
  await m.page.waitForTimeout(1500);
  await m.page.screenshot({ path: join(SHOTS, 'mobile-playing.png') });
  await m.page.tap('[data-ui="pause"]');
  await m.page.waitForTimeout(300);
  await m.page.screenshot({ path: join(SHOTS, 'mobile-paused.png') });
  await m.page.tap('[data-ui="resume"]');
  await evalN(m.page, () => { const g = window.__NEON__.game; g._grace = 0; g.powerups.shield = 0; g.debug.setInvincible(false); g.debug.injectHit({ kind: 'obstacle', type: 'wall', id: 9, position: { x: 0, y: 0, z: 0 } }); });
  await m.page.waitForFunction(() => window.__NEON__.game.state === 'over' && window.__NEON__.game._stateTime > 0.6, null, { timeout: 20000 });
  ok(await state(m.page) === 'over', 'mobile game over');
  await m.page.screenshot({ path: join(SHOTS, 'mobile-results.png') });
  ok(m.errors.length === 0, `mobile console errors: ${m.errors.length}`);
  m.errors.forEach((e) => console.log('   ERR', e.slice(0, 300)));
  await m.context.close();
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
