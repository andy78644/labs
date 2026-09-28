// Headless test for the World slice. Usage: node dev/world/test.mjs  (server on :8101)
import { launch } from '../launch.mjs';
const BASE = process.env.BASE || 'http://localhost:8101/dev/world/index.html';
const OUT = new URL('./shots/', import.meta.url).pathname;
const tag = process.argv[2] || 'run';

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [], logs = [];
page.on('console', (m) => { logs.push(`[${m.type()}] ${m.text()}`); if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(BASE + '?auto=0', { waitUntil: 'load' });
await page.waitForFunction(() => window.__W?.ready, null, { timeout: 30000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}${tag}-a.png` });

// scroll: 0.5 s of sim at speed 16 → scenery moves 8 m
await page.evaluate(() => __W.step(30, 16));
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}${tag}-b.png` });

// numeric checks: chunk displacement == speed*dt*n, marker stays aligned with grid lines
const res = await page.evaluate(() => {
  const { world, marker, step, resetMarker, CONFIG } = __W;
  world.reset(); resetMarker();
  const L = CONFIG.world.chunkLength, N = CONFIG.world.chunkCount;
  const z0 = world.chunks.map((c) => c.position.z);
  const s = 23.7, n = 1000;
  const cell = L / Math.round(L / 4);
  let maxMis = 0;
  for (let i = 0; i < n; i++) {
    step(1, s);
    // marker offset from the nearest grid line of chunk0 (grid lines at chunk.z - k*cell)
    const d = ((world.chunks[0].position.z - marker.position.z) % cell + cell) % cell;
    maxMis = Math.max(maxMis, Math.min(d, cell - d));
  }
  const expected = s * CONFIG.sim.step * n;
  const errs = world.chunks.map((c, i) => {
    const moved = c.position.z - z0[i];
    const wraps = Math.round((expected - moved) / (L * N));
    return Math.abs(moved + wraps * L * N - expected);
  });
  // coverage: sorted chunks must be contiguous
  const zs = world.chunks.map((c) => c.position.z).sort((a, b) => b - a);
  let gaps = 0; for (let i = 1; i < zs.length; i++) gaps = Math.max(gaps, Math.abs(zs[i - 1] - zs[i] - L));
  return { maxChunkErr: Math.max(...errs), markerMisalign: maxMis, contiguityErr: gaps, nearest: zs[0], farthest: zs.at(-1) - L,
    calls: __W.renderer.info.render.calls, tris: __W.renderer.info.render.triangles };
});
console.log('checks', JSON.stringify(res));

// resize
await page.setViewportSize({ width: 600, height: 900 });
await page.waitForTimeout(500);
const rs = await page.evaluate(() => ({ canvas: [__W.renderer.domElement.width, __W.renderer.domElement.height],
  rt: [__W.world.composer.renderTarget1.width, __W.world.composer.renderTarget1.height],
  bloom: [__W.world.bloom.renderTargetBright.width, __W.world.bloom.renderTargetBright.height] }));
console.log('resize', JSON.stringify(rs));
await page.screenshot({ path: `${OUT}${tag}-portrait.png` });
await page.setViewportSize({ width: 1280, height: 720 });
await page.waitForTimeout(300);

// fps estimate with auto loop at high speed
await page.goto(BASE + '?speed=40', { waitUntil: 'load' });
await page.waitForFunction(() => window.__W?.ready);
await page.waitForTimeout(2500);
console.log('fps(swiftshader)', await page.evaluate(() => __W.getFps().toFixed(1)));
await page.screenshot({ path: `${OUT}${tag}-fast.png` });

// dispose
const disp = await page.evaluate(() => { __W.world.dispose(); return __W.scene.children.length; });
console.log('after dispose scene children', disp);

console.log('console errors:', errors.length, errors.slice(0, 10));
console.log('warnings:', logs.filter((l) => l.startsWith('[warning]')).slice(0, 10));
await browser.close();
