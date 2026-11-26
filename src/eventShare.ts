import QRCode from 'qrcode';

// Passing an event around: the share sheet, the clipboard, and a QR card image to print or send.
// Hosts get all three under the QR code in the Host Console. Guests get "Invite friends" in the
// gallery while the event is on (see InviteButton).

const BLUE = '#0052FF';
const BLUE_LIGHT = '#6C93FF';

const clean = (s: string) => (s || '').replace(/\s+/g, ' ').trim();

/** When an event starts, for invites: "Sat, Dec 5 · 7:00 PM". Only for a start still ahead (null otherwise). */
export function startLine(startMs: number | null | undefined, now = Date.now()): string | null {
  if (!startMs || startMs <= now) return null;
  const d = new Date(startMs);
  const day = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
}

/** The message that goes with the link. Mentions the start when it's still ahead. */
export function inviteText(eventName: string, startMs?: number | null): string {
  const name = clean(eventName);
  const what = name ? `the photo album for "${name}"` : 'my event\'s photo album';
  const when = startLine(startMs);
  const starts = when ? ` It starts ${when.replace(' · ', ' at ')}; you can join now.` : '';
  return `Join ${what} on Get2Share.${starts} Every photo from the event lands in one place, so you get the ones you're in.`;
}

export function canShareLinks(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

/** Opens the share sheet with the invite. Must run straight from a tap. False if they closed it. */
export async function shareInvite(eventName: string, url: string, startMs?: number | null): Promise<boolean> {
  try {
    await navigator.share({ title: clean(eventName) || 'Get2Share', text: inviteText(eventName, startMs), url });
    return true;
  } catch (e: any) {
    if (e?.name === 'AbortError') return false;
    throw e;
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ---------- The QR card ----------

const CARD_W = 1200;
const CARD_H = 1500;

function slug(s: string) {
  return clean(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'event';
}

/** Up to `maxLines` lines that fit `maxWidth`; the last one is cut short with … if needed. */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = clean(text).split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (ctx.measureText(next).width <= maxWidth || !line) {
      line = next;
      continue;
    }
    lines.push(line);
    line = words[i];
    if (lines.length === maxLines - 1) {
      line = words.slice(i).join(' ');
      break;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines).map((l) => {
    if (ctx.measureText(l).width <= maxWidth) return l;
    let cut = l;
    while (cut.length > 1 && ctx.measureText(cut + '…').width > maxWidth) cut = cut.slice(0, -1);
    return cut.trimEnd() + '…';
  });
}

/**
 * The card: Get2Share, the event's name, when it starts (if that's still ahead), the QR code, and
 * the code to type in. Split out so it can be checked on its own.
 */
export async function drawQrCard(
  canvas: HTMLCanvasElement, eventName: string, code: string, url: string, host: string, when: string | null = null,
): Promise<void> {
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No canvas');
  const cx = CARD_W / 2;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const expanded = (px: number) => {
    ctx.font = `900 ${px}px Archivo, "Plus Jakarta Sans", system-ui, sans-serif`;
    try { (ctx as any).fontStretch = 'expanded'; } catch { /* older browsers: regular width */ }
  };
  const plain = (px: number, weight = 700) => {
    try { (ctx as any).fontStretch = 'normal'; } catch { /* ignore */ }
    ctx.font = `${weight} ${px}px "Plus Jakarta Sans", system-ui, sans-serif`;
  };

  // Get2Share, centered.
  expanded(64);
  const get2 = ctx.measureText('Get2').width;
  const share = ctx.measureText('Share').width;
  const lx = cx - (get2 + share) / 2;
  ctx.fillStyle = BLUE;
  ctx.fillText('Get2', lx, 140);
  ctx.fillStyle = '#fff';
  ctx.fillText('Share', lx + get2, 140);

  // The event's name (one line, or two smaller ones) and when it starts, between the lockup and the QR code.
  const qrSize = 720;
  const qrTop = 490;
  const name = clean(eventName);
  let lines: string[] = [];
  let namePx = 78;
  let lineH = 90;
  if (name) {
    expanded(namePx);
    lines = wrapLines(ctx, name, CARD_W - 160, 1);
    if (ctx.measureText(name).width > CARD_W - 160) {
      namePx = 62;
      lineH = 76;
      expanded(namePx);
      lines = wrapLines(ctx, name, CARD_W - 160, 2);
    }
  }
  const whenGap = 70; // baseline to baseline, name to start time
  const blockH = (lines.length ? (lines.length - 1) * lineH : 0) + (when && lines.length ? whenGap : 0);
  const blockMid = (140 + qrTop) / 2 + 22;
  let ty = blockMid - blockH / 2;
  ctx.textAlign = 'center';
  if (lines.length) {
    expanded(namePx);
    ctx.fillStyle = '#fff';
    for (const l of lines) {
      ctx.fillText(l, cx, ty);
      ty += lineH;
    }
    ty += whenGap - lineH;
  }
  if (when) {
    plain(44, 700);
    ctx.fillStyle = BLUE_LIGHT;
    ctx.fillText(when, cx, ty);
  }
  ctx.textAlign = 'left';

  // The QR code on a white rounded square.
  const qx = cx - qrSize / 2;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  if (typeof (ctx as any).roundRect === 'function') (ctx as any).roundRect(qx, qrTop, qrSize, qrSize, 48);
  else ctx.rect(qx, qrTop, qrSize, qrSize);
  ctx.fill();
  const qr = document.createElement('canvas');
  await QRCode.toCanvas(qr, url, { width: qrSize - 80, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  ctx.drawImage(qr, qx + 40, qrTop + 40, qrSize - 80, qrSize - 80);

  // How to join.
  ctx.textAlign = 'center';
  plain(48, 800);
  ctx.fillStyle = '#fff';
  ctx.fillText('Scan to get the photos you\'re in', cx, qrTop + qrSize + 100);
  // "Or enter code CODE at HOST": one line if it fits, otherwise the address goes on a second line
  // (shrunk if even that is too wide, as with a long preview address).
  const maxW = CARD_W - 120;
  const textFont = (px: number) => { plain(px, 600); };
  const codeFont = (px: number) => { ctx.font = `700 ${px}px "JetBrains Mono", ui-monospace, monospace`; };
  const pre = 'Or enter code ';
  textFont(36);
  const wPre = ctx.measureText(pre).width;
  const wAt = ctx.measureText(` at ${host}`).width;
  codeFont(38);
  const wCode = ctx.measureText(code).width;
  const y = qrTop + qrSize + 168;
  ctx.textAlign = 'left';
  const oneLine = wPre + wCode + wAt <= maxW;
  let x = cx - (wPre + wCode + (oneLine ? wAt : 0)) / 2;
  textFont(36);
  ctx.fillStyle = '#A8A8B3';
  ctx.fillText(pre, x, y);
  x += wPre;
  codeFont(38);
  ctx.fillStyle = BLUE_LIGHT;
  ctx.fillText(code, x, y);
  x += wCode;
  ctx.fillStyle = '#A8A8B3';
  if (oneLine) {
    textFont(36);
    ctx.fillText(` at ${host}`, x, y);
  } else {
    const at = `at ${host}`;
    let px = 36;
    textFont(px);
    while (px > 20 && ctx.measureText(at).width > maxW) textFont(--px);
    ctx.textAlign = 'center';
    ctx.fillText(at, cx, y + 54);
  }
}

/** The QR card as a PNG, ready to save, print or share. */
export async function qrCardFile(eventName: string, code: string, url: string, host: string, when: string | null = null): Promise<File> {
  try {
    await Promise.all([
      document.fonts.load('900 64px Archivo'),
      document.fonts.load('800 48px "Plus Jakarta Sans"'),
      document.fonts.load('600 36px "Plus Jakarta Sans"'),
      document.fonts.load('700 38px "JetBrains Mono"'),
      document.fonts.load('700 44px "Plus Jakarta Sans"'),
    ]);
  } catch { /* draw with whatever is there */ }
  const canvas = document.createElement('canvas');
  await drawQrCard(canvas, eventName, code, url, host, when);
  const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not make the QR card');
  return new File([blob], `get2share-${slug(eventName)}-qr.png`, { type: 'image/png' });
}
