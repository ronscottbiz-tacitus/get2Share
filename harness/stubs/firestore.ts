const svg = (a: string, b: string, w: number, h: number) =>
  'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`);
const now = Date.now();
const P = (id: string, nickname: string, sessionId: string, status: string, a: string, b: string, w: number, h: number, likes = 0) =>
  ({ id, url: svg(a, b, w, h), nickname, sessionId, createdAt: now - Number(id.slice(1)) * 60000, status, reactions: { likes, dislikes: 0 }, flagged: id === 'p4' });
const PHOTOS = [
  P('p1', 'jordan', 'g2', 'approved', '#3b2f63', '#d97757', 600, 800, 12),
  P('p2', 'Stage (Photo Spot)', 't1', 'approved', '#14324a', '#5aa7c7', 800, 600, 8),
  P('p3', 'maya', 'guest1', 'pending', '#4a3b1c', '#e0b25a', 600, 750),
  P('p4', 'dee', 'g3', 'approved', '#1d3b2a', '#6fbf8f', 600, 900, 5),
  P('p5', 'jordan (Group Shot)', 'g2', 'approved', '#3a1530', '#c86a9a', 800, 600, 21),
  P('p6', 'chris', 'g4', 'approved', '#2a2a2a', '#9a9a9a', 600, 700, 3),
  P('p7', 'sam', 'g5', 'pending', '#20304a', '#7f9fd0', 600, 800),
];
const SESSIONS = [
  { sessionId: 't1', nickname: 'Stage', role: 'tripod', lastActive: now, deviceInfo: { batteryLevel: 82 }, stream_frame: svg('#14324a', '#5aa7c7', 240, 135) },
  { sessionId: 'g2', nickname: 'jordan', role: 'guest', lastActive: now },
  { sessionId: 'g3', nickname: 'dee', role: 'guest', lastActive: now, lens_status: 'streaming', stream_frame: svg('#3a1530', '#c86a9a', 160, 120) },
];
const ts = (ms: number) => ({ toMillis: () => ms });
const ended = () => localStorage.getItem('h-ended') === '1';
const EV: any = { name: 'Get2 Grand Opening', subtitle: "Let's Get2 gettin' it!", ownerUid: 'host1', hostUids: ['host1'], joinCode: 'GALA26', access: 'link', autoApproval: false, guestLensEnabled: true, status: 'live', createdAt: { toMillis: () => now } };
Object.defineProperty(EV, 'endsAt', { get: () => ts(ended() ? now - 3 * 3600000 : now + 4 * 3600000), enumerable: true });
Object.defineProperty(EV, 'groupShot', { get: () => { const at = Number(localStorage.getItem('h-gs') || 0); return at ? { id: 'gs' + at, firesAt: ts(at), by: 'host1', spots: localStorage.getItem('h-gs-spots') === '1' } : null; }, enumerable: true });
Object.defineProperty(EV, 'expireAt', { get: () => ts((ended() ? now - 3 * 3600000 : now + 4 * 3600000) + 30 * 86400000), enumerable: true });
const DOCS: Record<string, any> = {
  'joinCodes/GALA26': { eventId: 'ev1', name: 'Get2 Grand Opening' },
  'events/ev1': EV,
  'spotPairings/SPT234': { spotName: 'Photo Wall', eventId: 'ev1', claimedBy: 'guest1' },
};
const sessionDoc = () => localStorage.getItem('h-lens') === '1' ? { invited_to_lens: true, lens_status: 'requesting' } : { lens_status: 'off' };
const docSnap = (path: string) => {
  let data = path === 'events/ev1/sessions/guest1' ? sessionDoc() : DOCS[path];
  if (path === 'events/ev1/members/guest1' || path === 'events/ev1/members/host1') data = localStorage.getItem('h-member') === '1' ? { nickname: 'maya' } : undefined;
  const tv = localStorage.getItem('h-tv');
  if (path.startsWith('screenPairings/')) data = tv ? { screenUid: 'guest1', createdAt: ts(now - 120000), eventId: tv === 'show' ? 'ev1' : null, screenName: tv === 'show' ? 'Main Hall TV' : null, claimedBy: tv === 'show' ? 'host1' : null } : undefined;
  if (tv === 'show' && path === 'events/ev1/members/guest1') data = { nickname: 'Main Hall TV' };
  if (path === 'events/ev1/screens/guest1') data = tv === 'show' ? { name: 'Main Hall TV', layout: localStorage.getItem('h-layout') || 'wall', showQr: true, showNames: true, paused: localStorage.getItem('h-paused') === '1', pairingCode: 'K7P2Q9' } : undefined;
  return { id: path.split('/').pop(), exists: () => !!data, data: () => data };
};
export const getFirestore = () => ({});
export const doc = (_db: any, ...segs: string[]) => ({ path: segs.join('/'), kind: 'doc' });
export const collection = (_db: any, ...segs: string[]) => ({ path: segs.join('/'), kind: 'col', filters: [] });
export const where = (f: string, op: string, v: any) => ({ f, op, v });
export const orderBy = () => null;
export const query = (c: any, ...cons: any[]) => ({ ...c, filters: cons.filter((x) => x && x.f) });
export const serverTimestamp = () => 0;
export const onSnapshot = (ref: any, cb: any) => {
  setTimeout(() => {
    if (ref.kind === 'doc') return cb(docSnap(ref.path));
    let rows: any[] = ref.path.endsWith('photos') ? PHOTOS.slice(0, Number(localStorage.getItem('h-nphotos') || PHOTOS.length)) : ref.path.endsWith('sessions') ? SESSIONS : ref.path === 'events' ? [{ id: 'ev1', ...EV }] : ref.path.endsWith('/joined') ? [{ id: 'ev2', name: "Nia's 30th", code: 'NIA300', joinedAt: ts(now - 86400000 * 20), expireAt: ts(now + 86400000 * 10) }] : [];
    if (ref.path === 'events' || ref.path.endsWith('/joined')) return cb({ docs: rows.map((r) => ({ id: r.id, data: () => r })), forEach: () => {} });
    for (const { f, op, v } of ref.filters) rows = rows.filter((r: any) => op === 'array-contains' ? (r[f] || []).includes(v) : op === '>=' ? r[f] >= v : r[f] === v);
    const docs = rows.map((r: any) => ({ id: r.id || r.sessionId, data: () => r }));
    cb({ docs, forEach: (fn: any) => docs.forEach(fn) });
    if (ref.kind === 'doc' && ref.path === 'sessions/guest1' && localStorage.getItem('h-trigger') === '1') {}
  }, 20);
  return () => {};
};
export const getDoc = async (ref: any) => docSnap(ref.path);
export const setDoc = async () => {};
export const updateDoc = async (ref: any, data: any) => { if (data.groupShot) localStorage.setItem('h-gs', String(data.groupShot.firesAt.toMillis())); console.log('UPDATE', ref.path, Object.keys(data).join(','), JSON.stringify(data).slice(0, 80), data.stream_frame ? 'frame:' + data.stream_frame.length : ''); };
export const addDoc = async (ref: any, data: any) => { console.log('ADD', ref.path, data && data.nickname, data && data.status); return { id: 'new' }; };
export const deleteDoc = async (ref: any) => { console.log('DELETE', ref.path); };

export const getDocs = async () => ({ docs: [], size: 0 });
export const writeBatch = () => ({ set() {}, update() {}, delete() {}, commit: async () => {} });
export class Timestamp { static fromMillis(ms: number) { return { toMillis: () => ms }; } }
export const arrayUnion = (...v: any[]) => ({ arrayUnion: v });
export const arrayRemove = (...v: any[]) => ({ arrayRemove: v });
export const increment = (n: number) => ({ increment: n });
