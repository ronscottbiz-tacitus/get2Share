// Captures every Walkthrough screen and checks the rules around them, using the fake Firebase.
//   ./node_modules/.bin/vite --config vite.harness.config.mjs &
//   node harness/walkthrough-shots.mjs <out-dir> [<dir with final-v.webm, final-h.webm, poster-v.jpg, poster-h.jpg>]
// Prints PASS or FAIL for each check; exits non-zero if any fail. Nothing leaves this machine:
// calls to the cloud job are answered here, and counted.
import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)('playwright');
const S = process.cwd();
const OUT = process.argv[2] || '.';
const MEDIA = process.argv[3];
const asset = (name) => (MEDIA ? `/@fs${MEDIA}/${name}` : '');
const F = (pkg, file) => `http://localhost:5199/@fs${S}/node_modules/@fontsource-variable/${pkg}/files/${file}`;
const fontCss = `
@font-face{font-family:'Archivo';font-style:normal;font-weight:100 900;font-stretch:62.5% 125%;src:url(${F('archivo', 'archivo-latin-standard-normal.woff2')}) format('woff2');}
@font-face{font-family:'Plus Jakarta Sans';font-style:normal;font-weight:200 800;src:url(${F('plus-jakarta-sans', 'plus-jakarta-sans-latin-wght-normal.woff2')}) format('woff2');}
@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:100 800;src:url(${F('jetbrains-mono', 'jetbrains-mono-latin-wght-normal.woff2')}) format('woff2');}`;
const LABEL = "AI-generated video. Some moments and details aren't real.";
const PHONE = [390, 844];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--autoplay-policy=no-user-gesture-required'] });
let failed = 0;
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(ok ? 'PASS' : 'FAIL', name, extra); };

async function open(path, ls, [w, h] = PHONE) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errs = [], api = [], warm = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.route('**/fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: fontCss }));
  await page.route('**/*get2share-walkthrough*/**', (r) => {
    api.push({ url: r.request().url(), body: r.request().postDataJSON() });
    const meterLeft = Number(ls['h-meter-left'] ?? 20);
    const answer = r.request().url().endsWith('/meter')
      ? { allowanceSeconds: 20, usedSeconds: 20 - meterLeft, remainingSeconds: meterLeft, plan: 'free', access: ls['h-meter-access'] === '1' }
      : { id: 'wt1', status: 'queued' };
    r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }, body: JSON.stringify(answer) });
  });
  await page.route('**/*get2share-step-in*/**', (r) => {
    warm.push(r.request().url());
    r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }, body: '{"warming":true}' });
  });
  await page.addInitScript((ls) => { for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v); }, ls);
  await page.goto('http://localhost:5199' + path);
  await page.waitForTimeout(1200);
  return { ctx, page, errs, api, warm };
}
const shot = (page, name, opts = {}) => page.screenshot({ path: `${OUT}/${name}.png`, ...opts });
const media = (aspect) => {
  const t = aspect === '16:9' ? 'h' : 'v';
  return MEDIA ? { 'h-wt-url': asset(`final-${t}.webm`), 'h-wt-poster': asset(`poster-${t}.jpg`) } : {};
};
const hostAll = { 'h-host': '1', 'h-wt-config': 'all' };
const card = (page) => page.getByRole('heading', { name: /^Flow/i });

// ---------- who sees the Host Console card
{ const { ctx, page } = await open('/host/ev1', { 'h-host': '1' });
  check('no config doc: no card, even for an admin', (await card(page).count()) === 0); await ctx.close(); }
{ const { ctx, page } = await open('/host/ev1', { 'h-host': '1', 'h-nonadmin': '1', 'h-wt-config': 'admin' });
  check('admin-only: an ordinary host sees no card', (await card(page).count()) === 0); await ctx.close(); }
{ const { ctx, page } = await open('/host/ev1', { 'h-host': '1', 'h-wt-config': 'admin' });
  check('admin-only: an admin sees the card', (await card(page).count()) === 1); await ctx.close(); }

