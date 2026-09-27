import { launch } from '../launch.mjs';
const b = await launch();
const c = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
const p = await c.newPage();
p.on('console', m => { if (!/GPU stall/.test(m.text())) console.log('console.' + m.type(), m.text()); });
p.on('pageerror', e => console.log('PAGEERROR', e.message));
p.on('requestfailed', r => console.log('REQFAIL', r.url(), r.failure()?.errorText));
const t0 = Date.now();
await p.goto(`http://localhost:${process.argv[2]}/`, { waitUntil: 'domcontentloaded' });
console.log('dcl', Date.now() - t0);
for (let i = 0; i < 20; i++) { await p.waitForTimeout(2000); const r = await p.evaluate(() => ({ neon: !!window.__NEON__, st: window.__NEON__?.game?.state, fr: window.__NEON__?.stats?.frames })); console.log(Date.now() - t0, JSON.stringify(r)); if (r.neon) break; }
await b.close();
