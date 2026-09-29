// usage: PORT=8791 node interact.mjs <screenshot-dir>
// Presses every shortcut with Playwright's real keyboard, drags both sliders, clicks a part,
// runs an Overtake in Chase, and reports state + console errors.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const SP = process.argv[2];
if (!SP) { console.error('pass a screenshot directory'); process.exit(1); }
mkdirSync(SP, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const logs = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(m.text()); });
page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
await page.goto(`http://127.0.0.1:${process.env.PORT || 8765}/index.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const st = () => page.evaluate(() => ({ aero: AA.S.aero, era: AA.S.era, scene: AA.S.scene, flow: AA.S.flow, xray: AA.S.xray, expl: AA.S.expl, card: AA.S.card, lang: AA.S.lang, ovt: AA.S.overtake, chasing: AA.S.chasing, aeroT: +AA.S.aeroT.toFixed(2) }));
const out = {};
await page.click('#b-snd'); await page.waitForTimeout(500);
out.sound = await page.evaluate(() => AA.S.sound);
for (const k of ['s']) { await page.keyboard.press(k); } await page.waitForTimeout(700); out.afterS = await st();
await page.keyboard.press('c'); await page.waitForTimeout(700); out.afterC = await st();
await page.keyboard.press('a'); await page.keyboard.press('y'); await page.waitForTimeout(400); out.afterY = await st();
await page.keyboard.press('g'); await page.waitForTimeout(300); out.afterG = await st();
await page.keyboard.press('y');
for (const k of ['1', '2', '3', '4', '5', '6', '7', 'x', 'x', 'e', 'e', 'f', 'f', 't', 'ArrowUp', 'ArrowDown', 'l', 'i', 'i']) { await page.keyboard.press(k); await page.waitForTimeout(220); }
out.afterKeys = await st();
await page.keyboard.press('?'); await page.waitForTimeout(400); await page.screenshot({ path: SP + '/i_help.png' }); await page.keyboard.press('Escape');
await page.keyboard.press('v'); await page.waitForTimeout(3000); await page.screenshot({ path: SP + '/i_cine.png' }); await page.keyboard.press('Escape');
await page.waitForTimeout(800);
// tunnel speed slider drag
await page.keyboard.press('t'); await page.waitForTimeout(400);
const box = await page.locator('#spd').boundingBox();
await page.mouse.move(box.x + box.width * 0.5, box.y + 16); await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.1, box.y + 16, { steps: 5 }); await page.mouse.up();
out.vSet = await page.evaluate(() => AA.S.vSet);
// click the rear flaps from a known camera → should open lesson 3
await page.keyboard.press('Escape'); await page.waitForTimeout(1800);
const p = await page.evaluate(() => { const v = AA.CAR.parts.rflaps.g.children[0].children[0].getWorldPosition(new AA.camera.position.constructor()); v.project(AA.camera); return { x: (v.x * .5 + .5) * innerWidth, y: (-v.y * .5 + .5) * innerHeight }; });
await page.mouse.move(p.x, p.y); await page.waitForTimeout(300); out.hover = await page.evaluate(() => AA.S.hover);
await page.mouse.click(p.x, p.y); await page.waitForTimeout(600); out.clickCard = await page.evaluate(() => AA.S.card);
// chase + overtake
await page.keyboard.press('Escape'); await page.keyboard.press('k'); await page.waitForTimeout(1500);
const gb = await page.locator('#gap').boundingBox();
await page.mouse.click(gb.x + gb.width * 0.3, gb.y + 16); out.gap = await page.evaluate(() => AA.S.gap);
await page.keyboard.press('o'); await page.waitForTimeout(2500);
out.chase = await page.evaluate(() => ({ passing: AA.CH.passing, gap: +AA.CH.gap.toFixed(1), lane: +AA.CH.lane.toFixed(2), ovt: AA.S.overtake }));
await page.screenshot({ path: SP + '/i_overtake.png' });
await page.keyboard.press('/'); await page.waitForTimeout(500); await page.screenshot({ path: SP + '/i_noui.png' }); await page.keyboard.press('/');
console.log(JSON.stringify(out, null, 1));
console.log(logs.length ? [...new Set(logs)].join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