// ---------- making one
{ const { ctx, page, errs, api } = await open('/host/ev1', { ...hostAll, 'h-photos': 'sample' });
  await card(page).scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot(page, '01-console-card-phone');
  await page.getByRole('button', { name: 'Make a Flow' }).click();
  await page.waitForTimeout(500);
  await shot(page, '02-studio-empty-phone');
  const create = page.getByRole('button', { name: 'Create' });
  check('Create is off with nothing picked', await create.isDisabled());
  const tiles = page.getByRole('button', { name: /^Photo by/ });
  check('only approved photos are offered', (await tiles.count()) === 5, `(${await tiles.count()})`);
  for (const i of [3, 0, 1, 4]) await tiles.nth(i).click();
  await page.waitForTimeout(300);
  check('Create stays off until the notice is accepted', await create.isDisabled());
  await page.getByText(/outside AI service/).scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await shot(page, '03-studio-picked-phone');
  await page.getByRole('button', { name: 'Move photo 2 later' }).click();
  await page.getByRole('checkbox', { name: /outside AI service/ }).check();
  await page.getByRole('button', { name: 'Horizontal' }).click();
  await create.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await shot(page, '04-studio-ready-phone');
  check('Create is on once ready', await create.isEnabled());
  await create.click();
  await page.waitForTimeout(500);
  const sent = api.find((a) => a.url.endsWith('/create'))?.body;
  check('create sends the accepted notice', sent?.acceptedNotice === true && sent?.noticeVersion === 2);
  check('create sends the host-chosen order and shape, label on by default', sent?.photoIds?.length === 4 && sent?.aspect === '16:9' && sent?.showLabel === true, JSON.stringify(sent?.photoIds));
  // Picked p2, p6, p5, p1. Suggested by createdAt (stub p1 is newest): p6, p5, p2, p1. Then the host swapped 2 and 3.
  check('order: oldest first, then the host\'s move', sent?.photoIds?.join() === 'p6,p2,p5,p1', sent?.photoIds?.join());
  check('no page errors while making one', errs.length === 0, errs.join(' | '));
  await ctx.close(); }

