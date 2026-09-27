// Quick screenshot: node dev/world/shot.mjs <name> <query> [w] [h] [steps]
import { launch } from '../launch.mjs';
const [name, query = '', w = 1280, h = 720, steps = 0] = process.argv.slice(2);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: +(process.env.DPR || 1) });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:8101/dev/world/index.html?auto=0&${query}`);
await page.waitForFunction(() => window.__W?.ready, null, { timeout: 30000 });
if (+steps) await page.evaluate((n) => __W.step(n), +steps);
await page.waitForTimeout(700);
await page.screenshot({ path: new URL(`./shots/${name}.png`, import.meta.url).pathname });
console.log(name, 'errors', errors.length, errors);
await browser.close();
