import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from './firebase';

// The strip on shared photos. When a guest taps Share, the copy that leaves the app carries a
// slim black strip under the photo: the event's name on the left, Get2Share and its address on
// the right. It is how a shared photo leads back here. The photo in the gallery, and copies
// saved with "Save to this device", stay clean.
//
// Free events always have the strip. An event with paid Flow time or Pro (features/{eventId})
// can turn it off: that sets shareFrame to false on the event, which the rules only allow for
// a paid event. So "shareFrame === false" is the one thing to check here.

export const SITE = 'share.get2.one';
const BLUE = '#0052FF';
const BLUE_LIGHT = '#6699FF';
const MAX_SIDE = 2400; // big enough for any feed, small enough for an old phone's memory

export function shareFrameOn(ev: { shareFrame?: boolean }): boolean {
  return ev.shareFrame !== false;
}

/** Hosts only: has this event paid for Flow time or Pro? (Guests can't read this, and don't need to.) */
export function useEventPaid(eventId: string, isHost: boolean): boolean {
  const [paid, setPaid] = useState(false);
  useEffect(() => {
    if (!isHost) return;
    return onSnapshot(
      doc(db, 'features', eventId),
      (s) => {
        const d = s.data() || {};
        setPaid(d.pro === true || (typeof d.flowSeconds === 'number' && d.flowSeconds > 0));
      },
      () => setPaid(false),
    );
  }, [eventId, isHost]);
  return paid;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(cut + '…').width > maxWidth) cut = cut.slice(0, -1);
  return cut.trimEnd() + '…';
}

/** Draws the photo with the strip beneath it. Split out so it can be checked on its own. */
export function drawShareFrame(
  canvas: HTMLCanvasElement, image: CanvasImageSource, width: number, height: number, eventName: string,
): void {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const strip = Math.max(44, Math.min(170, Math.round(Math.min(w, h) * 0.075)));
  canvas.width = w;
  canvas.height = h + strip;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No canvas');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h + strip);
  ctx.drawImage(image, 0, 0, w, h);

  const pad = Math.round(strip * 0.42);
  const mid = h + strip / 2;
  ctx.textBaseline = 'middle';

  // Right: "Get2Share" in the brand lockup, then the address if there's room.
  const lockupPx = Math.round(strip * 0.34);
  const setLockup = () => {
    ctx.font = `900 ${lockupPx}px Archivo, "Plus Jakarta Sans", system-ui, sans-serif`;
    try { (ctx as any).fontStretch = 'expanded'; } catch { /* older browsers: regular width */ }
  };
  const setText = (px: number, weight = 700) => {
    try { (ctx as any).fontStretch = 'normal'; } catch { /* ignore */ }
    ctx.font = `${weight} ${px}px "Plus Jakarta Sans", system-ui, sans-serif`;
  };
  setLockup();
  const get2 = ctx.measureText('Get2').width;
  const share = ctx.measureText('Share').width;
  const sitePx = Math.round(strip * 0.27);
  setText(sitePx, 600);
  const gap = Math.round(strip * 0.3);
  const siteWidth = ctx.measureText(SITE).width;
  const withSite = get2 + share + gap + siteWidth <= w * 0.62;
  const rightWidth = get2 + share + (withSite ? gap + siteWidth : 0);
  let x = w - pad - rightWidth;
  setLockup();
  ctx.textAlign = 'left';
  ctx.fillStyle = BLUE;
  ctx.fillText('Get2', x, mid);
  ctx.fillStyle = '#fff';
  ctx.fillText('Share', x + get2, mid);
  if (withSite) {
    setText(sitePx, 600);
    ctx.fillStyle = BLUE_LIGHT;
    ctx.fillText(SITE, x + get2 + share + gap, mid);
  }

  // Left: the event's name, cut short if it would run into the right side.
  const name = (eventName || '').replace(/\s+/g, ' ').trim();
  const room = x - pad * 2;
  if (name && room > strip * 1.5) {
    setText(Math.round(strip * 0.32), 700);
    ctx.fillStyle = '#E6E6EA';
    ctx.fillText(fitText(ctx, name, room), pad, mid);
  }
}

/** A copy of the photo with the strip under it, ready for the share sheet. */
export async function framedPhotoFile(file: File, eventName: string): Promise<File> {
  // The page's own fonts: make sure they're in before measuring and drawing with them.
  try {
    await Promise.all([
      document.fonts.load('900 32px Archivo'),
      document.fonts.load('700 32px "Plus Jakarta Sans"'),
      document.fonts.load('600 32px "Plus Jakarta Sans"'),
    ]);
  } catch { /* draw with whatever is there */ }
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    drawShareFrame(canvas, bitmap, bitmap.width, bitmap.height, eventName);
    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) throw new Error('Could not make the shared copy');
    return new File([blob], file.name.replace(/\.jpe?g$/i, '') + '-shared.jpg', { type: 'image/jpeg' });
  } finally {
    bitmap.close?.();
  }
}