// ---------- invited hosts, and the landing page
{ const { ctx, page } = await open('/host/ev1', { 'h-host': '1', 'h-nonadmin': '1', 'h-wt-config': 'admin' });
  await page.waitForTimeout(600);
  check('uninvited host on admin-only: no card', (await card(page).count()) === 0);
  await ctx.close(); }
{ const { ctx, page } = await open('/host/ev1', { 'h-host': '1', 'h-nonadmin': '1', 'h-wt-config': 'admin', 'h-meter-access': '1' });
  await page.waitForTimeout(600);
  check('invited host on admin-only: sees the card', (await card(page).count()) === 1);
  await ctx.close(); }
{ const { ctx, page, errs } = await open('/', {});
  await page.waitForTimeout(1200);
  await shot(page, '00-landing-phone');
  const text = await page.locator('main').innerText();
  check('landing: Flick and Flow, no Coming to Pro', /Flick/.test(text) && /Flow/.test(text) && !/Coming to Pro/i.test(text) && !/Matrix/.test(text));
  check('landing: Flow is marked early access and samples as AI', /Early access/i.test(text) && /AI sample/i.test(text));
  await page.getByRole('button', { name: /Flow/ }).first().click();
  await page.waitForTimeout(500);
  await shot(page, '00b-landing-flow-player-phone');
  check('landing: Flow player says it is a sample', (await page.getByText(/Made with Flow from AI-generated photos/).count()) === 1);
  check('landing: no page errors', errs.length === 0, errs.join(' | '));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /Flick/ }).first().click();
  await page.waitForTimeout(500);
  check('landing: Flick opens its own player', (await page.getByRole('dialog', { name: 'Flick' }).count()) === 1);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('landing: new headline and copy', /You never get it/.test(text) && /Now you Get2/.test(text) && /Get in the shot/.test(text) && /Walk back through the night/.test(text) && /flash mob for photos/.test(text) && !/Group Shot/.test(text));
  check('landing: early access link', ((await page.getByRole('link', { name: 'Ask for early access' }).getAttribute('href')) || '').startsWith('mailto:ron@get2studio.com'));
  check('landing: nothing wider than a phone', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await ctx.close(); }
{ const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.route('**/fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: fontCss }));
  await page.goto('http://localhost:5199/');
  await page.waitForTimeout(1000);
  const state = await page.locator('.video-bird-wing').first().evaluate((el) => getComputedStyle(el).animationName);
  check('reduced motion: the bird holds still', state === 'none', state);
  await ctx.close(); }

// ---------- photo count sets the length, within the range and the meter
{ const { ctx, page } = await open('/host/ev1', { ...hostAll, 'h-meter-left': '15' });
  await page.getByRole('button', { name: 'Make a Flow' }).click();
  await page.waitForTimeout(400);
  const tiles = page.getByRole('button', { name: /^Photo by/ });
  const create = page.getByRole('button', { name: /^Create/ });
  await page.getByRole('checkbox', { name: /outside AI service/ }).check();
  await tiles.nth(0).click(); await tiles.nth(1).click();
  check('2 photos is too few', await create.isDisabled());
  await tiles.nth(2).click();
  check('3 photos makes a 10-second Flow', (await create.isEnabled()) && (await page.getByRole('button', { name: 'Create 10-second Flow' }).count()) === 1);
  await tiles.nth(3).click();
  check('4 photos makes a 15-second Flow', (await page.getByRole('button', { name: 'Create 15-second Flow' }).count()) === 1);
  check('the meter stops a 5th photo', await tiles.nth(4).isDisabled());
  await shot(page, '03b-studio-meter-phone');
  await ctx.close(); }
{ const { ctx, page } = await open('/host/ev1', { ...hostAll, 'h-meter-left': '5' });
  check('too few seconds: button is off', await page.getByRole('button', { name: 'Make a Flow' }).isDisabled());
  check('too few seconds: says so', (await page.getByText(/enough AI video seconds/).count()) === 1);
  await ctx.close(); }
{ const { ctx, page } = await open('/host/ev1', { ...hostAll, 'h-meter-left': '500', 'h-wt': 'preview', 'h-wt-more': '1' });
  const rows = page.getByRole('button', { name: /-second Flow/ });
  check('two Flows: both listed, newest open', (await rows.count()) === 2 && (await rows.nth(0).getAttribute('aria-expanded')) === 'true');
  await rows.nth(1).click();
  await page.waitForTimeout(300);
  check('two Flows: tapping the older one opens it', (await rows.nth(1).getAttribute('aria-expanded')) === 'true' && (await page.getByRole('button', { name: 'Take it down' }).count()) === 1);
  check('two Flows: can make another', await page.getByRole('button', { name: 'Make another Flow' }).isEnabled());
  await ctx.close(); }
{ const { ctx, page } = await open('/host/ev1', { ...hostAll, 'h-meter-left': '500', 'h-wt': 'generating', 'h-wt-more': '1' });
  check('one being made: another has to wait', await page.getByRole('button', { name: 'Make another Flow' }).isDisabled());
  await ctx.close(); }
{ const config = JSON.stringify({ enabled: true, allHosts: true, photos: { min: 3, max: 4 } });
  const { ctx, page } = await open('/host/ev1', { 'h-host': '1', 'h-wt-config': config, 'h-meter-left': '500' });
  await page.getByRole('button', { name: 'Make a Flow' }).click();
  await page.waitForTimeout(400);
  check('the photo range comes from config', (await page.getByText(/Pick 3 to 4 photos/).count()) === 1);
  await ctx.close(); }
{ const { ctx, page, api } = await open('/host/ev1', { ...hostAll, 'h-photos': 'sample' });
  await page.getByRole('button', { name: 'Make a Flow' }).click();
  await page.waitForTimeout(400);
  const tiles = page.getByRole('button', { name: /^Photo by/ });
  for (const i of [0, 1, 2]) await tiles.nth(i).click();
  await page.getByRole('checkbox', { name: /small AI label/ }).uncheck();
  check('turning the label off explains what it means', (await page.getByText(/won't say it's AI-generated/).count()) === 1);
  await page.getByRole('checkbox', { name: /outside AI service/ }).check();
  await page.getByRole('button', { name: /^Create/ }).click();
  await page.waitForTimeout(400);
  check('create can leave the label off', api.find((a) => a.url.endsWith('/create'))?.body?.showLabel === false);
  await ctx.close(); }
{ const { ctx, page, api } = await open('/host/ev1', { ...hostAll, 'h-wt': 'preview', 'h-meter-left': '5', ...media('9:16') });
  page.once('dialog', (d) => d.accept());
  await page.getByRole('switch', { name: /AI label on the video: On/ }).click();
  await page.waitForTimeout(300);
  const sent = api.find((a) => a.url.endsWith('/label'))?.body;
  check('the label switch asks the cloud job', sent?.show === false);
  check('the note beside the video stays', (await page.getByText(LABEL, { exact: true }).count()) === 1);
  await ctx.close(); }

// ---------- every state on the console, phone width
for (const [name, ls] of [
  ['05-progress-phone', { 'h-wt': 'generating' }],
  ['06-progress-slow-phone', { 'h-wt': 'generating', 'h-wt-slow': '1' }],
  ['07-joining-phone', { 'h-wt': 'joining' }],
  ['08-preview-vertical-phone', { 'h-wt': 'preview', ...media('9:16') }],
  ['09-preview-horizontal-phone', { 'h-wt': 'preview', 'h-wt-aspect': '16:9', ...media('16:9') }],
  ['10-redo-notice-phone', { 'h-wt': 'preview', 'h-wt-redos': '1', 'h-wt-notice': "The AI service wouldn't redo this clip, often because of faces or its content rules. Your video is unchanged and this redo wasn't counted.", ...media('9:16') }],
  ['11-published-phone', { 'h-wt': 'published', ...media('9:16') }],
  ['12-blocked-phone', { 'h-wt': 'blocked' }],
  ['13-failed-phone', { 'h-wt': 'failed' }],
]) {
  const { ctx, page, errs } = await open('/host/ev1', { ...hostAll, ...ls });
  await card(page).scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await shot(page, name);
  check(`${name}: no page errors`, errs.length === 0, errs.join(' | '));
  if (name.includes('preview') || name.includes('published')) check(`${name}: label next to the video`, (await page.getByText(LABEL, { exact: true }).count()) === 1);
  await ctx.close();
}
{ const { ctx, page, api } = await open('/host/ev1', { ...hostAll, 'h-wt': 'preview', ...media('9:16') });
  check('no third redo button state: three clips offered', (await page.getByRole('button', { name: /^Clip \d/ }).count()) === 3);
  await page.getByRole('button', { name: 'Clip 2' }).click();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'Approve and share with guests' }).click();
  await page.waitForTimeout(200);
  const paths = api.map((a) => a.url.split('/').pop());
  check('redo asks for just that clip', api.find((a) => a.url.endsWith('/redo'))?.body?.clipIndex === 1);
  check('approve calls the cloud job', paths.includes('approve'));
  await ctx.close(); }
{ const { ctx, page } = await open('/host/ev1', { ...hostAll, 'h-wt': 'preview', 'h-meter-left': '0' });
  check('no seconds left: redo buttons off', await page.getByRole('button', { name: 'Clip 1' }).isDisabled());
  await ctx.close(); }
{ const { ctx, page, api } = await open('/host/ev1', { 'h-host': '1', 'h-wt': 'published', ...media('9:16') });
  check('feature off: a host can still take it down', (await page.getByRole('button', { name: 'Take it down' }).count()) === 1);
  await page.getByRole('button', { name: 'Take it down' }).click();
  await page.waitForTimeout(200);
  check('take-down calls the cloud job', api.some((a) => a.url.endsWith('/unpublish')));
  await ctx.close(); }

