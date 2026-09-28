// Real-time smoke test: auto-stepping harness, real key presses + touch on a phone-sized viewport.
import { launch } from '../launch.mjs';
const browser = await launch();
const errors = [];
for (const [name, vp, touch] of [['desktop', { width: 1280, height: 720 }, false], ['mobile', { width: 390, height: 844 }, true]]) {
  const ctx = await browser.newContext({ viewport: vp, hasTouch: touch, isMobile: touch, deviceScaleFactor: touch ? 2 : 1 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || (m.type() === 'warning' && !/ReadPixels/.test(m.text()))) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:8102/dev/player/index.html?speed=30&shield=1');
  await page.waitForFunction(() => window.__P && window.__P.ready);
  await page.waitForTimeout(800);
  if (touch) {
    await page.touchscreen.tap(195, 500);
    const cdp = await ctx.newCDPSession(page);
    for (const [dx, dy] of [[-90, 0], [0, -90]]) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 600, id: 1 }] });
      for (let i = 1; i <= 5; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195 + dx * i / 5, y: 600 + dy * i / 5, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(150);
    }
  } else {
    await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(200); await page.keyboard.press('ArrowUp'); await page.waitForTimeout(250);
  }
  const st = await page.evaluate(() => ({ lane: __P.player.lane, state: __P.player.state, y: __P.player.position.y, t: __P.sim.t, events: __P.log.map((e) => e.name).join(',') }));
  console.log(name, JSON.stringify(st));
  await page.screenshot({ path: `dev/player/shots/live-${name}.png` });
  await ctx.close();
}
console.log('console errors/warnings:', errors.length, errors);
await browser.close();
