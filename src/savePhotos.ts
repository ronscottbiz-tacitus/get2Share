import { zipSync } from 'fflate';
import { EventDoc, eventPhase } from './events';
import { Photo } from './types';

// Saving photos to a guest's own phone or laptop.
//
//   Phones: the share sheet ("Save Image" puts it in Photos), up to SHARE_BATCH at a time.
//   Laptops: one photo downloads as a .jpg; several download as one .zip.
//
// Who can save what:
//   - Your own photos (ones you took, ones taken for you with Borrow, Share Spot photos
//     you kept) — always.
//   - Everyone else's — when the host's albumSaving setting allows it:
//       'party' (default)  any time
//       'after'            once the event has ended (wrap-up hour and album)
//       'host'             only the hosts
//
// This is a courtesy setting, not a lock: anyone who can see a photo can still
// screenshot it. It decides which save buttons the app offers.

export type AlbumSaving = 'party' | 'after' | 'host';

export const ALBUM_SAVING_OPTIONS: { id: AlbumSaving; label: string; hint: string }[] = [
  { id: 'party', label: 'Any time', hint: 'Guests can save every photo, during the party and after' },
  { id: 'after', label: 'After it ends', hint: 'Guests save the album once the party is over' },
  { id: 'host', label: 'Only me', hint: 'Guests save only their own photos' },
];

/** Phones offer this many photos per share sheet. */
export const SHARE_BATCH = 10;

export function albumSavingOf(ev: Pick<EventDoc, 'albumSaving'>): AlbumSaving {
  return ev.albumSaving === 'after' || ev.albumSaving === 'host' ? ev.albumSaving : 'party';
}

/** Can this person save photos other people took? */
export function canSaveAlbum(ev: Pick<EventDoc, 'albumSaving' | 'endsAt' | 'expireAt'>, isHost: boolean, now = Date.now()) {
  if (isHost) return true;
  const mode = albumSavingOf(ev);
  if (mode === 'party') return true;
  if (mode === 'after') return eventPhase(ev, now) !== 'live';
  return false;
}

/** A photo this guest took, or one taken for them on someone else's camera. */
export function isOwnPhoto(p: Photo, uid: string) {
  return p.sessionId === uid || p.takenBy?.uid === uid;
}

export function canSavePhoto(p: Photo, uid: string, ev: Pick<EventDoc, 'albumSaving' | 'endsAt' | 'expireAt'>, isHost: boolean) {
  return isOwnPhoto(p, uid) || canSaveAlbum(ev, isHost);
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'party';
}

export function photoFileName(eventName: string, p: Photo, n?: number) {
  const d = new Date(p.createdAt || Date.now());
  const pad = (x: number) => String(x).padStart(2, '0');
  const when = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `get2share-${slug(eventName)}-${when}${n ? `-${n}` : ''}.jpg`;
}

/** The photo's bytes. Works for Storage links (needs the bucket's CORS set; see cors.json) and inline photos. */
export async function photoFile(eventName: string, p: Photo, n?: number): Promise<File> {
  const res = await fetch(p.url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return new File([blob], photoFileName(eventName, p, n), { type: blob.type || 'image/jpeg' });
}

/** Phones that can hand files to the share sheet (and so to Photos). */
export function canShareFiles(files: File[]) {
  try {
    return typeof navigator !== 'undefined' && !!navigator.canShare && navigator.canShare({ files });
  } catch {
    return false;
  }
}

/** Opens the share sheet. Must run straight from a tap. Resolves false if the person closed it. */
export async function shareFiles(files: File[]): Promise<boolean> {
  try {
    await navigator.share({ files });
    return true;
  } catch (e: any) {
    if (e?.name === 'AbortError') return false;
    throw e;
  }
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Several photos as one .zip (photos are already compressed, so they're stored as-is). */
export async function zipFiles(files: File[]): Promise<Blob> {
  const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
  for (const f of files) {
    let name = f.name;
    for (let i = 2; entries[name]; i++) name = f.name.replace(/\.jpg$/, `-${i}.jpg`);
    entries[name] = [new Uint8Array(await f.arrayBuffer()), { level: 0 }];
  }
  return new Blob([zipSync(entries)], { type: 'application/zip' });
}

/** Days until the album closes (rounded up), or null. */
export function daysLeft(expireAtMs: number | null, now = Date.now()) {
  if (!expireAtMs) return null;
  return Math.max(0, Math.ceil((expireAtMs - now) / 86_400_000));
}