// ---------- guests
for (const status of ['queued', 'generating', 'joining', 'preview', 'failed', 'blocked']) {
  const { ctx, page } = await open('/e/GALA26', { 'h-member': '1', 'h-wt': status, ...media('9:16') });
  check(`guest sees nothing while it's ${status}`, (await page.getByText('Flow video').count()) === 0 && (await page.locator('video').count()) === 0);
  await ctx.close();
}
for (const [name, ls, aspect] of [['14-gallery-card-phone', {}, '9:16'], ['16-gallery-card-horizontal-phone', { 'h-wt-aspect': '16:9' }, '16:9']]) {
  const { ctx, page, errs } = await open('/e/GALA26', { 'h-member': '1', 'h-photos': 'sample', 'h-wt': 'published', ...ls, ...media(aspect) });
  await shot(page, name);
  check(`${name}: the label is on the card`, (await page.getByText(LABEL, { exact: true }).count()) === 1);
  await page.getByText('Flow video').click();
  await page.waitForTimeout(900);
  await shot(page, name.replace('gallery-card', 'player').replace('14', '15').replace('16', '17'));
  check(`${name}: guest link to make their own`, (await page.getByRole('link', { name: 'Make one for your next event' }).count()) === 1);
  check(`${name}: player shows video, label and save`, (await page.locator('video').count()) === 1 && (await page.getByText(LABEL, { exact: true }).count()) >= 1 && (await page.getByRole('button', { name: 'Save to this device' }).count()) === 1);
  check(`${name}: no page errors`, errs.length === 0, errs.join(' | '));
  await ctx.close();
}
{ const { ctx, page } = await open('/e/GALA26', { 'h-member': '1', 'h-wt': 'published', 'h-saving': 'host', ...media('9:16') });
  await page.getByText('Flow video').click();
  await page.waitForTimeout(500);
  check('"Only me" saving: guests get no save button', (await page.getByRole('button', { name: 'Save to this device' }).count()) === 0);
  await ctx.close(); }

