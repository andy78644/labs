// Functional tests for Player + Input. Run: node dev/player/test.mjs  (server on :8102)
import { launch } from '../launch.mjs';

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 900, height: 600 }, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  if (m.type() === 'warning' && !/GPU stall due to ReadPixels/.test(m.text())) errors.push('warn: ' + m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto('http://localhost:8102/dev/player/index.html?manual=1');
await page.waitForFunction(() => window.__P && window.__P.ready);
await page.evaluate(() => { __P.sim.freeze = true; }); // keep rendering out of the way

let pass = 0, fail = 0;
function check(name, cond, info = '') {
  if (cond) { pass++; console.log('  ok  ', name, info); } else { fail++; console.log('  FAIL', name, info); }
}
const E = (fn) => page.evaluate(fn);
const reset = () => E(() => { __P.player.reset(); __P.log.length = 0; __P.sim.t = 0; __P.sim.maxY = 0; __P.input.setEnabled(true); document.activeElement?.blur?.(); });
const log = () => E(() => __P.log.slice());
const names = (l) => l.map((e) => e.name);
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------- keyboard + lanes
console.log('lanes');
await reset();
await page.keyboard.press('ArrowRight');
let r = await E(() => { const p = __P.player; const x0 = p.position.x; __P.step(3); const xm = p.position.x; __P.step(20); return { lane: p.lane, x0, xm, x: p.position.x }; });
check('ArrowRight → lane 2', r.lane === 2, JSON.stringify(r));
check('lane tween in progress after 3 steps', r.xm > 0 && r.xm < 2.4, `x=${r.xm.toFixed(3)}`);
check('reaches exact lane x 2.4', r.x === 2.4, `x=${r.x}`);
let l = await log();
check('player:lane payload {lane:2, from:1}', l.some((e) => e.name === 'player:lane' && e.lane === 2 && e.from === 1), JSON.stringify(l.filter((e) => e.name === 'player:lane')));
check('input:right emitted once', names(l).filter((n) => n === 'input:right').length === 1);
await page.keyboard.press('ArrowRight');
r = await E(() => __P.player.lane);
check('cannot go past lane 2', r === 2);
await E(() => { __P.log.length = 0; });
await page.keyboard.press('a'); await page.keyboard.press('KeyA');
r = await E(() => { __P.step(30); return { lane: __P.player.lane, x: __P.player.position.x }; });
check('A,A → lane 0 at x −2.4', r.lane === 0 && r.x === -2.4, JSON.stringify(r));
l = await log();
check('lane events 2→1, 1→0', JSON.stringify(l.filter((e) => e.name === 'player:lane').map((e) => [e.from, e.lane])) === '[[2,1],[1,0]]');
await page.keyboard.press('d');
r = await E(() => { __P.step(4); const mid = __P.player.position.x; __P.player.moveRight(); __P.step(30); return { mid, lane: __P.player.lane, x: __P.player.position.x }; });
check('D then mid-tween moveRight → lane 2 exactly', r.lane === 2 && r.x === 2.4, JSON.stringify(r));
// lane change time
r = await E(() => { __P.player.reset(); __P.player.moveLeft(); let n = 0; while (__P.player.position.x !== -2.4 && n < 100) { __P.step(1); n++; } return n / 60; });
check('adjacent lane change time ≈ laneChangeTime (0.13 s)', near(r, 0.13, 1 / 60 + 1e-9), `${r.toFixed(4)} s`);

// ---------------------------------------------------------------- jump
console.log('jump');
await reset();
await page.keyboard.press('ArrowUp');
r = await E(() => {
  const p = __P.player; const st = p.state; const air0 = p.airborne; let n = 0, maxY = 0, landN = -1;
  while (n < 120) { __P.step(1); n++; if (p.position.y > maxY) maxY = p.position.y; if (p.state !== 'jump') { landN = n; break; } }
  return { st, air0, maxY, airtime: landN / 60, after: p.state, y: p.position.y };
});
check('ArrowUp starts jump & airborne', r.st === 'jump' && r.air0 === true);
check('apex ≈ jumpHeight 2.0', near(r.maxY, 2.0, 0.01), `apex=${r.maxY.toFixed(4)}`);
check('airtime ≈ jumpDuration 0.65', near(r.airtime, 0.65, 1 / 60 + 1e-9), `airtime=${r.airtime.toFixed(4)}`);
check('lands on y=0 back to run', r.after === 'run' && r.y === 0);
l = await log();
const land = l.find((e) => e.name === 'player:land');
check('player:jump + player:land{position} emitted', names(l).includes('player:jump') && land && land.position && land.position.y === 0, JSON.stringify(land));
r = await E(() => { __P.player.jump(); __P.step(5); return __P.player.jump(); });
check('no double jump', r === false);
r = await E(() => { __P.step(60); const b = __P.player.getBounds(); return [b.min.toArray(), b.max.toArray()]; });
check('run hitbox: x/z ±(0.35−0.1), y 0..1.7', [...r[0], ...r[1]].every((v, i) => near(v, [-0.25, 0, -0.25, 0.25, 1.7, 0.25][i], 1e-12)), JSON.stringify(r));
// W and Space
await reset();
await page.keyboard.press('w');
r = await E(() => __P.player.state); check('W jumps', r === 'jump');
await reset();
await page.keyboard.press('Space');
l = await log();
check('Space emits input:jump AND input:confirm', names(l).includes('input:jump') && names(l).includes('input:confirm'), names(l).join(','));
// jump bounds mid-air
r = await E(() => { __P.step(10); const b = __P.player.getBounds(); return { h: b.max.y - b.min.y, y: b.min.y, py: __P.player.position.y }; });
check('airborne hitbox feet = position.y, height 1.7', near(r.h, 1.7, 1e-9) && r.y === r.py, JSON.stringify(r));

// ---------------------------------------------------------------- slide
console.log('slide');
await reset();
await page.keyboard.press('ArrowDown');
r = await E(() => {
  const p = __P.player; const b = p.getBounds(new __P.THREE.Box3()); const st = p.state; let n = 0;
  while (p.state === 'slide' && n < 200) { __P.step(1); n++; }
  const b2 = p.getBounds();
  return { st, h: b.max.y - b.min.y, dur: n / 60, after: p.state, h2: b2.max.y - b2.min.y };
});
check('ArrowDown → slide, hitbox height 0.7', r.st === 'slide' && near(r.h, 0.7, 1e-9), JSON.stringify(r));
check('slide lasts slideDuration 0.75', near(r.dur, 0.75, 1 / 60 + 1e-9), `${r.dur.toFixed(4)} s`);
check('back to run, height 1.7', r.after === 'run' && near(r.h2, 1.7, 1e-9));
l = await log();
check('player:slide emitted', names(l).filter((n) => n === 'player:slide').length === 1);
// S key, restart timer, jump cancels slide
await reset();
await page.keyboard.press('s');
r = await E(() => { const p = __P.player; __P.step(30); p.slide(); let n = 0; while (p.state === 'slide' && n < 200) { __P.step(1); n++; } return { total: (30 + n) / 60 }; });
check('S slides; re-slide restarts timer (total ≈ 0.5+0.75)', near(r.total, 1.25, 1 / 60 + 1e-9), JSON.stringify(r));
r = await E(() => { const p = __P.player; p.slide(); __P.step(10); const ok = p.jump(); return { ok, st: p.state, h: p.getBounds().max.y - p.getBounds().min.y }; });
check('jump during slide cancels slide', r.ok && r.st === 'jump' && near(r.h, 1.7, 1e-9), JSON.stringify(r));

// ---------------------------------------------------------------- fast-fall
console.log('fast-fall');
await reset();
r = await E(() => {
  const p = __P.player; p.jump(); __P.step(15); const y0 = p.position.y;
  const ok = p.slide(); __P.step(1); const y1 = p.position.y; const st1 = p.state;
  let n = 1; while (p.state === 'jump' && n < 100) { __P.step(1); n++; }
  const landSt = p.state, h = p.getBounds().max.y - p.getBounds().min.y;
  return { ok, y0, y1, dy: (y0 - y1) * 60, st1, fallTime: n / 60, landSt, h };
});
check('slide mid-air returns true, still airborne', r.ok && r.st1 === 'jump', JSON.stringify(r));
check('descends at fastFallSpeed 18 m/s', near(r.dy, 18, 1e-6), `dy/dt=${r.dy.toFixed(3)}`);
check('fast-fall lands quickly then slides (h=0.7)', r.fallTime <= r.y0 / 18 + 2 / 60 && r.landSt === 'slide' && near(r.h, 0.7, 1e-9), JSON.stringify(r));
l = await log();
check('fast-fall: jump, slide, land events (slide once)', names(l).join(',') === 'player:jump,player:slide,player:land', names(l).join(','));
// keyboard version: jump then ArrowDown mid-air
await reset();
await page.keyboard.press('ArrowUp');
await E(() => __P.step(12));
await page.keyboard.press('ArrowDown');
r = await E(() => { const p = __P.player; let n = 0; while (p.state === 'jump' && n < 100) { __P.step(1); n++; } return { n, st: p.state }; });
check('keyboard fast-fall → slide on landing', r.st === 'slide' && r.n < 10, JSON.stringify(r));

// ---------------------------------------------------------------- auto-repeat, other keys, preventDefault
console.log('keys');
await reset();
await page.keyboard.down('ArrowLeft'); await page.keyboard.down('ArrowLeft'); await page.keyboard.down('ArrowLeft');
await page.keyboard.up('ArrowLeft');
l = await log();
check('auto-repeat ignored (1 input:left for 3 keydowns)', names(l).filter((n) => n === 'input:left').length === 1, names(l).join(','));
await reset();
for (const k of ['Enter', 'p', 'Escape', 'm']) await page.keyboard.press(k);
l = await log();
check('Enter→confirm, P/Esc→pause, M→mute', names(l).join(',') === 'input:confirm,input:pause,input:pause,input:mute', names(l).join(','));
r = await E(() => {
  const res = {};
  const probe = (e) => { res[e.code] = e.defaultPrevented; };
  window.addEventListener('keydown', probe);
  for (const code of ['ArrowUp', 'ArrowDown', 'Space', 'KeyM']) {
    const key = code === 'Space' ? ' ' : code === 'KeyM' ? 'm' : code;
    window.dispatchEvent(new KeyboardEvent('keydown', { code, key, cancelable: true, bubbles: true }));
  }
  window.removeEventListener('keydown', probe);
  return res;
});
check('preventDefault on arrows/space only', r.ArrowUp && r.ArrowDown && r.Space && !r.KeyM, JSON.stringify(r));
// focused button: Space/Enter ignored (native click), arrows still work
await reset();
r = await E(() => { const b = document.createElement('button'); b.id = 'tb'; b.textContent = 'x'; document.body.appendChild(b); b.focus(); return document.activeElement.id; });
await page.keyboard.press('Space'); await page.keyboard.press('Enter'); await page.keyboard.press('ArrowRight');
l = await log();
check('focused <button>: Space/Enter ignored, arrows work', names(l).filter((n) => n.startsWith('input:')).join(',') === 'input:right', names(l).join(','));
await E(() => { document.getElementById('tb').remove(); });
// text input: all ignored
await reset();
await E(() => { const i = document.createElement('input'); i.id = 'ti'; document.body.appendChild(i); i.focus(); });
await page.keyboard.press('ArrowLeft'); await page.keyboard.press('a');
l = await log();
check('focused <input>: keys ignored', names(l).length === 0, names(l).join(','));
await E(() => { document.getElementById('ti').remove(); });
// setEnabled(false)
await reset();
await E(() => __P.input.setEnabled(false));
await page.keyboard.press('ArrowLeft');
await page.mouse.move(450, 300); await page.mouse.down(); await page.mouse.move(380, 300, { steps: 5 }); await page.mouse.up();
l = await log();
check('setEnabled(false): no events', l.length === 0, names(l).join(','));

// ---------------------------------------------------------------- gestures
console.log('gestures');
async function mouseSwipe(dx, dy) {
  await page.mouse.move(450, 300); await page.mouse.down();
  await page.mouse.move(450 + dx, 300 + dy, { steps: 8 }); await page.mouse.up();
}
await reset();
await mouseSwipe(-80, 0); await mouseSwipe(80, 0); await mouseSwipe(0, -80); await mouseSwipe(0, 80);
l = await log();
check('mouse drags: left,right,jump,slide (once each)', names(l).filter((n) => n.startsWith('input:')).join(',') === 'input:left,input:right,input:jump,input:slide', names(l).join(','));
await reset();
await mouseSwipe(-20, 5);
l = await log();
check('short drag (20px < 30) → no swipe, no tap', l.length === 0, names(l).join(','));
await reset();
await page.mouse.click(450, 300);
l = await log();
check('click → input:confirm', names(l).join(',') === 'input:confirm', names(l).join(','));
// real touch via CDP
const cdp = await ctx.newCDPSession(page);
async function touchSwipe(dx, dy, steps = 6, dtMs = 16) {
  const x0 = 450, y0 = 300;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, id: 1 }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (dx * i) / steps, y: y0 + (dy * i) / steps, id: 1 }] });
    if (dtMs) await new Promise((res) => setTimeout(res, dtMs));
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
await reset();
await touchSwipe(-120, 10); await touchSwipe(120, -10); await touchSwipe(5, -100); await touchSwipe(-5, 100);
l = await log();
check('touch swipes: left,right,jump,slide', names(l).filter((n) => n.startsWith('input:')).join(',') === 'input:left,input:right,input:jump,input:slide', names(l).join(','));
r = await E(() => { __P.step(40); return __P.player.lane; });
check('swipes drove player (lane back to 1)', r === 1);
// fires on move (before touchEnd), once per touch
await reset();
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 450, y: 300, id: 1 }] });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 400, y: 300, id: 1 }] });
const beforeEnd = names(await log());
await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 300, y: 300, id: 1 }] });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y: 300, id: 1 }] });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
l = await log();
check('swipe fires on move before release', beforeEnd.includes('input:left'), beforeEnd.join(','));
check('long swipe fires once per touch', names(l).filter((n) => n === 'input:left').length === 1, names(l).join(','));
await reset();
await page.touchscreen.tap(450, 300);
l = await log();
check('touch tap → input:confirm (once)', names(l).filter((n) => n === 'input:confirm').length === 1 && names(l).filter((n) => n.startsWith('input:')).length === 1, names(l).join(','));
r = await E(() => getComputedStyle(document.getElementById('game')).touchAction);
check('canvas touch-action none', r === 'none', r);

