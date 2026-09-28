// Screenshot poses from the game camera. Run: node dev/player/shots.mjs  (server on :8102)
import { launch } from '../launch.mjs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const URL = 'http://localhost:8102/dev/player/index.html?manual=1' + (process.argv[2] ? '&' + process.argv[2] : '');

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 2 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto(URL);
await page.waitForFunction(() => window.__P && window.__P.ready);
await page.evaluate(() => { __P.sim.freeze = true; });

async function shot(name, setup) {
  await page.evaluate(setup);
  await page.evaluate(() => __P.snap());
  await page.screenshot({ path: `${here}/shots/${name}.png` });
  if (!name.startsWith('side')) await page.screenshot({ path: `${here}/shots/zoom-${name}.png`, clip: { x: 330, y: 200, width: 300, height: 260 } });
}
const S = 1 / 60;
await shot('run', () => { __P.player.reset(); __P.step(22); });
await shot('run2', () => { __P.step(9); });
await shot('jump', () => { __P.player.reset(); __P.step(10); __P.player.jump(); __P.step(19); });
await shot('jump-rise', () => { __P.player.reset(); __P.step(10); __P.player.jump(); __P.step(6); });
await shot('slide', () => { __P.player.reset(); __P.step(10); __P.player.slide(); __P.step(12); });
await shot('lane', () => { __P.player.reset(); __P.step(10); __P.player.moveRight(); __P.step(4); });
await shot('shield', () => { __P.player.reset(); __P.player.setShield(true); __P.step(40); });
await shot('shield-slide', () => { __P.player.slide(); __P.step(12); });
await shot('death-flash', () => { __P.player.reset(); __P.step(20); __P.player.die('wall'); __P.step(4); });
await shot('death', () => { __P.player.reset(); __P.step(20); __P.player.die('wall'); __P.step(70); });
await shot('death-mid', () => { __P.player.reset(); __P.step(20); __P.player.die('bar'); __P.step(18); });
await shot('death-right', () => { __P.player.reset(); __P.player.moveRight(); __P.step(20); __P.player.die('wall'); __P.step(70); });
await shot('death-trip', () => { __P.player.reset(); __P.step(20); __P.player.die('barrier'); __P.step(70); });
// side view close-up for proportions
await shot('side', () => {
  __P.player.reset(); __P.step(22);
  __P.snap = () => { const c = __P.camera; c.position.set(4, 1.2, 0); c.lookAt(0, 0.9, 0); __P.renderer.render(__P.scene, c); };
});
await shot('side-slide', () => { __P.player.slide(); __P.step(12); });
await shot('side-jump', () => { __P.player.reset(); __P.step(5); __P.player.jump(); __P.step(19); });
await shot('side-death', () => { __P.player.reset(); __P.step(5); __P.player.die('wall'); __P.step(70); });
console.log('errors/warnings:', errors.length, errors.slice(0, 10));
await browser.close();
