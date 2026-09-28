import { chromium } from 'playwright';
const SP = process.argv[2];
const browser = await chromium.launch({ args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const logs = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(m.text()); });
page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
await page.goto(`http://127.0.0.1:${process.env.PORT || 8765}/index.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.click('#b-snd'); await page.waitForTimeout(800);
const aud = await page.evaluate(() => ({ snd: PU.S.sound }));
for (const k of ['1','2','3','4','5','6','7','x','x','e','e','f','f','y','y','q','r','g','o','l','l','ArrowUp','i','i']) { await page.keyboard.press(k); await page.waitForTimeout(250); }
await page.keyboard.down(' '); await page.waitForTimeout(600); const lift = await page.evaluate(() => ({ k: PU.SIM.k, thr: PU.SIM.throttle })); await page.keyboard.up(' ');
await page.keyboard.press('?'); await page.waitForTimeout(400); await page.screenshot({ path: SP + '/i_help.png' }); await page.keyboard.press('Escape');
await page.keyboard.press('c'); await page.waitForTimeout(3500); await page.screenshot({ path: SP + '/i_cine.png' }); await page.keyboard.press('Escape');
await page.waitForTimeout(1600);
// drag the rpm slider
const box = await page.locator('#rpm').boundingBox();
await page.mouse.move(box.x + box.width * 0.5, box.y + 16); await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.15, box.y + 16, { steps: 5 }); await page.mouse.up();
await page.waitForTimeout(1500);
const dyno = await page.evaluate(() => ({ drive: PU.S.drive, rpmSet: PU.S.rpmSet, rpm: Math.round(PU.SIM.rpm), fuel: Math.round(PU.SIM.fuel), theta: PU.S.theta }));
// hover + click the MGU-K on the canvas
await page.mouse.move(700, 530); await page.waitForTimeout(400);
const hov = await page.evaluate(() => PU.S.hover);
await page.mouse.click(700, 530); await page.waitForTimeout(1800);
const card = await page.evaluate(() => PU.S.card);
await page.keyboard.press('/'); await page.waitForTimeout(500); await page.screenshot({ path: SP + '/i_noui.png' }); await page.keyboard.press('/');
console.log(JSON.stringify({ aud, lift, dyno, hov, card, ctx: await page.evaluate(() => typeof AudioContext) }));
console.log(logs.length ? [...new Set(logs)].join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