// ---------- TVs. Plays after 30 seconds on a TV that just opened.
const tvs = await Promise.all([
  ['18-tv-vertical-720', '9:16', [1280, 720]], ['19-tv-vertical-1080', '9:16', [1920, 1080]],
  ['20-tv-horizontal-720', '16:9', [1280, 720]], ['21-tv-horizontal-1080', '16:9', [1920, 1080]],
].map(async ([name, aspect, size]) => {
  const opened = await open('/tv', { 'h-tv': 'show', 'h-photos': 'sample', 'h-wt': 'published', 'h-wt-aspect': aspect, ...media(aspect) }, size);
  return { name, ...opened };
}));
await tvs[0].page.waitForTimeout(32000);
for (const { name, ctx, page, errs } of tvs) {
  await shot(page, name);
  const played = await page.locator('video').evaluate((v) => ({ muted: v.muted, playing: !v.paused, t: v.currentTime, err: v.error?.message })).catch(() => null);
  if (MEDIA) check(`${name}: the video is playing, muted`, !!played && played.playing && played.muted, JSON.stringify(played));
  check(`${name}: label next to it`, (await page.getByText(LABEL, { exact: true }).count()) === 1);
  check(`${name}: no page errors`, errs.length === 0, errs.join(' | '));
  await ctx.close();
}
{ const { ctx, page } = await open('/tv', { 'h-tv': 'show', 'h-wt': 'preview', ...media('9:16') }, [1280, 720]);
  await page.waitForTimeout(31000);
  check('TV never plays an unapproved video', (await page.locator('video').count()) === 0);
  await ctx.close(); }
{ const { ctx, page } = await open('/tv', { 'h-tv': 'show', 'h-wt': 'published', 'h-paused': '1', ...media('9:16') }, [1280, 720]);
  await page.waitForTimeout(31000);
  check('a paused TV stays paused', (await page.locator('video').count()) === 0);
  await ctx.close(); }

