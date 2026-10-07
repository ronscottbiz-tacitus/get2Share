import { chromium } from 'playwright';
const S = process.cwd(); // run from the repo root
const F = (pkg, file) => `http://localhost:5199/@fs${S}/node_modules/@fontsource-variable/${pkg}/files/${file}`;
const fontCss = `
@font-face{font-family:'Archivo';font-style:normal;font-weight:100 900;font-stretch:62.5% 125%;src:url(${F('archivo','archivo-latin-standard-normal.woff2')}) format('woff2');}
@font-face{font-family:'Plus Jakarta Sans';font-style:normal;font-weight:200 800;src:url(${F('plus-jakarta-sans','plus-jakarta-sans-latin-wght-normal.woff2')}) format('woff2');}
@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:100 800;src:url(${F('jetbrains-mono','jetbrains-mono-latin-wght-normal.woff2')}) format('woff2');}`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
async function open(path, ls, w = 390, h = 844) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, permissions: ['camera'] });
  const page = await ctx.newPage();
  const errs = [], logs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => logs.push(m.text()));
  await page.route('**/fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: fontCss }));
  await page.addInitScript((ls) => { for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, typeof v === 'function' ? v() : v); }, ls);
  await page.goto('http://localhost:5199' + path);
  await page.waitForTimeout(1500);
  return { ctx, page, errs, logs };
}
const at = (ms) => String(Date.now() + ms);
// 1. Guest gets the prompt, joins, fires
{ const { ctx, page, errs, logs } = await open('/e/GALA26', { 'h-member': '1', 'h-gs': at(9000) });
  await page.screenshot({ path: 'gs-1-prompt.png' });
  await page.getByText("I'm in. Open my camera").click(); await page.waitForTimeout(1500);
  await page.screenshot({ path: 'gs-2-camera.png' });
  await page.waitForTimeout(7500);
  await page.screenshot({ path: 'gs-3-after.png' });
  console.log('guest ADD:', logs.filter(l => l.startsWith('ADD') || /Group Shot/.test(l)));
  console.log('errs', errs); await ctx.close(); }
// 2. Guest who ignores it sees "missed"; also the join-as-new link
{ const { ctx, page, errs } = await open('/e/GALA26', { 'h-member': '1' });
  console.log('join-as-new link:', await page.getByText(/Join as someone new/).count());
  await page.screenshot({ path: 'gs-4-gallery.png' });
  await ctx.close(); }
// 3. Host console button
{ const { ctx, page, errs, logs } = await open('/host/ev1', { 'h-host': '1' }, 1280, 800);
  await page.getByRole('button', { name: /Group Shot/ }).first().click(); await page.waitForTimeout(1200);
  await page.screenshot({ path: 'gs-5-host.png', clip: { x: 0, y: 0, width: 1280, height: 260 } });
  console.log('host logs', logs.filter(l => l.startsWith('UPDATE')));
  console.log('errs', errs); await ctx.close(); }
// 4. TV countdown and layouts
{ const { ctx, page, errs } = await open('/tv', { 'h-tv': 'show', 'h-gs': at(7000) }, 1280, 720);
  await page.screenshot({ path: 'gs-6-tv.png' }); console.log('errs', errs); await ctx.close(); }
for (const n of [1, 3, 5]) {
  const { ctx, page, errs } = await open('/tv', { 'h-tv': 'show', 'h-nphotos': String(n) }, 1280, 720);
  await page.mouse.move(600, 300); await page.waitForTimeout(400);
  await page.screenshot({ path: `gs-tv-${n}.png` }); console.log(n, 'errs', errs); await ctx.close();
}
await browser.close();