// ---------------------------------------------------------------- death & shield
console.log('death / shield');
await reset();
r = await E(() => { const p = __P.player; p.jump(); __P.step(10); p.die('wall'); __P.log.length = 0; return p.state; });
await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowDown');
await touchSwipe(100, 0);
r = await E(() => {
  const p = __P.player; const res = { l: p.moveLeft(), r: p.moveRight(), j: p.jump(), s: p.slide(), lane: p.lane, x: p.position.x };
  __P.step(90); res.y = p.position.y; res.state = p.state; res.airborne = p.airborne;
  res.playerEvents = __P.log.filter((e) => e.name.startsWith('player:')).map((e) => e.name); return res;
});
check('dead: actions return false, lane/x unchanged', !r.l && !r.r && !r.j && !r.s && r.lane === 1 && r.x === 0, JSON.stringify(r));
check('dead mid-air falls to ground, stays dead', r.y === 0 && r.state === 'dead' && !r.airborne, JSON.stringify(r));
check('dead: no player:* events from input', r.playerEvents.length === 0, r.playerEvents.join(','));
r = await E(() => { const p = __P.player; p.reset(); __P.step(5); return { st: p.state, lane: p.lane, x: p.position.x, y: p.position.y, ok: p.moveLeft() }; });
check('reset() revives: run, lane 1, input works', r.st === 'run' && r.x === 0 && r.y === 0 && r.ok, JSON.stringify(r));
r = await E(() => {
  const p = __P.player; const g = p._shieldG; p.setShield(true); __P.step(30); const on = { vis: g.visible, sc: g.scale.x, shield: p.shield };
  p.setShield(false); __P.step(2); const breaking = g.visible; __P.step(30); return { on, breaking, off: g.visible, shield: p.shield };
});
check('setShield(true) shows bubble, false pops then hides', r.on.vis && r.on.sc > 0.9 && r.on.shield && r.breaking && !r.off && !r.shield, JSON.stringify(r));

// ---------------------------------------------------------------- allocation sanity: run many updates, check heap growth
r = await E(() => {
  const p = __P.player; p.reset(); p.setShield(true);
  for (let i = 0; i < 600; i++) { __P.step(1); if (i % 40 === 0) p.jump(); if (i % 55 === 0) p.slide(); if (i % 70 === 0) (i % 140 ? p.moveLeft() : p.moveRight()); p.getBounds(); }
  const m0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
  const t0 = performance.now();
  for (let i = 0; i < 6000; i++) { p.update(1 / 60, 30); p.getBounds(); }
  const t1 = performance.now();
  const m1 = performance.memory ? performance.memory.usedJSHeapSize : 0;
  return { perUpdateUs: ((t1 - t0) / 6000) * 1000, heapDeltaKB: (m1 - m0) / 1024 };
});
check('update() cheap', r.perUpdateUs < 200, JSON.stringify(r));

console.log(`\n${pass} passed, ${fail} failed; console errors/warnings: ${errors.length}`);
if (errors.length) console.log(errors);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
