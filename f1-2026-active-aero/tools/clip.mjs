// usage: node clip.mjs <out.png> [query] [x y w h] [scale]  — zoomed crop for close inspection
import { chromium } from 'playwright';
const [out, q = '', x = '300', y = '150', w = '700', h = '500', sc = '2'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: +sc })).newPage();
const logs = []; page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(m.text()); }); page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
await page.goto(`http://127.0.0.1:${process.env.PORT || 8765}/index.html` + (q ? '?' + q : ''), { waitUntil: 'networkidle' });
await page.waitForTimeout(5000);
await page.screenshot({ path: out, clip: { x: +x, y: +y, width: +w, height: +h } });
console.log(logs.length ? [...new Set(logs)].join('\n') : 'NO CONSOLE ERRORS'); await browser.close();