// ---------- Step In switch. Moments exist on p1 and p2, in the gallery, lightbox and TV.
const moment = JSON.stringify({
  p1: { status: 'ready', inUrl: '/none.sog', outUrl: null, inFrame: { pivot: 1, cx: 0, cy: 0, tanH: 1, tanV: 1 } },
  p2: { status: 'ready', inUrl: '/none.sog', outUrl: null, inFrame: { pivot: 1, cx: 0, cy: 0, tanH: 1, tanV: 1 } },
});
const badge = (page) => page.locator('main span', { hasText: /^Step In$/ });
const lightboxTab = (page) => page.getByRole('button', { name: 'Step In', exact: true });
const opensMoment = async (page) => { await page.locator('main img').first().click(); await page.waitForTimeout(500); return (await lightboxTab(page).count()) > 0; };

{ const { ctx, page } = await open('/e/GALA26', { 'h-member': '1', 'h-stepin': moment });
  check('allHosts missing: guest sees the badge', (await badge(page).count()) === 2);
  check('allHosts missing: guest gets the moment in the lightbox', await opensMoment(page));
  await ctx.close(); }
{ const { ctx, page } = await open('/e/GALA26', { 'h-member': '1', 'h-stepin': moment, 'h-allhosts': '0' });
  await shot(page, '22-stepin-hidden-gallery-phone');
  check('allHosts false: guest sees no badge', (await badge(page).count()) === 0);
  check('allHosts false: lightbox shows only the photo', !(await opensMoment(page)));
  await ctx.close(); }

const warms = (w) => w.filter((u) => u.endsWith('/warm')).length;
for (const [title, ls, wantWarm, wantMake, wantSee] of [
  ['allHosts missing, ordinary host', { 'h-nonadmin': '1' }, true, true, true],
  ['allHosts missing, admin', {}, true, true, true],
  ['allHosts false, ordinary host', { 'h-nonadmin': '1', 'h-allhosts': '0' }, false, false, false],
  ['allHosts false, admin', { 'h-allhosts': '0' }, false, true, true],
  ['allHosts false, Pro host', { 'h-nonadmin': '1', 'h-allhosts': '0', 'h-pro': '1' }, true, true, true],
]) {
  const { ctx, page, warm } = await open('/e/GALA26', { 'h-host': '1', 'h-member': '1', 'h-stepin': moment, ...ls });
  await page.waitForTimeout(600);
  check(`${title}: warm-up ${wantWarm ? 'runs' : 'stays off'}`, (warms(warm) > 0) === wantWarm, `(${warms(warm)} pings)`);
  check(`${title}: badge ${wantSee ? 'shows' : 'hidden'}`, ((await badge(page).count()) > 0) === wantSee);
  // A photo with no moment yet, to see the Make button.
  await page.locator('main img').nth(2).click();
  await page.waitForTimeout(500);
  check(`${title}: Make button ${wantMake ? 'offered' : 'hidden'}`, ((await page.getByRole('button', { name: /Make Step In/ }).count()) > 0) === wantMake);
  await ctx.close();
}
{ const { ctx, warm } = await open('/host/ev1', { 'h-host': '1', 'h-allhosts': '0' });
  check('allHosts false, admin in the console: no warm-up', warms(warm) === 0);
  await ctx.close(); }

// TV: count how often the 3D layer tried to load, in the layouts that show moments.
for (const [layout, wantStage] of [['slideshow', true], ['justin', true], ['wall', true]]) {
  for (const [title, extra, want] of [['allHosts missing', {}, wantStage], ['allHosts false', { 'h-allhosts': '0' }, false]]) {
    const { ctx, page } = await open('/tv', { 'h-tv': 'show', 'h-layout': layout, 'h-stepin': moment, ...extra }, [1280, 720]);
    const fetched = [];
    page.on('request', (r) => { if (r.url().includes('none.sog')) fetched.push(r.url()); });
    await page.reload();
    await page.waitForTimeout(2500);
    check(`TV ${layout}, ${title}: 3D moment ${want ? 'loads' : 'never loads'}`, (fetched.length > 0) === want, `(${fetched.length})`);
    await ctx.close();
  }
}

await browser.close();
console.log(failed ? `${failed} FAILED` : 'All Flow screen checks passed.');
process.exit(failed ? 1 : 0);
