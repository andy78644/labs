// usage: node shot.mjs <out.png> [query] [w] [h] [waitMs] [js-to-eval-after-load] [mobile]
import { chromium } from 'playwright';
const [out, q = '', w = '1440', h = '900', wait = '4000', js = '', mobile = ''] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: +w, height: +h }, deviceScaleFactor: mobile ? 3 : 1, isMobile: !!mobile, hasTouch: !!mobile });
const page = await ctx.newPage();
const logs = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => logs.push(`[pageerror] ${e.message} :: ${(e.stack||'').split('\n').slice(1,3).join(' | ')}`));
await page.goto(`http://127.0.0.1:${process.env.PORT || 8765}/index.html` + (q ? '?' + q : ''), { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
if (js) { await page.evaluate(js); }
await page.waitForTimeout(+wait);
const info = await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'); const d = gl && gl.getExtension('WEBGL_debug_renderer_info'); return { renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a', fps: window.__fps }; });
await page.screenshot({ path: out });
console.log(JSON.stringify(info));
const uniq=[...new Set(logs)]; console.log(uniq.length ? `${logs.length} msgs:\n` + uniq.slice(0,8).join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
